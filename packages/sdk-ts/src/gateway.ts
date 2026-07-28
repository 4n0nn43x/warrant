/**
 * L'interface du Gateway Warrant, vue depuis les adaptateurs.
 *
 * C'est la **seule** dépendance des outils. Le serveur MCP, le client SDK et
 * l'adaptateur Vercel AI ne connaissent rien d'autre : ni HTTP, ni base64, ni
 * en-têtes `PAYMENT-REQUIRED`. Toute la mécanique de transport reste derrière
 * cette frontière, ce qui rend les quatre outils testables sans réseau.
 *
 * Contrepartie assumée : le Gateway doit traduire son 402 HTTP en un
 * `{ status: 'payment-required' }` explicite plutôt que de lever une exception.
 * Une exigence de paiement n'est pas une erreur — c'est une étape normale du
 * protocole, et la modéliser comme une erreur pousse tous les appelants à faire
 * du contrôle de flux par `catch`.
 */

import type {
  ActionCategory,
  ActionSpec,
  Address,
  CheckResult,
  ConditionSpec,
  Hex,
  WarrantStatus,
} from '@warrant/core'
import type { PaymentPayload, PaymentRequired, SettlementResponse } from './x402.js'

// ─────────────────────────────────────────────────────────────────────────────
// quote_risk
// ─────────────────────────────────────────────────────────────────────────────

export interface QuoteRequest {
  actionSpec: ActionSpec
  /**
   * Bénéficiaire des saisies. Optionnel au devis : il n'entre pas dans le prix,
   * seulement dans la post-condition construite quand il est fourni.
   */
  beneficiary?: Address
}

export interface QuoteResult {
  /** Dérivée du calldata par le Classifieur. Jamais déclarée par l'agent. */
  category: ActionCategory
  /** Caution en unités atomiques de l'actif de caution (USDC, 6 décimales). */
  bond: string
  riskBps: number
  /** Notionnel dérivé des arguments décodés — publié pour rendre le prix lisible. */
  notionalUSD: string
  conditionSpec: ConditionSpec
  /** Explication en une phrase du prix retenu. */
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
  /** Identifiant d'exécution KeeperHub. */
  executionId: string
  conditionHash: Hex
  actionHash: Hex
  /** Timestamp Unix en secondes. */
  expiry: number
  bond?: string
  fundingRef?: Hex
}

/**
 * Deux issues, une seule forme. `payment-required` porte l'objet à recopier tel
 * quel dans le résultat d'outil MCP ; `opened` porte le mandat et, si le rail
 * x402 a été emprunté, le règlement à replacer dans `_meta`.
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
  /** RPC utilisé pour l'évaluation — publié pour rendre le verdict rejouable. */
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
  /** Présent seulement une fois le mandat réglé. */
  verdict?: WarrantVerdict
  /**
   * Un résultat par vérification, y compris celles qui passent — un verdict qui
   * ne montre que la vérification échouée n'est pas auditable (docs/04).
   * Tableau vide tant que le mandat n'est pas réglé.
   */
  checks: CheckResult[]
}

export interface ListWarrantsQuery {
  agent: Address
  status?: 'open' | 'honored' | 'slashed' | 'reclaimed'
  category?: ActionCategory
  /** Timestamps Unix en secondes, sur `openedAt`. */
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
  /** Sommes en unités atomiques. */
  totalBonded: string
  totalSlashed: string
  /** Part de mandats réglés qui ont été honorés, en points de base. */
  honorRateBps: number
}

export interface ListWarrantsResult {
  warrants: WarrantView[]
  stats: WarrantStats
  nextCursor?: string
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les quatre appels que le Gateway doit servir. Rien de plus.
 *
 * `requestWarrant` est le seul à prendre un paiement optionnel : c'est aussi le
 * seul outil payant, et cette asymétrie doit se voir dans la signature.
 */
export interface GatewayClient {
  quote(req: QuoteRequest): Promise<QuoteResult>
  requestWarrant(req: WarrantRequest, payment?: PaymentPayload): Promise<RequestWarrantResult>
  /** `null` — et non une exception — quand le mandat n'existe pas. */
  getWarrant(warrantId: Hex): Promise<WarrantView | null>
  listWarrants(query: ListWarrantsQuery): Promise<ListWarrantsResult>
}
