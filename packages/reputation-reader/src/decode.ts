/**
 * Log decoding. Pure, network-free: everything that follows is tested against
 * simulated logs.
 */

import { decodeEventLog, toEventSelector } from 'viem'

import {
  feedbackRevokedEvent,
  newFeedbackEvent,
  warrantHonoredEvent,
  warrantOpenedEvent,
  warrantSlashedEvent,
} from './abi.js'
import type {
  Address,
  FeedbackRecord,
  Hex,
  OpeningRecord,
  RawLog,
  SettlementRecord,
} from './types.js'

/** `topic0` of every event read. Computed from the ABI, never copied by hand. */
export const TOPICS = {
  newFeedback: toEventSelector(newFeedbackEvent),
  feedbackRevoked: toEventSelector(feedbackRevokedEvent),
  warrantOpened: toEventSelector(warrantOpenedEvent),
  warrantHonored: toEventSelector(warrantHonoredEvent),
  warrantSlashed: toEventSelector(warrantSlashedEvent),
} as const

/**
 * Key of a feedback in the registry: `(agentId, clientAddress, feedbackIndex)`.
 * `feedbackIndex` is **1-indexed** per (agentId, clientAddress) pair — never
 * start from 0.
 */
export function feedbackKey(
  agentId: bigint,
  clientAddress: string,
  feedbackIndex: bigint,
): string {
  return `${agentId}:${clientAddress.toLowerCase()}:${feedbackIndex}`
}

/** Decodes the `FeedbackRevoked` events into a set of revoked keys. */
export function decodeRevocations(logs: readonly RawLog[]): Set<string> {
  const out = new Set<string>()
  for (const log of logs) {
    if (topic0(log) !== TOPICS.feedbackRevoked) continue
    const { args } = decodeEventLog({
      abi: [feedbackRevokedEvent],
      eventName: 'FeedbackRevoked',
      data: log.data,
      topics: topicsOf(log),
    })
    out.add(feedbackKey(args.agentId, args.clientAddress, BigInt(args.feedbackIndex)))
  }
  return out
}

type DecodableTopics = [signature: Hex, ...args: Hex[]] | []

function topicsOf(log: RawLog): DecodableTopics {
  return log.topics as unknown as DecodableTopics
}

function topic0(log: RawLog): Hex | undefined {
  return log.topics[0]
}

function lower(value: string): Hex {
  return value.toLowerCase() as Hex
}

/**
 * Decodes the `NewFeedback` events.
 *
 * Logs of other events are silently ignored: we filter by `topic0`, which lets
 * the caller pass an unsorted window of logs without preparing it.
 */
export function decodeNewFeedbackLogs(logs: readonly RawLog[]): FeedbackRecord[] {
  const out: FeedbackRecord[] = []
  for (const log of logs) {
    if (topic0(log) !== TOPICS.newFeedback) continue
    const { args } = decodeEventLog({
      abi: [newFeedbackEvent],
      eventName: 'NewFeedback',
      data: log.data,
      topics: topicsOf(log),
    })
    out.push({
      agentId: args.agentId,
      clientAddress: lower(args.clientAddress) as Address,
      feedbackIndex: BigInt(args.feedbackIndex),
      value: args.value,
      valueDecimals: Number(args.valueDecimals),
      // `args.tag1` is the **non-indexed** version: the readable value.
      // `args.indexedTag1` is only its keccak256 and serves for filtering alone.
      tag1: args.tag1,
      tag2: args.tag2,
      endpoint: args.endpoint,
      feedbackURI: args.feedbackURI,
      feedbackHash: lower(args.feedbackHash),
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
    })
  }
  return out
}

/**
 * Decodes the `WarrantEscrow` settlements.
 *
 * The bond is reconstructed from the event, not from a state read later on:
 *   - `WarrantHonored` → `refunded + fee`, because the refund is net of the
 *     protocol fee whereas the bond that was locked up was not;
 *   - `WarrantSlashed` → `amount`, a slash takes the whole thing.
 *
 * `WarrantReclaimed` is not decoded: an expiry is not a settlement, it weighs
 * neither in the numerator nor in the denominator.
 */
export function decodeSettlementLogs(logs: readonly RawLog[]): SettlementRecord[] {
  const out: SettlementRecord[] = []
  for (const log of logs) {
    const t0 = topic0(log)
    if (t0 === TOPICS.warrantHonored) {
      const { args } = decodeEventLog({
        abi: [warrantHonoredEvent],
        eventName: 'WarrantHonored',
        data: log.data,
        topics: topicsOf(log),
      })
      out.push({
        warrantId: lower(args.id),
        verdict: 'honored',
        bond: args.refunded + args.fee,
        execRef: lower(args.execRef),
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      })
    } else if (t0 === TOPICS.warrantSlashed) {
      const { args } = decodeEventLog({
        abi: [warrantSlashedEvent],
        eventName: 'WarrantSlashed',
        data: log.data,
        topics: topicsOf(log),
      })
      out.push({
        warrantId: lower(args.id),
        verdict: 'slashed',
        bond: args.amount,
        execRef: lower(args.execRef),
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      })
    }
  }
  return out
}

/**
 * Decodes the `WarrantOpened` events.
 *
 * Used for the optional cross-check: `WarrantOpened.agent` makes it possible to
 * verify that a warrant belongs to an agent **without going through the
 * Settler's feedback**. See `crossReference({ openings, agentAddresses })`.
 */
export function decodeOpeningLogs(logs: readonly RawLog[]): OpeningRecord[] {
  const out: OpeningRecord[] = []
  for (const log of logs) {
    if (topic0(log) !== TOPICS.warrantOpened) continue
    const { args } = decodeEventLog({
      abi: [warrantOpenedEvent],
      eventName: 'WarrantOpened',
      data: log.data,
      topics: topicsOf(log),
    })
    out.push({
      warrantId: lower(args.id),
      agent: lower(args.agent) as Address,
      beneficiary: lower(args.beneficiary) as Address,
      bond: args.bond,
      fundingRef: lower(args.fundingRef),
      expiry: BigInt(args.expiry),
      blockNumber: log.blockNumber,
    })
  }
  return out
}
