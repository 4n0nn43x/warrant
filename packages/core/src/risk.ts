/**
 * Tarification du risque.
 *
 * ```
 * bond = clamp(minBond, riskBps × notionalUSD, maxBond)
 * ```
 *
 * Trois règles, et elles vont toutes dans le même sens (docs/03 « Tarification
 * du risque », docs/13 § 5) :
 *
 * - `notionalUSD` est **dérivé des arguments décodés du calldata**, jamais
 *   déclaré par l'agent ;
 * - une catégorie `unknown` coûte `maxBond`, jamais `minBond` — un doute de
 *   classification coûte le maximum à l'agent. Un système où l'incertitude fait
 *   baisser le prix est un système qu'on attaque en créant de l'incertitude ;
 * - toute l'arithmétique est en `bigint` sur les unités atomiques USDC
 *   (6 décimales). Une caution est un montant exact, pas un arrondi flottant.
 */

import { buildConditionSpec, type BuildConditionOptions } from './policy.js'
import type { Classification, Policy, Quote } from './types.js'

const BPS_DENOMINATOR = 10_000n

export class RiskError extends Error {
  override readonly name = 'RiskError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * Produit le devis complet : caution, notionnel et post-condition engagée.
 *
 * @throws {RiskError} si les bornes de la politique sont incohérentes.
 * @throws {PolicyError} si la politique ne couvre pas la catégorie dérivée.
 */
export function priceRisk(
  classification: Classification,
  policy: Policy,
  opts: BuildConditionOptions = {},
): Quote {
  const minBond = parseAtomic(policy.minBond, 'policy.minBond')
  const maxBond = parseAtomic(policy.maxBond, 'policy.maxBond')
  if (minBond > maxBond) {
    throw new RiskError(
      `bornes incohérentes : minBond=${minBond} > maxBond=${maxBond}`,
    )
  }

  const notionalUSD = parseAtomic(
    classification.notionalUSD,
    'classification.notionalUSD',
  )
  const category = classification.category
  const cat = policy.categories[category]
  const riskBps = cat ? requireBps(cat.riskBps) : 0

  let bond: bigint
  let rationale: string

  if (category === 'unknown') {
    // Couple (chainId, target, selector) absent du registre : on ne sait pas ce
    // que fait cette action, donc elle est facturée au maximum.
    bond = maxBond
    rationale =
      "couple (chainId, target, selector) absent du registre : catégorie " +
      '`unknown`, caution plafonnée à maxBond. Le repli n\'est jamais permissif.'
  } else if (!cat) {
    // Catégorie connue du registre mais absente de la politique : le
    // propriétaire du capital ne s'est pas prononcé. Même traitement — un trou
    // de politique ne doit pas produire la caution la moins chère.
    bond = maxBond
    rationale =
      `catégorie ${category} dérivée du calldata mais absente de la politique : ` +
      'caution plafonnée à maxBond.'
  } else {
    const raw = (notionalUSD * BigInt(riskBps)) / BPS_DENOMINATOR
    bond = clamp(minBond, raw, maxBond)
    const clampNote =
      raw < minBond
        ? ` (plancher minBond=${format(minBond)} appliqué)`
        : raw > maxBond
          ? ` (plafond maxBond=${format(maxBond)} appliqué)`
          : ''
    rationale =
      `${category} : ${riskBps} bps × ${format(notionalUSD)} $ de notionnel ` +
      `dérivé du calldata = ${format(raw)} $${clampNote}.`
  }

  return {
    category,
    bond: bond.toString(10),
    riskBps,
    notionalUSD: notionalUSD.toString(10),
    conditionSpec: buildConditionSpec(classification, policy, opts),
    rationale,
  }
}

/** `clamp(lo, x, hi)` en `bigint`. */
export function clamp(lo: bigint, x: bigint, hi: bigint): bigint {
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

/**
 * Caution seule, sans post-condition. Utile aux tests et aux simulations de
 * tarif ; `priceRisk` reste le point d'entrée du Gateway.
 */
export function bondFor(classification: Classification, policy: Policy): bigint {
  const minBond = parseAtomic(policy.minBond, 'policy.minBond')
  const maxBond = parseAtomic(policy.maxBond, 'policy.maxBond')
  if (minBond > maxBond) {
    throw new RiskError(
      `bornes incohérentes : minBond=${minBond} > maxBond=${maxBond}`,
    )
  }
  const cat = policy.categories[classification.category]
  if (classification.category === 'unknown' || !cat) return maxBond
  const notional = parseAtomic(
    classification.notionalUSD,
    'classification.notionalUSD',
  )
  const raw = (notional * BigInt(requireBps(cat.riskBps))) / BPS_DENOMINATOR
  return clamp(minBond, raw, maxBond)
}

// ─────────────────────────────────────────────────────────────────────────────

function parseAtomic(value: string, what: string): bigint {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RiskError(`${what} : montant absent`)
  }
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    throw new RiskError(`${what} : entier attendu, reçu "${value}"`)
  }
  if (parsed < 0n) throw new RiskError(`${what} : montant négatif`)
  return parsed
}

function requireBps(riskBps: number): number {
  if (!Number.isInteger(riskBps) || riskBps < 0) {
    throw new RiskError(`riskBps invalide: ${riskBps}`)
  }
  return riskBps
}

/** Affichage en dollars pour le `rationale`. Jamais utilisé pour calculer. */
function format(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = atomic % 1_000_000n
  return `${whole}.${frac.toString(10).padStart(6, '0')}`
}
