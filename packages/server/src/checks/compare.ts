/**
 * Comparison and normalisation.
 *
 * All arithmetic is in `bigint`. No `number` ever enters a comparison: `uint256`
 * values overflow `Number.MAX_SAFE_INTEGER`, and a silent rounding would turn a
 * verdict into a lottery.
 *
 * **No implicit tolerance** (docs/07 § 5): the comparison is exact. If a margin
 * is wanted, it belongs in the committed `value`.
 */

import { InvalidSpecError } from './errors.js'
import type { Address, Hex, Op } from './types.js'

const DECIMAL_INTEGER = /^-?(0|[1-9][0-9]*)$/
const HEX_STRING = /^0x[0-9a-fA-F]*$/

/** `observed <op> expected`. */
export function compare(observed: bigint, op: Op, expected: bigint): boolean {
  switch (op) {
    case 'eq':
      return observed === expected
    case 'lte':
      return observed <= expected
    case 'gte':
      return observed >= expected
    default:
      throw new InvalidSpecError(`unknown op: ${JSON.stringify(op)}`)
  }
}

/** Parses a signed decimal string. Rejects everything else, `1e18` included. */
export function parseDecimal(raw: string, field: string): bigint {
  if (typeof raw !== 'string' || !DECIMAL_INTEGER.test(raw)) {
    throw new InvalidSpecError(
      `${field} must be a decimal integer string, got ${JSON.stringify(raw)}`,
    )
  }
  return BigInt(raw)
}

/** Parses a committed value in decimal or hexadecimal (`address`, `bytes32`). */
export function parseDecimalOrHex(raw: string, field: string): bigint {
  if (typeof raw === 'string' && HEX_STRING.test(raw) && raw.length > 2) {
    return BigInt(raw)
  }
  if (typeof raw === 'string' && (raw === 'true' || raw === 'false')) {
    return raw === 'true' ? 1n : 0n
  }
  return parseDecimal(raw, field)
}

/** Unsigned integer from a `number` field of the DSL. Moves to `bigint` at once. */
export function parseCount(raw: number, field: string): bigint {
  if (!Number.isInteger(raw) || raw < 0) {
    throw new InvalidSpecError(
      `${field} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    )
  }
  return BigInt(raw)
}

/**
 * Canonical form of an address: lowercase, no EIP-55 checksum (docs/07 § 4,
 * rule 2). Two spellings of the same address must never yield two results.
 */
export function lower<T extends string>(value: T): T {
  return value.toLowerCase() as T
}

export function addressEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Extracts an address from a 32-byte indexed topic. */
export function addressFromTopic(topic: Hex): Address {
  return `0x${topic.slice(-40)}`.toLowerCase() as Address
}

/** `BigInt` of a log `data` field, tolerant of an empty `0x`. */
export function bigintFromData(data: Hex | undefined): bigint {
  if (!data || data === '0x') return 0n
  return BigInt(data)
}

/** Readable rendering of an address in the `expected` / `observed` fields. */
export function short(address: string): string {
  return address.toLowerCase()
}
