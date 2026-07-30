/**
 * ERC-20 checks: `erc20_allowance`, `erc20_balance`, `erc20_balance_delta`.
 */

import {
  ERC20_EVENT_TOPIC_COUNT,
  TOPIC_TRANSFER,
  erc20Abi,
} from './abi.js'
import {
  addressEquals,
  addressFromTopic,
  bigintFromData,
  compare,
  lower,
  parseDecimal,
} from './compare.js'
import { read } from './errors.js'
import type {
  CheckEnv,
  CheckResult,
  Erc20AllowanceCheck,
  Erc20BalanceCheck,
  Erc20BalanceDeltaCheck,
  Hex,
} from './types.js'

export async function checkErc20Allowance(
  check: Erc20AllowanceCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const expected = parseDecimal(check.value, 'erc20_allowance.value')

  const observed = await read(
    `allowance(${lower(check.token)}, ${lower(check.owner)}, ${lower(check.spender)}) @ ${env.evalBlock}`,
    () =>
      env.client.readContract({
        address: check.token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [check.owner, check.spender],
        // Read at a pinned block — never `latest`.
        blockNumber: env.evalBlock,
      }),
  )

  return {
    kind: 'erc20_allowance',
    expected: `allowance(token=${lower(check.token)}, owner=${lower(check.owner)}, spender=${lower(check.spender)}) @ block ${env.evalBlock} ${check.op} ${expected.toString()}`,
    observed: observed.toString(),
    pass: compare(observed, check.op, expected),
  }
}

export async function checkErc20Balance(
  check: Erc20BalanceCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const expected = parseDecimal(check.value, 'erc20_balance.value')

  const observed = await read(
    `balanceOf(${lower(check.token)}, ${lower(check.account)}) @ ${env.evalBlock}`,
    () =>
      env.client.readContract({
        address: check.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [check.account],
        blockNumber: env.evalBlock,
      }),
  )

  return {
    kind: 'erc20_balance',
    expected: `balanceOf(token=${lower(check.token)}, account=${lower(check.account)}) @ block ${env.evalBlock} ${check.op} ${expected.toString()}`,
    observed: observed.toString(),
    pass: compare(observed, check.op, expected),
  }
}

/**
 * ERC-20 balance delta **attributable to the action transaction**.
 *
 * The delta is the signed sum of the account's `Transfer` logs in the
 * transaction receipt, not `balanceOf(evaluateAt) - balanceOf(tx.blockNumber -
 * 1)`.
 *
 * The reason, and it is not negotiable: on an active account, another
 * transaction included in the same block — a payroll run, a refund, another
 * strategy — would be charged to the agent and produce an unjust slash. A bond
 * is slashed only for what the committed transaction actually did.
 */
export async function checkErc20BalanceDelta(
  check: Erc20BalanceDeltaCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  const expected = parseDecimal(check.value, 'erc20_balance_delta.value')
  const { delta, inflow, outflow, matched } = sumTransferDelta(
    env.receipt.logs,
    check.token,
    check.account,
  )

  return {
    kind: 'erc20_balance_delta',
    expected: `sum(Transfer) for account=${lower(check.account)} on token=${lower(check.token)} in tx ${env.txHash} ${check.op} ${expected.toString()}`,
    observed: `${delta.toString()} (in=${inflow.toString()}, out=${outflow.toString()}, transfers=${matched})`,
    pass: compare(delta, check.op, expected),
  }
}

export interface TransferDelta {
  delta: bigint
  inflow: bigint
  outflow: bigint
  /** Number of `Transfer` logs of the token that touch the account. */
  matched: number
}

/**
 * Sums the account's inbound and outbound `Transfer` logs, for a given token,
 * within the supplied logs.
 *
 * A self-transfer (`from === to === account`) cancels out naturally. ERC-721
 * `Transfer` logs (4 topics) are ignored: their indexed `tokenId` is not an
 * amount.
 */
export function sumTransferDelta(
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[],
  token: string,
  account: string,
): TransferDelta {
  let inflow = 0n
  let outflow = 0n
  let matched = 0

  for (const log of logs) {
    if (!addressEquals(log.address, token)) continue
    if (log.topics.length !== ERC20_EVENT_TOPIC_COUNT) continue
    const [topic0, fromTopic, toTopic] = log.topics
    if (!topic0 || !fromTopic || !toTopic) continue
    if (topic0.toLowerCase() !== TOPIC_TRANSFER.toLowerCase()) continue

    const from = addressFromTopic(fromTopic)
    const to = addressFromTopic(toTopic)
    const amount = bigintFromData(log.data)

    let touched = false
    if (addressEquals(to, account)) {
      inflow += amount
      touched = true
    }
    if (addressEquals(from, account)) {
      outflow += amount
      touched = true
    }
    if (touched) matched += 1
  }

  return { delta: inflow - outflow, inflow, outflow, matched }
}
