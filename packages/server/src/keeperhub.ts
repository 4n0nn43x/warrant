/**
 * Client KeeperHub — exécution directe et audit trail.
 *
 * Routes vérifiées contre `docs.keeperhub.com/api/*` le 28/07/2026. Elles ne
 * figurent PAS dans l'OpenAPI live (`/api/openapi`), qui ne couvre que la
 * marketplace `/api/mcp/workflows/{slug}/call`. C'est la friction n°1 du
 * teardown d'onboarding.
 *
 * Division du travail, à ne jamais inverser : l'audit trail **localise et
 * date** une exécution ; la décision de verdict est une lecture onchain
 * indépendante faite par l'évaluateur sur un RPC tiers. Utiliser KeeperHub
 * pour exécuter *et* pour juger réintroduirait une circularité.
 * Voir docs/08-integration-keeperhub.md § 4.
 */

import type { Address, Hex } from '@warrant/core'

export interface KeeperHubConfig {
  /**
   * Clé API **d'organisation**, préfixe `kh_`.
   *
   * Une clé `wfb_` est une clé *utilisateur* et n'est acceptée que par
   * `POST /api/workflows/{id}/webhook` — elle est rejetée en 401 partout
   * ailleurs, y compris sur le serveur MCP.
   */
  apiKey: string
  baseUrl?: string
  maxRetries?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_BASE_URL = 'https://app.keeperhub.com'

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

/** Le cap journalier du wallet d'exécution est dépassé (HTTP 403). */
export class SpendCapExceededError extends KeeperHubError {
  constructor(body: KeeperHubErrorBody) {
    super(403, body)
    this.name = 'SpendCapExceededError'
  }
}

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export interface TransactionRef {
  hash: Hex
  nodeId?: string
  nodeName?: string
  chainId?: number
}

/**
 * Record d'exécution normalisé.
 *
 * ⚠ `blockNumber` n'est **pas** exposé par l'API KeeperHub, sur aucune route.
 * Il doit être dérivé du `txHash` via un RPC — ce que fait le Settler, qui
 * attend de toute façon les confirmations sur un RPC indépendant.
 *
 * ⚠ Le résultat de simulation n'apparaît pas non plus dans l'audit trail :
 * `simulate: true` ne crée aucune ligne d'exécution. Il n'existe que dans la
 * réponse HTTP synchrone de l'appel de simulation.
 */
export interface Execution {
  executionId: string
  status: ExecutionStatus
  txHash?: Hex
  transactions: TransactionRef[]
  gasUsedWei?: bigint
  outcome?: string
  error?: string
  completedAt?: string
  raw: unknown
}

export interface SimulationResult {
  success: boolean
  status: 'simulated'
  from: Address
  to: Address
  value?: string
  gasEstimate?: string
  simulatedReturnValue?: unknown
  wouldRevert: boolean
  revertReason?: string
}

export interface WalletInfo {
  hasWallet: boolean
  walletAddress?: Address
  walletId?: string
  isActive?: boolean
}

export interface SpendCap {
  dailyCapWei: string
  spentTodayWei: string
  remainingWei: string
  percentUsed: number
}

export interface ContractCallRequest {
  chainId: number
  contractAddress: Address
  /** Calldata complet. */
  data: Hex
  value?: string
  gasLimitMultiplier?: string
}

export class KeeperHubClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch

  /** Journal des `request_id`, pour remonter un incident en office hours. */
  readonly requestIds: string[] = []

  constructor(cfg: KeeperHubConfig) {
    if (!cfg.apiKey) throw new Error('KeeperHubClient: apiKey manquante')
    if (cfg.apiKey.startsWith('wfb_')) {
      throw new Error(
        'KeeperHubClient: une clé `wfb_` est une clé webhook utilisateur, ' +
          "acceptée uniquement par POST /api/workflows/{id}/webhook. Il faut une clé d'organisation `kh_` " +
          '(Settings → API Keys → onglet Organisation, ou `kh auth login`).',
      )
    }
    this.apiKey = cfg.apiKey
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.maxRetries = cfg.maxRetries ?? 4
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
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
            ...extraHeaders,
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

      // La limite documentée est de 60 req/min par clé sur l'exécution directe.
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
        // Le cap journalier n'est pas une erreur transitoire : ne pas réessayer.
        if (res.status === 403 && /spending cap/i.test(errBody.detail ?? errBody.error)) {
          throw new SpendCapExceededError(errBody)
        }
        throw new KeeperHubError(res.status, errBody)
      }

      const json = (await res.json()) as { data?: T } | T
      return (json as { data?: T }).data !== undefined
        ? (json as { data: T }).data
        : (json as T)
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`KeeperHub: échec réseau sur ${method} ${path}`)
  }

  // ── Exécution directe ─────────────────────────────────────────────────────

  /**
   * Simule un appel de contrat sans rien diffuser.
   *
   * `simulate` doit être un **booléen strict** : l'API rejette `"true"` et `1`
   * en 400, précisément pour qu'une coercition accidentelle ne se transforme
   * pas en diffusion réelle. On ne prend donc jamais ce paramètre de
   * l'extérieur.
   *
   * Un mandat dont la simulation échoue n'est jamais ouvert : la caution n'est
   * pas prélevée pour un échec prévisible.
   */
  async simulateContractCall(req: ContractCallRequest): Promise<SimulationResult> {
    return this.request('POST', '/api/execute/contract-call', {
      ...contractCallBody(req),
      simulate: true,
    })
  }

  /**
   * Exécute un appel de contrat. Synchrone côté API.
   *
   * `idempotencyKey` est indispensable dès qu'un retry est possible : la
   * fenêtre de replay est de 24 h, à l'échelle de l'organisation. Sans elle,
   * un timeout réseau suivi d'un retry diffuse deux transactions.
   */
  async executeContractCall(
    req: ContractCallRequest,
    idempotencyKey?: string,
  ): Promise<Execution> {
    const raw = await this.request<unknown>(
      'POST',
      '/api/execute/contract-call',
      { ...contractCallBody(req), simulate: false },
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    )
    return normalizeExecution(raw)
  }

  async executeTransfer(
    req: {
      chainId: number
      recipientAddress: Address
      /** Montant en unités humaines, ex. "0.1". */
      amount: string
      tokenAddress?: Address
    },
    idempotencyKey?: string,
  ): Promise<Execution> {
    const raw = await this.request<unknown>(
      'POST',
      '/api/execute/transfer',
      { ...req, simulate: false },
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    )
    return normalizeExecution(raw)
  }

  /** Statut d'une exécution directe. */
  async getDirectExecution(executionId: string): Promise<Execution> {
    const raw = await this.request<unknown>(
      'GET',
      `/api/execute/${encodeURIComponent(executionId)}/status`,
    )
    return normalizeExecution(raw, executionId)
  }

  // ── Exécutions de workflow ────────────────────────────────────────────────

  async getWorkflowExecution(executionId: string): Promise<Execution> {
    const raw = await this.request<unknown>(
      'GET',
      `/api/workflows/executions/${encodeURIComponent(executionId)}/status`,
    )
    return normalizeExecution(raw, executionId)
  }

  /**
   * Attend l'état terminal côté serveur. Préférable à une boucle de polling :
   * un seul appel, et pas de rate limit consommé pour rien.
   *
   * `timeoutMs` est plafonné à 60 s par l'API.
   */
  async waitForWorkflowExecution(
    executionId: string,
    timeoutMs = 25_000,
  ): Promise<Execution> {
    const capped = Math.min(Math.max(timeoutMs, 1_000), 60_000)
    const raw = await this.request<unknown>(
      'GET',
      `/api/workflows/executions/${encodeURIComponent(executionId)}/wait?timeoutMs=${capped}`,
    )
    return normalizeExecution(raw, executionId)
  }

  /**
   * Suit une exécution jusqu'à terminaison, quel que soit son type.
   *
   * Ne décide de rien : rend le record pour que le Settler aille lire la chaîne.
   */
  async pollExecution(
    executionId: string,
    opts: { timeoutMs?: number; intervalMs?: number; kind?: 'direct' | 'workflow' } = {},
  ): Promise<Execution> {
    const timeoutMs = opts.timeoutMs ?? 180_000
    const intervalMs = opts.intervalMs ?? 3_000
    const kind = opts.kind ?? 'direct'
    const deadline = Date.now() + timeoutMs

    for (;;) {
      const exec =
        kind === 'workflow'
          ? await this.getWorkflowExecution(executionId)
          : await this.getDirectExecution(executionId)

      if (isTerminal(exec.status)) return exec
      if (Date.now() >= deadline) {
        throw new Error(
          `KeeperHub: exécution ${executionId} toujours ${exec.status} après ${timeoutMs} ms`,
        )
      }
      await sleep(intervalMs)
    }
  }

  // ── Wallet et budget ──────────────────────────────────────────────────────

  /** Wallet Turnkey de l'organisation active. Les soldes sont ailleurs. */
  async getWallet(): Promise<WalletInfo> {
    return this.request('GET', '/api/user/wallet')
  }

  async getWalletBalances(): Promise<unknown> {
    return this.request('GET', '/api/user/wallet/balances')
  }

  /**
   * Cap de dépense journalier de l'organisation, en wei.
   *
   * À surveiller avant un runner de volume : un dépassement fait échouer les
   * exécutions en 403, et le compteur ne se remet à zéro qu'à minuit UTC.
   */
  async getSpendCap(): Promise<SpendCap> {
    return this.request('GET', '/api/analytics/spend-cap')
  }

  async getChains(): Promise<unknown[]> {
    return this.request('GET', '/api/chains')
  }
}

function contractCallBody(req: ContractCallRequest): Record<string, unknown> {
  return {
    chainId: req.chainId,
    contractAddress: req.contractAddress,
    data: req.data,
    value: req.value ?? '0',
    ...(req.gasLimitMultiplier ? { gasLimitMultiplier: req.gasLimitMultiplier } : {}),
  }
}

function isTerminal(status: ExecutionStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'cancelled'
}

/**
 * Normalise un record d'exécution.
 *
 * Les deux familles de routes n'ont pas le même vocabulaire : l'exécution
 * directe dit `completed`/`failed` et `transactionHash`, le workflow dit
 * `success`/`error` et `transactionHashes[]`. On ramène tout à une forme unique.
 */
export function normalizeExecution(raw: unknown, fallbackId = ''): Execution {
  const r = (raw ?? {}) as Record<string, unknown>

  const transactions: TransactionRef[] = []
  const list = r['transactionHashes']
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string') {
        transactions.push({ hash: item as Hex })
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        const hash = pickString(o, ['hash', 'transactionHash', 'txHash'])
        if (hash) {
          transactions.push({
            hash: hash as Hex,
            ...(typeof o['nodeId'] === 'string' ? { nodeId: o['nodeId'] } : {}),
            ...(typeof o['nodeName'] === 'string' ? { nodeName: o['nodeName'] } : {}),
            ...(typeof o['chainId'] === 'number' ? { chainId: o['chainId'] } : {}),
          })
        }
      }
    }
  }

  const single = pickString(r, ['transactionHash', 'txHash', 'hash'])
  if (single && !transactions.some((t) => t.hash.toLowerCase() === single.toLowerCase())) {
    transactions.push({ hash: single as Hex })
  }

  const gasUsedWei = pickBigInt(r, ['gasUsedWei', 'gasUsed'])
  const outcome = pickString(r, ['outcome', 'result'])
  const errorText = pickString(r, ['error', 'errorMessage'])
  const completedAt = pickString(r, ['completedAt', 'completed_at', 'timestamp'])

  return {
    executionId: pickString(r, ['executionId', 'id']) ?? fallbackId,
    status: normalizeStatus(pickString(r, ['status', 'state'])),
    ...(transactions[0] ? { txHash: transactions[0].hash } : {}),
    transactions,
    ...(gasUsedWei !== undefined ? { gasUsedWei } : {}),
    ...(outcome ? { outcome } : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(completedAt ? { completedAt } : {}),
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
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
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

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function pickBigInt(o: Record<string, unknown>, keys: string[]): bigint | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'bigint') return v
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v)
    if (typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v)) return BigInt(v)
  }
  return undefined
}

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

/** `execRef` relie un verdict à l'exécution KeeperHub et à la transaction. */
export function execRefInput(executionId: string, txHash: Hex): string {
  return `${executionId}${txHash}`
}
