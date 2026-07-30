/**
 * JSON canonicalization — RFC 8785 (JCS).
 *
 * This module is the most critical piece of the project: the `conditionHash`
 * posted onchain must be recomputable byte for byte by anyone, in TypeScript,
 * in Python or in Go. A serialization divergence between client and server
 * would make every warrant unevaluable (docs/07 § 4).
 *
 * Rules implemented, in the order of the RFC:
 *
 *  - §3.2.1 — no formatting whitespace, bare `,` and `:` separators.
 *  - §3.2.2.2 — minimal escaping: \b \t \n \f \r \" and the backslash; the
 *    other control characters U+0000..U+001F as `\u00xx` (lowercase hex),
 *    everything else literal in UTF-8. Lone surrogates — not representable in
 *    UTF-8 — are escaped as `\udxxx`, exactly as ECMAScript's "well-formed"
 *    `JSON.stringify` does.
 *  - §3.2.2.3 — numbers serialized by ECMAScript's `Number::toString`, with
 *    `-0` serialized as `0`.
 *  - §3.2.3 — object keys sorted by lexicographic order of their **UTF-16 code
 *    units**. That is exactly the order of JavaScript's `<` comparator on
 *    strings; it differs from code point order for characters outside the BMP,
 *    and the RFC means it to.
 *
 * What is refused explicitly, rather than silently transformed as
 * `JSON.stringify` would: `undefined`, functions, symbols, `NaN`, `±Infinity`,
 * `bigint`, non-plain objects (Date, Map, Set, wrappers…) and cycles.
 */

/** Canonicalization error. Always carries the path of the offending field. */
export class CanonicalizationError extends Error {
  /** JSONPath-like path of the offending node, e.g. `$.checks[0].value`. */
  readonly path: string

  constructor(message: string, path: string) {
    super(`${message} (at ${path})`)
    this.name = 'CanonicalizationError'
    this.path = path
  }
}

/**
 * Short escapes mandated by RFC 8785 § 3.2.2.2, indexed by code unit. We index
 * by code rather than by character so that the table stays readable in the
 * source.
 */
const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
}

function unicodeEscape(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).padStart(4, '0')}`
}

/**
 * Serializes a JSON string per RFC 8785 § 3.2.2.2.
 *
 * Exported for the tests: this is the spot where a cross-language divergence is
 * most likely.
 */
export function serializeString(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i += 1) {
    const cu = value.charCodeAt(i)
    const short = SHORT_ESCAPES[cu]
    if (short !== undefined) {
      out += short
      continue
    }
    if (cu < 0x20) {
      out += unicodeEscape(cu)
      continue
    }
    if (cu >= 0xd800 && cu <= 0xdbff) {
      // High surrogate: valid only if a low surrogate follows.
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.charAt(i) + value.charAt(i + 1)
        i += 1
        continue
      }
      out += unicodeEscape(cu)
      continue
    }
    if (cu >= 0xdc00 && cu <= 0xdfff) {
      // Orphan low surrogate.
      out += unicodeEscape(cu)
      continue
    }
    out += value.charAt(i)
  }
  return `${out}"`
}

/**
 * Serializes a number per RFC 8785 § 3.2.2.3: ECMAScript's `Number::toString`,
 * except for `-0`, which must come out as `0`.
 *
 * `String(n)` in JavaScript *is* `Number::toString`; we therefore do not
 * reimplement the conversion algorithm, we only handle negative zero.
 */
export function serializeNumber(value: number, path = '$'): string {
  if (Number.isNaN(value)) {
    throw new CanonicalizationError('NaN is not representable in JSON', path)
  }
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(
      'Infinity is not representable in JSON',
      path,
    )
  }
  // Covers 0 and -0: RFC 8785 mandates the same serialization for both.
  if (value === 0) return '0'
  return String(value)
}

function describe(value: object): string {
  const ctor = value.constructor
  return ctor && typeof ctor.name === 'string' && ctor.name.length > 0
    ? ctor.name
    : 'object'
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function encode(value: unknown, path: string, stack: object[]): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'

    case 'number':
      return serializeNumber(value, path)

    case 'string':
      return serializeString(value)

    case 'undefined':
      throw new CanonicalizationError(
        'undefined is not a JSON value; omit the key or use null',
        path,
      )

    case 'function':
      throw new CanonicalizationError('functions are not JSON values', path)

    case 'symbol':
      throw new CanonicalizationError('symbols are not JSON values', path)

    case 'bigint':
      throw new CanonicalizationError(
        'bigint is not a JSON value; serialize large integers as decimal strings',
        path,
      )

    default:
      break
  }

  const obj = value as object
  if (stack.includes(obj)) {
    throw new CanonicalizationError('circular reference detected', path)
  }
  stack.push(obj)
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = []
      for (let i = 0; i < obj.length; i += 1) {
        parts.push(encode(obj[i], `${path}[${i}]`, stack))
      }
      return `[${parts.join(',')}]`
    }

    if (!isPlainObject(obj)) {
      throw new CanonicalizationError(
        `unsupported value of type ${describe(obj)}; only plain objects, arrays, strings, numbers, booleans and null are canonicalizable`,
        path,
      )
    }

    // RFC 8785 § 3.2.3: sort by UTF-16 code units. JavaScript's `<` comparator
    // on strings does exactly that.
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    const parts: string[] = []
    for (const key of keys) {
      const child = (obj as Record<string, unknown>)[key]
      parts.push(
        `${serializeString(key)}:${encode(child, `${path}.${key}`, stack)}`,
      )
    }
    return `{${parts.join(',')}}`
  } finally {
    stack.pop()
  }
}

/**
 * Canonicalizes a JSON value per RFC 8785 and returns the corresponding UTF-8
 * string.
 *
 * @throws {CanonicalizationError} on any non-representable value.
 */
export function canonicalize(value: unknown): string {
  return encode(value, '$', [])
}
