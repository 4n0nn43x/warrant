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
 * Simulated node. It knows nothing but `eth_getLogs` — that is all the reader ever
 * asks of it, and that is the point: no view is called, because no view would
 * return `feedbackURI` or `feedbackHash`.
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
  it('computes the score from the logs alone', async () => {
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

  it('queries events only, never a view', async () => {
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

  it('filters node-side on agentId, client and tag1', async () => {
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
      // `indexedTag1` is an indexed string: the node compares keccak256('warrant').
      indexedTag1: 'warrant',
    })
  })

  it('returns a null score — not zero — for an agent with no settled warrant', async () => {
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

  it('takes revocations into account', async () => {
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
    // The slash of warrant 3 was revoked: it leaves the denominator.
    expect(rep.settledCount).toBe(2)
    expect(rep.slashedBond).toBe(0n)
    expect(rep.stakeWeightedScore).toBe(1)
  })

  it('discards the feedback of an unexpected client', async () => {
    const honest = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 1,
      bond: 100n * USDC,
      verdict: 'honored',
    })
    const forged = settledWarrantLogs({
      agentId: AGENT_ID,
      n: 2,
      bond: 99_999n * USDC,
      verdict: 'honored',
      client: IMPOSTOR,
    })
    const { client } = nodeMock([
      honest.opened,
      honest.settlement,
      honest.feedback,
      forged.opened,
      forged.settlement,
      forged.feedback,
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

  it('resolves batches through resolveWarrantIds', async () => {
    const logs = corpus()
    const { client } = nodeMock(logs)
    const rep = await readAgentReputation(client, {
      reputationRegistry: REPUTATION,
      escrow: ESCROW,
      agentId: AGENT_ID,
      clients: [SETTLER],
      resolveWarrantIds: async () => [warrantId(1), warrantId(2)],
    })
    // Every feedback is deemed to cover warrants 1 and 2; number 3 disappears.
    expect(rep.settledCount).toBe(2)
    expect(rep.totalAtRisk).toBe(500n * USDC)
  })
})
