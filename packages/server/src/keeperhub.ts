/**
 * Client KeeperHub — REST + marketplace.
 *
 * Deux surfaces sont utilisées :
 *   1. l'exécution onchain (`execute_contract_call`, `execute_transfer`, …)
 *   2. l'audit trail (`get_execution`), qui **localise et date** une exécution.
 *
 * L'audit trail ne décide jamais d'un verdict. La décision est une lecture
 * onchain indépendante faite par l'évaluateur sur un RPC tiers — utiliser
 * KeeperHub pour exécuter *et* pour juger réintroduirait une circularité.
 * Voir docs/08-integration-keeperhub.md § 4.
 *
 * ⚠ La forme exacte du record d'exécution n'est pas publiée dans un schéma
 * machine (l'OpenAPI live de KeeperHub est le catalogue marketplace, pas le
 * CRUD REST). Le parsing ci-dessous est donc **défensif** : il accepte
 * plusieurs noms de champs plausibles et signale ce qu'il n'a pas trouvé,
 * plutôt que de supposer. C'est le risque R3 de docs/13-risques.md.
 */

import type { Address, Hex } from '@warrant/core'

export interface KeeperHubConfig {
  /** Clé API scoped organisation, préfixe `kh_`. Jamais dans le dépôt. */
  apiKey: string
  baseUrl?: string
  /** Nombre de tentatives sur 429 et 5xx. */
  maxRetries?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_BASE_URL = 'https://app.keeperhub.com'

/** Enveloppe d'erreur documentée : `{ error, detail, hint, docs, request_id }`. */
export interface KeeperHubErrorBody {
  error: string
  detail?: string
  hint?: string
  docs?: string
  request_id?: string
}

export class KeeperHubError extends Error {
  readonly status: number
  readonly body: KeeperHubErrorBody
  /** Journalisé systématiquement : c'est ce qui permet de remonter un incident. */
  readonly requestId: string | undefined

  constructor(status: number, body: KeeperHubErrorBody) {
    const hint = body.hint ? ` — ${body.hint}` : ''
    super(`KeeperHub ${status} ${body.error}: ${body.detail ?? ''}${hint}`)
    this.name = 'KeeperHubError'
    this.status = status
    this.body = body
    this.requestId = body.request_id
  }
}

/** Statut d'une exécution KeeperHub, normalisé. */
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'unknown'

/**
 * Record d'exécution normalisé.
 *
 * Les champs optionnels le sont réellement : ne jamais supposer leur présence.
 * `raw` conserve la réponse intégrale pour l'audit et pour le teardown
 * d'onboarding.
 */
export interface Execution {
  executionId: string
  status: ExecutionStatus
  txHash?: Hex
  blockNumber?: bigint
  gasUsed?: bigint
  /** Distingue un échec d'exécution d'une exécution réussie non conforme. */
  outcome?: string
  /** Résultat de la simulation pré-soumission, si l'API l'expose. */
  simulation?: unknown
  retries?: number
  timestamp?: string
  raw: unknown
}

export interface ContractCallRequest {
  chainId: number
  to: Address
  data: Hex
  value?: string
}

export class KeeperHubClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch

  /** Derniers `request_id` vus, pour le journal de debug et les office hours. */
  readonly requestIds: string[] = []

  constructor(cfg: KeeperHubConfig) {
    if (!cfg.apiKey) throw new Error('KeeperHubClient: apiKey manquante')
    this.apiKey = cfg.apiKey
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.maxRetries = cfg.maxRetries ?? 4
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    let lastErr: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      } catch (e) {
        lastErr = e
        if (attempt === this.maxRetries) break
        await sleep(backoffMs(attempt))
        continue
      }

      const requestId = res.headers.get('x-request-id')
      if (requestId) this.requestIds.push(requestId)

      // 429 : la limite documentée est de 100 req/min authentifié.
      if (res.status === 429 || res.status >= 500) {
        if (attempt === this.maxRetries) {
          throw new KeeperHubError(res.status, await safeErrorBody(res))
        }
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs(attempt),
        )
        continue
      }

      if (!res.ok) {
        const errBody = await safeErrorBody(res)
        if (errBody.request_id) this.requestIds.push(errBody.request_id)
        throw new KeeperHubError(res.status, errBody)
      }

      const json = (await res.json()) as { data?: T } | T
      // Enveloppe documentée `{ data }`, mais certaines routes répondent à plat.
      return (json as { data?: T }).data !== undefined
        ? ((json as { data: T }).data)
        : (json as T)
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`KeeperHub: échec réseau sur ${method} ${path}`)
  }

  /** Exécute un appel de contrat arbitraire — le chemin générique de Warrant. */
  async executeContractCall(
    req: ContractCallRequest,
  ): Promise<{ executionId: string; status: string }> {
    return this.request('POST', '/api/execute/contract-call', {
      chainId: req.chainId,
      to: req.to,
      data: req.data,
      value: req.value ?? '0',
    })
  }

  /** Appelle un workflow du marketplace. Peut répondre 402 si payant. */
  async callWorkflow(
    slug: string,
    input: Record<string, unknown>,
  ): Promise<{ executionId: string; status: string }> {
    return this.request('POST', `/api/mcp/workflows/${slug}/call`, input)
  }

  async getExecution(executionId: string): Promise<Execution> {
    const raw = await this.request<unknown>(
      'GET',
      `/api/executions/${encodeURIComponent(executionId)}`,
    )
    return normalizeExecution(executionId, raw)
  }

  /**
   * Suit une exécution jusqu'à terminaison.
   *
   * Ne décide de rien : rend le record pour que le Settler aille lire la chaîne.
   */
  async pollExecution(
    executionId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<Execution> {
    const timeoutMs = opts.timeoutMs ?? 180_000
    const intervalMs = opts.intervalMs ?? 3_000
    const deadline = Date.now() + timeoutMs

    for (;;) {
      const exec = await this.getExecution(executionId)
      if (exec.status === 'success' || exec.status === 'failed') return exec
      if (Date.now() >= deadline) {
        throw new Error(
          `KeeperHub: exécution ${executionId} toujours ${exec.status} après ${timeoutMs} ms`,
        )
      }
      await sleep(intervalMs)
    }
  }
}

/**
 * Normalise un record d'exécution en acceptant plusieurs conventions de nommage.
 *
 * Tant que la forme réelle n'est pas confirmée contre l'API live (spike J1–J2),
 * il serait imprudent de coder contre un seul jeu de noms.
 */
export function normalizeExecution(executionId: string, raw: unknown): Execution {
  const r = (raw ?? {}) as Record<string, unknown>

  const txHash = pickString(r, ['txHash', 'transactionHash', 'tx_hash', 'hash'])
  const blockNumber = pickBigInt(r, ['blockNumber', 'block_number', 'block'])
  const gasUsed = pickBigInt(r, ['gasUsed', 'gas_used'])
  const outcome = pickString(r, ['outcome', 'result'])
  const timestamp = pickString(r, ['timestamp', 'createdAt', 'created_at'])
  const retries = pickBigInt(r, ['retries', 'retryCount', 'retry_count'])

  return {
    executionId,
    status: normalizeStatus(pickString(r, ['status', 'state'])),
    ...(txHash ? { txHash: txHash as Hex } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(gasUsed !== undefined ? { gasUsed } : {}),
    ...(outcome ? { outcome } : {}),
    ...(r['simulation'] !== undefined ? { simulation: r['simulation'] } : {}),
    ...(retries !== undefined ? { retries: Number(retries) } : {}),
    ...(timestamp ? { timestamp } : {}),
    raw,
  }
}

function normalizeStatus(s: string | undefined): ExecutionStatus {
  switch (s?.toLowerCase()) {
    case 'success':
    case 'succeeded':
    case 'completed':
    case 'confirmed':
      return 'success'
    case 'failed':
    case 'error':
    case 'reverted':
      return 'failed'
    case 'running':
    case 'executing':
      return 'running'
    case 'pending':
    case 'queued':
      return 'pending'
    default:
      return 'unknown'
  }
}

function pickString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function pickBigInt(
  o: Record<string, unknown>,
  keys: string[],
): bigint | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'bigint') return v
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v)
    if (typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v)) return BigInt(v)
  }
  return undefined
}

/**
 * Lit le corps d'erreur sans jamais lever : une réponse d'erreur mal formée ne
 * doit pas masquer le code HTTP, qui est l'information la plus utile.
 */
async function safeErrorBody(res: Response): Promise<KeeperHubErrorBody> {
  try {
    const parsed = (await res.json()) as Partial<KeeperHubErrorBody>
    if (parsed && typeof parsed.error === 'string') {
      return parsed as KeeperHubErrorBody
    }
    return { error: `http_${res.status}`, detail: JSON.stringify(parsed) }
  } catch {
    return { error: `http_${res.status}`, detail: res.statusText }
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Référence compacte reliant un verdict à la fois à l'exécution KeeperHub et à
 * la transaction onchain : `keccak256(executionId ‖ txHash)`.
 */
export function execRefInput(executionId: string, txHash: Hex): string {
  return `${executionId}${txHash}`
}
