/**
 * Commitments: `conditionHash` and `actionHash` (docs/07 § 4).
 *
 *   hash = keccak256(utf8(canonicalize(normalize(spec))))
 *
 * Normalization runs **before** canonicalization and applies the four
 * non-negotiable rules of docs/07 § 4:
 *
 *   1. JCS (RFC 8785) — delegated to `canonical.ts`.
 *   2. Lowercase addresses, no EIP-55 checksum: one and the same address must
 *      never produce two hashes.
 *   3. Numbers as decimal strings, never as JavaScript `number` — `uint256`
 *      values exceed `Number.MAX_SAFE_INTEGER`. A `number` or a `bigint`
 *      supplied for an amount field is converted losslessly, and a fractional
 *      or unsafe `number` is refused rather than rounded.
 *   4. No optional field left out: default values are injected.
 *
 * Normalization rebuilds fresh objects from a whitelist of fields: nothing
 * unexpected can slip into the hashed object.
 *
 * What is deliberately **not** done: the order of `checks` and of
 * `no_new_approvals.tokens` is preserved as is. JCS never reorders arrays;
 * introducing a homegrown sort would be one more rule to reimplement
 * identically in Python and in Go.
 */

import { keccak256, stringToBytes } from 'viem'

import { canonicalize } from './canonical.js'
import {
  COMMITMENT_KIND,
  DECODE_AS,
  INT256_MAX,
  INT256_MIN,
  OPS,
  UINT256_MAX,
  isAddress,
  isHexBytes,
  isHexData,
} from './dsl.js'
import { DEFAULT_CONFIRMATIONS } from './types.js'
import type {
  ActionSpec,
  Address,
  Check,
  CheckKind,
  ConditionSpec,
  EvaluateAt,
  Hex,
  Op,
} from './types.js'

/** Normalization error. Carries the path of the offending field. */
export class NormalizationError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(`${message} (at ${path})`)
    this.name = 'NormalizationError'
    this.path = path
  }
}

function fail(path: string, message: string): never {
  throw new NormalizationError(message, path)
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function asRecord(value: unknown, path: string, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, `expected ${what}, got ${show(value)}`)
  }
  return value as Record<string, unknown>
}

/** Rule 2: lowercase, no EIP-55 checksum. */
function normAddress(value: unknown, path: string): Address {
  if (!isAddress(value)) {
    fail(path, `expected a 20-byte hex address, got ${show(value)}`)
  }
  return value.toLowerCase() as Address
}

function normHexBytes(value: unknown, bytes: number, path: string): Hex {
  if (!isHexBytes(value, bytes)) {
    fail(path, `expected a ${bytes}-byte hex string, got ${show(value)}`)
  }
  return value.toLowerCase() as Hex
}

function normHexData(value: unknown, path: string): Hex {
  if (!isHexData(value)) {
    fail(
      path,
      `expected 0x-prefixed data with an even number of hex digits, got ${show(value)}`,
    )
  }
  return value.toLowerCase() as Hex
}

/**
 * Rule 3: amounts as canonical decimal strings.
 *
 * Accepts `string`, `bigint` and safe integer `number`, refuses everything
 * else. Equivalent spellings (`"007"`, `"+7"`, `"-0"`) are collapsed to their
 * canonical form so that they do not produce two different hashes.
 */
function normDecimal(
  value: unknown,
  path: string,
  bounds: { min: bigint; max: bigint },
): string {
  let n: bigint
  if (typeof value === 'bigint') {
    n = value
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail(
        path,
        `expected an exact integer amount; ${show(value)} is not a safe JavaScript integer — pass it as a decimal string`,
      )
    }
    n = BigInt(value)
  } else if (typeof value === 'string') {
    if (!/^[+-]?[0-9]+$/.test(value)) {
      fail(
        path,
        `expected a decimal integer string (no exponent, no separator, no whitespace), got ${show(value)}`,
      )
    }
    n = BigInt(value)
  } else {
    fail(path, `expected a decimal amount, got ${show(value)}`)
  }

  if (n < bounds.min || n > bounds.max) {
    fail(path, `value ${n} out of range [${bounds.min}, ${bounds.max}]`)
  }
  return n.toString(10)
}

const UNSIGNED = { min: 0n, max: UINT256_MAX }
const SIGNED = { min: INT256_MIN, max: INT256_MAX }

function normOp(value: unknown, path: string): Op {
  if (typeof value !== 'string' || !(OPS as readonly string[]).includes(value)) {
    fail(path, `expected one of ${OPS.join(' | ')}, got ${show(value)}`)
  }
  return value as Op
}

function normInteger(
  value: unknown,
  path: string,
  opts: { min: number; fallback?: number },
): number {
  const v = value === undefined ? opts.fallback : value
  if (v === undefined) fail(path, 'missing required field')
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < opts.min) {
    fail(path, `expected an integer >= ${opts.min}, got ${show(value)}`)
  }
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

function normalizeCheck(raw: unknown, path: string): Check {
  const c = asRecord(raw, path, 'a check object')
  const kind = c['kind']
  if (typeof kind !== 'string') {
    fail(`${path}.kind`, `expected a string, got ${show(kind)}`)
  }

  switch (kind as CheckKind) {
    case 'erc20_allowance':
      return {
        kind: 'erc20_allowance',
        token: normAddress(c['token'], `${path}.token`),
        owner: normAddress(c['owner'], `${path}.owner`),
        spender: normAddress(c['spender'], `${path}.spender`),
        op: normOp(c['op'], `${path}.op`),
        value: normDecimal(c['value'], `${path}.value`, UNSIGNED),
      }

    case 'erc20_balance':
      return {
        kind: 'erc20_balance',
        token: normAddress(c['token'], `${path}.token`),
        account: normAddress(c['account'], `${path}.account`),
        op: normOp(c['op'], `${path}.op`),
        value: normDecimal(c['value'], `${path}.value`, UNSIGNED),
      }

    case 'erc20_balance_delta':
      return {
        kind: 'erc20_balance_delta',
        token: normAddress(c['token'], `${path}.token`),
        account: normAddress(c['account'], `${path}.account`),
        op: normOp(c['op'], `${path}.op`),
        value: normDecimal(c['value'], `${path}.value`, SIGNED),
      }

    case 'native_balance_delta':
      return {
        kind: 'native_balance_delta',
        account: normAddress(c['account'], `${path}.account`),
        op: normOp(c['op'], `${path}.op`),
        value: normDecimal(c['value'], `${path}.value`, SIGNED),
      }

    case 'aave_health_factor':
      return {
        kind: 'aave_health_factor',
        pool: normAddress(c['pool'], `${path}.pool`),
        user: normAddress(c['user'], `${path}.user`),
        op: normOp(c['op'], `${path}.op`),
        value: normDecimal(c['value'], `${path}.value`, UNSIGNED),
      }

    case 'staticcall_result': {
      const decodeAs = c['decodeAs']
      if (
        typeof decodeAs !== 'string' ||
        !(DECODE_AS as readonly string[]).includes(decodeAs)
      ) {
        fail(
          `${path}.decodeAs`,
          `expected one of ${DECODE_AS.join(' | ')}, got ${show(decodeAs)}`,
        )
      }
      const as = decodeAs as (typeof DECODE_AS)[number]
      let value: string
      switch (as) {
        case 'uint256':
          value = normDecimal(c['value'], `${path}.value`, UNSIGNED)
          break
        case 'int256':
          value = normDecimal(c['value'], `${path}.value`, SIGNED)
          break
        case 'bool':
          if (c['value'] === true || c['value'] === 'true') value = 'true'
          else if (c['value'] === false || c['value'] === 'false') value = 'false'
          else
            fail(
              `${path}.value`,
              `expected "true" or "false" for decodeAs=bool, got ${show(c['value'])}`,
            )
          break
        case 'address':
          value = normAddress(c['value'], `${path}.value`)
          break
        case 'bytes32':
          value = normHexBytes(c['value'], 32, `${path}.value`)
          break
      }
      return {
        kind: 'staticcall_result',
        target: normAddress(c['target'], `${path}.target`),
        data: normHexData(c['data'], `${path}.data`),
        decodeAs: as,
        op: normOp(c['op'], `${path}.op`),
        value,
      }
    }

    case 'event_emitted':
      return {
        kind: 'event_emitted',
        address: normAddress(c['address'], `${path}.address`),
        topic0: normHexBytes(c['topic0'], 32, `${path}.topic0`),
        // Rule 4: `minCount` is the only truly optional field of any check.
        minCount: normInteger(c['minCount'], `${path}.minCount`, {
          min: 1,
          fallback: 1,
        }),
      }

    case 'nonce_advanced':
      return {
        kind: 'nonce_advanced',
        account: normAddress(c['account'], `${path}.account`),
        op: normOp(c['op'], `${path}.op`),
        value: normDecimal(c['value'], `${path}.value`, UNSIGNED),
      }

    case 'no_new_approvals': {
      const tokens = c['tokens']
      if (!Array.isArray(tokens)) {
        fail(`${path}.tokens`, `expected an array of addresses, got ${show(tokens)}`)
      }
      return {
        kind: 'no_new_approvals',
        owner: normAddress(c['owner'], `${path}.owner`),
        tokens: tokens.map((t, i) => normAddress(t, `${path}.tokens[${i}]`)),
      }
    }

    case COMMITMENT_KIND:
      return {
        kind: 'calldata_matches_commitment',
        actionHash: normHexBytes(c['actionHash'], 32, `${path}.actionHash`),
      }

    default:
      fail(
        `${path}.kind`,
        `unknown check kind ${show(kind)} — the catalogue is closed`,
      )
  }
}

function normalizeEvaluateAt(value: unknown, path: string): EvaluateAt {
  if (value === undefined || value === 'tx') return 'tx'
  if (value === 'tx+1') return 'tx+1'
  const r = asRecord(value, path, '"tx", "tx+1" or { "block": n }')
  const block = normInteger(r['block'], `${path}.block`, { min: 0 })
  return { block }
}

/**
 * Default confirmations: L1 (chainId 1) waits 12 blocks, everything else 3
 * (docs/07 § 1). The default is pinned here so that two implementations that
 * omit the field produce the same hash.
 */
export function defaultConfirmations(chainId: number): number {
  return chainId === 1 ? DEFAULT_CONFIRMATIONS.l1 : DEFAULT_CONFIRMATIONS.l2
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a `ConditionSpec` before hashing: lowercase addresses, amounts as
 * canonical decimal strings, defaults injected, unknown fields dropped.
 *
 * @throws {NormalizationError}
 */
export function normalizeConditionSpec(spec: unknown): ConditionSpec {
  const s = asRecord(spec, '$', 'a ConditionSpec object')

  const version = s['version'] === undefined ? 1 : s['version']
  if (version !== 1) {
    fail('$.version', `expected version 1, got ${show(s['version'])}`)
  }

  const chainId = normInteger(s['chainId'], '$.chainId', { min: 1 })

  const checksRaw = s['checks']
  if (!Array.isArray(checksRaw)) {
    fail('$.checks', `expected an array of checks, got ${show(checksRaw)}`)
  }

  return {
    version: 1,
    chainId,
    evaluateAt: normalizeEvaluateAt(s['evaluateAt'], '$.evaluateAt'),
    confirmations: normInteger(s['confirmations'], '$.confirmations', {
      min: 0,
      fallback: defaultConfirmations(chainId),
    }),
    checks: checksRaw.map((c, i) => normalizeCheck(c, `$.checks[${i}]`)),
  }
}

/**
 * Normalizes an `ActionSpec` before hashing.
 *
 * @throws {NormalizationError}
 */
export function normalizeActionSpec(spec: unknown): ActionSpec {
  const s = asRecord(spec, '$', 'an ActionSpec object')

  const version = s['version'] === undefined ? 1 : s['version']
  if (version !== 1) {
    fail('$.version', `expected version 1, got ${show(s['version'])}`)
  }

  return {
    version: 1,
    chainId: normInteger(s['chainId'], '$.chainId', { min: 1 }),
    target: normAddress(s['target'], '$.target'),
    // Rule 4: an action with no native value is "0", never absent.
    value: normDecimal(s['value'] === undefined ? '0' : s['value'], '$.value', UNSIGNED),
    calldata: normHexData(s['calldata'] === undefined ? '0x' : s['calldata'], '$.calldata'),
    registryRef: normHexBytes(s['registryRef'], 32, '$.registryRef'),
  }
}

/**
 * Generic normalization: tells a `ConditionSpec` (it carries `checks`) from an
 * `ActionSpec` (it carries `calldata`).
 *
 * @throws {NormalizationError} if the shape is neither one nor the other.
 */
export function normalize(spec: unknown): ConditionSpec | ActionSpec {
  const s = asRecord(spec, '$', 'a ConditionSpec or an ActionSpec')
  const hasChecks = 'checks' in s
  const hasCalldata = 'calldata' in s || 'target' in s
  if (hasChecks && !hasCalldata) return normalizeConditionSpec(s)
  if (hasCalldata && !hasChecks) return normalizeActionSpec(s)
  fail(
    '$',
    'ambiguous spec: expected a ConditionSpec (with "checks") or an ActionSpec (with "target"/"calldata")',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `keccak256(utf8(canonical))`. The low-level entry point.
 *
 * We call `stringToBytes` rather than the `toBytes` of docs/07 § 4: `toBytes`
 * switches to hex mode when the string starts with `0x`, which would hash
 * different bytes. The two are equivalent on JCS output, which always starts
 * with `{`, `[` or `"` — but ambiguity has no place in the function that
 * produces the onchain commitment.
 */
export function hashCanonical(canonical: string): Hex {
  return keccak256(stringToBytes(canonical))
}

/** JCS canonical form of a `ConditionSpec`, after normalization. */
export function canonicalConditionSpec(spec: unknown): string {
  return canonicalize(normalizeConditionSpec(spec))
}

/** JCS canonical form of an `ActionSpec`, after normalization. */
export function canonicalActionSpec(spec: unknown): string {
  return canonicalize(normalizeActionSpec(spec))
}

/**
 * `conditionHash` committed onchain (docs/07 § 4).
 *
 * ```ts
 * keccak256(toBytes(canonicalize(normalize(spec))))
 * ```
 */
export function conditionHash(spec: unknown): Hex {
  return hashCanonical(canonicalConditionSpec(spec))
}

/** `actionHash` committed onchain — same treatment as `conditionHash`. */
export function actionHash(spec: unknown): Hex {
  return hashCanonical(canonicalActionSpec(spec))
}
