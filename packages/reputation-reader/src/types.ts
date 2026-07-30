export type Hex = `0x${string}`
export type Address = Hex

/** Verdict of a settled warrant. An expired warrant (`reclaimed`) is not one. */
export type Verdict = 'honored' | 'slashed'

/**
 * A raw log, as `eth_getLogs` returns it. Deliberately structural: the reader
 * requires no particular client and is tested against simulated logs.
 */
export interface RawLog {
  address: Address
  topics: readonly Hex[]
  data: Hex
  blockNumber: bigint | null
  logIndex: number | null
  transactionHash: Hex | null
}

/** An ERC-8004 feedback, decoded from `NewFeedback`. */
export interface FeedbackRecord {
  agentId: bigint
  clientAddress: Address
  feedbackIndex: bigint
  value: bigint
  valueDecimals: number
  tag1: string
  tag2: string
  endpoint: string
  feedbackURI: string
  feedbackHash: Hex
  blockNumber: bigint | null
  logIndex: number | null
  transactionHash: Hex | null
}

/** A warrant settlement, decoded from `WarrantHonored` / `WarrantSlashed`. */
export interface SettlementRecord {
  warrantId: Hex
  verdict: Verdict
  /**
   * The bond that was locked up, in atomic units of the escrow's asset.
   * `refunded + fee` on a `WarrantHonored`, `amount` on a `WarrantSlashed`.
   */
  bond: bigint
  execRef: Hex
  blockNumber: bigint | null
  transactionHash: Hex | null
}

/** A warrant opening, decoded from `WarrantOpened`. */
export interface OpeningRecord {
  warrantId: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  fundingRef: Hex
  expiry: bigint
  blockNumber: bigint | null
}

/** A settled warrant, attributed to an agent. The unit the score is computed on. */
export interface SettledWarrant {
  warrantId: Hex
  verdict: Verdict
  bond: bigint
  blockNumber: bigint | null
}
