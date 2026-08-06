/**
 * The ledger as the source of truth — and the public counter that comes out of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why the runner keeps no state of its own
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A volume runner has to survive being killed and restarted without reopening
 * what it already opened. The tempting answer is a state file of its own —
 * `runner.state.json`, a counter, a list of ids. That is a second register to
 * reconcile with the first, and the day the two diverge (SIGKILL between the
 * opening and the state write), the one we believe is the one that lies.
 *
 * So the runner has none. It **reuses** `WARRANT_JOURNAL_FILE`, the one
 * `open-warrant.ts` writes and the Settler follows, and it adds the one thing
 * that ledger does not carry yet: under which **scenario** a warrant was opened.
 * The ledger is append-only and "the last line wins on reload" (see
 * `packages/server/src/journal.ts`): rewriting a record enriched with a `runner`
 * field is therefore a legitimate operation of the format, not a hijacking. The
 * Settler re-reads the line, finds nothing changed in the fields it knows about,
 * and carries on.
 *
 * What that field buys, and what no onchain read would give:
 *
 *   • **exact resumption of the plan.** The scenario cannot be deduced from the
 *     chain nor from the ledger: `actionSpec.calldata` encodes the *committed*
 *     destination, never the one actually served. Without the tag, a restarted
 *     runner would not know how many slashes it has already caused, and would
 *     reopen slashes at 0.2 USDC apiece — the only line item that destroys
 *     principal;
 *   • **separation between campaigns.** Warrants opened by hand before the
 *     runner count towards the public counter (they are real warrants) but not
 *     towards the budget of the campaign under way.
 *
 * And the budget itself never believes the tag: destroyed principal is computed
 * from `status == Slashed` **read onchain**. The tag serves the plan, the chain
 * serves the accounting.
 */

import { WarrantStatus, type Address, type Hex } from '@warrant/core'
import type { PublicClient } from 'viem'
import { fileWarrantStore, type WarrantJournal } from '../../../packages/server/src/journal.js'
import type { WarrantRecord } from '../../../packages/server/src/gateway.js'
import { readWarrants, type OnchainWarrant } from './chain.js'

export type Scenario = 'honored' | 'diverted'

/**
 * The call shape a warrant commits to.
 *
 * Not cosmetic: the two exercise different post-conditions. A `transfer` is
 * judged on `erc20_balance_delta`, an `approve` on `erc20_allowance` — and a
 * campaign made only of transfers leaves the allowance checker with no onchain
 * evidence at all, however well it is unit-tested.
 */
export type Action = 'transfer' | 'approve'

/** Campaign tag the runner adds to a ledger record. */
export interface RunnerTag {
  /** Campaign label — `RUNNER_CAMPAIGN`. Isolates budgets between series. */
  campaign: string
  /** Rank within the campaign, from 1. Diagnostic, never an identifier. */
  seq: number
  /** Scenario asked of `open-warrant.ts`. The only non-deducible field. */
  scenario: Scenario
  /**
   * Call shape asked of `open-warrant.ts`. Optional: records written before the
   * runner could drive anything but `transfer` do not carry it, and rewriting
   * them would falsify a ledger whose value is that it was written as it went.
   */
  action?: Action
  /** Epoch milliseconds. Used to measure the throughput actually achieved. */
  taggedAt: number
}

export type TaggedRecord = WarrantRecord & { runner?: RunnerTag }

export interface Ledger {
  readonly journal: WarrantJournal
  /** Takes in the lines other processes appended. */
  refresh(): void
  /** Every record, last version wins. */
  all(): TaggedRecord[]
  /** Those tagged with the current campaign, by ascending rank. */
  campaign(): (TaggedRecord & { runner: RunnerTag })[]
  /** Rewrites a record enriched with its tag. Idempotent. */
  tag(id: Hex, tag: RunnerTag): void
  /** Next free rank in the campaign. */
  nextSeq(): number
}

export function openLedger(path: string, campaign: string): Ledger {
  const journal = fileWarrantStore({
    path,
    // An unreadable line interrupts nothing, but it must not be silent: it is a
    // warrant the Settler will never settle, hence a bond with nothing left to
    // wait for but expiry.
    onDefect: (d) =>
      console.warn(
        JSON.stringify({ msg: 'runner: unreadable ledger line', line: d.line, error: d.error }),
      ),
  })

  const isCampaign = (r: TaggedRecord): r is TaggedRecord & { runner: RunnerTag } =>
    r.runner?.campaign === campaign

  return {
    journal,
    refresh(): void {
      journal.refresh()
    },
    all(): TaggedRecord[] {
      return journal.list() as TaggedRecord[]
    },
    campaign(): (TaggedRecord & { runner: RunnerTag })[] {
      return (journal.list() as TaggedRecord[])
        .filter(isCampaign)
        .sort((a, b) => a.runner.seq - b.runner.seq)
    },
    tag(id: Hex, tag: RunnerTag): void {
      journal.refresh()
      const record = journal.get(id) as TaggedRecord | undefined
      if (!record) {
        // The child opened the warrant but the ledger does not carry it: refuse
        // to invent a line. A record fabricated here would hold a
        // `conditionSpec` nobody signed, and the Settler would recompute
        // `conditionHash(spec) != conditionHash onchain` — hence a refusal to
        // evaluate, hence an expiry. Better to say so right away.
        throw new Error(
          `warrant ${id} missing from ledger ${path}: it was opened onchain but ` +
            'open-warrant.ts did not write its line. The Settler will not be able ' +
            'to evaluate it and the bond will wait for reclaim().',
        )
      }
      journal.put({ ...record, runner: tag } as WarrantRecord)
    },
    nextSeq(): number {
      journal.refresh()
      const seqs = (journal.list() as TaggedRecord[])
        .filter(isCampaign)
        .map((r) => r.runner.seq)
      return seqs.length === 0 ? 1 : Math.max(...seqs) + 1
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public counter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the dashboard and the jury read.
 *
 * ASCII keys and amounts as decimal strings of atomic units: a counter consumed
 * by another process must neither depend on an accent nor pass through a
 * `number` — 0.2 USDC is 200000, and a bond routed through a float would lose
 * units without signalling anything. The same amounts are duplicated in `*_usdc`
 * decimal form for display, and only that one is meant to be read by a human.
 */
export interface Counters {
  campaign: string
  /** ISO 8601, instant of computation. An undated counter cannot be compared. */
  at: string
  chainId: number
  escrow: Address
  /** Over the whole ledger — the deployment's complete history. */
  total: Tally
  /** Over only the warrants tagged with the current campaign. */
  campaignTally: Tally
  /** Warrants in the ledger but not found onchain. Must stay at 0. */
  unknown: number
}

export interface Tally {
  /** Warrants existing onchain (status ≠ None). This is the claimed volume. */
  opened: number
  honored: number
  slashed: number
  reclaimed: number
  /** Still open: the backlog the Settler has to drain. */
  open: number
  /** Σ bond of open warrants — capital locked up, recoverable. */
  locked: string
  locked_usdc: string
  /** Σ bond of slashed warrants — capital **destroyed**, gone to the beneficiary. */
  destroyed: string
  destroyed_usdc: string
  /** Σ fee of honored warrants — the real cost of recycling. */
  fees: string
  fees_usdc: string
  /** Σ `bond − fee` returned to the agent on the honored ones. */
  refunded: string
  refunded_usdc: string
  /** slashed / (honored + slashed), in basis points. Nothing settled: 0. */
  slashRateBps: number
}

function emptyTally(): Tally {
  return {
    opened: 0,
    honored: 0,
    slashed: 0,
    reclaimed: 0,
    open: 0,
    locked: '0',
    locked_usdc: '0.000000',
    destroyed: '0',
    destroyed_usdc: '0.000000',
    fees: '0',
    fees_usdc: '0.000000',
    refunded: '0',
    refunded_usdc: '0.000000',
    slashRateBps: 0,
  }
}

function decimals6(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = (atomic % 1_000_000n).toString(10).padStart(6, '0')
  return `${whole}.${frac}`
}

/**
 * Aggregates a list of warrants read onchain.
 *
 * `fee` is derived from `bond × feeBpsAtOpen / 10000` rather than read from
 * `WarrantHonored`: this escrow's logs cannot be queried over a wide window with
 * Base Sepolia's public RPC, which refuses any `eth_getLogs` spanning more than
 * 2000 blocks. `feeBpsAtOpen` is frozen at opening time by the contract
 * precisely so that this computation stays exact even if the rate changes
 * afterwards — deriving it is therefore just as correct as reading it, and costs
 * no request at all.
 */
export function tally(warrants: Iterable<OnchainWarrant>): Tally {
  const t = emptyTally()
  let locked = 0n
  let destroyed = 0n
  let fees = 0n
  let refunded = 0n
  for (const w of warrants) {
    if (w.status === WarrantStatus.None) continue
    t.opened += 1
    const fee = (w.bond * BigInt(w.feeBpsAtOpen)) / 10_000n
    switch (w.status) {
      case WarrantStatus.Open:
        t.open += 1
        locked += w.bond
        break
      case WarrantStatus.Honored:
        t.honored += 1
        fees += fee
        refunded += w.bond - fee
        break
      case WarrantStatus.Slashed:
        t.slashed += 1
        destroyed += w.bond
        break
      case WarrantStatus.Reclaimed:
        t.reclaimed += 1
        refunded += w.bond
        break
    }
  }
  const settled = t.honored + t.slashed
  t.locked = locked.toString(10)
  t.locked_usdc = decimals6(locked)
  t.destroyed = destroyed.toString(10)
  t.destroyed_usdc = decimals6(destroyed)
  t.fees = fees.toString(10)
  t.fees_usdc = decimals6(fees)
  t.refunded = refunded.toString(10)
  t.refunded_usdc = decimals6(refunded)
  t.slashRateBps = settled === 0 ? 0 : Math.round((t.slashed * 10_000) / settled)
  return t
}

export interface CountersInput {
  ledger: Ledger
  client: PublicClient
  escrow: Address
  chainId: number
  campaign: string
}

/** Recomputes the public counter: ledger for the list, chain for the status. */
export async function computeCounters(input: CountersInput): Promise<Counters> {
  input.ledger.refresh()
  const records = input.ledger.all()
  const ids = records.map((r) => r.id.toLowerCase() as Hex)
  const onchain = await readWarrants(input.client, input.escrow, ids)

  const campaignIds = new Set(
    records
      .filter((r) => r.runner?.campaign === input.campaign)
      .map((r) => r.id.toLowerCase()),
  )

  return {
    campaign: input.campaign,
    at: new Date().toISOString(),
    chainId: input.chainId,
    escrow: input.escrow,
    total: tally(onchain.values()),
    campaignTally: tally([...onchain.values()].filter((w) => campaignIds.has(w.id))),
    unknown: ids.length - onchain.size,
  }
}
