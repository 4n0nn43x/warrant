/**
 * Risk pricing.
 *
 * ```
 * bond = clamp(minBond, riskBps × notionalUSD, maxBond)
 * ```
 *
 * Three rules, and they all pull in the same direction (docs/03 "Risk pricing",
 * docs/13 § 5):
 *
 * - `notionalUSD` is **derived from the calldata's decoded arguments**, never
 *   declared by the agent;
 * - an `unknown` category costs `maxBond`, never `minBond` — a classification
 *   doubt costs the agent the maximum. A system where uncertainty drives the
 *   price down is a system you attack by manufacturing uncertainty;
 * - all the arithmetic is in `bigint` over USDC atomic units (6 decimals). A bond
 *   is an exact amount, not a floating-point rounding.
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
 * Produces the complete quote: bond, notional and committed post-condition.
 *
 * @throws {RiskError} if the policy's bounds are inconsistent.
 * @throws {PolicyError} if the policy does not cover the derived category.
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
      `inconsistent bounds: minBond=${minBond} > maxBond=${maxBond}`,
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
    // The (chainId, target, selector) tuple is absent from the registry: we do
    // not know what this action does, so it is charged at the maximum.
    bond = maxBond
    rationale =
      '(chainId, target, selector) tuple absent from the registry: category ' +
      '`unknown`, bond capped at maxBond. The fallback is never permissive.'
  } else if (!cat) {
    // Category known to the registry but absent from the policy: the capital
    // owner has not ruled on it. Same treatment — a hole in the policy must not
    // produce the cheapest bond.
    bond = maxBond
    rationale =
      `category ${category} derived from the calldata but absent from the policy: ` +
      'bond capped at maxBond.'
  } else {
    const raw = (notionalUSD * BigInt(riskBps)) / BPS_DENOMINATOR
    bond = clamp(minBond, raw, maxBond)
    const clampNote =
      raw < minBond
        ? ` (minBond floor ${format(minBond)} applied)`
        : raw > maxBond
          ? ` (maxBond ceiling ${format(maxBond)} applied)`
          : ''
    rationale =
      `${category}: ${riskBps} bps × ${format(notionalUSD)} USD of notional ` +
      `derived from the calldata = ${format(raw)} USD${clampNote}.`
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
 * The bond alone, with no post-condition. Useful for tests and pricing
 * simulations; `priceRisk` remains the Gateway's entry point.
 */
export function bondFor(classification: Classification, policy: Policy): bigint {
  const minBond = parseAtomic(policy.minBond, 'policy.minBond')
  const maxBond = parseAtomic(policy.maxBond, 'policy.maxBond')
  if (minBond > maxBond) {
    throw new RiskError(
      `inconsistent bounds: minBond=${minBond} > maxBond=${maxBond}`,
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
    throw new RiskError(`${what}: amount missing`)
  }
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    throw new RiskError(`${what}: integer expected, got "${value}"`)
  }
  if (parsed < 0n) throw new RiskError(`${what}: negative amount`)
  return parsed
}

function requireBps(riskBps: number): number {
  if (!Number.isInteger(riskBps) || riskBps < 0) {
    throw new RiskError(`invalid riskBps: ${riskBps}`)
  }
  return riskBps
}

/** Dollar rendering for the `rationale`. Never used to compute anything. */
function format(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = atomic % 1_000_000n
  return `${whole}.${frac.toString(10).padStart(6, '0')}`
}
