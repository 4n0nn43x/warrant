/**
 * Environment reading — same conventions as `packages/server/src/bin/*`.
 *
 * One canonical name per variable, **no aliases**: a binary that accepts two
 * spellings ends up reading the one that was not set. And a volume runner that
 * reads the wrong variable does not fail, it spends.
 */

import type { Address, Hex } from '@warrant/core'
import type { Action } from './ledger.js'

export function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `missing environment variable: ${name} — see apps/runner/src/runner.ts ` +
        'for the full list and its comment',
    )
  }
  return value.trim()
}

export function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

export function flag(name: string, fallback = false): boolean {
  const raw = optional(name, '')
  if (raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(raw)
}

export function address(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name}: expected an EVM address, got "${value}"`)
  }
  return value.toLowerCase() as Address
}

export function hex32(name: string, value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name}: expected bytes32, got "${value}"`)
  }
  return value.toLowerCase() as Hex
}

/**
 * **Strict** integer. `Number('12 warrants')` is `NaN` and `parseInt` is 12:
 * both are wrong here, the first because it propagates without throwing, the
 * second because it invents a value out of a typo.
 */
export function integer(name: string, fallback: number): number {
  const raw = optional(name, '')
  if (raw === '') return fallback
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name}: expected a decimal integer, got "${raw}"`)
  }
  return Number(raw)
}

/** Arbitrarily large integer — USDC atomic units, wei. Never `number`. */
export function bigint(name: string, fallback: bigint): bigint {
  const raw = optional(name, '')
  if (raw === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name}: expected an unsigned decimal integer, got "${raw}"`)
  }
  return BigInt(raw)
}

/**
 * The campaign's call shape. Rejects anything outside the closed set rather than
 * passing it to the child: an unknown `--action` fails there too, but only after
 * a process spawn and with the error buried in a subprocess's tail.
 */
export function action(name: string, fallback: Action): Action {
  const raw = optional(name, '')
  if (raw === '') return fallback
  if (raw !== 'transfer' && raw !== 'approve') {
    throw new Error(`${name}: expected transfer or approve, got "${raw}"`)
  }
  return raw
}

/** 6 decimals, display format. Never fed back into a computation. */
export function usdc(atomic: bigint): string {
  const negative = atomic < 0n
  const abs = negative ? -atomic : atomic
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString(10).padStart(6, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/** 18 decimals, truncated to 9 — past that, on Base, it stops being readable. */
export function eth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = (wei % 1_000_000_000_000_000_000n).toString(10).padStart(18, '0')
  return `${whole}.${frac.slice(0, 9)}`
}
