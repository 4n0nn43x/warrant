import { keccak256, stringToBytes } from 'viem'
import { describe, expect, it } from 'vitest'

import { canonicalize } from './canonical.js'
import {
  CHECK_KINDS,
  COMMITMENT_KIND,
  DslError,
  injectCommitmentCheck,
  safeValidateConditionSpec,
  validateActionSpec,
  validateConditionSpec,
  validateGatewayConditionSpec,
} from './dsl.js'
import {
  NormalizationError,
  actionHash,
  canonicalConditionSpec,
  conditionHash,
  defaultConfirmations,
  hashCanonical,
  normalize,
  normalizeActionSpec,
  normalizeConditionSpec,
} from './hash.js'
import { MAX_CHECKS } from './types.js'
import type { Check, ConditionSpec } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Local fixtures
// ─────────────────────────────────────────────────────────────────────────────

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const TREASURY = '0x1111111111111111111111111111111111111111'
const SPENDER = '0x2222222222222222222222222222222222222222'
const AGENT = '0x3333333333333333333333333333333333333333'

const TOPIC_APPROVAL =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const ACTION_HASH =
  '0x9d8f2c1e4b6a0537d1c9e2a4f60b8d3c5a7e91f24b6d8036c1e5a9f7b3d20c48'
const REGISTRY_REF =
  '0x5c1f7a93e0b46d28f3a5c7091e6b4d82a0f39c5d71b8e2460a93f5c7d1e08b36'

const UINT256_MAX =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'
const INT256_MIN =
  '-57896044618658097711785492504343953926634992332820282019728792003956564819968'
const INT256_MAX =
  '57896044618658097711785492504343953926634992332820282019728792003956564819967'

const VALID_CHECKS: Record<string, Record<string, unknown>> = {
  erc20_allowance: {
    kind: 'erc20_allowance',
    token: USDC,
    owner: TREASURY,
    spender: SPENDER,
    op: 'eq',
    value: '0',
  },
  erc20_balance: {
    kind: 'erc20_balance',
    token: USDC,
    account: TREASURY,
    op: 'gte',
    value: '1000000',
  },
  erc20_balance_delta: {
    kind: 'erc20_balance_delta',
    token: USDC,
    account: TREASURY,
    op: 'gte',
    value: '-50000000',
  },
  native_balance_delta: {
    kind: 'native_balance_delta',
    account: TREASURY,
    op: 'gte',
    value: '-1',
  },
  aave_health_factor: {
    kind: 'aave_health_factor',
    pool: AAVE_POOL,
    user: TREASURY,
    op: 'gte',
    value: '1500000000000000000',
  },
  staticcall_result: {
    kind: 'staticcall_result',
    target: USDT,
    data: '0x70a082310000000000000000000000001111111111111111111111111111111111111111',
    decodeAs: 'uint256',
    op: 'lte',
    value: '0',
  },
  event_emitted: {
    kind: 'event_emitted',
    address: USDT,
    topic0: TOPIC_APPROVAL,
    minCount: 1,
  },
  nonce_advanced: {
    kind: 'nonce_advanced',
    account: AGENT,
    op: 'eq',
    value: '1',
  },
  no_new_approvals: {
    kind: 'no_new_approvals',
    owner: TREASURY,
    tokens: [USDT],
  },
  calldata_matches_commitment: {
    kind: 'calldata_matches_commitment',
    actionHash: ACTION_HASH,
  },
}

function spec(checks: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    chainId: 1,
    evaluateAt: 'tx',
    confirmations: 12,
    checks,
    ...overrides,
  }
}

function issuesOf(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn()
  } catch (err) {
    if (err instanceof DslError) return [...err.issues]
    throw err
  }
  throw new Error('expected a DslError, none was thrown')
}

function paths(fn: () => unknown): string[] {
  return issuesOf(fn).map((i) => i.path)
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConditionSpec — the catalogue is closed', () => {
  it('accepts every kind of the catalogue', () => {
    for (const kind of CHECK_KINDS) {
      const check = VALID_CHECKS[kind]
      expect(check, `no sample check for ${kind}`).toBeDefined()
      // The commitment check is out of quota: on its own it does not amount to a
      // declared conjunction, so we pair it with an ordinary check.
      const checks =
        kind === COMMITMENT_KIND ? [VALID_CHECKS['nonce_advanced'], check] : [check]
      expect(() =>
        validateConditionSpec(spec(checks), { allowCommitmentCheck: true }),
      ).not.toThrow()
    }
  })

  it('refuses a spec made only of the out-of-quota commitment check', () => {
    const errs = issuesOf(() =>
      validateConditionSpec(spec([VALID_CHECKS['calldata_matches_commitment']]), {
        allowCommitmentCheck: true,
      }),
    )
    expect(errs[0]?.path).toBe('$.checks')
    expect(errs[0]?.message).toContain('at least one declared check')
  })

  it('the sample table covers the whole catalogue', () => {
    expect(Object.keys(VALID_CHECKS).sort()).toEqual([...CHECK_KINDS].sort())
  })

  it.each([
    'swap_got_a_good_price',
    'decision_was_optimal',
    'position_will_be_profitable',
    'agent_was_not_manipulated',
    'gas_was_reasonable',
  ])('rejects the inadmissible kind %s and names the offending field', (kind) => {
    const errs = issuesOf(() => validateConditionSpec(spec([{ kind }])))
    expect(errs[0]?.path).toBe('$.checks[0].kind')
    expect(errs[0]?.message).toContain('unknown check kind')
    expect(errs[0]?.message).toContain('erc20_allowance')
  })

  it('rejects a missing or non-string kind', () => {
    expect(paths(() => validateConditionSpec(spec([{}])))).toEqual([
      '$.checks[0].kind',
    ])
    expect(paths(() => validateConditionSpec(spec([{ kind: 7 }])))).toEqual([
      '$.checks[0].kind',
    ])
  })

  it('rejects a check that is not an object', () => {
    expect(paths(() => validateConditionSpec(spec(['erc20_allowance'])))).toEqual(
      ['$.checks[0]'],
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cardinality of `checks`
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConditionSpec — checks cardinality', () => {
  it('rejects an empty conjunction', () => {
    const errs = issuesOf(() => validateConditionSpec(spec([])))
    expect(errs[0]?.path).toBe('$.checks')
    expect(errs[0]?.message).toContain('at least one declared check')
  })

  it('rejects a non-array checks field', () => {
    expect(paths(() => validateConditionSpec(spec(undefined as never)))).toEqual(
      ['$.checks'],
    )
  })

  it(`accepts exactly ${MAX_CHECKS} declared checks`, () => {
    const checks = Array.from({ length: MAX_CHECKS }, () => ({
      ...VALID_CHECKS['nonce_advanced'],
    }))
    expect(() => validateConditionSpec(spec(checks))).not.toThrow()
  })

  it(`rejects ${MAX_CHECKS + 1} declared checks`, () => {
    const checks = Array.from({ length: MAX_CHECKS + 1 }, () => ({
      ...VALID_CHECKS['nonce_advanced'],
    }))
    const errs = issuesOf(() => validateConditionSpec(spec(checks)))
    expect(errs[0]?.path).toBe('$.checks')
    expect(errs[0]?.message).toContain(`at most ${MAX_CHECKS}`)
  })

  it('leaves calldata_matches_commitment out of the quota', () => {
    const checks = [
      ...Array.from({ length: MAX_CHECKS }, () => ({
        ...VALID_CHECKS['nonce_advanced'],
      })),
      VALID_CHECKS['calldata_matches_commitment'],
    ]
    expect(checks).toHaveLength(MAX_CHECKS + 1)
    expect(() =>
      validateConditionSpec(spec(checks), { allowCommitmentCheck: true }),
    ).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The spec envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConditionSpec — envelope', () => {
  const one = [VALID_CHECKS['nonce_advanced']]

  it('rejects a non-object spec', () => {
    for (const bad of [null, 'x', 42, [], undefined]) {
      expect(paths(() => validateConditionSpec(bad))).toEqual(['$'])
    }
  })

  it('rejects an unknown top-level field', () => {
    const errs = issuesOf(() =>
      validateConditionSpec(spec(one, { or: ['anything'] })),
    )
    expect(errs[0]?.path).toBe('$.or')
    expect(errs[0]?.message).toContain('unexpected field')
  })

  it('rejects a version other than 1', () => {
    expect(paths(() => validateConditionSpec(spec(one, { version: 2 })))).toEqual(
      ['$.version'],
    )
    expect(
      paths(() => validateConditionSpec(spec(one, { version: '1' }))),
    ).toEqual(['$.version'])
  })

  it('rejects a bad chainId', () => {
    for (const bad of [0, -1, 1.5, '1', null]) {
      expect(paths(() => validateConditionSpec(spec(one, { chainId: bad })))).toEqual(
        ['$.chainId'],
      )
    }
  })

  it('accepts the three forms of evaluateAt', () => {
    for (const at of ['tx', 'tx+1', { block: 21_000_000 }, { block: 0 }]) {
      expect(() =>
        validateConditionSpec(spec(one, { evaluateAt: at })),
      ).not.toThrow()
    }
  })

  it('rejects "latest" and any other evaluateAt — a verdict must be reproducible', () => {
    const errs = issuesOf(() =>
      validateConditionSpec(spec(one, { evaluateAt: 'latest' })),
    )
    expect(errs[0]?.path).toBe('$.evaluateAt')
    expect(errs[0]?.message).toContain('reproducible')

    expect(
      paths(() => validateConditionSpec(spec(one, { evaluateAt: { block: -1 } }))),
    ).toEqual(['$.evaluateAt.block'])
    expect(
      paths(() =>
        validateConditionSpec(spec(one, { evaluateAt: { block: 1, extra: 2 } })),
      ),
    ).toEqual(['$.evaluateAt'])
  })

  it('rejects bad confirmations', () => {
    for (const bad of [-1, 1.5, '12', null]) {
      expect(
        paths(() => validateConditionSpec(spec(one, { confirmations: bad }))),
      ).toEqual(['$.confirmations'])
    }
  })

  it('reports every issue at once, each with its own path', () => {
    const errs = issuesOf(() =>
      validateConditionSpec({
        version: 2,
        chainId: 0,
        evaluateAt: 'latest',
        confirmations: -1,
        checks: [{ kind: 'erc20_allowance', token: '0xnope' }],
      }),
    )
    const seen = errs.map((e) => e.path)
    expect(seen).toContain('$.version')
    expect(seen).toContain('$.chainId')
    expect(seen).toContain('$.evaluateAt')
    expect(seen).toContain('$.confirmations')
    expect(seen).toContain('$.checks[0].token')
    for (const e of errs) expect(e.path.startsWith('$')).toBe(true)
  })

  it('exposes a non-throwing variant', () => {
    const bad = safeValidateConditionSpec(spec([]))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.length).toBeGreaterThan(0)

    const good = safeValidateConditionSpec(spec(one))
    expect(good.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Per-check validation
// ─────────────────────────────────────────────────────────────────────────────

describe('validateConditionSpec — per-check shape', () => {
  function reject(check: Record<string, unknown>, expectedPath: string) {
    const errs = issuesOf(() =>
      validateConditionSpec(spec([check]), { allowCommitmentCheck: true }),
    )
    expect(errs.map((e) => e.path)).toContain(expectedPath)
  }

  it('rejects malformed addresses on every address-bearing field', () => {
    reject({ ...VALID_CHECKS['erc20_allowance'], token: '0xTREASURY' }, '$.checks[0].token')
    reject({ ...VALID_CHECKS['erc20_allowance'], owner: '0x123' }, '$.checks[0].owner')
    reject({ ...VALID_CHECKS['erc20_allowance'], spender: USDC.slice(0, -1) }, '$.checks[0].spender')
    reject({ ...VALID_CHECKS['erc20_balance'], account: `${USDC}00` }, '$.checks[0].account')
    reject({ ...VALID_CHECKS['aave_health_factor'], pool: 'not-hex' }, '$.checks[0].pool')
    reject({ ...VALID_CHECKS['aave_health_factor'], user: null }, '$.checks[0].user')
    reject({ ...VALID_CHECKS['staticcall_result'], target: 42 }, '$.checks[0].target')
    reject({ ...VALID_CHECKS['event_emitted'], address: USDC.toUpperCase() }, '$.checks[0].address')
  })

  it('accepts an EIP-55 checksummed address', () => {
    expect(() =>
      validateConditionSpec(
        spec([
          {
            ...VALID_CHECKS['erc20_balance'],
            token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          },
        ]),
      ),
    ).not.toThrow()
  })

  it('rejects an op outside eq | lte | gte', () => {
    for (const op of ['lt', 'gt', 'ne', '', 1, undefined]) {
      reject({ ...VALID_CHECKS['erc20_balance'], op }, '$.checks[0].op')
    }
  })

  it('rejects values that are not canonical decimal strings', () => {
    for (const value of [0, 1e18, '1e18', '0x0', '', ' 1', '1 ', '+1', '007', '-0', '1.0', null, 1n]) {
      reject({ ...VALID_CHECKS['erc20_balance'], value }, '$.checks[0].value')
    }
  })

  it('accepts the whole uint256 range and rejects what overflows it', () => {
    expect(() =>
      validateConditionSpec(spec([{ ...VALID_CHECKS['erc20_balance'], value: UINT256_MAX }])),
    ).not.toThrow()
    reject(
      { ...VALID_CHECKS['erc20_balance'], value: `${UINT256_MAX.slice(0, -1)}6` },
      '$.checks[0].value',
    )
    reject({ ...VALID_CHECKS['erc20_balance'], value: '-1' }, '$.checks[0].value')
  })

  it('accepts signed deltas only on the delta kinds', () => {
    for (const kind of ['erc20_balance_delta', 'native_balance_delta']) {
      expect(() =>
        validateConditionSpec(spec([{ ...VALID_CHECKS[kind], value: INT256_MIN }])),
      ).not.toThrow()
      expect(() =>
        validateConditionSpec(spec([{ ...VALID_CHECKS[kind], value: INT256_MAX }])),
      ).not.toThrow()
      reject({ ...VALID_CHECKS[kind], value: `${INT256_MAX}0` }, '$.checks[0].value')
    }
    reject({ ...VALID_CHECKS['nonce_advanced'], value: '-1' }, '$.checks[0].value')
    reject({ ...VALID_CHECKS['aave_health_factor'], value: '-1' }, '$.checks[0].value')
  })

  it('validates staticcall_result target, data and decoding', () => {
    reject({ ...VALID_CHECKS['staticcall_result'], data: '0x123' }, '$.checks[0].data')
    reject({ ...VALID_CHECKS['staticcall_result'], data: '70a08231' }, '$.checks[0].data')
    reject({ ...VALID_CHECKS['staticcall_result'], data: '0x' }, '$.checks[0].data')
    reject({ ...VALID_CHECKS['staticcall_result'], decodeAs: 'uint128' }, '$.checks[0].decodeAs')
    reject({ ...VALID_CHECKS['staticcall_result'], decodeAs: 'bytes' }, '$.checks[0].decodeAs')
  })

  it('binds staticcall_result value shape to decodeAs', () => {
    const base = VALID_CHECKS['staticcall_result'] as Record<string, unknown>
    expect(() =>
      validateConditionSpec(spec([{ ...base, decodeAs: 'int256', value: '-1' }])),
    ).not.toThrow()
    expect(() =>
      validateConditionSpec(spec([{ ...base, decodeAs: 'bool', op: 'eq', value: 'true' }])),
    ).not.toThrow()
    expect(() =>
      validateConditionSpec(spec([{ ...base, decodeAs: 'address', op: 'eq', value: TREASURY }])),
    ).not.toThrow()
    expect(() =>
      validateConditionSpec(spec([{ ...base, decodeAs: 'bytes32', op: 'eq', value: TOPIC_APPROVAL }])),
    ).not.toThrow()

    reject({ ...base, decodeAs: 'bool', op: 'eq', value: '1' }, '$.checks[0].value')
    reject({ ...base, decodeAs: 'address', op: 'eq', value: '0x00' }, '$.checks[0].value')
    reject({ ...base, decodeAs: 'bytes32', op: 'eq', value: TREASURY }, '$.checks[0].value')
    reject({ ...base, decodeAs: 'uint256', value: '-1' }, '$.checks[0].value')
    // No total order exists for bool/address/bytes32.
    reject({ ...base, decodeAs: 'bool', op: 'gte', value: 'true' }, '$.checks[0].op')
  })

  it('validates event_emitted topic0 and minCount', () => {
    reject({ ...VALID_CHECKS['event_emitted'], topic0: '0x1234' }, '$.checks[0].topic0')
    reject({ ...VALID_CHECKS['event_emitted'], topic0: TOPIC_APPROVAL.slice(0, -2) }, '$.checks[0].topic0')
    reject({ ...VALID_CHECKS['event_emitted'], topic0: `${TOPIC_APPROVAL}ff` }, '$.checks[0].topic0')
    reject({ ...VALID_CHECKS['event_emitted'], minCount: 0 }, '$.checks[0].minCount')
    reject({ ...VALID_CHECKS['event_emitted'], minCount: -1 }, '$.checks[0].minCount')
    reject({ ...VALID_CHECKS['event_emitted'], minCount: 1.5 }, '$.checks[0].minCount')
    reject({ ...VALID_CHECKS['event_emitted'], minCount: '1' }, '$.checks[0].minCount')
    expect(() =>
      validateConditionSpec(spec([{ ...VALID_CHECKS['event_emitted'], minCount: 3 }])),
    ).not.toThrow()
  })

  it('validates the no_new_approvals watchlist', () => {
    reject({ ...VALID_CHECKS['no_new_approvals'], tokens: [] }, '$.checks[0].tokens')
    reject({ ...VALID_CHECKS['no_new_approvals'], tokens: USDT }, '$.checks[0].tokens')
    reject({ ...VALID_CHECKS['no_new_approvals'], tokens: [USDT, '0xzz'] }, '$.checks[0].tokens[1]')
    reject(
      { ...VALID_CHECKS['no_new_approvals'], tokens: [USDT, USDT.toUpperCase().replace('0X', '0x')] },
      '$.checks[0].tokens[1]',
    )
    reject(
      {
        ...VALID_CHECKS['no_new_approvals'],
        tokens: Array.from({ length: 17 }, (_, i) => `0x${String(i).padStart(40, '0')}`),
      },
      '$.checks[0].tokens',
    )
  })

  it('validates the commitment actionHash', () => {
    reject({ kind: COMMITMENT_KIND, actionHash: '0x00' }, '$.checks[0].actionHash')
    reject({ kind: COMMITMENT_KIND, actionHash: TREASURY }, '$.checks[0].actionHash')
    reject({ kind: COMMITMENT_KIND }, '$.checks[0].actionHash')
  })

  it('rejects surplus and missing fields, naming each one', () => {
    const errs = issuesOf(() =>
      validateConditionSpec(
        spec([{ kind: 'nonce_advanced', account: AGENT, op: 'eq', value: '1', tolerance: '5' }]),
      ),
    )
    expect(errs.map((e) => e.path)).toContain('$.checks[0].tolerance')
    expect(errs[0]?.message).toContain('unexpected field')

    const missing = issuesOf(() =>
      validateConditionSpec(spec([{ kind: 'nonce_advanced', account: AGENT }])),
    )
    expect(missing.map((e) => e.path)).toContain('$.checks[0].op')
    expect(missing.map((e) => e.path)).toContain('$.checks[0].value')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// calldata_matches_commitment — implicit and not removable
// ─────────────────────────────────────────────────────────────────────────────

describe('injectCommitmentCheck', () => {
  const client = spec([VALID_CHECKS['erc20_allowance']])

  it('adds the commitment check to a spec that did not ask for one', () => {
    const out = injectCommitmentCheck(client, ACTION_HASH)
    expect(out.checks).toHaveLength(2)
    const last = out.checks[1] as Check
    expect(last).toEqual({ kind: COMMITMENT_KIND, actionHash: ACTION_HASH })
  })

  it('does not mutate the caller spec', () => {
    const input = spec([VALID_CHECKS['erc20_allowance']])
    injectCommitmentCheck(input, ACTION_HASH)
    expect(input.checks).toHaveLength(1)
  })

  it('lowercases the actionHash', () => {
    const out = injectCommitmentCheck(client, ACTION_HASH.toUpperCase().replace('0X', '0x'))
    const last = out.checks[1] as { actionHash: string }
    expect(last.actionHash).toBe(ACTION_HASH)
  })

  it('rejects a spec that supplies the commitment check itself', () => {
    const errs = issuesOf(() =>
      injectCommitmentCheck(
        spec([VALID_CHECKS['erc20_allowance'], VALID_CHECKS['calldata_matches_commitment']]),
        ACTION_HASH,
      ),
    )
    expect(errs[0]?.path).toBe('$.checks[1].kind')
    expect(errs[0]?.message).toContain('cannot be supplied, removed or overridden')
  })

  it('rejects a spec that supplies a forged commitment check', () => {
    const forged = { kind: COMMITMENT_KIND, actionHash: `0x${'0'.repeat(64)}` }
    expect(() => injectCommitmentCheck(spec([forged]), ACTION_HASH)).toThrow(DslError)
  })

  it('rejects duplicates even when the commitment check is allowed', () => {
    const errs = issuesOf(() =>
      validateConditionSpec(
        spec([
          VALID_CHECKS['erc20_allowance'],
          VALID_CHECKS['calldata_matches_commitment'],
          VALID_CHECKS['calldata_matches_commitment'],
        ]),
        { allowCommitmentCheck: true },
      ),
    )
    expect(errs[0]?.path).toBe('$.checks[2].kind')
    expect(errs[0]?.message).toContain('exactly once')
  })

  it('rejects a malformed actionHash', () => {
    for (const bad of ['0x', '0xdeadbeef', TREASURY, ACTION_HASH.slice(0, -1), 42, null]) {
      const errs = issuesOf(() => injectCommitmentCheck(client, bad))
      expect(errs.map((e) => e.path)).toContain('actionHash')
    }
  })

  it('rejects an invalid spec before injecting anything', () => {
    expect(() => injectCommitmentCheck(spec([]), ACTION_HASH)).toThrow(DslError)
    expect(() => injectCommitmentCheck(spec([{ kind: 'nope' }]), ACTION_HASH)).toThrow(
      /unknown check kind/,
    )
  })

  it('keeps a full-quota spec legal, the commitment being out of quota', () => {
    const full = spec(
      Array.from({ length: MAX_CHECKS }, () => ({ ...VALID_CHECKS['nonce_advanced'] })),
    )
    const out = injectCommitmentCheck(full, ACTION_HASH)
    expect(out.checks).toHaveLength(MAX_CHECKS + 1)
    expect(() => validateGatewayConditionSpec(out)).not.toThrow()
  })

  it('makes the gateway output pass gateway validation, and a stripped spec fail it', () => {
    const out = injectCommitmentCheck(client, ACTION_HASH)
    expect(() => validateGatewayConditionSpec(out)).not.toThrow()

    const stripped: ConditionSpec = {
      ...out,
      checks: out.checks.filter((c) => c.kind !== COMMITMENT_KIND),
    }
    const errs = issuesOf(() => validateGatewayConditionSpec(stripped))
    expect(errs[0]?.path).toBe('$.checks')
    expect(errs[0]?.message).toContain('cannot be removed')
  })

  it('changes the conditionHash — the commitment is part of what is engaged', () => {
    const withCommitment = injectCommitmentCheck(client, ACTION_HASH)
    expect(conditionHash(withCommitment)).not.toBe(conditionHash(client))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Normalization — docs/07 § 4
// ─────────────────────────────────────────────────────────────────────────────

describe('normalize — docs/07 § 4', () => {
  it('rule 2: lowercases addresses, dropping the EIP-55 checksum', () => {
    const checksummed = spec([
      {
        kind: 'erc20_allowance',
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        owner: TREASURY.toUpperCase().replace('0X', '0x'),
        spender: SPENDER,
        op: 'eq',
        value: '0',
      },
    ])
    const lower = spec([VALID_CHECKS['erc20_allowance']])
    expect(conditionHash(checksummed)).toBe(conditionHash(lower))
    expect(canonicalConditionSpec(checksummed)).not.toMatch(/0x[0-9a-f]*[A-F]/)
  })

  it('rule 2 applies to hex payloads too', () => {
    const upper = spec([
      { ...VALID_CHECKS['event_emitted'], topic0: TOPIC_APPROVAL.toUpperCase().replace('0X', '0x') },
    ])
    expect(conditionHash(upper)).toBe(conditionHash(spec([VALID_CHECKS['event_emitted']])))
  })

  it('rule 3: never loses precision on values beyond MAX_SAFE_INTEGER', () => {
    const big = '9007199254740993' // 2^53 + 1, not representable as a double
    const out = normalizeConditionSpec(spec([{ ...VALID_CHECKS['erc20_balance'], value: big }]))
    expect((out.checks[0] as { value: string }).value).toBe(big)
    expect(canonicalConditionSpec(spec([{ ...VALID_CHECKS['erc20_balance'], value: big }]))).toContain(
      `"value":"${big}"`,
    )
    // The danger, demonstrated: the same round trip through a number lies.
    expect(String(Number(big))).toBe('9007199254740992')
  })

  it('rule 3: carries uint256 and int256 extremes verbatim', () => {
    for (const [kind, value] of [
      ['erc20_balance', UINT256_MAX],
      ['erc20_balance_delta', INT256_MIN],
      ['erc20_balance_delta', INT256_MAX],
    ] as const) {
      const out = normalizeConditionSpec(spec([{ ...VALID_CHECKS[kind], value }]))
      expect((out.checks[0] as { value: string }).value).toBe(value)
    }
  })

  it('rule 3: coerces bigint and safe number amounts to decimal strings', () => {
    const fromBigint = normalizeConditionSpec(
      spec([{ ...VALID_CHECKS['erc20_balance'], value: 10n ** 30n }]),
    )
    expect((fromBigint.checks[0] as { value: string }).value).toBe(
      '1000000000000000000000000000000',
    )

    const fromNumber = normalizeConditionSpec(
      spec([{ ...VALID_CHECKS['erc20_balance'], value: 1000000 }]),
    )
    expect((fromNumber.checks[0] as { value: string }).value).toBe('1000000')
  })

  it('rule 3: refuses an unsafe or fractional number rather than rounding it', () => {
    expect(() =>
      normalizeConditionSpec(spec([{ ...VALID_CHECKS['erc20_balance'], value: 1e18 }])),
    ).toThrow(NormalizationError)
    expect(() =>
      normalizeConditionSpec(spec([{ ...VALID_CHECKS['erc20_balance'], value: 1.5 }])),
    ).toThrow(/not a safe JavaScript integer/)
  })

  it('rule 3: collapses equivalent decimal spellings', () => {
    const canonical = canonicalConditionSpec(spec([VALID_CHECKS['erc20_allowance']]))
    for (const value of ['0', '00', '0000', '+0', '-0']) {
      expect(
        canonicalConditionSpec(spec([{ ...VALID_CHECKS['erc20_allowance'], value }])),
      ).toBe(canonical)
    }
  })

  it('rule 4: injects version, evaluateAt, confirmations and minCount', () => {
    const bare = {
      chainId: 1,
      checks: [{ kind: 'event_emitted', address: USDT, topic0: TOPIC_APPROVAL }],
    }
    const out = normalizeConditionSpec(bare)
    expect(out.version).toBe(1)
    expect(out.evaluateAt).toBe('tx')
    expect(out.confirmations).toBe(12)
    expect((out.checks[0] as { minCount: number }).minCount).toBe(1)
    expect(conditionHash(bare)).toBe(conditionHash(spec([VALID_CHECKS['event_emitted']])))
  })

  it('rule 4: the confirmations default follows the chain family', () => {
    expect(defaultConfirmations(1)).toBe(12)
    expect(defaultConfirmations(8453)).toBe(3)
    expect(defaultConfirmations(84532)).toBe(3)
    expect(
      normalizeConditionSpec({ chainId: 8453, checks: [VALID_CHECKS['nonce_advanced']] })
        .confirmations,
    ).toBe(3)
  })

  it('drops fields that are not part of the DSL, so nothing unexpected is hashed', () => {
    const withNoise = spec([{ ...VALID_CHECKS['nonce_advanced'], memo: 'ignore me' }], {
      clientRef: 'abc',
    })
    expect(conditionHash(withNoise)).toBe(conditionHash(spec([VALID_CHECKS['nonce_advanced']])))
  })

  it('is insensitive to key insertion order', () => {
    const a = {
      checks: [{ value: '1', op: 'eq', account: AGENT, kind: 'nonce_advanced' }],
      confirmations: 12,
      evaluateAt: 'tx',
      chainId: 1,
      version: 1,
    }
    expect(conditionHash(a)).toBe(conditionHash(spec([VALID_CHECKS['nonce_advanced']])))
  })

  it('preserves the declared order of checks and of the token watchlist', () => {
    const ab = spec([VALID_CHECKS['erc20_allowance'], VALID_CHECKS['nonce_advanced']])
    const ba = spec([VALID_CHECKS['nonce_advanced'], VALID_CHECKS['erc20_allowance']])
    expect(conditionHash(ab)).not.toBe(conditionHash(ba))

    const t1 = spec([{ ...VALID_CHECKS['no_new_approvals'], tokens: [USDT, USDC] }])
    const t2 = spec([{ ...VALID_CHECKS['no_new_approvals'], tokens: [USDC, USDT] }])
    expect(conditionHash(t1)).not.toBe(conditionHash(t2))
  })

  it('reports the path of the offending field', () => {
    try {
      normalizeConditionSpec(spec([VALID_CHECKS['nonce_advanced'], { ...VALID_CHECKS['erc20_balance'], token: 'nope' }]))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(NormalizationError)
      expect((err as NormalizationError).path).toBe('$.checks[1].token')
    }
  })

  it('refuses an unknown kind at hashing time as well', () => {
    expect(() => conditionHash(spec([{ kind: 'oracle_says_ok' }]))).toThrow(
      /unknown check kind/,
    )
  })

  it('dispatches ConditionSpec and ActionSpec through the generic entry point', () => {
    const cond = normalize(spec([VALID_CHECKS['nonce_advanced']]))
    expect('checks' in cond).toBe(true)

    const act = normalize({
      version: 1,
      chainId: 1,
      target: USDC,
      value: '0',
      calldata: '0xa9059cbb',
      registryRef: REGISTRY_REF,
    })
    expect('calldata' in act).toBe(true)

    expect(() => normalize({ version: 1 })).toThrow(/ambiguous spec/)
    expect(() => normalize(null)).toThrow(NormalizationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ActionSpec
// ─────────────────────────────────────────────────────────────────────────────

describe('actionSpec', () => {
  const action = {
    version: 1,
    chainId: 1,
    target: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    value: '0',
    calldata: '0xA9059CBB',
    registryRef: REGISTRY_REF.toUpperCase().replace('0X', '0x'),
  }

  it('lowercases target, calldata and registryRef', () => {
    const out = normalizeActionSpec(action)
    expect(out.target).toBe(USDC)
    expect(out.calldata).toBe('0xa9059cbb')
    expect(out.registryRef).toBe(REGISTRY_REF)
  })

  it('injects the default native value and calldata', () => {
    const out = normalizeActionSpec({
      version: 1,
      chainId: 1,
      target: USDC,
      registryRef: REGISTRY_REF,
    })
    expect(out.value).toBe('0')
    expect(out.calldata).toBe('0x')
  })

  it('keeps a max-uint256 native value exact', () => {
    const out = normalizeActionSpec({ ...action, value: UINT256_MAX })
    expect(out.value).toBe(UINT256_MAX)
    expect(canonicalize(out)).toContain(`"value":"${UINT256_MAX}"`)
  })

  it('hashes as keccak256(utf8(canonicalize(normalize(spec))))', () => {
    const canonical = canonicalize(normalizeActionSpec(action))
    expect(actionHash(action)).toBe(keccak256(stringToBytes(canonical)))
    expect(actionHash(action)).toBe(hashCanonical(canonical))
  })

  it('includes registryRef, which makes the classification replayable', () => {
    const other = { ...action, registryRef: `0x${'1'.repeat(64)}` }
    expect(actionHash(other)).not.toBe(actionHash(action))
  })

  it('validates shape and names the offending field', () => {
    expect(() => validateActionSpec(action)).not.toThrow()
    expect(paths(() => validateActionSpec({ ...action, target: '0xbad' }))).toContain('$.target')
    expect(paths(() => validateActionSpec({ ...action, value: 0 }))).toContain('$.value')
    expect(paths(() => validateActionSpec({ ...action, value: '-1' }))).toContain('$.value')
    expect(paths(() => validateActionSpec({ ...action, calldata: '0xabc' }))).toContain('$.calldata')
    expect(paths(() => validateActionSpec({ ...action, registryRef: '0x00' }))).toContain(
      '$.registryRef',
    )
    expect(paths(() => validateActionSpec({ ...action, version: 2 }))).toContain('$.version')
    expect(paths(() => validateActionSpec({ ...action, extra: 1 }))).toContain('$.extra')
    expect(paths(() => validateActionSpec('nope'))).toEqual(['$'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The invariant that matters: client and server must hash the same
// ─────────────────────────────────────────────────────────────────────────────

describe('conditionHash — the cross-implementation invariant', () => {
  const reference = spec([
    VALID_CHECKS['erc20_allowance'],
    VALID_CHECKS['no_new_approvals'],
    VALID_CHECKS['erc20_balance_delta'],
    VALID_CHECKS['calldata_matches_commitment'],
  ])

  it('is exactly keccak256(utf8(canonicalize(normalize(spec))))', () => {
    const canonical = canonicalConditionSpec(reference)
    expect(conditionHash(reference)).toBe(keccak256(stringToBytes(canonical)))
  })

  it('is stable across repeated calls and across deep copies', () => {
    const h = conditionHash(reference)
    expect(conditionHash(reference)).toBe(h)
    expect(conditionHash(JSON.parse(JSON.stringify(reference)))).toBe(h)
    expect(conditionHash(normalizeConditionSpec(reference))).toBe(h)
  })

  it('is normalization-idempotent: normalizing twice changes nothing', () => {
    const once = normalizeConditionSpec(reference)
    const twice = normalizeConditionSpec(once)
    expect(twice).toEqual(once)
    expect(canonicalize(twice)).toBe(canonicalize(once))
  })

  it('changes when any engaged field changes', () => {
    const base = conditionHash(reference)
    const mutations: Array<Record<string, unknown>> = [
      { chainId: 8453 },
      { evaluateAt: 'tx+1' },
      { evaluateAt: { block: 1 } },
      { confirmations: 3 },
      { checks: reference.checks.slice(0, 3) },
    ]
    for (const m of mutations) {
      expect(conditionHash({ ...reference, ...m })).not.toBe(base)
    }
  })

  it('produces a 32-byte lowercase hex hash', () => {
    expect(conditionHash(reference)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('emits a canonical form with sorted keys and no whitespace', () => {
    const canonical = canonicalConditionSpec(reference)
    expect(canonical.startsWith('{"chainId":')).toBe(true)
    expect(canonical.endsWith('"version":1}')).toBe(true)
    expect(canonical).not.toMatch(/\s/)
  })
})
