/**
 * The single entry point for the shared types, on the evaluator's side.
 *
 * Everything borrowed from `warrant-core` goes through this file, and every
 * borrowing is **types only** (`import type` / `export type`), hence erased at
 * compile time: the evaluator has no runtime dependency on `core`, and its tests
 * run even while `packages/core/dist` is still empty. Only `tsc --noEmit` will
 * require `core` to have been built, as is already the case for
 * `src/keeperhub.ts`.
 *
 * What `core` must export for this file to compile: the types listed below,
 * and — for `ctx.hashAction` — `actionHash(spec: ActionSpec): Hex`.
 */
export type {
  ActionSpec,
  Address,
  AaveHealthFactorCheck,
  CalldataMatchesCommitmentCheck,
  Check,
  CheckKind,
  CheckResult,
  ConditionSpec,
  Erc20AllowanceCheck,
  Erc20BalanceCheck,
  Erc20BalanceDeltaCheck,
  EvaluateAt,
  EvaluationResult,
  EventEmittedCheck,
  Hex,
  NativeBalanceDeltaCheck,
  NoNewApprovalsCheck,
  NonceAdvancedCheck,
  Op,
  StaticcallResultCheck,
} from 'warrant-core'

import type { ActionSpec, Address, Hex } from 'warrant-core'
import type { PublicClient, Transaction, TransactionReceipt } from 'viem'

/** An observed native transfer, top-level or internal. */
export interface NativeTransfer {
  from: Address
  to: Address
  value: bigint
}

/**
 * Optional tracer for native transfers. Standard receipts do not expose internal
 * calls; if the operator has a node with `debug_traceTransaction` or
 * `trace_transaction`, they inject it here and `native_balance_delta` becomes
 * decidable on contract calls.
 */
export type NativeTracer = (txHash: Hex) => Promise<NativeTransfer[]>

/**
 * Signature of `actionHash` from `warrant-core` (docs/07 § 4).
 *
 * Injectable for tests only. In production the evaluator uses the
 * `warrant-core` implementation and nothing else: two diverging
 * canonicalisations between client and server would make every warrant
 * unevaluable — that is risk R1 in docs/13-risques.md.
 */
export type ActionHasher = (spec: ActionSpec) => Hex

/**
 * The read context shared by every check of a single evaluation. Receipt and
 * transaction are read once and reused: two evaluations of the same warrant must
 * produce exactly the same document.
 */
export interface CheckEnv {
  client: PublicClient
  txHash: Hex
  /** Inclusion block of the action transaction, read from the receipt. */
  txBlock: bigint
  /** Read block resolved from `evaluateAt`. Never `latest`. */
  evalBlock: bigint
  /** `chainId` of the `ConditionSpec`. */
  chainId: number
  receipt: TransactionReceipt
  transaction: Transaction
  /** Version of the classification registry committed to in the `ActionSpec`. */
  registryRef: Hex
  hashAction: ActionHasher
  traceNativeTransfers?: NativeTracer | undefined
}
