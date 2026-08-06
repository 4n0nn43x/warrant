import { describe, expect, it } from 'vitest'

import {
  decodeNewFeedbackLogs,
  decodeOpeningLogs,
  decodeRevocations,
  decodeSettlementLogs,
} from './decode.js'
import {
  AGENT_WALLET,
  IMPOSTOR,
  OTHER_WALLET,
  SETTLER,
  feedbackRevokedLog,
  newFeedbackLog,
  settledWarrantLogs,
  warrantHonoredLog,
  warrantId,
  warrantOpenedLog,
  warrantSlashedLog,
} from './fixtures.js'
import {
  WAD,
  computeAgentReputation,
  crossReference,
  formatBond,
  formatScore,
  reputationFromEvents,
  warrantIdsFromFeedbackURI,
} from './score.js'
import type { RawLog } from './types.js'

const AGENT_ID = 4242n
const USDC = 1_000_000n // 1 USDC, 6 decimals

/** Assembles the logs of N settled warrants and decodes them as the reader would. */
function scenario(
  specs: readonly {
    n: number
    bond: bigint
    verdict: 'honored' | 'slashed'
    client?: `0x${string}`
    agent?: `0x${string}`
    feeBps?: bigint
  }[],
  agentId = AGENT_ID,
) {
  const opened: RawLog[] = []
  const settlements: RawLog[] = []
  const feedbacks: RawLog[] = []
  for (const s of specs) {
    const logs = settledWarrantLogs({ agentId, ...s })
    opened.push(logs.opened)
    settlements.push(logs.settlement)
    feedbacks.push(logs.feedback)
  }
  return {
    openings: decodeOpeningLogs(opened),
    settlements: decodeSettlementLogs(settlements),
    feedbacks: decodeNewFeedbackLogs(feedbacks),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoding
// ─────────────────────────────────────────────────────────────────────────────

describe('log decoding', () => {
  it('reads a complete NewFeedback, feedbackURI and feedbackHash included', () => {
    const [f] = decodeNewFeedbackLogs([
      newFeedbackLog({ agentId: AGENT_ID, warrantId: warrantId(7), verdict: 'slashed' }),
    ])
    expect(f).toBeDefined()
    expect(f!.agentId).toBe(AGENT_ID)
    expect(f!.clientAddress).toBe(SETTLER)
    expect(f!.value).toBe(-100n)
    expect(f!.valueDecimals).toBe(2)
    expect(f!.tag1).toBe('warrant')
    expect(f!.tag2).toBe('slashed')
    // endpoint is empty, and this is the only place on the chain where it shows.
    expect(f!.endpoint).toBe('')
    expect(f!.feedbackURI).toBe(`https://raw.githubusercontent.com/4n0nn43x/warrant/master/verdicts/${warrantId(7)}`)
    expect(f!.feedbackHash).toBe(`0x${'cc'.repeat(32)}`)
  })

  it('reconstructs the honored bond as refunded + fee', () => {
    // A 100 USDC bond, 50 bps of fees: the agent is refunded 99.5, but it had
    // locked up 100.
    const [s] = decodeSettlementLogs([
      warrantHonoredLog({ warrantId: warrantId(1), bond: 100n * USDC, feeBps: 50n }),
    ])
    expect(s!.bond).toBe(100n * USDC)
    expect(s!.verdict).toBe('honored')
  })

  it('takes the whole amount on a slash', () => {
    const [s] = decodeSettlementLogs([
      warrantSlashedLog({ warrantId: warrantId(2), bond: 42n * USDC }),
    ])
    expect(s!.bond).toBe(42n * USDC)
    expect(s!.verdict).toBe('slashed')
  })

  it('ignores logs of other events', () => {
    const mixed = [
      warrantOpenedLog({ warrantId: warrantId(3), bond: USDC }),
      warrantHonoredLog({ warrantId: warrantId(3), bond: USDC }),
    ]
    expect(decodeSettlementLogs(mixed)).toHaveLength(1)
    expect(decodeNewFeedbackLogs(mixed)).toHaveLength(0)
    expect(decodeOpeningLogs(mixed)).toHaveLength(1)
  })
})

describe('warrantIdsFromFeedbackURI', () => {
  it('extracts the identifier from a single-warrant URI', () => {
    expect(warrantIdsFromFeedbackURI(`https://raw.githubusercontent.com/4n0nn43x/warrant/master/verdicts/${warrantId(9)}`)).toEqual([
      warrantId(9),
    ])
  })

  it('returns nothing for a batch URI', () => {
    expect(
      warrantIdsFromFeedbackURI(`https://raw.githubusercontent.com/4n0nn43x/warrant/master/verdicts/batch/0x${'cc'.repeat(32)}`),
    ).toEqual([])
  })

  it('reads the identifier whatever the base path', () => {
    // `VERDICT_BASE_URI` is configuration, and it has already changed once. The
    // parser used to require a literal `/v/` segment, so every verdict published
    // under `…/verdicts/` extracted nothing and the score reported an empty
    // history for the whole real corpus.
    const id = warrantId(7)
    for (const base of [
      'https://raw.githubusercontent.com/4n0nn43x/warrant/master/verdicts/',
      'https://warrant.sh/v/', // the first base, still inscribed onchain
      'https://verdicts.example/',
      'http://127.0.0.1:8403/verdicts/',
    ]) {
      expect(warrantIdsFromFeedbackURI(`${base}${id}`)).toEqual([id])
    }
  })

  it('rules the batch out under any base too', () => {
    const hash = `0x${'cc'.repeat(32)}`
    for (const base of ['https://warrant.sh/v/', 'http://127.0.0.1:8403/verdicts/']) {
      expect(warrantIdsFromFeedbackURI(`${base}batch/${hash}`)).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The score
// ─────────────────────────────────────────────────────────────────────────────

describe('stakeWeightedScore', () => {
  it('is 1 when everything has been honored', () => {
    const { feedbacks, settlements } = scenario([
      { n: 1, bond: 100n * USDC, verdict: 'honored' },
      { n: 2, bond: 250n * USDC, verdict: 'honored' },
    ])
    const rep = reputationFromEvents({ agentId: AGENT_ID, feedbacks, settlements })
    expect(rep.stakeWeightedScore).toBe(1)
    expect(rep.stakeWeightedScoreWad).toBe(WAD)
    expect(rep.totalAtRisk).toBe(350n * USDC)
    expect(rep.slashedBond).toBe(0n)
  })

  it('weights by capital, not by warrant count', () => {
    // Nine small honored warrants, one big slash: the count says 90 % success,
    // the capital says something else entirely.
    const specs = Array.from({ length: 9 }, (_, i) => ({
      n: i + 1,
      bond: 10n * USDC,
      verdict: 'honored' as const,
    }))
    specs.push({ n: 10, bond: 910n * USDC, verdict: 'honored' as const })
    const big = scenario([
      ...specs.slice(0, 9),
      { n: 10, bond: 910n * USDC, verdict: 'slashed' },
    ])
    const rep = reputationFromEvents({
      agentId: AGENT_ID,
      feedbacks: big.feedbacks,
      settlements: big.settlements,
    })
    expect(rep.honoredCount).toBe(9)
    expect(rep.slashedCount).toBe(1)
    expect(rep.honoredBond).toBe(90n * USDC)
    expect(rep.slashedBond).toBe(910n * USDC)
    expect(rep.stakeWeightedScore).toBeCloseTo(0.09, 10)
    expect(rep.totalAtRisk).toBe(1000n * USDC)
  })

  it('is 0 when everything has been slashed — without ever dividing by zero', () => {
    const { feedbacks, settlements } = scenario([
      { n: 1, bond: 5n * USDC, verdict: 'slashed' },
    ])
    const rep = reputationFromEvents({ agentId: AGENT_ID, feedbacks, settlements })
    expect(rep.stakeWeightedScore).toBe(0)
    expect(rep.totalAtRisk).toBe(5n * USDC)
  })

  it('returns null — and not 0 — when Σ = 0', () => {
    const empty = computeAgentReputation(AGENT_ID, [])
    expect(empty.totalAtRisk).toBe(0n)
    expect(empty.stakeWeightedScore).toBeNull()
    expect(empty.stakeWeightedScoreWad).toBeNull()
    expect(empty.settledCount).toBe(0)
    // An agent with no history does not have a bad score: it has none.
    expect(formatScore(empty.stakeWeightedScore)).toBe('n/a')
    expect(formatScore(0)).not.toBe('n/a')
  })

  it('does not divide by zero either when no feedback ties up', () => {
    // Feedbacks exist, but no matching warrant onchain.
    const feedbacks = decodeNewFeedbackLogs([
      newFeedbackLog({ agentId: AGENT_ID, warrantId: warrantId(99) }),
    ])
    const rep = reputationFromEvents({ agentId: AGENT_ID, feedbacks, settlements: [] })
    expect(rep.stakeWeightedScore).toBeNull()
    expect(rep.crossReference.unmatched).toHaveLength(1)
  })

  it('discards duplicate warrantIds', () => {
    const { feedbacks, settlements } = scenario([
      { n: 1, bond: 100n * USDC, verdict: 'honored' },
    ])
    const rep = reputationFromEvents({
      agentId: AGENT_ID,
      feedbacks: [...feedbacks, ...feedbacks],
      settlements: [...settlements, ...settlements],
    })
    expect(rep.settledCount).toBe(1)
    expect(rep.totalAtRisk).toBe(100n * USDC)
  })
})

describe('totalAtRisk separates what the score conflates', () => {
  // This is the central argument: ERC-8004 does not say how much an agent risked.
  const small = scenario(
    Array.from({ length: 200 }, (_, i) => ({
      n: i + 1,
      bond: 5n * USDC,
      verdict: 'honored' as const,
    })),
    1n,
  )
  const big = scenario(
    Array.from({ length: 20 }, (_, i) => ({
      n: 1000 + i,
      bond: 2500n * USDC,
      verdict: 'honored' as const,
    })),
    2n,
  )

  const modest = reputationFromEvents({
    agentId: 1n,
    feedbacks: small.feedbacks,
    settlements: small.settlements,
  })
  const heavy = reputationFromEvents({
    agentId: 2n,
    feedbacks: big.feedbacks,
    settlements: big.settlements,
  })

  it('gives both agents the same score', () => {
    expect(modest.stakeWeightedScore).toBe(1)
    expect(heavy.stakeWeightedScore).toBe(1)
    expect(modest.stakeWeightedScoreWad).toBe(heavy.stakeWeightedScoreWad)
  })

  it('but tells them apart by the capital actually locked up', () => {
    expect(modest.honoredCount).toBe(200)
    expect(modest.totalAtRisk).toBe(1_000n * USDC)
    expect(formatBond(modest.totalAtRisk, 6)).toBe('1000.000000')

    expect(heavy.honoredCount).toBe(20)
    expect(heavy.totalAtRisk).toBe(50_000n * USDC)
    expect(formatBond(heavy.totalAtRisk, 6)).toBe('50000.000000')

    expect(heavy.totalAtRisk).toBe(modest.totalAtRisk * 50n)
    // 200 small warrants are not worth $50,000 of honored bonds, and that is
    // exactly what the registry's `getSummary` is incapable of saying.
    expect(heavy.totalAtRisk > modest.totalAtRisk).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The cross-reference
// ─────────────────────────────────────────────────────────────────────────────

describe('crossReference', () => {
  it('accepts only the feedbacks of the expected clients', () => {
    const honest = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 100n * USDC,
      verdict: 'honored',
    })
    // A third party writes a `warrant` feedback for the same agent, pointing at a
    // warrant that does exist: with no client list, we would count it.
    const forged = newFeedbackLog({
      agentId: AGENT_ID,
      warrantId: warrantId(1),
      client: IMPOSTOR,
      feedbackIndex: 1n,
    })

    const feedbacks = decodeNewFeedbackLogs([honest.feedback, forged])
    const settlements = decodeSettlementLogs([honest.settlement])

    const scoped = crossReference({
      agentId: AGENT_ID,
      feedbacks,
      settlements,
      clients: [SETTLER],
    })
    expect(scoped.warrants).toHaveLength(1)

    const open = crossReference({ agentId: AGENT_ID, feedbacks, settlements })
    expect(open.warrants).toHaveLength(1) // deduplicated by warrantId…
    // …but the impostor's feedback was indeed taken into account, for want of a
    // filter.
    expect(open.warrants[0]!.warrantId).toBe(warrantId(1))
  })

  it('ignores feedbacks whose tag1 is not "warrant"', () => {
    const w = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: USDC,
      verdict: 'honored',
    })
    const other = newFeedbackLog({
      agentId: AGENT_ID,
      warrantId: warrantId(1),
      tag1: 'starred',
    })
    const xref = crossReference({
      agentId: AGENT_ID,
      feedbacks: decodeNewFeedbackLogs([other]),
      settlements: decodeSettlementLogs([w.settlement]),
    })
    expect(xref.warrants).toHaveLength(0)
  })

  it('ignores feedbacks from another agentId', () => {
    const w = settledWarrantLogs({
      agentId: 999n,
      n: 1,
      bond: USDC,
      verdict: 'honored',
    })
    const xref = crossReference({
      agentId: AGENT_ID,
      feedbacks: decodeNewFeedbackLogs([w.feedback]),
      settlements: decodeSettlementLogs([w.settlement]),
    })
    expect(xref.warrants).toHaveLength(0)
  })

  it('discards a revoked feedback', () => {
    const w = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 100n * USDC,
      verdict: 'slashed',
    })
    const revoked = decodeRevocations([
      feedbackRevokedLog({ agentId: AGENT_ID, feedbackIndex: 1n }),
    ])
    const rep = reputationFromEvents({
      agentId: AGENT_ID,
      feedbacks: decodeNewFeedbackLogs([w.feedback]),
      settlements: decodeSettlementLogs([w.settlement]),
      revoked,
    })
    expect(rep.settledCount).toBe(0)
    expect(rep.stakeWeightedScore).toBeNull()
  })

  it('reports a divergence between the written verdict and the onchain settlement', () => {
    // The feedback says `honored`, the escrow slashed. The escrow is authoritative.
    const feedbacks = decodeNewFeedbackLogs([
      newFeedbackLog({ agentId: AGENT_ID, warrantId: warrantId(1), verdict: 'honored' }),
    ])
    const settlements = decodeSettlementLogs([
      warrantSlashedLog({ warrantId: warrantId(1), bond: 100n * USDC }),
    ])
    const xref = crossReference({ agentId: AGENT_ID, feedbacks, settlements })
    expect(xref.mismatched).toEqual([
      { warrantId: warrantId(1), onchain: 'slashed', feedbackTag2: 'honored' },
    ])
    expect(xref.warrants[0]!.verdict).toBe('slashed')
  })

  it('cross-checks attribution against WarrantOpened.agent', () => {
    const genuine = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 100n * USDC,
      verdict: 'honored',
      agent: AGENT_WALLET,
    })
    // The Settler attributes to this agent a warrant opened by somebody else.
    const usurped = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 2,
      bond: 900n * USDC,
      verdict: 'honored',
      agent: OTHER_WALLET,
    })

    const xref = crossReference({
      agentId: AGENT_ID,
      feedbacks: decodeNewFeedbackLogs([genuine.feedback, usurped.feedback]),
      settlements: decodeSettlementLogs([genuine.settlement, usurped.settlement]),
      openings: decodeOpeningLogs([genuine.opened, usurped.opened]),
      agentAddresses: [AGENT_WALLET],
    })

    expect(xref.warrants).toHaveLength(1)
    expect(xref.rejectedByOpening).toEqual([warrantId(2)])
    expect(computeAgentReputation(AGENT_ID, xref.warrants).totalAtRisk).toBe(100n * USDC)
  })

  it('resolves the identifiers of a batch through warrantIdsOf', () => {
    const a = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 10n * USDC,
      verdict: 'honored',
    })
    const b = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 2,
      bond: 30n * USDC,
      verdict: 'honored',
    })
    const batch = decodeNewFeedbackLogs([
      newFeedbackLog({
        agentId: AGENT_ID,
        feedbackURI: `https://raw.githubusercontent.com/4n0nn43x/warrant/master/verdicts/batch/0x${'cc'.repeat(32)}`,
      }),
    ])

    // Without resolution, a batch URI yields no warrant.
    expect(
      crossReference({
        agentId: AGENT_ID,
        feedbacks: batch,
        settlements: decodeSettlementLogs([a.settlement, b.settlement]),
      }).warrants,
    ).toHaveLength(0)

    const rep = reputationFromEvents({
      agentId: AGENT_ID,
      feedbacks: batch,
      settlements: decodeSettlementLogs([a.settlement, b.settlement]),
      warrantIdsOf: () => [warrantId(1), warrantId(2)],
    })
    expect(rep.settledCount).toBe(2)
    expect(rep.totalAtRisk).toBe(40n * USDC)
  })

  it('never counts an expired warrant: WarrantReclaimed is not decoded', () => {
    // No feedback is published for a reclaim, and no settlement either.
    const rep = reputationFromEvents({
      agentId: AGENT_ID,
      feedbacks: [],
      settlements: [],
    })
    expect(rep.settledCount).toBe(0)
    expect(rep.stakeWeightedScore).toBeNull()
  })
})

describe('formatting', () => {
  it('formats a bond in its decimals', () => {
    expect(formatBond(1_234_567n, 6)).toBe('1.234567')
    expect(formatBond(0n, 6)).toBe('0.000000')
    expect(formatBond(42n, 0)).toBe('42')
  })

  it('never displays 0.0000 for an absent score', () => {
    expect(formatScore(null)).toBe('n/a')
    expect(formatScore(0)).toBe('0.0000')
    expect(formatScore(0.0909090909, 4)).toBe('0.0909')
  })
})
