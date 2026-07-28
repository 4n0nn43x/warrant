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
 *
 * ⚠ **Indécidable sur une transaction sponsorisée.** Quand KeeperHub paie le
 * gas, la transaction est émise par un relayer via un forwarder : le nonce du
 * wallet de l'organisation n'avance pas du tout. Le delta vaudrait 0 et le
 * check échouerait alors que l'action a bien eu lieu.
 *
 * Dans ce cas on lève `UnsupportedCheckError` — une lecture non concluante,
 * donc un retry puis une expiration vers `reclaim` — plutôt que de rendre
 * `pass: false`, qui serait une saisie injuste. Le doute bénéficie à l'agent.
 *
 * Conséquence produit : ce vérificateur ne doit pas figurer dans les
 * post-conditions par défaut tant que le sponsoring est actif. La politique le
 * réserve aux exécutions dont on sait qu'elles partent du wallet lui-même.
 */

import { compare, lower, parseDecimal } from './compare.js'
import { UnsupportedCheckError, read } from './errors.js'
import { unwrapForwarder } from './forwarder.js'
import type { CheckEnv, CheckResult, Hex, NonceAdvancedCheck } from './types.js'

export async function checkNonceAdvanced(
  check: NonceAdvancedCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const tx = env.transaction

  // La transaction a-t-elle été émise par le compte surveillé lui-même ?
  const emittedByAccount =
    typeof tx.from === 'string' && lower(tx.from) === lower(check.account)

  if (!emittedByAccount) {
    const wrapped = unwrapForwarder({
      to: tx.to ?? null,
      value: tx.value,
      input: (tx.input ?? '0x') as Hex,
    })
    throw new UnsupportedCheckError(
      wrapped.viaForwarder
        ? `nonce_advanced est indécidable sur une transaction sponsorisée : ` +
          `elle est émise par le relayer ${lower(String(tx.from))} via un forwarder, ` +
          `et le nonce de ${lower(check.account)} n'avance pas`
        : `nonce_advanced attend une transaction émise par ${lower(check.account)}, ` +
          `mais celle-ci vient de ${lower(String(tx.from))}`,
    )
  }

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
