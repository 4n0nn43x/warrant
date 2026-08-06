/**
 * The Gateway's two payment protocols: **x402 v2** and **MPP**.
 *
 * This file contains the protocol and nothing else — wire formats, encodings,
 * validation, facilitator client, Challenge store. It knows nothing of warrants,
 * of classification or of KeeperHub: `gateway.ts` is what wires them together.
 * Normative source: docs/05-specs-protocoles.md.
 *
 * Three traps of the spec are handled explicitly here, because getting them
 * wrong is silent:
 *
 * 1. **The headers changed between x402 v1 and v2.** `X-PAYMENT` no longer
 *    exists. We emit `PAYMENT-REQUIRED`, we read `PAYMENT-SIGNATURE`, we return
 *    `PAYMENT-RESPONSE`. No fallback to the v1 names: accepting both would amount
 *    to accepting two payload formats under a single name.
 * 2. **`/verify` and `/settle` are not symmetric.** `/verify` answers
 *    `{ isValid }`, `/settle` answers `{ success }`. A crossed read
 *    (`res.success` on `/verify`) is `undefined`, hence falsy, hence a silent
 *    refusal — or worse, the opposite, depending on which way the test runs. So we
 *    check for the **presence** of the expected boolean and reject a response that
 *    does not carry it, rather than coercing it.
 * 3. **An MPP Credential is good for exactly one request.** Replay is rejected
 *    strictly, by `challenge.id`, and the `id` is cryptographically bound to the
 *    Challenge's parameters: a Challenge echoed back with a modified amount does
 *    not recompute the same `id`.
 */

import { canonicalize, type Address, type Hex } from '@warrant/core'
import { keccak256, parseSignature, stringToBytes, toHex } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Encodings
// ─────────────────────────────────────────────────────────────────────────────

/** Standard base64 — the encoding of the x402 v2 headers. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** Unpadded base64url — the encoding of the MPP fields (RFC 4648 § 5). */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * Decoding that tolerates both alphabets. Node accepts the `-`/`_` characters as
 * `+`/`/`, which makes a single decoder safe: the two alphabets are disjoint on
 * the characters that distinguish them.
 */
export function b64decode(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8')
}

export class WireFormatError extends Error {
  override readonly name = 'WireFormatError'
  constructor(message: string) {
    super(message)
  }
}

/** Object → base64 of a JSON. Used for all three x402 headers. */
export function encodeHeaderObject(value: unknown): string {
  return b64encode(JSON.stringify(value))
}

/** base64 → object. An error here is a refusal, never a fallback to `{}`. */
export function decodeHeaderObject<T>(header: string): T {
  let text: string
  try {
    text = b64decode(header.trim())
  } catch {
    throw new WireFormatError('header not decodable as base64')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new WireFormatError(`header decoded but unreadable as JSON: ${text.slice(0, 120)}`)
  }
}

/**
 * Object → base64url of its **JCS (RFC 8785)** form.
 *
 * MPP requires JCS for `request` and `opaque`. We reuse `@warrant/core`'s
 * canonicalisation — the one behind `conditionHash` — rather than write a second
 * one: a divergence between two canonicalisations would be exactly risk R1 of
 * docs/13.
 */
export function encodeJcs(value: unknown): string {
  return b64urlEncode(canonicalize(value))
}

export function decodeJcs<T>(encoded: string): T {
  return decodeHeaderObject<T>(encoded)
}

// ─────────────────────────────────────────────────────────────────────────────
// x402 v2 — wire types
// ─────────────────────────────────────────────────────────────────────────────

export const X402_VERSION = 2 as const

/** Server → client, with HTTP 402 and a `{}` body. */
export const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED'
/** Client → server. Replaces v1's `X-PAYMENT`. */
export const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE'
/** Server → client, on the 200 response. */
export const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE'

export interface ResourceInfo {
  url: string
  description?: string
  mimeType?: string
}

/** Asset transfer methods of the `exact` scheme on EVM, in order of preference. */
/**
 * Asset transfer method, in the sense of x402 v2's `exact` scheme.
 *
 * The first three values are the spec's. `eip3009-receive` is a **deliberate
 * extension**, and it is worth saying exactly why it exists.
 *
 * The spec is normative on this field: `if present, MUST be "eip3009"`, and
 * `eip3009` there unambiguously designates `transferWithAuthorization`. But the
 * escrow consumes `receiveWithAuthorization`, whose `msg.sender == to` constraint
 * is what stops a third party from intercepting the authorization to burn the
 * nonce. Announcing `eip3009` would therefore be FALSE: a conforming client would
 * sign the wrong typehash, and `open()` would revert on an invalid signature.
 *
 * Measured, not assumed: the CDP facilitator answers `HTTP 400
 * invalid_exact_evm_payload_signature` to a `receive` authorization under the
 * `exact` scheme, and an unknown value of this field does not make it fail
 * cleanly — it silently falls back to `transfer`. There is therefore no
 * configuration in which a public facilitator verifies a `receive` authorization
 * under `exact`.
 *
 * The precedent exists on both sides: the CDP facilitator already verifies
 * `receiveWithAuthorization` signatures for its own `batch-settlement` scheme,
 * with a dedicated error reason; and three upstream PRs add transfer methods
 * through this very field, among them #2886, which likewise turns the EIP-3009
 * nonce into a commitment hash.
 *
 * An explicit, sourced non-conformance beats a standard field that lied.
 */
export type AssetTransferMethod = 'eip3009' | 'eip3009-receive' | 'permit2' | 'erc7710'

export interface PaymentRequirements {
  scheme: 'exact'
  /** **CAIP-2** identifier, e.g. `eip155:8453`. Never a bare chainId. */
  network: string
  /** Atomic units, as a decimal string. `"25000000"` = 25 USDC. */
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  /** EIP-3009 requires `name` and `version` — the token's real EIP-712 domain. */
  extra?: {
    name: string
    version: string
    assetTransferMethod?: AssetTransferMethod
    /**
     * The EIP-712 `primaryType` to be signed.
     *
     * Announced in the 402 rather than assumed, because the `exact` scheme's
     * default (`TransferWithAuthorization`) is **not** what the escrow consumes.
     * A client that reads this field signs the right typehash on the first try; a
     * client that ignores it will see `open()` revert at the token's signature
     * check, without a single fund having moved.
     */
    primaryType?: string
  }
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION
  error?: string
  resource: ResourceInfo
  accepts: PaymentRequirements[]
  extensions?: Record<string, unknown>
}

/**
 * EIP-3009 authorization, as the `exact` scheme transports it.
 *
 * ⚠ **The typehash is not among these fields, and that is the trap.** EIP-3009
 * defines two operations over exactly the same argument list:
 *
 *   TransferWithAuthorization(address from,address to,uint256 value,…)
 *   ReceiveWithAuthorization(address from,address to,uint256 value,…)
 *
 * Two different `keccak256` values, hence two different EIP-712 digests, hence
 * two signatures that are **not** interchangeable — while the signed data itself
 * is identical down to the bit. Nothing in an `ExactEvmAuthorization` says which
 * of the two was signed: the only way to find out is to submit the signature to
 * the token and see whether it reverts.
 *
 * `WarrantEscrow.open` calls `receiveWithAuthorization` — deliberately, because
 * the `receive` variant imposes `to == msg.sender` and so prevents a third party
 * from intercepting the authorization to burn the nonce before we do. Clients
 * must sign the `ReceiveWithAuthorization` typehash; a
 * `TransferWithAuthorization` signature, which is what x402 `exact`
 * implementations produce by default, will be rejected by the token and will make
 * `open()` revert. See `RECEIVE_WITH_AUTHORIZATION_TYPE`.
 */
export interface ExactEvmAuthorization {
  from: string
  /** Must be the escrow's address: it is the escrow that will call the token. */
  to: string
  value: string
  validAfter: string
  validBefore: string
  /** 32 random bytes, never reused. Becomes the `fundingRef`. */
  nonce: Hex
}

export interface ExactEvmPayload {
  /** 65 bytes, `r ‖ s ‖ v`. Split into `v`/`r`/`s` for the contract. */
  signature: Hex
  authorization: ExactEvmAuthorization
}

/**
 * The EIP-712 type clients must sign, in `signTypedData` form.
 *
 * Published here so that an integrator does not have to transcribe it: the field
 * order is part of the typehash, and a moved field produces a signature that is
 * valid for a message nobody will ever verify.
 *
 * The EIP-712 domain is the **token**'s — `{ name, version, chainId,
 * verifyingContract: asset }` — not the escrow's. `name` and `version` are
 * announced in `PaymentRequirements.extra`.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPE = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** Name of the expected typehash, announced in `PaymentRequirements.extra`. */
export const RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE = 'ReceiveWithAuthorization' as const

export interface PaymentPayload {
  x402Version: typeof X402_VERSION
  resource: { url: string }
  accepted: PaymentRequirements
  payload: ExactEvmPayload
  extensions?: Record<string, unknown>
}

/** `POST /verify` — carries `isValid`, **never** `success`. */
export interface VerifyResponse {
  isValid: boolean
  invalidReason?: string
  payer?: string
}

/** `POST /settle` — carries `success`, **never** `isValid`. */
export interface SettlementResponse {
  success: boolean
  transaction: Hex
  network: string
  payer: string
  amount?: string
  errorReason?: string
}

/**
 * What THIS Gateway announces by default.
 *
 * It is NOT the spec's default (`eip3009`): it is what the escrow actually
 * consumes. The spec's default would remain correct for an ordinary x402 server;
 * here it would describe an implementation other than ours.
 */
export const DEFAULT_TRANSFER_METHOD: AssetTransferMethod = 'eip3009-receive'

/** EIP-3009 validity window. Kept tight to narrow the replay window. */
export const MAX_TIMEOUT_SECONDS = 60

export interface BuildPaymentRequiredOptions {
  resource: ResourceInfo
  network: string
  amount: string
  asset: string
  payTo: string
  extra: {
    name: string
    version: string
    assetTransferMethod?: AssetTransferMethod
    primaryType?: string
  }
  maxTimeoutSeconds?: number
  error?: string
  extensions?: Record<string, unknown>
}

/** Builds the `PaymentRequired` of a 402 response. */
export function buildPaymentRequired(opts: BuildPaymentRequiredOptions): PaymentRequired {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: opts.network,
    amount: opts.amount,
    asset: opts.asset,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS,
    extra: {
      name: opts.extra.name,
      version: opts.extra.version,
      assetTransferMethod: opts.extra.assetTransferMethod ?? DEFAULT_TRANSFER_METHOD,
      // Always emitted: it is the one piece of information in the 402 that cannot
      // be guessed, and omitting it would leave the client on the scheme's default.
      primaryType: opts.extra.primaryType ?? RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
    },
  }
  return {
    x402Version: X402_VERSION,
    error: opts.error ?? `${HEADER_PAYMENT_SIGNATURE} header is required`,
    resource: opts.resource,
    accepts: [requirements],
    extensions: opts.extensions ?? {},
  }
}

export class PaymentRejected extends Error {
  override readonly name = 'PaymentRejected'
  readonly reason: string
  constructor(reason: string, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

/**
 * Checks that a `PaymentPayload` matches the requirements that were emitted.
 *
 * The facilitator redoes this check, but it can only do it against the
 * requirements **we hand it**: if we handed it the ones the client copied into
 * `accepted`, a client could lower the amount and the facilitator would
 * faithfully validate a payment conforming to fabricated requirements. The
 * comparison against the amount *we* computed is therefore the only point at
 * which the bond is genuinely constrained.
 *
 * @throws {PaymentRejected}
 */
export function assertPayloadMatches(
  payload: PaymentPayload,
  required: PaymentRequirements,
): void {
  if (payload?.x402Version !== X402_VERSION) {
    throw new PaymentRejected(
      'unsupported_version',
      `x402Version ${String(payload?.x402Version)}: only ${X402_VERSION} is supported`,
    )
  }
  const accepted = payload.accepted
  if (!accepted || typeof accepted !== 'object') {
    throw new PaymentRejected('malformed_payload', '`accepted` field missing from the PaymentPayload')
  }
  if (accepted.scheme !== required.scheme) {
    throw new PaymentRejected(
      'scheme_mismatch',
      `scheme "${String(accepted.scheme)}" instead of "${required.scheme}"`,
    )
  }
  if (accepted.network !== required.network) {
    throw new PaymentRejected(
      'network_mismatch',
      `network "${String(accepted.network)}" instead of "${required.network}"`,
    )
  }
  if (!sameAddress(accepted.asset, required.asset)) {
    throw new PaymentRejected(
      'asset_mismatch',
      `asset "${String(accepted.asset)}" instead of "${required.asset}"`,
    )
  }
  if (!sameAddress(accepted.payTo, required.payTo)) {
    throw new PaymentRejected(
      'recipient_mismatch',
      `recipient "${String(accepted.payTo)}" instead of "${required.payTo}"`,
    )
  }
  // Amount **exactly** equal — step 3 of the facilitator's verification.
  if (!sameAmount(accepted.amount, required.amount)) {
    throw new PaymentRejected(
      'amount_mismatch',
      `amount "${String(accepted.amount)}" instead of "${required.amount}"`,
    )
  }
  const auth = payload.payload?.authorization
  if (!auth) {
    throw new PaymentRejected('malformed_payload', 'EIP-3009 authorization missing')
  }
  if (!sameAmount(auth.value, required.amount)) {
    throw new PaymentRejected(
      'amount_mismatch',
      `authorization for ${String(auth.value)} against a required amount of ${required.amount}`,
    )
  }
  if (!sameAddress(auth.to, required.payTo)) {
    throw new PaymentRejected(
      'recipient_mismatch',
      `authorization towards ${String(auth.to)} instead of ${required.payTo}`,
    )
  }
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

function sameAmount(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Facilitator
// ─────────────────────────────────────────────────────────────────────────────

export interface FacilitatorConfig {
  url: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

export class FacilitatorError extends Error {
  override readonly name = 'FacilitatorError'
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * The minimal interface the Gateway depends on.
 *
 * ⚠ `settle()` is **no longer called on the warrants route**. Settlement is now
 * pulled by `WarrantEscrow.open()` itself, inside the transaction that opens the
 * warrant: delegating the transfer to the facilitator and then opening in a
 * second transaction was exactly the orphaned-funds window the audit closed. The
 * method stays on the interface because the facilitator remains a conforming
 * x402 service and another caller may legitimately use it; it is simply no longer
 * on the opening path.
 *
 * `verify()`, for its part, moves nothing and remains usable — but see
 * `RECEIVE_WITH_AUTHORIZATION_TYPE`: a facilitator that only implements the
 * `TransferWithAuthorization` typehash will wrongly invalidate our
 * authorizations.
 */
export interface Facilitator {
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse>
}

export class FacilitatorClient implements Facilitator {
  private readonly url: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(cfg: FacilitatorConfig) {
    if (!cfg.url) throw new Error('FacilitatorClient: url is missing')
    this.url = cfg.url.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  /**
   * What the facilitator declares itself able to serve.
   *
   * Warrant does NOT delegate signature verification to it: the escrow consumes
   * `receiveWithAuthorization`, which the `exact` scheme does not cover, and the
   * token verifies the signature authoritatively inside `open()` — it even
   * verifies more, since the contract additionally checks that the nonce really is
   * the hash of the committed terms.
   *
   * This call therefore plays a different role, and it is not decorative: it
   * verifies at startup that the configured facilitator does serve the scheme and
   * the network we announce in our 402 challenges. A facilitator that does not
   * cover our chain would produce challenges nobody can honour, and the failure
   * would only surface on the first payment.
   */
  async supported(): Promise<{ kinds: { scheme: string; network: string; x402Version?: number }[] }> {
    const res = await this.fetchImpl(`${this.url}/supported`, {
      headers: { accept: 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
    })
    if (!res.ok) throw new Error(`facilitator /supported: HTTP ${res.status}`)
    const body = (await res.json()) as { kinds?: { scheme: string; network: string; x402Version?: number }[] }
    return { kinds: body.kinds ?? [] }
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const body = await this.post('/verify', payload, requirements)
    // Trap #2: `/verify` carries `isValid`. A response that does not carry it is
    // not "invalid", it is unusable — we do not guess.
    if (typeof (body as VerifyResponse).isValid !== 'boolean') {
      throw new FacilitatorError(
        200,
        '/verify response with no boolean `isValid` field — ' +
          '/verify returns `isValid`, /settle returns `success`, the two are not interchangeable',
        body,
      )
    }
    return body as VerifyResponse
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    const body = await this.post('/settle', payload, requirements)
    if (typeof (body as SettlementResponse).success !== 'boolean') {
      throw new FacilitatorError(
        200,
        '/settle response with no boolean `success` field — ' +
          '/settle returns `success`, /verify returns `isValid`, the two are not interchangeable',
        body,
      )
    }
    return body as SettlementResponse
  }

  private async post(
    path: string,
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      }),
    })
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    if (!res.ok) {
      throw new FacilitatorError(
        res.status,
        `facilitator ${res.status} on ${path}`,
        body,
      )
    }
    return body
  }
}

/**
 * Hash of the transaction that moved the funds.
 *
 * This is **no longer** the warrant's `fundingRef`: since `open()` collects the
 * bond itself, the transaction that moves the funds is the opening, and the
 * `fundingRef` inscribed onchain is the authorization's nonce
 * (`fundingRefOfAuthorization`). This function therefore only serves to validate
 * the shape of a hash before returning it in a receipt — x402
 * `PAYMENT-RESPONSE` or MPP `Payment-Receipt`, both of which expect a settlement
 * reference.
 */
export function settlementTxOf(settlement: SettlementResponse): Hex {
  const tx = settlement.transaction
  // Uppercase `0X` accepted: some facilitators return it that way, and refusing
  // over the case of the prefix would lose a settlement already broadcast.
  if (typeof tx !== 'string' || !/^0[xX][0-9a-fA-F]{64}$/.test(tx)) {
    throw new PaymentRejected(
      'malformed_settlement',
      `unusable settlement transaction: ${String(tx)}`,
    )
  }
  return tx.toLowerCase() as Hex
}

/**
 * `fundingRef` = the authorization's **EIP-3009 nonce**.
 *
 * The contract inscribes `auth.nonce` and nothing else; recomputing the same
 * value here rather than reading it back onchain keeps the journal and the chain
 * in agreement without an extra RPC call. It is also a better `fundingRef` than
 * the old transaction hash: the token itself guarantees that this nonce is used
 * only once, whereas a tx hash guaranteed nothing of the kind.
 *
 * @throws {PaymentRejected} if the nonce is not a `bytes32`. The contract would
 *   accept it — any 32-byte word is one — but a shorter nonce would be
 *   left-padded by the ABI encoder, hence **different** from the one the agent
 *   signed, and the token would revert after the fact. Refusing here makes the
 *   diagnosis immediate.
 */
export function fundingRefOfAuthorization(auth: ExactEvmAuthorization): Hex {
  const nonce = auth?.nonce
  if (typeof nonce !== 'string' || !/^0[xX][0-9a-fA-F]{64}$/.test(nonce)) {
    throw new PaymentRejected(
      'malformed_authorization',
      `unusable EIP-3009 nonce: ${String(nonce)} — exactly 32 bytes expected`,
    )
  }
  return nonce.toLowerCase() as Hex
}

/**
 * The authorization in the shape `WarrantEscrow.open` expects: the
 * `Authorization` struct, with the signature already split into `v`/`r`/`s`.
 *
 * `to` **disappears** from the struct, and that is not an omission: the contract
 * passes `address(this)` to the token, precisely so that `to` cannot be declared.
 * It is `assertPayloadMatches` that checked upstream that the signed `to` really
 * equals `payTo` — which must be the escrow, otherwise the digest the agent
 * signed will not be the one the token recomputes.
 */
export interface EscrowAuthorization {
  from: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
  v: number
  r: Hex
  s: Hex
}

/**
 * `ExactEvmPayload` → `Authorization` struct.
 *
 * @throws {PaymentRejected} on a signature that is not 65 bytes, or on unreadable
 *   validity bounds. These refusals beat a reverting `open()`: they name the
 *   offending field to the client, who can then re-sign.
 */
export function escrowAuthorizationOf(payload: ExactEvmPayload): EscrowAuthorization {
  const auth = payload?.authorization
  if (!auth) {
    throw new PaymentRejected('malformed_payload', 'EIP-3009 authorization missing')
  }
  const signature = payload.signature
  // Exactly 65 bytes: `r`(32) ‖ `s`(32) ‖ `v`(1). viem's `parseSignature` accepts
  // broader shapes — ERC-2098 compact signatures, `yParity` without `v` — but the
  // contract takes three separate fields, one of them a `uint8`, and guessing `v`
  // from a compact signature would be a reconstruction we do not want to perform
  // silently.
  if (typeof signature !== 'string' || !/^0[xX][0-9a-fA-F]{130}$/.test(signature)) {
    throw new PaymentRejected(
      'malformed_signature',
      `signature of ${signature ? (signature.length - 2) / 2 : 0} byte(s): ` +
        '65 expected (r ‖ s ‖ v)',
    )
  }

  let parsed: { r: Hex; s: Hex; v?: bigint; yParity: number }
  try {
    parsed = parseSignature(signature.toLowerCase() as Hex) as typeof parsed
  } catch (err) {
    throw new PaymentRejected('malformed_signature', `unreadable signature: ${errText(err)}`)
  }
  // `v` rather than `yParity`: the token does an `ecrecover`, which wants 27 or
  // 28. viem only fills `v` in when the byte it read already was one; on a
  // signature whose last byte is 0 or 1, we normalise it.
  const v = parsed.v !== undefined ? Number(parsed.v) : parsed.yParity + 27
  if (v !== 27 && v !== 28) {
    throw new PaymentRejected(
      'malformed_signature',
      `v = ${v}: only 27 and 28 are recoverable by ecrecover`,
    )
  }

  return {
    from: requireAddress(auth.from, 'authorization.from'),
    value: requireUint(auth.value, 'authorization.value'),
    validAfter: requireUint(auth.validAfter, 'authorization.validAfter'),
    validBefore: requireUint(auth.validBefore, 'authorization.validBefore'),
    nonce: fundingRefOfAuthorization(auth),
    v,
    r: parsed.r,
    s: parsed.s,
  }
}

function requireAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !/^0[xX][0-9a-fA-F]{40}$/.test(value)) {
    throw new PaymentRejected(
      'malformed_authorization',
      `${field}: EVM address expected, got ${String(value)}`,
    )
  }
  return value.toLowerCase() as Address
}

function requireUint(value: unknown, field: string): bigint {
  let parsed: bigint
  try {
    parsed = BigInt(String(value))
  } catch {
    throw new PaymentRejected(
      'malformed_authorization',
      `${field}: integer expected, got ${String(value)}`,
    )
  }
  if (parsed < 0n) {
    throw new PaymentRejected('malformed_authorization', `${field}: negative (${parsed})`)
  }
  return parsed
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─────────────────────────────────────────────────────────────────────────────
// MPP — Challenge / Credential / Receipt
// ─────────────────────────────────────────────────────────────────────────────

export const HEADER_WWW_AUTHENTICATE = 'WWW-Authenticate'
export const HEADER_AUTHORIZATION = 'Authorization'
export const HEADER_PAYMENT_RECEIPT = 'Payment-Receipt'
/** Name of the RFC 9110 authentication scheme MPP uses. */
export const MPP_SCHEME = 'Payment'

/** MPP intents. Only `charge` is in v1 scope (docs/05 § 2.5). */
export type MppIntent = 'charge' | 'session' | 'subscription'

export interface MppChallenge {
  id: string
  realm: string
  /** `tempo`, `stripe`, `evm`, `card`… */
  method: string
  intent: MppIntent
  /** JCS JSON, base64url-encoded. */
  request: string
  /** ISO 8601. */
  expires?: string
  /** JCS JSON, base64url-encoded. The client must send it back **unchanged**. */
  opaque?: string
  description?: string
}

/** Fields common to the decoded `request`. */
export interface MppRequestBody {
  /** Base units. */
  amount: string
  /** Currency code or token address. */
  currency: string
  /** The method's native format. */
  recipient: string
  [key: string]: unknown
}

export type MppPayloadType = 'transaction' | 'hash' | 'proof'

export interface MppCredential {
  /** The Challenge echoed back **as-is**, wire values included. */
  challenge: MppChallenge
  payload: {
    type: MppPayloadType
    signature?: Hex
    /** EIP-3009 authorization for `transaction` mode on an EVM rail. */
    authorization?: ExactEvmAuthorization
    [key: string]: unknown
  }
  /** The payer's address, DID or account identifier. */
  source: string
}

export interface MppReceipt {
  challengeId: string
  method: string
  reference: string
  settlement: { amount: string; currency: string }
  status: 'success' | 'failed'
  timestamp: string
}

const CHALLENGE_PARAM_ORDER = [
  'id',
  'realm',
  'method',
  'intent',
  'expires',
  'opaque',
  'request',
  'description',
] as const

/**
 * Serialises a Challenge into a `WWW-Authenticate` header value.
 *
 * RFC 9110 format: `Payment k="v", k="v"`. Values are always quoted — a base64url
 * `id` can contain `-` and `_`, which are not `token` characters in the sense of
 * the grammar.
 */
export function formatChallengeHeader(challenge: MppChallenge): string {
  const parts: string[] = []
  for (const key of CHALLENGE_PARAM_ORDER) {
    const value = (challenge as unknown as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}="${escapeQuoted(String(value))}"`)
  }
  return `${MPP_SCHEME} ${parts.join(', ')}`
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Parses a `WWW-Authenticate: Payment …` value. Used by the tests and by a
 * client; the server does not need it, since it emits.
 *
 * @throws {WireFormatError}
 */
export function parseChallengeHeader(header: string): MppChallenge {
  const trimmed = header.trim()
  const prefix = `${MPP_SCHEME} `
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new WireFormatError(`unexpected authentication scheme: ${trimmed.slice(0, 40)}`)
  }
  const params: Record<string, string> = {}
  const re = /([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(trimmed.slice(prefix.length))) !== null) {
    params[match[1] as string] = (match[2] as string).replace(/\\(.)/g, '$1')
  }
  for (const required of ['id', 'realm', 'method', 'intent', 'request'] as const) {
    if (!params[required]) {
      throw new WireFormatError(`required Challenge parameter missing: ${required}`)
    }
  }
  return {
    id: params['id'] as string,
    realm: params['realm'] as string,
    method: params['method'] as string,
    intent: params['intent'] as MppIntent,
    request: params['request'] as string,
    ...(params['expires'] ? { expires: params['expires'] } : {}),
    ...(params['opaque'] ? { opaque: params['opaque'] } : {}),
    ...(params['description'] ? { description: params['description'] } : {}),
  }
}

export function encodeCredential(credential: MppCredential): string {
  return b64urlEncode(JSON.stringify(credential))
}

/** Reads the value of `Authorization: Payment …`. @throws {WireFormatError} */
export function decodeCredentialHeader(header: string): MppCredential {
  const trimmed = header.trim()
  const prefix = `${MPP_SCHEME} `
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new WireFormatError(
      `Authorization header without the ${MPP_SCHEME} scheme: ${trimmed.slice(0, 40)}`,
    )
  }
  const credential = decodeHeaderObject<MppCredential>(trimmed.slice(prefix.length))
  if (!credential || typeof credential !== 'object' || !credential.challenge) {
    throw new WireFormatError('Credential with no echoed Challenge')
  }
  return credential
}

export function encodeReceipt(receipt: MppReceipt): string {
  return b64urlEncode(JSON.stringify(receipt))
}

export function decodeReceipt(header: string): MppReceipt {
  return decodeHeaderObject<MppReceipt>(header)
}

// ─────────────────────────────────────────────────────────────────────────────
// Challenge store
// ─────────────────────────────────────────────────────────────────────────────

export type MppErrorCode =
  | 'malformed_credential'
  | 'unknown_challenge'
  | 'challenge_expired'
  | 'challenge_replayed'
  | 'challenge_tampered'
  | 'opaque_mismatch'

export class MppError extends Error {
  override readonly name = 'MppError'
  readonly code: MppErrorCode
  constructor(code: MppErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface IssuedChallenge<T = unknown> {
  challenge: MppChallenge
  /** Associated server-side context — never transmitted to the client. */
  context: T
  issuedAt: number
  expiresAt: number
  consumed: boolean
}

export interface ChallengeStoreOptions {
  /** `MPP_SECRET_KEY`. Never logged, never exposed to the client. */
  secret: string
  ttlSeconds?: number
  now?: () => number
  /** Injectable salt, to make the tests deterministic. */
  salt?: () => string
}

export interface IssueOptions<T> {
  realm: string
  method: string
  intent: MppIntent
  request: MppRequestBody
  opaque?: Record<string, unknown>
  description?: string
  context: T
}

/** Default TTL of a Challenge, in seconds. */
export const DEFAULT_CHALLENGE_TTL = 300

/**
 * In-memory Challenge store, with a TTL and strict rejection of replays.
 *
 * The `id` is a MAC over the Challenge's parameters: that is what the spec means
 * by "unique identifier, cryptographically bound to the Challenge's parameters".
 * Two useful consequences:
 *
 * - a Challenge echoed back with a modified amount does not recompute the same
 *   `id`, so `consume()` rejects it even when the original `id` is known;
 * - `opaque` is covered by the MAC, so its integrity is verified without having
 *   to trust it on read.
 *
 * In memory, therefore lost on restart: an unconsumed Challenge becomes unknown,
 * which is the refusal in the correct direction. A v2 would put it in Redis with
 * the same TTL.
 */
export class ChallengeStore<T = unknown> {
  private readonly secret: string
  private readonly ttlSeconds: number
  private readonly now: () => number
  private readonly salt: () => string
  private readonly entries = new Map<string, IssuedChallenge<T>>()

  constructor(opts: ChallengeStoreOptions) {
    if (!opts.secret) throw new Error('ChallengeStore: secret is missing (MPP_SECRET_KEY)')
    this.secret = opts.secret
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_CHALLENGE_TTL
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.salt =
      opts.salt ??
      (() => toHex(crypto.getRandomValues(new Uint8Array(16))))
  }

  issue(opts: IssueOptions<T>): MppChallenge {
    const issuedAt = this.now()
    const expiresAt = issuedAt + this.ttlSeconds
    const salt = this.salt()

    const partial = {
      realm: opts.realm,
      method: opts.method,
      intent: opts.intent,
      request: encodeJcs(opts.request),
      expires: new Date(expiresAt * 1000).toISOString(),
      ...(opts.opaque ? { opaque: encodeJcs(opts.opaque) } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    }

    const challenge: MppChallenge = { id: this.bind(partial, salt), ...partial }

    this.gc()
    this.entries.set(challenge.id, {
      challenge,
      context: opts.context,
      issuedAt,
      expiresAt,
      consumed: false,
    })
    return challenge
  }

  /** Read without consuming — for tests and introspection. */
  peek(id: string): IssuedChallenge<T> | undefined {
    return this.entries.get(id)
  }

  /**
   * Validates a Credential and **consumes** the Challenge. Each Credential is
   * valid for exactly one request (docs/05 § 2.3).
   *
   * @throws {MppError}
   */
  consume(credential: MppCredential): IssuedChallenge<T> {
    const echoed = credential?.challenge
    if (!echoed || typeof echoed.id !== 'string' || echoed.id === '') {
      throw new MppError('malformed_credential', 'Credential with no `challenge.id`')
    }

    const entry = this.entries.get(echoed.id)
    if (!entry) {
      throw new MppError(
        'unknown_challenge',
        `no pending Challenge for id ${echoed.id}`,
      )
    }
    if (entry.consumed) {
      // Strict rejection of replay, ahead of even the expiry check: it is the
      // gravest fault and it must be named as such.
      throw new MppError(
        'challenge_replayed',
        `Challenge ${echoed.id} already consumed — a Credential is good for one request only`,
      )
    }
    if (this.now() > entry.expiresAt) {
      this.entries.delete(echoed.id)
      throw new MppError('challenge_expired', `Challenge ${echoed.id} expired`)
    }

    // The Challenge is echoed back as-is: any divergence is a tampering.
    for (const key of CHALLENGE_PARAM_ORDER) {
      const mine = (entry.challenge as unknown as Record<string, unknown>)[key]
      const theirs = (echoed as unknown as Record<string, unknown>)[key]
      if ((mine ?? undefined) !== (theirs ?? undefined)) {
        throw new MppError(
          key === 'opaque' ? 'opaque_mismatch' : 'challenge_tampered',
          `Challenge parameter "${key}" was modified: emitted ${JSON.stringify(mine)}, ` +
            `received ${JSON.stringify(theirs)}`,
        )
      }
    }

    entry.consumed = true
    return entry
  }

  /** Purges the expired Challenges. Called on every issuance. */
  gc(): void {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(id)
    }
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * `id = base64url(keccak256(secret ‖ JCS(parameters) ‖ salt)[0..16])`.
   *
   * The secret never appears in the output and is never logged; the salt makes
   * two Challenges for the same action distinct, without which an agent could not
   * pay for the same action twice.
   */
  private bind(partial: Omit<MppChallenge, 'id'>, salt: string): string {
    const digest = keccak256(
      stringToBytes(`${this.secret}|${canonicalize(partial)}|${salt}`),
    )
    return Buffer.from(digest.slice(2, 34), 'hex').toString('base64url')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC 9457 — Problem Details, the error format of the MPP path
// ─────────────────────────────────────────────────────────────────────────────

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  [key: string]: unknown
}

/** URI space of the Gateway's error types. */
/**
 * RFC 9457 `type`. A URN, not an https URL.
 *
 * The `type` is an identifier first: the spec only says it SHOULD dereference to
 * documentation, and this project publishes none. It used to be
 * `https://warrant.sh/problems/…` — a domain owned by an unrelated project, so
 * every error we returned pointed a reader at someone else's site. A URN
 * promises nothing and misattributes nothing.
 */
export const PROBLEM_BASE = 'urn:warrant:problem'

export function problem(
  code: string,
  status: number,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}:${code}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridges between the two rails
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuilds an x402 `PaymentPayload` from an MPP Credential.
 *
 * This is what makes the two rails **strictly equivalent downstream**: the same
 * EIP-3009 authorization reaches `open()`, hence the same `fundingRef` — its
 * nonce — and the same agent, `auth.from`. The rail is only a means of
 * transporting the signature (docs/04).
 *
 * @throws {PaymentRejected} if the Credential carries no usable authorization.
 *   Tempo's `hash` and `proof` payloads are out of v1 scope: a non-zero `charge`
 *   in pull mode, hence `transaction`.
 */
export function paymentPayloadFromCredential(
  credential: MppCredential,
  required: PaymentRequirements,
  resourceUrl: string,
): PaymentPayload {
  const payload = credential.payload
  if (!payload || payload.type !== 'transaction') {
    throw new PaymentRejected(
      'unsupported_payload_type',
      `MPP payload of type "${String(payload?.type)}": only "transaction" is supported in v1`,
    )
  }
  if (!payload.authorization || !payload.signature) {
    throw new PaymentRejected(
      'malformed_payload',
      'MPP `transaction` payload with neither an EIP-3009 `authorization` nor a `signature`',
    )
  }
  return {
    x402Version: X402_VERSION,
    resource: { url: resourceUrl },
    accepted: required,
    payload: {
      signature: payload.signature,
      authorization: payload.authorization,
    },
    extensions: {},
  }
}

/**
 * Extracts an EVM address from an MPP `source`, which may be a bare address or a
 * PKH DID (`did:pkh:eip155:4217:0x1234…`).
 */
export function addressFromSource(source: string | undefined): Address | undefined {
  if (typeof source !== 'string') return undefined
  const match = /0[xX][0-9a-fA-F]{40}$/.exec(source.trim())
  return match ? (match[0].toLowerCase() as Address) : undefined
}
