/**
 * `@warrant/reputation-reader` — stake-weighted ERC-8004 reputation.
 *
 * ERC-8004 holds more than 150,000 reputation records, and nothing is at stake
 * when a feedback is published: reputation there is **declarative**. `getSummary`
 * returns an average of ratings, without ever saying how much an agent risked to
 * earn it.
 *
 * This library computes, from **onchain events** alone:
 *
 *     stakeWeightedScore(agent) = Σ(bond_honored) / (Σ(bond_honored) + Σ(bond_slashed))
 *     totalAtRisk(agent)        = Σ(bond) over every settled warrant
 *
 * An agent with 200 small honored warrants and a score of 1.0 becomes
 * distinguishable from an agent with $50,000 of cumulated honored bonds at the
 * same score: `totalAtRisk` tells them apart.
 *
 * It reads **logs**, not views — `feedbackURI` and `feedbackHash` are not stored
 * by the ReputationRegistry, they are only emitted in the `NewFeedback` event.
 * That is an architectural constraint, not a detail.
 *
 * It depends on `viem` alone, and on no other Warrant package: it can be read,
 * published and used without the rest of the project.
 *
 * ```ts
 * import { createPublicClient, http } from 'viem'
 * import { base } from 'viem/chains'
 * import { readAgentReputation, ERC8004_ADDRESSES, formatScore } from '@warrant/reputation-reader'
 *
 * const client = createPublicClient({ chain: base, transport: http() })
 * const rep = await readAgentReputation(client, {
 *   reputationRegistry: ERC8004_ADDRESSES.mainnet.reputation,
 *   escrow: '0x…',
 *   agentId: 1234n,
 *   clients: ['0x…settler'],   // who may rate this agent on Warrant's behalf
 * })
 * console.log(formatScore(rep.stakeWeightedScore), rep.totalAtRisk)
 * ```
 */

export * from './types.js'
export * from './abi.js'
export * from './decode.js'
export * from './score.js'
export * from './read.js'
