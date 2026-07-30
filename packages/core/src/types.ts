/**
 * Warrant's shared types.
 *
 * This file is the interface contract between every module. It is deliberately
 * free of any runtime dependency: nothing but types and a few literal
 * constants.
 *
 * References: docs/07-postconditions.md, docs/13-risques.md § 5.
 */

export type Hex = `0x${string}`
export type Address = Hex

/** Comparators admitted by the numeric checks. */
export type Op = 'eq' | 'lte' | 'gte'

// ─────────────────────────────────────────────────────────────────────────────
// Post-conditions — the DSL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closed catalogue of checks. A `kind` outside this list is rejected when the
 * warrant is opened, never at settlement (docs/07 § 3).
 */
export type CheckKind =
  | 'erc20_allowance'
  | 'erc20_balance'
  | 'erc20_balance_delta'
  | 'native_balance_delta'
  | 'aave_health_factor'
  | 'staticcall_result'
  | 'event_emitted'
  | 'nonce_advanced'
  | 'no_new_approvals'
  | 'calldata_matches_commitment'

export interface Erc20AllowanceCheck {
  kind: 'erc20_allowance'
  token: Address
  owner: Address
  spender: Address
  op: Op
  value: string
}

export interface Erc20BalanceCheck {
  kind: 'erc20_balance'
  token: Address
  account: Address
  op: Op
  value: string
}

/**
 * ERC-20 balance delta attributable to the action transaction.
 *
 * The delta is derived from the `Transfer` logs of the transaction itself, not
 * from a balance difference between two blocks: on an active account, another
 * transaction included in the same block would be charged to the agent and
 * would produce an unfair slash.
 */
export interface Erc20BalanceDeltaCheck {
  kind: 'erc20_balance_delta'
  token: Address
  account: Address
  op: Op
  /** Signed delta, in atomic units. Negative = tolerated outflow. */
  value: string
}

export interface NativeBalanceDeltaCheck {
  kind: 'native_balance_delta'
  account: Address
  op: Op
  value: string
}

export interface AaveHealthFactorCheck {
  kind: 'aave_health_factor'
  pool: Address
  user: Address
  op: Op
  /** Health factor in 1e18 — "1500000000000000000" = 1.5. */
  value: string
}

export interface StaticcallResultCheck {
  kind: 'staticcall_result'
  target: Address
  data: Hex
  decodeAs: 'uint256' | 'int256' | 'bool' | 'address' | 'bytes32'
  op: Op
  value: string
}

export interface EventEmittedCheck {
  kind: 'event_emitted'
  address: Address
  topic0: Hex
  minCount: number
}

/**
 * Nonce progression of the executing account, measured as a **delta** between
 * the block preceding the transaction and the evaluation block.
 *
 * This is not an absolute nonce: the KeeperHub execution wallet is reused and
 * its nonce is arbitrarily large.
 */
export interface NonceAdvancedCheck {
  kind: 'nonce_advanced'
  account: Address
  op: Op
  /** Number of transactions attributed to the account over the evaluated window. */
  value: string
}

export interface NoNewApprovalsCheck {
  kind: 'no_new_approvals'
  owner: Address
  tokens: Address[]
}

/**
 * Verifies that the transaction executed onchain is the one committed under
 * `actionHash`. Injected unconditionally by the Gateway, not removable, out of
 * the `MAX_CHECKS` quota (docs/07 § 2.10, docs/13 § 5).
 */
export interface CalldataMatchesCommitmentCheck {
  kind: 'calldata_matches_commitment'
  actionHash: Hex
}

export type Check =
  | Erc20AllowanceCheck
  | Erc20BalanceCheck
  | Erc20BalanceDeltaCheck
  | NativeBalanceDeltaCheck
  | AaveHealthFactorCheck
  | StaticcallResultCheck
  | EventEmittedCheck
  | NonceAdvancedCheck
  | NoNewApprovalsCheck
  | CalldataMatchesCommitmentCheck

/** Block at which the post-condition is read. Never `latest`. */
export type EvaluateAt = 'tx' | 'tx+1' | { block: number }

export interface ConditionSpec {
  version: 1
  chainId: number
  evaluateAt: EvaluateAt
  confirmations: number
  /** Pure conjunction: every one must pass. No OR, no branching. */
  checks: Check[]
}

/** Maximum number of *declared* checks. `calldata_matches_commitment` is out of quota. */
export const MAX_CHECKS = 8

/** Default confirmations, per chain family (docs/07 § 1). */
export const DEFAULT_CONFIRMATIONS = { l1: 12, l2: 3 } as const

// ─────────────────────────────────────────────────────────────────────────────
// Actions — what is committed to and executed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The transaction KeeperHub will execute, committed under `actionHash`.
 *
 * It is the **only** input to classification: no declarative field of the
 * agent's request has any bearing on which policy applies (docs/13 § 5).
 */
export interface ActionSpec {
  version: 1
  chainId: number
  target: Address
  /** Native value sent, in wei, as a decimal string. */
  value: string
  calldata: Hex
  /** Hash of the classification registry version used. */
  registryRef: Hex
}

/** Categories known to the registry. `unknown` triggers the strictest fallback. */
export type ActionCategory =
  | 'erc20.transfer'
  | 'erc20.approve'
  | 'aavev3.repay'
  | 'aavev3.supply'
  | 'aavev3.withdraw'
  | 'aavev3.borrow'
  | 'unknown'

export interface Classification {
  category: ActionCategory
  /** Arguments decoded from the calldata, as strings. */
  params: Record<string, string>
  /** Notional derived from the decoded arguments — never declared by the agent. */
  notionalUSD: string
  registryRef: Hex
}

/**
 * An entry of the classification registry, indexed by `(target, selector)`.
 *
 * The key is the pair, not the selector alone: `transfer(address,uint256)` on
 * the treasury's USDC and the same selector on a worthless token are not the
 * same action.
 */
export interface RegistryEntry {
  chainId: number
  target: Address
  selector: Hex
  category: Exclude<ActionCategory, 'unknown'>
  /** Human-readable ABI signature, e.g. "transfer(address,uint256)". */
  signature: string
  /** Argument names, in decoding order. */
  argNames: string[]
  /** Decimals of the asset carried by this action, used to derive the notional. */
  assetDecimals?: number
  /** Reference price in USD, frozen in the registry. No oracle in v1. */
  assetPriceUSD?: string
}

export interface ClassificationRegistry {
  version: number
  entries: RegistryEntry[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk pricing
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryPolicy {
  riskBps: number
  /** Allowed destinations for outbound categories. */
  allowedDest?: Address[]
  /** Maximum tolerated outflow, in atomic units of the asset. */
  maxOutflow?: string
}

export interface Policy {
  /** Recipient of slashed bonds: the capital owner. */
  beneficiary: Address
  /** Protected account (treasury) the post-conditions bear on. */
  treasury: Address
  minBond: string
  maxBond: string
  /** Warrant duration in seconds. Must cover execution + confirmations. */
  duration: number
  categories: Record<string, CategoryPolicy>
}

export interface Quote {
  category: ActionCategory
  bond: string
  riskBps: number
  notionalUSD: string
  conditionSpec: ConditionSpec
  rationale: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Warrants and verdicts
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of the Solidity enum. See contracts/src/WarrantEscrow.sol. */
export enum WarrantStatus {
  None = 0,
  Open = 1,
  Honored = 2,
  Slashed = 3,
  Reclaimed = 4,
}

export interface Warrant {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: string
  conditionHash: Hex
  actionHash: Hex
  fundingRef: Hex
  expiry: number
  openedAt: number
  status: WarrantStatus
}

export interface CheckResult {
  kind: CheckKind
  expected: string
  observed: string
  pass: boolean
}

export interface EvaluationResult {
  verdict: 'honored' | 'slashed'
  evaluatedAtBlock: string
  checks: CheckResult[]
  /** Published: makes the verdict replayable by a third party. */
  rpcUrl: string
}

/**
 * Verdict document served at a stable URI. Its canonicalized `keccak256` is
 * what gets committed in ERC-8004's `NewFeedback` event.
 */
export interface VerdictDocument {
  warrantId: Hex
  executionId: string
  txHash: Hex
  blockNumber: string
  gasUsed: string
  outcome: string
  conditionSpec: ConditionSpec
  actionSpec: ActionSpec
  classification: Classification
  checks: CheckResult[]
  verdict: 'honored' | 'slashed'
  evaluatedAtBlock: string
  rpcUrl: string
  settlementTx?: Hex
  reputationTx?: Hex
}
