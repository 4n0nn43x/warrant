/**
 * Types partagés de Warrant.
 *
 * Ce fichier est le contrat d'interface entre tous les modules. Il est
 * délibérément sans dépendance runtime : rien d'autre que des types et
 * quelques constantes littérales.
 *
 * Références : docs/07-postconditions.md, docs/13-risques.md § 5.
 */

export type Hex = `0x${string}`
export type Address = Hex

/** Comparateurs admis par les vérificateurs numériques. */
export type Op = 'eq' | 'lte' | 'gte'

// ─────────────────────────────────────────────────────────────────────────────
// Post-conditions — le DSL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Catalogue fermé des vérificateurs. Un `kind` hors de cette liste est rejeté
 * à l'ouverture du mandat, jamais au règlement (docs/07 § 3).
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
 * Delta de solde ERC-20 attribuable à la transaction d'action.
 *
 * Le delta est dérivé des logs `Transfer` de la transaction elle-même, et non
 * d'une différence de soldes entre deux blocs : sur un compte actif, une autre
 * transaction incluse dans le même bloc serait imputée à l'agent et produirait
 * une saisie injuste.
 */
export interface Erc20BalanceDeltaCheck {
  kind: 'erc20_balance_delta'
  token: Address
  account: Address
  op: Op
  /** Delta signé, en unités atomiques. Négatif = sortie tolérée. */
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
  /** Health factor en 1e18 — "1500000000000000000" = 1,5. */
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
 * Progression du nonce du compte exécutant, mesurée comme un **delta** entre le
 * bloc précédant la transaction et le bloc d'évaluation.
 *
 * Ce n'est pas un nonce absolu : le wallet d'exécution KeeperHub est réutilisé
 * et son nonce est arbitrairement grand.
 */
export interface NonceAdvancedCheck {
  kind: 'nonce_advanced'
  account: Address
  op: Op
  /** Nombre de transactions attribuées au compte sur la fenêtre évaluée. */
  value: string
}

export interface NoNewApprovalsCheck {
  kind: 'no_new_approvals'
  owner: Address
  tokens: Address[]
}

/**
 * Vérifie que la transaction exécutée onchain est bien celle engagée sous
 * `actionHash`. Injecté d'office par le Gateway, non retirable, hors quota
 * de `MAX_CHECKS` (docs/07 § 2.10, docs/13 § 5).
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

/** Bloc auquel la post-condition est lue. Jamais `latest`. */
export type EvaluateAt = 'tx' | 'tx+1' | { block: number }

export interface ConditionSpec {
  version: 1
  chainId: number
  evaluateAt: EvaluateAt
  confirmations: number
  /** Conjonction pure : toutes doivent passer. Pas de OR, pas de branchement. */
  checks: Check[]
}

/** Nombre maximal de checks *déclarés*. `calldata_matches_commitment` est hors quota. */
export const MAX_CHECKS = 8

/** Confirmations par défaut, par famille de chaîne (docs/07 § 1). */
export const DEFAULT_CONFIRMATIONS = { l1: 12, l2: 3 } as const

// ─────────────────────────────────────────────────────────────────────────────
// Actions — ce qui est engagé et exécuté
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La transaction que KeeperHub exécutera, engagée sous `actionHash`.
 *
 * C'est le **seul** intrant de la classification : aucun champ déclaratif de la
 * requête de l'agent n'entre dans le choix de la politique (docs/13 § 5).
 */
export interface ActionSpec {
  version: 1
  chainId: number
  target: Address
  /** Valeur native envoyée, en wei, en chaîne décimale. */
  value: string
  calldata: Hex
  /** Hash de la version du registre de classification utilisée. */
  registryRef: Hex
}

/** Catégories connues du registre. `unknown` déclenche le repli le plus strict. */
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
  /** Arguments décodés du calldata, en chaînes. */
  params: Record<string, string>
  /** Notionnel dérivé des arguments décodés — jamais déclaré par l'agent. */
  notionalUSD: string
  registryRef: Hex
}

/**
 * Une entrée du registre de classification, indexée par `(target, selector)`.
 *
 * La clé est le couple, pas le seul sélecteur : `transfer(address,uint256)` sur
 * l'USDC du trésor et le même sélecteur sur un token sans valeur ne sont pas la
 * même action.
 */
export interface RegistryEntry {
  chainId: number
  target: Address
  selector: Hex
  category: Exclude<ActionCategory, 'unknown'>
  /** Signature ABI humaine, ex. "transfer(address,uint256)". */
  signature: string
  /** Noms des arguments, dans l'ordre du décodage. */
  argNames: string[]
  /** Décimales de l'actif porté par cette action, pour dériver le notionnel. */
  assetDecimals?: number
  /** Prix de référence en USD, figé dans le registre. Pas d'oracle en v1. */
  assetPriceUSD?: string
}

export interface ClassificationRegistry {
  version: number
  entries: RegistryEntry[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarification du risque
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryPolicy {
  riskBps: number
  /** Destinations autorisées pour les catégories sortantes. */
  allowedDest?: Address[]
  /** Sortie maximale tolérée, en unités atomiques de l'actif. */
  maxOutflow?: string
}

export interface Policy {
  /** Bénéficiaire des saisies : le propriétaire du capital. */
  beneficiary: Address
  /** Compte protégé (trésor) sur lequel portent les post-conditions. */
  treasury: Address
  minBond: string
  maxBond: string
  /** Durée du mandat en secondes. Doit couvrir exécution + confirmations. */
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
// Mandats et verdicts
// ─────────────────────────────────────────────────────────────────────────────

/** Miroir de l'enum Solidity. Voir contracts/src/WarrantEscrow.sol. */
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
  /** Publié : rend le verdict rejouable par un tiers. */
  rpcUrl: string
}

/**
 * Document de verdict servi à une URI stable. Son `keccak256` canonicalisé est
 * ce qui est engagé dans l'event `NewFeedback` d'ERC-8004.
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
