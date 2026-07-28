/**
 * Engagements : `conditionHash` et `actionHash` (docs/07 § 4).
 *
 *   hash = keccak256(utf8(canonicalize(normalize(spec))))
 *
 * La normalisation est appliquee **avant** la canonicalisation et applique les
 * quatre regles non negociables de docs/07 § 4 :
 *
 *   1. JCS (RFC 8785) — delegue a `canonical.ts`.
 *   2. Adresses en minuscules, sans checksum EIP-55 : une meme adresse ne doit
 *      jamais produire deux hashs.
 *   3. Nombres en chaines decimales, jamais en `number` JavaScript — les
 *      `uint256` depassent `Number.MAX_SAFE_INTEGER`. Un `number` ou un
 *      `bigint` fourni pour un champ montant est converti sans perte, et un
 *      `number` non entier ou non sur est refuse plutot qu'arrondi.
 *   4. Aucun champ optionnel absent : les valeurs par defaut sont injectees.
 *
 * La normalisation reconstruit des objets neufs a partir d'une liste blanche de
 * champs : rien d'inattendu ne peut se glisser dans l'objet hache.
 *
 * Ce qui n'est **pas** fait, volontairement : l'ordre des `checks` et celui de
 * `no_new_approvals.tokens` sont preserves tels quels. JCS ne reordonne jamais
 * les tableaux ; introduire un tri maison serait une regle supplementaire a
 * reimplementer a l'identique en Python et en Go.
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

/** Erreur de normalisation. Porte le chemin du champ fautif. */
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

/** Regle 2 : minuscules, sans checksum EIP-55. */
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
 * Regle 3 : montants en chaine decimale canonique.
 *
 * Accepte `string`, `bigint` et `number` entier sur, refuse tout le reste. Les
 * formes equivalentes (`"007"`, `"+7"`, `"-0"`) sont ramenees a leur forme
 * canonique pour qu'elles ne produisent pas deux hashs differents.
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
        // Regle 4 : `minCount` est le seul champ de check reellement optionnel.
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
 * Confirmations par defaut : L1 (chainId 1) attend 12 blocs, tout le reste 3
 * (docs/07 § 1). Le defaut est fige ici pour que deux implementations qui
 * omettent le champ produisent le meme hash.
 */
export function defaultConfirmations(chainId: number): number {
  return chainId === 1 ? DEFAULT_CONFIRMATIONS.l1 : DEFAULT_CONFIRMATIONS.l2
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation des specs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise une `ConditionSpec` avant hachage : adresses en minuscules,
 * montants en chaines decimales canoniques, defauts injectes, champs inconnus
 * ecartes.
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
 * Normalise une `ActionSpec` avant hachage.
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
    // Regle 4 : une action sans valeur native est "0", jamais absente.
    value: normDecimal(s['value'] === undefined ? '0' : s['value'], '$.value', UNSIGNED),
    calldata: normHexData(s['calldata'] === undefined ? '0x' : s['calldata'], '$.calldata'),
    registryRef: normHexBytes(s['registryRef'], 32, '$.registryRef'),
  }
}

/**
 * Normalisation generique : reconnait une `ConditionSpec` (elle porte `checks`)
 * d'une `ActionSpec` (elle porte `calldata`).
 *
 * @throws {NormalizationError} si la forme n'est ni l'une ni l'autre.
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
// Hachage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `keccak256(utf8(canonical))`. Le point d'entree bas niveau.
 *
 * On appelle `stringToBytes` et non le `toBytes` de docs/07 § 4 : `toBytes`
 * bascule en mode hexadecimal si la chaine commence par `0x`, ce qui hacherait
 * des octets differents. Les deux sont equivalents sur une sortie JCS, qui
 * commence toujours par `{`, `[` ou `"` — mais l'ambiguite n'a pas sa place
 * dans la fonction qui produit l'engagement onchain.
 */
export function hashCanonical(canonical: string): Hex {
  return keccak256(stringToBytes(canonical))
}

/** Forme canonique JCS d'une `ConditionSpec`, apres normalisation. */
export function canonicalConditionSpec(spec: unknown): string {
  return canonicalize(normalizeConditionSpec(spec))
}

/** Forme canonique JCS d'une `ActionSpec`, apres normalisation. */
export function canonicalActionSpec(spec: unknown): string {
  return canonicalize(normalizeActionSpec(spec))
}

/**
 * `conditionHash` engage onchain (docs/07 § 4).
 *
 * ```ts
 * keccak256(toBytes(canonicalize(normalize(spec))))
 * ```
 */
export function conditionHash(spec: unknown): Hex {
  return hashCanonical(canonicalConditionSpec(spec))
}

/** `actionHash` engage onchain — meme traitement que `conditionHash`. */
export function actionHash(spec: unknown): Hex {
  return hashCanonical(canonicalActionSpec(spec))
}
