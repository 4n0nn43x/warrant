/**
 * Gateway 402 — la porte d'entrée de Warrant.
 *
 * Trois routes, et l'ordre des étapes de la route payante est le produit :
 *
 *   POST /v1/quote      gratuit, sans authentification — classifier, tarifer, montrer
 *   POST /v1/warrants   payant — 402 dual-rail, puis mandat + exécution
 *   GET  /v1/warrants/:id  mandat, exécution et verdict (checks[] inclus)
 *   GET  /openapi.json  OpenAPI 3.1 avec l'extension x-payment-info
 *
 * Quatre principes gouvernent ce fichier. Ils viennent de découvertes, pas de
 * préférences :
 *
 * 1. **L'agent ne déclare jamais sa catégorie ni son notionnel.** Le seul
 *    intrant de la tarification est l'`ActionSpec` — le calldata qui sera
 *    réellement exécuté. Un champ `category` dans la requête est lu, ignoré, et
 *    signalé dans la réponse (docs/13 § 5). C'est le fondement du modèle de
 *    menace : un agent sous prompt injection n'a rien à mentir.
 *
 * 2. **KeeperHub n'accepte pas de calldata brut.** Son API veut `functionName`
 *    et `functionArgs`, cette dernière étant une **chaîne JSON** et non un
 *    tableau, et résout l'ABI elle-même (repo/docs/onboarding-teardown.md,
 *    14:12). Le Gateway encode donc le calldata lui-même avec viem pour
 *    l'engager sous `actionHash`, puis passe la forme nominative à KeeperHub.
 *    `encodeActionSpec` et `decodeActionSpec` sont inverses l'une de l'autre et
 *    c'est testé : c'est le point de divergence le plus coûteux du système.
 *
 * 3. **Un mandat dont la simulation échoue n'est jamais ouvert.** La simulation
 *    précède le règlement : la caution n'est pas prélevée pour un échec
 *    prévisible. La simulation n'apparaissant dans aucun audit trail
 *    (`simulate: true` ne crée pas de ligne d'exécution), elle est appelée
 *    explicitement et son résultat conservé par nos soins.
 *
 * 4. **Les deux rails produisent un mandat identique.** Même `conditionHash`,
 *    même caution, même forme de `fundingRef`. Le rail n'est qu'un moyen de
 *    payer : il ne change que l'en-tête de reçu.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  ClassificationError,
  DslError,
  PolicyError,
  RiskError,
  WarrantStatus,
  actionHash as hashAction,
  classify,
  conditionHash as hashCondition,
  priceRisk,
  validateActionSpec,
  validateGatewayConditionSpec,
  entryKey,
  type ActionSpec,
  type Address,
  type CheckResult,
  type Classification,
  type ClassificationRegistry,
  type ConditionSpec,
  type Hex,
  type Policy,
  type Quote,
  type RegistryFileEntry,
} from '@warrant/core'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiFunction,
} from 'viem'
import { openapiDocument, type OpenApiOptions } from './openapi.js'
import {
  ChallengeStore,
  FacilitatorError,
  HEADER_AUTHORIZATION,
  HEADER_PAYMENT_RECEIPT,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_WWW_AUTHENTICATE,
  MAX_TIMEOUT_SECONDS,
  MppError,
  PROBLEM_CONTENT_TYPE,
  PaymentRejected,
  WireFormatError,
  X402_VERSION,
  addressFromSource,
  assertPayloadMatches,
  buildPaymentRequired,
  decodeCredentialHeader,
  decodeHeaderObject,
  encodeHeaderObject,
  encodeReceipt,
  formatChallengeHeader,
  fundingRefOf,
  paymentPayloadFromCredential,
  problem,
  type AssetTransferMethod,
  type Facilitator,
  type MppChallenge,
  type MppCredential,
  type MppRequestBody,
  type PaymentPayload,
  type PaymentRequirements,
  type ProblemDetails,
  type SettlementResponse,
} from './x402.js'

// ─────────────────────────────────────────────────────────────────────────────
// ActionSpec ⇄ appel nominatif KeeperHub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le corps d'appel que l'API KeeperHub accepte réellement.
 *
 * ⚠ `functionArgs` est une **chaîne JSON**, pas un tableau. Un tableau est
 * rejeté en 400 avec « functionArgs must be a JSON string when provided ». Il
 * n'existe aucun champ pour un calldata pré-encodé : `data`, `callData` et
 * `calldata` sont tous ignorés silencieusement.
 */
export interface KeeperHubCall {
  chainId: number
  contractAddress: Address
  functionName: string
  /** `JSON.stringify` des arguments, dans l'ordre de l'ABI. */
  functionArgs: string
  value?: string
}

export interface EncodeActionSpecInput {
  chainId: number
  target: Address
  /** Signature ABI humaine, ex. `transfer(address,uint256)`. */
  signature: string
  /** Arguments, acceptés en chaînes — ils viennent d'un JSON. */
  args: readonly unknown[]
  value?: string
  registryRef: Hex
}

export class ActionEncodingError extends Error {
  override readonly name = 'ActionEncodingError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * L'`ActionSpec` engage une version de registre qui n'est pas celle qui a servi
 * à la classifier. Refus à l'ouverture : l'engagement doit être rejouable.
 */
export class RegistryMismatchError extends Error {
  override readonly name = 'RegistryMismatchError'
  readonly declared: Hex
  readonly expected: Hex
  constructor(declared: Hex, expected: Hex) {
    super(
      `registryRef engagé ${declared} alors que la classification utilise ${expected} : ` +
        "l'engagement ne serait pas rejouable",
    )
    this.declared = declared
    this.expected = expected
  }
}

function abiFunctionOf(signature: string): AbiFunction {
  let abi: Abi
  try {
    abi = parseAbi([`function ${signature}`] as string[]) as Abi
  } catch (err) {
    throw new ActionEncodingError(
      `signature illisible "${signature}": ${(err as Error).message}`,
    )
  }
  const fn = abi.find((item): item is AbiFunction => item.type === 'function')
  if (!fn) throw new ActionEncodingError(`signature sans fonction: "${signature}"`)
  return fn
}

/**
 * Résout l'entrée de registre du couple `(chainId, target, selector)`.
 *
 * Reprend `entryKey` de `@warrant/core` — la clé est le couple entier, jamais
 * le seul sélecteur — plutôt que d'écrire une seconde indexation. `lookupEntry`
 * n'étant pas exposée par le baril du paquet, on refait la boucle sur la même
 * clé, ce qui garde une seule définition de « même action ».
 */
function lookupSignature(
  registry: ClassificationRegistry,
  chainId: number,
  target: string,
  selector: string,
): RegistryFileEntry | undefined {
  const wanted = entryKey(chainId, target, selector)
  return (registry.entries as RegistryFileEntry[]).find(
    (entry) => entryKey(entry.chainId, entry.target, entry.selector) === wanted,
  )
}

/** Nom de fonction nu, sans la liste de types. */
export function functionNameOf(signature: string): string {
  const at = signature.indexOf('(')
  return at === -1 ? signature : signature.slice(0, at)
}

/**
 * Coercition d'un argument venu d'un JSON vers la forme attendue par viem.
 *
 * Les montants arrivent en chaînes décimales — c'est la règle de
 * canonicalisation de docs/07 § 4, et un `uint256` ne tient pas dans un
 * `number`. viem, lui, veut un `bigint`.
 */
function coerceArg(type: string, value: unknown): unknown {
  if (type.endsWith(']')) {
    const inner = type.slice(0, type.lastIndexOf('['))
    const items =
      Array.isArray(value) ? value : (JSON.parse(String(value)) as unknown[])
    if (!Array.isArray(items)) {
      throw new ActionEncodingError(`tableau attendu pour le type ${type}`)
    }
    return items.map((item) => coerceArg(inner, item))
  }
  if (/^u?int(\d+)?$/.test(type)) {
    if (typeof value === 'bigint') return value
    try {
      return BigInt(String(value))
    } catch {
      throw new ActionEncodingError(`entier attendu pour ${type}, reçu ${String(value)}`)
    }
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    throw new ActionEncodingError(`booléen attendu, reçu ${String(value)}`)
  }
  return value
}

/** Mise en chaîne d'un argument décodé. Miroir exact de `coerceArg`. */
function stringifyArg(value: unknown): string {
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value.startsWith('0x') ? value.toLowerCase() : value
  if (Array.isArray(value)) return JSON.stringify(value.map(stringifyArg))
  throw new ActionEncodingError(`argument non représentable: ${typeof value}`)
}

/**
 * Construit l'`ActionSpec` — donc le calldata engagé sous `actionHash` — depuis
 * une forme nominative.
 *
 * C'est le Gateway qui encode, pas KeeperHub : l'engagement doit porter sur des
 * octets, et KeeperHub ne nous rendrait le calldata qu'après exécution.
 *
 * @throws {ActionEncodingError}
 */
export function encodeActionSpec(input: EncodeActionSpecInput): ActionSpec {
  const fn = abiFunctionOf(input.signature)
  if (fn.inputs.length !== input.args.length) {
    throw new ActionEncodingError(
      `arité: "${input.signature}" attend ${fn.inputs.length} argument(s), ` +
        `${input.args.length} fourni(s)`,
    )
  }
  const args = fn.inputs.map((param, i) => coerceArg(param.type, input.args[i]))
  let calldata: Hex
  try {
    calldata = encodeFunctionData({
      abi: [fn] as Abi,
      functionName: fn.name,
      args,
    } as Parameters<typeof encodeFunctionData>[0])
  } catch (err) {
    throw new ActionEncodingError(
      `encodage impossible pour "${input.signature}": ${(err as Error).message}`,
    )
  }
  return {
    version: 1,
    chainId: input.chainId,
    target: input.target.toLowerCase() as Address,
    value: input.value ?? '0',
    calldata,
    registryRef: input.registryRef,
  }
}

export interface DecodedAction {
  signature: string
  functionName: string
  /** Arguments en chaînes, dans l'ordre de l'ABI. */
  args: string[]
  /** `JSON.stringify(args)` — la forme que KeeperHub exige. */
  functionArgs: string
}

export interface DecodeActionSpecOptions {
  registry: ClassificationRegistry
  /**
   * Signature à utiliser quand le couple `(chainId, target, selector)` n'est pas
   * au registre.
   *
   * Ce n'est **pas** une déclaration à laquelle on fait confiance : le sélecteur
   * qu'elle produit doit valoir celui du calldata, et le ré-encodage des
   * arguments décodés doit reproduire le calldata octet pour octet. Une
   * signature mensongère ne peut donc pas changer ce qui sera exécuté — elle ne
   * fait que nommer ce qui est déjà engagé sous `actionHash`.
   */
  signature?: string
}

/**
 * Inverse de `encodeActionSpec` : du calldata engagé vers la forme nominative
 * que KeeperHub accepte.
 *
 * @throws {ActionEncodingError}
 */
export function decodeActionSpec(
  actionSpec: ActionSpec,
  opts: DecodeActionSpecOptions,
): DecodedAction {
  const calldata = actionSpec.calldata
  if (calldata.length < 10) {
    throw new ActionEncodingError('calldata sans sélecteur : rien à nommer')
  }
  const selector = calldata.slice(0, 10).toLowerCase()

  const entry = lookupSignature(opts.registry, actionSpec.chainId, actionSpec.target, selector)
  const signature = entry?.signature ?? opts.signature
  if (!signature) {
    throw new ActionEncodingError(
      `couple (chainId ${actionSpec.chainId}, ${actionSpec.target}, ${selector}) ` +
        "absent du registre et aucune signature fournie : l'API KeeperHub exige " +
        'functionName/functionArgs, un calldata brut ne lui suffit pas',
    )
  }

  const expected = toFunctionSelector(`function ${signature}`)
  if (expected.toLowerCase() !== selector) {
    throw new ActionEncodingError(
      `signature "${signature}" (${expected}) incohérente avec le sélecteur ${selector} du calldata`,
    )
  }

  const fn = abiFunctionOf(signature)
  let decoded: readonly unknown[]
  try {
    const result = decodeFunctionData({ abi: [fn] as Abi, data: calldata })
    decoded = (result.args ?? []) as readonly unknown[]
  } catch (err) {
    throw new ActionEncodingError(
      `décodage impossible pour "${signature}": ${(err as Error).message}`,
    )
  }

  const args = decoded.map(stringifyArg)

  // Aller-retour vérifié : ce que KeeperHub exécutera doit être exactement ce
  // qui est engagé sous `actionHash`. Sans ce contrôle, un calldata non
  // canonique — remplissage, arguments surnuméraires — serait exécuté sous une
  // forme différente de celle qu'on a haché.
  const reencoded = encodeActionSpec({
    chainId: actionSpec.chainId,
    target: actionSpec.target,
    signature,
    args,
    value: actionSpec.value,
    registryRef: actionSpec.registryRef,
  }).calldata
  if (reencoded.toLowerCase() !== calldata.toLowerCase()) {
    throw new ActionEncodingError(
      `le ré-encodage de "${signature}" ne reproduit pas le calldata engagé : ` +
        'la forme nominative transmise à KeeperHub divergerait de actionHash',
    )
  }

  return {
    signature,
    functionName: functionNameOf(signature),
    args,
    functionArgs: JSON.stringify(args),
  }
}

/** `ActionSpec` → corps d'appel KeeperHub. */
export function keeperHubCallOf(
  actionSpec: ActionSpec,
  opts: DecodeActionSpecOptions,
): KeeperHubCall {
  const decoded = decodeActionSpec(actionSpec, opts)
  return {
    chainId: actionSpec.chainId,
    contractAddress: actionSpec.target,
    functionName: decoded.functionName,
    functionArgs: decoded.functionArgs,
    ...(actionSpec.value && actionSpec.value !== '0' ? { value: actionSpec.value } : {}),
  }
}

/** `id = keccak256(abi.encode(agent, nonce, actionHash))`. */
export function warrantIdOf(agent: Address, nonce: bigint, actionHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [agent, nonce, actionHash],
    ),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulationOutcome {
  success: boolean
  wouldRevert?: boolean
  revertReason?: string
  gasEstimate?: string
}

export interface ExecutionOutcome {
  executionId: string
  status: string
  txHash?: Hex
}

/**
 * Ce que le Gateway attend de KeeperHub.
 *
 * Volontairement plus étroit que `KeeperHubClient` : celui-ci expose un
 * `ContractCallRequest` à calldata brut, forme que l'API réelle n'accepte pas
 * (voir l'en-tête de ce fichier). Le port impose la forme nominative, et
 * `keeperHubExecutor()` en donne une implémentation HTTP.
 */
export interface ExecutorPort {
  simulateContractCall(call: KeeperHubCall): Promise<SimulationOutcome>
  executeContractCall(
    call: KeeperHubCall,
    idempotencyKey?: string,
  ): Promise<ExecutionOutcome>
}

export interface OpenWarrantArgs {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: string
  conditionHash: Hex
  actionHash: Hex
  fundingRef: Hex
  /** Le contrat prend une durée et calcule `expiry` lui-même. */
  duration: number
}

/** Le Gateway est l'`opener` : il ne peut qu'ouvrir (invariant I10). */
export interface EscrowPort {
  open(args: OpenWarrantArgs): Promise<Hex>
}

export interface VerdictView {
  verdict: 'honored' | 'slashed'
  evaluatedAtBlock: string
  checks: CheckResult[]
  rpcUrl?: string
  settlementTx?: Hex
  executionId?: string
  txHash?: Hex
}

export interface VerdictSource {
  get(warrantId: Hex): Promise<VerdictView | undefined> | VerdictView | undefined
}

export type Rail = 'x402' | 'mpp'

export interface WarrantRecord {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: string
  conditionHash: Hex
  actionHash: Hex
  fundingRef: Hex
  expiry: number
  openedAt: number
  status: WarrantStatus
  /** Rail emprunté. Journalisé, jamais rendu dans le corps du mandat. */
  rail: Rail
  executionId: string
  openTx?: Hex
  actionSpec: ActionSpec
  conditionSpec: ConditionSpec
  classification: Classification
  quote: Quote
  simulation: SimulationOutcome
  settlement: SettlementResponse
}

export interface WarrantStore {
  put(record: WarrantRecord): void | Promise<void>
  get(id: Hex): WarrantRecord | undefined | Promise<WarrantRecord | undefined>
  list?(): WarrantRecord[]
}

export function memoryWarrantStore(): WarrantStore & { list(): WarrantRecord[] } {
  const records = new Map<string, WarrantRecord>()
  return {
    put(record) {
      records.set(record.id.toLowerCase(), record)
    },
    get(id) {
      return records.get(id.toLowerCase())
    },
    list() {
      return [...records.values()]
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface GatewayConfig {
  registry: ClassificationRegistry
  policy: Policy
  /** Base publique du service, pour `resource.url` et `instance`. */
  baseUrl: string
  /** `realm` MPP, ex. `warrant.sh`. */
  realm: string
  /** Réseau de règlement de la caution, en **CAIP-2**. */
  network: string
  /** Contrat du token de caution — USDC natif Base. */
  asset: Address
  /** Coffre Warrant : le scheme `exact` ne transporte pas de calldata (docs/04). */
  payTo: Address
  /** Domaine EIP-712 réel du token. À lire onchain plutôt qu'à croire. */
  assetExtra: { name: string; version: string; assetTransferMethod?: AssetTransferMethod }
  facilitator: Facilitator
  executor: ExecutorPort
  escrow: EscrowPort
  /** `MPP_SECRET_KEY`. Jamais loggée. */
  mppSecret: string
  mppMethod?: string
  /** Devise annoncée dans le Challenge MPP. Défaut : l'adresse de l'actif. */
  mppCurrency?: string
  maxTimeoutSeconds?: number
  challengeTtlSeconds?: number
  store?: WarrantStore
  verdicts?: VerdictSource
  openapi?: Partial<OpenApiOptions>
  now?: () => number
  /** Sel injectable pour rendre les Challenges déterministes en test. */
  challengeSalt?: () => string
  randomNonce?: () => bigint
  /**
   * Régler la caution **avant** de simuler.
   *
   * Faux par défaut, et ce défaut est un choix : la simulation précède le
   * règlement pour qu'un échec prévisible ne coûte rien à l'agent
   * (docs/08 § 4). Mettre ce drapeau à vrai retrouve l'ordre littéral de la
   * séquence de docs/04, au prix d'une caution prélevée pour rien.
   */
  settleBeforeSimulate?: boolean
}

/** Contexte serveur attaché à un Challenge MPP. Jamais transmis au client. */
interface ChallengeContext {
  requirements: PaymentRequirements
  conditionHash: Hex
  actionHash: Hex
  bond: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Le serveur
// ─────────────────────────────────────────────────────────────────────────────

export function createGateway(cfg: GatewayConfig) {
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000))
  const store = cfg.store ?? memoryWarrantStore()
  const challenges = new ChallengeStore<ChallengeContext>({
    secret: cfg.mppSecret,
    ...(cfg.challengeTtlSeconds !== undefined ? { ttlSeconds: cfg.challengeTtlSeconds } : {}),
    now,
    ...(cfg.challengeSalt ? { salt: cfg.challengeSalt } : {}),
  })
  const randomNonce =
    cfg.randomNonce ?? (() => BigInt(toHex(crypto.getRandomValues(new Uint8Array(32)))))
  const mppMethod = cfg.mppMethod ?? 'tempo'
  const mppCurrency = cfg.mppCurrency ?? cfg.asset
  const resourceUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/warrants`

  const app = new Hono()

  // ── POST /v1/quote — gratuit, sans authentification ───────────────────────
  //
  // La porte d'entrée sans friction : un agent peut connaître le prix et
  // l'engagement exact avant d'ouvrir son portefeuille. C'est aussi ce qui rend
  // la tarification auditable — le devis est reproductible par un tiers.
  app.post('/v1/quote', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return sendProblem(c, badJson())
    }

    let priced: PricedAction
    try {
      priced = priceAction(body, cfg)
    } catch (err) {
      return sendProblem(c, problemFor(err))
    }

    return c.json({
      category: priced.quote.category,
      bond: priced.quote.bond,
      riskBps: priced.quote.riskBps,
      notionalUSD: priced.quote.notionalUSD,
      rationale: priced.quote.rationale,
      registryRef: priced.classification.registryRef,
      conditionSpec: priced.conditionSpec,
      conditionHash: priced.conditionHash,
      actionHash: priced.actionHash,
      params: priced.classification.params,
      /**
       * Rappel explicite du modèle de menace : si l'appelant a déclaré une
       * catégorie, elle n'a servi à rien. Le dire est plus utile que de refuser
       * la requête — un agent honnête corrige, un agent hostile apprend que le
       * champ ne lui donne aucune prise.
       */
      ...(body['category'] !== undefined
        ? {
            ignoredFields: {
              category: body['category'],
              note:
                'la catégorie est dérivée du calldata, jamais déclarée — ' +
                'le champ reçu a été ignoré (docs/13 § 5)',
            },
          }
        : {}),
      payment: {
        amount: priced.quote.bond,
        asset: cfg.asset,
        network: cfg.network,
        payTo: cfg.payTo,
        protocols: ['x402', 'mpp'],
      },
    })
  })

  // ── POST /v1/warrants — payant, dual-rail ─────────────────────────────────
  app.post('/v1/warrants', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return sendProblem(c, badJson())
    }

    // 1-4. Classifier, construire la post-condition depuis la politique,
    //      injecter `calldata_matches_commitment`, calculer les engagements.
    let priced: PricedAction
    try {
      priced = priceAction(body, cfg)
    } catch (err) {
      return sendProblem(c, problemFor(err))
    }

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network: cfg.network,
      amount: priced.quote.bond,
      asset: cfg.asset,
      payTo: cfg.payTo,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS,
      extra: {
        name: cfg.assetExtra.name,
        version: cfg.assetExtra.version,
        assetTransferMethod: cfg.assetExtra.assetTransferMethod ?? 'eip3009',
      },
    }

    const x402Header = c.req.header(HEADER_PAYMENT_SIGNATURE)
    const authHeader = c.req.header(HEADER_AUTHORIZATION)
    const rail: Rail | undefined = x402Header
      ? 'x402'
      : authHeader && /^payment\s/i.test(authHeader.trim())
        ? 'mpp'
        : undefined

    // 5. Pas de paiement → 402 avec les **deux** challenges, simultanément.
    if (!rail) {
      return challengeResponse(c, priced, requirements)
    }

    // 6. Résolution du paiement, quel que soit le rail : le facilitateur voit le
    //    même `PaymentPayload` dans les deux cas.
    let resolved: ResolvedPayment
    try {
      resolved =
        rail === 'x402'
          ? resolveX402(x402Header as string, requirements, resourceUrl)
          : resolveMpp(authHeader as string, requirements, resourceUrl, challenges)
    } catch (err) {
      if (err instanceof MppError && err.code === 'challenge_replayed') {
        // Un Credential vaut pour exactement une requête. On ne réémet pas de
        // Challenge : le client doit repartir d'une requête neuve, sans quoi
        // « rejeu refusé » deviendrait « rejeu réessayable ».
        return sendProblem(
          c,
          problem(
            'challenge_replayed',
            409,
            'Credential déjà utilisé',
            err.message,
            { rail },
          ),
        )
      }
      return paymentErrorResponse(c, priced, requirements, rail, err)
    }

    // 7. `verify` — aucun fonds ne bouge encore.
    let verified: { payer?: string }
    try {
      const verification = await cfg.facilitator.verify(resolved.payload, requirements)
      if (!verification.isValid) {
        return paymentErrorResponse(
          c,
          priced,
          requirements,
          rail,
          new PaymentRejected(
            'verification_failed',
            verification.invalidReason ?? 'le facilitateur refuse le paiement',
          ),
        )
      }
      verified = verification
    } catch (err) {
      return sendProblem(
        c,
        problem(
          'facilitator_unavailable',
          502,
          'Facilitateur indisponible',
          errText(err),
          { rail },
        ),
      )
    }

    // Forme nominative exigée par KeeperHub, dérivée du calldata engagé.
    let call: KeeperHubCall
    try {
      call = keeperHubCallOf(priced.actionSpec, {
        registry: cfg.registry,
        ...(typeof body['signature'] === 'string'
          ? { signature: body['signature'] }
          : {}),
      })
    } catch (err) {
      return sendProblem(c, problemFor(err))
    }

    let settlement: SettlementResponse | undefined
    let simulation: SimulationOutcome | undefined

    const doSettle = async (): Promise<ProblemDetails | undefined> => {
      try {
        const result = await cfg.facilitator.settle(resolved.payload, requirements)
        if (!result.success) {
          return problem(
            'settlement_failed',
            402,
            'Règlement en échec',
            result.errorReason ?? 'le facilitateur rapporte un règlement en échec',
            { rail },
          )
        }
        settlement = result
        return undefined
      } catch (err) {
        return problem(
          'facilitator_unavailable',
          502,
          'Facilitateur indisponible',
          errText(err),
          { rail },
        )
      }
    }

    const doSimulate = async (): Promise<ProblemDetails | undefined> => {
      try {
        const result = await cfg.executor.simulateContractCall(call)
        simulation = result
        if (!result.success || result.wouldRevert === true) {
          // Un mandat dont la simulation échoue n'est jamais ouvert.
          return problem(
            'simulation_failed',
            422,
            'Simulation en échec',
            result.revertReason ??
              "l'action reverterait à l'exécution : aucun mandat ouvert, aucune caution prélevée",
            { rail, warrantOpened: false },
          )
        }
        return undefined
      } catch (err) {
        return problem(
          'executor_unavailable',
          502,
          'Exécuteur indisponible',
          errText(err),
          { rail, warrantOpened: false },
        )
      }
    }

    // 8. Simulation **avant** règlement : la caution n'est pas prélevée pour un
    //    échec prévisible. `settleBeforeSimulate` retrouve l'ordre littéral de
    //    docs/04 pour qui le préfère.
    const steps = cfg.settleBeforeSimulate ? [doSettle, doSimulate] : [doSimulate, doSettle]
    for (const step of steps) {
      const failure = await step()
      if (failure) return sendProblem(c, failure)
    }
    if (!settlement || !simulation) {
      return sendProblem(c, problem('internal', 500, 'Règlement incomplet'))
    }

    // 9. `fundingRef` = hash de la transaction de règlement du facilitateur.
    //    Même forme sur les deux rails : c'est le même facilitateur.
    let fundingRef: Hex
    try {
      fundingRef = fundingRefOf(settlement)
    } catch (err) {
      return paymentErrorResponse(c, priced, requirements, rail, err)
    }

    const agent =
      addressFromSource(settlement.payer) ??
      addressFromSource(verified.payer) ??
      addressFromSource(resolved.payer) ??
      addressFromSource(resolved.payload.payload.authorization.from)
    if (!agent) {
      return sendProblem(
        c,
        problem(
          'unknown_payer',
          502,
          'Payeur indéterminé',
          "ni le facilitateur ni le Credential n'identifient une adresse de payeur",
          { rail },
        ),
      )
    }

    const nonce = resolveNonce(body['nonce'], resolved.payload, randomNonce)
    const id = warrantIdOf(agent, nonce, priced.actionHash)
    const openedAt = now()
    const duration = cfg.policy.duration

    // 10. Ouverture onchain. Le Gateway est `opener`, rien d'autre.
    let openTx: Hex | undefined
    try {
      openTx = await cfg.escrow.open({
        id,
        agent,
        beneficiary: cfg.policy.beneficiary,
        bond: priced.quote.bond,
        conditionHash: priced.conditionHash,
        actionHash: priced.actionHash,
        fundingRef,
        duration,
      })
    } catch (err) {
      return sendProblem(
        c,
        problem('open_failed', 502, "Ouverture du mandat en échec", errText(err), {
          rail,
          fundingRef,
        }),
      )
    }

    // 11. Exécution. `idempotencyKey` = l'identifiant du mandat : un retry
    //     réseau ne peut pas diffuser deux transactions pour un même mandat.
    let execution: ExecutionOutcome
    try {
      execution = await cfg.executor.executeContractCall(call, id)
    } catch (err) {
      return sendProblem(
        c,
        problem('execution_failed', 502, "Exécution en échec", errText(err), {
          rail,
          warrantId: id,
          fundingRef,
          note:
            "le mandat est ouvert et expirera vers reclaim : une défaillance d'infrastructure " +
            "n'est pas une post-condition violée",
        }),
      )
    }

    const record: WarrantRecord = {
      id,
      agent,
      beneficiary: cfg.policy.beneficiary,
      bond: priced.quote.bond,
      conditionHash: priced.conditionHash,
      actionHash: priced.actionHash,
      fundingRef,
      expiry: openedAt + duration,
      openedAt,
      status: WarrantStatus.Open,
      rail,
      executionId: execution.executionId,
      ...(openTx ? { openTx } : {}),
      actionSpec: priced.actionSpec,
      conditionSpec: priced.conditionSpec,
      classification: priced.classification,
      quote: priced.quote,
      simulation,
      settlement,
    }
    await store.put(record)

    // 12. Reçu du rail emprunté — et de lui seul.
    if (rail === 'x402') {
      c.header(HEADER_PAYMENT_RESPONSE, encodeHeaderObject(settlement))
    } else {
      c.header(
        HEADER_PAYMENT_RECEIPT,
        encodeReceipt({
          challengeId: resolved.challengeId as string,
          method: mppMethod,
          reference: settlement.transaction,
          settlement: { amount: priced.quote.bond, currency: String(mppCurrency) },
          status: 'success',
          timestamp: new Date(openedAt * 1000).toISOString(),
        }),
      )
    }

    return c.json({
      warrantId: id,
      executionId: execution.executionId,
      conditionHash: priced.conditionHash,
      actionHash: priced.actionHash,
      expiry: openedAt + duration,
      bond: priced.quote.bond,
      category: priced.quote.category,
      fundingRef,
      agent,
      beneficiary: cfg.policy.beneficiary,
    })
  })

  // ── GET /v1/warrants/:id ──────────────────────────────────────────────────
  app.get('/v1/warrants/:id', async (c) => {
    const raw = c.req.param('id')
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
      return sendProblem(
        c,
        problem('bad_warrant_id', 400, 'Identifiant de mandat invalide', raw),
      )
    }
    const record = await store.get(raw.toLowerCase() as Hex)
    if (!record) {
      return sendProblem(c, problem('not_found', 404, 'Mandat inconnu', raw))
    }

    const verdict = cfg.verdicts ? await cfg.verdicts.get(record.id) : undefined

    return c.json({
      warrant: {
        id: record.id,
        agent: record.agent,
        beneficiary: record.beneficiary,
        bond: record.bond,
        conditionHash: record.conditionHash,
        actionHash: record.actionHash,
        fundingRef: record.fundingRef,
        expiry: record.expiry,
        openedAt: record.openedAt,
        status: WarrantStatus[record.status],
      },
      rail: record.rail,
      execution: { executionId: record.executionId },
      quote: {
        category: record.quote.category,
        bond: record.quote.bond,
        riskBps: record.quote.riskBps,
        notionalUSD: record.quote.notionalUSD,
        rationale: record.quote.rationale,
      },
      actionSpec: record.actionSpec,
      conditionSpec: record.conditionSpec,
      // Un verdict sans `checks[]` est une assertion ; avec, c'est une preuve
      // rejouable (docs/04 « Modèle de données »).
      verdict: verdict ?? null,
      checks: verdict?.checks ?? [],
    })
  })

  // ── GET /openapi.json ─────────────────────────────────────────────────────
  app.get('/openapi.json', (c) =>
    c.json(
      openapiDocument({
        baseUrl: cfg.baseUrl,
        network: cfg.network,
        asset: cfg.asset,
        minBond: cfg.policy.minBond,
        maxBond: cfg.policy.maxBond,
        mppMethod,
        ...cfg.openapi,
      }),
    ),
  )

  app.get('/healthz', (c) => c.json({ ok: true, now: now() }))

  return app

  // ── helpers liés à la configuration ───────────────────────────────────────

  /**
   * Émet un 402 portant les **deux** challenges.
   *
   * `opts.problem` remplit le corps en RFC 9457 (chemin MPP) ; `opts.error`
   * remplit le champ `error` du `PaymentRequired` (format propriétaire x402).
   * Sans ni l'un ni l'autre, le corps est `{}` — toute l'information étant dans
   * les en-têtes.
   */
  function challengeResponse(
    c: Context,
    priced: PricedAction,
    requirements: PaymentRequirements,
    opts: { problem?: ProblemDetails; error?: string } = {},
  ) {
    const request: MppRequestBody = {
      amount: priced.quote.bond,
      currency: String(mppCurrency),
      recipient: cfg.payTo,
    }
    const challenge: MppChallenge = challenges.issue({
      realm: cfg.realm,
      method: mppMethod,
      intent: 'charge',
      request,
      opaque: {
        route: '/v1/warrants',
        conditionHash: priced.conditionHash,
        actionHash: priced.actionHash,
      },
      description: `Caution pour ${priced.quote.category}`,
      context: {
        requirements,
        conditionHash: priced.conditionHash,
        actionHash: priced.actionHash,
        bond: priced.quote.bond,
      },
    })

    // Les deux challenges, simultanément, sur la même route.
    c.header(HEADER_WWW_AUTHENTICATE, formatChallengeHeader(challenge))
    c.header(
      HEADER_PAYMENT_REQUIRED,
      encodeHeaderObject(
        buildPaymentRequired({
          resource: {
            url: resourceUrl,
            description: `Bond for a KeeperHub-executed action (${priced.quote.category})`,
            mimeType: 'application/json',
          },
          network: requirements.network,
          amount: requirements.amount,
          asset: requirements.asset,
          payTo: requirements.payTo,
          extra: cfg.assetExtra,
          maxTimeoutSeconds: requirements.maxTimeoutSeconds,
          ...(opts.error ? { error: opts.error } : {}),
          extensions: {
            'warrant/commitment': {
              info: {
                conditionHash: priced.conditionHash,
                actionHash: priced.actionHash,
                category: priced.quote.category,
              },
            },
          },
        }),
      ),
    )

    if (opts.problem) {
      return c.body(JSON.stringify(opts.problem), 402, {
        'content-type': PROBLEM_CONTENT_TYPE,
      })
    }
    // Corps `{}` : toute l'information est dans les en-têtes (docs/05 § 1.2).
    return c.json({}, 402)
  }

  function paymentErrorResponse(
    c: Context,
    priced: PricedAction,
    requirements: PaymentRequirements,
    rail: Rail,
    err: unknown,
  ) {
    const detail = errText(err)
    const code =
      err instanceof PaymentRejected
        ? err.reason
        : err instanceof MppError
          ? err.code
          : err instanceof WireFormatError
            ? 'malformed_payment_header'
            : 'payment_rejected'

    // Rail MPP → RFC 9457. Rail x402 → format propriétaire x402, c'est-à-dire
    // un nouveau 402 dont le `PaymentRequired` porte l'explication (docs/05 § 2.7).
    return rail === 'mpp'
      ? challengeResponse(c, priced, requirements, {
          problem: problem(code, 402, 'Paiement refusé', detail, { rail }),
        })
      : challengeResponse(c, priced, requirements, { error: `${code}: ${detail}` })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarification — le seul intrant est l'ActionSpec
// ─────────────────────────────────────────────────────────────────────────────

export interface PricedAction {
  actionSpec: ActionSpec
  classification: Classification
  quote: Quote
  conditionSpec: ConditionSpec
  conditionHash: Hex
  actionHash: Hex
}

/**
 * Classifier → politique → tarif, dans cet ordre et sans autre intrant que
 * l'`ActionSpec`.
 *
 * `body.category`, `body.notionalUSD` et tout autre champ déclaratif sont
 * ignorés : ils ne sont même pas lus ici. Deux requêtes qui ne diffèrent que
 * par ces champs produisent le même `conditionHash` et la même caution — c'est
 * précisément ce que le test de reproductibilité vérifie.
 */
export function priceAction(body: Record<string, unknown>, cfg: GatewayConfig): PricedAction {
  const actionSpec = validateActionSpec(body['actionSpec'])
  const classification = classify(actionSpec, cfg.registry)

  // Le `registryRef` déclaré est engagé sous `actionHash` : s'il désignait une
  // autre version du registre que celle qui a servi à classifier, un tiers
  // rejouerait `classify` avec le mauvais registre et pourrait constater une
  // catégorie différente sans qu'aucune des deux parties n'ait menti. Le refus
  // porte la valeur attendue pour que la correction tienne en un aller-retour.
  if (actionSpec.registryRef.toLowerCase() !== classification.registryRef.toLowerCase()) {
    throw new RegistryMismatchError(actionSpec.registryRef, classification.registryRef)
  }

  const actionHash = hashAction(actionSpec)

  // `priceRisk` délègue à `buildConditionSpec`, qui injecte d'office
  // `calldata_matches_commitment` dès qu'un `actionHash` est fourni. Un seul
  // chemin de construction, donc aucune spec produite sans l'engagement.
  const quote = priceRisk(classification, cfg.policy, {
    chainId: actionSpec.chainId,
    actionHash,
  })
  // Ceinture et bretelles : refuse de servir une spec sans le vérificateur
  // d'engagement, quelle qu'en soit la cause.
  const conditionSpec = validateGatewayConditionSpec(quote.conditionSpec)

  return {
    actionSpec,
    classification,
    quote,
    conditionSpec,
    conditionHash: hashCondition(conditionSpec),
    actionHash,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Résolution du paiement
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedPayment {
  payload: PaymentPayload
  payer?: string
  challengeId?: string
}

function resolveX402(
  header: string,
  requirements: PaymentRequirements,
  resourceUrl: string,
): ResolvedPayment {
  const payload = decodeHeaderObject<PaymentPayload>(header)
  assertPayloadMatches(payload, requirements)
  return {
    payload: { ...payload, resource: payload.resource ?? { url: resourceUrl } },
    ...(payload.payload?.authorization?.from
      ? { payer: payload.payload.authorization.from }
      : {}),
  }
}

function resolveMpp(
  header: string,
  requirements: PaymentRequirements,
  resourceUrl: string,
  challenges: ChallengeStore<ChallengeContext>,
): ResolvedPayment {
  const credential: MppCredential = decodeCredentialHeader(header)
  // Consommation stricte : Challenge connu, non expiré, réécho tel quel, jamais
  // rejoué. Toute anomalie lève une `MppError`.
  const entry = challenges.consume(credential)

  // Le montant engagé est celui du Challenge émis, pas celui que le Credential
  // recopie : le Challenge est lié cryptographiquement à son `id`.
  if (entry.context.bond !== requirements.amount) {
    throw new PaymentRejected(
      'amount_mismatch',
      `Challenge émis pour ${entry.context.bond}, caution recalculée à ${requirements.amount}`,
    )
  }

  const payload = paymentPayloadFromCredential(credential, requirements, resourceUrl)
  assertPayloadMatches(payload, requirements)
  return {
    payload,
    ...(credential.source ? { payer: credential.source } : {}),
    challengeId: entry.challenge.id,
  }
}

/**
 * `nonce` du mandat.
 *
 * À défaut d'un nonce fourni, on reprend celui de l'autorisation EIP-3009 :
 * 32 octets aléatoires **jamais réutilisés** par construction du scheme. Le
 * `warrantId` hérite donc de l'unicité du paiement qui le finance, et les deux
 * rails — qui portent la même autorisation — produisent le même identifiant.
 */
function resolveNonce(
  declared: unknown,
  payload: PaymentPayload,
  fallback: () => bigint,
): bigint {
  if (typeof declared === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(declared)) {
    return BigInt(declared)
  }
  const authNonce = payload.payload?.authorization?.nonce
  if (typeof authNonce === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(authNonce)) {
    return BigInt(authNonce)
  }
  return fallback()
}

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs
// ─────────────────────────────────────────────────────────────────────────────

function badJson(): ProblemDetails {
  return problem('malformed_request', 400, 'Corps de requête illisible', 'JSON attendu')
}

function problemFor(err: unknown): ProblemDetails {
  if (err instanceof ClassificationError) {
    return problem(
      'classification_refused',
      422,
      'Action non classifiable',
      err.message,
      { code: err.code },
    )
  }
  if (err instanceof DslError) {
    return problem('invalid_spec', 400, 'Spécification invalide', err.message, {
      issues: (err as unknown as { issues?: unknown }).issues ?? [],
    })
  }
  if (err instanceof PolicyError) {
    return problem('policy_gap', 422, 'Politique incomplète', err.message)
  }
  if (err instanceof RiskError) {
    return problem('policy_gap', 422, 'Politique incohérente', err.message)
  }
  if (err instanceof RegistryMismatchError) {
    return problem(
      'registry_mismatch',
      422,
      'Version de registre incompatible',
      err.message,
      { declared: err.declared, expected: err.expected },
    )
  }
  if (err instanceof ActionEncodingError) {
    return problem('unencodable_action', 422, 'Action non exécutable', err.message)
  }
  if (err instanceof FacilitatorError) {
    return problem('facilitator_unavailable', 502, 'Facilitateur indisponible', err.message)
  }
  return problem('internal', 500, 'Erreur interne', errText(err))
}

function sendProblem(c: Context, details: ProblemDetails) {
  return c.body(JSON.stringify(details), details.status as ContentfulStatusCode, {
    'content-type': PROBLEM_CONTENT_TYPE,
  })
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─────────────────────────────────────────────────────────────────────────────
// Implémentations par défaut des ports
// ─────────────────────────────────────────────────────────────────────────────

export interface KeeperHubExecutorConfig {
  /** Clé d'organisation `kh_`. Une clé `wfb_` est rejetée en 401 partout. */
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * Exécuteur HTTP KeeperHub, dans la forme que l'API accepte réellement.
 *
 * Ne réutilise pas `KeeperHubClient.executeContractCall` : son
 * `ContractCallRequest` envoie un champ `data` porteur du calldata, forme
 * qu'aucune route KeeperHub n'accepte — `data`, `callData` et `calldata` sont
 * ignorés, et seuls `functionName` + `functionArgs` sont lus
 * (repo/docs/onboarding-teardown.md, 14:12).
 */
export function keeperHubExecutor(cfg: KeeperHubExecutorConfig): ExecutorPort {
  const baseUrl = (cfg.baseUrl ?? 'https://app.keeperhub.com').replace(/\/+$/, '')
  const fetchImpl = cfg.fetchImpl ?? fetch

  async function post(
    body: Record<string, unknown>,
    extraHeaders: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`${baseUrl}/api/execute/contract-call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const detail = typeof json['detail'] === 'string' ? json['detail'] : res.statusText
      throw new Error(`KeeperHub ${res.status} ${String(json['error'] ?? '')}: ${detail}`)
    }
    return (json['data'] as Record<string, unknown>) ?? json
  }

  return {
    async simulateContractCall(call) {
      // `simulate` doit être un booléen strict : l'API rejette `"true"` en 400,
      // précisément pour qu'une coercition ne devienne pas une diffusion réelle.
      const data = await post({ ...callBody(call), simulate: true }, {})
      const result = (data['result'] ?? data) as Record<string, unknown>
      return {
        success: result['success'] !== false,
        ...(typeof result['wouldRevert'] === 'boolean'
          ? { wouldRevert: result['wouldRevert'] }
          : {}),
        ...(typeof result['revertReason'] === 'string'
          ? { revertReason: result['revertReason'] }
          : {}),
        ...(result['gasEstimate'] !== undefined
          ? { gasEstimate: String(result['gasEstimate']) }
          : {}),
      }
    },
    async executeContractCall(call, idempotencyKey) {
      const data = await post(
        { ...callBody(call), simulate: false },
        idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
      )
      const txHash =
        (data['transactionHash'] as Hex | undefined) ??
        ((data['result'] as Record<string, unknown> | undefined)?.['transactionHash'] as
          | Hex
          | undefined)
      return {
        executionId: String(data['executionId'] ?? data['id'] ?? ''),
        status: String(data['status'] ?? 'unknown'),
        ...(txHash ? { txHash } : {}),
      }
    },
  }
}

function callBody(call: KeeperHubCall): Record<string, unknown> {
  return {
    chainId: call.chainId,
    contractAddress: call.contractAddress,
    functionName: call.functionName,
    // Chaîne JSON, pas tableau. Un tableau est rejeté en 400.
    functionArgs: call.functionArgs,
    value: call.value ?? '0',
  }
}

export interface ViemEscrowConfig {
  address: Address
  account: Address
  chain: unknown
  walletClient: {
    writeContract(args: Record<string, unknown>): Promise<Hex>
  }
}

/** `EscrowPort` adossé à un `WalletClient` viem portant la clé `opener`. */
export function viemEscrow(cfg: ViemEscrowConfig, abi: unknown): EscrowPort {
  return {
    async open(args) {
      return cfg.walletClient.writeContract({
        address: cfg.address,
        abi,
        account: cfg.account,
        chain: cfg.chain,
        functionName: 'open',
        args: [
          args.id,
          args.agent,
          args.beneficiary,
          BigInt(args.bond),
          args.conditionHash,
          args.actionHash,
          args.fundingRef,
          BigInt(args.duration),
        ],
      })
    },
  }
}

export { X402_VERSION }
