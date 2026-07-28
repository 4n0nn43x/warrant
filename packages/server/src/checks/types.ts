/**
 * Point d'entrée unique des types partagés, côté évaluateur.
 *
 * Tous les emprunts à `@warrant/core` passent par ce fichier et sont
 * **exclusivement des types** (`import type` / `export type`), donc effacés à la
 * compilation : l'évaluateur n'a aucune dépendance runtime sur `core`, et ses
 * tests tournent même tant que `packages/core/dist` est vide. Seul
 * `tsc --noEmit` exigera que `core` soit buildé, comme pour `src/keeperhub.ts`.
 *
 * Ce que `core` doit exporter pour que ce fichier compile : les types listés
 * ci-dessous, et — pour `ctx.hashAction` — `actionHash(spec: ActionSpec): Hex`.
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
} from '@warrant/core'

import type { ActionSpec, Address, Hex } from '@warrant/core'
import type { PublicClient, Transaction, TransactionReceipt } from 'viem'

/** Un transfert natif observé, top-level ou interne. */
export interface NativeTransfer {
  from: Address
  to: Address
  value: bigint
}

/**
 * Tracer optionnel de transferts natifs. Les receipts standard n'exposent pas
 * les appels internes ; si l'opérateur dispose d'un noeud avec
 * `debug_traceTransaction` ou `trace_transaction`, il l'injecte ici et
 * `native_balance_delta` devient décidable sur les appels de contrat.
 */
export type NativeTracer = (txHash: Hex) => Promise<NativeTransfer[]>

/**
 * Signature de `actionHash` de `@warrant/core` (docs/07 § 4).
 *
 * Injectable uniquement pour les tests. En production, l'évaluateur utilise
 * l'implémentation de `@warrant/core` et rien d'autre : deux canonicalisations
 * divergentes entre le client et le serveur rendraient tout mandat inévaluable,
 * c'est le risque R1 de docs/13-risques.md.
 */
export type ActionHasher = (spec: ActionSpec) => Hex

/**
 * Contexte de lecture partagé par tous les vérificateurs d'une évaluation.
 * Receipt et transaction sont lus une seule fois et réutilisés : deux
 * évaluations du même mandat doivent produire exactement le même document.
 */
export interface CheckEnv {
  client: PublicClient
  txHash: Hex
  /** Bloc d'inclusion de la transaction d'action, lu depuis le receipt. */
  txBlock: bigint
  /** Bloc de lecture résolu depuis `evaluateAt`. Jamais `latest`. */
  evalBlock: bigint
  /** `chainId` de la `ConditionSpec`. */
  chainId: number
  receipt: TransactionReceipt
  transaction: Transaction
  /** Version du registre de classification engagée dans l'`ActionSpec`. */
  registryRef: Hex
  hashAction: ActionHasher
  traceNativeTransfers?: NativeTracer | undefined
}
