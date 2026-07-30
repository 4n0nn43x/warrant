import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CanonicalizationError,
  canonicalize,
  serializeNumber,
  serializeString,
} from './canonical.js'
import {
  actionHash,
  canonicalActionSpec,
  canonicalConditionSpec,
  conditionHash,
  hashCanonical,
} from './hash.js'
import { CHECK_KINDS } from './dsl.js'

// ─────────────────────────────────────────────────────────────────────────────
// RFC 8785 § 3.2.3 — key ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalize — key ordering (RFC 8785 § 3.2.3)', () => {
  it('sorts by UTF-16 code units, which is the RFC order, not code point order', () => {
    // The RFC's normative example. The expected order puts the G clef (U+1D11E,
    // high surrogate D834) before the emoji (U+1F602, high surrogate D83D), and
    // both after the heart (U+2764): that is UTF-16 code unit order. Sorting by
    // code points would give the same order here, but sorting by UTF-8 bytes
    // would put U+1D11E after U+2764 — which is exactly the divergence this
    // vector locks down.
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      '\n': 'Newline',
      '1': 'One',
      '\u0080': 'Control',
      '😂': 'Smiley',
      'ö': 'Latin Small Letter O With Diaeresis',
      '': 'Empty',
      '❤️': 'Heart',
      '𝄞': 'G Clef',
    }
    expect(canonicalize(input)).toBe(
      '{"":"Empty",' +
        '"\\n":"Newline",' +
        '"\\r":"Carriage Return",' +
        '"1":"One",' +
        '"\u0080":"Control",' +
        '"ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign",' +
        '"❤️":"Heart",' +
        '"𝄞":"G Clef",' +
        '"😂":"Smiley"}',
    )
  })

  it('sorts uppercase before lowercase (code unit order, not locale order)', () => {
    expect(canonicalize({ a: 1, A: 2, b: 3, B: 4 })).toBe(
      '{"A":2,"B":4,"a":1,"b":3}',
    )
  })

  it('sorts digit-like keys as strings, not numerically', () => {
    expect(canonicalize({ '10': 1, '1': 2, '2': 3, '111': 4 })).toBe(
      '{"1":2,"10":1,"111":4,"2":3}',
    )
  })

  it('does not depend on insertion order', () => {
    const a = canonicalize({ z: 1, m: { d: 4, c: 3 }, a: [1, 2] })
    const b = canonicalize({ a: [1, 2], m: { c: 3, d: 4 }, z: 1 })
    expect(a).toBe(b)
  })

  it('sorts nested objects too', () => {
    expect(canonicalize({ o: { z: 1, a: 2 } })).toBe('{"o":{"a":2,"z":1}}')
  })

  it('never reorders array elements', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalize({ t: ['b', 'a'] })).toBe('{"t":["b","a"]}')
  })

  it('reproduces the nested example of RFC 8785 § 3.2.3', () => {
    const input = {
      '1': { f: { f: 'hi', F: 5 }, '\n': 56 },
      '10': {},
      '': 'empty',
      a: {},
      '111': [{ e: 'yes', E: 'no' }],
      A: {},
    }
    expect(canonicalize(input)).toBe(
      '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RFC 8785 § 3.2.2.2 — string escaping
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalize — string escaping (RFC 8785 § 3.2.2.2)', () => {
  it('uses the seven short escapes and nothing else for them', () => {
    expect(serializeString('\b\t\n\f\r"\\')).toBe('"\\b\\t\\n\\f\\r\\"\\\\"')
  })

  it('escapes other C0 control characters as lowercase \\u00xx', () => {
    expect(serializeString('\u0000')).toBe('"\\u0000"')
    expect(serializeString('\u0001')).toBe('"\\u0001"')
    expect(serializeString('\u000b')).toBe('"\\u000b"')
    expect(serializeString('\u000e')).toBe('"\\u000e"')
    expect(serializeString('\u001f')).toBe('"\\u001f"')
  })

  it('does not escape the solidus, DEL, or any non-ASCII character', () => {
    expect(serializeString('/')).toBe('"/"')
    expect(serializeString('\u007f')).toBe('"\u007f"')
    expect(serializeString('\u0080')).toBe('"\u0080"')
    expect(serializeString('caution déposée — 1 500 €')).toBe(
      '"caution déposée — 1 500 €"',
    )
    expect(serializeString('保証')).toBe('"保証"')
  })

  it('keeps well-formed surrogate pairs literal', () => {
    expect(serializeString('😂')).toBe('"😂"')
    expect(serializeString('a𝄞b')).toBe('"a𝄞b"')
    expect(serializeString('😂')).not.toContain('\\u')
  })

  it('escapes lone surrogates, which are not encodable in UTF-8', () => {
    // Same behaviour as ECMAScript's "well-formed" JSON.stringify.
    expect(serializeString('\ud800')).toBe('"\\ud800"')
    expect(serializeString('\udfff')).toBe('"\\udfff"')
    expect(serializeString('\ud800a')).toBe('"\\ud800a"')
    expect(serializeString('\udc00\ud800')).toBe('"\\udc00\\ud800"')
  })

  it('agrees with JSON.stringify on every BMP code unit', () => {
    // ECMAScript's JSON.stringify is RFC 8785's reference for escaping. A
    // divergence on a single code unit would show up here.
    const mismatches: string[] = []
    for (let cu = 0; cu <= 0xffff; cu += 1) {
      const s = String.fromCharCode(cu)
      if (serializeString(s) !== JSON.stringify(s)) {
        mismatches.push(`U+${cu.toString(16).padStart(4, '0')}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('escapes control characters appearing in object keys too', () => {
    expect(canonicalize({ '\u0001': 1 })).toBe('{"\\u0001":1}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RFC 8785 § 3.2.2.3 — numbers
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalize — numbers (RFC 8785 § 3.2.2.3)', () => {
  it('serializes -0 as 0', () => {
    expect(serializeNumber(-0)).toBe('0')
    expect(canonicalize(-0)).toBe('0')
    expect(canonicalize({ a: -0, b: 0 })).toBe('{"a":0,"b":0}')
    // A -0 that came out as "-0" would produce two hashes for the same value.
    expect(canonicalize(-0)).toBe(canonicalize(0))
  })

  it('follows ECMAScript Number::toString for integers and exponents', () => {
    expect(canonicalize(1)).toBe('1')
    expect(canonicalize(-1)).toBe('-1')
    expect(canonicalize(1.5)).toBe('1.5')
    expect(canonicalize(1e20)).toBe('100000000000000000000')
    expect(canonicalize(1e21)).toBe('1e+21')
    expect(canonicalize(1e-6)).toBe('0.000001')
    expect(canonicalize(1e-7)).toBe('1e-7')
    expect(canonicalize(1e100)).toBe('1e+100')
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
    expect(canonicalize(Number.MAX_VALUE)).toBe('1.7976931348623157e+308')
    expect(canonicalize(Number.MIN_VALUE)).toBe('5e-324')
  })

  it('rejects NaN and the infinities instead of emitting null', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError)
    expect(() => canonicalize(Number.NaN)).toThrow(/NaN/)
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/Infinity/)
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(/Infinity/)
    expect(() => canonicalize({ a: { b: [Number.NaN] } })).toThrow(
      /\$\.a\.b\[0\]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Structure and refusals
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalize — structure', () => {
  it('emits no formatting whitespace', () => {
    const out = canonicalize({ a: [1, { b: 2 }], c: 'x y' })
    expect(out).toBe('{"a":[1,{"b":2}],"c":"x y"}')
    expect(out).not.toMatch(/[\n\t]/)
  })

  it('handles empty containers and literals', () => {
    expect(canonicalize({})).toBe('{}')
    expect(canonicalize([])).toBe('[]')
    expect(canonicalize(null)).toBe('null')
    expect(canonicalize(true)).toBe('true')
    expect(canonicalize(false)).toBe('false')
    expect(canonicalize('')).toBe('""')
  })

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>
    o['b'] = 1
    o['a'] = 2
    expect(canonicalize(o)).toBe('{"a":2,"b":1}')
  })

  it('is idempotent through a JSON round-trip', () => {
    const spec = {
      version: 1,
      checks: [
        {
          kind: 'x',
          value:
            '115792089237316195423570985008687907853269984665640564039457584007913129639935',
        },
      ],
      note: 'héllo😂',
    }
    const once = canonicalize(spec)
    const twice = canonicalize(JSON.parse(once))
    expect(twice).toBe(once)
  })
})

describe('canonicalize — explicit refusals', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['undefined at the root', undefined, /undefined is not a JSON value/],
    [
      'undefined in an object',
      { a: undefined },
      /undefined is not a JSON value/,
    ],
    ['undefined in an array', [undefined], /undefined is not a JSON value/],
    ['a function', () => 1, /functions are not JSON values/],
    ['a symbol', Symbol('s'), /symbols are not JSON values/],
    ['a bigint', 1n, /bigint is not a JSON value/],
    ['a Date', new Date(0), /unsupported value of type Date/],
    ['a Map', new Map(), /unsupported value of type Map/],
    ['a Set', new Set(), /unsupported value of type Set/],
    // eslint-disable-next-line no-new-wrappers
    ['a boxed Number', new Number(1), /unsupported value of type Number/],
    // eslint-disable-next-line no-new-wrappers
    ['a boxed String', new String('x'), /unsupported value of type String/],
    ['a class instance', new (class Foo {})(), /unsupported value of type Foo/],
  ]

  for (const [label, value, pattern] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => canonicalize(value)).toThrow(CanonicalizationError)
      expect(() => canonicalize(value)).toThrow(pattern)
    })
  }

  it('rejects rather than silently dropping, unlike JSON.stringify', () => {
    // JSON.stringify({a: undefined}) === '{}': a key vanishes without a sound,
    // and two different specs hash the same. Unacceptable here.
    expect(JSON.stringify({ a: undefined })).toBe('{}')
    expect(() => canonicalize({ a: undefined })).toThrow()
  })

  it('reports the path of the offending field', () => {
    try {
      canonicalize({ checks: [{ kind: 'x' }, { value: undefined }] })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalizationError)
      expect((err as CanonicalizationError).path).toBe('$.checks[1].value')
      expect((err as Error).message).toContain('$.checks[1].value')
    }
  })

  it('detects direct and indirect cycles', () => {
    const self: Record<string, unknown> = {}
    self['me'] = self
    expect(() => canonicalize(self)).toThrow(/circular reference/)

    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { a }
    a['b'] = b
    expect(() => canonicalize(a)).toThrow(/circular reference/)

    const arr: unknown[] = []
    arr.push(arr)
    expect(() => canonicalize(arr)).toThrow(/circular reference/)
  })

  it('accepts a shared subtree that is not a cycle', () => {
    const shared = { a: 1 }
    expect(canonicalize({ x: shared, y: shared })).toBe(
      '{"x":{"a":1},"y":{"a":1}}',
    )
    expect(canonicalize([shared, shared])).toBe('[{"a":1},{"a":1}]')
  })

  it('ignores symbol-keyed properties, which are not JSON data', () => {
    const o: Record<string, unknown> = { a: 1 }
    ;(o as Record<symbol, unknown>)[Symbol('hidden')] = 2
    expect(canonicalize(o)).toBe('{"a":1}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Shared vectors — the cross-language agreement
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  name: string
  type: 'raw' | 'conditionSpec' | 'actionSpec'
  spec: unknown
  canonical: string
  hash: string
}

const FIXTURES: Fixture[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/condition-hashes.json', import.meta.url)),
    'utf8',
  ),
) as Fixture[]

describe('fixtures/condition-hashes.json', () => {
  it('carries enough vectors to be worth comparing across languages', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(12)
  })

  it('has unique names', () => {
    const names = FIXTURES.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('covers every kind of the closed catalogue', () => {
    const serialized = JSON.stringify(FIXTURES)
    for (const kind of CHECK_KINDS) {
      expect(serialized, `no vector exercises ${kind}`).toContain(
        `"kind":"${kind}"`,
      )
    }
  })

  it('covers each fixture type', () => {
    const types = new Set(FIXTURES.map((f) => f.type))
    expect([...types].sort()).toEqual(['actionSpec', 'conditionSpec', 'raw'])
  })

  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    'recomputes %s to the committed canonical form and hash',
    (_name, fixture) => {
      const canonical =
        fixture.type === 'raw'
          ? canonicalize(fixture.spec)
          : fixture.type === 'conditionSpec'
            ? canonicalConditionSpec(fixture.spec)
            : canonicalActionSpec(fixture.spec)

      expect(canonical).toBe(fixture.canonical)
      expect(hashCanonical(canonical)).toBe(fixture.hash)
      expect(fixture.hash).toMatch(/^0x[0-9a-f]{64}$/)

      if (fixture.type === 'conditionSpec') {
        expect(conditionHash(fixture.spec)).toBe(fixture.hash)
      }
      if (fixture.type === 'actionSpec') {
        expect(actionHash(fixture.spec)).toBe(fixture.hash)
      }
    },
  )

  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    'has a canonical form for %s that is valid JSON and already canonical',
    (_name, fixture) => {
      const reparsed: unknown = JSON.parse(fixture.canonical)
      expect(canonicalize(reparsed)).toBe(fixture.canonical)
    },
  )

  it('pins a uint256 that a JavaScript number could not hold', () => {
    const max =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const vector = FIXTURES.find(
      (f) => f.name === 'raw/uint256-amounts-as-decimal-strings',
    )
    expect(vector).toBeDefined()
    expect(vector?.canonical).toContain(`"maxUint256":"${max}"`)
    // The proof that going through a number would have destroyed the value.
    expect(String(Number(max))).not.toBe(max)
  })

  it('gives the same hash to a checksummed spec and its lowercase twin', () => {
    const a = FIXTURES.find((f) => f.name === 'check/erc20_allowance')
    const b = FIXTURES.find(
      (f) => f.name === 'normalize/checksummed-addresses-are-lowercased',
    )
    expect(a?.hash).toBeDefined()
    expect(a?.hash).toBe(b?.hash)
    expect(a?.canonical).not.toMatch(/0x[0-9a-f]*[A-F]/)
  })
})
