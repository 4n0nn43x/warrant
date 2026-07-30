/**
 * Settler — the orchestration of settlement.
 *
 * The sequence, and the order matters:
 *   1. read the execution through the KeeperHub API  → locates and timestamps it
 *   2. wait for N confirmations on an independent RPC
 *   3. re-evaluate the post-condition as an onchain read at the target block
 *   4. honor / slash, then publish the verdict
 *
 * Step 3 is what makes the verdict replayable: the KeeperHub audit trail serves
 * to *find* the transaction, never to decide. See docs/08 § 4.
 *
 * Two rules of conduct run through this whole file:
 *
 *   "A transaction that fails is not a violated post-condition."
 *     An execution failure lets the warrant expire towards `reclaim`. The agent
 *     is never punished for an infrastructure failure.
 *
 *   "Doubt benefits the agent, never the protocol."
 *     Every read error leads to a retry and then to expiry, never to a slash.
 */

import type { Address, Hex } from '@warrant/core'
import { encodePacked, keccak256 } from 'viem'
import type { PublicClient, WalletClient } from 'viem'
import { warrantEscrowAbi } from './escrow-abi.js'
import { RpcReadError } from './checks/errors.js'
import type { Execution, KeeperHubClient } from './keeperhub.js'

/** The Settler's decision for a given warrant. */
export type SettlementAction =
  | { kind: 'honor'; execRef: Hex }
  | { kind: 'slash'; execRef: Hex; reason: string }
  /** Do nothing and let `reclaim` refund the agent once the warrant expires. */
  | { kind: 'let-expire'; reason: string }

export interface SettlementDecision {
  warrantId: Hex
  action: SettlementAction
  /** Absent when we let the warrant expire before any evaluation took place. */
  evaluation?: {
    verdict: 'honored' | 'slashed'
    evaluatedAtBlock: string
    checks: { kind: string; expected: string; observed: string; pass: boolean }[]
    rpcUrl: string
  }
}

/**
 * Safety margin before expiry below which the Settler abstains from emitting a
 * settlement transaction.
 *
 * By invariant I9, `honor` and `slash` revert past `expiry`: a transaction sent
 * too late is wasted gas, and its place is taken by the agent's `reclaim`. See
 * docs/13 § 3, R9.
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
  /** Warrant expiry, in epoch seconds. */
  expiry: number
  confirmations: number
  execution: Execution
  evaluate: EvaluateFn
  publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>
  now?: () => number
}

/**
 * Decides the fate of a warrant. A function with no onchain side effect: it
 * returns a decision, it does not submit it. That is what makes it testable and
 * replayable.
 */
export async function decide(opts: DecideOptions): Promise<SettlementDecision> {
  const { warrantId, execution, expiry, confirmations } = opts
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

  // 1. Execution failure → never a slash.
  if (execution.status === 'failed') {
    return {
      warrantId,
      action: {
        kind: 'let-expire',
        reason: `KeeperHub execution failed (outcome=${execution.outcome ?? 'unknown'})`,
      },
    }
  }

  if (execution.status !== 'success') {
    return {
      warrantId,
      action: {
        kind: 'let-expire',
        reason: `execution not finished (status=${execution.status})`,
      },
    }
  }

  // 2. With no txHash there is nothing to evaluate. We do not guess.
  if (!execution.txHash) {
    return {
      warrantId,
      action: {
        kind: 'let-expire',
        reason: 'the audit trail reports no txHash for this execution',
      },
    }
  }

  // 3. Confirmations, on an RPC independent of KeeperHub.
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
        reason: `confirmations not obtained: ${errText(e)}`,
      },
    }
  }

  // 4. Evaluation. A read error is not a violation.
  let evaluation: Awaited<ReturnType<EvaluateFn>>
  try {
    evaluation = await opts.evaluate({ txHash: execution.txHash, blockNumber })
  } catch (e) {
    if (e instanceof RpcReadError) {
      return {
        warrantId,
        action: {
          kind: 'let-expire',
          reason: `inconclusive onchain read: ${errText(e)}`,
        },
      }
    }
    throw e
  }

  // 5. Is the settlement window still open? (invariant I9)
  if (now() + SETTLEMENT_MARGIN_SECONDS >= expiry) {
    return {
      warrantId,
      evaluation,
      action: {
        kind: 'let-expire',
        reason:
          'settlement window too close to expiry — honor/slash would revert',
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

/** Short summary of the failed checks, written into the onchain event. */
export function summarizeFailures(
  checks: { kind: string; expected: string; observed: string; pass: boolean }[],
): string {
  const failed = checks.filter((c) => !c.pass)
  if (failed.length === 0) return 'no failed check'
  return failed
    .map((c) => `${c.kind}: expected ${c.expected}, observed ${c.observed}`)
    .join(' | ')
    .slice(0, 400)
}

export interface SubmitOptions {
  escrow: Address
  walletClient: WalletClient
  account: Address
  chain: WalletClient['chain']
}

/** Submits the decision onchain. Split from `decide` so a dry replay stays possible. */
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

/** The full loop: follow the execution, decide, submit. */
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
        reason: `audit trail unreadable: ${errText(e)}`,
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
