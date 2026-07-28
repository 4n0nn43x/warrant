/**
 * Settler — l'orchestration du règlement.
 *
 * Enchaînement, et l'ordre compte :
 *   1. lire l'exécution via l'API KeeperHub  → localise et date
 *   2. attendre N confirmations sur un RPC indépendant
 *   3. réévaluer la post-condition en lecture onchain au bloc cible
 *   4. honor / slash, puis publier le verdict
 *
 * L'étape 3 est ce qui rend le verdict rejouable : l'audit trail KeeperHub sert
 * à trouver la transaction, jamais à décider. Voir docs/08 § 4.
 *
 * Deux règles de conduite traversent tout ce fichier :
 *
 *   « Une transaction qui échoue n'est pas une post-condition violée. »
 *     Un échec d'exécution laisse le mandat expirer vers `reclaim`. L'agent
 *     n'est jamais puni pour une défaillance d'infrastructure.
 *
 *   « Le doute bénéficie à l'agent, jamais au protocole. »
 *     Toute erreur de lecture mène à un retry puis à l'expiration, jamais à une
 *     saisie.
 */

import type { Address, Hex } from '@warrant/core'
import { encodePacked, keccak256 } from 'viem'
import type { PublicClient, WalletClient } from 'viem'
import { warrantEscrowAbi } from './escrow-abi.js'
import { RpcReadError } from './checks/errors.js'
import type { Execution, KeeperHubClient } from './keeperhub.js'

/** Décision du Settler pour un mandat donné. */
export type SettlementAction =
  | { kind: 'honor'; execRef: Hex }
  | { kind: 'slash'; execRef: Hex; reason: string }
  /** Ne rien faire et laisser `reclaim` rembourser l'agent après expiration. */
  | { kind: 'let-expire'; reason: string }

export interface SettlementDecision {
  warrantId: Hex
  action: SettlementAction
  /** Absent quand on laisse expirer avant toute évaluation. */
  evaluation?: {
    verdict: 'honored' | 'slashed'
    evaluatedAtBlock: string
    checks: { kind: string; expected: string; observed: string; pass: boolean }[]
    rpcUrl: string
  }
}

/**
 * Marge de sécurité avant expiration en dessous de laquelle le Settler
 * s'abstient d'émettre une transaction de règlement.
 *
 * Depuis l'invariant I9, `honor` et `slash` révertent passé `expiry` : une
 * transaction envoyée trop tard est du gas perdu, et sa place est prise par le
 * `reclaim` de l'agent. Voir docs/13 § 3, R9.
 */
export const SETTLEMENT_MARGIN_SECONDS = 60

/** `execRef = keccak256(executionId ‖ txHash)`. */
export function execRef(executionId: string, txHash: Hex): Hex {
  return keccak256(encodePacked(['string', 'bytes32'], [executionId, txHash]))
}

export interface EvaluateFn {
  (ctx: {
    txHash: Hex
    blockNumber: bigint
  }): Promise<{
    verdict: 'honored' | 'slashed'
    evaluatedAtBlock: string
    checks: { kind: string; expected: string; observed: string; pass: boolean }[]
    rpcUrl: string
  }>
}

export interface DecideOptions {
  warrantId: Hex
  /** Expiration du mandat, en secondes epoch. */
  expiry: number
  confirmations: number
  execution: Execution
  evaluate: EvaluateFn
  publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>
  now?: () => number
}

/**
 * Décide du sort d'un mandat. Fonction sans effet de bord onchain : elle rend
 * une décision, elle ne la soumet pas. C'est ce qui la rend testable et
 * rejouable.
 */
export async function decide(opts: DecideOptions): Promise<SettlementDecision> {
  const { warrantId, execution, expiry, confirmations } = opts
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

  // 1. Échec d'exécution → jamais une saisie.
  if (execution.status === 'failed') {
    return {
      warrantId,
      action: {
        kind: 'let-expire',
        reason: `exécution KeeperHub en échec (outcome=${execution.outcome ?? 'inconnu'})`,
      },
    }
  }

  if (execution.status !== 'success') {
    return {
      warrantId,
      action: {
        kind: 'let-expire',
        reason: `exécution non terminée (status=${execution.status})`,
      },
    }
  }

  // 2. Sans txHash, il n'y a rien à évaluer. On ne devine pas.
  if (!execution.txHash) {
    return {
      warrantId,
      action: {
        kind: 'let-expire',
        reason: "l'audit trail ne rapporte aucun txHash pour cette exécution",
      },
    }
  }

  // 3. Confirmations, sur un RPC indépendant de KeeperHub.
  let blockNumber: bigint
  try {
    const receipt = await opts.publicClient.waitForTransactionReceipt({
      hash: execution.txHash,
      confirmations,
    })
    blockNumber = receipt.blockNumber
  } catch (e) {
    return {
      warrantId,
      action: {
        kind: 'let-expire',
        reason: `confirmations non obtenues: ${errText(e)}`,
      },
    }
  }

  // 4. Évaluation. Une erreur de lecture n'est pas une violation.
  let evaluation: Awaited<ReturnType<EvaluateFn>>
  try {
    evaluation = await opts.evaluate({ txHash: execution.txHash, blockNumber })
  } catch (e) {
    if (e instanceof RpcReadError) {
      return {
        warrantId,
        action: {
          kind: 'let-expire',
          reason: `lecture onchain non concluante: ${errText(e)}`,
        },
      }
    }
    throw e
  }

  // 5. La fenêtre de règlement est-elle encore ouverte ? (invariant I9)
  if (now() + SETTLEMENT_MARGIN_SECONDS >= expiry) {
    return {
      warrantId,
      evaluation,
      action: {
        kind: 'let-expire',
        reason:
          "fenêtre de règlement trop proche de l'expiration — honor/slash reverteraient",
      },
    }
  }

  const ref = execRef(execution.executionId, execution.txHash)

  if (evaluation.verdict === 'honored') {
    return { warrantId, evaluation, action: { kind: 'honor', execRef: ref } }
  }

  return {
    warrantId,
    evaluation,
    action: {
      kind: 'slash',
      execRef: ref,
      reason: summarizeFailures(evaluation.checks),
    },
  }
}

/** Résumé court des vérifications échouées, écrit dans l'event onchain. */
export function summarizeFailures(
  checks: { kind: string; expected: string; observed: string; pass: boolean }[],
): string {
  const failed = checks.filter((c) => !c.pass)
  if (failed.length === 0) return 'aucune vérification échouée'
  return failed
    .map((c) => `${c.kind}: attendu ${c.expected}, observé ${c.observed}`)
    .join(' | ')
    .slice(0, 400)
}

export interface SubmitOptions {
  escrow: Address
  walletClient: WalletClient
  account: Address
  chain: WalletClient['chain']
}

/** Soumet la décision onchain. Séparé de `decide` pour rester rejouable à sec. */
export async function submit(
  decision: SettlementDecision,
  opts: SubmitOptions,
): Promise<Hex | undefined> {
  const { action } = decision
  if (action.kind === 'let-expire') return undefined

  const base = {
    address: opts.escrow,
    abi: warrantEscrowAbi,
    account: opts.account,
    chain: opts.chain,
  } as const

  if (action.kind === 'honor') {
    return opts.walletClient.writeContract({
      ...base,
      functionName: 'honor',
      args: [decision.warrantId, action.execRef],
    })
  }

  return opts.walletClient.writeContract({
    ...base,
    functionName: 'slash',
    args: [decision.warrantId, action.execRef, action.reason],
  })
}

/** Boucle complète : suivre l'exécution, décider, soumettre. */
export async function settle(opts: {
  warrantId: Hex
  executionId: string
  expiry: number
  confirmations: number
  kh: KeeperHubClient
  evaluate: EvaluateFn
  publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>
  submitOptions?: SubmitOptions
  now?: () => number
}): Promise<SettlementDecision & { settlementTx?: Hex }> {
  let execution: Execution
  try {
    execution = await opts.kh.pollExecution(opts.executionId)
  } catch (e) {
    return {
      warrantId: opts.warrantId,
      action: {
        kind: 'let-expire',
        reason: `audit trail illisible: ${errText(e)}`,
      },
    }
  }

  const decision = await decide({
    warrantId: opts.warrantId,
    expiry: opts.expiry,
    confirmations: opts.confirmations,
    execution,
    evaluate: opts.evaluate,
    publicClient: opts.publicClient,
    ...(opts.now ? { now: opts.now } : {}),
  })

  if (!opts.submitOptions) return decision

  const tx = await submit(decision, opts.submitOptions)
  return tx ? { ...decision, settlementTx: tx } : decision
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
