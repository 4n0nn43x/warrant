/**
 * Lecture d'environnement — mêmes conventions que `packages/server/src/bin/*`.
 *
 * Un nom canonique par variable, **aucun alias** : un binaire qui accepte deux
 * orthographes finit par lire celle qui n'est pas renseignée. Et un runner de
 * volume qui lit la mauvaise variable n'échoue pas, il dépense.
 */

import type { Address, Hex } from '@warrant/core'

export function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `variable d'environnement manquante: ${name} — voir apps/runner/src/runner.ts ` +
        'pour la liste complète et son commentaire',
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
    throw new Error(`${name} : adresse EVM attendue, reçu "${value}"`)
  }
  return value.toLowerCase() as Address
}

export function hex32(name: string, value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} : bytes32 attendu, reçu "${value}"`)
  }
  return value.toLowerCase() as Hex
}

/**
 * Entier **strict**. `Number('12 mandats')` vaut `NaN` et `parseInt` vaut 12 :
 * les deux sont mauvais ici, le premier parce qu'il se propage sans lever, le
 * second parce qu'il invente une valeur à partir d'une faute de frappe.
 */
export function integer(name: string, fallback: number): number {
  const raw = optional(name, '')
  if (raw === '') return fallback
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} : entier décimal attendu, reçu "${raw}"`)
  }
  return Number(raw)
}

/** Entier arbitrairement grand — unités atomiques d'USDC, wei. Jamais `number`. */
export function bigint(name: string, fallback: bigint): bigint {
  const raw = optional(name, '')
  if (raw === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} : entier décimal non signé attendu, reçu "${raw}"`)
  }
  return BigInt(raw)
}

/** 6 décimales, format d'affichage. Jamais réinjecté dans un calcul. */
export function usdc(atomic: bigint): string {
  const negative = atomic < 0n
  const abs = negative ? -atomic : atomic
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString(10).padStart(6, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/** 18 décimales, tronquées à 9 — au-delà, sur Base, ce n'est plus lisible. */
export function eth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = (wei % 1_000_000_000_000_000_000n).toString(10).padStart(18, '0')
  return `${whole}.${frac.slice(0, 9)}`
}
