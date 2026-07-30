/**
 * x402 v2 wire types and MCP transport constants.
 *
 * Source: docs/05-specs-protocoles.md § 1.3 through § 1.7. Nothing is invented
 * here: every field corresponds literally to a field of the specification. The
 * delicate point — and the only one that is ours — is § 1.7: on MCP, the
 * `PaymentRequired` must travel **in both formats**, `structuredContent` and
 * `content[0].text`, strictly equivalent.
 */

/** Protocol version. v1 (`X-PAYMENT`) is not supported. */
export const X402_VERSION = 2 as const

/** `_meta` key through which the client passes its payment (docs/05 § 1.7 step 4). */
export const X402_PAYMENT_META_KEY = 'x402/payment'

/** `_meta` key through which the server returns the settlement (docs/05 § 1.7 step 6). */
export const X402_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response'

/** Resource for which payment is required. */
export interface ResourceInfo {
  url: string
  description?: string
  mimeType?: string
}

/**
 * One acceptable payment offer.
 *
 * `amount` is in atomic units and is a string: the bond of a warrant can exceed
 * `Number.MAX_SAFE_INTEGER` in atomic units, and a floating-point rounding error
 * on an amount is a class of bug we would rather not open.
 */
export interface PaymentRequirements {
  scheme: string
  /** CAIP-2 identifier, e.g. `eip155:8453`. */
  network: string
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

/** The body of the 402 — on MCP, the content of the erroring tool result. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION
  error?: string
  resource: ResourceInfo
  accepts: PaymentRequirements[]
  extensions?: Record<string, unknown>
}

/** The client's answer: the offer taken plus the proof of payment. */
export interface PaymentPayload {
  x402Version: typeof X402_VERSION
  resource: Pick<ResourceInfo, 'url'>
  accepted: PaymentRequirements
  payload: unknown
  extensions?: Record<string, unknown>
}

/** What the facilitator returns after `POST /settle` (docs/05 § 1.6). */
export interface SettlementResponse {
  success: boolean
  /** The hash Warrant records in `fundingRef`. */
  transaction?: string
  network?: string
  payer?: string
  amount?: string
  errorReason?: string
}

/**
 * Recognises a `PaymentRequired` on the wire.
 *
 * Deliberately structural rather than schema-based: the server on the other side
 * may announce `extensions` we know nothing about, and rejecting those would
 * break the forward compatibility the spec intends.
 */
export function isPaymentRequired(value: unknown): value is PaymentRequired {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.x402Version === X402_VERSION &&
    Array.isArray(v.accepts) &&
    typeof v.resource === 'object' &&
    v.resource !== null
  )
}

export function isPaymentPayload(value: unknown): value is PaymentPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.x402Version === X402_VERSION &&
    typeof v.accepted === 'object' &&
    v.accepted !== null &&
    'payload' in v
  )
}

/**
 * Payment signer. This is all the SDK asks of a wallet.
 *
 * The SDK does not sign anything itself: it holds no key, and wants none. The
 * concrete implementation (viem, mppx, an OpenClaw plugin…) is supplied by the
 * caller.
 */
export interface PaymentSigner {
  createPayment(required: PaymentRequired): Promise<PaymentPayload> | PaymentPayload
}
