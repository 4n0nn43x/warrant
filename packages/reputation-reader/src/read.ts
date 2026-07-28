/**
 * Couche d'E/S — la seule du paquet.
 *
 * Elle ne fait qu'une chose : aller chercher des logs. Aucune vue n'est
 * appelée, et ce n'est pas une préférence de style : `readFeedback` ne rend ni
 * `feedbackURI` ni `feedbackHash`, qui ne sont émis que dans `NewFeedback`.
 * Sans les logs, il n'y a pas de verdict Warrant lisible onchain.
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
 * Interface structurelle minimale : un `PublicClient` viem la satisfait, et un
 * objet de test aussi. Le paquet ne dépend d'aucun client concret.
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
 * Lit les `NewFeedback` d'un agent.
 *
 * Le filtre `indexedTag1` porte sur la `string` **indexée** de l'event : le nœud
 * compare `keccak256('warrant')`, et viem s'occupe du hachage. Le `tag1` non
 * indexé reste vérifié après décodage, en défense.
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

/** Lit les `FeedbackRevoked` d'un agent. */
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

/** Lit les règlements de l'escrow — `WarrantHonored` puis `WarrantSlashed`. */
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

/** Lit les `WarrantOpened`, pour recouper l'attribution des mandats. */
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
  /** Adresses clientes retenues — en pratique, celles du Settler. */
  clients?: readonly Address[]
  /** Adresses onchain de l'agent, pour recouper via `WarrantOpened`. */
  agentAddresses?: readonly Address[]
  /**
   * Résout les identifiants de mandat d'un feedback agrégé, en téléchargeant le
   * document à son `feedbackURI`. Sans elle, seuls les feedbacks portant un
   * mandat unique dans leur URI sont pris en compte.
   */
  resolveWarrantIds?: (feedback: FeedbackRecord) => Promise<readonly `0x${string}`[]>
}

/**
 * Le point d'entrée complet : lit les logs, croise, calcule.
 *
 * Aucune vue n'est appelée. Le résultat est reproductible par un tiers à partir
 * du seul couple (RPC, plage de blocs).
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

  // Résolution des lots : un feedback agrégé ne porte pas ses identifiants dans
  // son URI. On pré-calcule la table pour que le recoupement reste synchrone.
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
