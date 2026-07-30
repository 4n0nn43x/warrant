/**
 * `nonce_advanced` — number of transactions attributable to the account over the
 * evaluated window.
 *
 * This is a **delta**, never an absolute nonce:
 *
 *     getTransactionCount(account, evaluateAt)
 *   - getTransactionCount(account, tx.blockNumber - 1)
 *
 * The KeeperHub execution wallet is reused from one warrant to the next; its
 * absolute nonce is arbitrarily large and means nothing as a post-condition.
 * Comparing an absolute value would produce systematic slashes.
 *
 * So `value: "1"` with `op: "eq"` means "exactly one transaction emitted by this
 * account over the window" — the committed action, and nothing else.
 *
 * ⚠ **Undecidable on a sponsored transaction.** When KeeperHub pays the gas, the
 * transaction is emitted by a relayer through a forwarder: the organisation
 * wallet's nonce does not advance at all. The delta would be 0 and the check
 * would fail even though the action did take place.
 *
 * In that case we throw `UnsupportedCheckError` — an inconclusive read, hence a
 * retry and then expiry towards `reclaim` — rather than return `pass: false`,
 * which would be an unjust slash. Doubt benefits the agent.
 *
 * Product consequence: this check must not appear in the default
 * post-conditions while sponsoring is enabled. Policy reserves it for executions
 * we know originate from the wallet itself.
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

  // Was the transaction emitted by the watched account itself?
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
        ? `nonce_advanced is undecidable on a sponsored transaction: it is emitted ` +
          `by relayer ${lower(String(tx.from))} through a forwarder, and the nonce ` +
          `of ${lower(check.account)} does not advance`
        : `nonce_advanced expects a transaction emitted by ${lower(check.account)}, ` +
          `but this one comes from ${lower(String(tx.from))}`,
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

  // viem returns a `number`; we move back to bigint immediately.
  const delta = BigInt(after) - BigInt(before)

  return {
    kind: 'nonce_advanced',
    expected: `nonce(account=${lower(check.account)}) @ block ${env.evalBlock} minus @ block ${beforeBlock} ${check.op} ${expected.toString()}`,
    observed: `${delta.toString()} (before=${BigInt(before).toString()}, after=${BigInt(after).toString()})`,
    pass: compare(delta, check.op, expected),
  }
}
