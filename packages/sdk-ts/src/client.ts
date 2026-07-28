/**
 * `WarrantClient` — le client HTTP du Gateway, plus la boucle de paiement x402.
 *
 * Deux niveaux dans un seul objet, volontairement :
 *
 * - il **implémente `GatewayClient`** — transport nu, un appel HTTP par
 *   méthode, aucune magie ;
 * - il expose `call()`, qui exécute un descripteur d'outil et **rejoue
 *   automatiquement** avec le paiement quand un signataire est configuré.
 *
 * C'est `call()` que consomment les adaptateurs de framework : un agent
 * LangChain ou Vercel AI ne doit pas avoir à connaître le protocole 402.
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

/** En-têtes du transport HTTP v2. Les noms ont changé depuis v1 (docs/05 § 1.2). */
const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED'
const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE'
const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE'

export interface WarrantClientOptions {
  /** Racine du Gateway, ex. `https://api.warrant.sh`. */
  baseUrl: string
  /** Signataire de la caution. Sans lui, `call()` remonte le PaymentRequired. */
  wallet?: PaymentSigner
  /** Injectable pour les tests et les runtimes sans `fetch` global. */
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
  /** Nombre de rejeux de paiement autorisés. Un seul suffit au flux nominal. */
  maxPaymentAttempts?: number
}

/** UTF-8 puis base64. Les descriptions de post-conditions contiennent des accents. */
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

  constructor(options: WarrantClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
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
      throw new WarrantError('gateway_unreachable', `Gateway injoignable : ${String(err)}`, {
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
      /* le corps n'est pas du JSON — on garde le texte brut */
    }
    if (res.status === 404) {
      throw new WarrantError('warrant_not_found', `${path} : introuvable.`, { details })
    }
    throw new WarrantError('gateway_error', `${path} a répondu ${res.status}.`, { details })
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
          `Le Gateway a répondu 402 sans PaymentRequired x402 v${X402_VERSION} exploitable.`,
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
   * Exécute un outil par son nom, en réglant la caution si un wallet est
   * configuré.
   *
   * Le rejeu est borné (`maxPaymentAttempts`) : une boucle de paiement non
   * bornée face à un serveur qui répond 402 en permanence viderait un wallet
   * agentique sans qu'aucun humain ne le remarque.
   */
  async call<T = unknown>(name: string, args: unknown): Promise<ToolOutcome<T>> {
    return runToolByName<T>(this, name, args, {
      wallet: this.wallet,
      maxPaymentAttempts: this.maxPaymentAttempts,
    })
  }

  /** Sucre typé — la voie normale pour du code applicatif. */
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
 * Aplatit la réponse de `GET /v1/warrants/:id`.
 *
 * Le Gateway sert une enveloppe — `{ warrant, verdict, checks, actionSpec… }` —
 * avec un `status` en toutes lettres, tandis que `WarrantView` est plate et
 * porte l'entier de l'enum Solidity. Traduire ici plutôt que dans les outils
 * garde la normalisation à la frontière du transport, là où elle appartient :
 * un adaptateur de framework n'a pas à connaître deux formes du même objet.
 *
 * Une réponse déjà plate traverse sans être touchée — le jour où le Gateway
 * s'aligne, il n'y a rien à retirer.
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

/** `"Open"` ou `1` — les deux mènent au même entier, celui de l'enum Solidity. */
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
    'Paiement requis et aucun wallet configuré sur le client.',
    {
      hint: "Passe un `wallet` à WarrantClient, ou utilise `call()` et règle toi-même le PaymentRequired retourné.",
      details: outcome.paymentRequired,
    },
  )
}

export { toWarrantError }
