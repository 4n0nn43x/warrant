/**
 * Comparaison et normalisation.
 *
 * Toute l'arithmétique est en `bigint`. Aucun `number` n'entre dans un
 * comparatif : les `uint256` dépassent `Number.MAX_SAFE_INTEGER` et un arrondi
 * silencieux transformerait un verdict en loterie.
 *
 * **Aucune tolérance implicite** (docs/07 § 5) : la comparaison est exacte. Si
 * une marge est voulue, elle est dans la `value` engagée.
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

/** Parse une chaîne décimale signée. Rejette tout le reste, y compris `1e18`. */
export function parseDecimal(raw: string, field: string): bigint {
  if (typeof raw !== 'string' || !DECIMAL_INTEGER.test(raw)) {
    throw new InvalidSpecError(
      `${field} must be a decimal integer string, got ${JSON.stringify(raw)}`,
    )
  }
  return BigInt(raw)
}

/** Parse une valeur engagée en décimal ou en hexadécimal (`address`, `bytes32`). */
export function parseDecimalOrHex(raw: string, field: string): bigint {
  if (typeof raw === 'string' && HEX_STRING.test(raw) && raw.length > 2) {
    return BigInt(raw)
  }
  if (typeof raw === 'string' && (raw === 'true' || raw === 'false')) {
    return raw === 'true' ? 1n : 0n
  }
  return parseDecimal(raw, field)
}

/** Entier non signé issu d'un champ `number` du DSL. Passe en `bigint` aussitôt. */
export function parseCount(raw: number, field: string): bigint {
  if (!Number.isInteger(raw) || raw < 0) {
    throw new InvalidSpecError(
      `${field} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    )
  }
  return BigInt(raw)
}

/**
 * Forme canonique d'une adresse : minuscule, sans checksum EIP-55 (docs/07 § 4
 * règle 2). Deux graphies d'une même adresse ne doivent jamais donner deux
 * résultats.
 */
export function lower<T extends string>(value: T): T {
  return value.toLowerCase() as T
}

export function addressEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Extrait une adresse d'un topic indexé de 32 octets. */
export function addressFromTopic(topic: Hex): Address {
  return `0x${topic.slice(-40)}`.toLowerCase() as Address
}

/** `BigInt` d'un champ `data` de log, tolérant au `0x` vide. */
export function bigintFromData(data: Hex | undefined): bigint {
  if (!data || data === '0x') return 0n
  return BigInt(data)
}

/** Rendu lisible d'une adresse dans les champs `expected` / `observed`. */
export function short(address: string): string {
  return address.toLowerCase()
}
