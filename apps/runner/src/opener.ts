/**
 * Opening a warrant — by **reusing** `bin/open-warrant.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Why a subprocess and not an `import`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `open-warrant.ts` already works: it signs the EIP-3009 authorization with the
 * nonce constrained to `termsHash(...)`, reads the EIP-712 domain `name` onchain
 * rather than assuming it, goes through `keeperHubEscrow` — hence through the
 * real opener — and writes the ledger line the Settler is waiting for. Rewriting
 * all of that inside the runner would only produce a second implementation to
 * maintain, and the first divergence would be paid for in bonds.
 *
 * Importing it is not possible: it is a script, its `main()` runs on load and it
 * reads `process.argv`. A dynamic `import()` would run it only once — the ESM
 * module cache does not replay — hence a single warrant per process. Making it
 * importable would mean writing inside `packages/`, which the scope forbids and
 * which would be the wrong split anyway: the operations tool is perfectly fine
 * as it stands.
 *
 * The subprocess is therefore not a stopgap; it brings three things an in-line
 * call would not have:
 *
 *   • **fault isolation.** An uncaught `throw`, a memory leak, a
 *     `process.exit(1)`: the runner observes it as an exit code and carries on.
 *     In-process, the same thing would kill the campaign.
 *   • **an enforceable guard timeout.** `executeContractCall` blocks on the API
 *     side; a call that never returns would block a worker indefinitely. A
 *     subprocess can be killed.
 *   • **structured logging for free.** `open-warrant.ts` already emits one JSON
 *     line per step. The runner reads them off `stdout` and needs no return
 *     value at all.
 *
 * The price we accept: ≈ 300 ms of Node startup and one ledger re-read per
 * warrant, negligible against the ≈ 46 s KeeperHub takes to answer.
 */

import { spawn } from 'node:child_process'
import type { Hex } from '@warrant/core'
import type { Action, Scenario } from './ledger.js'

export interface OpenerConfig {
  /** Monorepo root. The child's `cwd`, so it finds `.env` and `tsx`. */
  repoRoot: string
  /** Path to `open-warrant.ts`. Explicit: it cannot be guessed. */
  script: string
  bond: bigint
  /**
   * Amount transferred by the action, in atomic units.
   *
   * **1 unit, i.e. 0.000001 USDC**, and that is not timidity. This amount leaves
   * the KeeperHub execution wallet on every warrant, and never comes back: the
   * post-condition requires the *committed* destination to be credited. At 1 USDC
   * per warrant — `open-warrant.ts`'s default — the execution wallet would be
   * drained on the very first warrant (it holds 0 USDC) and `open-warrant.ts`
   * would attempt a `mint()` that does not exist on Circle's USDC: revert, and
   * nothing opened. At 1 unit, 150 warrants cost 0.00015 USDC of inventory. The
   * amount changes nothing about the demonstration: what is being proven is that
   * the post-condition tells the right destination from the wrong one, not the
   * size of the transfer.
   */
  amount: bigint
  /**
   * Warrant duration, in seconds. `MIN_DURATION` is 900: we stick to it.
   *
   * A long duration improves nothing and costs: it widens the window during
   * which a bond stays locked up if the Settler goes down, so it reduces the
   * volume reachable at constant capital. The Settler settles in ≈ 30 s; 900 s
   * leave thirty times the margin.
   */
  duration: number
  /**
   * Call shape opened for this campaign — `RUNNER_ACTION`.
   *
   * Campaign-level and not per-warrant on purpose: the planner reasons about
   * honored/diverted quotas and knows nothing of call shapes, so threading a
   * second dimension through it would buy a mix that two successive campaigns
   * already give, at the cost of coupling the budget to something that does not
   * affect it — an `approve` and a `transfer` cost the same bond.
   */
  action: Action
  /** The **committed** destination, the one on the policy's allowlist. */
  allowedDest: string
  /** The destination actually served in the diverted scenario. */
  divertedDest: string
  /** Guard timeout. Past it, the child is killed. */
  timeoutMs: number
}

export interface OpenerEvent {
  msg?: string
  [k: string]: unknown
}

export interface OpenOutcome {
  scenario: Scenario
  ok: boolean
  warrantId?: Hex
  openTx?: Hex
  openedAt?: number
  executionId?: string
  actionTx?: Hex
  /** Did the child write the ledger line? Decisive — see below. */
  journalWritten: boolean
  durationMs: number
  exitCode: number | null
  signal: string | null
  error?: string
  /** The last lines emitted, for diagnosis on failure only. */
  tail: OpenerEvent[]
}

/**
 * Opens a warrant and returns what the child managed to do.
 *
 * Does not throw on a failed opening: a runner that raises an exception per
 * missed warrant would stop at KeeperHub's first 429. Failure is a value.
 *
 * The case that really matters is the **partial** one: `openTx` present and
 * `journalWritten` false. The warrant then exists onchain, the bond has been
 * collected, and the Settler does not have the `ConditionSpec` to evaluate it —
 * it will refuse to judge and the bond will wait for `reclaim()` at expiry. That
 * is not a loss of principal, but it is capital frozen for 900 s and a warrant
 * that will count neither as honored nor as slashed. The caller must see it.
 */
export async function openWarrant(cfg: OpenerConfig, scenario: Scenario): Promise<OpenOutcome> {
  const started = Date.now()
  const args = [
    '--import',
    'tsx',
    cfg.script,
    '--scenario',
    scenario,
    '--action',
    cfg.action,
    '--bond',
    cfg.bond.toString(10),
    '--amount',
    cfg.amount.toString(10),
    '--duration',
    String(cfg.duration),
  ]

  const child = spawn(process.execPath, args, {
    cwd: cfg.repoRoot,
    env: {
      ...process.env,
      // These two are **not** in `.env` and have no business being there: they
      // describe the runner's staging, not the deployment. Passing them through
      // the child's environment avoids requiring an edit of `.env` to launch a
      // campaign. Node does not overwrite an already-defined variable when it
      // loads an environment file, so `process.loadEnvFile` on the child side
      // will not clobber them.
      DEMO_ALLOWED_DEST: cfg.allowedDest,
      DEMO_DIVERTED_DEST: cfg.divertedDest,
      // The opening must go through the KeeperHub wallet, otherwise `open()`
      // reverts with `NotOpener()` — and above all the gas would no longer be
      // sponsored, which would move the volume bound from USDC to the agent's
      // ETH, of which it has 0.00019.
      WARRANT_ESCROW_PORT: 'keeperhub',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const events: OpenerEvent[] = []
  const out = { warrantId: undefined as Hex | undefined, openTx: undefined as Hex | undefined }
  let openedAt: number | undefined
  let executionId: string | undefined
  let actionTx: Hex | undefined
  let journalWritten = false
  let stderr = ''

  // Split on `\n` and never on a chunk: a child's `stdout` arrives fragmented,
  // and a `JSON.parse` on half a line would lose the most important event — the
  // one carrying `openTx`.
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (line === '') continue
      let ev: OpenerEvent
      try {
        ev = JSON.parse(line) as OpenerEvent
      } catch {
        events.push({ msg: 'non-JSON line', raw: line.slice(0, 300) })
        continue
      }
      events.push(ev)
      // `open-warrant.ts` lives in `packages/server`: its `msg` vocabulary is an
      // inter-process contract here, not prose, and this switch has to keep
      // matching whatever the child actually prints — nothing in the type system
      // relates the two, so a divergence is silent. It has one now-verified
      // shape: `open-warrant.ts` emits English, and the French spellings this
      // switch used to accept during the translation pass have been dropped with
      // it, in the same change. Whoever renames one of these four events must
      // rename it here in the same commit; a matcher that stops recognising
      // `ledger line written` reports every opening as partial
      // (`journalWritten: false`), and every warrant then looks like a bond stuck
      // waiting for `reclaim()` — 900 s of frozen capital apiece, and no test
      // fails.
      switch (ev['msg']) {
        case 'warrant prepared':
          out.warrantId = ev['warrantId'] as Hex
          break
        case 'warrant opened':
          out.openTx = ev['openTx'] as Hex
          openedAt = Number(ev['openedAt'])
          break
        case 'action executed':
          executionId = ev['executionId'] as string
          actionTx = ev['txHash'] as Hex | undefined
          break
        case 'ledger line written':
          journalWritten = true
          break
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const timer = setTimeout(() => {
    // SIGTERM first: `open-warrant.ts` installs no handler, so it is a clean
    // stop. `SIGKILL` as a last resort, after 5 s, for the case where the child
    // is stuck inside a system call.
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
  }, cfg.timeoutMs)

  const [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    child.once('error', (e) => resolve([null, `spawn: ${e.message}`]))
    child.once('close', (code, sig) => resolve([code, sig]))
  })
  clearTimeout(timer)

  const ok = exitCode === 0 && journalWritten && !!out.openTx
  return {
    scenario,
    ok,
    ...(out.warrantId ? { warrantId: out.warrantId } : {}),
    ...(out.openTx ? { openTx: out.openTx } : {}),
    ...(openedAt !== undefined ? { openedAt } : {}),
    ...(executionId ? { executionId } : {}),
    ...(actionTx ? { actionTx } : {}),
    journalWritten,
    durationMs: Date.now() - started,
    exitCode,
    signal,
    ...(ok
      ? {}
      : {
          error:
            stderr.trim().split('\n').slice(-3).join(' | ') ||
            (signal ? `killed by ${signal}` : `exit code ${exitCode}`),
        }),
    // The trace is only surfaced on failure: in steady state, 150 warrants ×
    // 7 events would drown the runner's own log.
    tail: ok ? [] : events.slice(-6),
  }
}

/**
 * Token bucket — respecting KeeperHub's rate, in one class.
 *
 * Why a bucket rather than a plain fixed delay between launches: a warrant's cost
 * in requests is not constant (5 nominally, up to 11 if `resolveTransaction`
 * exhausts its attempts), and the Settler eats into the same quota in parallel
 * without coordinating. A fixed delay calibrated on the nominal case would blow
 * past the limit as soon as one warrant retried; calibrated on the worst case, it
 * would waste half the throughput. The bucket reserves only what is needed and
 * lets the rate climb back as soon as the load drops.
 *
 * Refill is **continuous, not windowed**: a 60 req/min limit applied over a
 * sliding window allows 60 requests inside one second, and that burst is exactly
 * what triggers the 429.
 */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    /** Capacity, in requests. Equal to the per-minute rate: one minute of reserve. */
    readonly capacity: number,
    /** Refill rate, in requests per minute. */
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity
    this.last = now()
  }

  private refill(): void {
    const t = this.now()
    const gained = ((t - this.last) / 60_000) * this.perMinute
    if (gained <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + gained)
    this.last = t
  }

  /** Tokens available, rounded down. Diagnostic. */
  available(): number {
    this.refill()
    return Math.floor(this.tokens)
  }

  /** Waits until `cost` tokens are available, then consumes them. */
  async take(cost: number): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= cost) {
        this.tokens -= cost
        return
      }
      const missing = cost - this.tokens
      const waitMs = Math.max(50, Math.ceil((missing / this.perMinute) * 60_000))
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}
