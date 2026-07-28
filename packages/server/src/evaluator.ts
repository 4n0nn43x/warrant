/**
 * L'évaluateur de post-conditions — le composant qui décide si une caution est
 * rendue ou saisie.
 *
 * Trois invariants gouvernent tout ce fichier (docs/07 § 5) :
 *
 * 1. **Lecture à bloc figé.** Chaque appel porte un `blockNumber` explicite,
 *    jamais `latest`. Un verdict qu'un tiers ne peut pas rejouer à l'identique
 *    ne vaut rien, et c'est tout l'argument du projet.
 * 2. **Aucune tolérance implicite.** La comparaison est exacte. Si une marge est
 *    voulue, elle est dans la `value` engagée.
 * 3. **Échec de lecture ≠ échec de post-condition.** `evaluate()` rend soit un
 *    verdict complet, soit une exception. Aucun chemin ne convertit une erreur
 *    en `slashed`. Le doute bénéficie à l'agent, jamais au protocole.
 *
 * `checks[]` est publié intégralement, y compris les vérifications passées : un
 * verdict qui ne montre que la vérification échouée est un verdict qu'on ne
 * peut pas auditer.
 */

import type { PublicClient } from 'viem'
import { MAX_CHECKS, actionHash } from '@warrant/core'
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
  /** Transaction d'action, telle qu'exécutée. */
  txHash: Hex
  /** Bloc d'inclusion attendu de cette transaction. Recoupé avec le receipt. */
  blockNumber: bigint
  /**
   * RPC **indépendant de KeeperHub** : utiliser le même fournisseur pour
   * exécuter et pour juger réintroduirait une circularité (docs/07 § 5).
   */
  client: PublicClient
  /** Publié dans le verdict pour le rendre rejouable. Déduit du transport sinon. */
  rpcUrl?: string
  /**
   * Version du registre de classification engagée dans l'`ActionSpec`.
   * Nécessaire à `calldata_matches_commitment` : ce champ n'est pas dérivable
   * de la chaîne, il vient du mandat.
   */
  registryRef?: Hex
  /**
   * `actionHash` de `@warrant/core`. Injecté pour que l'évaluateur et le
   * Gateway partagent exactement une canonicalisation.
   */
  hashAction?: ActionHasher
  /** Tracer optionnel de transferts natifs — voir `checks/native.ts`. */
  traceNativeTransfers?: NativeTracer
}

/**
 * Évalue une `ConditionSpec` contre une transaction incluse.
 *
 * @throws {RpcReadError} lecture non concluante — l'appelant retente, puis
 *   laisse le mandat expirer vers `reclaim`. Jamais un `slashed`.
 * @throws {InvalidSpecError} spec malformée : ce cas aurait dû être rejeté à
 *   l'ouverture du mandat, pas au règlement.
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
    // Réorganisation, ou contexte erroné. Lecture non concluante : on refuse de
    // trancher plutôt que de juger sur un bloc qu'on ne reconnaît pas.
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

  // Toutes les vérifications sont exécutées, sans court-circuit : `checks[]`
  // doit être complet même quand la première échoue.
  const settled = await Promise.allSettled(spec.checks.map((check) => runCheck(check, env)))

  // Une seule lecture non concluante suffit à priver le verdict de sens. On
  // relève la première erreur dans l'ordre déclaré — déterministe, donc
  // reproductible.
  for (const outcome of settled) {
    if (outcome.status === 'rejected') throw outcome.reason
  }

  const checks = settled.map((outcome) => (outcome as PromiseFulfilledResult<CheckResult>).value)

  return {
    // Conjonction pure : toutes doivent passer.
    verdict: checks.every((check) => check.pass) ? 'honored' : 'slashed',
    evaluatedAtBlock: evalBlock.toString(),
    checks,
    rpcUrl: resolveRpcUrl(ctx),
  }
}

/** Résout `evaluateAt` en un numéro de bloc concret. Jamais `latest`. */
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
 * Validation défensive. Ces refus appartiennent à l'ouverture du mandat ; les
 * répéter ici garantit qu'aucune spec douteuse ne produit un verdict — elle
 * produit une exception, qui ne saisit rien.
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

  // `calldata_matches_commitment` est hors quota (docs/07 § 2.10).
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
