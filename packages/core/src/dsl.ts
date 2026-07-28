/**
 * Validation du DSL de post-conditions (docs/07).
 *
 * Le domaine est fini et enumere : tout `kind` hors catalogue est refuse **a
 * l'ouverture du mandat**, jamais au reglement. Refuser tard serait un moyen de
 * gagner a tous les coups.
 *
 * Toutes les erreurs portent le chemin du champ fautif (`$.checks[2].token`) :
 * un agent qui recoit un refus doit pouvoir corriger sa requete sans deviner.
 */

import { MAX_CHECKS } from './types.js'
import type {
  ActionSpec,
  Address,
  CheckKind,
  ConditionSpec,
  Hex,
  Op,
} from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs
// ─────────────────────────────────────────────────────────────────────────────

export interface DslIssue {
  /** Chemin JSONPath-like du champ fautif. */
  path: string
  message: string
}

/** Erreur de validation du DSL. Agrege toutes les anomalies detectees. */
export class DslError extends Error {
  readonly issues: readonly DslIssue[]
  /** Chemin du premier champ fautif — raccourci de confort. */
  readonly path: string

  constructor(subject: string, issues: DslIssue[]) {
    const rendered = issues.map((i) => `${i.path}: ${i.message}`).join('; ')
    super(`Invalid ${subject}: ${rendered}`)
    this.name = 'DslError'
    this.issues = issues
    this.path = issues[0]?.path ?? '$'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives partagees (reutilisees par hash.ts pour la normalisation)
// ─────────────────────────────────────────────────────────────────────────────

/** Catalogue ferme des vérificateurs, dans l'ordre de docs/07 § 2. */
export const CHECK_KINDS = [
  'erc20_allowance',
  'erc20_balance',
  'erc20_balance_delta',
  'native_balance_delta',
  'aave_health_factor',
  'staticcall_result',
  'event_emitted',
  'nonce_advanced',
  'no_new_approvals',
  'calldata_matches_commitment',
] as const satisfies readonly CheckKind[]

export const OPS = ['eq', 'lte', 'gte'] as const satisfies readonly Op[]

export const DECODE_AS = [
  'uint256',
  'int256',
  'bool',
  'address',
  'bytes32',
] as const

/** `calldata_matches_commitment` est hors quota de `MAX_CHECKS` (docs/07 § 2.10). */
export const COMMITMENT_KIND = 'calldata_matches_commitment'

/** Nombre maximal d'adresses surveillees par un `no_new_approvals`. */
export const MAX_WATCHED_TOKENS = 16

export const UINT256_MAX = (1n << 256n) - 1n
export const INT256_MAX = (1n << 255n) - 1n
export const INT256_MIN = -(1n << 255n)

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)$/
const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/

export function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && ADDRESS_RE.test(value)
}

/** Chaine hexadecimale de `bytes` octets exactement. */
export function isHexBytes(value: unknown, bytes: number): value is Hex {
  return (
    typeof value === 'string' &&
    value.length === 2 + bytes * 2 &&
    HEX_BYTES_RE.test(value)
  )
}

/** Chaine hexadecimale de longueur libre, mais entiere en octets. */
export function isHexData(value: unknown): value is Hex {
  return typeof value === 'string' && HEX_BYTES_RE.test(value)
}

/**
 * Chaine decimale **canonique** : pas de `+`, pas de zero de tete, pas de
 * `-0`, pas d'espace, pas de notation exponentielle.
 */
export function isCanonicalDecimal(value: unknown): value is string {
  return (
    typeof value === 'string' && DECIMAL_RE.test(value) && value !== '-0'
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// Collecteur d'anomalies
// ─────────────────────────────────────────────────────────────────────────────

class Issues {
  readonly list: DslIssue[] = []

  add(path: string, message: string): void {
    this.list.push({ path, message })
  }

  get ok(): boolean {
    return this.list.length === 0
  }
}

function quote(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return `${value}n`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Champs admis par vérificateur — tout champ surnumeraire est refuse
// ─────────────────────────────────────────────────────────────────────────────

const CHECK_FIELDS: Readonly<Record<CheckKind, readonly string[]>> = {
  erc20_allowance: ['kind', 'token', 'owner', 'spender', 'op', 'value'],
  erc20_balance: ['kind', 'token', 'account', 'op', 'value'],
  erc20_balance_delta: ['kind', 'token', 'account', 'op', 'value'],
  native_balance_delta: ['kind', 'account', 'op', 'value'],
  aave_health_factor: ['kind', 'pool', 'user', 'op', 'value'],
  staticcall_result: ['kind', 'target', 'data', 'decodeAs', 'op', 'value'],
  event_emitted: ['kind', 'address', 'topic0', 'minCount'],
  nonce_advanced: ['kind', 'account', 'op', 'value'],
  no_new_approvals: ['kind', 'owner', 'tokens'],
  calldata_matches_commitment: ['kind', 'actionHash'],
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation des primitives, avec chemin
// ─────────────────────────────────────────────────────────────────────────────

function checkAddress(
  issues: Issues,
  obj: Record<string, unknown>,
  path: string,
  field: string,
): void {
  const value = obj[field]
  if (!isAddress(value)) {
    issues.add(
      `${path}.${field}`,
      `expected a 20-byte hex address (0x + 40 hex chars), got ${quote(value)}`,
    )
  }
}

function checkOp(
  issues: Issues,
  obj: Record<string, unknown>,
  path: string,
): void {
  const value = obj['op']
  if (typeof value !== 'string' || !(OPS as readonly string[]).includes(value)) {
    issues.add(
      `${path}.op`,
      `expected one of ${OPS.join(' | ')}, got ${quote(value)}`,
    )
  }
}

function checkNumericValue(
  issues: Issues,
  obj: Record<string, unknown>,
  path: string,
  opts: { signed: boolean },
): void {
  const value = obj['value']
  const p = `${path}.value`
  if (typeof value !== 'string') {
    issues.add(
      p,
      `expected a decimal string (uint256 values exceed Number.MAX_SAFE_INTEGER), got ${quote(value)}`,
    )
    return
  }
  if (!isCanonicalDecimal(value)) {
    issues.add(
      p,
      `expected a canonical decimal string — digits only, optional leading '-', no leading zeros, no exponent — got ${quote(value)}`,
    )
    return
  }
  const n = BigInt(value)
  if (!opts.signed) {
    if (n < 0n) {
      issues.add(p, `expected a non-negative value, got ${quote(value)}`)
      return
    }
    if (n > UINT256_MAX) {
      issues.add(p, `value exceeds uint256 range, got ${quote(value)}`)
    }
    return
  }
  if (n < INT256_MIN || n > INT256_MAX) {
    issues.add(p, `value out of int256 range, got ${quote(value)}`)
  }
}

function checkStaticcallValue(
  issues: Issues,
  obj: Record<string, unknown>,
  path: string,
): void {
  const decodeAs = obj['decodeAs']
  const p = `${path}.value`
  const value = obj['value']

  if (
    typeof decodeAs !== 'string' ||
    !(DECODE_AS as readonly string[]).includes(decodeAs)
  ) {
    issues.add(
      `${path}.decodeAs`,
      `expected one of ${DECODE_AS.join(' | ')}, got ${quote(decodeAs)}`,
    )
    return
  }

  if (typeof value !== 'string') {
    issues.add(p, `expected a string encoding of ${decodeAs}, got ${quote(value)}`)
    return
  }

  switch (decodeAs) {
    case 'uint256':
      checkNumericValue(issues, obj, path, { signed: false })
      break
    case 'int256':
      checkNumericValue(issues, obj, path, { signed: true })
      break
    case 'bool':
      if (value !== 'true' && value !== 'false') {
        issues.add(p, `expected "true" or "false" for decodeAs=bool, got ${quote(value)}`)
      }
      break
    case 'address':
      if (!isAddress(value)) {
        issues.add(p, `expected a 20-byte hex address for decodeAs=address, got ${quote(value)}`)
      }
      break
    case 'bytes32':
      if (!isHexBytes(value, 32)) {
        issues.add(p, `expected a 32-byte hex string for decodeAs=bytes32, got ${quote(value)}`)
      }
      break
  }

  if (decodeAs === 'bool' || decodeAs === 'address' || decodeAs === 'bytes32') {
    const op = obj['op']
    if (op !== 'eq') {
      issues.add(
        `${path}.op`,
        `decodeAs=${decodeAs} only supports op "eq" — ordering is undefined for this type, got ${quote(op)}`,
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation d'un check
// ─────────────────────────────────────────────────────────────────────────────

function validateCheck(issues: Issues, raw: unknown, path: string): void {
  if (!isPlainRecord(raw)) {
    issues.add(path, `expected a check object, got ${quote(raw)}`)
    return
  }

  const kind = raw['kind']
  if (typeof kind !== 'string') {
    issues.add(`${path}.kind`, `expected a string, got ${quote(kind)}`)
    return
  }
  if (!(CHECK_KINDS as readonly string[]).includes(kind)) {
    issues.add(
      `${path}.kind`,
      `unknown check kind ${quote(kind)} — the catalogue is closed, admissible kinds are: ${CHECK_KINDS.join(', ')}`,
    )
    return
  }

  const k = kind as CheckKind
  const allowed = CHECK_FIELDS[k]
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.add(
        `${path}.${key}`,
        `unexpected field for kind ${quote(k)} — admissible fields are: ${allowed.join(', ')}`,
      )
    }
  }
  for (const key of allowed) {
    if (!(key in raw)) {
      issues.add(`${path}.${key}`, `missing required field for kind ${quote(k)}`)
    }
  }

  switch (k) {
    case 'erc20_allowance':
      checkAddress(issues, raw, path, 'token')
      checkAddress(issues, raw, path, 'owner')
      checkAddress(issues, raw, path, 'spender')
      checkOp(issues, raw, path)
      checkNumericValue(issues, raw, path, { signed: false })
      break

    case 'erc20_balance':
      checkAddress(issues, raw, path, 'token')
      checkAddress(issues, raw, path, 'account')
      checkOp(issues, raw, path)
      checkNumericValue(issues, raw, path, { signed: false })
      break

    case 'erc20_balance_delta':
      checkAddress(issues, raw, path, 'token')
      checkAddress(issues, raw, path, 'account')
      checkOp(issues, raw, path)
      checkNumericValue(issues, raw, path, { signed: true })
      break

    case 'native_balance_delta':
      checkAddress(issues, raw, path, 'account')
      checkOp(issues, raw, path)
      checkNumericValue(issues, raw, path, { signed: true })
      break

    case 'aave_health_factor':
      checkAddress(issues, raw, path, 'pool')
      checkAddress(issues, raw, path, 'user')
      checkOp(issues, raw, path)
      checkNumericValue(issues, raw, path, { signed: false })
      break

    case 'staticcall_result': {
      checkAddress(issues, raw, path, 'target')
      const data = raw['data']
      if (!isHexData(data)) {
        issues.add(
          `${path}.data`,
          `expected 0x-prefixed calldata with an even number of hex digits, got ${quote(data)}`,
        )
      } else if (data.length < 10) {
        issues.add(
          `${path}.data`,
          `expected at least a 4-byte function selector, got ${quote(data)}`,
        )
      }
      checkOp(issues, raw, path)
      checkStaticcallValue(issues, raw, path)
      break
    }

    case 'event_emitted': {
      checkAddress(issues, raw, path, 'address')
      const topic0 = raw['topic0']
      if (!isHexBytes(topic0, 32)) {
        issues.add(
          `${path}.topic0`,
          `expected a 32-byte event signature hash (0x + 64 hex chars), got ${quote(topic0)}`,
        )
      }
      const minCount = raw['minCount']
      if (!isInteger(minCount) || minCount < 1) {
        issues.add(
          `${path}.minCount`,
          `expected an integer >= 1, got ${quote(minCount)}`,
        )
      }
      break
    }

    case 'nonce_advanced':
      checkAddress(issues, raw, path, 'account')
      checkOp(issues, raw, path)
      checkNumericValue(issues, raw, path, { signed: false })
      break

    case 'no_new_approvals': {
      checkAddress(issues, raw, path, 'owner')
      const tokens = raw['tokens']
      if (!Array.isArray(tokens)) {
        issues.add(`${path}.tokens`, `expected an array of addresses, got ${quote(tokens)}`)
        break
      }
      if (tokens.length === 0) {
        issues.add(
          `${path}.tokens`,
          'expected at least one token address — an empty watchlist checks nothing',
        )
      }
      if (tokens.length > MAX_WATCHED_TOKENS) {
        issues.add(
          `${path}.tokens`,
          `expected at most ${MAX_WATCHED_TOKENS} addresses, got ${tokens.length}`,
        )
      }
      const seen = new Set<string>()
      tokens.forEach((token, i) => {
        if (!isAddress(token)) {
          issues.add(
            `${path}.tokens[${i}]`,
            `expected a 20-byte hex address, got ${quote(token)}`,
          )
          return
        }
        const lower = token.toLowerCase()
        if (seen.has(lower)) {
          issues.add(
            `${path}.tokens[${i}]`,
            `duplicate token ${quote(token)} — the watchlist is a set`,
          )
        }
        seen.add(lower)
      })
      break
    }

    case 'calldata_matches_commitment': {
      const actionHash = raw['actionHash']
      if (!isHexBytes(actionHash, 32)) {
        issues.add(
          `${path}.actionHash`,
          `expected a 32-byte hash (0x + 64 hex chars), got ${quote(actionHash)}`,
        )
      }
      break
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation de la ConditionSpec
// ─────────────────────────────────────────────────────────────────────────────

const SPEC_FIELDS = [
  'version',
  'chainId',
  'evaluateAt',
  'confirmations',
  'checks',
] as const

export interface ValidateOptions {
  /**
   * Autorise la presence de `calldata_matches_commitment`.
   *
   * Faux par defaut : une `conditionSpec` venant d'un agent ne doit jamais le
   * porter, c'est le Gateway qui l'injecte (docs/07 § 2.10). Le Gateway
   * revalide sa propre sortie avec `true`.
   */
  allowCommitmentCheck?: boolean
}

function validateEvaluateAt(issues: Issues, value: unknown): void {
  const p = '$.evaluateAt'
  if (value === 'tx' || value === 'tx+1') return
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length !== 1 || keys[0] !== 'block') {
      issues.add(
        p,
        `expected exactly the key "block", got {${keys.join(', ')}}`,
      )
      return
    }
    const block = value['block']
    if (!isInteger(block) || block < 0) {
      issues.add(`${p}.block`, `expected a non-negative integer block number, got ${quote(block)}`)
    }
    return
  }
  issues.add(
    p,
    `expected "tx", "tx+1" or { "block": n } — never "latest", a verdict must be reproducible — got ${quote(value)}`,
  )
}

function collectConditionIssues(
  spec: unknown,
  options: ValidateOptions,
): Issues {
  const issues = new Issues()

  if (!isPlainRecord(spec)) {
    issues.add('$', `expected a ConditionSpec object, got ${quote(spec)}`)
    return issues
  }

  for (const key of Object.keys(spec)) {
    if (!(SPEC_FIELDS as readonly string[]).includes(key)) {
      issues.add(
        `$.${key}`,
        `unexpected field — admissible fields are: ${SPEC_FIELDS.join(', ')}`,
      )
    }
  }

  if (spec['version'] !== 1) {
    issues.add(
      '$.version',
      `expected 1 — a version change changes the hash, got ${quote(spec['version'])}`,
    )
  }

  const chainId = spec['chainId']
  if (!isInteger(chainId) || chainId <= 0) {
    issues.add('$.chainId', `expected a positive integer chain id, got ${quote(chainId)}`)
  }

  validateEvaluateAt(issues, spec['evaluateAt'])

  const confirmations = spec['confirmations']
  if (!isInteger(confirmations) || confirmations < 0) {
    issues.add(
      '$.confirmations',
      `expected a non-negative integer, got ${quote(confirmations)}`,
    )
  }

  const checks = spec['checks']
  if (!Array.isArray(checks)) {
    issues.add('$.checks', `expected an array of checks, got ${quote(checks)}`)
    return issues
  }

  let declared = 0
  let commitments = 0
  checks.forEach((check, i) => {
    const path = `$.checks[${i}]`
    const kind = isPlainRecord(check) ? check['kind'] : undefined
    if (kind === COMMITMENT_KIND) {
      commitments += 1
      if (!options.allowCommitmentCheck) {
        issues.add(
          `${path}.kind`,
          `${COMMITMENT_KIND} is injected by the gateway and cannot be supplied, removed or overridden by the caller`,
        )
      } else if (commitments > 1) {
        issues.add(
          `${path}.kind`,
          `${COMMITMENT_KIND} must appear exactly once, found ${commitments}`,
        )
      }
    } else {
      declared += 1
    }
    validateCheck(issues, check, path)
  })

  if (declared === 0) {
    issues.add(
      '$.checks',
      'expected at least one declared check — an empty conjunction commits to nothing',
    )
  }
  if (declared > MAX_CHECKS) {
    issues.add(
      '$.checks',
      `expected at most ${MAX_CHECKS} declared checks (${COMMITMENT_KIND} is out of quota), got ${declared}`,
    )
  }

  return issues
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: DslIssue[] }

/** Variante sans exception : utile pour rendre toutes les anomalies d'un coup. */
export function safeValidateConditionSpec(
  spec: unknown,
  options: ValidateOptions = {},
): ValidationResult<ConditionSpec> {
  const issues = collectConditionIssues(spec, options)
  if (!issues.ok) return { ok: false, issues: issues.list }
  return { ok: true, value: spec as ConditionSpec }
}

/**
 * Valide une `ConditionSpec`. Refus a l'ouverture, jamais au reglement.
 *
 * @throws {DslError} portant `issues[]`, chacune avec le chemin du champ fautif.
 */
export function validateConditionSpec(
  spec: unknown,
  options: ValidateOptions = {},
): ConditionSpec {
  const issues = collectConditionIssues(spec, options)
  if (!issues.ok) throw new DslError('ConditionSpec', issues.list)
  return spec as ConditionSpec
}

/**
 * Valide une `ConditionSpec` telle que produite par le Gateway : le
 * `calldata_matches_commitment` doit y etre, exactement une fois.
 */
export function validateGatewayConditionSpec(spec: unknown): ConditionSpec {
  const validated = validateConditionSpec(spec, { allowCommitmentCheck: true })
  if (!validated.checks.some((c) => c.kind === COMMITMENT_KIND)) {
    throw new DslError('ConditionSpec', [
      {
        path: '$.checks',
        message: `${COMMITMENT_KIND} is missing — it is added to every conditionSpec and cannot be removed`,
      },
    ])
  }
  return validated
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection du vérificateur d'engagement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ajoute d'office `calldata_matches_commitment` a une `conditionSpec` fournie
 * par un agent (docs/07 § 2.10).
 *
 * Le check est **hors quota** : une spec avec 8 checks declares en ressort avec
 * 9 entrees, ce qui est legal. Toute tentative de le fournir soi-meme — pour le
 * neutraliser avec un faux `actionHash` par exemple — est refusee.
 *
 * @throws {DslError} si la spec est invalide, si elle porte deja le check, ou
 *   si `actionHash` n'est pas un hash de 32 octets.
 */
export function injectCommitmentCheck(
  spec: unknown,
  actionHash: unknown,
): ConditionSpec {
  const issues = collectConditionIssues(spec, { allowCommitmentCheck: false })
  if (!isHexBytes(actionHash, 32)) {
    issues.add(
      'actionHash',
      `expected a 32-byte action hash (0x + 64 hex chars), got ${quote(actionHash)}`,
    )
  }
  if (!issues.ok) throw new DslError('ConditionSpec', issues.list)

  const base = spec as ConditionSpec
  return {
    ...base,
    checks: [
      ...base.checks,
      {
        kind: COMMITMENT_KIND,
        actionHash: (actionHash as string).toLowerCase() as Hex,
      },
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionSpec
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_FIELDS = [
  'version',
  'chainId',
  'target',
  'value',
  'calldata',
  'registryRef',
] as const

function collectActionIssues(spec: unknown): Issues {
  const issues = new Issues()

  if (!isPlainRecord(spec)) {
    issues.add('$', `expected an ActionSpec object, got ${quote(spec)}`)
    return issues
  }

  for (const key of Object.keys(spec)) {
    if (!(ACTION_FIELDS as readonly string[]).includes(key)) {
      issues.add(
        `$.${key}`,
        `unexpected field — admissible fields are: ${ACTION_FIELDS.join(', ')}`,
      )
    }
  }

  if (spec['version'] !== 1) {
    issues.add('$.version', `expected 1, got ${quote(spec['version'])}`)
  }

  const chainId = spec['chainId']
  if (!isInteger(chainId) || chainId <= 0) {
    issues.add('$.chainId', `expected a positive integer chain id, got ${quote(chainId)}`)
  }

  if (!isAddress(spec['target'])) {
    issues.add(
      '$.target',
      `expected a 20-byte hex address, got ${quote(spec['target'])}`,
    )
  }

  const value = spec['value']
  if (!isCanonicalDecimal(value)) {
    issues.add(
      '$.value',
      `expected a canonical decimal wei amount as a string, got ${quote(value)}`,
    )
  } else {
    const n = BigInt(value)
    if (n < 0n) issues.add('$.value', `expected a non-negative wei amount, got ${quote(value)}`)
    else if (n > UINT256_MAX) issues.add('$.value', `value exceeds uint256 range, got ${quote(value)}`)
  }

  if (!isHexData(spec['calldata'])) {
    issues.add(
      '$.calldata',
      `expected 0x-prefixed calldata with an even number of hex digits, got ${quote(spec['calldata'])}`,
    )
  }

  if (!isHexBytes(spec['registryRef'], 32)) {
    issues.add(
      '$.registryRef',
      `expected a 32-byte registry version hash (0x + 64 hex chars), got ${quote(spec['registryRef'])}`,
    )
  }

  return issues
}

export function safeValidateActionSpec(spec: unknown): ValidationResult<ActionSpec> {
  const issues = collectActionIssues(spec)
  if (!issues.ok) return { ok: false, issues: issues.list }
  return { ok: true, value: spec as ActionSpec }
}

/** @throws {DslError} */
export function validateActionSpec(spec: unknown): ActionSpec {
  const issues = collectActionIssues(spec)
  if (!issues.ok) throw new DslError('ActionSpec', issues.list)
  return spec as ActionSpec
}
