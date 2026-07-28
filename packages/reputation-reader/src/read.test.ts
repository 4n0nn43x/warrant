import { describe, expect, it, vi } from 'vitest'

import { TOPICS } from './decode.js'
import {
  ESCROW,
  IMPOSTOR,
  REPUTATION,
  SETTLER,
  feedbackRevokedLog,
  settledWarrantLogs,
  warrantId,
} from './fixtures.js'
import { readAgentReputation } from './read.js'
import type { GetLogsQuery, LogClient } from './read.js'
import type { RawLog } from './types.js'

const AGENT_ID = 4242n
const USDC = 1_000_000n

/**
 * Nœud simulé. Il ne connaît que `eth_getLogs` — c'est tout ce que le lecteur
 * lui demande, et c'est le point : aucune vue n'est appelée, parce qu'aucune
 * vue ne rendrait `feedbackURI` ni `feedbackHash`.
 */
function nodeMock(logs: readonly RawLog[]) {
  const queries: GetLogsQuery[] = []
  const client: LogClient = {
    getLogs: vi.fn(async (query: GetLogsQuery) => {
      queries.push(query)
      const event = query.event as { name: string }
      const topic0 =
        event.name === 'NewFeedback'
          ? TOPICS.newFeedback
          : event.name === 'FeedbackRevoked'
            ? TOPICS.feedbackRevoked
            : event.name === 'WarrantOpened'
              ? TOPICS.warrantOpened
              : event.name === 'WarrantHonored'
                ? TOPICS.warrantHonored
                : TOPICS.warrantSlashed
      return logs.filter(
        (l) =>
          l.address.toLowerCase() === query.address.toLowerCase() && l.topics[0] === topic0,
      )
    }),
  }
  return { client, queries }
}

function corpus() {
  const specs = [
    { n: 1, bond: 100n * USDC, verdict: 'honored' as const, feeBps: 50n },
    { n: 2, bond: 400n * USDC, verdict: 'honored' as const, feeBps: 50n },
    { n: 3, bond: 500n * USDC, verdict: 'slashed' as const },
  ]
  const logs: RawLog[] = []
  for (const s of specs) {
    const l = settledWarrantLogs({ agentId: AGENT_ID, ...s })
    logs.push(l.opened, l.settlement, l.feedback)
  }
  return logs
}

describe('readAgentReputation', () => {
  it('calcule le score depuis les seuls logs', async () => {
    const { client } = nodeMock(corpus())
    const rep = await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
    })

    expect(rep.settledCount).toBe(3)
    expect(rep.honoredBond).toBe(500n * USDC)
    expect(rep.slashedBond).toBe(500n * USDC)
    expect(rep.totalAtRisk).toBe(1000n * USDC)
    expect(rep.stakeWeightedScore).toBe(0.5)
  })

  it('n’interroge que des events, jamais une vue', async () => {
    const { client, queries } = nodeMock(corpus())
    await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
    })

    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) {
      expect(q.event).toBeDefined()
      expect((q.event as { type: string }).type).toBe('event')
    }
    const names = queries.map((q) => (q.event as { name: string }).name)
    expect(names).toContain('NewFeedback')
    expect(names).toContain('WarrantHonored')
    expect(names).toContain('WarrantSlashed')
  })

  it('filtre côté nœud sur agentId, client et tag1', async () => {
    const { client, queries } = nodeMock(corpus())
    await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
    })
    const feedbackQuery = queries.find(
      (q) => (q.event as { name: string }).name === 'NewFeedback',
    )
    expect(feedbackQuery?.args).toMatchObject({
      agentId: AGENT_ID,
      clientAddress: [SETTLER],
      // `indexedTag1` est une string indexée : le nœud compare keccak256('warrant').
      indexedTag1: 'warrant',
    })
  })

  it('rend un score nul — pas zéro — pour un agent sans mandat réglé', async () => {
    const { client } = nodeMock([])
    const rep = await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
    })
    expect(rep.settledCount).toBe(0)
    expect(rep.totalAtRisk).toBe(0n)
    expect(rep.stakeWeightedScore).toBeNull()
  })

  it('tient compte des révocations', async () => {
    const logs = [
      ...corpus(),
      feedbackRevokedLog({ agentId: AGENT_ID, feedbackIndex: 3n }),
    ]
    const { client } = nodeMock(logs)
    const rep = await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
    })
    // La saisie du mandat 3 a été révoquée : elle sort du dénominateur.
    expect(rep.settledCount).toBe(2)
    expect(rep.slashedBond).toBe(0n)
    expect(rep.stakeWeightedScore).toBe(1)
  })

  it('écarte le feedback d’un client non attendu', async () => {
    const honnete = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 100n * USDC,
      verdict: 'honored',
    })
    const forge = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 2,
      bond: 99_999n * USDC,
      verdict: 'honored',
      client: IMPOSTOR,
    })
    const { client } = nodeMock([
      honnete.opened,
      honnete.settlement,
      honnete.feedback,
      forge.opened,
      forge.settlement,
      forge.feedback,
    ])

    const rep = await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
    })
    expect(rep.settledCount).toBe(1)
    expect(rep.totalAtRisk).toBe(100n * USDC)
  })

  it('résout les lots via resolveWarrantIds', async () => {
    const logs = corpus()
    const { client } = nodeMock(logs)
    const rep = await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
      resolveWarrantIds: async () => [warrantId(1), warrantId(2)],
    })
    // Chaque feedback est réputé couvrir les mandats 1 et 2 ; le 3 disparaît.
    expect(rep.settledCount).toBe(2)
    expect(rep.totalAtRisk).toBe(500n * USDC)
  })
})
