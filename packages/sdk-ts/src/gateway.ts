/**
 * The Warrant Gateway interface, seen from the adapters.
 *
 * This is the **only** dependency the tools have. The MCP server, the SDK client
 * and the Vercel AI adapter know nothing else: no HTTP, no base64, no
 * `PAYMENT-REQUIRED` headers. All the transport machinery stays behind this
 * boundary, which makes the four tools testable without a network.
 *
 * Trade-off accepted: the Gateway must translate its HTTP 402 into an explicit
 * `{ status: 'payment-required' }` rather than throw an exception. A payment
 * requirement is not an error — it is a normal step of the protocol, and
 * modelling it as an error pushes every caller into doing flow control with
 * `catch`.
 */

import type {
  ActionCategory,
  ActionSpec,
  Address,
  CheckResult,
  ConditionSpec,
  Hex,
  WarrantStatus,
} from 'warrant-core'
import type { PaymentPayload, PaymentRequired, SettlementResponse } from './x402.js'

// ─────────────────────────────────────────────────────────────────────────────
// quote_risk
// ─────────────────────────────────────────────────────────────────────────────

export interface QuoteRequest {
  actionSpec: ActionSpec
  /**
   * Beneficiary of any slash. Optional at quote time: it does not enter the
   * price, only the post-condition built when it is supplied.
   */
  beneficiary?: Address
}

export interface QuoteResult {
  /** Derived from the calldata by the Classifier. Never declared by the agent. */
  category: ActionCategory
  /** Bond in atomic units of the bonding asset (USDC, 6 decimals). */
  bond: string
  riskBps: number
  /** Notional derived from the decoded arguments — published to make the price legible. */
  notionalUSD: string
  conditionSpec: ConditionSpec
  /** One-sentence explanation of the price arrived at. */
  rationale: string
}

// ─────────────────────────────────────────────────────────────────────────────
// request_warrant
// ─────────────────────────────────────────────────────────────────────────────

export interface WarrantRequest {
  actionSpec: ActionSpec
  beneficiary: Address
}

export interface WarrantOpened {
  warrantId: Hex
  /** KeeperHub execution identifier. */
  executionId: string
  conditionHash: Hex
  actionHash: Hex
  /** Unix timestamp in seconds. */
  expiry: number
  bond?: string
  fundingRef?: Hex
}

/**
 * Two outcomes, a single shape. `payment-required` carries the object to be
 * copied verbatim into the MCP tool result; `opened` carries the warrant and, if
 * the x402 rail was taken, the settlement to place back into `_meta`.
 */
export type RequestWarrantResult =
  | { status: 'payment-required'; paymentRequired: PaymentRequired }
  | { status: 'opened'; warrant: WarrantOpened; settlement?: SettlementResponse }

// ─────────────────────────────────────────────────────────────────────────────
// get_warrant / list_warrants
// ─────────────────────────────────────────────────────────────────────────────

export interface WarrantVerdict {
  verdict: 'honored' | 'slashed'
  evaluatedAtBlock: string
  /** RPC used for the evaluation — published to make the verdict replayable. */
  rpcUrl: string
  txHash?: Hex
  blockNumber?: string
  gasUsed?: string
  outcome?: string
  settlementTx?: Hex
  reputationTx?: Hex
}

export interface WarrantView {
  warrantId: Hex
  agent: Address
  beneficiary: Address
  bond: string
  conditionHash: Hex
  actionHash: Hex
  fundingRef?: Hex
  expiry: number
  openedAt: number
  status: WarrantStatus
  category?: ActionCategory
  executionId?: string
  actionSpec?: ActionSpec
  conditionSpec?: ConditionSpec
  /** Present only once the warrant is settled. */
  verdict?: WarrantVerdict
  /**
   * One result per check, including the ones that pass — a verdict that shows
   * only the failed check is not auditable (docs/04). Empty array as long as the
   * warrant is unsettled.
   */
  checks: CheckResult[]
}

export interface ListWarrantsQuery {
  agent: Address
  status?: 'open' | 'honored' | 'slashed' | 'reclaimed'
  category?: ActionCategory
  /** Unix timestamps in seconds, against `openedAt`. */
  since?: number
  until?: number
  limit?: number
  cursor?: string
}

export interface WarrantStats {
  total: number
  open: number
  honored: number
  slashed: number
  reclaimed: number
  /** Sums in atomic units. */
  totalBonded: string
  totalSlashed: string
  /** Share of settled warrants that were honored, in basis points. */
  honorRateBps: number
}

export interface ListWarrantsResult {
  warrants: WarrantView[]
  stats: WarrantStats
  nextCursor?: string
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four calls the Gateway must serve. Nothing more.
 *
 * `requestWarrant` is the only one that takes an optional payment: it is also
 * the only paid tool, and that asymmetry ought to be visible in the signature.
 */
export interface GatewayClient {
  quote(req: QuoteRequest): Promise<QuoteResult>
  requestWarrant(req: WarrantRequest, payment?: PaymentPayload): Promise<RequestWarrantResult>
  /** `null` — and not an exception — when the warrant does not exist. */
  getWarrant(warrantId: Hex): Promise<WarrantView | null>
  listWarrants(query: ListWarrantsQuery): Promise<ListWarrantsResult>
}
