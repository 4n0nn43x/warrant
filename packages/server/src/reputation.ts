/**
 * ERC-8004 — inscription des verdicts Warrant dans le Reputation Registry.
 *
 * Ce module fait trois choses, et rien d'autre :
 *
 *   1. il construit le **document de feedback off-chain** au format normalisé
 *      de la spec ERC-8004 (§ « Off-Chain Feedback File Structure »), y compris
 *      le champ `proofOfPayment` qui est le pont normalisé entre le paiement
 *      x402 et la réputation ;
 *   2. il calcule `feedbackHash = keccak256(canonicalize(doc))` avec la
 *      canonicalisation JCS de `@warrant/core` — la même que celle qui produit
 *      le `conditionHash` onchain, une seule implémentation, jamais deux ;
 *   3. il appelle `giveFeedback` depuis l'adresse du Settler.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Vocabulaire — un feedback ERC-8004 n'est jamais une attestation signée
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EIP-712 et ERC-1271 n'y servent qu'à `setAgentWallet`. Aucune signature n'est
 * attachée à un feedback : l'authenticité repose **uniquement sur `msg.sender`**,
 * ici l'adresse du Settler. Le mot « signed » de la spec qualifie la *valeur*
 * (`int128`, donc négative possible), pas le message. Il n'y a ni attestation
 * détachée, ni relais possible par un tiers : celui qui note est celui qui
 * envoie la transaction.
 *
 * La formulation exacte est donc : verdict **inscrit** dans le registre par
 * l'adresse du Settler, avec engagement `keccak256` sur son contenu.
 *
 * La vérifiabilité vient du couple `feedbackURI` + `feedbackHash` : n'importe
 * qui télécharge le document, le canonicalise, recalcule le `keccak256` et
 * compare — voir `verifyFeedbackHash`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce qui n'est pas lisible en storage
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `endpoint`, `feedbackURI` et `feedbackHash` ne sont **pas stockés**. Ils ne
 * sont émis que dans l'event `NewFeedback`. `readFeedback` ne rend que `value`,
 * `valueDecimals`, `tag1`, `tag2` et `isRevoked`. Relire un verdict Warrant
 * exige donc d'indexer les logs — c'est ce que fait `@warrant/reputation-reader`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Sources
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ABI et invariants repris verbatim de `erc-8004/erc-8004-contracts@master` :
 *   - `abis/ReputationRegistry.json`, `abis/IdentityRegistry.json`
 *   - `contracts/ReputationRegistryUpgradeable.sol` (garde-fou anti-auto-notation)
 *   - `ERC8004SPEC.md` (structure du fichier de feedback, `proofOfPayment`)
 *
 * Voir docs/10-erc8004.md.
 */

import {
  ERC8004,
  canonicalize,
  hashCanonical,
  normalizeActionSpec,
  normalizeConditionSpec,
} from '@warrant/core'
import type {
  ActionSpec,
  Address,
  CheckResult,
  Classification,
  ConditionSpec,
  Hex,
  VerdictDocument,
} from '@warrant/core'
import { encodeFunctionData, stringToHex } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// ABI — récupérée, jamais inventée
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ReputationRegistry`, sous-ensemble utile de
 * `erc-8004/erc-8004-contracts@master:abis/ReputationRegistry.json`.
 *
 * `giveFeedback` prend **huit** paramètres. `endpoint`, en sixième position,
 * est le piège : il est optionnel, il ne nous sert à rien, et l'omettre décale
 * `feedbackURI` et `feedbackHash`. On le passe en chaîne vide, jamais absent.
 *
 * ⚠ Les registres sont **upgradeable** (UUPS derrière un ERC-1967). L'ABI est
 * figée ici, mais elle décrit l'implémentation courante : à revérifier contre
 * l'implémentation, pas seulement contre le proxy.
 */
export const reputationRegistryAbi = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'readFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'getIdentityRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true },
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeedbackRevoked',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: true },
    ],
  },
] as const

/**
 * `IdentityRegistry` (ERC-721), sous-ensemble utile.
 *
 * ⚠ `isAuthorizedOrOwner` est présente dans l'implémentation déployée
 * (`contracts/IdentityRegistryUpgradeable.sol`, ligne 205) et c'est **elle** que
 * `ReputationRegistry.giveFeedback` appelle pour interdire l'auto-notation.
 * Elle est pourtant **absente de `abis/IdentityRegistry.json`** : le fichier
 * d'ABI publié est en retard sur la source. On la déclare explicitement, et
 * `canGiveFeedback` sait retomber sur la décomposition ERC-721 équivalente
 * (`ownerOf` / `getApproved` / `isApprovedForAll`) si l'appel échoue.
 *
 * Un seul `register` est déclaré — la surcharge à deux arguments — pour ne pas
 * exposer viem à une résolution de surcharge ambiguë.
 */
export const identityRegistryAbi = [
  {
    type: 'function',
    name: 'isAuthorizedOrOwner',
    stateMutability: 'view',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getApproved',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getMetadata',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'setMetadata',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
      {
        name: 'metadata',
        type: 'tuple[]',
        components: [
          { name: 'metadataKey', type: 'string' },
          { name: 'metadataValue', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Constantes du mapping Warrant → ERC-8004
// ─────────────────────────────────────────────────────────────────────────────

/** Rend tous les feedbacks Warrant filtrables par n'importe quel client ERC-8004. */
export const FEEDBACK_TAG1 = 'warrant' as const

/**
 * `endpoint`, sixième paramètre de `giveFeedback`. Toujours la chaîne vide :
 * Warrant ne note pas un point de terminaison HTTP, il note un mandat.
 * Jamais omis — l'omettre décalerait `feedbackURI` et `feedbackHash`.
 */
export const FEEDBACK_ENDPOINT = '' as const

/** `valueDecimals = 2` → `value = ±100` se lit `+1.00` / `−1.00`. */
export const VERDICT_VALUE_DECIMALS = 2 as const

/** `int128 value`, en unités de 10⁻². Négatif = saisie. */
export const VERDICT_VALUE = {
  honored: 100n,
  slashed: -100n,
} as const

/** `require(valueDecimals <= 18)` — ReputationRegistryUpgradeable.sol:105. */
export const MAX_VALUE_DECIMALS = 18

/** `MAX_ABS_VALUE = 1e38` — ReputationRegistryUpgradeable.sol:12. */
export const MAX_ABS_VALUE = 10n ** 38n

/** Base d'URI par défaut du document de verdict. */
export const DEFAULT_FEEDBACK_URI_BASE = 'https://warrant.sh/v/'

/** Clés de métadonnées écrites sur l'identité de l'agent (docs/10 § 4). */
export const METADATA_KEYS = {
  escrow: 'warrant.escrow',
  since: 'warrant.since',
} as const

/** Verdicts possibles d'un mandat, `reclaimed` compris. */
export type WarrantVerdict = 'honored' | 'slashed' | 'reclaimed'

/**
 * Document de verdict tel que le produit le Settler, élargi à `reclaimed`.
 * `VerdictDocument` de `@warrant/core` ne connaît que `honored` / `slashed` :
 * un mandat expiré ne produit pas de document publiable, mais il traverse
 * quand même `publishVerdict`, qui doit pouvoir le refuser explicitement.
 */
export type PublishableVerdictDocument = Omit<VerdictDocument, 'verdict'> & {
  verdict: WarrantVerdict
}

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs
// ─────────────────────────────────────────────────────────────────────────────

export class ReputationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReputationError'
  }
}

/** Raison pour laquelle le soumetteur ne peut pas noter cet `agentId`. */
export type AuthorizationBlocker =
  | 'owner'
  | 'operator'
  | 'approved'
  | 'agent-not-registered'
  | 'unknown'

/**
 * Le soumetteur ne peut pas écrire ce feedback. Levée **avant** toute
 * transaction : découvrir le problème après 150 mandats réglés et zéro feedback
 * publié n'est pas une option.
 */
export class ReputationAuthorizationError extends ReputationError {
  readonly blocker: AuthorizationBlocker
  readonly agentId: bigint
  readonly submitter: Address
  readonly agentOwner?: Address

  constructor(opts: {
    message: string
    blocker: AuthorizationBlocker
    agentId: bigint
    submitter: Address
    agentOwner?: Address
  }) {
    super(opts.message)
    this.name = 'ReputationAuthorizationError'
    this.blocker = opts.blocker
    this.agentId = opts.agentId
    this.submitter = opts.submitter
    if (opts.agentOwner) this.agentOwner = opts.agentOwner
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clients — interfaces structurelles minimales, pour rester mockables
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadContractRequest {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}

export interface WriteContractRequest {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
  account: Address
  chain?: unknown
}

/** Sous-ensemble de `PublicClient` dont ce module a besoin. */
export interface ReputationPublicClient {
  readContract(request: ReadContractRequest): Promise<unknown>
}

/** Sous-ensemble de `WalletClient` dont ce module a besoin. */
export interface ReputationWalletClient {
  writeContract(request: WriteContractRequest): Promise<Hex>
}

// ─────────────────────────────────────────────────────────────────────────────
// Le document de feedback off-chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pont normalisé entre le paiement x402 et la réputation, tel que défini par
 * `ERC8004SPEC.md` : *« this can be used for x402 proof of payment »*.
 *
 * On l'utilise plutôt qu'un format maison précisément pour qu'un client
 * ERC-8004 qui ne connaît pas Warrant sache quand même relier le feedback au
 * règlement qui l'a financé.
 *
 * `txHash` est le hash de la transaction d'**ouverture** du mandat, et non le
 * `fundingRef` : depuis que `open()` tire lui-même le paiement EIP-3009, c'est
 * cette transaction qui déplace l'USDC, et `fundingRef` n'est plus qu'un nonce
 * — unique, mais ne désignant aucune transaction. Un consommateur qui résout
 * `txHash` chez un explorateur doit tomber sur un transfert réel.
 */
export interface ProofOfPayment {
  fromAddress: Address
  toAddress: Address
  /** Chaîne décimale, comme dans l'exemple de la spec (`"1"`). */
  chainId: string
  txHash: Hex
}

/** Projection déterministe d'un mandat réglé à l'intérieur du document. */
export interface WarrantVerdictRecord {
  warrantId: Hex
  executionId: string
  txHash: Hex
  blockNumber: string
  gasUsed: string
  outcome: string
  conditionSpec: ConditionSpec
  actionSpec: ActionSpec
  classification: Classification
  checks: CheckResult[]
  verdict: 'honored' | 'slashed'
  evaluatedAtBlock: string
  rpcUrl: string
  /** `null` quand le règlement n'a pas encore de hash — jamais absent. */
  settlementTx: Hex | null
  /** Présent seulement dans un document agrégé, où il est par mandat. */
  proofOfPayment?: ProofOfPayment
}

/** Champs communs, au format normalisé de `ERC8004SPEC.md`. */
export interface FeedbackDocumentBase {
  // MUST FIELDS de la spec
  agentRegistry: string
  agentId: number
  clientAddress: string
  createdAt: string
  value: number
  valueDecimals: number
  // OPTIONAL FIELDS que Warrant remplit
  tag1: typeof FEEDBACK_TAG1
  tag2: 'honored' | 'slashed'
  endpoint: string
}

/** Un mandat, un feedback. Le cas d'une saisie. */
export interface SingleFeedbackDocument extends FeedbackDocumentBase {
  proofOfPayment?: ProofOfPayment
  warrant: WarrantVerdictRecord
}

/** N mandats honorés, un feedback agrégé. Le cas du lot (docs/10 § 5). */
export interface BatchFeedbackDocument extends FeedbackDocumentBase {
  warrantCount: number
  warrants: WarrantVerdictRecord[]
}

export type FeedbackDocument = SingleFeedbackDocument | BatchFeedbackDocument

/** `eip155:<chainId>:<address>` — la forme CAIP-10 employée par la spec. */
export function caip10(chainId: number, address: Address): string {
  return `eip155:${chainId}:${address.toLowerCase()}`
}

function lowerHex(value: string, path: string): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new ReputationError(`${path}: attendu un hex 0x…, reçu ${JSON.stringify(value)}`)
  }
  return value.toLowerCase() as Hex
}

/**
 * Reconstruit un enregistrement de mandat depuis une liste blanche.
 *
 * Deux exclusions volontaires :
 *   - `reputationTx` : le hash de la transaction ERC-8004 n'est connu qu'après
 *     l'écriture. L'inclure rendrait `feedbackHash` circulaire et invérifiable.
 *   - tout champ inattendu du document d'entrée : rien d'imprévu ne doit se
 *     glisser dans ce qui est haché.
 *
 * `settlementTx` absent devient `null` plutôt que d'être omis — même règle que
 * `@warrant/core` : aucun champ optionnel absent, sinon deux documents
 * sémantiquement identiques produiraient deux hashs (docs/07 § 4, règle 4).
 */
export function toVerdictRecord(
  doc: PublishableVerdictDocument,
  proofOfPayment?: ProofOfPayment,
): WarrantVerdictRecord {
  if (doc.verdict === 'reclaimed') {
    throw new ReputationError(
      "un mandat 'reclaimed' ne produit aucun document de feedback : " +
        "l'expiration n'est la faute de personne (docs/10 § 5)",
    )
  }

  const record: WarrantVerdictRecord = {
    warrantId: lowerHex(doc.warrantId, 'warrantId'),
    executionId: String(doc.executionId),
    txHash: lowerHex(doc.txHash, 'txHash'),
    blockNumber: String(doc.blockNumber),
    gasUsed: String(doc.gasUsed),
    outcome: String(doc.outcome),
    conditionSpec: normalizeConditionSpec(doc.conditionSpec),
    actionSpec: normalizeActionSpec(doc.actionSpec),
    classification: {
      category: doc.classification.category,
      params: { ...doc.classification.params },
      notionalUSD: String(doc.classification.notionalUSD),
      registryRef: lowerHex(doc.classification.registryRef, 'classification.registryRef'),
    },
    checks: doc.checks.map((c) => ({
      kind: c.kind,
      expected: String(c.expected),
      observed: String(c.observed),
      pass: Boolean(c.pass),
    })),
    verdict: doc.verdict,
    evaluatedAtBlock: String(doc.evaluatedAtBlock),
    rpcUrl: String(doc.rpcUrl),
    settlementTx: doc.settlementTx ? lowerHex(doc.settlementTx, 'settlementTx') : null,
  }

  if (proofOfPayment) record.proofOfPayment = normalizeProof(proofOfPayment)
  return record
}

function normalizeProof(p: ProofOfPayment): ProofOfPayment {
  return {
    fromAddress: p.fromAddress.toLowerCase() as Address,
    toAddress: p.toAddress.toLowerCase() as Address,
    chainId: String(p.chainId),
    txHash: lowerHex(p.txHash, 'proofOfPayment.txHash'),
  }
}

export interface BuildFeedbackOptions {
  agentId: bigint | number
  chainId: number
  /** Adresse du Settler — l'auteur onchain, et la seule preuve d'origine. */
  settler: Address
  /** `IdentityRegistry` de la chaîne, pour le champ `agentRegistry`. */
  identityRegistry: Address
  /** Preuve de paiement x402 du mandat (`fundingRef`). */
  proofOfPayment?: ProofOfPayment
  /** ISO 8601 UTC. Injecté pour rendre le hash reproductible en test. */
  createdAt?: string
}

function agentIdAsNumber(agentId: bigint | number): number {
  const n = typeof agentId === 'bigint' ? Number(agentId) : agentId
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ReputationError(
      `agentId ${agentId} n'est pas un entier JSON sûr ; le document de feedback ` +
        "de la spec le sérialise en nombre, pas en chaîne — l'implémentation " +
        'devra être revue si le registre atteint 2⁵³ identités',
    )
  }
  return n
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function baseDocument(
  verdict: 'honored' | 'slashed',
  opts: BuildFeedbackOptions,
): FeedbackDocumentBase {
  return {
    agentRegistry: caip10(opts.chainId, opts.identityRegistry),
    agentId: agentIdAsNumber(opts.agentId),
    clientAddress: caip10(opts.chainId, opts.settler),
    createdAt: opts.createdAt ?? nowIso(),
    value: Number(VERDICT_VALUE[verdict]),
    valueDecimals: VERDICT_VALUE_DECIMALS,
    tag1: FEEDBACK_TAG1,
    tag2: verdict,
    endpoint: FEEDBACK_ENDPOINT,
  }
}

/**
 * Construit le document de feedback d'un mandat unique.
 *
 * @throws {ReputationError} sur un verdict `reclaimed` — il n'y a rien à publier.
 */
export function buildFeedbackDocument(
  doc: PublishableVerdictDocument,
  opts: BuildFeedbackOptions,
): SingleFeedbackDocument {
  if (doc.verdict === 'reclaimed') {
    throw new ReputationError(
      "aucun feedback n'est publié pour un mandat 'reclaimed' : une défaillance " +
        "d'infrastructure ne doit jamais dégrader la réputation d'un agent " +
        '(docs/10 § 5)',
    )
  }

  const out: SingleFeedbackDocument = {
    ...baseDocument(doc.verdict, opts),
    warrant: toVerdictRecord(doc),
  }
  if (opts.proofOfPayment) out.proofOfPayment = normalizeProof(opts.proofOfPayment)
  return out
}

/**
 * Construit le document agrégé d'un lot de mandats honorés.
 *
 * `proofOfPayment` reste au niveau de chaque mandat : un lot recouvre N
 * règlements x402 distincts, et en hisser un seul au niveau du document
 * laisserait croire qu'il les couvre tous.
 */
export function buildBatchFeedbackDocument(
  docs: readonly PublishableVerdictDocument[],
  opts: BuildFeedbackOptions & {
    proofsByWarrantId?: Readonly<Record<string, ProofOfPayment>>
  },
): BatchFeedbackDocument {
  if (docs.length === 0) {
    throw new ReputationError('lot vide : rien à publier')
  }
  const offenders = docs.filter((d) => d.verdict !== 'honored')
  if (offenders.length > 0) {
    throw new ReputationError(
      "un lot n'agrège que des mandats honorés ; une saisie s'écrit " +
        `immédiatement et seule (verdicts reçus : ${[...new Set(offenders.map((d) => d.verdict))].join(', ')})`,
    )
  }

  const warrants = docs.map((d) =>
    toVerdictRecord(d, opts.proofsByWarrantId?.[d.warrantId.toLowerCase()]),
  )

  return {
    ...baseDocument('honored', opts),
    warrantCount: warrants.length,
    warrants,
  }
}

/**
 * `feedbackHash = keccak256(utf8(canonicalize(doc)))`.
 *
 * Même canonicalisation JCS que le `conditionHash` onchain : une seule
 * implémentation, réimplémentable en Python ou en Go à l'octet près.
 */
export function feedbackHashOf(doc: FeedbackDocument): Hex {
  return hashCanonical(canonicalize(doc))
}

/** Forme canonique servie à `feedbackURI`. C'est elle qui est hachée. */
export function canonicalFeedbackDocument(doc: FeedbackDocument): string {
  return canonicalize(doc)
}

/**
 * Vérification côté tiers : télécharger le document, le canonicaliser,
 * recalculer le `keccak256`, comparer à ce qui a été émis dans `NewFeedback`.
 */
export function verifyFeedbackHash(doc: FeedbackDocument, expected: Hex): boolean {
  return feedbackHashOf(doc) === expected.toLowerCase()
}

/** URI stable du document de verdict d'un mandat. */
export function feedbackUriFor(warrantId: Hex, base = DEFAULT_FEEDBACK_URI_BASE): string {
  return `${base}${warrantId.toLowerCase()}`
}

/** URI stable d'un lot, indexé par le hash de son contenu. */
export function batchFeedbackUriFor(
  feedbackHash: Hex,
  base = DEFAULT_FEEDBACK_URI_BASE,
): string {
  return `${base}batch/${feedbackHash.toLowerCase()}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Les huit arguments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le tuple positionnel de `giveFeedback`, dans l'ordre exact de l'ABI :
 * `agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash`.
 */
export type GiveFeedbackArgs = readonly [
  agentId: bigint,
  value: bigint,
  valueDecimals: number,
  tag1: string,
  tag2: string,
  endpoint: string,
  feedbackURI: string,
  feedbackHash: Hex,
]

/**
 * Assemble les huit arguments. Séparé de l'envoi pour que le mapping soit
 * testable à sec, sans client ni réseau.
 */
export function giveFeedbackArgs(opts: {
  agentId: bigint | number
  verdict: 'honored' | 'slashed'
  feedbackURI: string
  feedbackHash: Hex
}): GiveFeedbackArgs {
  const agentId = BigInt(opts.agentId)
  const value = VERDICT_VALUE[opts.verdict]

  // Bornes reprises telles quelles de ReputationRegistryUpgradeable.sol.
  if (value < -MAX_ABS_VALUE || value > MAX_ABS_VALUE) {
    throw new ReputationError(`value ${value} hors bornes ±1e38`)
  }
  if (VERDICT_VALUE_DECIMALS > MAX_VALUE_DECIMALS) {
    throw new ReputationError(`valueDecimals doit rester ≤ ${MAX_VALUE_DECIMALS}`)
  }

  return [
    agentId,
    value,
    VERDICT_VALUE_DECIMALS,
    FEEDBACK_TAG1,
    opts.verdict,
    // Sixième position. Vide, jamais absent.
    FEEDBACK_ENDPOINT,
    opts.feedbackURI,
    lowerHex(opts.feedbackHash, 'feedbackHash'),
  ] as const
}

// ─────────────────────────────────────────────────────────────────────────────
// Le garde-fou anti-auto-notation
// ─────────────────────────────────────────────────────────────────────────────

export interface IdentityContext {
  publicClient: ReputationPublicClient
  identityRegistry: Address
}

export interface AuthorizationVerdict {
  ok: boolean
  blocker?: AuthorizationBlocker
  agentOwner?: Address
  /** Comment la réponse a été obtenue — utile en diagnostic. */
  via: 'isAuthorizedOrOwner' | 'erc721-decomposition'
}

/**
 * Le soumetteur peut-il noter cet `agentId` ?
 *
 * `giveFeedback` exige `!isAuthorizedOrOwner(msg.sender, agentId)` — le
 * soumetteur ne doit être ni owner, ni opérateur approuvé, ni approuvé sur le
 * jeton (ReputationRegistryUpgradeable.sol:110). On reproduit exactement le même
 * prédicat, en appelant d'abord la fonction que le registre appelle lui-même.
 *
 * Si cet appel échoue — l'implémentation courante peut différer, et la fonction
 * est absente de l'ABI publiée — on retombe sur la décomposition ERC-721
 * équivalente, celle qu'implémente `_isAuthorized` d'OpenZeppelin.
 */
export async function canGiveFeedback(
  agentId: bigint | number,
  submitter: Address,
  ctx: IdentityContext,
): Promise<AuthorizationVerdict> {
  const id = BigInt(agentId)
  const who = submitter.toLowerCase() as Address

  try {
    const authorized = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'isAuthorizedOrOwner',
      args: [who, id],
    })) as boolean
    if (!authorized) return { ok: true, via: 'isAuthorizedOrOwner' }
    // Le registre refuserait. On cherche l'owner pour un message utile.
    const owner = await safeOwnerOf(id, ctx)
    return {
      ok: false,
      blocker: owner && owner === who ? 'owner' : 'operator',
      ...(owner ? { agentOwner: owner } : {}),
      via: 'isAuthorizedOrOwner',
    }
  } catch {
    // Repli : décomposition ERC-721.
  }

  const lookup = await lookupOwner(id, ctx)
  if (lookup.kind !== 'found') {
    // Distinguer les deux échecs compte : un agent inexistant est une situation
    // normale (l'identité ERC-8004 est optionnelle), un RPC muet ne permet de
    // conclure à rien — et dans le doute on n'écrit pas.
    return {
      ok: false,
      blocker: lookup.kind === 'nonexistent' ? 'agent-not-registered' : 'unknown',
      via: 'erc721-decomposition',
    }
  }
  const owner = lookup.owner
  if (owner === who) {
    return { ok: false, blocker: 'owner', agentOwner: owner, via: 'erc721-decomposition' }
  }

  try {
    const approved = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'getApproved',
      args: [id],
    })) as Address
    if (approved && approved.toLowerCase() === who) {
      return {
        ok: false,
        blocker: 'approved',
        agentOwner: owner,
        via: 'erc721-decomposition',
      }
    }

    const forAll = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'isApprovedForAll',
      args: [owner, who],
    })) as boolean
    if (forAll) {
      return {
        ok: false,
        blocker: 'operator',
        agentOwner: owner,
        via: 'erc721-decomposition',
      }
    }
  } catch {
    // Indéterminé : on ne conclut pas à « autorisé », on refuse d'écrire.
    return {
      ok: false,
      blocker: 'unknown',
      agentOwner: owner,
      via: 'erc721-decomposition',
    }
  }

  return { ok: true, agentOwner: owner, via: 'erc721-decomposition' }
}

type OwnerLookup =
  | { kind: 'found'; owner: Address }
  /** `ERC721NonexistentToken` — l'agentId n'a jamais été frappé. */
  | { kind: 'nonexistent' }
  /** La chaîne n'a pas répondu. On n'en conclut rien. */
  | { kind: 'unavailable'; error: string }

/**
 * Un revert applicatif se reconnaît à son texte ; tout le reste (transport,
 * timeout, nœud saturé) reste « indéterminé ». Approximation assumée : viem
 * expose des classes d'erreur, mais on ne veut pas lier ce module à leur
 * hiérarchie ni la reproduire dans chaque mock de test.
 */
function looksLikeRevert(e: unknown): boolean {
  const text = `${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`.toLowerCase()
  return (
    text.includes('revert') ||
    text.includes('erc721') ||
    text.includes('nonexistent') ||
    text.includes('invalidtoken')
  )
}

async function lookupOwner(agentId: bigint, ctx: IdentityContext): Promise<OwnerLookup> {
  try {
    const owner = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [agentId],
    })) as Address
    return owner
      ? { kind: 'found', owner: owner.toLowerCase() as Address }
      : { kind: 'nonexistent' }
  } catch (e) {
    return looksLikeRevert(e)
      ? { kind: 'nonexistent' }
      : { kind: 'unavailable', error: errText(e) }
  }
}

async function safeOwnerOf(
  agentId: bigint,
  ctx: IdentityContext,
): Promise<Address | undefined> {
  const lookup = await lookupOwner(agentId, ctx)
  return lookup.kind === 'found' ? lookup.owner : undefined
}

const BLOCKER_MESSAGE: Record<AuthorizationBlocker, string> = {
  owner: 'il en est le **owner**',
  operator: 'il en est un **operator** approuvé',
  approved: 'il est **approuvé** sur ce jeton',
  'agent-not-registered': "cet agentId n'existe pas dans l'IdentityRegistry",
  unknown: 'la vérification onchain a échoué',
}

/**
 * Refuse d'écrire si le soumetteur ne peut pas noter cet agent.
 *
 * À appeler **avant** la transaction. Sans elle, on découvrirait le problème
 * avec 150 mandats réglés et zéro feedback publié.
 *
 * @throws {ReputationAuthorizationError}
 */
export async function assertCanGiveFeedback(
  agentId: bigint | number,
  settler: Address,
  ctx: IdentityContext,
): Promise<void> {
  const verdict = await canGiveFeedback(agentId, settler, ctx)
  if (verdict.ok) return

  const blocker = verdict.blocker ?? 'unknown'
  const id = BigInt(agentId)
  const detail = BLOCKER_MESSAGE[blocker]

  const remedy =
    blocker === 'agent-not-registered'
      ? "Enregistrer l'agent depuis sa propre adresse avant de le noter — " +
        "l'enregistrement Warrant est optionnel et jamais bloquant (docs/10 § 4)."
      : blocker === 'unknown'
        ? "Dans le doute on n'écrit pas : un feedback qui reverterait est du gas " +
          "perdu, et un feedback écrit à tort n'est pas rattrapable. Réessayer " +
          'quand le RPC répond.'
        : "L'agent doit être owner de son propre NFT ERC-8004, jamais Warrant, et " +
        "le Settler doit être une adresse tierce, ni owner ni operator. Si l'agent " +
        'a été enregistré depuis une adresse Warrant, aucun verdict ne pourra ' +
        'jamais être inscrit pour lui (docs/10 § 4).'

  throw new ReputationAuthorizationError({
    blocker,
    agentId: id,
    submitter: settler.toLowerCase() as Address,
    ...(verdict.agentOwner ? { agentOwner: verdict.agentOwner } : {}),
    message:
      `giveFeedback reverterait ("Self-feedback not allowed") : le soumetteur ` +
      `${settler.toLowerCase()} ne peut pas noter l'agentId ${id} car ${detail}` +
      (verdict.agentOwner ? ` (owner actuel : ${verdict.agentOwner})` : '') +
      `. ${remedy}`,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Politique d'écriture (docs/10 § 5)
// ─────────────────────────────────────────────────────────────────────────────

export type WritePolicy = 'immediate' | 'batch' | 'never'

/**
 * Quand écrire.
 *
 *   - `slashed`   → immédiatement. C'est le signal qui a de la valeur.
 *   - `honored`   → par lots. Écrire à chaque règlement doublerait le nombre de
 *                   transactions pour un signal peu informatif pris isolément.
 *   - `reclaimed` → **jamais**. Un mandat expiré n'est la faute de personne ;
 *                   noter négativement une défaillance de notre propre
 *                   infrastructure ferait de Warrant un vecteur de dénigrement.
 */
export function writePolicyFor(verdict: WarrantVerdict): WritePolicy {
  switch (verdict) {
    case 'slashed':
      return 'immediate'
    case 'honored':
      return 'batch'
    case 'reclaimed':
      return 'never'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Écriture
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishVerdictOptions extends BuildFeedbackOptions {
  reputationRegistry: Address
  walletClient: ReputationWalletClient
  publicClient: ReputationPublicClient
  chain?: unknown
  /** Base d'URI du document de verdict. */
  feedbackURIBase?: string
  /** URI explicite, si le document n'est pas servi à l'emplacement par défaut. */
  feedbackURI?: string
  /**
   * `auto` (défaut) applique docs/10 § 5 : immédiat sur `slashed`, différé sur
   * `honored`, jamais sur `reclaimed`. `immediate` force l'écriture d'un
   * `honored` isolé — et ne peut **pas** forcer celle d'un `reclaimed`.
   */
  mode?: 'auto' | 'immediate'
  /**
   * Court-circuite la pré-vérification onchain. À n'utiliser que quand
   * l'autorisation vient d'être vérifiée pour le même couple (agentId, settler).
   */
  skipAuthorizationCheck?: boolean
}

export type PublishSkipReason =
  /** Verdict `reclaimed` : aucune écriture, jamais. */
  | 'reclaimed'
  /** Verdict `honored` : le document est prêt, l'écriture part avec le lot. */
  | 'batched'

export type PublishResult =
  | {
      written: true
      txHash: Hex
      feedbackURI: string
      feedbackHash: Hex
      document: FeedbackDocument
      args: GiveFeedbackArgs
    }
  | {
      written: false
      reason: PublishSkipReason
      /** Absent sur `reclaimed` : il n'y a rien à publier, ni maintenant ni plus tard. */
      document?: SingleFeedbackDocument
      feedbackURI?: string
      feedbackHash?: Hex
    }

/**
 * Inscrit un verdict dans le Reputation Registry.
 *
 * L'ordre est celui-ci, et il compte :
 *   1. politique d'écriture — un `reclaimed` s'arrête ici ;
 *   2. construction du document normalisé et de son `feedbackHash` ;
 *   3. vérification que le Settler peut noter cet agent ;
 *   4. `giveFeedback`, huit arguments, depuis l'adresse du Settler.
 */
export async function publishVerdict(
  verdictDocument: PublishableVerdictDocument,
  opts: PublishVerdictOptions,
): Promise<PublishResult> {
  const policy = writePolicyFor(verdictDocument.verdict)

  // 1. `reclaimed` : rien, quel que soit le mode. Non négociable.
  if (policy === 'never') {
    return { written: false, reason: 'reclaimed' }
  }

  // 2. Le document et son engagement.
  const document = buildFeedbackDocument(verdictDocument, opts)
  const feedbackHash = feedbackHashOf(document)
  const feedbackURI =
    opts.feedbackURI ??
    feedbackUriFor(document.warrant.warrantId, opts.feedbackURIBase)

  if (policy === 'batch' && (opts.mode ?? 'auto') === 'auto') {
    return { written: false, reason: 'batched', document, feedbackURI, feedbackHash }
  }

  // 3. Le Settler peut-il noter cet agent ?
  if (!opts.skipAuthorizationCheck) {
    await assertCanGiveFeedback(opts.agentId, opts.settler, {
      publicClient: opts.publicClient,
      identityRegistry: opts.identityRegistry,
    })
  }

  // 4. L'écriture. Le compte utilisé *est* la preuve d'origine : aucune
  //    signature n'est attachée à un feedback ERC-8004.
  const args = giveFeedbackArgs({
    agentId: opts.agentId,
    verdict: document.tag2,
    feedbackURI,
    feedbackHash,
  })

  const txHash = await opts.walletClient.writeContract({
    address: opts.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args,
    account: opts.settler,
    chain: opts.chain,
  })

  return { written: true, txHash, feedbackURI, feedbackHash, document, args }
}

/** Inscrit un lot de mandats honorés en un seul feedback agrégé. */
export async function publishBatch(
  verdictDocuments: readonly PublishableVerdictDocument[],
  opts: PublishVerdictOptions & {
    proofsByWarrantId?: Readonly<Record<string, ProofOfPayment>>
  },
): Promise<PublishResult> {
  const document = buildBatchFeedbackDocument(verdictDocuments, opts)
  const feedbackHash = feedbackHashOf(document)
  const feedbackURI =
    opts.feedbackURI ?? batchFeedbackUriFor(feedbackHash, opts.feedbackURIBase)

  if (!opts.skipAuthorizationCheck) {
    await assertCanGiveFeedback(opts.agentId, opts.settler, {
      publicClient: opts.publicClient,
      identityRegistry: opts.identityRegistry,
    })
  }

  const args = giveFeedbackArgs({
    agentId: opts.agentId,
    verdict: 'honored',
    feedbackURI,
    feedbackHash,
  })

  const txHash = await opts.walletClient.writeContract({
    address: opts.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args,
    account: opts.settler,
    chain: opts.chain,
  })

  return { written: true, txHash, feedbackURI, feedbackHash, document, args }
}

// ─────────────────────────────────────────────────────────────────────────────
// Le lot
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchPolicy {
  /** Nombre de mandats honorés au-delà duquel le lot part. */
  maxBatchSize: number
  /** Âge du plus ancien mandat en attente au-delà duquel le lot part. */
  maxAgeMs: number
}

/** « toutes les N exécutions ou toutes les 24 h » (docs/10 § 5). */
export const DEFAULT_BATCH_POLICY: BatchPolicy = {
  maxBatchSize: 25,
  maxAgeMs: 24 * 60 * 60 * 1000,
}

interface Pending {
  documents: PublishableVerdictDocument[]
  oldestAt: number
}

/**
 * File d'attente des mandats honorés, par `agentId`.
 *
 * Volontairement en mémoire et sans E/S : le Settler la persiste s'il le
 * souhaite. Ce qu'elle garantit, c'est que rien d'autre qu'un `honored` n'y
 * entre — une saisie s'écrit immédiatement, un `reclaimed` ne s'écrit jamais.
 */
export class VerdictBatcher {
  readonly policy: BatchPolicy
  private readonly clock: () => number
  private readonly queues = new Map<string, Pending>()

  constructor(policy: Partial<BatchPolicy> = {}, clock: () => number = Date.now) {
    this.policy = { ...DEFAULT_BATCH_POLICY, ...policy }
    this.clock = clock
  }

  /** @throws {ReputationError} si le verdict n'est pas `honored`. */
  enqueue(agentId: bigint | number, doc: PublishableVerdictDocument): void {
    if (doc.verdict !== 'honored') {
      throw new ReputationError(
        `seuls les mandats honorés sont mis en lot ; reçu '${doc.verdict}' ` +
          "(une saisie s'écrit immédiatement, une expiration ne s'écrit jamais)",
      )
    }
    const key = BigInt(agentId).toString()
    const q = this.queues.get(key)
    if (q) q.documents.push(doc)
    else this.queues.set(key, { documents: [doc], oldestAt: this.clock() })
  }

  size(agentId: bigint | number): number {
    return this.queues.get(BigInt(agentId).toString())?.documents.length ?? 0
  }

  /** `agentId` dont le lot a atteint la taille ou l'âge de déclenchement. */
  due(): bigint[] {
    const now = this.clock()
    const out: bigint[] = []
    for (const [key, q] of this.queues) {
      if (
        q.documents.length >= this.policy.maxBatchSize ||
        now - q.oldestAt >= this.policy.maxAgeMs
      ) {
        out.push(BigInt(key))
      }
    }
    return out
  }

  /** Vide la file d'un agent et rend les documents en attente. */
  drain(agentId: bigint | number): PublishableVerdictDocument[] {
    const key = BigInt(agentId).toString()
    const q = this.queues.get(key)
    if (!q) return []
    this.queues.delete(key)
    return q.documents
  }

  /** Tous les `agentId` ayant au moins un mandat en attente. */
  agents(): bigint[] {
    return [...this.queues.keys()].map((k) => BigInt(k))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Identité — optionnelle, jamais bloquante
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `IdentityRegistry.register` **frappe le NFT au profit de `msg.sender`** : il
 * n'existe aucune surcharge `registerFor(owner, …)`. Warrant ne peut donc pas
 * enregistrer un agent « pour son compte » depuis sa propre adresse sans en
 * devenir le owner — ce qui interdirait ensuite au Settler de le noter à jamais.
 *
 * Conséquence assumée : Warrant **prépare** la transaction, l'agent l'envoie.
 * C'est ce que rend cette fonction — un `{ to, data }` à signer par l'agent.
 */
export function buildAgentRegistration(opts: {
  identityRegistry?: Address
  agentURI: string
  escrow?: Address
  since?: number
}): { to: Address; data: Hex; value: 0n; note: string } {
  const metadata: { metadataKey: string; metadataValue: Hex }[] = []
  if (opts.escrow) {
    metadata.push({
      metadataKey: METADATA_KEYS.escrow,
      metadataValue: stringToHex(opts.escrow.toLowerCase()),
    })
  }
  if (opts.since !== undefined) {
    metadata.push({
      metadataKey: METADATA_KEYS.since,
      metadataValue: stringToHex(String(opts.since)),
    })
  }

  const to = (opts.identityRegistry ?? ERC8004.mainnet.identity) as Address
  return {
    to,
    data: encodeFunctionData({
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [opts.agentURI, metadata],
    }),
    value: 0n,
    note:
      "cette transaction doit être envoyée par l'agent lui-même : `register` " +
      "frappe le NFT au profit de `msg.sender`, et un agent dont Warrant serait " +
      'owner ne pourrait plus jamais être noté par le Settler (docs/10 § 4)',
  }
}

/**
 * Calldata de mise à jour des métadonnées Warrant.
 *
 * `setMetadata` n'est ouverte qu'au owner et aux operators : ces appels sont
 * eux aussi à envoyer par l'agent, pas par Warrant. Les valeurs sont des
 * chaînes UTF-8 — la spec ne fixe aucun encodage pour `bytes metadataValue`, et
 * une chaîne reste lisible telle quelle dans un explorateur.
 */
export function buildWarrantMetadataCalls(opts: {
  identityRegistry?: Address
  agentId: bigint | number
  escrow: Address
  since: number
}): { to: Address; data: Hex; key: string }[] {
  const to = (opts.identityRegistry ?? ERC8004.mainnet.identity) as Address
  const id = BigInt(opts.agentId)
  const entries: [string, string][] = [
    [METADATA_KEYS.escrow, opts.escrow.toLowerCase()],
    [METADATA_KEYS.since, String(opts.since)],
  ]
  return entries.map(([key, value]) => ({
    to,
    key,
    data: encodeFunctionData({
      abi: identityRegistryAbi,
      functionName: 'setMetadata',
      args: [id, key, stringToHex(value)],
    }),
  }))
}

export type IdentityStatus =
  /** L'agent a un `agentId` utilisable et le Settler peut le noter. */
  | { status: 'usable'; agentId: bigint }
  /** L'agent a un `agentId`, mais le Settler ne peut pas le noter. */
  | { status: 'unnotable'; agentId: bigint; reason: string }
  /** Pas d'identité ERC-8004. Warrant fonctionne quand même. */
  | { status: 'absent'; reason: string }
  /** La chaîne n'a pas répondu. On n'en déduit rien. */
  | { status: 'unavailable'; reason: string }

/**
 * Établit ce qu'on peut faire de l'identité ERC-8004 d'un agent, **sans jamais
 * lever**. Un agent peut utiliser Warrant sans identité ERC-8004 : il n'aura
 * simplement pas de trace de réputation. Aucune de ces situations ne doit
 * empêcher un mandat de s'ouvrir ou de se régler.
 */
export async function inspectAgentIdentity(
  agentId: bigint | number | undefined,
  settler: Address,
  ctx: IdentityContext,
): Promise<IdentityStatus> {
  if (agentId === undefined || agentId === null) {
    return {
      status: 'absent',
      reason: "aucun agentId fourni — l'identité ERC-8004 est optionnelle",
    }
  }
  const id = BigInt(agentId)
  try {
    const verdict = await canGiveFeedback(id, settler, ctx)
    if (verdict.ok) return { status: 'usable', agentId: id }
    if (verdict.blocker === 'agent-not-registered') {
      return { status: 'absent', reason: `agentId ${id} inconnu de l'IdentityRegistry` }
    }
    if (verdict.blocker === 'unknown') {
      return {
        status: 'unavailable',
        reason: `vérification onchain non concluante pour l'agentId ${id}`,
      }
    }
    return {
      status: 'unnotable',
      agentId: id,
      reason:
        `le Settler ${settler.toLowerCase()} est ${verdict.blocker} de l'agentId ` +
        `${id} : aucun verdict ne pourra être inscrit`,
    }
  } catch (e) {
    return { status: 'unavailable', reason: errText(e) }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
