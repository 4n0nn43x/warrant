/**
 * Cross-checking the counters against the chain — the binary that is allowed to
 * say our figures are wrong.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Why `counters` is not enough
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `bin/counters.ts` reads the ledger to obtain a list of `id`s, then
 * `getWarrant(id)` to obtain their status. That is already better than a ledger
 * counter — the status comes from the chain — but the construction keeps two blind
 * spots, and they are exactly the two a jury will look for:
 *
 *   1. **the list comes from us.** A warrant opened onchain and missing from the
 *      ledger is in no list, hence in no total. The counter can be perfectly
 *      consistent *and* under-report the volume. Worse the other way round:
 *      nothing in it detects a warrant we claim and that does not exist —
 *      `unknown` counts it, but nobody verifies it;
 *   2. **the amounts are derived.** `fees` is `bond × feeBpsAtOpen / 10000`,
 *      computed by us, never read. If the contract took anything other than what
 *      it announces, the counter would display what we believe, not what was
 *      transferred. The derivation is correct — `feeBpsAtOpen` is frozen at
 *      opening precisely for that — but "correct by construction" is not
 *      "verified".
 *
 * So this binary builds a **third** counter, out of the escrow's events alone,
 * enumerating the `id`s instead of receiving them and reading `fee`, `refunded`
 * and `amount` from the payloads. Then it cross-checks all three and grants
 * credit only to what agrees:
 *
 *   ledger   ─┐
 *             ├─→ ids ─→ getWarrant  ─→ STATE counter   ─┐
 *   events  ──┴─────────────────────────→ EVENTS counter ┴─→ equality or failure
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * The invariants checked, and what each one would catch
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   I-A  state ≡ events, field by field over the intersection of the `id`s.
 *        Catches: a shifted `status` decoding, a wrong fee derivation.
 *   I-B  `totalLocked()` == Σ bond of the open warrants, according to the events.
 *        Catches: an open warrant not counted, or counted twice. It is the only
 *        invariant that confronts our aggregate with an aggregate **the contract**
 *        keeps itself.
 *   I-C  conservation per honored warrant: `refunded + fee == bond`.
 *        Catches: a partially returned bond, a deduction outside the fee.
 *   I-D  conservation per slash: `amount == bond`.
 *        Catches: a partial slash — the contract provides for none.
 *   I-E  treasury USDC balance ≥ Σ fees, and == if it has spent nothing.
 *        Catches: announced fees that never landed. A check external to the
 *        contract: it goes through the token, not through the escrow.
 *   I-F  ledger coverage: every ledger `id` exists in the events, and every
 *        warrant of **our** agent appears in the ledger.
 *        Catches: the orphan warrant (opened, unjournaled, hence unsettleable)
 *        and the claimed warrant that does not exist.
 *
 * Exit 0 if everything agrees, 1 otherwise. A counter no process can contradict
 * is not a counter, it is an assertion.
 *
 * Usage:
 *   pnpm --filter @warrant/runner verify
 *   pnpm --filter @warrant/runner verify -- --json
 */

import { resolve } from 'node:path'
import type { Address, Hex } from 'warrant-core'
import {
  ERC20_READ_ABI,
  deploymentBlock,
  publicClientFor,
  readEscrowRoles,
  readWarrants,
  scanWarrantEvents,
  usdcBalance,
  type EventWarrant,
} from '../chain.js'
import { address, bigint, integer, optional, required, usdc } from '../env.js'
import { openLedger, tally, type Tally } from '../ledger.js'
import { loadEnv } from '../runner.js'

loadEnv()

/** An observed discrepancy. `expected`/`observed` are always exact strings. */
interface Divergence {
  invariant: string
  subject: string
  expected: string
  observed: string
  consequence: string
}

/**
 * The counter rebuilt from the events alone.
 *
 * Same shape as `Tally` so that the comparison is field by field and not
 * "roughly the same thing". The amounts come from the payloads: `fee` and
 * `refunded` from `WarrantHonored`, `amount` from `WarrantSlashed`, `refunded`
 * from `WarrantReclaimed`. No multiplication by `feeBps` here — that is the whole
 * point.
 */
function tallyFromEvents(warrants: Iterable<EventWarrant>): Tally {
  let opened = 0
  let honored = 0
  let slashed = 0
  let reclaimed = 0
  let open = 0
  let locked = 0n
  let destroyed = 0n
  let fees = 0n
  let refunded = 0n
  for (const w of warrants) {
    opened += 1
    if (w.honored) {
      honored += 1
      fees += w.honored.fee
      refunded += w.honored.refunded
    } else if (w.slashed) {
      slashed += 1
      destroyed += w.slashed.amount
    } else if (w.reclaimed) {
      reclaimed += 1
      refunded += w.reclaimed.refunded
    } else {
      open += 1
      locked += w.bond
    }
  }
  const settled = honored + slashed
  const d6 = (a: bigint) => `${a / 1_000_000n}.${(a % 1_000_000n).toString(10).padStart(6, '0')}`
  return {
    opened,
    honored,
    slashed,
    reclaimed,
    open,
    locked: locked.toString(10),
    locked_usdc: d6(locked),
    destroyed: destroyed.toString(10),
    destroyed_usdc: d6(destroyed),
    fees: fees.toString(10),
    fees_usdc: d6(fees),
    refunded: refunded.toString(10),
    refunded_usdc: d6(refunded),
    slashRateBps: settled === 0 ? 0 : Math.round((slashed * 10_000) / settled),
  }
}

function compareTallies(
  label: string,
  fromState: Tally,
  fromEvents: Tally,
  out: Divergence[],
): void {
  const fields: (keyof Tally)[] = [
    'opened',
    'honored',
    'slashed',
    'reclaimed',
    'open',
    'locked',
    'destroyed',
    'fees',
    'refunded',
    'slashRateBps',
  ]
  for (const f of fields) {
    if (String(fromState[f]) !== String(fromEvents[f])) {
      out.push({
        invariant: 'I-A state ≡ events',
        subject: `${label}.${f}`,
        expected: `${String(fromEvents[f])} (events)`,
        observed: `${String(fromState[f])} (getWarrant)`,
        consequence:
          'the published counter does not describe what the chain emitted: as it ' +
          'stands it has no evidential value',
      })
    }
  }
}

async function main(): Promise<void> {
  const jsonOnly = process.argv.includes('--json')
  const chainId = integer('WARRANT_ESCROW_CHAIN_ID', 84532)
  const escrow = address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS')) as Address
  const token = address('WARRANT_ASSET', required('WARRANT_ASSET')) as Address
  const campaign = optional('RUNNER_CAMPAIGN', 'hackathon')
  const client = publicClientFor(chainId, optional('WARRANT_ESCROW_RPC', 'https://sepolia.base.org'))

  const observed = await client.getChainId()
  if (observed !== chainId) {
    throw new Error(`the RPC answers chainId ${observed}, expected ${chainId}`)
  }

  const roles = await readEscrowRoles(client, escrow)

  // ── The scan, over the contract's whole history ───────────────────────────
  const deployed = await deploymentBlock(client, escrow)
  const from = bigint('VERIFY_FROM_BLOCK', deployed.block)
  const scan = await scanWarrantEvents(client, escrow, from, deployed.head)

  // ── The ledger, and the warrants it claims ────────────────────────────────
  const repoRoot = resolve(
    optional('RUNNER_REPO_ROOT', new URL('../../../../', import.meta.url).pathname),
  )
  const ledger = openLedger(
    resolve(repoRoot, optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl')),
    campaign,
  )
  const records = ledger.all()
  const journalIds = records.map((r) => r.id.toLowerCase() as Hex)
  const campaignIds = new Set(
    records.filter((r) => r.runner?.campaign === campaign).map((r) => r.id.toLowerCase()),
  )
  const state = await readWarrants(client, escrow, journalIds)

  const divergences: Divergence[] = []

  // ── I-A: state ≡ events, over the intersection ────────────────────────────
  //
  // The intersection and not the union: comparing an events total over the *whole*
  // history against a state total over *the ledger's ids* would measure the
  // ledger's coverage (that is I-F) and not the agreement of the two reads.
  const intersection = journalIds.filter((id) => scan.warrants.has(id))
  compareTallies(
    'ledger',
    tally(intersection.map((id) => state.get(id)!).filter(Boolean)),
    tallyFromEvents(intersection.map((id) => scan.warrants.get(id)!)),
    divergences,
  )
  const campaignIntersection = intersection.filter((id) => campaignIds.has(id))
  compareTallies(
    `campaign(${campaign})`,
    tally(campaignIntersection.map((id) => state.get(id)!).filter(Boolean)),
    tallyFromEvents(campaignIntersection.map((id) => scan.warrants.get(id)!)),
    divergences,
  )

  // ── I-B: `totalLocked()` == Σ bond of the open ones, per the events ────────
  const eventsAll = tallyFromEvents(scan.warrants.values())
  if (roles.totalLocked.toString(10) !== eventsAll.locked) {
    divergences.push({
      invariant: 'I-B totalLocked() ≡ Σ bond of the open ones',
      subject: 'escrow.totalLocked()',
      expected: `${eventsAll.locked} (Σ bond of the ${eventsAll.open} warrants open per the events)`,
      observed: roles.totalLocked.toString(10),
      consequence:
        'an open warrant escapes the scan (block window too short) or the contract ' +
        'locks up capital attached to no warrant at all',
    })
  }

  // ── I-C / I-D: conservation, warrant by warrant ───────────────────────────
  for (const w of scan.warrants.values()) {
    if (w.honored && w.honored.refunded + w.honored.fee !== w.bond) {
      divergences.push({
        invariant: 'I-C refunded + fee ≡ bond',
        subject: w.id,
        expected: w.bond.toString(10),
        observed: `${w.honored.refunded} + ${w.honored.fee}`,
        consequence: 'some of the bond vanished between the deposit and the settlement',
      })
    }
    if (w.slashed && w.slashed.amount !== w.bond) {
      divergences.push({
        invariant: 'I-D amount ≡ bond',
        subject: w.id,
        expected: w.bond.toString(10),
        observed: w.slashed.amount.toString(10),
        consequence: 'partial slash: the contract should not know how to produce one',
      })
    }
  }
  if (scan.orphanSettlements.length > 0) {
    divergences.push({
      invariant: 'I-B settlements attached',
      subject: `${scan.orphanSettlements.length} settlement(s) with no opening`,
      expected: '0',
      observed: scan.orphanSettlements.slice(0, 5).join(', '),
      consequence:
        `the scan starts at block ${from} and misses the opening of these warrants: ` +
        'lower VERIFY_FROM_BLOCK',
    })
  }

  // ── I-E: the fees really did land in the treasury ─────────────────────────
  const treasuryUsdc = await usdcBalance(client, token, roles.treasury)
  const feesTotal = BigInt(eventsAll.fees)
  if (treasuryUsdc < feesTotal) {
    divergences.push({
      invariant: 'I-E treasury ≥ Σ fees',
      subject: roles.treasury,
      expected: `≥ ${feesTotal}`,
      observed: treasuryUsdc.toString(10),
      consequence:
        'fees counted in the counter were never transferred — the counter describes ' +
        'an intention, not a movement of funds',
    })
  }

  // ── I-F: ledger coverage, both ways ───────────────────────────────────────
  const missingFromChain = journalIds.filter((id) => !scan.warrants.has(id))
  if (missingFromChain.length > 0) {
    divergences.push({
      invariant: 'I-F ledger ⊆ events',
      subject: `${missingFromChain.length} warrant(s) claimed and not found`,
      expected: '0',
      observed: missingFromChain.slice(0, 5).join(', '),
      consequence:
        'the ledger claims warrants the chain does not know about: the announced ' +
        'volume is overstated by that much',
    })
  }
  const ours = new Set(journalIds)
  // Only **our** agents' warrants concern us: the escrow is public, and a third
  // party opening a warrant on it is not a defect of our accounting.
  const ourAgents = new Set(records.map((r) => r.agent.toLowerCase()))
  const agentUnjournaled = [...scan.warrants.values()].filter(
    (w) => !ours.has(w.id) && ourAgents.has(w.agent),
  )
  if (agentUnjournaled.length > 0) {
    divergences.push({
      invariant: "F-1 our agent's warrants ⊆ ledger",
      subject: `${agentUnjournaled.length} warrant(s) opened outside the ledger`,
      expected: '0',
      observed: agentUnjournaled
        .slice(0, 5)
        .map((w) => `${w.id}@${w.openedAtBlock}`)
        .join(', '),
      consequence:
        'these warrants are ORPHANS: the Settler does not have their ConditionSpec, ' +
        'it will refuse to judge, and their bond waits for reclaim() at expiry',
    })
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const report = {
    at: new Date().toISOString(),
    chainId,
    escrow,
    campaign,
    scan: {
      fromBlock: scan.fromBlock.toString(10),
      toBlock: scan.toBlock.toString(10),
      blocks: (scan.toBlock - scan.fromBlock + 1n).toString(10),
      getLogsRequests: scan.requests,
      deploymentBlock: deployed.block.toString(10),
      completeHistory: deployed.complete,
    },
    escrowOnchain: {
      opener: roles.opener,
      settler: roles.settler,
      treasury: roles.treasury,
      feeBps: roles.feeBps,
      totalLocked: roles.totalLocked.toString(10),
      treasuryUsdc: treasuryUsdc.toString(10),
    },
    allEscrowWarrants_events: eventsAll,
    ledger_events: tallyFromEvents(intersection.map((id) => scan.warrants.get(id)!)),
    ledger_state: tally(intersection.map((id) => state.get(id)!).filter(Boolean)),
    campaign_events: tallyFromEvents(campaignIntersection.map((id) => scan.warrants.get(id)!)),
    campaign_state: tally(campaignIntersection.map((id) => state.get(id)!).filter(Boolean)),
    journalRecords: records.length,
    ourAgentsWarrantsOutsideLedger: agentUnjournaled.length,
    divergences,
    verdict: divergences.length === 0 ? 'RECONCILED' : 'DIVERGENT',
  }

  if (!jsonOnly) {
    const e = report.campaign_events
    const g = report.allEscrowWarrants_events
    console.error(
      [
        '',
        `WARRANT — onchain cross-check (chainId ${chainId}, escrow ${escrow})`,
        `scan ${scan.fromBlock}..${scan.toBlock} (${scan.toBlock - scan.fromBlock + 1n} blocks, ` +
          `${scan.requests} eth_getLogs requests, deployed at block ${deployed.block})`,
        '',
        `Whole escrow, from the EVENTS alone`,
        `  warrants opened ............. ${g.opened}`,
        `  honored ..................... ${g.honored}`,
        `  slashed ..................... ${g.slashed}`,
        `  reclaimed ................... ${g.reclaimed}`,
        `  still open .................. ${g.open}`,
        `  capital locked .............. ${g.locked_usdc} USDC  (totalLocked() = ${usdc(roles.totalLocked)})`,
        `  capital destroyed ........... ${g.destroyed_usdc} USDC`,
        `  fees collected .............. ${g.fees_usdc} USDC  (treasury = ${usdc(treasuryUsdc)})`,
        `  capital returned to agent ... ${g.refunded_usdc} USDC`,
        '',
        `Campaign "${campaign}", from the EVENTS`,
        `  opened ${e.opened} · honored ${e.honored} · slashed ${e.slashed} · ` +
          `reclaimed ${e.reclaimed} · still open ${e.open}`,
        `  destroyed ${e.destroyed_usdc} · fees ${e.fees_usdc} · returned ${e.refunded_usdc} USDC`,
        '',
        divergences.length === 0
          ? "✓ RECONCILED — state, events, ledger and the contract's own aggregates agree (I-A…I-F)"
          : `✗ DIVERGENT — ${divergences.length} discrepancy(ies):`,
        ...divergences.map(
          (d) => `    [${d.invariant}] ${d.subject}\n      expected ${d.expected}\n      observed ${d.observed}\n      → ${d.consequence}`,
        ),
        '',
      ].join('\n'),
    )
  }
  console.log(JSON.stringify(report, null, 2))
  if (divergences.length > 0) process.exit(1)
}

main().catch((e: unknown) => {
  console.error(
    JSON.stringify({ msg: 'verify: failed', error: e instanceof Error ? e.message : String(e) }),
  )
  process.exit(1)
})
