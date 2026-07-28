export type Hex = `0x${string}`
export type Address = Hex

/** Verdict d'un mandat réglé. Un mandat expiré (`reclaimed`) n'en est pas un. */
export type Verdict = 'honored' | 'slashed'

/**
 * Un log brut, tel que le rend `eth_getLogs`. Volontairement structurel : le
 * lecteur n'exige aucun client particulier et se teste sur des logs simulés.
 */
export interface RawLog {
  address: Address
  topics: readonly Hex[]
  data: Hex
  blockNumber: bigint | null
  logIndex: number | null
  transactionHash: Hex | null
}

/** Un feedback ERC-8004, décodé depuis `NewFeedback`. */
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

/** Un règlement de mandat, décodé depuis `WarrantHonored` / `WarrantSlashed`. */
export interface SettlementRecord {
  warrantId: Hex
  verdict: Verdict
  /**
   * La caution immobilisée, en unités atomiques de l'actif de l'escrow.
   * `refunded + fee` sur un `WarrantHonored`, `amount` sur un `WarrantSlashed`.
   */
  bond: bigint
  execRef: Hex
  blockNumber: bigint | null
  transactionHash: Hex | null
}

/** Une ouverture de mandat, décodée depuis `WarrantOpened`. */
export interface OpeningRecord {
  warrantId: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  fundingRef: Hex
  expiry: bigint
  blockNumber: bigint | null
}

/** Un mandat réglé, rattaché à un agent. L'unité de calcul du score. */
export interface SettledWarrant {
  warrantId: Hex
  verdict: Verdict
  bond: bigint
  blockNumber: bigint | null
}
