/**
 * Vérificateurs ERC-20 : `erc20_allowance`, `erc20_balance`,
 * `erc20_balance_delta`.
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
        // Lecture à bloc figé — jamais `latest`.
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
 * Delta de solde ERC-20 **attribuable à la transaction d'action**.
 *
 * Le delta est la somme signée des `Transfer` du compte dans le receipt de la
 * transaction, et non `balanceOf(evaluateAt) - balanceOf(tx.blockNumber - 1)`.
 *
 * Raison, non négociable : sur un compte actif, une autre transaction incluse
 * dans le même bloc — un versement de salaire, un remboursement, une autre
 * stratégie — serait imputée à l'agent et produirait une saisie injuste. On ne
 * saisit une caution que pour ce que la transaction engagée a effectivement
 * fait.
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
  /** Nombre de logs `Transfer` du token touchant le compte. */
  matched: number
}

/**
 * Somme les `Transfer` entrants et sortants du compte, pour un token donné,
 * dans les logs fournis.
 *
 * Un auto-transfert (`from === to === account`) s'annule naturellement. Les
 * `Transfer` ERC-721 (4 topics) sont ignorés : leur `tokenId` indexé n'est pas
 * un montant.
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
