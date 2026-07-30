/**
 * `staticcall_result` — the generic escape hatch for any `view` read.
 *
 * Target and calldata are frozen in the commitment; decoding is restricted to
 * `uint256 | int256 | bool | address | bytes32`.
 *
 * Decision the docs left open: **a revert, or a decoding that cannot be done, is
 * an inconclusive read, not a failed post-condition.** We throw `RpcReadError`
 * rather than return `pass: false`. A reverting `view` can signal a transient
 * state of the node just as well as a state of the contract; we do not slash a
 * bond on that ambiguity.
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
 * Decodes to a comparable `bigint`, plus a readable form for the audit trail.
 * `address` and `bytes32` are compared as integers: `eq` stays exact, and an
 * ordering remains defined for `lte` / `gte` without ever having to throw.
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
