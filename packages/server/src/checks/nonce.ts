/**
 * `nonce_advanced` — nombre de transactions attribuées au compte sur la fenêtre
 * évaluée.
 *
 * C'est un **delta**, jamais un nonce absolu :
 *
 *     getTransactionCount(account, evaluateAt)
 *   - getTransactionCount(account, tx.blockNumber - 1)
 *
 * Le wallet d'exécution KeeperHub est réutilisé d'un mandat à l'autre ; son
 * nonce absolu est arbitrairement grand et n'a aucun sens comme post-condition.
 * Comparer un absolu produirait des saisies systématiques.
 *
 * `value: "1"` avec `op: "eq"` signifie donc « exactement une transaction émise
 * par ce compte sur la fenêtre » — l'action engagée, et rien d'autre.
 */

import { compare, lower, parseDecimal } from './compare.js'
import { read } from './errors.js'
import type { CheckEnv, CheckResult, NonceAdvancedCheck } from './types.js'

export async function checkNonceAdvanced(
  check: NonceAdvancedCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const expected = parseDecimal(check.value, 'nonce_advanced.value')
  const beforeBlock = env.txBlock > 0n ? env.txBlock - 1n : 0n

  const [after, before] = await Promise.all([
    read(`getTransactionCount(${lower(check.account)}) @ ${env.evalBlock}`, () =>
      env.client.getTransactionCount({ address: check.account, blockNumber: env.evalBlock }),
    ),
    read(`getTransactionCount(${lower(check.account)}) @ ${beforeBlock}`, () =>
      env.client.getTransactionCount({ address: check.account, blockNumber: beforeBlock }),
    ),
  ])

  // viem rend un `number` ; on repasse en bigint immédiatement.
  const delta = BigInt(after) - BigInt(before)

  return {
    kind: 'nonce_advanced',
    expected: `nonce(account=${lower(check.account)}) @ block ${env.evalBlock} minus @ block ${beforeBlock} ${check.op} ${expected.toString()}`,
    observed: `${delta.toString()} (before=${BigInt(before).toString()}, after=${BigInt(after).toString()})`,
    pass: compare(delta, check.op, expected),
  }
}
