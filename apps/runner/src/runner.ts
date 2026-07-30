/**
 * The volume runner.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * What it is, and what it is not
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The hackathon's most heavily weighted criterion is "does it execute onchain via
 * KeeperHub". A correct protocol with a single warrant does not satisfy it. This
 * process exists to turn a one-off demonstration into volume: it opens warrants
 * continuously, mixes the honored and diverted scenarios, and stops cleanly when
 * a named budget is reached.
 *
 * It is **not** a service, and it reimplements nothing: the opening is delegated
 * to `packages/server/src/bin/open-warrant.ts` (see `opener.ts` for the
 * subprocess argument), the settlement to the `packages/server/src/bin/settler.ts`
 * daemon, the persistence to the JSONL ledger. The runner adds only three things:
 * a plan, a budget, and a counter.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * The observation that makes the target reachable
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * **Capital recycles.** An honored warrant returns `bond − fee` to the agent: at
 * `feeBps = 250` and `bond = 0.2 USDC`, a cycle costs 0.005 USDC. So the agent's
 * 2 USDC fund ≈ 240 honored cycles, not 10 warrants. What bounds the volume is
 * not the capital, it is the throughput — and since the opening is sponsored by
 * KeeperHub (opening tx emitted by the relayer `0x6331eb45…` via the forwarder
 * `0x5aF5194B…`), it is not the gas either, except the settlement's.
 *
 * **A slash, on the other hand, destroys capital.** The bond goes to the
 * beneficiary and never comes back. It is the only line item that consumes
 * principal, and that is why it has a cap of its own. See `budget.ts` for the
 * measured figures and the full throughput computation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Environment variables — to add to `.env`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * None is mandatory: the defaults are calibrated on the real balances of
 * 2026-07-30 after the faucet (agent 2.165 USDC / 0.000385 ETH, Settler
 * 0.000365 ETH). Otherwise the runner reuses exactly the Gateway's and the
 * Settler's variables.
 *
 *   RUNNER_CAMPAIGN=hackathon           label isolating budgets between series
 *   RUNNER_TARGET=150                   warrants targeted
 *   RUNNER_SLASH_TARGET=3               slashes targeted (the criterion asks ≥ 3)
 *   RUNNER_CONCURRENCY=3                simultaneous openings
 *   RUNNER_BACKLOG_CAP=6                at most this many warrants open at once
 *   RUNNER_BOND=200000                  bond, atomic units
 *   RUNNER_AMOUNT=1                     amount transferred by the action
 *   RUNNER_DURATION=900                 warrant duration, seconds (= MIN_DURATION)
 *   RUNNER_SLASH_PRINCIPAL_BUDGET=800000  principal the slashes may destroy
 *   RUNNER_FEE_BUDGET=1000000           cumulative fees allowed on the honored ones
 *   RUNNER_AGENT_RESERVE=50000          untouchable USDC on the agent
 *   RUNNER_GAS_FLOOR_WEI=20000000000000 floor on the Settler's balance (0.00002 ETH)
 *   RUNNER_GAS_SPEND_WEI=150000000000000  gas this process may consume
 *   RUNNER_KH_REQ_PER_MIN=60            KeeperHub rate we keep
 *   RUNNER_KH_REQ_PER_MANDATE=11        cost in requests, worst case
 *   RUNNER_MAX_RUNTIME_MS=5400000       90 min
 *   RUNNER_DRAIN_MS=420000              drain wait after the last open
 *   RUNNER_COUNTERS_FILE=.warrant/counters.json
 *   RUNNER_ALLOWED_DEST=0x…dEaD         committed destination
 *   RUNNER_DIVERTED_DEST=0x…DeaDBeef    destination served in the diversion
 *   RUNNER_SETTLER=auto                 auto | 1 | 0 — supervise the Settler
 *   RUNNER_OPEN_TIMEOUT_MS=180000       guard timeout on one opening
 *   RUNNER_RECLAIM_INTERVAL_MS=60000    period of the expired-bond sweep
 *   RUNNER_AGENT_GAS_FLOOR_WEI=5000000000000  floor on the agent's ETH, below
 *                                       which the reclaim() sweep suspends itself
 *                                       — one reclaim costs ≈ 380e9 wei, measured
 *   RUNNER_POLL_MS=5000                 period of the onchain snapshot
 *   RUNNER_SETTLER_INTERVAL_MS=8000     SETTLER_INTERVAL_MS forced on the child
 *
 * And two corrections the runner forces on the Settler it supervises, because
 * their defaults are wrong on Base Sepolia:
 *
 *   SETTLER_LOG_CHUNK        the environment's own if it is set, clamped to
 *                            2001 — `sepolia.base.org` refuses any eth_getLogs
 *                            whose `toBlock − fromBlock` exceeds 2000. The
 *                            default of 9000 in `bin/settler.ts` makes **every**
 *                            chunk fail, so the Settler discovers no warrant at
 *                            all and the backlog would never drain.
 *   SETTLER_FROM_BLOCK=…     derived from the oldest still-open warrant. The
 *                            default scans 60,000 blocks, i.e. 30 chunks of
 *                            requests on every loop pass to discover nothing
 *                            more.
 *
 * The runner also reads `ERC8004_BATCH_SIZE` without modifying it: it changes no
 * decision, but it amortises the honored warrants' ERC-8004 registration gas
 * within the announced bound (see `budget.ts` § 1).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { WarrantStatus, type Address, type Hex } from '@warrant/core'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createWalletClient, http, type PublicClient } from 'viem'
import {
  ERC20_READ_ABI,
  RECLAIM_ABI,
  VOLUME_ALLOWED_CHAIN_IDS,
  chainOf,
  publicClientFor,
  readEscrowRoles,
  readWarrants,
  usdcBalance,
  type OnchainWarrant,
} from './chain.js'
import {
  GAS_FEEDBACK_WEI,
  GAS_HONOR_WEI,
  GAS_SLASH_WEI,
  decide,
  volumeBound,
  type BudgetCaps,
  type BudgetState,
  type StopCap,
} from './budget.js'
import { address, bigint, eth, flag, integer, optional, required, usdc } from './env.js'
import { TokenBucket, openWarrant, type OpenerConfig } from './opener.js'
import { computeCounters, openLedger, tally, type Ledger, type Scenario } from './ledger.js'

/**
 * Measured rates, named once — scattering them as literals through the
 * computations guarantees that a re-measurement only fixes half of them.
 *
 * `MANDATES_PER_MINUTE_PER_WORKER`: 60,000 / 17,384 ms, the average of the 8
 * warrants of the "bound" campaign. `SETTLER_MANDATES_PER_MINUTE`: the drain rate
 * of a single key, see `budget.ts` § 2 (c).
 */
const MANDATES_PER_MINUTE_PER_WORKER = 3.45
const SETTLER_MANDATES_PER_MINUTE = 6

/** Structured log, one JSON line per event. Never a secret. */
export function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Is there already a Settler alive?
 *
 * We probe the verdict server's port, which `bin/settler.ts` opens
 * unconditionally at startup. It is not a formal proof — another process could be
 * holding that port — but it is the only local and cheap clue, and the mistake it
 * avoids is serious: two Settlers on the same key would sign with the same nonce,
 * and one of the two would see its settlements rejected as
 * `replacement transaction underpriced`. So doubt leads to **not** launching a
 * second one.
 */
function settlerListening(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolveP) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (answer: boolean) => {
      socket.destroy()
      resolveP(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export interface RunnerConfig {
  campaign: string
  repoRoot: string
  chainId: number
  escrowRpc: string
  escrow: Address
  token: Address
  agent: Address
  /**
   * The agent's account. Used only for `reclaim()` — the opening signs the
   * EIP-3009 authorization inside the subprocess, with its own copy of the key
   * read from the environment. The runner never logs this object.
   */
  agentAccount: PrivateKeyAccount
  /** ETH floor below which the runner stops reclaiming. */
  agentGasFloorWei: bigint
  settlerKeyAddress: Address
  journalFile: string
  countersFile: string
  caps: BudgetCaps
  opener: OpenerConfig
  concurrency: number
  pollMs: number
  drainMs: number
  khReqPerMin: number
  khReqPerMandate: number
  settlerMode: 'auto' | 'on' | 'off'
  settlerPort: number
  settlerIntervalMs: number
}

export function loadConfig(): RunnerConfig {
  const repoRoot = resolve(
    optional('RUNNER_REPO_ROOT', new URL('../../../', import.meta.url).pathname),
  )
  const chainId = integer('WARRANT_ESCROW_CHAIN_ID', 84532)
  const chain = chainOf(chainId)
  const bond = bigint('RUNNER_BOND', bigint('WARRANT_MIN_BOND', 200_000n))
  const agentAccount = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as Hex)

  return {
    campaign: optional('RUNNER_CAMPAIGN', 'hackathon'),
    repoRoot,
    chainId,
    escrowRpc: optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0]),
    escrow: address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS')),
    token: address('WARRANT_ASSET', required('WARRANT_ASSET')),
    agent: agentAccount.address.toLowerCase() as Address,
    agentAccount,
    agentGasFloorWei: bigint('RUNNER_AGENT_GAS_FLOOR_WEI', 5_000_000_000_000n),
    settlerKeyAddress: privateKeyToAccount(
      required('SETTLER_PRIVATE_KEY') as Hex,
    ).address.toLowerCase() as Address,
    journalFile: optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl'),
    countersFile: optional('RUNNER_COUNTERS_FILE', '.warrant/counters.json'),
    caps: {
      slashPrincipal: bigint('RUNNER_SLASH_PRINCIPAL_BUDGET', 800_000n),
      fees: bigint('RUNNER_FEE_BUDGET', 1_000_000n),
      gasFloorWei: bigint('RUNNER_GAS_FLOOR_WEI', 20_000_000_000_000n),
      gasSpendWei: bigint('RUNNER_GAS_SPEND_WEI', 150_000_000_000_000n),
      agentReserve: bigint('RUNNER_AGENT_RESERVE', 50_000n),
      target: integer('RUNNER_TARGET', 150),
      slashTarget: integer('RUNNER_SLASH_TARGET', 3),
      maxRuntimeMs: integer('RUNNER_MAX_RUNTIME_MS', 90 * 60 * 1000),
      backlogCap: integer('RUNNER_BACKLOG_CAP', 6),
      // Read and not assumed: it is the variable the Settler will read too, and it
      // amortises the honored warrants' ERC-8004 registration gas. The default is
      // `bin/settler.ts`'s own.
      erc8004BatchSize: integer('ERC8004_BATCH_SIZE', 25),
    },
    opener: {
      repoRoot,
      script: resolve(repoRoot, 'packages/server/src/bin/open-warrant.ts'),
      bond,
      amount: bigint('RUNNER_AMOUNT', 1n),
      duration: integer('RUNNER_DURATION', 900),
      allowedDest: optional('RUNNER_ALLOWED_DEST', '0x000000000000000000000000000000000000dEaD'),
      divertedDest: optional('RUNNER_DIVERTED_DEST', '0x00000000000000000000000000000000DeaDBeef'),
      timeoutMs: integer('RUNNER_OPEN_TIMEOUT_MS', 180_000),
    },
    concurrency: integer('RUNNER_CONCURRENCY', 3),
    pollMs: integer('RUNNER_POLL_MS', 5_000),
    drainMs: integer('RUNNER_DRAIN_MS', 7 * 60 * 1000),
    khReqPerMin: integer('RUNNER_KH_REQ_PER_MIN', 60),
    khReqPerMandate: integer('RUNNER_KH_REQ_PER_MANDATE', 11),
    settlerMode: (() => {
      const raw = optional('RUNNER_SETTLER', 'auto').toLowerCase()
      if (raw === 'auto') return 'auto'
      return /^(1|true|yes|on)$/.test(raw) ? 'on' : 'off'
    })(),
    settlerPort: integer('SETTLER_PORT', 8403),
    settlerIntervalMs: integer('RUNNER_SETTLER_INTERVAL_MS', 8_000),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What makes startup fail, and why.
 *
 * A misconfigured volume runner does not crash: it spends. Each of these checks
 * corresponds to a failure mode that, without it, would only be discovered after
 * N openings — that is, N bonds.
 */
export async function preflight(
  cfg: RunnerConfig,
  client: PublicClient,
  /**
   * The warrants already known to the ledger. They serve exactly one purpose
   * here, and it is decisive: telling "the agent is dry" apart from "the agent's
   * capital is in flight". See the capital check's fix below.
   */
  journalIds: readonly Hex[] = [],
): Promise<{
  feeBps: number
  agentUsdc: bigint
  settlerWei: bigint
  executor: Address
  inherited: { open: number; recoverable: bigint }
}> {
  // Chain. First, because getting the chain wrong is the only irreversible
  // mistake on this list.
  const observed = await client.getChainId()
  if (observed !== cfg.chainId) {
    throw new Error(
      `RPC ${cfg.escrowRpc} answers chainId ${observed}, WARRANT_ESCROW_CHAIN_ID announces ` +
        `${cfg.chainId}: the campaign would go out on the wrong chain`,
    )
  }
  if (!VOLUME_ALLOWED_CHAIN_IDS.has(cfg.chainId)) {
    throw new Error(
      `chain ${cfg.chainId} refused: a volume runner only opens hundreds of warrants ` +
        'without human confirmation on a testnet. Allowed chains: ' +
        `${[...VOLUME_ALLOWED_CHAIN_IDS].join(', ')}`,
    )
  }

  const roles = await readEscrowRoles(client, cfg.escrow)

  // `settler()` onchain. Without it, `honor`/`slash` would revert with
  // `NotSettler()`: the runner would open 150 warrants none of which would settle,
  // and one would have to wait for 150 expiries to get the bonds back.
  if (roles.settler !== cfg.settlerKeyAddress) {
    throw new Error(
      `settler() onchain is ${roles.settler}, SETTLER_PRIVATE_KEY derives ` +
        `${cfg.settlerKeyAddress}: nothing would ever be settled`,
    )
  }
  // `opener()` must be the KeeperHub wallet, otherwise `open()` reverts with
  // `NotOpener()` — and were it a local key, the opening gas would stop being
  // sponsored, which would move the volume bound from USDC to the agent's ETH, of
  // which it has 0.00019.
  if (roles.token !== cfg.token) {
    throw new Error(
      `token() onchain is ${roles.token}, WARRANT_ASSET announces ${cfg.token}: ` +
        'the EIP-3009 authorization would be signed on the wrong token domain',
    )
  }

  const [agentUsdc, settlerWei, executorUsdc, assetName] = await Promise.all([
    usdcBalance(client, cfg.token, cfg.agent),
    client.getBalance({ address: cfg.settlerKeyAddress }),
    usdcBalance(client, cfg.token, roles.opener),
    client.readContract({ address: cfg.token, abi: ERC20_READ_ABI, functionName: 'name' }),
  ])

  /**
   * The capital in flight, read onchain, before refusing to start.
   *
   * ⚠ Same fix as § "fix nº 2" of `budget.ts`, applied here because the preflight
   * held the hard version of the same reasoning — and in a far worse place: it
   * **threw**. A runner killed mid-campaign leaves `backlogCap` bonds locked up;
   * restarted, it found a free balance below one bond and refused to start. But it
   * is the runner that launches the Settler, so nothing settled the warrants in
   * flight, so the capital never came back: the preflight made its own failure
   * condition permanent. The deadlock was complete and the error message — "top up
   * with pnpm faucet" — pointed at a faucet capped at 1 USDC / 24 h as the only way
   * out of a situation that resolved itself in thirty seconds.
   *
   * An insufficient balance remains blocking, but only when **nothing** is in
   * flight. Otherwise it is a warning, and the loop waits (`decide` returns
   * `wait`).
   */
  const inherited = await (async () => {
    if (journalIds.length === 0) return { open: 0, recoverable: 0n }
    const known = await readWarrants(client, cfg.escrow, journalIds)
    let open = 0
    let recoverable = 0n
    for (const w of known.values()) {
      if (w.status !== WarrantStatus.Open || w.agent !== cfg.agent) continue
      open += 1
      // Deliberate caution: we do not assume the verdict to come. `bond − fee` is
      // what an honored warrant returns, and it is the floor of what can come
      // back — a `reclaim` would return the whole `bond`, a slash would return
      // nothing. This field only serves to answer "yes, something is coming
      // back", and an underestimate errs on the right side.
      recoverable += w.bond - (w.bond * BigInt(w.feeBpsAtOpen)) / 10_000n
    }
    return { open, recoverable }
  })()

  if (agentUsdc < cfg.opener.bond + cfg.caps.agentReserve) {
    if (inherited.recoverable === 0n) {
      throw new Error(
        `agent ${cfg.agent} holds ${usdc(agentUsdc)} USDC: not enough for a bond of ` +
          `${usdc(cfg.opener.bond)} plus ${usdc(cfg.caps.agentReserve)} of reserve, and no ` +
          'warrant in flight can return capital. Top up with `pnpm faucet` ' +
          "(1 USDC / address / 24 h): that is volume's hard bound.",
      )
    }
    emit({
      msg: "runner: warning — the agent's capital is momentarily in flight",
      freeBalance: usdc(agentUsdc),
      required: usdc(cfg.opener.bond + cfg.caps.agentReserve),
      warrantsInFlight: inherited.open,
      recoverableCapital: usdc(inherited.recoverable),
      consequence:
        'the runner starts, launches the Settler and waits for the first settlement. ' +
        'Refusing to start here would block the only process able to return that capital.',
    })
  }
  if (settlerWei < cfg.caps.gasFloorWei) {
    throw new Error(
      `Settler ${cfg.settlerKeyAddress} holds ${eth(settlerWei)} ETH, below the floor of ` +
        `${eth(cfg.caps.gasFloorWei)}: no settlement would ever go out`,
    )
  }
  /**
   * The **execution wallet**'s USDC inventory, and this is the least obvious check
   * on the list.
   *
   * The post-condition requires the committed destination to be credited with
   * `amount`. That amount leaves the KeeperHub wallet, which held 0 USDC on
   * 2026-07-30. With no inventory, the `transfer` action reverts, the
   * post-condition fails, and **every** warrant — including those meant to be
   * honored — would be slashed. That is 0.2 USDC destroyed per warrant instead of
   * 0.005: the agent's capital would be gone in ten warrants, and the runner would
   * have dutifully respected every one of its budgets while producing the exact
   * opposite of what it was asked for.
   */
  if (executorUsdc < cfg.opener.amount) {
    throw new Error(
      `the KeeperHub execution wallet ${roles.opener} holds ${usdc(executorUsdc)} USDC, ` +
        `it needs at least ${usdc(cfg.opener.amount)} for the honored action to go through. ` +
        'With no inventory, the action reverts and EVERY warrant is slashed — 0.2 USDC ' +
        'destroyed per warrant. Transfer it an inventory from the agent before launching ' +
        'the campaign.',
    )
  }
  const affordableMandates = cfg.opener.amount === 0n ? Infinity : executorUsdc / cfg.opener.amount
  if (affordableMandates < BigInt(cfg.caps.target)) {
    emit({
      msg: "runner: warning — the execution wallet's inventory is tight",
      executor: roles.opener,
      inventory: usdc(executorUsdc),
      fundableWarrants: affordableMandates.toString(10),
      target: cfg.caps.target,
    })
  }
  if (cfg.opener.duration < 900) {
    throw new Error(
      `RUNNER_DURATION=${cfg.opener.duration} is below MIN_DURATION (900 s): ` +
        'open() would revert with BadDuration()',
    )
  }
  const minBond = bigint('WARRANT_MIN_BOND', 200_000n)
  const maxBond = bigint('WARRANT_MAX_BOND', 500_000n)
  if (cfg.opener.bond < minBond || cfg.opener.bond > maxBond) {
    throw new Error(
      `RUNNER_BOND=${cfg.opener.bond} outside [${minBond}, ${maxBond}]: the local policy ` +
        'would bring the bond back to its floor and the EIP-3009 nonce would no longer be ' +
        'termsHash(...) — open() would revert with TermsMismatch()',
    )
  }
  if (cfg.concurrency > cfg.caps.backlogCap) {
    throw new Error(
      `RUNNER_CONCURRENCY=${cfg.concurrency} exceeds RUNNER_BACKLOG_CAP=${cfg.caps.backlogCap}: ` +
        'the workers would open past the locked-up capital cap',
    )
  }

  emit({
    msg: 'runner: preflight',
    chainId: cfg.chainId,
    escrow: cfg.escrow,
    token: cfg.token,
    assetName,
    feeBps: roles.feeBps,
    opener: roles.opener,
    settler: roles.settler,
    treasury: roles.treasury,
    totalLocked: usdc(roles.totalLocked),
    agent: cfg.agent,
    agentUsdc: usdc(agentUsdc),
    settlerEth: eth(settlerWei),
    executorUsdc: usdc(executorUsdc),
    inheritedWarrantsInFlight: inherited.open,
    recoverableCapital: usdc(inherited.recoverable),
  })

  return { feeBps: roles.feeBps, agentUsdc, settlerWei, executor: roles.opener, inherited }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervising the Settler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launches the Settler if — and only if — there is not one already.
 *
 * The runner could leave that to the operator. It does not, because a runner
 * without a Settler is a trap: it opens at full rate, nothing settles, the capital
 * locks up, and the stop lands on `agent-capital-insufficient` — a true message
 * that names the wrong cause.
 *
 * `SETTLER_FROM_BLOCK` is computed rather than left to its default: `fromBlock` is
 * derived from the oldest **still-open** warrant, at 2 s per block on Base, with
 * 300 blocks of margin. The default of 60,000 blocks would cost 32 `eth_getLogs`
 * requests per loop pass — out of the quota shared with the opening — to discover
 * nothing more.
 */
async function superviseSettler(
  cfg: RunnerConfig,
  client: PublicClient,
  oldestOpenAt: number | undefined,
): Promise<ChildProcess | undefined> {
  if (cfg.settlerMode === 'off') {
    emit({ msg: 'runner: settler not supervised', reason: 'RUNNER_SETTLER=0' })
    return undefined
  }
  if (cfg.settlerMode === 'auto' && (await settlerListening(cfg.settlerPort))) {
    emit({
      msg: 'runner: settler already alive',
      port: cfg.settlerPort,
      reason: 'a second Settler on the same key would produce a nonce conflict',
    })
    return undefined
  }

  const head = await client.getBlockNumber()
  const ageSeconds = oldestOpenAt ? Math.max(0, Math.floor(Date.now() / 1000) - oldestOpenAt) : 0
  const back = BigInt(Math.ceil(ageSeconds / 2) + 300)
  const fromBlock = head > back ? head - back : 0n

  /**
   * `SETTLER_LOG_CHUNK`: the operator's value if there is one, clamped.
   *
   * The runner used to force 1900 hard. That was safe but wrong in two ways: for
   * one it silently overrode the value from `.env` — an operator who fixes an RPC
   * cap and sees their setting ignored without a word searches for a long time;
   * for another, 1900 leaves 5% of the window on the table. Measured on
   * `sepolia.base.org`: the error is `query exceeds max block range 2000` and it
   * bears on `toBlock − fromBlock`, not on the number of blocks — a range of 2001
   * blocks goes through, 2002 does not. `viemEscrowReader` computes
   * `to = cursor + chunk − 1`, so `chunk = 2001` is the largest accepted value. We
   * clamp to that, and we say what we did.
   */
  const RPC_MAX_LOG_SPAN = 2001
  const requestedChunk = integer('SETTLER_LOG_CHUNK', RPC_MAX_LOG_SPAN)
  const logChunk = Math.max(1, Math.min(RPC_MAX_LOG_SPAN, requestedChunk))
  if (logChunk !== requestedChunk) {
    emit({
      msg: "runner: SETTLER_LOG_CHUNK clamped to the RPC's cap",
      requested: requestedChunk,
      applied: logChunk,
      reason:
        'sepolia.base.org refuses eth_getLogs beyond a 2000-block span; past that, ' +
        'EVERY chunk fails and the Settler discovers no warrant at all',
    })
  }

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(cfg.repoRoot, 'packages/server/src/bin/settler.ts')],
    {
      cwd: cfg.repoRoot,
      env: {
        ...process.env,
        // The default of 9000 makes *every* chunk fail on Base Sepolia's public
        // RPC, which refuses eth_getLogs beyond a 2000-block span. The Settler
        // degrades gracefully ("incomplete scan") and therefore discovers **no**
        // warrant at all: the backlog would never drain.
        SETTLER_LOG_CHUNK: String(logChunk),
        SETTLER_FROM_BLOCK: fromBlock.toString(10),
        SETTLER_INTERVAL_MS: String(cfg.settlerIntervalMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  // The Settler's lines are re-emitted with a prefix: a runner that swallows its
  // child's logs makes the one process that moves funds impossible to diagnose.
  const forward = (stream: NodeJS.ReadableStream, level: 'out' | 'err') => {
    let pending = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk: string) => {
      pending += chunk
      let nl: number
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).trim()
        pending = pending.slice(nl + 1)
        if (line !== '') console.log(`[settler:${level}] ${line}`)
      }
    })
  }
  forward(child.stdout!, 'out')
  forward(child.stderr!, 'err')
  child.once('exit', (code, signal) =>
    emit({ msg: 'runner: settler exited', code, signal }),
  )

  emit({
    msg: 'runner: settler launched',
    pid: child.pid,
    fromBlock: fromBlock.toString(10),
    logChunk,
    intervalMs: cfg.settlerIntervalMs,
  })
  // Time enough for it to run its preflight — chain, role, archive probe, gas —
  // and open its verdict server. Opening a warrant before it is ready is harmless
  // (it will discover it on the next pass) but failing its preflight after 50
  // openings would not be.
  await sleep(6_000)
  if (child.exitCode !== null) {
    throw new Error(
      `the Settler stopped immediately (code ${child.exitCode}): ` +
        'its preflight failed. See the [settler:err] lines above.',
    )
  }
  return child
}

// ─────────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────────

/** The state shared between workers. One instance, one point of truth. */
interface Shared {
  ledger: Ledger
  client: PublicClient
  cfg: RunnerConfig
  feeBps: number
  startedAt: number
  settlerWeiAtStart: bigint
  /** Latest onchain snapshot, and the instant it was read. */
  snapshot: {
    at: number
    warrants: Map<string, OnchainWarrant>
    agentUsdc: bigint
    settlerWei: bigint
  }
  /** Openings under way, per scenario. Reserved before the spawn. */
  inFlight: { honored: number; diverted: number }
  /** True as soon as a cap has been reached. The workers exit. */
  stop?: { cap: StopCap; why: string }
  /** Serialises the decision: two workers do not reserve the same slash. */
  gate: Promise<void>
  /**
   * Serialises the tagging. A lock **distinct** from `gate`, and deliberately so:
   * tagging requires a read-then-write of the ledger, but has no need to block
   * opening decisions. Conflating them would make three workers wait through an
   * `appendFileSync`. With no lock at all, two workers finishing at the same time
   * would read the same `nextSeq()` and two warrants would carry rank 7 — a
   * duplicated rank falsifies no budget (they are all computed onchain) but it
   * makes the ledger unreadable to whoever audits it.
   */
  tagGate: Promise<void>
  bucket: TokenBucket
  /** Cumulative session counters — what the runner itself observed. */
  session: { opened: number; failed: number; orphans: number }
}

/**
 * Refreshes the onchain snapshot, at most once per `pollMs`.
 *
 * The cache is not cosmetic optimisation: with 3 workers each deciding before
 * every opening, reading systematically would mean 3 multicalls plus 6 balance
 * reads every 15 s, on the same public RPC the Settler uses for its archive
 * evaluations. Rationing it protects the component that decides the verdicts.
 */
async function refreshSnapshot(s: Shared, force = false): Promise<void> {
  if (!force && Date.now() - s.snapshot.at < s.cfg.pollMs) return
  s.ledger.refresh()
  const ids = s.ledger.all().map((r) => r.id.toLowerCase() as Hex)
  const [warrants, agentUsdc, settlerWei] = await Promise.all([
    readWarrants(s.client, s.cfg.escrow, ids),
    usdcBalance(s.client, s.cfg.token, s.cfg.agent),
    s.client.getBalance({ address: s.cfg.settlerKeyAddress }),
  ])
  s.snapshot = { at: Date.now(), warrants, agentUsdc, settlerWei }
}

/** Projects the snapshot and the ledger into the state `decide` expects. */
function budgetState(s: Shared): BudgetState {
  const campaign = s.ledger.campaign()
  const w = s.snapshot.warrants

  let slashed = 0
  let divertedPending = 0
  let destroyed = 0n
  let fees = 0n
  for (const record of campaign) {
    const onchain = w.get(record.id.toLowerCase())
    const status = onchain?.status ?? WarrantStatus.Open
    if (status === WarrantStatus.Slashed) {
      slashed += 1
      destroyed += onchain?.bond ?? s.cfg.opener.bond
    } else if (status === WarrantStatus.Honored && onchain) {
      fees += (onchain.bond * BigInt(onchain.feeBpsAtOpen)) / 10_000n
    }
    // A slash "in flight" is a warrant tagged `diverted` whose verdict has not
    // landed. Counting it is what avoids opening four to obtain three —
    // over-slashing costs 0.2 USDC apiece.
    if (record.runner.scenario === 'diverted' && status === WarrantStatus.Open) {
      divertedPending += 1
    }
  }

  // The backlog counts **every** open warrant, campaign or not: that is the
  // Settler's real load and the capital really locked up.
  const backlog = [...w.values()].filter((x) => x.status === WarrantStatus.Open).length

  /**
   * The capital the warrants in flight will return — the datum that turns a
   * permanent stop into a thirty-second wait (see `decide`, fix nº 2).
   *
   * Three regimes, and all three are needed: a warrant tagged `diverted` returns
   * **nothing** (its bond goes to the beneficiary), a warrant already expired
   * returns the **whole** `bond` (`reclaim` takes no fee, and the runner's sweeper
   * calls it), an honorable warrant returns `bond − fee`. Counting `bond − fee`
   * uniformly would overestimate the return of a campaign with a high proportion of
   * slashes, and the runner would wait for capital that is not coming back — that
   * is, it would replace a false stop with a false wait.
   *
   * Only **our** agent's warrants count: the backlog includes a third party's,
   * whose settlement returns us nothing.
   */
  const now = Math.floor(Date.now() / 1000)
  const scenarioOf = new Map(
    campaign.map((r) => [r.id.toLowerCase(), r.runner.scenario] as const),
  )
  let recoverable = 0n
  for (const x of w.values()) {
    if (x.status !== WarrantStatus.Open || x.agent !== s.cfg.agent) continue
    if (scenarioOf.get(x.id) === 'diverted') continue
    recoverable += x.expiry < now ? x.bond : x.bond - (x.bond * BigInt(x.feeBpsAtOpen)) / 10_000n
  }

  return {
    opened: campaign.length + s.inFlight.honored + s.inFlight.diverted,
    slashed,
    divertedInFlight: divertedPending + s.inFlight.diverted,
    destroyed,
    fees,
    backlog: backlog + s.inFlight.honored + s.inFlight.diverted,
    agentUsdc: s.snapshot.agentUsdc,
    recoverable,
    settlerWei: s.snapshot.settlerWei,
    settlerWeiAtStart: s.settlerWeiAtStart,
    elapsedMs: Date.now() - s.startedAt,
    bond: s.cfg.opener.bond,
    feeBps: s.feeBps,
  }
}

/**
 * Reserves an opening slot, under lock.
 *
 * The lock (`s.gate`) is not decorative: `decide` reads `divertedInFlight` to know
 * how many slashes are already acquired. Without serialisation, three workers
 * calling `decide` at the same instant would all read "0 slashes" and would open
 * three slashes to obtain one — 0.4 USDC destroyed by inadvertence, i.e. 20% of
 * the agent's capital.
 */
async function reserve(s: Shared): Promise<{ scenario: Scenario; why: string } | 'wait' | 'stop'> {
  let release!: () => void
  const previous = s.gate
  s.gate = new Promise<void>((r) => (release = r))
  await previous
  try {
    if (s.stop) return 'stop'
    await refreshSnapshot(s)
    const decision = decide(s.cfg.caps, budgetState(s))
    if (decision.kind === 'stop') {
      s.stop = { cap: decision.cap, why: decision.why }
      return 'stop'
    }
    if (decision.kind === 'wait') return 'wait'
    s.inFlight[decision.scenario] += 1
    return { scenario: decision.scenario, why: decision.why }
  } finally {
    release()
  }
}

/**
 * Sweeps the expired warrants and recovers their bond.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this sweep exists, and why it belongs to the runner
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The Settler abstains when it cannot judge: failed KeeperHub action,
 * `ConditionSpec` missing from the ledger, execution not found. It emits
 * `kind: 'let-expire'` and moves on — that is the right behaviour, doubt must
 * benefit the agent. But abstention refunds nothing by itself: `reclaim()` has to
 * be called, and **the Settler never calls it** (by design: it is not the judge's
 * job to refund). Nobody else does either.
 *
 * Without this sweep, every abandoned warrant freezes 0.2 USDC for good. On the
 * measured campaign, 8 warrants out of 15 saw their KeeperHub action fail at
 * concurrency 4: that is 1.6 USDC, i.e. **two thirds of the agent's capital**, and
 * 320 honored cycles lost. The sweep returns all of it — `reclaim` refunds `bond`
 * without taking a fee.
 *
 * It belongs to the runner and not to the Settler because it is an *agent
 * treasury* operation, not a settlement one: it goes out from the agent's key, it
 * renders no verdict, and it never touches the beneficiary.
 *
 * Sequential, and not up for negotiation: a single key, hence a single nonce. Two
 * `reclaim`s in parallel on the same key would produce a
 * `replacement transaction underpriced`.
 */
async function reclaimExpired(s: Shared): Promise<{ reclaimed: number; recovered: bigint }> {
  const now = Math.floor(Date.now() / 1000)
  const expired = [...s.snapshot.warrants.values()].filter(
    (w) =>
      w.status === WarrantStatus.Open &&
      w.expiry < now &&
      // Only **our** agent's bonds: `reclaim` is permissionless, but reclaiming for
      // a third party would spend our gas to refund somebody else.
      w.agent === s.cfg.agent,
  )
  if (expired.length === 0) return { reclaimed: 0, recovered: 0n }

  const gas = await s.client.getBalance({ address: s.cfg.agent })
  if (gas < s.cfg.agentGasFloorWei) {
    emit({
      msg: 'runner: reclaim sweep suspended',
      reason: `the agent is at ${eth(gas)} ETH, floor ${eth(s.cfg.agentGasFloorWei)}`,
      expired: expired.length,
      frozen: usdc(expired.reduce((acc, w) => acc + w.bond, 0n)),
    })
    return { reclaimed: 0, recovered: 0n }
  }

  const wallet = createWalletClient({
    account: s.cfg.agentAccount,
    chain: chainOf(s.cfg.chainId),
    transport: http(s.cfg.escrowRpc),
  })
  let reclaimed = 0
  let recovered = 0n
  for (const w of expired) {
    try {
      const tx = await wallet.writeContract({
        address: s.cfg.escrow,
        abi: RECLAIM_ABI,
        functionName: 'reclaim',
        args: [w.id],
      })
      await s.client.waitForTransactionReceipt({ hash: tx, confirmations: 1 })
      reclaimed += 1
      recovered += w.bond
      emit({
        msg: 'runner: bond recovered',
        warrantId: w.id,
        bond: usdc(w.bond),
        reclaimTx: tx,
      })
    } catch (e) {
      // `NotOpen()` means the Settler settled between the read and the send —
      // benign, and frequent. Any other error deserves to be seen.
      emit({
        msg: 'runner: reclaim failed',
        warrantId: w.id,
        error: e instanceof Error ? e.message.split('\n')[0] : String(e),
      })
    }
  }
  return { reclaimed, recovered }
}

/** Runs `body` under mutual exclusion on the ledger. See `Shared.tagGate`. */
async function withTagLock<T>(s: Shared, body: () => T): Promise<T> {
  let release!: () => void
  const previous = s.tagGate
  s.tagGate = new Promise<void>((r) => (release = r))
  await previous
  try {
    return body()
  } finally {
    release()
  }
}

async function worker(s: Shared, slot: number): Promise<void> {
  for (;;) {
    if (s.stop) return
    const slotDecision = await reserve(s)
    if (slotDecision === 'stop') return
    if (slotDecision === 'wait') {
      await sleep(s.cfg.pollMs)
      continue
    }

    // The KeeperHub rate is reserved **after** the decision and before the spawn:
    // reserving before the decision would tie up tokens for an opening the budget
    // may well refuse.
    await s.bucket.take(s.cfg.khReqPerMandate)

    const { scenario, why } = slotDecision
    emit({ msg: 'runner: opening', slot, scenario, reason: why, tokens: s.bucket.available() })
    let outcome
    try {
      outcome = await openWarrant(s.cfg.opener, scenario)
    } finally {
      s.inFlight[scenario] -= 1
    }

    if (outcome.ok && outcome.warrantId) {
      s.session.opened += 1
      const seq = await withTagLock(s, () => {
        const next = s.ledger.nextSeq()
        s.ledger.tag(outcome.warrantId!, {
          campaign: s.cfg.campaign,
          seq: next,
          scenario,
          taggedAt: Date.now(),
        })
        return next
      })
      emit({
        msg: 'runner: warrant opened',
        slot,
        seq,
        scenario,
        warrantId: outcome.warrantId,
        openTx: outcome.openTx,
        actionTx: outcome.actionTx,
        executionId: outcome.executionId,
        durationMs: outcome.durationMs,
      })
      await refreshSnapshot(s, true)
      await writeCounters(s)
      continue
    }

    // Failure. Two very different cases, and conflating them would be expensive.
    if (outcome.openTx && !outcome.journalWritten) {
      // Warrant opened onchain, bond collected, no ledger line: the Settler will
      // not know what to evaluate. This is not a loss of principal — `reclaim()`
      // will refund at expiry — but it is capital frozen for 900 s and a warrant
      // that will count neither as honored nor as slashed.
      s.session.orphans += 1
      emit({
        msg: 'runner: ORPHAN warrant — opened with no ledger line',
        slot,
        warrantId: outcome.warrantId,
        openTx: outcome.openTx,
        consequence:
          'the Settler will refuse to evaluate for lack of a ConditionSpec; the bond ' +
          'will be refunded by reclaim() at expiry',
        error: outcome.error,
        tail: outcome.tail,
      })
    } else {
      s.session.failed += 1
      emit({
        msg: 'runner: opening failed',
        slot,
        scenario,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        error: outcome.error,
        tail: outcome.tail,
      })
    }
    // A failure does not kill the campaign, but it must not loop at full rate: a
    // 429 or a KeeperHub outage would repeat identically.
    await sleep(Math.min(30_000, s.cfg.pollMs * 3))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public counter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes the public counter, and writes it **atomically**.
 *
 * A dashboard polling this file in a loop would otherwise end up reading truncated
 * JSON — `writeFileSync` is not atomic on an existing file. Writing beside it then
 * renaming is, on the same filesystem.
 */
export async function writeCounters(s: Shared): Promise<void> {
  const counters = await computeCounters({
    ledger: s.ledger,
    client: s.client,
    escrow: s.cfg.escrow,
    chainId: s.cfg.chainId,
    campaign: s.cfg.campaign,
  })
  const enriched = {
    ...counters,
    session: {
      ...s.session,
      startedAt: new Date(s.startedAt).toISOString(),
      elapsedSeconds: Math.round((Date.now() - s.startedAt) / 1000),
      agentUsdc: s.snapshot.agentUsdc.toString(10),
      agentUsdcDecimal: usdc(s.snapshot.agentUsdc),
      settlerWei: s.snapshot.settlerWei.toString(10),
      settlerEth: eth(s.snapshot.settlerWei),
      gasSpentWei: (s.settlerWeiAtStart > s.snapshot.settlerWei
        ? s.settlerWeiAtStart - s.snapshot.settlerWei
        : 0n
      ).toString(10),
    },
    caps: {
      target: s.cfg.caps.target,
      slashTarget: s.cfg.caps.slashTarget,
      slashPrincipal: s.cfg.caps.slashPrincipal.toString(10),
      fees: s.cfg.caps.fees.toString(10),
      backlogCap: s.cfg.caps.backlogCap,
      gasFloorWei: s.cfg.caps.gasFloorWei.toString(10),
    },
    ...(s.stop ? { stop: s.stop } : {}),
  }
  const path = resolve(s.cfg.repoRoot, s.cfg.countersFile)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(enriched, null, 2)}\n`, 'utf8')
  const { renameSync } = await import('node:fs')
  renameSync(tmp, path)
  emit({
    msg: 'runner: counter',
    campaign: counters.campaignTally,
    total: counters.total,
    file: path,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const cfg = loadConfig()
  const client = publicClientFor(cfg.chainId, cfg.escrowRpc)

  // The ledger is opened **before** the preflight, and that is not an incidental
  // detail of sequencing: the preflight needs to know what is already in flight so
  // as not to refuse to start over capital that is only waiting to come back. See
  // `preflight`'s capital check.
  const ledger = openLedger(resolve(cfg.repoRoot, cfg.journalFile), cfg.campaign)
  const journalIds = ledger.all().map((r) => r.id.toLowerCase() as Hex)
  const { feeBps, agentUsdc, settlerWei } = await preflight(cfg, client, journalIds)

  // The resumption. Nothing to rebuild: the ledger already carries the campaign
  // tags, hence the rank, hence the number of slashes already caused. The runner
  // resumes at the next rank without reopening anything.
  const resumed = ledger.campaign()

  /**
   * The campaign's already-acquired state, read **onchain**, so that the announced
   * bound is the one of what is left to do and not the one of a fresh campaign. The
   * ledger gives the list of warrants, the chain gives their fate: the same
   * division of labour as everywhere else in this file.
   */
  const acquired = await (async () => {
    if (resumed.length === 0) return { opened: 0, slashed: 0, destroyed: 0n, fees: 0n }
    const onchain = await readWarrants(
      client,
      cfg.escrow,
      resumed.map((r) => r.id.toLowerCase() as Hex),
    )
    const t = tally(onchain.values())
    return { opened: resumed.length, slashed: t.slashed, destroyed: BigInt(t.destroyed), fees: BigInt(t.fees) }
  })()

  const bound = volumeBound(cfg.caps, {
    agentUsdc,
    bond: cfg.opener.bond,
    feeBps,
    settlerWei,
    ...acquired,
  })
  emit({
    msg: 'runner: startup',
    campaign: cfg.campaign,
    resumedFrom: resumed.length,
    nextSeq: ledger.nextSeq(),
    target: cfg.caps.target,
    slashTarget: cfg.caps.slashTarget,
    concurrency: cfg.concurrency,
    backlogCap: cfg.caps.backlogCap,
    bond: usdc(cfg.opener.bond),
    actionAmount: usdc(cfg.opener.amount),
    duration: cfg.opener.duration,
    acquired: {
      opened: acquired.opened,
      slashed: acquired.slashed,
      principalDestroyed: usdc(acquired.destroyed),
      feesPaid: usdc(acquired.fees),
    },
    // The real bound, announced before opening anything at all — and bounded by all
    // four constraints at once, `binding` naming the one that bites.
    bound: {
      warrantsStillFundable: bound.total,
      ofWhichSlashes: bound.slashes,
      ofWhichHonored: bound.honored,
      binding: bound.binding,
      gasUsableEth: eth(bound.gasUsableWei),
      settlementsFundableByGas: bound.settlementsPerGas,
      // 3.45 warrants/min per worker, the average of the 8 openings of the "bound"
      // campaign (17,384 ms per warrant) and not the 3.7 derived from "smoke"'s two
      // warrants — two measurements do not make an average. Capped by the Settler's
      // throughput: a single key, one settlement at a time, ≈ 6/min. Announcing
      // 3.45 × C would be announcing an opening rate the draining does not keep up
      // with — the backlog absorbs the difference up to its cap, then the runner
      // waits.
      openingRatePerMinute: Number((MANDATES_PER_MINUTE_PER_WORKER * cfg.concurrency).toFixed(1)),
      sustainedRatePerMinute: Math.min(
        SETTLER_MANDATES_PER_MINUTE,
        Number((MANDATES_PER_MINUTE_PER_WORKER * cfg.concurrency).toFixed(1)),
      ),
      minutesToExhaustTheBound: Math.ceil(
        bound.total /
          Math.min(
            SETTLER_MANDATES_PER_MINUTE,
            Math.max(0.1, MANDATES_PER_MINUTE_PER_WORKER * cfg.concurrency),
          ),
      ),
    },
  })

  const oldestOpen = (() => {
    const times = resumed.map((r) => r.openedAt).filter((t): t is number => typeof t === 'number')
    return times.length === 0 ? undefined : Math.min(...times)
  })()
  const settlerChild = await superviseSettler(cfg, client, oldestOpen)

  const shared: Shared = {
    ledger,
    client,
    cfg,
    feeBps,
    startedAt: Date.now(),
    settlerWeiAtStart: settlerWei,
    snapshot: { at: 0, warrants: new Map(), agentUsdc, settlerWei },
    inFlight: { honored: 0, diverted: 0 },
    gate: Promise.resolve(),
    tagGate: Promise.resolve(),
    bucket: new TokenBucket(cfg.khReqPerMin, cfg.khReqPerMin),
    session: { opened: 0, failed: 0, orphans: 0 },
  }
  await refreshSnapshot(shared, true)
  await writeCounters(shared)

  let interrupted = false
  const onSignal = (signal: string) => {
    if (interrupted) process.exit(130)
    interrupted = true
    shared.stop = {
      cap: 'max-runtime',
      why: `interrupted by ${signal} — the warrants in flight remain settleable`,
    }
    emit({ msg: 'runner: interruption requested', signal })
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  /**
   * The expired-bond sweeper — **a single instance**, and that is the constraint
   * that dictates its shape.
   *
   * It cannot live inside `worker()`: `reclaim` goes out from the agent's key, and
   * four workers reclaiming in parallel would produce transactions at the same
   * nonce. Nor can it be in `Promise.all` with the workers, since it must keep
   * running during the drain — that is in fact where it is most useful, when
   * nothing is opening any more and the abandoned warrants remain.
   */
  let sweeping = true
  const reclaimIntervalMs = integer('RUNNER_RECLAIM_INTERVAL_MS', 60_000)
  const sweeper = (async () => {
    let totalReclaimed = 0
    let totalRecovered = 0n
    while (sweeping) {
      await sleep(Math.min(reclaimIntervalMs, 10_000))
      if (!sweeping) break
      if (Date.now() - shared.snapshot.at > reclaimIntervalMs) await refreshSnapshot(shared, true)
      const swept = await reclaimExpired(shared)
      totalReclaimed += swept.reclaimed
      totalRecovered += swept.recovered
      if (swept.reclaimed > 0) await refreshSnapshot(shared, true)
    }
    return { totalReclaimed, totalRecovered }
  })()

  await Promise.all(
    Array.from({ length: cfg.concurrency }, (_, slot) => worker(shared, slot)),
  )

  emit({
    msg: 'runner: openings finished',
    cap: shared.stop?.cap,
    reason: shared.stop?.why,
    session: shared.session,
  })

  // ── Draining ───────────────────────────────────────────────────────────────
  //
  // We do not stop the runner on the last `open`. The warrants in flight are not
  // settled yet, and they are the ones that carry the figure that matters: an open
  // warrant proves nothing, a **settled** warrant proves the post-condition was
  // evaluated and that the bond moved. So we wait for the backlog to empty, and we
  // keep publishing the counter meanwhile.
  const drainUntil = Date.now() + cfg.drainMs
  for (;;) {
    await refreshSnapshot(shared, true)
    await writeCounters(shared)
    const open = [...shared.snapshot.warrants.values()].filter(
      (w) => w.status === WarrantStatus.Open,
    ).length
    if (open === 0) {
      emit({ msg: 'runner: backlog drained' })
      break
    }
    if (Date.now() > drainUntil) {
      const now = Math.floor(Date.now() / 1000)
      const past = [...shared.snapshot.warrants.values()].filter(
        (w) => w.status === WarrantStatus.Open && w.expiry < now,
      ).length
      emit({
        msg: 'runner: draining cut short',
        stillOpen: open,
        ofWhichExpired: past,
        reason:
          `RUNNER_DRAIN_MS=${cfg.drainMs} elapsed. The non-expired ones are still ` +
          'settleable: leave the Settler running. The expired ones are waiting for a ' +
          'reclaim() — restarting the runner is enough, its sweeper recovers them.',
      })
      break
    }
    await sleep(Math.max(5_000, cfg.settlerIntervalMs))
  }

  sweeping = false
  const swept = await sweeper

  /**
   * ⚠ The Settler is stopped **before** the final reading, not after.
   *
   * Defect observed on the "bound" campaign: the report announced 0.000004641 ETH
   * of gas consumed, while the sum of the receipts was 0.000005446 ETH — 17% more.
   * The cause is not an arithmetic error but an ordering one: `bin/settler.ts`
   * flushes its pending ERC-8004 batches on `SIGTERM` ("keeping them in memory
   * would amount to losing verdicts already rendered"), so **an 806e9 wei
   * transaction goes out after** the last balance reading. A gas report that
   * systematically excludes the last reputation write under-provisions the next
   * campaign, and it does so all the more the smaller the batch is.
   *
   * So we send it the signal, wait for it to exit, then re-read the balance. A
   * Settler that was already running survives — it is not the runner's job to kill
   * a process it did not launch — and in that case the reading stays approximate,
   * which the report's `gasSettlerOutsideRunner` field says explicitly.
   */
  if (settlerChild && settlerChild.exitCode === null) {
    settlerChild.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((r) => settlerChild.once('exit', () => r())),
      sleep(20_000),
    ])
  }
  await refreshSnapshot(shared, true)

  const final = await computeCounters({
    ledger,
    client,
    escrow: cfg.escrow,
    chainId: cfg.chainId,
    campaign: cfg.campaign,
  })
  emit({
    msg: 'runner: finished',
    capReached: shared.stop?.cap ?? 'none',
    reason: shared.stop?.why,
    campaign: final.campaignTally,
    total: final.total,
    bondsRecovered: swept.totalReclaimed,
    capitalRecovered: usdc(swept.totalRecovered),
    gasConsumed: eth(
      shared.settlerWeiAtStart > shared.snapshot.settlerWei
        ? shared.settlerWeiAtStart - shared.snapshot.settlerWei
        : 0n,
    ),
    // **All-in** cost per settlement: the gas measured on the Settler's key divided
    // by the campaign's settlements. So it includes the ERC-8004 registration,
    // immediate on the slashes and amortised in batches on the honored ones.
    averageSettlementCostWei:
      final.campaignTally.honored + final.campaignTally.slashed > 0
        ? (
            (shared.settlerWeiAtStart - shared.snapshot.settlerWei) /
            BigInt(final.campaignTally.honored + final.campaignTally.slashed)
          ).toString(10)
        : '0',
    settlementProvisionWei: {
      honor: GAS_HONOR_WEI.toString(10),
      slash: GAS_SLASH_WEI.toString(10),
      erc8004Registration: GAS_FEEDBACK_WEI.toString(10),
    },
    // The reading is only exact if the Settler measured is the one the runner
    // launched and stopped: otherwise its batches go out beyond the measurement
    // window.
    gasSettlerOutsideRunner: settlerChild === undefined,
  })
}

/** Loads `.env` the way `bin/settler.ts` and `bin/open-warrant.ts` do. */
export function loadEnv(): void {
  for (const candidate of [optional('WARRANT_ENV_FILE', ''), '.env', '../../.env']) {
    if (!candidate) continue
    try {
      process.loadEnvFile(candidate)
      return
    } catch {
      /* next */
    }
  }
}

export { flag }
