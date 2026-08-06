/**
 * The MPP rail, client side.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file exists
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The Gateway has served both rails since day one, and `POST /v1/warrants`
 * answers a 402 carrying an x402 `PAYMENT-REQUIRED` **and** an MPP
 * `WWW-Authenticate: Payment` at once. But the only code that ever spoke MPP back
 * to it lived inside the server's own test file. An SDK that calls itself the
 * single source of the tools while supporting one of the two advertised rails is
 * advertising something no client of ours can take.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What is ours, and what is not
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here signs. The EIP-3009 authorization an MPP `transaction` payload
 * carries is **the same object** the x402 rail puts in its `PaymentPayload`, so
 * this module asks the caller's existing `PaymentSigner` for it and repackages
 * it. That is deliberate: two ways of obtaining a signature would be two ways of
 * signing the wrong thing, and the rail is a means of transport, not a different
 * commitment. `credentialFrom` is the exact mirror of the server's
 * `paymentPayloadFromCredential` — one packs, the other unpacks, and a
 * conformance test in `@warrant/server` holds the two halves against each other.
 *
 * Only `transaction` is produced. MPP also defines `hash` and `proof` payloads;
 * the Gateway refuses them explicitly, so emitting one would be building a
 * request we know will be turned down.
 */

import type { PaymentPayload, PaymentRequired, PaymentSigner } from './x402.js'

/** RFC 9110 authentication scheme carrying MPP. */
export const MPP_SCHEME = 'Payment'

/** Header the 402 puts its Challenge in. */
export const HEADER_WWW_AUTHENTICATE = 'WWW-Authenticate'

/** Header the client puts its Credential in. */
export const HEADER_AUTHORIZATION = 'Authorization'

/** Header the Gateway answers with on the MPP rail. */
export const HEADER_PAYMENT_RECEIPT = 'Payment-Receipt'

/**
 * MPP payment method this SDK speaks.
 *
 * `evm` — "stablecoin payments on EVM chains with inline x402 exact
 * compatibility" in the MPP method registry. Not `tempo`, which is TIP-20 on the
 * Tempo chain and a different request schema.
 */
export const MPP_METHOD_EVM = 'evm'

/** MPP intents. Only `charge` is in scope. */
export type MppIntent = 'charge' | 'session' | 'subscription'

export interface MppChallenge {
  id: string
  realm: string
  method: string
  intent: MppIntent
  /** JCS JSON, base64url-encoded. Opaque to the client. */
  request: string
  expires?: string
  /** Echoed back **unchanged**: it is covered by the Challenge's MAC. */
  opaque?: string
  description?: string
}

export type MppPayloadType = 'transaction' | 'hash' | 'proof'

export interface MppCredential {
  /** The Challenge echoed back as-is, wire values included. */
  challenge: MppChallenge
  payload: {
    type: MppPayloadType
    signature?: string
    authorization?: unknown
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

/** A Challenge or Credential that does not parse. */
export class MppWireError extends Error {
  override readonly name = 'MppWireError'
}

// ─────────────────────────────────────────────────────────────────────────────
// base64url — no padding, `-` and `_` (RFC 4648 § 5)
// ─────────────────────────────────────────────────────────────────────────────

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// Challenge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a `WWW-Authenticate: Payment …` value.
 *
 * Values are always quoted on the wire — a base64url `id` contains `-` and `_`,
 * which are not `token` characters in RFC 9110's grammar — so the parameter
 * grammar accepted here is the quoted one, with backslash escapes.
 *
 * @throws {MppWireError} on a different scheme or a Challenge missing a
 *   mandatory parameter. Missing `id` or `request` is fatal rather than
 *   defaulted: a Credential echoing a partial Challenge fails the server's MAC,
 *   and the resulting `challenge_tampered` would be blamed on the wrong side.
 */
export function parseChallengeHeader(header: string): MppChallenge {
  const trimmed = header.trim()
  const prefix = `${MPP_SCHEME} `
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new MppWireError(`unexpected authentication scheme: ${trimmed.slice(0, 40)}`)
  }

  const params: Record<string, string> = {}
  const re = /([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(trimmed)) !== null) {
    params[match[1]!] = match[2]!.replace(/\\(.)/g, '$1')
  }

  for (const required of ['id', 'realm', 'method', 'intent', 'request'] as const) {
    if (!params[required]) {
      throw new MppWireError(`MPP Challenge without "${required}"`)
    }
  }

  return {
    id: params['id']!,
    realm: params['realm']!,
    method: params['method']!,
    intent: params['intent'] as MppIntent,
    request: params['request']!,
    ...(params['expires'] ? { expires: params['expires'] } : {}),
    ...(params['opaque'] ? { opaque: params['opaque'] } : {}),
    ...(params['description'] ? { description: params['description'] } : {}),
  }
}

/**
 * Picks the MPP Challenge out of a response.
 *
 * A 402 may carry several `WWW-Authenticate` values, only one of which is ours;
 * `Headers.get` joins them with `, `, which is also the Challenge's own parameter
 * separator, so splitting on commas would shred a valid Challenge. We therefore
 * look for the scheme keyword and cut there.
 *
 * Returns `undefined` rather than throwing when there is no MPP offer: a server
 * serving x402 alone is a normal counterparty, not an error.
 */
export function challengeFromResponse(headers: Headers): MppChallenge | undefined {
  const raw = headers.get(HEADER_WWW_AUTHENTICATE)
  if (!raw) return undefined
  const at = raw.search(new RegExp(`(^|[,\\s])${MPP_SCHEME}\\s`, 'i'))
  if (at === -1) return undefined
  const from = raw.slice(at).replace(/^[,\s]+/, '')
  return parseChallengeHeader(from)
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repackages an x402 `PaymentPayload` as an MPP Credential.
 *
 * The mirror of the Gateway's `paymentPayloadFromCredential`. What crosses over
 * is exactly the pair (`signature`, `authorization`): the same EIP-3009
 * authorization, hence the same `fundingRef` — its nonce — and the same agent,
 * derived from the signature by the contract. That is what makes the two rails
 * produce an identical warrant instead of merely a similar one.
 *
 * @throws {MppWireError} if the payload carries no EIP-3009 material. The x402
 *   `exact` scheme on EVM always does; a payload without it belongs to another
 *   scheme, and wrapping it would produce a Credential the Gateway rejects for a
 *   reason that names the wrong layer.
 */
export function credentialFrom(
  challenge: MppChallenge,
  payment: PaymentPayload,
  source: string,
): MppCredential {
  const inner = payment.payload as
    | { signature?: string; authorization?: unknown }
    | undefined
  if (!inner || !inner.signature || !inner.authorization) {
    throw new MppWireError(
      'x402 payload with neither an EIP-3009 `authorization` nor a `signature`: ' +
        'nothing to carry on the MPP rail',
    )
  }
  return {
    // Echoed **as-is**: the server's Challenge id is a MAC over these very
    // fields, so re-serialising `request` or dropping `opaque` turns a valid
    // payment into `challenge_tampered`.
    challenge,
    payload: {
      type: 'transaction',
      signature: inner.signature,
      authorization: inner.authorization,
    },
    source,
  }
}

/** Encodes a Credential for the `Authorization` header. */
export function encodeCredential(credential: MppCredential): string {
  return b64urlEncode(JSON.stringify(credential))
}

/** The full `Authorization: Payment …` header value. */
export function authorizationHeader(credential: MppCredential): string {
  return `${MPP_SCHEME} ${encodeCredential(credential)}`
}

/** Decodes the `Payment-Receipt` the Gateway answers with. */
export function decodeReceipt(header: string): MppReceipt {
  let json: string
  try {
    json = atob(header.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    throw new MppWireError('Payment-Receipt is not valid base64url')
  }
  try {
    return JSON.parse(json) as MppReceipt
  } catch {
    throw new MppWireError('Payment-Receipt is not valid JSON')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The handshake
// ─────────────────────────────────────────────────────────────────────────────

export interface MppPaymentOptions {
  /** The 402 body, as the x402 rail describes it. Both rails price identically. */
  required: PaymentRequired
  /** The MPP Challenge, out of `WWW-Authenticate`. */
  challenge: MppChallenge
  /** Supplies the EIP-3009 authorization. The same one the x402 rail uses. */
  signer: PaymentSigner
  /** The payer, as an address or a `did:pkh:…`. */
  source: string
}

/**
 * Turns a 402 into the `Authorization` header that answers it.
 *
 * Split out from any HTTP loop on purpose: the caller owns the retry, and this
 * function owns the format. It is also what makes the rail testable without a
 * server.
 */
export async function mppAuthorization(opts: MppPaymentOptions): Promise<string> {
  const payment = await opts.signer.createPayment(opts.required)
  return authorizationHeader(credentialFrom(opts.challenge, payment, opts.source))
}
