/**
 * `WarrantClient` — the Gateway's HTTP client, plus the x402 payment loop.
 *
 * Two levels in a single object, on purpose:
 *
 * - it **implements `GatewayClient`** — bare transport, one HTTP call per
 *   method, no magic;
 * - it exposes `call()`, which runs a tool descriptor and **automatically
 *   replays** with the payment when a signer is configured.
 *
 * It is `call()` that the framework adapters consume: a LangChain or Vercel AI
 * agent should not have to know about the 402 protocol.
 */

import type { Hex } from '@warrant/core'

import { WarrantError, toWarrantError } from './errors.js'
import type {
  GatewayClient,
  ListWarrantsQuery,
  ListWarrantsResult,
  QuoteRequest,
  QuoteResult,
  RequestWarrantResult,
  WarrantOpened,
  WarrantRequest,
  WarrantView,
} from './gateway.js'
import type { ToolOutcome } from './tools.js'
import { runToolByName } from './tools.js'
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentSigner,
  SettlementResponse,
} from './x402.js'
import { X402_VERSION, isPaymentRequired } from './x402.js'

/** Headers of the HTTP v2 transport. The names changed since v1 (docs/05 § 1.2). */
const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED'
const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE'
const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE'

/**
 * The hosted Gateway on Base Sepolia.
 *
 * Used when the caller names none. The default points at the public deployment
 * and not at `127.0.0.1:8402` because of who installs this package: an agent
 * developer who has never run our server and has no reason to. A localhost
 * default made the first call after `npm i` fail with a connection refused,
 * which reads as a broken package rather than as missing infrastructure.
 *
 * Anyone running their own Gateway passes `baseUrl` — one line, either way.
 */
export const DEFAULT_BASE_URL = 'https://warrant.fyra.fun'

export interface WarrantClientOptions {
  /** Root of the Gateway. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** Signer of the bond. Without it, `call()` surfaces the PaymentRequired. */
  wallet?: PaymentSigner
  /** Injectable for tests and for runtimes without a global `fetch`. */
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
  /** Number of payment replays allowed. One is enough for the nominal flow. */
  maxPaymentAttempts?: number
}

/** UTF-8 then base64. Post-condition descriptions contain non-ASCII characters. */
function encodeBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64<T>(value: string): T {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

export class WarrantClient implements GatewayClient {
  private readonly baseUrl: string
  private readonly doFetch: typeof globalThis.fetch
  private readonly headers: Record<string, string>
  private readonly maxPaymentAttempts: number
  readonly wallet?: PaymentSigner

  constructor(options: WarrantClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.headers = { 'content-type': 'application/json', ...options.headers }
    this.maxPaymentAttempts = options.maxPaymentAttempts ?? 1
    if (options.wallet) this.wallet = options.wallet
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.doFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
      })
    } catch (err) {
      throw new WarrantError('gateway_unreachable', `Gateway unreachable: ${String(err)}`, {
        cause: err,
      })
    }
  }

  private async readError(res: Response, path: string): Promise<never> {
    const body = await res.text().catch(() => '')
    let details: unknown = body
    try {
      details = JSON.parse(body)
    } catch {
      /* the body is not JSON — keep the raw text */
    }
    if (res.status === 404) {
      throw new WarrantError('warrant_not_found', `${path}: not found.`, { details })
    }
    throw new WarrantError('gateway_error', `${path} answered ${res.status}.`, { details })
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const res = await this.request('/v1/quote', { method: 'POST', body: JSON.stringify(req) })
    if (!res.ok) await this.readError(res, 'POST /v1/quote')
    return (await res.json()) as QuoteResult
  }

  async requestWarrant(
    req: WarrantRequest,
    payment?: PaymentPayload,
  ): Promise<RequestWarrantResult> {
    const headers: Record<string, string> = {}
    if (payment) headers[HEADER_PAYMENT_SIGNATURE] = encodeBase64(payment)

    const res = await this.request('/v1/warrants', {
      method: 'POST',
      body: JSON.stringify(req),
      headers,
    })

    if (res.status === 402) {
      const header = res.headers.get(HEADER_PAYMENT_REQUIRED)
      const paymentRequired = header
        ? decodeBase64<PaymentRequired>(header)
        : ((await res.json()) as PaymentRequired)
      if (!isPaymentRequired(paymentRequired)) {
        throw new WarrantError(
          'payment_invalid',
          `The Gateway answered 402 without a usable x402 v${X402_VERSION} PaymentRequired.`,
          { details: paymentRequired },
        )
      }
      return { status: 'payment-required', paymentRequired }
    }

    if (!res.ok) await this.readError(res, 'POST /v1/warrants')

    const warrant = (await res.json()) as WarrantOpened
    const receipt = res.headers.get(HEADER_PAYMENT_RESPONSE)
    const settlement = receipt ? decodeBase64<SettlementResponse>(receipt) : undefined
    return settlement
      ? { status: 'opened', warrant, settlement }
      : { status: 'opened', warrant }
  }

  async getWarrant(warrantId: Hex): Promise<WarrantView | null> {
    const res = await this.request(`/v1/warrants/${warrantId}`, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) await this.readError(res, `GET /v1/warrants/${warrantId}`)
    return normalizeWarrantView(await res.json())
  }

  async listWarrants(query: ListWarrantsQuery): Promise<ListWarrantsResult> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    const res = await this.request(`/v1/warrants?${params.toString()}`, { method: 'GET' })
    if (!res.ok) await this.readError(res, 'GET /v1/warrants')
    return (await res.json()) as ListWarrantsResult
  }

  /**
   * Runs a tool by its name, settling the bond if a wallet is configured.
   *
   * The replay is bounded (`maxPaymentAttempts`): an unbounded payment loop
   * facing a server that answers 402 forever would drain an agentic wallet
   * without any human noticing.
   */
  async call<T = unknown>(name: string, args: unknown): Promise<ToolOutcome<T>> {
    return runToolByName<T>(this, name, args, {
      wallet: this.wallet,
      maxPaymentAttempts: this.maxPaymentAttempts,
    })
  }

  /** Typed sugar — the normal route for application code. */
  async quoteRisk(args: unknown): Promise<QuoteResult> {
    return unwrap(await this.call<QuoteResult>('quote_risk', args))
  }

  async openWarrant(args: unknown): Promise<WarrantOpened> {
    return unwrap(await this.call<WarrantOpened>('request_warrant', args))
  }

  async readWarrant(args: unknown): Promise<WarrantView> {
    return unwrap(await this.call<WarrantView>('get_warrant', args))
  }

  async history(args: unknown): Promise<ListWarrantsResult> {
    return unwrap(await this.call<ListWarrantsResult>('list_warrants', args))
  }
}

/**
 * Flattens the response of `GET /v1/warrants/:id`.
 *
 * The Gateway serves an envelope — `{ warrant, verdict, checks, actionSpec… }` —
 * with a spelled-out `status`, whereas `WarrantView` is flat and carries the
 * integer of the Solidity enum. Translating here rather than in the tools keeps
 * the normalisation at the transport boundary, where it belongs: a framework
 * adapter has no business knowing two shapes of the same object.
 *
 * An already-flat response passes through untouched — the day the Gateway falls
 * into line, there is nothing to remove.
 */
export function normalizeWarrantView(raw: unknown): WarrantView {
  const body = raw as Record<string, unknown>
  const nested = body['warrant']
  if (typeof nested !== 'object' || nested === null) return body as unknown as WarrantView

  const warrant = nested as Record<string, unknown>
  const verdict = body['verdict']
  const execution = body['execution'] as { executionId?: string } | undefined
  const quote = body['quote'] as { category?: string } | undefined

  const view: Record<string, unknown> = {
    ...warrant,
    warrantId: warrant['warrantId'] ?? warrant['id'],
    status: normalizeStatus(warrant['status']),
    checks: Array.isArray(body['checks']) ? body['checks'] : [],
  }
  delete view['id']

  if (verdict) view['verdict'] = verdict
  if (execution?.executionId !== undefined) view['executionId'] = execution.executionId
  if (quote?.category !== undefined) view['category'] = quote.category
  for (const key of ['actionSpec', 'conditionSpec'] as const) {
    if (body[key] !== undefined) view[key] = body[key]
  }

  return view as unknown as WarrantView
}

/** `"Open"` or `1` — both lead to the same integer, that of the Solidity enum. */
function normalizeStatus(status: unknown): number {
  if (typeof status === 'number') return status
  const names = ['None', 'Open', 'Honored', 'Slashed', 'Reclaimed']
  const index = names.indexOf(String(status))
  return index === -1 ? 0 : index
}

function unwrap<T>(outcome: ToolOutcome<T>): T {
  if (outcome.kind === 'ok') return outcome.data
  throw new WarrantError(
    'payment_invalid',
    'Payment required and no wallet configured on the client.',
    {
      hint: 'Pass a `wallet` to WarrantClient, or use `call()` and settle the returned PaymentRequired yourself.',
      details: outcome.paymentRequired,
    },
  )
}

export { toWarrantError }
