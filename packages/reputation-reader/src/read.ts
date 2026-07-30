/**
 * The I/O layer — the only one in the package.
 *
 * It does exactly one thing: fetch logs. No view is ever called, and that is not
 * a stylistic preference: `readFeedback` returns neither `feedbackURI` nor
 * `feedbackHash`, which are only emitted in `NewFeedback`. Without the logs,
 * there is no Warrant verdict readable onchain.
 */

import {
  newFeedbackEvent,
  feedbackRevokedEvent,
  warrantHonoredEvent,
  warrantOpenedEvent,
  warrantSlashedEvent,
} from './abi.js'
import {
  decodeNewFeedbackLogs,
  decodeOpeningLogs,
  decodeRevocations,
  decodeSettlementLogs,
} from './decode.js'
import { computeAgentReputation, crossReference } from './score.js'
import type { AgentReputation, CrossReferenceResult } from './score.js'
import type {
  Address,
  FeedbackRecord,
  OpeningRecord,
  RawLog,
  SettlementRecord,
} from './types.js'

export type BlockSpec = bigint | 'earliest' | 'latest' | 'safe' | 'finalized' | 'pending'

export interface GetLogsQuery {
  address: Address
  event: unknown
  args?: Record<string, unknown>
  fromBlock?: BlockSpec
  toBlock?: BlockSpec
  strict?: boolean
}

/**
 * Minimal structural interface: a viem `PublicClient` satisfies it, and so does a
 * test object. The package depends on no concrete client.
 */
export interface LogClient {
  getLogs(query: GetLogsQuery): Promise<readonly RawLog[]>
}

export interface BlockRange {
  fromBlock?: BlockSpec
  toBlock?: BlockSpec
}

function range(r: BlockRange): BlockRange {
  return { fromBlock: r.fromBlock ?? 'earliest', toBlock: r.toBlock ?? 'latest' }
}

/**
 * Reads an agent's `NewFeedback` events.
 *
 * The `indexedTag1` filter applies to the event's **indexed** `string`: the node
 * compares `keccak256('warrant')`, and viem takes care of the hashing. The
 * non-indexed `tag1` is still checked after decoding, as a defence.
 */
export async function fetchFeedback(
  client: LogClient,
  opts: {
    reputationRegistry: Address
    agentId: bigint
    clients?: readonly Address[]
    tag1?: string
  } & BlockRange,
): Promise<FeedbackRecord[]> {
  const args: Record<string, unknown> = { agentId: opts.agentId }
  if (opts.clients && opts.clients.length > 0) args['clientAddress'] = [...opts.clients]
  if (opts.tag1 !== undefined) args['indexedTag1'] = opts.tag1

  const logs = await client.getLogs({
    address: opts.reputationRegistry,
    event: newFeedbackEvent,
    args,
    ...range(opts),
  })
  return decodeNewFeedbackLogs(logs)
}

/** Reads an agent's `FeedbackRevoked` events. */
export async function fetchRevocations(
  client: LogClient,
  opts: { reputationRegistry: Address; agentId: bigint } & BlockRange,
): Promise<Set<string>> {
  const logs = await client.getLogs({
    address: opts.reputationRegistry,
    event: feedbackRevokedEvent,
    args: { agentId: opts.agentId },
    ...range(opts),
  })
  return decodeRevocations(logs)
}

/** Reads the escrow's settlements — `WarrantHonored`, then `WarrantSlashed`. */
export async function fetchSettlements(
  client: LogClient,
  opts: { escrow: Address } & BlockRange,
): Promise<SettlementRecord[]> {
  const [honored, slashed] = await Promise.all([
    client.getLogs({ address: opts.escrow, event: warrantHonoredEvent, ...range(opts) }),
    client.getLogs({ address: opts.escrow, event: warrantSlashedEvent, ...range(opts) }),
  ])
  return [...decodeSettlementLogs(honored), ...decodeSettlementLogs(slashed)]
}

/** Reads the `WarrantOpened` events, to cross-check warrant attribution. */
export async function fetchOpenings(
  client: LogClient,
  opts: { escrow: Address; agent?: Address } & BlockRange,
): Promise<OpeningRecord[]> {
  const logs = await client.getLogs({
    address: opts.escrow,
    event: warrantOpenedEvent,
    ...(opts.agent ? { args: { agent: opts.agent } } : {}),
    ...range(opts),
  })
  return decodeOpeningLogs(logs)
}

export interface ReadAgentReputationOptions extends BlockRange {
  reputationRegistry: Address
  escrow: Address
  agentId: bigint
  /** Client addresses accepted — in practice, the Settler's. */
  clients?: readonly Address[]
  /** Onchain addresses of the agent, to cross-check via `WarrantOpened`. */
  agentAddresses?: readonly Address[]
  /**
   * Resolves the warrant identifiers of an aggregated feedback, by downloading the
   * document at its `feedbackURI`. Without it, only feedbacks carrying a single
   * warrant in their URI are taken into account.
   */
  resolveWarrantIds?: (feedback: FeedbackRecord) => Promise<readonly `0x${string}`[]>
}

/**
 * The complete entry point: reads the logs, cross-references, computes.
 *
 * No view is called. The result is reproducible by a third party from the (RPC,
 * block range) pair alone.
 */
export async function readAgentReputation(
  client: LogClient,
  opts: ReadAgentReputationOptions,
): Promise<AgentReputation & { crossReference: CrossReferenceResult }> {
  const [feedbacks, revoked, settlements, openings] = await Promise.all([
    fetchFeedback(client, {
      reputationRegistry: opts.reputationRegistry,
      agentId: opts.agentId,
      ...(opts.clients ? { clients: opts.clients } : {}),
      tag1: 'warrant',
      ...range(opts),
    }),
    fetchRevocations(client, {
      reputationRegistry: opts.reputationRegistry,
      agentId: opts.agentId,
      ...range(opts),
    }),
    fetchSettlements(client, { escrow: opts.escrow, ...range(opts) }),
    opts.agentAddresses && opts.agentAddresses.length > 0
      ? fetchOpenings(client, { escrow: opts.escrow, ...range(opts) })
      : Promise.resolve([] as OpeningRecord[]),
  ])

  // Batch resolution: an aggregated feedback does not carry its identifiers in
  // its URI. We precompute the table so that the cross-reference stays
  // synchronous.
  const resolved = new Map<FeedbackRecord, readonly `0x${string}`[]>()
  if (opts.resolveWarrantIds) {
    for (const f of feedbacks) {
      resolved.set(f, await opts.resolveWarrantIds(f))
    }
  }

  const xref = crossReference({
    agentId: opts.agentId,
    feedbacks,
    settlements,
    ...(opts.clients ? { clients: opts.clients } : {}),
    revoked,
    ...(opts.agentAddresses ? { openings, agentAddresses: opts.agentAddresses } : {}),
    ...(opts.resolveWarrantIds
      ? { warrantIdsOf: (f: FeedbackRecord) => resolved.get(f) ?? [] }
      : {}),
  })

  return { ...computeAgentReputation(opts.agentId, xref.warrants), crossReference: xref }
}
