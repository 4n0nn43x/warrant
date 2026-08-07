/**
 * The post-condition evaluator — the component that decides whether a bond is
 * returned or slashed.
 *
 * Three invariants govern this whole file (docs/07 § 5):
 *
 * 1. **Reads at a pinned block.** Every call carries an explicit `blockNumber`,
 *    never `latest`. A verdict a third party cannot replay identically is worth
 *    nothing, and that is the project's entire argument.
 * 2. **No implicit tolerance.** The comparison is exact. If a margin is wanted,
 *    it belongs in the committed `value`.
 * 3. **A failed read is not a failed post-condition.** `evaluate()` returns
 *    either a complete verdict or an exception. No path converts an error into a
 *    `slashed`. Doubt benefits the agent, never the protocol.
 *
 * `checks[]` is published in full, passing checks included: a verdict that shows
 * only the check that failed is a verdict nobody can audit.
 */

import type { PublicClient } from 'viem'
import { MAX_CHECKS, actionHash } from 'warrant-core'
import {
  ContextMismatchError,
  InvalidSpecError,
  UnknownCheckKindError,
  read,
} from './checks/errors.js'
import { isKnownKind, runCheck } from './checks/index.js'
import type {
  ActionHasher,
  CheckEnv,
  CheckResult,
  ConditionSpec,
  EvaluateAt,
  EvaluationResult,
  Hex,
  NativeTracer,
} from './checks/types.js'

export { MAX_CHECKS }

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex

export interface EvaluationContext {
  /** The action transaction, as executed. */
  txHash: Hex
  /** Expected inclusion block of that transaction. Cross-checked against the receipt. */
  blockNumber: bigint
  /**
   * An RPC **independent of KeeperHub**: using the same provider to execute and
   * to judge would reintroduce a circularity (docs/07 § 5).
   */
  client: PublicClient
  /** Published in the verdict to make it replayable. Inferred from the transport otherwise. */
  rpcUrl?: string
  /**
   * Version of the classification registry committed to in the `ActionSpec`.
   * Required by `calldata_matches_commitment`: this field is not derivable from
   * the chain, it comes from the warrant.
   */
  registryRef?: Hex
  /**
   * `actionHash` from `warrant-core`. Injected so that the evaluator and the
   * Gateway share exactly one canonicalisation.
   */
  hashAction?: ActionHasher
  /** Optional native-transfer tracer — see `checks/native.ts`. */
  traceNativeTransfers?: NativeTracer
}

/**
 * Evaluates a `ConditionSpec` against an included transaction.
 *
 * @throws {RpcReadError} inconclusive read — the caller retries, then lets the
 *   warrant expire towards `reclaim`. Never a `slashed`.
 * @throws {InvalidSpecError} malformed spec: this case should have been rejected
 *   when the warrant was opened, not at settlement time.
 */
export async function evaluate(
  spec: ConditionSpec,
  ctx: EvaluationContext,
): Promise<EvaluationResult> {
  validateSpec(spec)

  const receipt = await read(`getTransactionReceipt(${ctx.txHash})`, () =>
    ctx.client.getTransactionReceipt({ hash: ctx.txHash }),
  )
  const transaction = await read(`getTransaction(${ctx.txHash})`, () =>
    ctx.client.getTransaction({ hash: ctx.txHash }),
  )

  const txBlock = receipt.blockNumber
  if (txBlock !== ctx.blockNumber) {
    // A reorg, or a wrong context. Inconclusive read: we refuse to rule rather
    // than judge on a block we do not recognise.
    throw new ContextMismatchError(
      `tx ${ctx.txHash} is included at block ${txBlock}, context announced ${ctx.blockNumber}`,
    )
  }

  const evalBlock = resolveEvaluateAt(spec.evaluateAt, txBlock)

  const env: CheckEnv = {
    client: ctx.client,
    txHash: ctx.txHash,
    txBlock,
    evalBlock,
    chainId: spec.chainId,
    receipt,
    transaction,
    registryRef: ctx.registryRef ?? ZERO_HASH,
    hashAction: ctx.hashAction ?? actionHash,
    traceNativeTransfers: ctx.traceNativeTransfers,
  }

  // Every check runs, with no short-circuit: `checks[]` must be complete even
  // when the first one fails.
  const settled = await Promise.allSettled(spec.checks.map((check) => runCheck(check, env)))

  // A single inconclusive read is enough to drain the verdict of meaning. We
  // surface the first error in declaration order — deterministic, therefore
  // reproducible.
  for (const outcome of settled) {
    if (outcome.status === 'rejected') throw outcome.reason
  }

  const checks = settled.map((outcome) => (outcome as PromiseFulfilledResult<CheckResult>).value)

  return {
    // Pure conjunction: all of them must pass.
    verdict: checks.every((check) => check.pass) ? 'honored' : 'slashed',
    evaluatedAtBlock: evalBlock.toString(),
    checks,
    rpcUrl: resolveRpcUrl(ctx),
  }
}

/** Resolves `evaluateAt` to a concrete block number. Never `latest`. */
export function resolveEvaluateAt(evaluateAt: EvaluateAt, txBlock: bigint): bigint {
  if (evaluateAt === 'tx') return txBlock
  if (evaluateAt === 'tx+1') return txBlock + 1n
  if (
    evaluateAt &&
    typeof evaluateAt === 'object' &&
    Number.isInteger(evaluateAt.block) &&
    evaluateAt.block >= 0
  ) {
    return BigInt(evaluateAt.block)
  }
  throw new InvalidSpecError(
    `evaluateAt must be "tx", "tx+1" or { block: n >= 0 }, got ${JSON.stringify(evaluateAt)}`,
  )
}

/**
 * Defensive validation. These refusals belong to warrant opening; repeating them
 * here guarantees that no dubious spec ever produces a verdict — it produces an
 * exception, which slashes nothing.
 */
export function validateSpec(spec: ConditionSpec): void {
  if (!spec || typeof spec !== 'object') {
    throw new InvalidSpecError('conditionSpec must be an object')
  }
  if (spec.version !== 1) {
    throw new InvalidSpecError(`unsupported conditionSpec version: ${JSON.stringify(spec.version)}`)
  }
  if (!Number.isInteger(spec.chainId) || spec.chainId <= 0) {
    throw new InvalidSpecError(`chainId must be a positive integer, got ${JSON.stringify(spec.chainId)}`)
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    throw new InvalidSpecError('checks must be a non-empty array')
  }

  for (const check of spec.checks) {
    if (!check || typeof check !== 'object' || !isKnownKind((check as { kind: string }).kind)) {
      throw new UnknownCheckKindError(String((check as { kind?: string })?.kind))
    }
  }

  // `calldata_matches_commitment` sits outside the quota (docs/07 § 2.10).
  const declared = spec.checks.filter((check) => check.kind !== 'calldata_matches_commitment')
  if (declared.length > MAX_CHECKS) {
    throw new InvalidSpecError(
      `at most ${MAX_CHECKS} declared checks, got ${declared.length}`,
    )
  }

  const commitments = spec.checks.filter((check) => check.kind === 'calldata_matches_commitment')
  if (commitments.length > 1) {
    throw new InvalidSpecError('calldata_matches_commitment must appear at most once')
  }
}

function resolveRpcUrl(ctx: EvaluationContext): string {
  if (ctx.rpcUrl) return ctx.rpcUrl
  const transport = (ctx.client as { transport?: { url?: unknown } }).transport
  return typeof transport?.url === 'string' ? transport.url : ''
}

export {
  ContextMismatchError,
  InvalidSpecError,
  RpcReadError,
  UnknownCheckKindError,
  UnsupportedCheckError,
} from './checks/errors.js'
export type { ActionHasher, CheckEnv, NativeTracer, NativeTransfer } from './checks/types.js'
