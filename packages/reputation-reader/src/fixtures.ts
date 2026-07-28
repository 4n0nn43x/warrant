/**
 * Fabrique de logs simulés, partagée par les tests.
 *
 * Les logs sont encodés avec viem depuis les mêmes fragments d'ABI que ceux du
 * lecteur : ce ne sont pas des objets bricolés à la main, mais des logs qu'un
 * nœud produirait à l'octet près. Un décalage d'ABI ferait échouer les tests.
 *
 * Il n'est pas réexporté par `index.ts` : c'est un outil de test, pas une partie
 * de l'API publique.
 */

import { encodeAbiParameters, encodeEventTopics } from 'viem'
import type { AbiEvent, AbiParameter } from 'viem'

import {
  newFeedbackEvent,
  feedbackRevokedEvent,
  warrantHonoredEvent,
  warrantOpenedEvent,
  warrantSlashedEvent,
} from './abi.js'
import type { Address, Hex, RawLog } from './types.js'

export const ESCROW = '0xe5c0e5c0e5c0e5c0e5c0e5c0e5c0e5c0e5c0e5c0' as Address
export const REPUTATION = '0x8004baa17c55a88189ae136b182e5fda19de9b63' as Address
export const SETTLER = '0x5e77135e77135e77135e77135e77135e77135e77' as Address
export const IMPOSTOR = '0xbadbadbadbadbadbadbadbadbadbadbadbadbadb' as Address
export const AGENT_WALLET = '0xa9e47a9e47a9e47a9e47a9e47a9e47a9e47a9e47' as Address
export const OTHER_WALLET = '0x0111011101110111011101110111011101110111' as Address

let cursor = 0

function nextMeta(): Pick<RawLog, 'blockNumber' | 'logIndex' | 'transactionHash'> {
  cursor += 1
  return {
    blockNumber: BigInt(30_000_000 + cursor),
    logIndex: cursor % 16,
    transactionHash: `0x${cursor.toString(16).padStart(64, '0')}` as Hex,
  }
}

/** Encode un log comme le ferait un nœud : topics indexés + data ABI. */
function makeLog(
  address: Address,
  event: AbiEvent,
  args: Record<string, unknown>,
): RawLog {
  const topics = encodeEventTopics({
    abi: [event],
    eventName: event.name,
    args,
  }) as Hex[]

  const nonIndexed = event.inputs.filter((i) => !i.indexed)
  const data =
    nonIndexed.length === 0
      ? ('0x' as Hex)
      : (encodeAbiParameters(
          nonIndexed as AbiParameter[],
          nonIndexed.map((i) => args[i.name ?? '']),
        ) as Hex)

  return { address, topics, data, ...nextMeta() }
}

/** `warrantId` déterministe à partir d'un entier. */
export function warrantId(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex
}

export function newFeedbackLog(opts: {
  agentId: bigint
  client?: Address
  warrantId?: Hex
  feedbackURI?: string
  verdict?: 'honored' | 'slashed'
  tag1?: string
  feedbackIndex?: bigint
  feedbackHash?: Hex
}): RawLog {
  const verdict = opts.verdict ?? 'honored'
  const tag1 = opts.tag1 ?? 'warrant'
  const uri =
    opts.feedbackURI ??
    `https://warrant.sh/v/${(opts.warrantId ?? warrantId(1)).toLowerCase()}`
  return makeLog(REPUTATION, newFeedbackEvent, {
    agentId: opts.agentId,
    clientAddress: opts.client ?? SETTLER,
    feedbackIndex: opts.feedbackIndex ?? 1n,
    value: verdict === 'honored' ? 100n : -100n,
    valueDecimals: 2,
    indexedTag1: tag1,
    tag1,
    tag2: verdict,
    endpoint: '',
    feedbackURI: uri,
    feedbackHash: opts.feedbackHash ?? (`0x${'cc'.repeat(32)}` as Hex),
  })
}

export function feedbackRevokedLog(opts: {
  agentId: bigint
  client?: Address
  feedbackIndex: bigint
}): RawLog {
  return makeLog(REPUTATION, feedbackRevokedEvent, {
    agentId: opts.agentId,
    clientAddress: opts.client ?? SETTLER,
    feedbackIndex: opts.feedbackIndex,
  })
}

export function warrantOpenedLog(opts: {
  warrantId: Hex
  agent?: Address
  bond: bigint
}): RawLog {
  return makeLog(ESCROW, warrantOpenedEvent, {
    id: opts.warrantId,
    agent: opts.agent ?? AGENT_WALLET,
    beneficiary: '0x7a5c7a5c7a5c7a5c7a5c7a5c7a5c7a5c7a5c7a5c' as Address,
    bond: opts.bond,
    conditionHash: `0x${'01'.repeat(32)}` as Hex,
    actionHash: `0x${'02'.repeat(32)}` as Hex,
    fundingRef: `0x${'03'.repeat(32)}` as Hex,
    expiry: 1_800_000_000n,
  })
}

/**
 * `WarrantHonored` porte `refunded` **net des frais** : la caution immobilisée
 * était `refunded + fee`. C'est elle qui compte au numérateur du score.
 */
export function warrantHonoredLog(opts: {
  warrantId: Hex
  bond: bigint
  feeBps?: bigint
}): RawLog {
  const fee = (opts.bond * (opts.feeBps ?? 0n)) / 10_000n
  return makeLog(ESCROW, warrantHonoredEvent, {
    id: opts.warrantId,
    execRef: `0x${'ee'.repeat(32)}` as Hex,
    refunded: opts.bond - fee,
    fee,
  })
}

export function warrantSlashedLog(opts: {
  warrantId: Hex
  bond: bigint
  reason?: string
}): RawLog {
  return makeLog(ESCROW, warrantSlashedEvent, {
    id: opts.warrantId,
    execRef: `0x${'ee'.repeat(32)}` as Hex,
    amount: opts.bond,
    reason: opts.reason ?? 'erc20_balance: attendu >=1000, observé 0',
  })
}

/** Un mandat complet : ouverture, règlement, feedback. */
export function settledWarrantLogs(opts: {
  agentId: bigint
  n: number
  bond: bigint
  verdict: 'honored' | 'slashed'
  client?: Address
  agent?: Address
  feeBps?: bigint
}): { opened: RawLog; settlement: RawLog; feedback: RawLog } {
  const id = warrantId(opts.n)
  return {
    opened: warrantOpenedLog({
      warrantId: id,
      bond: opts.bond,
      ...(opts.agent ? { agent: opts.agent } : {}),
    }),
    settlement:
      opts.verdict === 'honored'
        ? warrantHonoredLog({
            warrantId: id,
            bond: opts.bond,
            ...(opts.feeBps !== undefined ? { feeBps: opts.feeBps } : {}),
          })
        : warrantSlashedLog({ warrantId: id, bond: opts.bond }),
    feedback: newFeedbackLog({
      agentId: opts.agentId,
      warrantId: id,
      verdict: opts.verdict,
      feedbackIndex: BigInt(opts.n),
      ...(opts.client ? { client: opts.client } : {}),
    }),
  }
}
