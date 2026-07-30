/**
 * Budget and sizing — the part of the runner that is allowed to say no.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. What a warrant really costs, measured on Base Sepolia
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The three figures below are not estimates: they come from the receipts of the
 * first warrant settled on the current deployment
 * (`0x3ae9ad53…`, chainId 84532, `feeBps` 250).
 *
 *   • **opening** — tx `0xf95b25e4…`, 319,607 gas, L1 fee 23,661,378,860 wei,
 *     total cost 0.00000194 ETH. `from` is the KeeperHub relayer
 *     `0x6331eb45…`, `to` the forwarder `0x5aF5194B…`: the opening is
 *     **sponsored**. So it consumes *nothing* of our keys — neither gas nor
 *     nonce. That is the fact that makes volume possible at all.
 *   • **honor** — tx `0x3220b47e…`, 86,013 gas, L1 fee 6,845,289,219 wei,
 *     total cost **0.000000523 ETH**, `from` the Settler. `refunded` 195,000,
 *     `fee` 5,000: 97.5% of the 200,000 bond comes back.
 *   • **slash** — same shape, and **barely more expensive**: 493e9 wei measured
 *     against 477e9 for an honor. The original provisioning at 1.5 × honor
 *     assumed the `reason` string weighed appreciably on the L1 fee; it is far
 *     too short for that. See the constants below.
 *   • **ERC-8004 registration** — a **new** line item, and it did not exist when
 *     the three figures above were taken: `ERC8004_AGENT_IDS_FILE` is now set,
 *     so `erc8004Sink` resolves an `agentId` and really does write to the
 *     `ReputationRegistry`, on the Settler's key. The write policy is not
 *     uniform (`daemon.ts`, `writePolicyFor`) and that is what makes the
 *     provisioning asymmetric:
 *
 *       – `slashed`   → **immediate** write, one transaction per slash;
 *       – `honored`   → **batched**, one transaction per `ERC8004_BATCH_SIZE`
 *                       verdicts (25 by default) or on the shutdown `flush`;
 *       – `reclaimed` → never.
 *
 *     So the gas of a slash nearly doubles, while that of an honored warrant
 *     grows by only one twenty-fifth of a transaction. Provisioning the
 *     registration at the same price on both line items would overestimate the
 *     cost of honored volume by a factor of 2 — and would make the announced
 *     bound wrong in the pessimistic direction, which is still a wrong bound.
 *
 * Consequences in figures, at `bond = 200,000` and `feeBps = 250`:
 *
 *   cost of an **honored** warrant = 5,000 units = 0.005 USDC of fees
 *                                 + 477e9 wei of settlement
 *                                 + 806e9/25 ≈ 32e9 wei of batched registration
 *                                 ────────────────────── ≈ 510e9 wei
 *   cost of a **slashed** warrant  = 200,000 units = 0.2 USDC of principal
 *                                 + 494e9 wei of settlement
 *                                 + 806e9 wei of immediate registration
 *                                 ────────────────────── ≈ 1,300e9 wei, i.e. 2.6 ×
 *
 * Put differently: **capital recycles, except on slashes.** An honored warrant
 * consumes 1/40th of its bond; a slashed warrant consumes all of it. The budget
 * must therefore treat these two line items separately, and that is exactly what
 * `Budget` does: a principal cap for the slashes, a fee cap for the recycling, a
 * gas cap for the settlement. A single USDC cap would let 240 honored warrants
 * consume as much as 6 slashes — and would hide which of the two drained the key.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. Sizing the throughput — the computation, and its real bound
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Four limits stack up. The lowest one governs, and it is not the one you would
 * expect.
 *
 * **(a) KeeperHub's API rate.** 100 req/min authenticated announced,
 * 60 req/min documented on direct execution (see the comment on
 * `KeeperHubClient.request`). We keep the stricter one: 60. A complete opening by
 * `open-warrant.ts` costs, nominally:
 *
 *     1 × GET  /api/user/wallet                        (getWallet)
 *     1 × POST /api/execute/contract-call              (open)
 *     1 × GET  /api/execute/{id}/status                (resolveTransaction)
 *     1 × POST /api/execute/contract-call              (the action)
 *     1 × GET  /api/execute/{id}/status                (resolveTransaction)
 *     ────────────────────────────────────────────────────────────────
 *     5 requests per warrant, up to 11 if `resolveTransaction` exhausts its
 *     4 attempts on both calls.
 *
 * To which the Settler adds: 1 GET per **still-open** warrant per pass, i.e.
 * `backlog × 60/intervalMs` req/min. At backlog 6 and a 15 s pass: 24 req/min.
 * That leaves 36 req/min for the opening, i.e.
 * **⌊36 / 5⌋ = 7 warrants/min** — 11 counting retries at worst:
 * ⌊36 / 11⌋ = 3 warrants/min. We size on the worst case.
 *
 * **(b) KeeperHub's latency.** `executeContractCall` is *blocking on the API
 * side*: the response only arrives once the execution has finished. The comment
 * on `KeeperHubClient` announces ≈ 23 s per call, measured on Ethereum Sepolia;
 * **on Base Sepolia, measured on the "smoke" campaign, a complete warrant — two
 * blocking calls, plus the subprocess's Node startup, plus waiting for the
 * opening receipt — takes 14.3 s and 18.4 s.** That is ≈ 16 s, hence
 * **≈ 3.7 warrants/min per worker**, almost three times the estimate derived
 * from Sepolia. Base's 2 s blocks explain most of the gap.
 *
 * At `C` workers: ≈ 3.7 × C warrants/min. Saturating (a) therefore takes C ≈ 1 in
 * the worst case in requests (3 warrants/min) and C ≈ 2 nominally (7/min): on
 * Base, **it is the API rate that becomes the constraint before latency does**,
 * the opposite of what the Sepolia measurement suggested. The token bucket is
 * therefore not a theoretical precaution — it is what regulates.
 *
 * **(c) The Settler's throughput.** A single key, hence a single nonce, hence one
 * settlement at a time — parallelising would reintroduce the nonce conflict
 * invariant I10 is trying to avoid. Measured: opening at block 44,804,490,
 * `honor` at block 44,804,505, i.e. 15 blocks ≈ 30 s end to end, of which
 * 3 confirmations (≈ 6 s) and one loop pass. The *marginal* cost of one extra
 * warrant within the same pass is the evaluation plus the inclusion of one
 * transaction: the measured passes that actually settle last 4.8 s (the tick's
 * `durationMs`), against 1.9 s for a pass that settles nothing. That is
 * **≈ 12 warrants/min** at best, and we keep 6 to account for archive reads and
 * the variance of the public RPC.
 *
 * Consequence, and it is what dictates the backlog cap: with the Settler draining
 * ≈ 6/min and the runner opening ≈ 3.7 × C, any `C > 2` produces a backlog that
 * grows. That is not a problem — the backlog cap catches it and the runner waits —
 * but it means that **the campaign's sustainable throughput is the Settler's, not
 * the opening's**. Announcing 11 warrants/min with C = 3 would be false: the
 * sustained measurement is 6.
 *
 * **(d) Capital in flight.** And this is the real bound. Every open warrant locks
 * up `bond` until it settles. With 1.995 USDC on the agent and
 * `bond = 0.2 USDC`, **at most 9 warrants can be open simultaneously** — the
 * tenth would hit an insufficient balance, that is, a
 * `receiveWithAuthorization` that reverts after KeeperHub has paid the gas.
 *
 * Hence the sizing we settled on, and the order it is derived in:
 *
 *     backlogCap L = min(⌊(agentBalance − reserve) / bond⌋, configured cap)
 *     concurrency C = min(L, RUNNER_CONCURRENCY)
 *     sustained rate = min(3.4 × C, Settler's rate ≈ 6, bucket cap)
 *
 * **Measured on the "bound" campaign** (2026-07-30, 8 warrants, C = 2,
 * `backlogCap` 3): 17,384 ms per warrant on average over the eight successful
 * openings (min 10,809, max 22,149), i.e. **3.45 warrants/min per worker** — the
 * value of 3.7 derived from the two-warrant "smoke" campaign was 7% optimistic.
 * At C = 2 that gives 6.9 warrants/min of opening, which the Settler at ≈ 6/min
 * already fails to keep up with: the conclusion of § 2 (c) holds, **the
 * sustainable throughput is the Settler's**.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. The bound, in sustained operation: neither capital nor throughput
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `volumeBound` answers "how many with today's balance". The question that
 * governs a multi-day demonstration is a different one: **how many per day**, and
 * there it is the faucet that bounds, at 1 USDC and ≈ 0.0001 ETH per address per
 * 24 h.
 *
 *     capital: 1 USDC / 5,000 units of fees        = 200 honored warrants / day
 *     gas    : 0.0001 ETH / 532e9 wei per honored  = 187 settlements / day
 *     ────────────────────────────────────────────────────────────────────────
 *     sustained bound ≈ 187 honored warrants / day, **bounded by gas**
 *
 * The two line items are within 7% of each other, which is no coincidence: it is
 * the faucet's cap that made them comparable, not a property of the protocol. And
 * the one that bites is the one the ERC-8004 registration made dominant — without
 * it, gas would fund 200 settlements and capital would be the constraint. On
 * **slashes**, the gap is brutal: 5 per day on the capital side against 75 on the
 * gas side, destroyed principal binding fifteen times earlier.
 *
 * The backlog cap plays three roles at once, and that is what makes it the right
 * knob: it bounds locked-up capital, it bounds the Settler's load, and it bounds
 * expiry risk — `MIN_DURATION` is 900 s, a backlog of 6 drained at 6/min empties
 * in one minute, i.e. fifteen times the margin.
 */

import { usdc, eth } from './env.js'
import type { Scenario } from './ledger.js'

/**
 * Gas costs, in wei, **taken from the receipts** of the "bound" campaign
 * (2026-07-30, 8 warrants, chainId 84532), then rounded up.
 *
 *   honor               7 tx · 78,507 gas · 477,499,325,875 wei on average
 *   slash               1 tx · 78,289 gas · 493,551,244,498 wei
 *   giveFeedback alone  1 tx · 131,948 gas · 805,661,985,040 wei
 *   giveFeedback batch  1 tx · 131,636 gas · 804,692,195,881 wei  (7 verdicts)
 *   reclaim             2 tx · 59,535 gas · 363,150,905,216 wei   (agent's key)
 *
 * Two surprises, and both correct the original provisioning:
 *
 *   • **a slash costs almost no more than an honor** — 493e9 against 477e9, i.e.
 *     +3%, where the original provisioning assumed +50%. The slash's `reason`
 *     string is short ("post-condition not satisfied"), so its L1 fee surcharge is
 *     marginal. Provisioning 1.5 × honor inflated the rarest line item by 60%,
 *     which is not serious in itself, but which hid the truly dominant one;
 *   • **the ERC-8004 registration costs more than the settlement it describes** —
 *     806e9 against 477e9, i.e. 1.7 ×. A slash, which triggers an immediate
 *     registration, therefore costs 1,299e9 wei all in: **2.7 × a bare honor**.
 *     And the batch's cost is independent of its size (804e9 for 7 verdicts,
 *     against 806e9 for 1) because the registry receives only a URI and a hash,
 *     never the documents. So the batch amortises linearly: 806e9 / 25 ≈ 32e9 per
 *     honored warrant at a full batch.
 *
 * Put differently, ever since `ERC8004_AGENT_IDS_FILE` has been set, a campaign's
 * gas is no longer dominated by the number of settlements but by the number of
 * **slashes**. That is exactly the opposite of the intuition, and it is what the
 * announced bound has to reflect.
 */
export const GAS_HONOR_WEI = 500_000_000_000n
export const GAS_SLASH_WEI = 520_000_000_000n
export const GAS_FEEDBACK_WEI = 810_000_000_000n
/** `reclaim`, on the **agent's** key and not the Settler's. Do not mix the two. */
export const GAS_RECLAIM_WEI = 380_000_000_000n

export interface BudgetCaps {
  /** Cap on the principal the slashes are allowed to destroy. */
  slashPrincipal: bigint
  /** Cumulative fee cap over the honored warrants. */
  fees: bigint
  /**
   * Floor on the Settler's balance, in wei. **Invariant across restarts**: it is
   * this, and not the spend cap, that keeps the key from being drained.
   */
  gasFloorWei: bigint
  /**
   * Gas spend cap **for this process**, measured from the balance read at
   * startup. Does not survive a restart, and says so.
   */
  gasSpendWei: bigint
  /** Untouchable USDC reserve on the agent, on top of the bonds in flight. */
  agentReserve: bigint
  /** Number of warrants targeted for the campaign. */
  target: number
  /** Number of slashes targeted. The hackathon criterion asks for ≥ 3. */
  slashTarget: number
  /** Maximum process runtime, in milliseconds. */
  maxRuntimeMs: number
  /** Cap on simultaneously open warrants. See § 2 (d). */
  backlogCap: number
  /**
   * `ERC8004_BATCH_SIZE` as the Settler will read it. Enters no decision: it
   * serves only to amortise the honored warrants' registration gas within the
   * announced bound. A wrong value here does not make the runner spend, it makes
   * it announce badly — which, in front of a jury, is the same defect.
   */
  erc8004BatchSize: number
}

/** What the runner knows about the state of the world when it decides. */
export interface BudgetState {
  /** Campaign warrants already opened (all statuses). */
  opened: number
  /** Slashes **observed onchain** on the campaign. */
  slashed: number
  /** Campaign warrants still awaiting a slash scenario. */
  divertedInFlight: number
  /** Principal destroyed by the campaign's slashes, read onchain. */
  destroyed: bigint
  /** Fees paid by the campaign's honored warrants, read onchain. */
  fees: bigint
  /** Warrants still open, campaign or not: this is the real load. */
  backlog: number
  /** The agent's USDC balance. */
  agentUsdc: bigint
  /**
   * Capital the warrants **in flight** will return to the agent, in atomic
   * units: `bond − fee` per open warrant meant to be honored, the whole `bond`
   * per open warrant already expired (which the `reclaim` sweeper recovers at no
   * fee), and **zero** for a warrant tagged `diverted`, whose bond goes to the
   * beneficiary.
   *
   * This is the field that tells "the agent is dry" apart from "the agent is
   * waiting for its own money". See fix nº 2 commented in `decide`: without it, a
   * runner in nominal operation stops for good over a shortage that lasts thirty
   * seconds.
   */
  recoverable: bigint
  /** The Settler's ETH balance. */
  settlerWei: bigint
  /** The Settler's ETH balance at process startup. */
  settlerWeiAtStart: bigint
  /** Milliseconds elapsed since startup. */
  elapsedMs: number
  /** A warrant's bond, in atomic units. */
  bond: bigint
  /** Fee rate frozen by the contract, in basis points. */
  feeBps: number
}

export type Decision =
  | { kind: 'open'; scenario: Scenario; why: string }
  | { kind: 'wait'; why: string }
  | { kind: 'stop'; cap: StopCap; why: string }

/**
 * The possible stops, named.
 *
 * A runner that stops without saying **which** of its caps was reached is
 * unusable: you cannot tell whether to top up from the faucet, reduce the
 * slashes, or simply restart it because the target has been met. Every value in
 * this set corresponds to a different action by the operator.
 *
 * Note what is **not** in this list: the slashes' principal cap. It bounds the
 * slashes, not the campaign — see the fix commented in `decide`. A cap that only
 * closes off one *variant* of an action must not be able to stop the process.
 *
 * And note what stayed in but no longer fires in the same case:
 * `agent-capital-insufficient` only holds if **nothing** is coming back. A
 * balance momentarily below the bond while warrants in flight are each about to
 * return `bond − fee` is not exhaustion, it is a queue.
 */
export type StopCap =
  | 'target'
  | 'fee-budget'
  | 'settler-gas-floor'
  | 'process-gas-budget'
  | 'agent-capital-insufficient'
  | 'max-runtime'

/**
 * The decision, in the order it has to be taken.
 *
 * The order is not arbitrary. The *hard* stops (capital, gas) come before the
 * *soft* ones (target reached): a runner announcing "target reached" when it has
 * just exhausted the Settler's gas would be lying about the reason, and the
 * operator would restart for nothing. And degrading a slash into an honored
 * warrant comes before stopping: when the slash quota is exhausted, there is
 * still volume to produce, and it costs nothing but fees.
 */
export function decide(caps: BudgetCaps, s: BudgetState): Decision {
  const feePerHonor = (s.bond * BigInt(s.feeBps)) / 10_000n

  // ── Hard stops: what waiting will not repair ───────────────────────────────
  if (s.settlerWei < caps.gasFloorWei) {
    return {
      kind: 'stop',
      cap: 'settler-gas-floor',
      why:
        `the Settler is at ${eth(s.settlerWei)} ETH, below the floor of ` +
        `${eth(caps.gasFloorWei)} ETH. Continuing to open would produce warrants nobody ` +
        'would settle, and they would expire towards reclaim(). ' +
        "Top up the Settler's key (pnpm faucet), then restart.",
    }
  }
  const gasSpent = s.settlerWeiAtStart > s.settlerWei ? s.settlerWeiAtStart - s.settlerWei : 0n
  if (gasSpent >= caps.gasSpendWei) {
    return {
      kind: 'stop',
      cap: 'process-gas-budget',
      why:
        `this process has consumed ${eth(gasSpent)} ETH of settlement gas, ` +
        `cap ${eth(caps.gasSpendWei)} ETH. Raise RUNNER_GAS_SPEND_WEI to carry on — ` +
        "the key's own floor is still being respected.",
    }
  }
  /**
   * ⚠ Fix nº 2, same family as nº 1 commented below, and found by re-reading the
   * list of stops with the right question: "does this cap measure something
   * **consumed**, or something **locked up**?"
   *
   * The agent's USDC balance is locked up, not consumed. In nominal operation —
   * `backlogCap` warrants in flight, each locking up `bond` — the free balance
   * mechanically drops below one bond: that is the *normal* case, the one the
   * backlog cap makes the runner converge towards. A hard stop here therefore
   * means the runner stops for good over a shortage that clears itself at the next
   * settlement, i.e. ≈ 30 s later, and that it hands back a diagnosis — "top up
   * the agent" — that the operator has no use for.
   *
   * The stop only becomes legitimate if **nothing is coming back**: `recoverable`
   * is then 0, no warrant in flight will return capital, and waiting is an
   * infinite loop. Telling the two apart costs one state field and avoids
   * confusing "dry" with "waiting for its own money".
   */
  if (s.agentUsdc < s.bond + caps.agentReserve) {
    if (s.recoverable > 0n) {
      return {
        kind: 'wait',
        why:
          `free balance ${usdc(s.agentUsdc)} USDC below the bond ${usdc(s.bond)} + reserve ` +
          `${usdc(caps.agentReserve)}, but ${usdc(s.recoverable)} USDC are coming back from ` +
          `the ${s.backlog} warrants in flight. We wait for the settlement, we do not stop the campaign.`,
      }
    }
    return {
      kind: 'stop',
      cap: 'agent-capital-insufficient',
      why:
        `the agent holds ${usdc(s.agentUsdc)} USDC, it needs ${usdc(s.bond)} of bond ` +
        `plus ${usdc(caps.agentReserve)} of reserve, and **nothing is in flight** that could ` +
        'return capital. The EIP-3009 authorization would revert on collection, after ' +
        'KeeperHub has paid the opening gas. Top up the agent (pnpm faucet, ' +
        "1 USDC / address / 24 h): that is volume's hard bound.",
    }
  }
  if (s.elapsedMs >= caps.maxRuntimeMs) {
    return {
      kind: 'stop',
      cap: 'max-runtime',
      why:
        `maximum runtime reached (${Math.round(s.elapsedMs / 1000)} s). The warrants in ` +
        'flight remain settleable by the Settler: restarting the runner resumes the count ' +
        'where it stands, the ledger being authoritative.',
    }
  }

  // ── Target ─────────────────────────────────────────────────────────────────
  if (s.opened >= caps.target) {
    return {
      kind: 'stop',
      cap: 'target',
      why: `target of ${caps.target} warrants reached on this campaign (${s.opened} opened).`,
    }
  }

  // ── Waiting: the backlog is not a cap, it is a queue ───────────────────────
  if (s.backlog >= caps.backlogCap) {
    return {
      kind: 'wait',
      why:
        `${s.backlog} warrants open, cap ${caps.backlogCap}: ` +
        `${usdc(BigInt(s.backlog) * s.bond)} USDC locked up. We let the Settler drain.`,
    }
  }

  // ── Choosing the scenario ──────────────────────────────────────────────────
  //
  // The rule is a **ratio**, not a modulo. A modulo ("one slash every N") falls
  // out of sync as soon as a warrant fails to open, and above all it does not
  // recompute identically after a restart — two successive runs would replay the
  // same position. The ratio depends only on the observed state: "am I behind on
  // the targeted proportion of slashes?". It converges, it is idempotent, and it
  // resumes on its own after an interruption.
  //
  // Warrant nº 1 is **always** honored. A slash first would destroy 0.2 USDC —
  // 10% of the agent's capital — before we know the execution chain works end to
  // end. The first warrant is a smoke test, and it has to be the cheaper of the
  // two.
  const slashesAcquired = s.slashed + s.divertedInFlight
  const behindOnSlashes = slashesAcquired * caps.target < caps.slashTarget * (s.opened + 1)
  const slashRoom = caps.slashPrincipal - s.destroyed - BigInt(s.divertedInFlight) * s.bond

  /**
   * The two scenarios, each with its own feasibility condition. Keeping them
   * symmetric is the whole point of the two fixes commented below: **a cap closes
   * off only the scenario it funds.**
   */
  const slashOwed = s.opened >= 1 && slashesAcquired < caps.slashTarget
  const slashAffordable = slashRoom >= s.bond
  const honoredAffordable = s.fees + feePerHonor <= caps.fees

  /**
   * ⚠ Fix nº 1, straight out of a real run, and worth explaining because the
   * faulty version looked reasonable.
   *
   * There used to be a `slash-principal-budget` stop below, fired as soon as the
   * slash target **and** the principal cap were both reached. Launched on the
   * "hackathon" campaign with `slashTarget = 4` and `slashPrincipal = 0.8 USDC`,
   * the runner stopped at the 43rd warrant out of 52, message and all: "slash
   * principal budget exhausted (0.800000 USDC destroyed out of 0.800000) and slash
   * target reached". True, and absurd: 0.82 USDC of fee budget was left, i.e. 164
   * honored warrants, and it gave up producing them to protect principal that an
   * honored warrant does not touch — an honored warrant returns `bond − fee`, it
   * destroys only 1/40th of the bond.
   *
   * The slash cap **bounds the slashes, not the campaign**. Once exhausted, it
   * must do nothing beyond bringing every subsequent warrant back to the honored
   * scenario. Only the four line items that really consume something are allowed
   * to stop: gas, fees, *unrecoverable* capital, time. Confusing "I can no longer
   * slash" with "I can no longer do anything" cost 9 warrants.
   *
   * ⚠ Fix nº 3, the mirror image of nº 1, and it would not have failed to happen:
   * the **fee** cap closes off honored volume, it has no more reason to close off
   * the slashes. Without the `|| !honoredAffordable` below, an exhausted fee budget
   * stopped the campaign while a slash was still owed *and* fundable out of its own
   * principal budget — the slash target, which is the hackathon's criterion, stayed
   * missed to protect a line item that was not the one under pressure. The
   * `behindOnSlashes` ratio hid the case in nominal operation, which made it
   * exactly the kind of defect that reveals itself on the demonstration campaign.
   */
  const wantSlash = slashOwed && slashAffordable && (behindOnSlashes || !honoredAffordable)

  if (wantSlash) {
    return {
      kind: 'open',
      scenario: 'diverted',
      why:
        `slash ${slashesAcquired + 1}/${caps.slashTarget} — ` +
        `principal left for the slashes ${usdc(slashRoom)} USDC` +
        (honoredAffordable ? '' : ' (fee budget exhausted: only the slashes are left)'),
    }
  }

  if (!honoredAffordable) {
    return {
      kind: 'stop',
      cap: 'fee-budget',
      why:
        `fee budget reached: ${usdc(s.fees)} USDC consumed, cap ` +
        `${usdc(caps.fees)}, one more honored warrant would cost ${usdc(feePerHonor)}. ` +
        (slashOwed
          ? `${caps.slashTarget - slashesAcquired} slash(es) are still owed but the principal ` +
            `reserved for them is exhausted too (${usdc(slashRoom)} left). `
          : '') +
        "Raise RUNNER_FEE_BUDGET if the agent's capital allows it.",
    }
  }

  return {
    kind: 'open',
    scenario: 'honored',
    why:
      slashOwed && !slashAffordable
        ? `slash degraded to an honored warrant: the slashes' principal cap is reached ` +
          `(${usdc(slashRoom)} USDC left, one slash costs ${usdc(s.bond)}). ` +
          'Volume carries on, it costs nothing but fees.'
        : `honored warrant — fee ${usdc(feePerHonor)}, bond returned ${usdc(s.bond - feePerHonor)}`,
  }
}

/**
 * The real bound on reachable volume, at constant state.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What the first version announced that was false
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It took `slashesRemaining` as a parameter — and the caller passed it
 * `caps.slashTarget` as is. On a campaign resumption where three slashes were
 * already observed onchain, the bound therefore reserved three bonds more than
 * needed, i.e. 0.6 USDC, i.e. 120 honored cycles conjured away from the
 * announcement. It also ignored the slashes' principal cap, which can make the
 * slash target unreachable independently of capital.
 *
 * It ignored the **fee** cap too, even though that is the only one of the two
 * USDC budgets that bounds honored volume, and it derived the gas bound from
 * `gasSpendWei` alone — that is, from a policy cap, never from the balance
 * actually present on the Settler's key. A cap of 0.00015 ETH on a key holding
 * 0.00002 announced 187 fundable settlements where there were 25: the announced
 * bound exceeded the physical bound by a factor of 7.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The computation, in the order the constraints bite
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   slashes    s = min(target − acquired, ⌊principal left / bond⌋)
 *   capital    usable u = balance − reserve − bond   (one bond stays in flight)
 *   honored    h ≤ ⌊(u − s × bond) / fee⌋            (capital)
 *              h ≤ ⌊(fee cap − fees paid) / fee⌋     (fee budget)
 *   gas        s × (slash + registration) + h × (honor + registration/batch) ≤ g
 *              with g = min(process cap, Settler's balance − floor)
 *   target     s + h ≤ target − already opened
 *
 * `binding` names whichever of the four bit first. It is the one figure in the
 * output that tells the operator *what to top up*.
 */
export interface VolumeBound {
  /** Slashes still fundable — target and reserved principal taken together. */
  slashes: number
  /** Honored warrants still fundable. */
  honored: number
  total: number
  binding: 'target' | 'capital' | 'fees' | 'gas'
  /** Gas actually available, in wei: process cap ∧ balance − floor. */
  gasUsableWei: bigint
  /** Settlements this gas funds if **all** are honored. A landmark, not a plan. */
  settlementsPerGas: number
}

export function volumeBound(
  caps: BudgetCaps,
  s: Pick<
    BudgetState,
    'agentUsdc' | 'bond' | 'feeBps' | 'settlerWei' | 'destroyed' | 'fees' | 'slashed' | 'opened'
  >,
): VolumeBound {
  const feePerHonor = (s.bond * BigInt(s.feeBps)) / 10_000n
  const gasPerHonor = GAS_HONOR_WEI + GAS_FEEDBACK_WEI / BigInt(Math.max(1, caps.erc8004BatchSize))
  const gasPerSlash = GAS_SLASH_WEI + GAS_FEEDBACK_WEI

  // (a) Slashes: the target **and** the principal reserved for them.
  const slashRoom = caps.slashPrincipal > s.destroyed ? caps.slashPrincipal - s.destroyed : 0n
  const slashesByTarget = Math.max(0, caps.slashTarget - s.slashed)
  const slashesByPrincipal = s.bond === 0n ? 0 : Number(slashRoom / s.bond)
  let slashes = Math.min(slashesByTarget, slashesByPrincipal)

  // (b) The agent's capital. One bond stays locked up permanently.
  const usable =
    s.agentUsdc > caps.agentReserve + s.bond ? s.agentUsdc - caps.agentReserve - s.bond : 0n
  // Capital funds the slashes first: that is the destructive line item, and
  // under-provisioning it would produce a slash target announced then missed.
  const bondsForSlashes = BigInt(slashes) * s.bond
  if (bondsForSlashes > usable) {
    slashes = s.bond === 0n ? 0 : Number(usable / s.bond)
  }
  const afterSlashes = usable - BigInt(slashes) * s.bond
  const honoredByCapital = feePerHonor === 0n ? 0 : Number(afterSlashes / feePerHonor)

  // (c) Fee budget.
  const feeRoom = caps.fees > s.fees ? caps.fees - s.fees : 0n
  const honoredByFees = feePerHonor === 0n ? 0 : Number(feeRoom / feePerHonor)

  // (d) The Settler's gas: the policy cap **and** the physical balance.
  const settlerRoom = s.settlerWei > caps.gasFloorWei ? s.settlerWei - caps.gasFloorWei : 0n
  const gasUsableWei = caps.gasSpendWei < settlerRoom ? caps.gasSpendWei : settlerRoom
  const gasForSlashes = BigInt(slashes) * gasPerSlash
  if (gasForSlashes > gasUsableWei) {
    slashes = Number(gasUsableWei / gasPerSlash)
  }
  const gasLeft = gasUsableWei - BigInt(slashes) * gasPerSlash
  const honoredByGas = Number(gasLeft / gasPerHonor)

  // (e) Campaign target.
  const roomToTarget = Math.max(0, caps.target - s.opened)

  let honored = Math.min(honoredByCapital, honoredByFees, honoredByGas)
  let binding: VolumeBound['binding'] =
    honored === honoredByGas
      ? 'gas'
      : honored === honoredByFees
        ? 'fees'
        : 'capital'
  if (slashes + honored > roomToTarget) {
    honored = Math.max(0, roomToTarget - slashes)
    binding = 'target'
  }

  return {
    slashes,
    honored,
    total: slashes + honored,
    binding,
    gasUsableWei,
    settlementsPerGas: Number(gasUsableWei / gasPerHonor),
  }
}
