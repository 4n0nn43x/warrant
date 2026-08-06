/**
 * The stake-weighted score — Warrant's real contribution to ERC-8004.
 *
 *   stakeWeightedScore(agent) = Σ(bond_honored) / (Σ(bond_honored) + Σ(bond_slashed))
 *   totalAtRisk(agent)        = Σ(bond) over every settled warrant
 *
 * The registry's `getSummary` gives an average of ratings: it treats 200 warrants
 * at $5 the same as 200 warrants at $250. What the registry does not say — **how
 * much an agent has actually put at risk** — is derived from the escrow's events,
 * without trusting Warrant.
 *
 * What this computation assumes, stated plainly:
 *
 *   - the **amounts** assume nothing: they come from the `WarrantHonored` /
 *     `WarrantSlashed` events of the escrow contract, which moved the funds
 *     itself;
 *   - the **attribution** of a warrant to an `agentId` comes from the
 *     `feedbackURI` written by the Settler. So we trust the Settler on the link,
 *     not on the sums. That link can be cross-checked independently against
 *     `WarrantOpened.agent`: see the `agentAddresses` option.
 *
 * This whole file is pure. No I/O, no network, nothing to mock.
 */

import type {
  Address,
  FeedbackRecord,
  Hex,
  OpeningRecord,
  SettledWarrant,
  SettlementRecord,
  Verdict,
} from './types.js'

import { feedbackKey } from './decode.js'

/** Fixed-point factor used for the exact score. */
export const WAD = 10n ** 18n

/** The `tag1` under which Warrant writes its verdicts. */
export const WARRANT_TAG1 = 'warrant'

export interface AgentReputation {
  agentId: bigint
  /** Number of settled warrants taken into account. */
  settledCount: number
  honoredCount: number
  slashedCount: number
  /** Σ of the bonds of honored warrants, in atomic units. */
  honoredBond: bigint
  /** Σ of the bonds of slashed warrants, in atomic units. */
  slashedBond: bigint
  /** Σ of the bonds over every settled warrant. What the agent has put at stake. */
  totalAtRisk: bigint
  /**
   * The score, in 1e18 fixed point. `null` when no warrant has been settled —
   * the absence of a score is not a score of 0.
   */
  stakeWeightedScoreWad: bigint | null
  /** The same score as a float, for display. `null` in the same case. */
  stakeWeightedScore: number | null
  warrants: SettledWarrant[]
}

/**
 * Computes an agent's score from its settled warrants.
 *
 * Duplicate `warrantId`s are discarded: a warrant is settled only once (an escrow
 * invariant), and a window of logs re-requested after a reorg may report two
 * copies of it. First seen wins.
 *
 * When Σ = 0, `stakeWeightedScore` is `null` — never 0, never 1, and above all no
 * division at all. An agent with no settled warrant does not have a bad score: it
 * has none.
 */
export function computeAgentReputation(
  agentId: bigint,
  warrants: readonly SettledWarrant[],
): AgentReputation {
  const seen = new Set<string>()
  const kept: SettledWarrant[] = []

  let honoredBond = 0n
  let slashedBond = 0n
  let honoredCount = 0
  let slashedCount = 0

  for (const w of warrants) {
    const id = w.warrantId.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(w)
    if (w.verdict === 'honored') {
      honoredBond += w.bond
      honoredCount += 1
    } else {
      slashedBond += w.bond
      slashedCount += 1
    }
  }

  const totalAtRisk = honoredBond + slashedBond
  const scoreWad = totalAtRisk === 0n ? null : (honoredBond * WAD) / totalAtRisk

  return {
    agentId,
    settledCount: kept.length,
    honoredCount,
    slashedCount,
    honoredBond,
    slashedBond,
    totalAtRisk,
    stakeWeightedScoreWad: scoreWad,
    stakeWeightedScore: scoreWad === null ? null : Number(scoreWad) / Number(WAD),
    warrants: kept,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-referencing feedbacks ↔ settlements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the warrant identifiers from a `feedbackURI`.
 *
 * A single warrant's document is addressed by its own identifier as the last
 * path segment: `<base><warrantId>`. A batch is addressed by the **hash of the
 * document** instead (`<base>batch/<feedbackHash>`), which is not a warrant id
 * and resolves to nothing here — the document has to be downloaded, which the
 * caller does through the `warrantIdsOf` option.
 *
 * Deliberately **path-agnostic**. This used to require a literal `/v/` segment,
 * the shape of the very first publication base. Every verdict published since
 * lives under `…/verdicts/<warrantId>`, so the match silently returned nothing
 * and the score counted zero settled warrants for the entire real corpus. The
 * base is configuration — `VERDICT_BASE_URI` — and reading configuration out of
 * a hardcoded path is what made a base change look like an empty history.
 */
export function warrantIdsFromFeedbackURI(uri: string): Hex[] {
  const trimmed = uri.trim()
  // A batch first: its trailing hash has the same shape as a warrant id, so
  // matching the identifier before ruling the batch out would attribute the
  // document to a warrant that does not exist.
  if (/\/batch\/0x[0-9a-fA-F]{64}\s*$/.test(trimmed)) return []
  const m = /\/(0x[0-9a-fA-F]{64})\s*$/.exec(trimmed)
  return m?.[1] ? [m[1].toLowerCase() as Hex] : []
}

export interface CrossReferenceOptions {
  agentId: bigint
  feedbacks: readonly FeedbackRecord[]
  settlements: readonly SettlementRecord[]
  /**
   * Client addresses accepted. **To be filled in, in practice**: anyone can write
   * a `tag1='warrant'` feedback for any agent, and without this restriction we
   * would count the warrants of an unknown Settler. Empty or absent = every
   * client, which only makes sense while exploring.
   */
  clients?: readonly Address[]
  /** Revoked `agentId:client:index` keys, cf. `decodeRevocations`. */
  revoked?: ReadonlySet<string>
  /** Resolution of a feedback's warrant identifiers. Default: the URI. */
  warrantIdsOf?: (feedback: FeedbackRecord) => readonly Hex[]
  /**
   * Warrant openings, to cross-check attribution without believing the Settler.
   * Combined with `agentAddresses`, it discards every warrant whose onchain agent
   * is not one of those expected.
   */
  openings?: readonly OpeningRecord[]
  /** Known onchain addresses of the agent. Ignored without `openings`. */
  agentAddresses?: readonly Address[]
}

export interface CrossReferenceResult {
  warrants: SettledWarrant[]
  /** Feedbacks none of whose warrants could be tied to an onchain settlement. */
  unmatched: FeedbackRecord[]
  /** The written verdict and the onchain settlement diverge. The chain wins. */
  mismatched: { warrantId: Hex; onchain: Verdict; feedbackTag2: string }[]
  /** Warrants discarded because `WarrantOpened.agent` did not match. */
  rejectedByOpening: Hex[]
}

/**
 * Cross-references ERC-8004's `NewFeedback` events with `WarrantEscrow`'s
 * settlements.
 *
 * The verdict retained is **the escrow's**, never the feedback's: the former
 * moved funds, the latter is a declaration. A divergence is reported rather than
 * silently arbitrated.
 */
export function crossReference(opts: CrossReferenceOptions): CrossReferenceResult {
  const bySettlement = new Map<string, SettlementRecord>()
  for (const s of opts.settlements) {
    const id = s.warrantId.toLowerCase()
    if (!bySettlement.has(id)) bySettlement.set(id, s)
  }

  const byOpening = new Map<string, OpeningRecord>()
  for (const o of opts.openings ?? []) {
    const id = o.warrantId.toLowerCase()
    if (!byOpening.has(id)) byOpening.set(id, o)
  }

  const allowedClients =
    opts.clients && opts.clients.length > 0
      ? new Set(opts.clients.map((c) => c.toLowerCase()))
      : undefined
  const allowedAgents =
    opts.agentAddresses && opts.agentAddresses.length > 0
      ? new Set(opts.agentAddresses.map((a) => a.toLowerCase()))
      : undefined

  const idsOf = opts.warrantIdsOf ?? ((f: FeedbackRecord) => warrantIdsFromFeedbackURI(f.feedbackURI))

  const warrants: SettledWarrant[] = []
  const unmatched: FeedbackRecord[] = []
  const mismatched: CrossReferenceResult['mismatched'] = []
  const rejectedByOpening: Hex[] = []
  const seen = new Set<string>()

  for (const f of opts.feedbacks) {
    if (f.agentId !== opts.agentId) continue
    if (f.tag1 !== WARRANT_TAG1) continue
    if (allowedClients && !allowedClients.has(f.clientAddress.toLowerCase())) continue
    if (opts.revoked?.has(feedbackKey(f.agentId, f.clientAddress, f.feedbackIndex))) {
      continue
    }

    let matchedAny = false
    for (const rawId of idsOf(f)) {
      const id = rawId.toLowerCase()
      const settlement = bySettlement.get(id)
      if (!settlement) continue
      matchedAny = true

      if (settlement.verdict !== f.tag2) {
        mismatched.push({
          warrantId: id as Hex,
          onchain: settlement.verdict,
          feedbackTag2: f.tag2,
        })
      }

      if (allowedAgents) {
        const opening = byOpening.get(id)
        if (!opening || !allowedAgents.has(opening.agent.toLowerCase())) {
          rejectedByOpening.push(id as Hex)
          continue
        }
      }

      if (seen.has(id)) continue
      seen.add(id)
      warrants.push({
        warrantId: id as Hex,
        verdict: settlement.verdict,
        bond: settlement.bond,
        blockNumber: settlement.blockNumber,
      })
    }

    if (!matchedAny) unmatched.push(f)
  }

  return { warrants, unmatched, mismatched, rejectedByOpening }
}

/** Cross-reference then compute, in one pass. The usual pure entry point. */
export function reputationFromEvents(
  opts: CrossReferenceOptions,
): AgentReputation & { crossReference: CrossReferenceResult } {
  const xref = crossReference(opts)
  return { ...computeAgentReputation(opts.agentId, xref.warrants), crossReference: xref }
}

/**
 * Formats a score for display. `null` becomes `'n/a'`: showing `0.00` for an
 * agent with no history would make it look like a failing one.
 */
export function formatScore(score: number | null, digits = 4): string {
  return score === null ? 'n/a' : score.toFixed(digits)
}

/** Formats an atomic amount in its decimal units (USDC: 6). */
export function formatBond(bond: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = bond / base
  const frac = (bond % base).toString().padStart(decimals, '0')
  return decimals === 0 ? whole.toString() : `${whole}.${frac}`
}
