/**
 * `native_balance_delta` — delta de solde natif attribuable à la transaction.
 *
 * ## La limite, énoncée franchement
 *
 * Il n'existe pas d'équivalent des logs `Transfer` pour l'ether. Les transferts
 * internes (`CALL` avec `value` depuis un contrat) ne sont visibles que par
 * `debug_traceTransaction` / `trace_transaction`, indisponibles sur la plupart
 * des RPC publics. Prendre `getBalance(evaluateAt) - getBalance(tx.block - 1)`
 * réintroduirait exactement le bug qu'on corrige sur l'ERC-20 : une autre
 * transaction du même bloc serait imputée à l'agent.
 *
 * ## Ce qui a été tranché (la doc ne le tranchait pas)
 *
 * 1. Si un tracer est injecté (`ctx.traceNativeTransfers`), il fait foi : delta
 *    = somme des transferts, plus les frais de gas si le compte est l'émetteur.
 * 2. Sinon, le delta n'est calculable de façon **prouvablement complète** que
 *    pour une transaction sans appel : `input === '0x'` **et** destinataire
 *    sans code au bloc d'inclusion. Là, aucun appel interne n'est possible, et
 *    `value` + gas est le delta exact.
 * 3. Dans tous les autres cas, le vérificateur est déclaré non décidable et
 *    lève `UnsupportedCheckError`. Il ne rend jamais `false` : un `false` non
 *    fondé saisirait une caution sur une lecture qu'on sait incomplète. Le
 *    mandat expire alors vers `reclaim` et l'agent est remboursé.
 *
 * Les frais de gas sont **inclus** quand le compte est l'émetteur : c'est une
 * baisse réelle et observable de son solde natif, et l'écarter serait une
 * tolérance implicite. Le trésor protégé n'est en général pas l'émetteur, donc
 * la question ne se pose pas pour l'usage courant.
 */

import { addressEquals, compare, lower, parseDecimal } from './compare.js'
import { UnsupportedCheckError, read } from './errors.js'
import type { CheckEnv, CheckResult, NativeBalanceDeltaCheck, NativeTransfer } from './types.js'

export async function checkNativeBalanceDelta(
  check: NativeBalanceDeltaCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const expected = parseDecimal(check.value, 'native_balance_delta.value')
  const account = lower(check.account)

  const gasCost = gasCostOf(env)
  const isSender = addressEquals(env.transaction.from, account)

  let delta: bigint
  let source: string

  if (env.traceNativeTransfers) {
    const transfers = await read(`traceNativeTransfers(${env.txHash})`, () =>
      env.traceNativeTransfers!(env.txHash),
    )
    delta = sumNativeTransfers(transfers, account)
    if (isSender) delta -= gasCost
    source = `trace(${transfers.length} transfers)`
  } else {
    const terminal = await isTerminalValueTransfer(env)
    if (!terminal) {
      throw new UnsupportedCheckError(
        `native_balance_delta on tx ${env.txHash}: internal value transfers are not observable ` +
          `without a trace provider; refusing to guess (no verdict rather than a wrong verdict)`,
      )
    }
    delta = 0n
    const to = env.transaction.to ? lower(env.transaction.to) : null
    if (isSender) delta -= env.transaction.value + gasCost
    if (to && addressEquals(to, account)) delta += env.transaction.value
    source = 'top-level value transfer (callee has no code)'
  }

  return {
    kind: 'native_balance_delta',
    expected: `native delta for account=${account} attributable to tx ${env.txHash} ${check.op} ${expected.toString()}`,
    observed: `${delta.toString()} (${source}${isSender ? `, gas=-${gasCost.toString()}` : ''})`,
    pass: compare(delta, check.op, expected),
  }
}

export function sumNativeTransfers(
  transfers: readonly NativeTransfer[],
  account: string,
): bigint {
  let delta = 0n
  for (const transfer of transfers) {
    if (addressEquals(transfer.to, account)) delta += transfer.value
    if (addressEquals(transfer.from, account)) delta -= transfer.value
  }
  return delta
}

function gasCostOf(env: CheckEnv): bigint {
  const price =
    env.receipt.effectiveGasPrice ?? env.transaction.gasPrice ?? 0n
  return env.receipt.gasUsed * price
}

/**
 * Vrai si la transaction ne peut pas contenir d'appel interne : pas de
 * calldata, et un destinataire dépourvu de code au bloc d'inclusion (sinon son
 * `receive()` / `fallback()` s'exécute et peut redistribuer de la valeur).
 */
async function isTerminalValueTransfer(env: CheckEnv): Promise<boolean> {
  const input = env.transaction.input
  if (input && input !== '0x') return false
  const to = env.transaction.to
  if (!to) return false // création de contrat : le constructeur peut sortir de la valeur

  const code = await read(`getCode(${lower(to)}) @ ${env.txBlock}`, () =>
    env.client.getCode({ address: to, blockNumber: env.txBlock }),
  )
  return !code || code === '0x'
}
