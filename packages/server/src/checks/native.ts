/**
 * `native_balance_delta` — native balance delta attributable to the transaction.
 *
 * ## The limitation, stated plainly
 *
 * There is no equivalent of `Transfer` logs for ether. Internal transfers
 * (`CALL` with `value` from a contract) are visible only through
 * `debug_traceTransaction` / `trace_transaction`, unavailable on most public
 * RPCs. Taking `getBalance(evaluateAt) - getBalance(tx.block - 1)` would
 * reintroduce exactly the bug we fix on the ERC-20 side: another transaction in
 * the same block would be charged to the agent.
 *
 * ## What was decided (the docs did not decide it)
 *
 * 1. If a tracer is injected (`ctx.traceNativeTransfers`), it is authoritative:
 *    delta = sum of the transfers, plus the gas fees if the account is the
 *    sender.
 * 2. Otherwise the delta is computable in a **provably complete** way only for a
 *    transaction that makes no call: `input === '0x'` **and** a recipient with no
 *    code at the inclusion block. There, no internal call is possible, and
 *    `value` + gas is the exact delta.
 * 3. In every other case the check is declared undecidable and throws
 *    `UnsupportedCheckError`. It never returns `false`: an unfounded `false`
 *    would slash a bond on a read we know to be incomplete. The warrant then
 *    expires towards `reclaim` and the agent is refunded.
 *
 * Gas fees are **included** when the account is the sender: that is a real and
 * observable decrease of its native balance, and setting it aside would be an
 * implicit tolerance. The protected treasury is generally not the sender, so the
 * question does not arise in ordinary use.
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
 * True if the transaction cannot contain an internal call: no calldata, and a
 * recipient with no code at the inclusion block (otherwise its `receive()` /
 * `fallback()` runs and can redistribute value).
 */
async function isTerminalValueTransfer(env: CheckEnv): Promise<boolean> {
  const input = env.transaction.input
  if (input && input !== '0x') return false
  const to = env.transaction.to
  if (!to) return false // contract creation: the constructor can move value out

  const code = await read(`getCode(${lower(to)}) @ ${env.txBlock}`, () =>
    env.client.getCode({ address: to, blockNumber: env.txBlock }),
  )
  return !code || code === '0x'
}
