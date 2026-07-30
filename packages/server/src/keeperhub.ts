/**
 * KeeperHub client — direct execution and audit trail.
 *
 * Routes verified against `docs.keeperhub.com/api/*` on 2026-07-28. They do NOT
 * appear in the live OpenAPI document (`/api/openapi`), which covers only the
 * `/api/mcp/workflows/{slug}/call` marketplace. This is friction #1 of the
 * onboarding teardown.
 *
 * Division of labour, never to be inverted: the audit trail **locates and
 * timestamps** an execution; the verdict decision is an independent onchain read
 * performed by the evaluator against a third-party RPC. Using KeeperHub both to
 * execute *and* to judge would reintroduce a circularity.
 * See docs/08-integration-keeperhub.md § 4.
 */

import type { Address, Hex } from '@warrant/core'

export interface KeeperHubConfig {
  /**
   * **Organisation** API key, `kh_` prefix.
   *
   * A `wfb_` key is a *user* key and is accepted only by
   * `POST /api/workflows/{id}/webhook` — everywhere else it is rejected with a
   * 401, the MCP server included.
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

/** The execution wallet's daily cap has been exceeded (HTTP 403). */
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
 * Normalised execution record.
 *
 * ⚠ `blockNumber` is **not** exposed by the KeeperHub API, on any route. It has
 * to be derived from the `txHash` through an RPC — which is what the Settler
 * does, since it waits for confirmations on an independent RPC anyway.
 *
 * ⚠ The simulation result does not appear in the audit trail either:
 * `simulate: true` creates no execution row at all. It exists only in the
 * synchronous HTTP response of the simulation call.
 */
/** The call as KeeperHub reports having executed it. */
export interface ExecutedCall {
  contractAddress?: Address
  functionName?: string
  functionSignature?: string
  args?: Record<string, unknown>
  reverted?: boolean
  sponsored?: boolean
  /**
   * Recipient of the top-level transaction.
   *
   * Differs from `contractAddress` when the gas is sponsored: it is then the
   * **forwarder**'s address, not the target contract's. This is the field that
   * reveals an unwrapping will be needed on the evaluator's side.
   */
  topLevelTo?: Address
}

export interface Execution {
  executionId: string
  status: ExecutionStatus
  txHash?: Hex
  transactions: TransactionRef[]
  gasUsedWei?: bigint
  gasPriceWei?: bigint
  outcome?: string
  error?: string
  completedAt?: string
  /** `contract-call`, `transfer`, … */
  type?: string
  /** Network, reported as a string by the API. */
  chainId?: number
  /** Number of attempts. Feeds the dashboard's reliability metric. */
  retryCount?: number
  /** True if KeeperHub paid the gas — which implies going through a forwarder. */
  sponsored?: boolean
  executedCall?: ExecutedCall
  /** Explorer link supplied by the API, reused as-is in the verdicts. */
  transactionLink?: string
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

/**
 * A contract call as the KeeperHub API actually accepts it.
 *
 * ⚠ **There is no way to pass a pre-encoded calldata.** The `data`, `callData`
 * and `calldata` fields are ignored, and the error that comes back only mentions
 * `functionName` without ever saying so. The API resolves the contract's ABI
 * itself from the function name.
 *
 * Consequence for Warrant: the Gateway encodes the calldata on its own side in
 * order to commit to it in `actionHash`, then sends the named form here. The
 * `calldata_matches_commitment` check closes the loop by comparing what actually
 * went out on the chain against what had been committed to.
 */
export interface ContractCallRequest {
  chainId: number
  contractAddress: Address
  functionName: string
  /**
   * The function's arguments, in ABI order.
   *
   * Serialised to a **JSON string** at send time: the API rejects an array with
   * "functionArgs must be a JSON string when provided".
   */
  functionArgs: readonly unknown[]
  /**
   * The contract's ABI, mandatory as soon as the contract is **not verified** on
   * the explorer — which is the case for `WarrantEscrow` on Sepolia.
   *
   * Serialised to a **JSON string** at send time, exactly like `functionArgs`.
   * The trap is that passing an array produces the message for a *missing* ABI
   * ("ABI is required. Could not auto-fetch ABI…") rather than the one for a
   * wrong type: you conclude the field is unsupported and go looking elsewhere
   * (docs/onboarding-teardown.md, 15:20). Hence the strong typing here: the
   * caller passes an array, and serialisation happens in exactly one place.
   */
  abi?: readonly unknown[]
  value?: string
  gasLimitMultiplier?: string
}

export class KeeperHubClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch

  /** Log of the `request_id` values, to raise an incident during office hours. */
  readonly requestIds: string[] = []

  constructor(cfg: KeeperHubConfig) {
    if (!cfg.apiKey) throw new Error('KeeperHubClient: apiKey is missing')
    if (cfg.apiKey.startsWith('wfb_')) {
      throw new Error(
        'KeeperHubClient: a `wfb_` key is a user webhook key, accepted only by ' +
          'POST /api/workflows/{id}/webhook. An organisation key `kh_` is required ' +
          '(Settings → API Keys → Organisation tab, or `kh auth login`).',
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

      // The documented limit is 60 req/min per key on direct execution.
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
        // The daily cap is not a transient error: do not retry.
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
      : new Error(`KeeperHub: network failure on ${method} ${path}`)
  }

  // ── Direct execution ──────────────────────────────────────────────────────

  /**
   * Simulates a contract call without broadcasting anything.
   *
   * `simulate` must be a **strict boolean**: the API rejects `"true"` and `1`
   * with a 400, precisely so that an accidental coercion does not turn into a
   * real broadcast. We therefore never take this parameter from the outside.
   *
   * A warrant whose simulation fails is never opened: no bond is taken for a
   * foreseeable failure.
   */
  async simulateContractCall(req: ContractCallRequest): Promise<SimulationResult> {
    return this.request('POST', '/api/execute/contract-call', {
      ...contractCallBody(req),
      simulate: true,
    })
  }

  /**
   * Executes a contract call. Blocking on the API side — the response only
   * arrives once the execution has finished (≈ 23 s measured on Sepolia).
   *
   * ⚠ **The POST response does not carry the transaction hash.** It returns a
   * `202` with exactly `{ executionId, status: "completed" }` — so: an announced
   * success, a finished execution, and nothing with which to go and verify it.
   * The hash, the `sponsored` flag, the gas and the `executedCall` exist only on
   * `GET /api/execute/{id}/status`, where they are available immediately.
   * `resolveTransaction` is what closes that gap, once for every caller: a port
   * that returned an "open" warrant with no hash would leave the Settler without
   * any entry point for reading the chain.
   *
   * `idempotencyKey` is indispensable as soon as a retry is possible: the replay
   * window is 24 h, at organisation scope. Without it, a network timeout followed
   * by a retry broadcasts two transactions.
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
    return this.resolveTransaction(normalizeExecution(raw))
  }

  /**
   * Completes an execution record that is missing its hash.
   *
   * Does nothing when the hash is already there — the day the API returns it in
   * the POST response, this code stops costing a round trip without anyone having
   * to touch it. Does nothing on a failure either: a `failed` execution does not
   * necessarily have a transaction, and insisting would not make one appear.
   */
  private async resolveTransaction(execution: Execution, attempts = 4): Promise<Execution> {
    if (execution.txHash || !execution.executionId) return execution
    if (execution.status === 'failed' || execution.status === 'cancelled') return execution

    for (let attempt = 0; attempt < attempts; attempt++) {
      let fresh: Execution
      try {
        fresh = await this.getDirectExecution(execution.executionId)
      } catch {
        // The POST record remains the best thing we have: losing it would mean
        // forgetting the `executionId`, the only thread back to an execution that
        // has already been broadcast.
        return execution
      }
      if (fresh.txHash || fresh.status === 'failed' || fresh.status === 'cancelled') {
        return fresh
      }
      await sleep(backoffMs(attempt))
    }
    return execution
  }

  async executeTransfer(
    req: {
      chainId: number
      recipientAddress: Address
      /** Amount in human units, e.g. "0.1". */
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

  /** Status of a direct execution. */
  async getDirectExecution(executionId: string): Promise<Execution> {
    const raw = await this.request<unknown>(
      'GET',
      `/api/execute/${encodeURIComponent(executionId)}/status`,
    )
    return normalizeExecution(raw, executionId)
  }

  // ── Workflow executions ───────────────────────────────────────────────────

  async getWorkflowExecution(executionId: string): Promise<Execution> {
    const raw = await this.request<unknown>(
      'GET',
      `/api/workflows/executions/${encodeURIComponent(executionId)}/status`,
    )
    return normalizeExecution(raw, executionId)
  }

  /**
   * Waits for the terminal state server-side. Preferable to a polling loop: a
   * single call, and no rate limit burned for nothing.
   *
   * `timeoutMs` is capped at 60 s by the API.
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
   * Follows an execution through to termination, whatever its type.
   *
   * Decides nothing: it returns the record so that the Settler can go and read
   * the chain.
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
          `KeeperHub: execution ${executionId} still ${exec.status} after ${timeoutMs} ms`,
        )
      }
      await sleep(intervalMs)
    }
  }

  // ── Wallet and budget ─────────────────────────────────────────────────────

  /** Turnkey wallet of the active organisation. Balances live elsewhere. */
  async getWallet(): Promise<WalletInfo> {
    return this.request('GET', '/api/user/wallet')
  }

  async getWalletBalances(): Promise<unknown> {
    return this.request('GET', '/api/user/wallet/balances')
  }

  /**
   * The organisation's daily spend cap, in wei.
   *
   * Worth watching before a volume runner: going over makes executions fail with
   * a 403, and the counter only resets at midnight UTC.
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
    functionName: req.functionName,
    // JSON string, not array: an API constraint, verified live.
    functionArgs: JSON.stringify(
      req.functionArgs.map((a) => (typeof a === 'bigint' ? a.toString() : a)),
    ),
    // Same convention, same trap: a JSON string. Omitted when the caller does not
    // supply one, so auto-resolution can do its job on a verified contract.
    ...(req.abi ? { abi: JSON.stringify(req.abi) } : {}),
    value: req.value ?? '0',
    ...(req.gasLimitMultiplier ? { gasLimitMultiplier: req.gasLimitMultiplier } : {}),
  }
}

function isTerminal(status: ExecutionStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'cancelled'
}

/**
 * Normalises an execution record.
 *
 * The two families of routes do not share a vocabulary: direct execution says
 * `completed`/`failed` and `transactionHash`, the workflow says `success`/`error`
 * and `transactionHashes[]`. We bring everything back to a single shape.
 */
export function normalizeExecution(raw: unknown, fallbackId = ''): Execution {
  const r = (raw ?? {}) as Record<string, unknown>
  // Direct execution nests the essentials under `result`.
  const result = (r['result'] ?? {}) as Record<string, unknown>
  const call = (result['executedCall'] ?? {}) as Record<string, unknown>

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

  const single =
    pickString(r, ['transactionHash', 'txHash', 'hash']) ??
    pickString(result, ['transactionHash', 'txHash'])
  if (single && !transactions.some((t) => t.hash.toLowerCase() === single.toLowerCase())) {
    transactions.push({ hash: single as Hex })
  }

  const gasUsedWei = pickBigInt(r, ['gasUsedWei']) ?? pickBigInt(result, ['gasUsed'])
  const gasPriceWei =
    pickBigInt(r, ['gasPriceWei']) ?? pickBigInt(result, ['effectiveGasPrice'])
  const errorText = pickString(r, ['error', 'errorMessage'])
  const completedAt = pickString(r, ['completedAt', 'completed_at', 'timestamp'])
  const retryCount = pickBigInt(r, ['retryCount', 'retries'])
  // `network` is a string in the direct-execution response.
  const chainId = pickBigInt(r, ['network', 'chainId'])
  const sponsored =
    pickBool(result, ['sponsored']) ?? pickBool(call, ['sponsored'])

  const executedCall: ExecutedCall = {
    ...(pickString(call, ['contractAddress'])
      ? { contractAddress: pickString(call, ['contractAddress']) as Address }
      : {}),
    ...(pickString(call, ['functionName'])
      ? { functionName: pickString(call, ['functionName'])! }
      : {}),
    ...(pickString(call, ['functionSignature'])
      ? { functionSignature: pickString(call, ['functionSignature'])! }
      : {}),
    ...(call['args'] && typeof call['args'] === 'object'
      ? { args: call['args'] as Record<string, unknown> }
      : {}),
    ...(pickBool(call, ['reverted']) !== undefined
      ? { reverted: pickBool(call, ['reverted'])! }
      : {}),
    ...(pickBool(call, ['sponsored']) !== undefined
      ? { sponsored: pickBool(call, ['sponsored'])! }
      : {}),
    ...(pickString(call, ['topLevelTo'])
      ? { topLevelTo: pickString(call, ['topLevelTo']) as Address }
      : {}),
  }

  // `result.success === false` signals an execution that was indeed submitted but
  // whose call reverted. That is an execution failure, not a non-compliance.
  const innerSuccess = pickBool(result, ['success'])
  const rawStatus = normalizeStatus(pickString(r, ['status', 'state']))
  const status: ExecutionStatus =
    rawStatus === 'success' && innerSuccess === false ? 'failed' : rawStatus

  return {
    executionId: pickString(r, ['executionId', 'id']) ?? fallbackId,
    status,
    ...(transactions[0] ? { txHash: transactions[0].hash } : {}),
    transactions,
    ...(gasUsedWei !== undefined ? { gasUsedWei } : {}),
    ...(gasPriceWei !== undefined ? { gasPriceWei } : {}),
    ...(pickString(r, ['type']) ? { type: pickString(r, ['type'])! } : {}),
    ...(chainId !== undefined ? { chainId: Number(chainId) } : {}),
    ...(retryCount !== undefined ? { retryCount: Number(retryCount) } : {}),
    ...(sponsored !== undefined ? { sponsored } : {}),
    ...(Object.keys(executedCall).length > 0 ? { executedCall } : {}),
    ...(pickString(r, ['transactionLink']) ?? pickString(result, ['transactionLink'])
      ? {
          transactionLink: (pickString(r, ['transactionLink']) ??
            pickString(result, ['transactionLink']))!,
        }
      : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(completedAt ? { completedAt } : {}),
    raw,
  }
}

function pickBool(o: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    if (typeof o[k] === 'boolean') return o[k] as boolean
  }
  return undefined
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

/** `execRef` ties a verdict to the KeeperHub execution and to the transaction. */
export function execRefInput(executionId: string, txHash: Hex): string {
  return `${executionId}${txHash}`
}
