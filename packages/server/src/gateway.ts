/**
 * Gateway 402 — Warrant's front door.
 *
 * Three routes, and the ordering of the paid route's steps is the product:
 *
 *   POST /v1/quote      free, unauthenticated — classify, price, disclose
 *   POST /v1/warrants   paid — dual-rail 402, then warrant + execution
 *   GET  /v1/warrants/:id  warrant, execution and verdict (checks[] included)
 *   GET  /openapi.json  OpenAPI 3.1 with the x-payment-info extension
 *
 * Four principles govern this file. They come from findings, not from
 * preferences:
 *
 * 1. **The agent never declares its own category or notional.** The only input
 *    to pricing is the `ActionSpec` — the calldata that will actually be
 *    executed. A `category` field in the request is read, ignored, and reported
 *    back in the response (docs/13 § 5). This is the foundation of the threat
 *    model: an agent under prompt injection has nothing to lie about.
 *
 * 2. **KeeperHub does not accept raw calldata.** Its API wants `functionName`
 *    and `functionArgs`, the latter being a **JSON string** and not an array,
 *    and resolves the ABI itself (repo/docs/onboarding-teardown.md, 14:12). So
 *    the Gateway encodes the calldata itself with viem in order to commit to it
 *    under `actionHash`, then hands the named form to KeeperHub.
 *    `encodeActionSpec` and `decodeActionSpec` are inverses of one another, and
 *    that is tested: it is the costliest divergence point in the system.
 *
 * 3. **A warrant whose simulation fails is never opened.** Simulation comes
 *    before settlement: the bond is not charged for a foreseeable failure.
 *    Since simulation appears in no audit trail (`simulate: true` creates no
 *    execution row), it is called explicitly and its result kept by us.
 *
 * 4. **Both rails produce an identical warrant.** Same `conditionHash`, same
 *    bond, same shape of `fundingRef`. The rail is only a way of paying: it
 *    changes nothing but the receipt header.
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
import { DEFAULT_MPP_METHOD, openapiDocument, type OpenApiOptions } from './openapi.js'
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
  assertPayloadMatches,
  buildPaymentRequired,
  decodeCredentialHeader,
  decodeHeaderObject,
  encodeHeaderObject,
  encodeReceipt,
  escrowAuthorizationOf,
  formatChallengeHeader,
  fundingRefOfAuthorization,
  paymentPayloadFromCredential,
  problem,
  type AssetTransferMethod,
  type EscrowAuthorization,
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
// ActionSpec ⇄ KeeperHub named call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The call body the KeeperHub API actually accepts.
 *
 * ⚠ `functionArgs` is a **JSON string**, not an array. An array is rejected
 * with a 400 and "functionArgs must be a JSON string when provided". There is
 * no field for pre-encoded calldata: `data`, `callData` and `calldata` are all
 * silently ignored.
 */
export interface KeeperHubCall {
  chainId: number
  contractAddress: Address
  functionName: string
  /** `JSON.stringify` of the arguments, in ABI order. */
  functionArgs: string
  value?: string
}

export interface EncodeActionSpecInput {
  chainId: number
  target: Address
  /** Human-readable ABI signature, e.g. `transfer(address,uint256)`. */
  signature: string
  /** Arguments, accepted as strings — they come from JSON. */
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
 * The `ActionSpec` commits to a registry version that is not the one used to
 * classify it. Refused at opening: the commitment must stay replayable.
 */
export class RegistryMismatchError extends Error {
  override readonly name = 'RegistryMismatchError'
  readonly declared: Hex
  readonly expected: Hex
  constructor(declared: Hex, expected: Hex) {
    super(
      `registryRef committed as ${declared} while classification uses ${expected}: ` +
        'the commitment would not be replayable',
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
      `unreadable signature "${signature}": ${(err as Error).message}`,
    )
  }
  const fn = abi.find((item): item is AbiFunction => item.type === 'function')
  if (!fn) throw new ActionEncodingError(`signature with no function: "${signature}"`)
  return fn
}

/**
 * Resolves the registry entry for the `(chainId, target, selector)` triple.
 *
 * Reuses `entryKey` from `@warrant/core` — the key is the whole triple, never
 * the selector alone — rather than writing a second indexing scheme. Since
 * `lookupEntry` is not exposed by the package barrel, we redo the loop over the
 * same key, which keeps a single definition of "the same action".
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

/** Bare function name, without the list of types. */
export function functionNameOf(signature: string): string {
  const at = signature.indexOf('(')
  return at === -1 ? signature : signature.slice(0, at)
}

/**
 * Coerces an argument coming from JSON into the shape viem expects.
 *
 * Amounts arrive as decimal strings — that is the canonicalisation rule of
 * docs/07 § 4, and a `uint256` does not fit in a `number`. viem, for its part,
 * wants a `bigint`.
 */
function coerceArg(type: string, value: unknown): unknown {
  if (type.endsWith(']')) {
    const inner = type.slice(0, type.lastIndexOf('['))
    const items =
      Array.isArray(value) ? value : (JSON.parse(String(value)) as unknown[])
    if (!Array.isArray(items)) {
      throw new ActionEncodingError(`array expected for type ${type}`)
    }
    return items.map((item) => coerceArg(inner, item))
  }
  if (/^u?int(\d+)?$/.test(type)) {
    if (typeof value === 'bigint') return value
    try {
      return BigInt(String(value))
    } catch {
      throw new ActionEncodingError(`integer expected for ${type}, got ${String(value)}`)
    }
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    throw new ActionEncodingError(`boolean expected, got ${String(value)}`)
  }
  return value
}

/** Stringifies a decoded argument. Exact mirror of `coerceArg`. */
function stringifyArg(value: unknown): string {
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value.startsWith('0x') ? value.toLowerCase() : value
  if (Array.isArray(value)) return JSON.stringify(value.map(stringifyArg))
  throw new ActionEncodingError(`argument not representable: ${typeof value}`)
}

/**
 * Builds the `ActionSpec` — hence the calldata committed under `actionHash` —
 * from a named form.
 *
 * It is the Gateway that encodes, not KeeperHub: the commitment has to bear on
 * bytes, and KeeperHub would only hand the calldata back to us after execution.
 *
 * @throws {ActionEncodingError}
 */
export function encodeActionSpec(input: EncodeActionSpecInput): ActionSpec {
  const fn = abiFunctionOf(input.signature)
  if (fn.inputs.length !== input.args.length) {
    throw new ActionEncodingError(
      `arity: "${input.signature}" expects ${fn.inputs.length} argument(s), ` +
        `${input.args.length} provided`,
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
      `cannot encode "${input.signature}": ${(err as Error).message}`,
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
  /** Arguments as strings, in ABI order. */
  args: string[]
  /** `JSON.stringify(args)` — the shape KeeperHub demands. */
  functionArgs: string
}

export interface DecodeActionSpecOptions {
  registry: ClassificationRegistry
  /**
   * Signature to use when the `(chainId, target, selector)` triple is not in
   * the registry.
   *
   * This is **not** a declaration that we trust: the selector it produces must
   * equal the calldata's, and re-encoding the decoded arguments must reproduce
   * the calldata byte for byte. A lying signature therefore cannot change what
   * will be executed — it can only name what is already committed under
   * `actionHash`.
   */
  signature?: string
}

/**
 * Inverse of `encodeActionSpec`: from the committed calldata to the named form
 * KeeperHub accepts.
 *
 * @throws {ActionEncodingError}
 */
export function decodeActionSpec(
  actionSpec: ActionSpec,
  opts: DecodeActionSpecOptions,
): DecodedAction {
  const calldata = actionSpec.calldata
  if (calldata.length < 10) {
    throw new ActionEncodingError('calldata with no selector: nothing to name')
  }
  const selector = calldata.slice(0, 10).toLowerCase()

  const entry = lookupSignature(opts.registry, actionSpec.chainId, actionSpec.target, selector)
  const signature = entry?.signature ?? opts.signature
  if (!signature) {
    throw new ActionEncodingError(
      `triple (chainId ${actionSpec.chainId}, ${actionSpec.target}, ${selector}) ` +
        'absent from the registry and no signature provided: the KeeperHub API ' +
        'demands functionName/functionArgs, raw calldata is not enough for it',
    )
  }

  const expected = toFunctionSelector(`function ${signature}`)
  if (expected.toLowerCase() !== selector) {
    throw new ActionEncodingError(
      `signature "${signature}" (${expected}) inconsistent with the calldata's selector ${selector}`,
    )
  }

  const fn = abiFunctionOf(signature)
  let decoded: readonly unknown[]
  try {
    const result = decodeFunctionData({ abi: [fn] as Abi, data: calldata })
    decoded = (result.args ?? []) as readonly unknown[]
  } catch (err) {
    throw new ActionEncodingError(
      `cannot decode "${signature}": ${(err as Error).message}`,
    )
  }

  const args = decoded.map(stringifyArg)

  // Verified round trip: what KeeperHub will execute must be exactly what is
  // committed under `actionHash`. Without this control, non-canonical calldata
  // — padding, surplus arguments — would be executed in a form other than the
  // one we hashed.
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
      `re-encoding "${signature}" does not reproduce the committed calldata: ` +
        'the named form handed to KeeperHub would diverge from actionHash',
    )
  }

  return {
    signature,
    functionName: functionNameOf(signature),
    args,
    functionArgs: JSON.stringify(args),
  }
}

/** `ActionSpec` → KeeperHub call body. */
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

export interface WarrantTerms {
  id: Hex
  beneficiary: Address
  bond: string
  conditionHash: Hex
  actionHash: Hex
  duration: number
}

/**
 * `termsHash = keccak256(abi.encode(id, beneficiary, bond, conditionHash,
 * actionHash, duration))` — exact mirror of `WarrantEscrow.termsHash`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why the EIP-3009 nonce can no longer be random
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An EIP-3009 authorization signs six fields and no more: `from`, `to`,
 * `value`, `validAfter`, `validBefore`, `nonce`. Nothing that says *for which
 * warrant*. An `opener` receiving an authorization meant for one warrant could
 * therefore open it on terms of its own choosing — another beneficiary, another
 * post-condition, `duration` raised to MAX_DURATION — and the agent had indeed
 * signed the payment, but not those terms.
 *
 * The contract closes that by constraining `nonce` to equal the hash of the
 * terms. Since the `nonce` *is* inside the signed digest, signing the
 * authorization amounts to signing the terms: one signature, complete binding.
 * And the uniqueness the token requires of the nonce is preserved, because `id`
 * — which contains a warrant nonce, itself random — enters the hash.
 *
 * The consequence on the protocol, and it is the one that costs: the client
 * must know **every** term before signing. `id`, `beneficiary`, `bond`,
 * `conditionHash`, `actionHash` and `duration` are therefore all announced in
 * the 402 (`warrant/commitment` extension), and the warrant nonce that
 * determines `id` must make the round trip — see `resolveNonce`.
 */
export function termsHashOf(terms: WarrantTerms): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
      ],
      [
        terms.id,
        terms.beneficiary,
        BigInt(terms.bond),
        terms.conditionHash,
        terms.actionHash,
        BigInt(terms.duration),
      ],
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
 * What the Gateway expects of KeeperHub.
 *
 * Deliberately narrower than `KeeperHubClient`: that one exposes a
 * `ContractCallRequest` carrying raw calldata, a shape the real API does not
 * accept (see this file's header). The port imposes the named form, and
 * `keeperHubExecutor()` gives an HTTP implementation of it.
 */
export interface ExecutorPort {
  simulateContractCall(call: KeeperHubCall): Promise<SimulationOutcome>
  executeContractCall(
    call: KeeperHubCall,
    idempotencyKey?: string,
  ): Promise<ExecutionOutcome>
}

/**
 * `open()` arguments, in ABI order.
 *
 * Two fields have **disappeared** compared with the old signature, and their
 * absence is the fix itself:
 *
 * - `agent`: it equals `authorization.from`, proven by the EIP-3009 signature
 *   the token verifies. Keeping it twice invited declaring it, and `agent` is
 *   the recipient of two of the contract's three outputs — an opener that picks
 *   it freely can award itself any free balance.
 * - `fundingRef`: it equals `authorization.nonce`, written by the contract.
 *   Passing it would be letting the opener describe a funding it never made.
 *
 * Both remain readable from `authorization` whenever a caller needs them — and
 * that is the only place where they exist, hence the only place where they can
 * be right.
 */
export interface OpenWarrantArgs {
  id: Hex
  beneficiary: Address
  bond: string
  conditionHash: Hex
  actionHash: Hex
  /** The contract takes a duration and computes `expiry` itself. */
  duration: number
  /**
   * The EIP-3009 authorization signed by the agent. `open()` presents it to the
   * token, which transfers `value` to the escrow — that is the funding of the
   * bond, and it is atomic with the opening.
   */
  authorization: EscrowAuthorization
}

/** The Gateway is the `opener`: it can do nothing but open (invariant I10). */
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

/**
 * How the bond was paid.
 *
 * `direct` is not a payment rail, and that is the point of naming it. The
 * operations tool `bin/open-warrant.ts` signs the EIP-3009 authorization with a
 * local key and calls `open()` itself: no 402, no Challenge, no facilitator
 * settlement. It used to write `x402` into the ledger because the field admitted
 * nothing else — so every warrant opened by the runner claimed a rail it had
 * never traversed, on a route whose whole argument is that the two rails produce
 * an identical warrant. A reader counting rails was reading a number we made up.
 *
 * The authorization itself is identical whichever value appears here; what
 * `direct` says is that nobody was charged over HTTP.
 */
export type Rail = 'x402' | 'mpp' | 'direct'

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
  /** Rail taken. Logged, never returned in the warrant body. */
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
  /** Public base of the service, for `resource.url` and `instance`. */
  baseUrl: string
  /** MPP `realm` — an identifier, not a hostname. Default `warrant`. */
  realm: string
  /** Settlement network of the bond, in **CAIP-2**. */
  network: string
  /** Bond token contract — native Base USDC. */
  asset: Address
  /** Warrant vault: the `exact` scheme carries no calldata (docs/04). */
  payTo: Address
  /** The token's real EIP-712 domain. To be read onchain rather than believed. */
  assetExtra: {
    name: string
    version: string
    assetTransferMethod?: AssetTransferMethod
    primaryType?: string
  }
  facilitator: Facilitator
  executor: ExecutorPort
  escrow: EscrowPort
  /** `MPP_SECRET_KEY`. Never logged. */
  mppSecret: string
  mppMethod?: string
  /** Currency announced in the MPP Challenge. Defaults to the asset address. */
  mppCurrency?: string
  maxTimeoutSeconds?: number
  challengeTtlSeconds?: number
  store?: WarrantStore
  verdicts?: VerdictSource
  openapi?: Partial<OpenApiOptions>
  now?: () => number
  /** Injectable salt, to make Challenges deterministic under test. */
  challengeSalt?: () => string
  randomNonce?: () => bigint
  /**
   * Open the warrant — hence charge the bond — **before** simulating.
   *
   * This flag was called `settleBeforeSimulate` back when settlement was a
   * separate step. It no longer is: `open()` charges, so there is only one
   * ordering left to choose, that of the opening and the simulation.
   *
   * False by default, and that default is a choice: simulation comes before the
   * charge so that a foreseeable failure costs the agent nothing (docs/08 § 4).
   * Setting this flag to true restores the literal order of the docs/04
   * sequence, at the price of a bond charged for nothing.
   */
  openBeforeSimulate?: boolean
  /**
   * Submit the authorization to the facilitator's `POST /verify` before opening.
   *
   * **False by default, and this is the delicate point of this migration.** The
   * x402 `exact` scheme signs `TransferWithAuthorization`; the escrow consumes
   * `ReceiveWithAuthorization` (see `RECEIVE_WITH_AUTHORIZATION_TYPE`). A
   * facilitator conformant to the scheme therefore recomputes the wrong EIP-712
   * digest, does not find `authorization.from` in it, and answers
   * `isValid: false` on a perfectly valid authorization. Turning this check on
   * by default would refuse every payment.
   *
   * That nothing is lost by disabling it comes down to the check having become
   * redundant: the token verifies the same signature, authoritatively, inside
   * the `open` transaction. A false signature opens nothing and moves nothing —
   * it costs the opener the gas of a reverted transaction, and never again a
   * bond to the agent. That is precisely what atomicity bought.
   *
   * To be set back to true the day the facilitator announces it knows how to
   * verify the `receive` typehash.
   */
  verifyWithFacilitator?: boolean
}

/** Server-side context attached to an MPP Challenge. Never sent to the client. */
interface ChallengeContext {
  requirements: PaymentRequirements
  conditionHash: Hex
  actionHash: Hex
  bond: string
}

// ─────────────────────────────────────────────────────────────────────────────
// The server
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
  const mppMethod = cfg.mppMethod ?? DEFAULT_MPP_METHOD
  const mppCurrency = cfg.mppCurrency ?? cfg.asset
  const resourceUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/warrants`

  const app = new Hono()

  // ── POST /v1/quote — free, unauthenticated ───────────────────────────────
  //
  // The frictionless front door: an agent can know the price and the exact
  // commitment before opening its wallet. It is also what makes the pricing
  // auditable — the quote is reproducible by a third party.
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
       * Explicit reminder of the threat model: if the caller declared a
       * category, it served no purpose. Saying so is more useful than refusing
       * the request — an honest agent corrects itself, a hostile one learns
       * that the field gives it no grip.
       */
      ...(body['category'] !== undefined
        ? {
            ignoredFields: {
              category: body['category'],
              note:
                'the category is derived from the calldata, never declared — ' +
                'the field we received was ignored (docs/13 § 5)',
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

  // ── POST /v1/warrants — paid, dual-rail ──────────────────────────────────
  app.post('/v1/warrants', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return sendProblem(c, badJson())
    }

    // 1-4. Classify, build the post-condition from the policy, inject
    //      `calldata_matches_commitment`, compute the commitments.
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

    // 5. No payment → 402 with **both** challenges, simultaneously.
    if (!rail) {
      return challengeResponse(c, priced, requirements)
    }

    // 6. Payment resolution, whichever the rail: the facilitator sees the same
    //    `PaymentPayload` in both cases.
    let resolved: ResolvedPayment
    try {
      resolved =
        rail === 'x402'
          ? resolveX402(x402Header as string, requirements, resourceUrl)
          : resolveMpp(authHeader as string, requirements, resourceUrl, challenges)
    } catch (err) {
      if (err instanceof MppError && err.code === 'challenge_replayed') {
        // A Credential is good for exactly one request. We do not reissue a
        // Challenge: the client must start over from a fresh request, without
        // which "replay refused" would become "replay retryable".
        return sendProblem(
          c,
          problem(
            'challenge_replayed',
            409,
            'Credential already used',
            err.message,
            { rail },
          ),
        )
      }
      return paymentErrorResponse(c, priced, requirements, rail, err)
    }

    // 7. `verify` — no funds move, and the call is **optional**: see
    //    `verifyWithFacilitator`. The token redoes this check
    //    authoritatively inside `open()`, on the right typehash.
    if (cfg.verifyWithFacilitator) {
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
              verification.invalidReason ?? 'the facilitator refuses the payment',
            ),
          )
        }
      } catch (err) {
        return sendProblem(
          c,
          problem(
            'facilitator_unavailable',
            502,
            'Facilitator unavailable',
            errText(err),
            { rail },
          ),
        )
      }
    }

    // 7 bis. The authorization in the contract's own shape, and the two values
    //        the contract will derive from it. We compute them **before**
    //        opening so that `warrantId` and the logs agree with the chain.
    //
    //        `agent` is `auth.from` and nothing else. We no longer consult
    //        `settlement.payer` nor `verified.payer`: the contract will record
    //        `auth.from`, and holding on here to an address that a third party
    //        reported to us would produce a log naming an agent other than the
    //        chain's — hence a `warrantId` the Settler would not find.
    let authorization: EscrowAuthorization
    let fundingRef: Hex
    try {
      authorization = escrowAuthorizationOf(resolved.payload.payload)
      fundingRef = fundingRefOfAuthorization(resolved.payload.payload.authorization)
    } catch (err) {
      return paymentErrorResponse(c, priced, requirements, rail, err)
    }
    const agent = authorization.from
    // The recomputed bond must equal the signed amount **exactly**, otherwise
    // `open()` reverts with `ValueMismatch()`. `assertPayloadMatches` has
    // already checked it against `requirements.amount`; we say it again against
    // the `bond` we are actually going to pass, because that is the pair the
    // contract compares and a divergence between the two would be a bug on our
    // side.
    if (authorization.value !== BigInt(priced.quote.bond)) {
      return paymentErrorResponse(
        c,
        priced,
        requirements,
        rail,
        new PaymentRejected(
          'amount_mismatch',
          `authorization for ${authorization.value} against a bond of ${priced.quote.bond}: ` +
            'open() demands strict equality (ValueMismatch)',
        ),
      )
    }

    // The beneficiary is refused by the contract if it is the agent itself
    // (`BadBeneficiary`) — a slash would reimburse the culprit. The policy is
    // static and the agent is not, so the case can only be detected here, once
    // the agent is known. Saying it in a 4xx is worth more than a revert in a
    // 502: this is not an outage, it is an agent that cannot be its own
    // beneficiary.
    if (cfg.policy.beneficiary.toLowerCase() === agent) {
      return sendProblem(
        c,
        problem(
          'bad_beneficiary',
          422,
          'Degenerate beneficiary',
          `agent ${agent} is also the policy's beneficiary: a slash would ` +
            'reimburse it, which the contract refuses (BadBeneficiary)',
          { rail },
        ),
      )
    }

    // Named form demanded by KeeperHub, derived from the committed calldata.
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

    // The warrant nonce must be **the one announced in the 402**. If it is
    // missing we cannot guess it: we would draw another one, hence another
    // `id`, hence another `termsHash` than the one signed, and `open()` would
    // revert with `TermsMismatch()`. A named refusal beats an onchain revert.
    if (body['nonce'] === undefined) {
      return sendProblem(
        c,
        problem(
          'missing_nonce',
          400,
          'Missing warrant nonce',
          'the `nonce` field of the 402 (warrant/commitment extension) must be ' +
            'sent back with the payment: it determines the warrant identifier, ' +
            'which enters the termsHash that the EIP-3009 authorization must ' +
            'carry as its nonce',
          { rail },
        ),
      )
    }
    const nonce = resolveNonce(body['nonce'], randomNonce)
    const id = warrantIdOf(agent, nonce, priced.actionHash)
    const openedAt = now()
    const duration = cfg.policy.duration

    // The committed terms, and the signature ↔ terms binding.
    //
    // The contract redoes this check, and it is the one that is authoritative.
    // We do it here too for the same reason as elsewhere in this file: an
    // onchain revert does not say *which* term diverged, whereas at this point
    // we know all six and can hand them back to the client, who then only has
    // to re-sign.
    const expectedNonce = termsHashOf({
      id,
      beneficiary: cfg.policy.beneficiary,
      bond: priced.quote.bond,
      conditionHash: priced.conditionHash,
      actionHash: priced.actionHash,
      duration,
    })
    if (authorization.nonce !== expectedNonce) {
      return paymentErrorResponse(
        c,
        priced,
        requirements,
        rail,
        new PaymentRejected(
          'terms_mismatch',
          `the authorization's nonce (${authorization.nonce}) does not equal the termsHash ` +
            `of the terms served (${expectedNonce}). The EIP-3009 authorization must carry ` +
            'this hash as its nonce — that is what binds the signature to the terms of the ' +
            'warrant, which the six fields signed by EIP-3009 are not enough to cover. ' +
            `Terms: id=${id}, beneficiary=${cfg.policy.beneficiary}, ` +
            `bond=${priced.quote.bond}, conditionHash=${priced.conditionHash}, ` +
            `actionHash=${priced.actionHash}, duration=${duration}`,
        ),
      )
    }

    let openTx: Hex | undefined
    let simulation: SimulationOutcome | undefined

    /**
     * The opening, which **is** the settlement.
     *
     * A single transaction where there used to be two. This is not an
     * optimisation: between the old `settle` and the old `open`, the funds sat
     * on the contract with no warrant tying them to anyone, and the `opener`
     * alone decided who would get them. That is the flaw the fix closes, and it
     * can only be closed here — by handing the authorization to the contract
     * instead of having it settled on the side.
     *
     * The consequence on failure modes, and it goes the right way: an `open`
     * that reverts leaves **nothing** behind. No more orphan settlement to
     * refund by hand, hence no more need to distinguish "the bond is taken but
     * the warrant does not exist" from "nothing happened".
     */
    const doOpen = async (): Promise<ProblemDetails | undefined> => {
      try {
        openTx = await cfg.escrow.open({
          id,
          beneficiary: cfg.policy.beneficiary,
          bond: priced.quote.bond,
          conditionHash: priced.conditionHash,
          actionHash: priced.actionHash,
          duration,
          authorization,
        })
        return undefined
      } catch (err) {
        return problem('open_failed', 502, 'Warrant opening failed', errText(err), {
          rail,
          fundingRef,
          // True by construction ever since the funding became atomic: if the
          // opening failed, the EIP-3009 transfer failed with it and the nonce
          // is not consumed. The agent can re-sign, or retry.
          bondCharged: false,
        })
      }
    }

    const doSimulate = async (): Promise<ProblemDetails | undefined> => {
      try {
        const result = await cfg.executor.simulateContractCall(call)
        simulation = result
        if (!result.success || result.wouldRevert === true) {
          // A warrant whose simulation fails is never opened.
          return problem(
            'simulation_failed',
            422,
            'Simulation failed',
            result.revertReason ??
              'the action would revert on execution: no warrant opened, no bond charged',
            { rail, warrantOpened: false },
          )
        }
        return undefined
      } catch (err) {
        return problem(
          'executor_unavailable',
          502,
          'Executor unavailable',
          errText(err),
          { rail, warrantOpened: false },
        )
      }
    }

    // 8. Simulation **before** opening: the bond is not charged for a
    //    foreseeable failure. `openBeforeSimulate` restores the literal order
    //    of docs/04 for whoever prefers it.
    const steps = cfg.openBeforeSimulate ? [doOpen, doSimulate] : [doSimulate, doOpen]
    for (const step of steps) {
      const failure = await step()
      if (failure) return sendProblem(c, failure)
    }
    if (!openTx || !simulation) {
      return sendProblem(c, problem('internal', 500, 'Incomplete opening'))
    }

    // 9. The settlement receipt, **synthesised from the opening**.
    //
    //    Both protocols expect a transaction reference: x402 in
    //    `PAYMENT-RESPONSE`, MPP in `Payment-Receipt`. That reference used to be
    //    the hash returned by the facilitator; it is now the hash of the `open`,
    //    because that is the transaction that actually moved the USDC. So the
    //    receipt designates a settlement the client can go and read, and which
    //    also contains the opening of the warrant it paid for — strictly more
    //    information than before, not less.
    //
    //    `fundingRef`, for its part, is no longer that hash: it is the EIP-3009
    //    nonce, the value the contract writes. The two are no longer conflated.
    const settlement: SettlementResponse = {
      success: true,
      transaction: openTx,
      network: cfg.network,
      payer: agent,
      amount: priced.quote.bond,
    }

    // 10. Execution. `idempotencyKey` = the warrant identifier: a network retry
    //     cannot broadcast two transactions for one and the same warrant.
    let execution: ExecutionOutcome
    try {
      execution = await cfg.executor.executeContractCall(call, id)
    } catch (err) {
      return sendProblem(
        c,
        problem('execution_failed', 502, 'Execution failed', errText(err), {
          rail,
          warrantId: id,
          fundingRef,
          note:
            'the warrant is open and will expire towards reclaim: an infrastructure ' +
            'failure is not a violated post-condition',
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

    // 12. Receipt for the rail that was taken — and for it alone.
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

  // ── GET /v1/warrants ──────────────────────────────────────────────────────
  //
  // History and statistics. The counters serve the public dashboard directly:
  // the hackathon's heaviest scoring criterion asks for real transactions, and
  // giving a live count of them costs little.
  app.get('/v1/warrants', async (c) => {
    if (!store.list) {
      return sendProblem(
        c,
        problem(
          'not_supported',
          501,
          'This store cannot enumerate warrants',
          'store.list missing',
        ),
      )
    }

    const q = c.req.query()
    const agent = q['agent']?.toLowerCase()
    if (agent && !/^0x[0-9a-fA-F]{40}$/.test(agent)) {
      return sendProblem(
        c,
        problem('bad_agent', 400, 'Invalid agent address', q['agent'] ?? ''),
      )
    }

    const limit = Math.min(Math.max(Number(q['limit'] ?? 100) || 100, 1), 500)
    const since = q['since'] ? Number(q['since']) : undefined
    const until = q['until'] ? Number(q['until']) : undefined

    let records = store.list()
    if (agent) records = records.filter((r) => r.agent.toLowerCase() === agent)
    if (q['status']) {
      const wanted = String(q['status']).toLowerCase()
      records = records.filter(
        (r) => WarrantStatus[r.status].toLowerCase() === wanted,
      )
    }
    if (q['category']) {
      records = records.filter((r) => r.quote.category === q['category'])
    }
    if (since !== undefined) records = records.filter((r) => r.openedAt >= since)
    if (until !== undefined) records = records.filter((r) => r.openedAt <= until)

    // Most recent first: that is what one wants to see on a dashboard.
    records.sort((a, b) => b.openedAt - a.openedAt)

    const cursor = q['cursor']
    const start = cursor
      ? records.findIndex((r) => r.id.toLowerCase() === cursor.toLowerCase()) + 1
      : 0
    const page = records.slice(start, start + limit)
    const next = records[start + limit]

    // The statistics bear on the whole filtered set, not on the page: a counter
    // that changes with pagination is not a counter.
    const sumOf = (pred: (r: WarrantRecord) => boolean): string =>
      records
        .filter(pred)
        .reduce((acc, r) => acc + BigInt(r.bond), 0n)
        .toString()

    const honored = records.filter((r) => r.status === WarrantStatus.Honored)
    const slashed = records.filter((r) => r.status === WarrantStatus.Slashed)

    return c.json({
      warrants: page.map((r) => ({
        id: r.id,
        agent: r.agent,
        beneficiary: r.beneficiary,
        bond: r.bond,
        category: r.quote.category,
        conditionHash: r.conditionHash,
        actionHash: r.actionHash,
        fundingRef: r.fundingRef,
        expiry: r.expiry,
        openedAt: r.openedAt,
        status: WarrantStatus[r.status],
        rail: r.rail,
        executionId: r.executionId,
      })),
      stats: {
        total: records.length,
        open: records.filter((r) => r.status === WarrantStatus.Open).length,
        honored: honored.length,
        slashed: slashed.length,
        reclaimed: records.filter((r) => r.status === WarrantStatus.Reclaimed)
          .length,
        bondHonoredTotal: sumOf((r) => r.status === WarrantStatus.Honored),
        bondSlashedTotal: sumOf((r) => r.status === WarrantStatus.Slashed),
        totalAtRisk: sumOf(
          (r) =>
            r.status === WarrantStatus.Honored ||
            r.status === WarrantStatus.Slashed,
        ),
      },
      ...(next ? { nextCursor: page[page.length - 1]?.id } : {}),
    })
  })

  // ── GET /v1/warrants/:id ──────────────────────────────────────────────────
  app.get('/v1/warrants/:id', async (c) => {
    const raw = c.req.param('id')
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
      return sendProblem(
        c,
        problem('bad_warrant_id', 400, 'Invalid warrant identifier', raw),
      )
    }
    const record = await store.get(raw.toLowerCase() as Hex)
    if (!record) {
      return sendProblem(c, problem('not_found', 404, 'Unknown warrant', raw))
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
      // A verdict without `checks[]` is an assertion; with it, it is a
      // replayable proof (docs/04 "Data model").
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

  // ── configuration-bound helpers ───────────────────────────────────────────

  /**
   * Emits a 402 carrying **both** challenges.
   *
   * `opts.problem` fills the body in RFC 9457 (MPP path); `opts.error` fills the
   * `error` field of the `PaymentRequired` (x402's proprietary format). With
   * neither one nor the other, the body is `{}` — all the information being in
   * the headers.
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

    /**
     * The terms the client must know **before** signing.
     *
     * Ever since the EIP-3009 nonce equals `termsHash(...)`, the agent can no
     * longer sign a payment and then discover the terms: it signs the terms *by*
     * signing the payment. So the 402 must publish them all, and the warrant
     * `nonce` along with them — it is what determines `id`, and it must come
     * back unchanged in `body.nonce`.
     *
     * `id` is not announced, and cannot be: it equals
     * `keccak256(agent, nonce, actionHash)` and we do not know the agent yet. It
     * is up to the client to compute it — it alone knows which address will
     * sign.
     */
    const warrantNonce = randomNonce()
    const terms = {
      nonce: `0x${warrantNonce.toString(16).padStart(64, '0')}`,
      beneficiary: cfg.policy.beneficiary,
      bond: priced.quote.bond,
      conditionHash: priced.conditionHash,
      actionHash: priced.actionHash,
      duration: cfg.policy.duration,
      escrow: cfg.payTo,
      warrantId: 'keccak256(abi.encode(agent, nonce, actionHash))',
      authorizationNonce:
        'keccak256(abi.encode(warrantId, beneficiary, bond, conditionHash, actionHash, duration))',
      note:
        "the EIP-3009 authorization's nonce must equal authorizationNonce, and " +
        'the signed type is ReceiveWithAuthorization — not TransferWithAuthorization. ' +
        'Send `nonce` back in the body of the paid request.',
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
        // The terms travel in `opaque` too, which the Challenge's MAC covers:
        // on the MPP rail, a client that alters them does not recompute the same
        // `challenge.id` and gets refused at consumption.
        nonce: terms.nonce,
        beneficiary: terms.beneficiary,
        duration: terms.duration,
      },
      description: `Bond for ${priced.quote.category}`,
      context: {
        requirements,
        conditionHash: priced.conditionHash,
        actionHash: priced.actionHash,
        bond: priced.quote.bond,
      },
    })

    // Both challenges, simultaneously, on the same route.
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
                category: priced.quote.category,
                // Every term — `conditionHash` and `actionHash` included,
                // because the agent now signs them by signing its payment: the
                // EIP-3009 nonce equals their hash.
                ...terms,
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
    // Body `{}`: all the information is in the headers (docs/05 § 1.2).
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

    // MPP rail → RFC 9457. x402 rail → x402's proprietary format, that is, a new
    // 402 whose `PaymentRequired` carries the explanation (docs/05 § 2.7).
    return rail === 'mpp'
      ? challengeResponse(c, priced, requirements, {
          problem: problem(code, 402, 'Payment refused', detail, { rail }),
        })
      : challengeResponse(c, priced, requirements, { error: `${code}: ${detail}` })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — the only input is the ActionSpec
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
 * Classify → policy → price, in that order and with no input other than the
 * `ActionSpec`.
 *
 * `body.category`, `body.notionalUSD` and every other declarative field are
 * ignored: they are not even read here. Two requests that differ only by those
 * fields produce the same `conditionHash` and the same bond — which is exactly
 * what the reproducibility test verifies.
 */
export function priceAction(body: Record<string, unknown>, cfg: GatewayConfig): PricedAction {
  const actionSpec = validateActionSpec(body['actionSpec'])
  const classification = classify(actionSpec, cfg.registry)

  // The declared `registryRef` is committed under `actionHash`: were it to
  // designate a registry version other than the one used to classify, a third
  // party replaying `classify` with the wrong registry could observe a different
  // category without either side having lied. The refusal carries the expected
  // value so that the correction takes a single round trip.
  if (actionSpec.registryRef.toLowerCase() !== classification.registryRef.toLowerCase()) {
    throw new RegistryMismatchError(actionSpec.registryRef, classification.registryRef)
  }

  const actionHash = hashAction(actionSpec)

  // `priceRisk` delegates to `buildConditionSpec`, which injects
  // `calldata_matches_commitment` as a matter of course as soon as an
  // `actionHash` is supplied. A single construction path, hence no spec
  // produced without the commitment.
  const quote = priceRisk(classification, cfg.policy, {
    chainId: actionSpec.chainId,
    actionHash,
  })
  // Belt and braces: refuse to serve a spec without the commitment checker,
  // whatever the cause.
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
// Payment resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The payment, resolved from one rail or the other.
 *
 * No longer carries a `payer`. That was the address the rail *declared* — an
 * MPP Credential's `source`, an authorization's `from` — and the Gateway
 * cross-checked it against the facilitator's to derive the agent. Since the
 * contract now derives the agent from the signature, the only address that
 * counts is `authorization.from`, and it is read where it is proven. Keeping a
 * second source would have suggested that it carried weight.
 */
interface ResolvedPayment {
  payload: PaymentPayload
  challengeId?: string
}

function resolveX402(
  header: string,
  requirements: PaymentRequirements,
  resourceUrl: string,
): ResolvedPayment {
  const payload = decodeHeaderObject<PaymentPayload>(header)
  assertPayloadMatches(payload, requirements)
  return { payload: { ...payload, resource: payload.resource ?? { url: resourceUrl } } }
}

function resolveMpp(
  header: string,
  requirements: PaymentRequirements,
  resourceUrl: string,
  challenges: ChallengeStore<ChallengeContext>,
): ResolvedPayment {
  const credential: MppCredential = decodeCredentialHeader(header)
  // Strict consumption: Challenge known, unexpired, echoed back verbatim, never
  // replayed. Any anomaly raises an `MppError`.
  const entry = challenges.consume(credential)

  // The committed amount is the one from the Challenge that was issued, not the
  // one the Credential copies: the Challenge is cryptographically bound to its
  // `id`.
  if (entry.context.bond !== requirements.amount) {
    throw new PaymentRejected(
      'amount_mismatch',
      `Challenge issued for ${entry.context.bond}, bond recomputed to ${requirements.amount}`,
    )
  }

  const payload = paymentPayloadFromCredential(credential, requirements, resourceUrl)
  assertPayloadMatches(payload, requirements)
  return { payload, challengeId: entry.challenge.id }
}

/**
 * The warrant's `nonce` — the one that enters `warrantId`, not the EIP-3009 one.
 *
 * ⚠ It can **no longer** be taken from the authorization's nonce, as it once
 * was. That nonce now equals `termsHash(id, …)`, and `id` equals
 * `keccak256(agent, nonce, actionHash)`: taking one to compute the other would
 * be circular. The two nonces are now two distinct things — one identifies the
 * warrant, the other binds the authorization to its terms.
 *
 * Hence the round trip: the Gateway draws this nonce when it issues the 402,
 * announces it in the `warrant/commitment` extension, and the client sends it
 * back in `body.nonce` with its payment. Without it the server would draw
 * another one, compute another `id`, hence another `termsHash`, and the
 * contract would revert with `TermsMismatch()` — which is why it is required as
 * soon as a payment is present, rather than silently replaced.
 */
function resolveNonce(declared: unknown, fallback: () => bigint): bigint {
  if (typeof declared === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(declared)) {
    return BigInt(declared)
  }
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0) {
    return BigInt(declared)
  }
  return fallback()
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

function badJson(): ProblemDetails {
  return problem('malformed_request', 400, 'Unreadable request body', 'JSON expected')
}

function problemFor(err: unknown): ProblemDetails {
  if (err instanceof ClassificationError) {
    return problem(
      'classification_refused',
      422,
      'Unclassifiable action',
      err.message,
      { code: err.code },
    )
  }
  if (err instanceof DslError) {
    return problem('invalid_spec', 400, 'Invalid specification', err.message, {
      issues: (err as unknown as { issues?: unknown }).issues ?? [],
    })
  }
  if (err instanceof PolicyError) {
    return problem('policy_gap', 422, 'Incomplete policy', err.message)
  }
  if (err instanceof RiskError) {
    return problem('policy_gap', 422, 'Inconsistent policy', err.message)
  }
  if (err instanceof RegistryMismatchError) {
    return problem(
      'registry_mismatch',
      422,
      'Incompatible registry version',
      err.message,
      { declared: err.declared, expected: err.expected },
    )
  }
  if (err instanceof ActionEncodingError) {
    return problem('unencodable_action', 422, 'Unexecutable action', err.message)
  }
  if (err instanceof FacilitatorError) {
    return problem('facilitator_unavailable', 502, 'Facilitator unavailable', err.message)
  }
  return problem('internal', 500, 'Internal error', errText(err))
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
// Default port implementations
// ─────────────────────────────────────────────────────────────────────────────

export interface KeeperHubExecutorConfig {
  /** `kh_` organisation key. A `wfb_` key is rejected with a 401 everywhere. */
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * KeeperHub HTTP executor, in the shape the API actually accepts.
 *
 * Does not reuse `KeeperHubClient.executeContractCall`: its
 * `ContractCallRequest` sends a `data` field carrying the calldata, a shape no
 * KeeperHub route accepts — `data`, `callData` and `calldata` are ignored, and
 * only `functionName` + `functionArgs` are read
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

  async function status(executionId: string): Promise<Record<string, unknown>> {
    const res = await fetchImpl(
      `${baseUrl}/api/execute/${encodeURIComponent(executionId)}/status`,
      { headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'application/json' } },
    )
    if (!res.ok) return {}
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return (json['data'] as Record<string, unknown>) ?? json
  }

  function hashOf(data: Record<string, unknown>): Hex | undefined {
    const top = data['transactionHash']
    if (typeof top === 'string' && top.length > 0) return top as Hex
    const nested = (data['result'] as Record<string, unknown> | undefined)?.[
      'transactionHash'
    ]
    return typeof nested === 'string' && nested.length > 0 ? (nested as Hex) : undefined
  }

  return {
    async simulateContractCall(call) {
      // `simulate` must be a strict boolean: the API rejects `"true"` with a
      // 400, precisely so that a coercion cannot become a real broadcast.
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
      const executionId = String(data['executionId'] ?? data['id'] ?? '')

      // ⚠ The POST response does **not** carry the hash: a `202` with
      // `{ executionId, status: "completed" }`, and nothing else. The hash is
      // served only by the status route, where it is available immediately.
      // Without this second call, `txHash` is always undefined and the verdict
      // loses the only link tying a warrant to a transaction — measured on
      // Sepolia, not inferred.
      let txHash = hashOf(data)
      let fresh: Record<string, unknown> = {}
      if (!txHash && executionId) {
        fresh = await status(executionId)
        txHash = hashOf(fresh)
      }

      return {
        executionId,
        status: String(fresh['status'] ?? data['status'] ?? 'unknown'),
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
    // JSON string, not an array. An array is rejected with a 400.
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

/**
 * `EscrowPort` backed by a viem `WalletClient` holding the `opener` key.
 *
 * Kept even though the real deployment opens through KeeperHub: the day the
 * `opener` becomes a local key again — KeeperHub organisation unavailable, or a
 * deployment where we want no third-party dependency in order to write — this
 * port takes over, with nothing else to change. Both implementations satisfy
 * the same interface because the contract exposes only one way of opening.
 */
export function viemEscrow(cfg: ViemEscrowConfig, abi: unknown): EscrowPort {
  return {
    async open(args) {
      // `account` is NOT passed back here. Handing it over as an address
      // degraded the viem client into a "JSON-RPC account": viem then emitted
      // `eth_sendTransaction`, which public RPCs do not serve — there is no
      // unlocked account on them. The `walletClient` already carries its local
      // account, which signs offline; letting it decide is the only way to get a
      // locally signed transaction.
      return cfg.walletClient.writeContract({
        address: cfg.address,
        abi,
        chain: cfg.chain,
        functionName: 'open',
        args: [
          args.id,
          args.beneficiary,
          BigInt(args.bond),
          args.conditionHash,
          args.actionHash,
          BigInt(args.duration),
          // The `Authorization` struct as a **named object**: that is the shape
          // viem expects of a tuple whose components have names. A positional
          // array would be refused at encoding — which is preferable to
          // accepting it in an order we would not have checked.
          {
            from: args.authorization.from,
            value: args.authorization.value,
            validAfter: args.authorization.validAfter,
            validBefore: args.authorization.validBefore,
            nonce: args.authorization.nonce,
            v: args.authorization.v,
            r: args.authorization.r,
            s: args.authorization.s,
          },
        ],
      })
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `EscrowPort` through KeeperHub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The contract-call execution as the escrow sees it.
 *
 * Structurally satisfied by `KeeperHubClient`, but deliberately redeclared here
 * rather than imported: `gateway.ts` knows nothing but ports, and a type
 * dependency towards the HTTP client would make this file the place where one
 * discovers that the opening goes through a third party. The test verifies by
 * type assertion that the real client conforms — that is where the promise is
 * kept, not in a signature.
 */
export interface EscrowContractCall {
  chainId: number
  contractAddress: Address
  functionName: string
  functionArgs: readonly unknown[]
  /** JSON string on the wire — see `ContractCallRequest.abi`. */
  abi?: readonly unknown[]
}

export interface EscrowExecution {
  executionId: string
  status: string
  txHash?: Hex
  error?: string
}

export interface KeeperHubEscrowClient {
  executeContractCall(
    req: EscrowContractCall,
    idempotencyKey?: string,
  ): Promise<EscrowExecution>
}

export interface KeeperHubEscrowConfig {
  address: Address
  /** The escrow's chain. Generally distinct from the action's. */
  chainId: number
  client: KeeperHubEscrowClient
  /**
   * ABI of `WarrantEscrow`.
   *
   * Not optional in practice: KeeperHub can auto-resolve the ABI of a
   * **verified** contract only, which the escrow is not. Requiring it here
   * avoids discovering the problem on the first paid warrant.
   */
  abi: readonly unknown[]
}

/**
 * `EscrowPort` that opens the warrant **through KeeperHub**.
 *
 * This is the deployment's real path, not a variant: the onchain `opener` is
 * the KeeperHub organisation's wallet, and a local key signing `open()` would
 * be answered `NotOpener()`. The choice is argued in docs/transactions.md § 3 —
 * opening is the volume operation and it is gas-sponsored, settlement is the
 * sensitive operation and stays on a key we control. A KeeperHub organisation
 * having only one wallet, invariant I10 (`opener != settler`) forces it to be
 * one or the other.
 *
 * Two behavioural differences from `viemEscrow`, both accepted:
 *
 * - the call is **synchronous on the API side**: on return, the transaction is
 *   already included or the execution has failed. So we do not wait for
 *   confirmations here — the Settler does that, on an independent RPC.
 * - the transaction is **sponsored**, hence wrapped by a forwarder: `tx.to` is
 *   not the escrow. Of no importance for the opening (we do not re-read that
 *   transaction by its shape), but it is the raison d'être of
 *   `checks/forwarder.ts` on the action side.
 */
export function keeperHubEscrow(cfg: KeeperHubEscrowConfig): EscrowPort {
  return {
    async open(args) {
      const execution = await cfg.client.executeContractCall(
        {
          chainId: cfg.chainId,
          contractAddress: cfg.address,
          functionName: 'open',
          // ABI order, never named: KeeperHub positions the arguments.
          // Everything is passed as a string — `bond` and `duration` are
          // 256/64-bit integers that do not fit in a JSON `number`, and a value
          // travelling as a `number` would lose atomic units without signalling
          // anything.
          //
          // The `Authorization` struct is a **named object**, not an array, and
          // that is deliberate: `functionArgs` is serialised to JSON then
          // decoded by KeeperHub, which encodes with viem. viem requires named
          // components for a named tuple. A positional array would be refused at
          // encoding rather than encoded in some haphazard order — the failure
          // mode we want, on eight fields of which four are indistinguishable
          // 32-byte words.
          functionArgs: [
            args.id,
            args.beneficiary,
            args.bond,
            args.conditionHash,
            args.actionHash,
            String(args.duration),
            {
              from: args.authorization.from,
              value: args.authorization.value.toString(10),
              validAfter: args.authorization.validAfter.toString(10),
              validBefore: args.authorization.validBefore.toString(10),
              nonce: args.authorization.nonce,
              // `v` fits in a `number` without risk: it is 27 or 28.
              v: args.authorization.v,
              r: args.authorization.r,
              s: args.authorization.s,
            },
          ],
          abi: cfg.abi,
        },
        // The warrant identifier as the idempotency key: the replay window is
        // 24 h at the scale of the organisation, so a network timeout followed
        // by a retry cannot open the same warrant twice — the second call would
        // run into `AlreadyExists()` anyway, but only after burning gas and
        // muddying the audit trail.
        `warrant-open-${args.id}`,
      )

      if (execution.status !== 'success') {
        throw new Error(
          `KeeperHub: opening of warrant ${args.id} in status ${execution.status}` +
            (execution.error ? ` — ${execution.error}` : '') +
            ` (executionId ${execution.executionId || 'unknown'})`,
        )
      }
      if (!execution.txHash) {
        // A success without a hash proves nothing and does not replay: the
        // Settler would have no entry point to go and read the chain. Refused.
        throw new Error(
          `KeeperHub: opening ${args.id} reported successful without a transaction ` +
            `hash (executionId ${execution.executionId || 'unknown'})`,
        )
      }
      return execution.txHash
    },
  }
}

export { X402_VERSION }
