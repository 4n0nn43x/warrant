/**
 * `staticcall_result` — échappatoire générique pour toute lecture `view`.
 *
 * Cible et calldata sont figées dans l'engagement ; le décodage est limité à
 * `uint256 | int256 | bool | address | bytes32`.
 *
 * Décision non tranchée par la doc : **un revert ou un décodage impossible est
 * une lecture non concluante, pas un échec de post-condition.** On lève
 * `RpcReadError` plutôt que de rendre `pass: false`. Un `view` qui revert peut
 * signaler un état transitoire du noeud aussi bien qu'un état du contrat ; on
 * ne saisit pas une caution sur cette ambiguïté.
 */

import { decodeAbiParameters } from 'viem'
import { compare, lower, parseDecimalOrHex } from './compare.js'
import { InvalidSpecError, read } from './errors.js'
import type { CheckEnv, CheckResult, Hex, StaticcallResultCheck } from './types.js'

const DECODABLE = ['uint256', 'int256', 'bool', 'address', 'bytes32'] as const
type Decodable = (typeof DECODABLE)[number]

export async function checkStaticcallResult(
  check: StaticcallResultCheck,
  env: CheckEnv,
): Promise<CheckResult> {
  if (!DECODABLE.includes(check.decodeAs as Decodable)) {
    throw new InvalidSpecError(
      `staticcall_result.decodeAs must be one of ${DECODABLE.join(' | ')}, got ${JSON.stringify(check.decodeAs)}`,
    )
  }

  const expected = parseDecimalOrHex(check.value, 'staticcall_result.value')

  const returned = await read(
    `eth_call(${lower(check.target)}, ${check.data}) @ ${env.evalBlock}`,
    async () => {
      const result = await env.client.call({
        to: check.target,
        data: check.data,
        blockNumber: env.evalBlock,
      })
      if (!result.data || result.data === '0x') {
        throw new Error('empty return data')
      }
      return result.data
    },
  )

  const { value, display } = decode(check.decodeAs as Decodable, returned)

  return {
    kind: 'staticcall_result',
    expected: `staticcall(target=${lower(check.target)}, data=${check.data}) -> ${check.decodeAs} @ block ${env.evalBlock} ${check.op} ${check.value}`,
    observed: display,
    pass: compare(value, check.op, expected),
  }
}

/**
 * Décodage vers un `bigint` comparable, plus une forme lisible pour l'audit.
 * `address` et `bytes32` sont comparés comme entiers : `eq` est exact, et un
 * ordre reste défini pour `lte` / `gte` sans jamais devoir lever.
 */
function decode(decodeAs: Decodable, data: Hex): { value: bigint; display: string } {
  const [decoded] = decodeAbiParameters([{ type: decodeAs }], data)

  switch (decodeAs) {
    case 'uint256':
    case 'int256': {
      const value = decoded as bigint
      return { value, display: value.toString() }
    }
    case 'bool': {
      const value = decoded as boolean
      return { value: value ? 1n : 0n, display: value ? 'true' : 'false' }
    }
    case 'address':
    case 'bytes32': {
      const value = (decoded as string).toLowerCase()
      return { value: BigInt(value), display: value }
    }
  }
}
