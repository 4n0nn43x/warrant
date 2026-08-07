/**
 * The MCP transport of x402 v2.
 *
 * Specification: docs/05-specs-protocoles.md § 1.7, docs/09 § 3. The flow comes
 * in four beats:
 *
 * 1. a paid tool called without payment → a result with `isError: true` carrying
 *    the `PaymentRequired`;
 * 2. the client extracts the requirements from it and builds a `PaymentPayload`;
 * 3. it replays with the payment in `_meta["x402/payment"]`;
 * 4. the server settles and returns the settlement in
 *    `_meta["x402/payment-response"]`.
 *
 * The requirement not to be missed is that of the **dual format**. The spec
 * mandates supplying the `PaymentRequired` both as `structuredContent` and as
 * `content[0].text`, the latter being exactly `JSON.stringify` of the former —
 * clients that cannot read structured content must be able to parse the text and
 * obtain the same object.
 *
 * `dualFormat()` below is the server's only factory of results. It serialises
 * **the very object** it places in `structuredContent`, so that a divergence
 * between the two formats is not merely improbable: it is inexpressible.
 *
 * ## Why the challenge does not go through MRTR
 *
 * The 2026-07-28 revision introduces multi-round-trip requests (MRTR): a server
 * that needs something more answers `resultType: "input_required"` and the
 * client replays the request. That is exactly the shape of a 402, and the
 * temptation is strong — all the more so since the security requirements the
 * spec imposes on `requestState` (HMAC/AEAD integrity, short TTL, binding to the
 * principal, fingerprint of the original request) are word for word what is
 * needed to bind a quote to its payment.
 *
 * We do not do it, and the reason is structural rather than prudential:
 * **`InputRequiredResult` has neither `content` nor `structuredContent`.** Its
 * only fields are `resultType`, `inputRequests` and `requestState`
 * (basic/patterns/mrtr § InputRequiredResult, and the v2 SDK type confirms it).
 * And none of those three slots is a place to lodge a `PaymentRequired`:
 *
 * - `inputRequests` is a closed type — its values **must** be an
 *   `ElicitRequest`, a `CreateMessageRequest` or a `ListRootsRequest`. There is
 *   no "payment" request, and hijacking an elicitation would amount to asking a
 *   human to type in by hand what the agent's wallet is supposed to sign on its
 *   own — the negation of the very principle of x402.
 * - `requestState` is opaque by contract: "Clients **MUST NOT** inspect, parse,
 *   modify, or make any assumptions about its contents". A conforming client
 *   therefore cannot read the amount to pay out of it.
 * - that would leave `_meta`, the only free field inherited from `Result`. But
 *   putting the `PaymentRequired` there destroys precisely the invariant this
 *   file exists to uphold: no more `content[0].text`, hence no more dual format,
 *   hence a client that only reads the text learns nothing at all.
 *
 * On top of that comes a defect in observable behaviour. The spec says that a
 * client receiving an `input_required` **without** `inputRequests` "**MAY** retry
 * the original request immediately". An agent would therefore replay
 * immediately, without payment, receive the same `input_required`, and loop —
 * without any text ever explaining to it that it must pay. The `isError` path,
 * by contrast, puts the payable object in front of the model's eyes in both
 * formats.
 *
 * Finally, compatibility: an `input_required` served to a 2025 client is caught
 * by the SDK's "legacy shim", which tries to satisfy the `inputRequests` with
 * real server→client requests. With no `inputRequests`, there is nothing to
 * satisfy. On the day this page is written the revision is one day old and
 * virtually every x402 client is still on 2025.
 *
 * So we keep `isError: true`. This is not a renunciation of MRTR: it is the
 * observation that MRTR carries *typed input requests*, not application data,
 * and that a payment challenge is application data. The day the spec defines a
 * `PaymentRequest` in `inputRequests` — or allows `content` on an
 * `InputRequiredResult` — the switch will be a few lines, and `dualFormat()`
 * will remain the mandatory point of passage.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  X402_PAYMENT_META_KEY,
  X402_PAYMENT_RESPONSE_META_KEY,
  isPaymentPayload,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from 'warrant-sdk'

export { X402_PAYMENT_META_KEY, X402_PAYMENT_RESPONSE_META_KEY }

/** Any JSON object — all that `structuredContent` accepts. */
type JsonObject = Record<string, unknown>

/**
 * Builds a tool result in both required formats.
 *
 * Never build a `CallToolResult` any other way in this package: this is the sole
 * guarantee that `content[0].text` and `structuredContent` cannot diverge.
 */
export function dualFormat(payload: JsonObject, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
  if (isError) result.isError = true
  return result
}

/**
 * The result of a paid tool called without payment.
 *
 * `isError: true` is counter-intuitive — nothing failed — but it is what the
 * spec mandates: MCP has no "402" channel, and the erroring result is the only
 * one through which a client can receive usable data rather than a protocol
 * error. The 2026-07-28 revision does not change that; the analysis of the MRTR
 * case is at the head of this file.
 */
export function paymentRequiredResult(paymentRequired: PaymentRequired): CallToolResult {
  return dualFormat(paymentRequired as unknown as JsonObject, true)
}

/** Attaches the settlement to the result — step 6 of the flow. */
export function withSettlement(
  result: CallToolResult,
  settlement: SettlementResponse | undefined,
): CallToolResult {
  if (!settlement) return result
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [X402_PAYMENT_RESPONSE_META_KEY]: settlement },
  }
}

/**
 * Extracts the payment from `_meta` — step 4 of the flow.
 *
 * A `_meta["x402/payment"]` that is present but malformed is treated as absent:
 * we then answer with a fresh `PaymentRequired`, which gives the client a chance
 * to correct itself. Throwing a protocol error would leave it with no
 * information about what to pay.
 */
export function extractPayment(meta: unknown): PaymentPayload | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const candidate = (meta as Record<string, unknown>)[X402_PAYMENT_META_KEY]
  return isPaymentPayload(candidate) ? candidate : undefined
}
