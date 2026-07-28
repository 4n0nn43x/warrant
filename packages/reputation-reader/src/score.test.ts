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
const USDC = 1_000_000n // 1 USDC, 6 décimales

/** Assemble les logs de N mandats réglés et les décode comme le ferait le lecteur. */
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
// Décodage
// ─────────────────────────────────────────────────────────────────────────────

describe('décodage des logs', () => {
  it('lit un NewFeedback complet, feedbackURI et feedbackHash compris', () => {
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
    // endpoint est vide, et c'est le seul endroit de la chaîne où on le voit.
    expect(f!.endpoint).toBe('')
    expect(f!.feedbackURI).toBe(`https://warrant.sh/v/${warrantId(7)}`)
    expect(f!.feedbackHash).toBe(`0x${'cc'.repeat(32)}`)
  })

  it('reconstitue la caution honorée comme refunded + fee', () => {
    // 100 USDC de caution, 50 bps de frais : l'agent est remboursé 99.5,
    // mais il en avait immobilisé 100.
    const [s] = decodeSettlementLogs([
      warrantHonoredLog({ warrantId: warrantId(1), bond: 100n * USDC, feeBps: 50n }),
    ])
    expect(s!.bond).toBe(100n * USDC)
    expect(s!.verdict).toBe('honored')
  })

  it('prend la totalité du montant sur une saisie', () => {
    const [s] = decodeSettlementLogs([
      warrantSlashedLog({ warrantId: warrantId(2), bond: 42n * USDC }),
    ])
    expect(s!.bond).toBe(42n * USDC)
    expect(s!.verdict).toBe('slashed')
  })

  it('ignore les logs d’autres events', () => {
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
  it('extrait l’identifiant d’une URI de mandat isolé', () => {
    expect(warrantIdsFromFeedbackURI(`https://warrant.sh/v/${warrantId(9)}`)).toEqual([
      warrantId(9),
    ])
  })

  it('ne rend rien pour l’URI d’un lot', () => {
    expect(
      warrantIdsFromFeedbackURI(`https://warrant.sh/v/batch/0x${'cc'.repeat(32)}`),
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le score
// ─────────────────────────────────────────────────────────────────────────────

describe('stakeWeightedScore', () => {
  it('vaut 1 quand tout a été honoré', () => {
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

  it('pondère par le capital, pas par le nombre de mandats', () => {
    // Neuf petits mandats honorés, une grosse saisie : le compte dit 90 % de
    // réussite, le capital dit tout autre chose.
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

  it('vaut 0 quand tout a été saisi — sans jamais diviser par zéro', () => {
    const { feedbacks, settlements } = scenario([
      { n: 1, bond: 5n * USDC, verdict: 'slashed' },
    ])
    const rep = reputationFromEvents({ agentId: AGENT_ID, feedbacks, settlements })
    expect(rep.stakeWeightedScore).toBe(0)
    expect(rep.totalAtRisk).toBe(5n * USDC)
  })

  it('rend null — et non 0 — quand Σ = 0', () => {
    const empty = computeAgentReputation(AGENT_ID, [])
    expect(empty.totalAtRisk).toBe(0n)
    expect(empty.stakeWeightedScore).toBeNull()
    expect(empty.stakeWeightedScoreWad).toBeNull()
    expect(empty.settledCount).toBe(0)
    // Un agent sans historique n'a pas un mauvais score : il n'en a pas.
    expect(formatScore(empty.stakeWeightedScore)).toBe('n/a')
    expect(formatScore(0)).not.toBe('n/a')
  })

  it('ne divise pas par zéro non plus quand aucun feedback ne se relie', () => {
    // Des feedbacks existent, mais aucun mandat correspondant onchain.
    const feedbacks = decodeNewFeedbackLogs([
      newFeedbackLog({ agentId: AGENT_ID, warrantId: warrantId(99) }),
    ])
    const rep = reputationFromEvents({ agentId: AGENT_ID, feedbacks, settlements: [] })
    expect(rep.stakeWeightedScore).toBeNull()
    expect(rep.crossReference.unmatched).toHaveLength(1)
  })

  it('écarte les doublons de warrantId', () => {
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

describe('totalAtRisk sépare ce que le score confond', () => {
  // C'est l'argument central : ERC-8004 ne dit pas combien un agent a risqué.
  const petits = scenario(
    Array.from({ length: 200 }, (_, i) => ({
      n: i + 1,
      bond: 5n * USDC,
      verdict: 'honored' as const,
    })),
    1n,
  )
  const gros = scenario(
    Array.from({ length: 20 }, (_, i) => ({
      n: 1000 + i,
      bond: 2500n * USDC,
      verdict: 'honored' as const,
    })),
    2n,
  )

  const petit = reputationFromEvents({
    agentId: 1n,
    feedbacks: petits.feedbacks,
    settlements: petits.settlements,
  })
  const grand = reputationFromEvents({
    agentId: 2n,
    feedbacks: gros.feedbacks,
    settlements: gros.settlements,
  })

  it('donne le même score aux deux agents', () => {
    expect(petit.stakeWeightedScore).toBe(1)
    expect(grand.stakeWeightedScore).toBe(1)
    expect(petit.stakeWeightedScoreWad).toBe(grand.stakeWeightedScoreWad)
  })

  it('mais les distingue par le capital réellement immobilisé', () => {
    expect(petit.honoredCount).toBe(200)
    expect(petit.totalAtRisk).toBe(1_000n * USDC)
    expect(formatBond(petit.totalAtRisk, 6)).toBe('1000.000000')

    expect(grand.honoredCount).toBe(20)
    expect(grand.totalAtRisk).toBe(50_000n * USDC)
    expect(formatBond(grand.totalAtRisk, 6)).toBe('50000.000000')

    expect(grand.totalAtRisk).toBe(petit.totalAtRisk * 50n)
    // 200 petits mandats ne valent pas 50 000 $ de cautions honorées, et c'est
    // exactement ce que `getSummary` du registre est incapable de dire.
    expect(grand.totalAtRisk > petit.totalAtRisk).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le recoupement
// ─────────────────────────────────────────────────────────────────────────────

describe('crossReference', () => {
  it('n’accepte que les feedbacks des clients attendus', () => {
    const honnete = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 100n * USDC,
      verdict: 'honored',
    })
    // Un tiers inscrit un feedback `warrant` pour le même agent, en pointant
    // vers un mandat qui existe : sans liste de clients, on le compterait.
    const forge = newFeedbackLog({
      agentId: AGENT_ID,
      warrantId: warrantId(1),
      client: IMPOSTOR,
      feedbackIndex: 1n,
    })

    const feedbacks = decodeNewFeedbackLogs([honnete.feedback, forge])
    const settlements = decodeSettlementLogs([honnete.settlement])

    const scoped = crossReference({
      agentId: AGENT_ID,
      feedbacks,
      settlements,
      clients: [SETTLER],
    })
    expect(scoped.warrants).toHaveLength(1)

    const open = crossReference({ agentId: AGENT_ID, feedbacks, settlements })
    expect(open.warrants).toHaveLength(1) // dédoublonné par warrantId…
    // …mais le feedback de l'imposteur a bien été pris en compte, faute de filtre.
    expect(open.warrants[0]!.warrantId).toBe(warrantId(1))
  })

  it('ignore les feedbacks dont tag1 n’est pas « warrant »', () => {
    const w = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: USDC,
      verdict: 'honored',
    })
    const autre = newFeedbackLog({
      agentId: AGENT_ID,
      warrantId: warrantId(1),
      tag1: 'starred',
    })
    const xref = crossReference({
      agentId: AGENT_ID,
      feedbacks: decodeNewFeedbackLogs([autre]),
      settlements: decodeSettlementLogs([w.settlement]),
    })
    expect(xref.warrants).toHaveLength(0)
  })

  it('ignore les feedbacks d’un autre agentId', () => {
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

  it('écarte un feedback révoqué', () => {
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

  it('signale une divergence entre le verdict inscrit et le règlement onchain', () => {
    // Le feedback dit `honored`, l'escrow a saisi. L'escrow fait foi.
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

  it('recoupe l’attribution avec WarrantOpened.agent', () => {
    const bon = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 100n * USDC,
      verdict: 'honored',
      agent: AGENT_WALLET,
    })
    // Le Settler rattache à cet agent un mandat ouvert par quelqu'un d'autre.
    const usurpe = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 2,
      bond: 900n * USDC,
      verdict: 'honored',
      agent: OTHER_WALLET,
    })

    const xref = crossReference({
      agentId: AGENT_ID,
      feedbacks: decodeNewFeedbackLogs([bon.feedback, usurpe.feedback]),
      settlements: decodeSettlementLogs([bon.settlement, usurpe.settlement]),
      openings: decodeOpeningLogs([bon.opened, usurpe.opened]),
      agentAddresses: [AGENT_WALLET],
    })

    expect(xref.warrants).toHaveLength(1)
    expect(xref.rejectedByOpening).toEqual([warrantId(2)])
    expect(computeAgentReputation(AGENT_ID, xref.warrants).totalAtRisk).toBe(100n * USDC)
  })

  it('résout les identifiants d’un lot via warrantIdsOf', () => {
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
    const lot = decodeNewFeedbackLogs([
      newFeedbackLog({
        agentId: AGENT_ID,
        feedbackURI: `https://warrant.sh/v/batch/0x${'cc'.repeat(32)}`,
      }),
    ])

    // Sans résolution, l'URI d'un lot ne donne aucun mandat.
    expect(
      crossReference({
        agentId: AGENT_ID,
        feedbacks: lot,
        settlements: decodeSettlementLogs([a.settlement, b.settlement]),
      }).warrants,
    ).toHaveLength(0)

    const rep = reputationFromEvents({
      agentId: AGENT_ID,
      feedbacks: lot,
      settlements: decodeSettlementLogs([a.settlement, b.settlement]),
      warrantIdsOf: () => [warrantId(1), warrantId(2)],
    })
    expect(rep.settledCount).toBe(2)
    expect(rep.totalAtRisk).toBe(40n * USDC)
  })

  it('ne compte jamais un mandat expiré : WarrantReclaimed n’est pas décodé', () => {
    // Aucun feedback n'est publié pour un reclaim, et aucun règlement non plus.
    const rep = reputationFromEvents({
      agentId: AGENT_ID,
      feedbacks: [],
      settlements: [],
    })
    expect(rep.settledCount).toBe(0)
    expect(rep.stakeWeightedScore).toBeNull()
  })
})

describe('formatage', () => {
  it('formate une caution dans ses décimales', () => {
    expect(formatBond(1_234_567n, 6)).toBe('1.234567')
    expect(formatBond(0n, 6)).toBe('0.000000')
    expect(formatBond(42n, 0)).toBe('42')
  })

  it('n’affiche jamais 0,0000 pour une absence de score', () => {
    expect(formatScore(null)).toBe('n/a')
    expect(formatScore(0)).toBe('0.0000')
    expect(formatScore(0.0909090909, 4)).toBe('0.0909')
  })
})
