/**
 * Décodage des logs. Pur, sans réseau : tout ce qui suit se teste sur des logs
 * simulés.
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

/** `topic0` de chaque event lu. Calculés depuis l'ABI, jamais recopiés. */
export const TOPICS = {
  newFeedback: toEventSelector(newFeedbackEvent),
  feedbackRevoked: toEventSelector(feedbackRevokedEvent),
  warrantOpened: toEventSelector(warrantOpenedEvent),
  warrantHonored: toEventSelector(warrantHonoredEvent),
  warrantSlashed: toEventSelector(warrantSlashedEvent),
} as const

/**
 * Clé d'un feedback dans le registre : `(agentId, clientAddress, feedbackIndex)`.
 * `feedbackIndex` est **1-indexé** par couple (agentId, clientAddress) — ne
 * jamais partir de 0.
 */
export function feedbackKey(
  agentId: bigint,
  clientAddress: string,
  feedbackIndex: bigint,
): string {
  return `${agentId}:${clientAddress.toLowerCase()}:${feedbackIndex}`
}

/** Décode les `FeedbackRevoked` en un ensemble de clés révoquées. */
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
 * Décode les `NewFeedback`.
 *
 * Les logs d'autres events sont ignorés silencieusement : on filtre par
 * `topic0`, ce qui permet de passer une fenêtre de logs non triée sans la
 * préparer.
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
      // `args.tag1` est la version **non indexée** : la valeur lisible.
      // `args.indexedTag1` n'est que son keccak256 et ne sert qu'au filtrage.
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
 * Décode les règlements de `WarrantEscrow`.
 *
 * La caution est reconstituée depuis l'event, pas depuis un état lu plus tard :
 *   - `WarrantHonored` → `refunded + fee`, parce que le remboursement est net
 *     des frais du protocole alors que la caution immobilisée ne l'était pas ;
 *   - `WarrantSlashed` → `amount`, la saisie porte sur l'intégralité.
 *
 * `WarrantReclaimed` n'est pas décodé : une expiration n'est pas un règlement,
 * elle ne pèse ni au numérateur ni au dénominateur.
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
 * Décode les `WarrantOpened`.
 *
 * Sert au recoupement optionnel : `WarrantOpened.agent` permet de vérifier
 * l'attribution d'un mandat à un agent **sans passer par le feedback du
 * Settler**. Voir `crossReference({ openings, agentAddresses })`.
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
