/**
 * Tests of the pricer and of post-condition generation.
 *
 * `bond = clamp(minBond, riskBps × notionalUSD, maxBond)`, in `bigint`, over USDC
 * atomic units. The first test replays the project's thesis on the pricing side:
 * a declared category does not buy a rate.
 */

import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import { classify } from './classifier.js'
import {
  DEFAULT_MIN_HEALTH_FACTOR,
  PolicyError,
  buildConditionSpec,
} from './policy.js'
import { validateConditionSpec } from './dsl.js'
import { loadRegistry, mainnetRegistryRef } from './registry.js'
import { RiskError, bondFor, clamp, priceRisk } from './risk.js'
import {
  MAX_CHECKS,
  type ActionSpec,
  type Address,
  type Check,
  type Classification,
  type Hex,
  type Policy,
} from './types.js'

const REGISTRY = loadRegistry()
const REF = mainnetRegistryRef()

const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as Address
const TREASURY = '0x1111111111111111111111111111111111111111' as Address
const PAYROLL = '0x2222222222222222222222222222222222222222' as Address
const EXECUTOR = '0x3333333333333333333333333333333333333333' as Address
const ATTACKER = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as Address
const SHITCOIN = '0x9999999999999999999999999999999999999999' as Address

const POLICY: Policy = {
  beneficiary: TREASURY,
  treasury: TREASURY,
  minBond: '5000000', //     5 USDC
  maxBond: '500000000', // 500 USDC
  duration: 3600,
  categories: {
    'erc20.transfer': {
      riskBps: 200,
      allowedDest: [PAYROLL],
      maxOutflow: '250000000',
    },
    'erc20.approve': { riskBps: 5, allowedDest: [PAYROLL], maxOutflow: '0' },
    'aavev3.repay': { riskBps: 25 },
    'aavev3.supply': { riskBps: 25 },
    'aavev3.withdraw': { riskBps: 50, allowedDest: [TREASURY] },
    'aavev3.borrow': { riskBps: 100, allowedDest: [TREASURY] },
  },
}

function transferCalldata(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        inputs: [{ type: 'address' }, { type: 'uint256' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    args: [to, amount],
  })
}

function approveCalldata(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'approve',
        inputs: [{ type: 'address' }, { type: 'uint256' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    args: [spender, amount],
  })
}

function aaveCalldata(
  name: 'supply' | 'withdraw' | 'borrow' | 'repay',
  args: readonly unknown[],
): Hex {
  const inputs = {
    supply: ['address', 'uint256', 'address', 'uint16'],
    withdraw: ['address', 'uint256', 'address'],
    borrow: ['address', 'uint256', 'uint256', 'uint16', 'address'],
    repay: ['address', 'uint256', 'uint256', 'address'],
  }[name]
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name,
        inputs: inputs.map((type) => ({ type })),
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    args: args as never,
  })
}

function action(over: Partial<ActionSpec> = {}): ActionSpec {
  return {
    version: 1,
    chainId: 1,
    target: USDC_ETH,
    value: '0',
    calldata: transferCalldata(PAYROLL, 100_000_000n),
    registryRef: REF,
    ...over,
  }
}

/** Hand-crafted classification, to test the pricer in isolation. */
function fake(
  category: Classification['category'],
  notionalUSD: string,
  params: Record<string, string> = {},
): Classification {
  return {
    category,
    notionalUSD,
    registryRef: REF,
    params: {
      chainId: '1',
      // `target` is always present in a real `unknown` classification
      // (classifier.ts): it is the contract being called, and the fallback
      // post-condition uses it as minimal surveillance.
      target: USDC_ETH,
      token: USDC_ETH,
      to: PAYROLL,
      amount: '1000000',
      ...params,
    },
  }
}

function kinds(checks: Check[]): string[] {
  return checks.map((c) => c.kind)
}

function find<K extends Check['kind']>(
  checks: Check[],
  kind: K,
): Extract<Check, { kind: K }>[] {
  return checks.filter((c) => c.kind === kind) as Extract<Check, { kind: K }>[]
}

// ─────────────────────────────────────────────────────────────────────────────
// THE test, on the pricing side
// ─────────────────────────────────────────────────────────────────────────────

describe('a declared category does not buy a rate', () => {
  it("declaring 'allowance_revoke' while executing a transfer yields the bond AND the post-condition of the transfer", () => {
    const request = {
      ...action({ calldata: transferCalldata(ATTACKER, 10_000_000_000n) }),
      category: 'allowance_revoke', // what the agent claims
      riskBps: 5, // the rate it hopes for
      bond: '5000000',
    } as unknown as ActionSpec

    const quote = priceRisk(classify(request, REGISTRY), POLICY)

    // The transfer's rate: 200 bps × $10,000 = $200 — not the $5 asked for.
    expect(quote.category).toBe('erc20.transfer')
    expect(quote.riskBps).toBe(200)
    expect(quote.notionalUSD).toBe('10000000000')
    expect(quote.bond).toBe('200000000')

    // The transfer post-condition, destination taken from the allowlist.
    expect(kinds(quote.conditionSpec.checks)).toEqual([
      'erc20_balance_delta',
      'erc20_balance_delta',
      'no_new_approvals',
    ])
    expect(
      find(quote.conditionSpec.checks, 'erc20_balance_delta')[1]!.account,
    ).toBe(PAYROLL)
    // And above all: nothing from the allowance-revocation policy.
    expect(kinds(quote.conditionSpec.checks)).not.toContain('erc20_allowance')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// clamp
// ─────────────────────────────────────────────────────────────────────────────

describe('bond = clamp(minBond, riskBps × notionalUSD, maxBond)', () => {
  it('intermediate value: the raw product', () => {
    // 200 bps × $1,000 = $20, between $5 and $500.
    const q = priceRisk(fake('erc20.transfer', '1000000000'), POLICY)
    expect(q.bond).toBe('20000000')
    expect(q.rationale).toContain('200 bps')
  })

  it('lower bound: the minBond floor applies', () => {
    // 200 bps × $1 = $0.02 → $5 floor.
    const q = priceRisk(fake('erc20.transfer', '1000000'), POLICY)
    expect(q.bond).toBe(POLICY.minBond)
    expect(q.rationale).toContain('minBond floor')
  })

  it('upper bound: the maxBond ceiling applies', () => {
    // 200 bps × $1,000,000 = $20,000 → $500 ceiling.
    const q = priceRisk(fake('erc20.transfer', '1000000000000'), POLICY)
    expect(q.bond).toBe(POLICY.maxBond)
    expect(q.rationale).toContain('maxBond ceiling')
  })

  it('zero notional: the floor, never zero', () => {
    expect(priceRisk(fake('erc20.transfer', '0'), POLICY).bond).toBe(
      POLICY.minBond,
    )
  })

  it('exactly on the bounds', () => {
    // 200 bps × $250 = $5 = minBond.
    expect(bondFor(fake('erc20.transfer', '250000000'), POLICY)).toBe(5_000_000n)
    // 200 bps × $25,000 = $500 = maxBond.
    expect(bondFor(fake('erc20.transfer', '25000000000'), POLICY)).toBe(
      500_000_000n,
    )
  })

  it('clamp is a clamp', () => {
    expect(clamp(5n, 1n, 10n)).toBe(5n)
    expect(clamp(5n, 7n, 10n)).toBe(7n)
    expect(clamp(5n, 99n, 10n)).toBe(10n)
  })

  it('minBond > maxBond is an error, not a silence', () => {
    const broken: Policy = { ...POLICY, minBond: '10', maxBond: '1' }
    expect(() => priceRisk(fake('erc20.transfer', '0'), broken)).toThrowError(
      RiskError,
    )
  })

  it('an invalid riskBps is an error', () => {
    const broken: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': { riskBps: -1, maxOutflow: '1' },
      },
    }
    expect(() => priceRisk(fake('erc20.transfer', '1000'), broken)).toThrowError(
      RiskError,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integer arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('arithmetic in bigint, never in floating point', () => {
  it('a notional beyond Number.MAX_SAFE_INTEGER stays exact', () => {
    const huge = (2n ** 200n).toString(10)
    const q = priceRisk(fake('erc20.transfer', huge), POLICY)
    expect(q.notionalUSD).toBe(huge)
    expect(q.bond).toBe(POLICY.maxBond)
    expect(q.bond).not.toContain('e')
  })

  it('the bond is always an integer decimal string', () => {
    for (const notional of ['1', '333333333', '1000000007']) {
      const bond = priceRisk(fake('erc20.transfer', notional), POLICY).bond
      expect(bond).toMatch(/^[0-9]+$/)
    }
  })

  it('the bps division truncates downwards, deterministically', () => {
    // 5 bps × $1.999999 = $0.00099… → 999 atomic units before the clamp.
    const policy: Policy = { ...POLICY, minBond: '0' }
    expect(bondFor(fake('erc20.approve', '1999999'), policy)).toBe(999n)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The pricer's fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown costs the maximum', () => {
  it('unknown category → maxBond, whatever the notional', () => {
    for (const notional of ['0', '1', '999999999999']) {
      const q = priceRisk(fake('unknown', notional), POLICY)
      expect(q.bond).toBe(POLICY.maxBond)
      expect(q.rationale).toContain('unknown')
    }
  })

  it('a tuple absent from the registry is charged maxBond end to end', () => {
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    expect(c.category).toBe('unknown')
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('a category known to the registry but absent from the policy → maxBond, not minBond', () => {
    const partial: Policy = {
      ...POLICY,
      categories: { 'erc20.transfer': POLICY.categories['erc20.transfer']! },
    }
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(c.category).toBe('aavev3.repay')
    expect(() => priceRisk(c, partial)).toThrowError(PolicyError)
    expect(bondFor(c, partial)).toBe(BigInt(POLICY.maxBond))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Generated post-conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('the policy generates the post-condition', () => {
  it('erc20.transfer: the three normative checks of docs/13 § 5, plus the destination delta', () => {
    const c = classify(action(), REGISTRY)
    const spec = buildConditionSpec(c, POLICY)

    expect(spec.version).toBe(1)
    expect(spec.chainId).toBe(1)
    expect(spec.evaluateAt).toBe('tx')
    expect(spec.confirmations).toBe(12) // L1

    const [bound] = find(spec.checks, 'erc20_balance_delta')
    expect(bound).toMatchObject({
      token: USDC_ETH,
      account: TREASURY,
      op: 'gte',
      value: '-250000000', // the POLICY's bound, not the calldata amount
    })

    // The amount lands on the allowlist destination — as a delta, derived from
    // the `Transfer` logs, never as an absolute balance (see B1 further down).
    expect(find(spec.checks, 'erc20_balance_delta')[1]).toMatchObject({
      token: USDC_ETH,
      account: PAYROLL,
      op: 'gte',
      value: '100000000',
    })

    expect(find(spec.checks, 'no_new_approvals')[0]).toMatchObject({
      owner: TREASURY,
      tokens: [USDC_ETH],
    })
  })

  it('the outflow bound cannot be inflated by the calldata', () => {
    const small = buildConditionSpec(
      classify(action({ calldata: transferCalldata(PAYROLL, 1n) }), REGISTRY),
      POLICY,
    )
    const large = buildConditionSpec(
      classify(
        action({ calldata: transferCalldata(PAYROLL, 10n ** 12n) }),
        REGISTRY,
      ),
      POLICY,
    )
    const boundOf = (s: typeof small) =>
      find(s.checks, 'erc20_balance_delta')[0]!.value
    expect(boundOf(small)).toBe('-250000000')
    expect(boundOf(large)).toBe('-250000000')
  })

  it("a destination outside the allowlist is replaced by the policy's own", () => {
    const c = classify(
      action({ calldata: transferCalldata(ATTACKER, 1_000_000n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY)
    const accounts = spec.checks.map((chk) => (chk as { account?: string }).account)
    expect(accounts).toContain(PAYROLL)
    expect(accounts).not.toContain(ATTACKER)
  })

  it('a listed destination is committed to as is', () => {
    const OTHER = '0x4444444444444444444444444444444444444444' as Address
    const policy: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': {
          riskBps: 200,
          allowedDest: [PAYROLL, OTHER],
          maxOutflow: '250000000',
        },
      },
    }
    const c = classify(
      action({ calldata: transferCalldata(OTHER, 1_000_000n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, policy)
    expect(find(spec.checks, 'erc20_balance_delta')[1]!.account).toBe(OTHER)
  })

  it("maxOutflow '0' commits to `0` and not `-0`, which is not a canonical decimal", () => {
    // "No outflow tolerated" is the strictest policy, and it is the Gateway's
    // default. `-0` used to fail the validation of the ConditionSpec we had just
    // built: every quotation of a classified erc20.transfer answered 400.
    // RFC 8785 mandates the same serialization for `0` and `-0` anyway, so `-0`
    // would not have survived hashing either.
    const strict: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': { riskBps: 200, allowedDest: [PAYROLL], maxOutflow: '0' },
      },
    }
    const spec = buildConditionSpec(classify(action(), REGISTRY), strict)
    const delta = find(spec.checks, 'erc20_balance_delta')[0]!
    expect(delta.value).toBe('0')
    expect(delta.value).not.toBe('-0')
    // And the spec produced validates itself.
    expect(() => validateConditionSpec(spec)).not.toThrow()
  })

  it('erc20.transfer without maxOutflow is refused: the bound must come from the policy', () => {
    const boundless: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': { riskBps: 200, allowedDest: [PAYROLL] },
      },
    }
    expect(() =>
      buildConditionSpec(classify(action(), REGISTRY), boundless),
    ).toThrowError(PolicyError)
  })

  it('erc20.approve: allowance cap, and zero for a spender outside the allowlist', () => {
    const unlisted = classify(
      action({ calldata: approveCalldata(ATTACKER, 10n ** 30n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(unlisted, POLICY)
    expect(find(spec.checks, 'erc20_allowance')[0]).toMatchObject({
      token: USDC_ETH,
      owner: TREASURY,
      spender: ATTACKER,
      op: 'lte',
      value: '0',
    })
    // An approval does not move funds.
    expect(find(spec.checks, 'erc20_balance_delta')[0]).toMatchObject({
      account: TREASURY,
      op: 'gte',
      value: '0',
    })

    const listed = classify(
      action({ calldata: approveCalldata(PAYROLL, 1_000_000n) }),
      REGISTRY,
    )
    const policy: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.approve': {
          riskBps: 5,
          allowedDest: [PAYROLL],
          maxOutflow: '2000000',
        },
      },
    }
    expect(
      find(buildConditionSpec(listed, policy).checks, 'erc20_allowance')[0]!
        .value,
    ).toBe('2000000')
  })

  it('aavev3.*: health factor, and no nonce_advanced by default', () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY, { executor: EXECUTOR })
    expect(kinds(spec.checks)).toEqual(['aave_health_factor'])
    expect(find(spec.checks, 'aave_health_factor')[0]).toMatchObject({
      pool: AAVE_POOL,
      user: TREASURY,
      op: 'gte',
      value: DEFAULT_MIN_HEALTH_FACTOR,
    })
  })

  it('aavev3.*: the health factor threshold can be tightened by the policy', () => {
    const policy: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'aavev3.borrow': {
          riskBps: 100,
          allowedDest: [TREASURY],
          // Policy extension, read defensively.
          minHealthFactor: '2000000000000000000',
        } as Policy['categories'][string],
      },
    }
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('borrow', [
          USDC_ETH,
          1_000_000n,
          2n,
          0,
          TREASURY,
        ]),
      }),
      REGISTRY,
    )
    expect(
      find(buildConditionSpec(c, policy).checks, 'aave_health_factor')[0]!
        .value,
    ).toBe('2000000000000000000')
  })

  it('aavev3.withdraw: the withdrawal destination also comes from the allowlist', () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('withdraw', [USDC_ETH, 5_000_000n, ATTACKER]),
      }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY)
    const delta = find(spec.checks, 'erc20_balance_delta')[0]!
    expect(delta.account).toBe(TREASURY)
    expect(delta.value).toBe('5000000')
    expect(JSON.stringify(spec)).not.toContain(ATTACKER.slice(2))
  })

  it('unknown: generic post-condition, strict, and decidable on the receipt alone', () => {
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    const spec = buildConditionSpec(c, POLICY, { executor: EXECUTOR })

    // The target of the unclassified action is watched unconditionally: it is the
    // only known fact about an `unknown` action.
    expect(kinds(spec.checks)).toEqual([
      'no_new_approvals',
      'erc20_balance_delta',
    ])
    expect(find(spec.checks, 'no_new_approvals')[0]).toMatchObject({
      owner: TREASURY,
      tokens: [SHITCOIN],
    })
    expect(find(spec.checks, 'erc20_balance_delta')[0]).toMatchObject({
      token: SHITCOIN,
      account: TREASURY,
      op: 'gte',
      value: '0', // no outflow tolerance on an action we cannot classify
    })

    // The policy's watched tokens are added to the target.
    const watching = {
      ...POLICY,
      watchedTokens: [USDC_ETH],
    } as Policy
    const large = buildConditionSpec(c, watching, { executor: EXECUTOR })
    expect(find(large.checks, 'no_new_approvals')[0]!.tokens).toEqual([
      SHITCOIN,
      USDC_ETH,
    ])
    expect(
      find(large.checks, 'erc20_balance_delta').map((d) => d.token),
    ).toEqual([SHITCOIN, USDC_ETH])
  })

  it('MAX_CHECKS is respected, and calldata_matches_commitment is out of quota', () => {
    const actionHash =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hex
    const cases: Classification[] = [
      classify(action(), REGISTRY),
      classify(
        action({ calldata: approveCalldata(PAYROLL, 1n) }),
        REGISTRY,
      ),
      classify(
        action({
          target: AAVE_POOL,
          calldata: aaveCalldata('withdraw', [USDC_ETH, 1n, TREASURY]),
        }),
        REGISTRY,
      ),
      classify(action({ target: SHITCOIN }), REGISTRY),
    ]
    for (const c of cases) {
      const bare = buildConditionSpec(c, POLICY)
      expect(bare.checks.length).toBeLessThanOrEqual(MAX_CHECKS)
      expect(bare.checks.length).toBeGreaterThan(0)

      const committed = buildConditionSpec(c, POLICY, { actionHash })
      expect(committed.checks.length).toBe(bare.checks.length + 1)
      expect(committed.checks.at(-1)).toEqual({
        kind: 'calldata_matches_commitment',
        actionHash,
      })
    }
  })

  it('default confirmations: 12 on L1, 3 on L2', () => {
    const l1 = buildConditionSpec(classify(action(), REGISTRY), POLICY)
    expect(l1.confirmations).toBe(12)

    const l2 = buildConditionSpec(
      classify(action({ chainId: 8453, target: USDC_BASE }), REGISTRY),
      POLICY,
    )
    expect(l2.chainId).toBe(8453)
    expect(l2.confirmations).toBe(3)

    const forced = buildConditionSpec(classify(action(), REGISTRY), POLICY, {
      confirmations: 1,
      evaluateAt: 'tx+1',
    })
    expect(forced.confirmations).toBe(1)
    expect(forced.evaluateAt).toBe('tx+1')
  })

  it('a classification with no usable chainId is refused', () => {
    const orphan: Classification = {
      category: 'erc20.transfer',
      params: { token: USDC_ETH, to: PAYROLL, amount: '1' },
      notionalUSD: '1',
      registryRef: REF,
    }
    expect(() => buildConditionSpec(orphan, POLICY)).toThrowError(PolicyError)
    expect(() =>
      buildConditionSpec(orphan, POLICY, { chainId: 1 }),
    ).not.toThrow()
  })

  it('the quote is reproducible', () => {
    const c = classify(action(), REGISTRY)
    expect(JSON.stringify(priceRisk(c, POLICY))).toBe(
      JSON.stringify(priceRisk(c, POLICY)),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A hole in the policy is a refusal to open, never a permissive post-condition.
// The "policy without allowedDest" branch is the one the production binary took:
// no test covered it.
// ─────────────────────────────────────────────────────────────────────────────

/** The reference policy, stripped of `allowedDest` on one category. */
function withoutAllowlist(category: string, extra: object = {}): Policy {
  const cat = { ...POLICY.categories[category], ...extra } as Record<
    string,
    unknown
  >
  delete cat['allowedDest']
  return {
    ...POLICY,
    categories: {
      ...POLICY.categories,
      [category]: cat as Policy['categories'][string],
    },
  }
}

describe('a missing allowedDest is a refusal, not a silence', () => {
  it('erc20.transfer without allowedDest is refused — the diverted transfer used to pass the three remaining checks', () => {
    // Adversary 1 of docs/13 § 6: 500 USDC to an arbitrary address, under
    // maxOutflow = 1000 USDC. With no allowlist, both destination checks
    // *silently* disappeared; all that was left was "the treasury did not lose
    // more than maxOutflow" and `no_new_approvals`, both of which this transfer
    // passes. Verdict `honored`, bond returned, reputation improved, funds gone.
    const policy = withoutAllowlist('erc20.transfer', {
      maxOutflow: '1000000000',
    })
    const diverted = classify(
      action({ calldata: transferCalldata(ATTACKER, 500_000_000n) }),
      REGISTRY,
    )
    expect(() => buildConditionSpec(diverted, policy)).toThrowError(
      PolicyError,
    )
    expect(() => buildConditionSpec(diverted, policy)).toThrowError(
      /allowedDest/,
    )
    // And the refusal reaches all the way up to the quote: no warrant can be
    // opened at all.
    expect(() => priceRisk(diverted, policy)).toThrowError(PolicyError)
  })

  it('an empty allowlist is worth an absent one', () => {
    const empty: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': {
          riskBps: 200,
          allowedDest: [],
          maxOutflow: '250000000',
        },
      },
    }
    expect(() =>
      buildConditionSpec(classify(action(), REGISTRY), empty),
    ).toThrowError(PolicyError)
  })

  it('erc20.approve without allowedDest is refused — otherwise every spender is allowlisted', () => {
    // `!cat.allowedDest` made `allowlisted` true for anyone: the attacker
    // inherited the policy's allowance cap instead of zero.
    const policy = withoutAllowlist('erc20.approve', { maxOutflow: '1000000' })
    const c = classify(
      action({ calldata: approveCalldata(ATTACKER, 10n ** 30n) }),
      REGISTRY,
    )
    expect(() => buildConditionSpec(c, policy)).toThrowError(PolicyError)

    // With an allowlist, the unlisted spender is indeed capped at zero.
    expect(
      find(buildConditionSpec(c, POLICY).checks, 'erc20_allowance')[0]!.value,
    ).toBe('0')
  })

  for (const [name, calldata] of [
    ['aavev3.withdraw', aaveCalldata('withdraw', [USDC_ETH, 5_000_000n, ATTACKER])],
    ['aavev3.borrow', aaveCalldata('borrow', [USDC_ETH, 5_000_000n, 2n, 0, ATTACKER])],
  ] as const) {
    it(`${name} without allowedDest is refused: a withdrawal is an outflow`, () => {
      const policy = withoutAllowlist(name)
      const c = classify(action({ target: AAVE_POOL, calldata }), REGISTRY)
      expect(c.category).toBe(name)
      expect(() => buildConditionSpec(c, policy)).toThrowError(PolicyError)
    })
  }

  it('aavev3.repay and supply move nothing out: they require no allowlist', () => {
    for (const [name, calldata] of [
      ['aavev3.repay', aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY])],
      ['aavev3.supply', aaveCalldata('supply', [USDC_ETH, 1_000_000n, TREASURY, 0])],
    ] as const) {
      const c = classify(action({ target: AAVE_POOL, calldata }), REGISTRY)
      expect(c.category).toBe(name)
      // POLICY declares no allowedDest for these two categories.
      expect(() => buildConditionSpec(c, POLICY)).not.toThrow()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A check that always throws is not a guarantee, it is an automatic refund in
// disguise.
// ─────────────────────────────────────────────────────────────────────────────

/** Every category, with a real classification for each. */
function allClassifications(): Classification[] {
  return [
    classify(action(), REGISTRY),
    classify(action({ calldata: approveCalldata(PAYROLL, 1n) }), REGISTRY),
    ...(
      [
        aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
        aaveCalldata('supply', [USDC_ETH, 1_000_000n, TREASURY, 0]),
        aaveCalldata('withdraw', [USDC_ETH, 1_000_000n, TREASURY]),
        aaveCalldata('borrow', [USDC_ETH, 1_000_000n, 2n, 0, TREASURY]),
      ] as const
    ).map((calldata) => classify(action({ target: AAVE_POOL, calldata }), REGISTRY)),
    classify(action({ target: SHITCOIN }), REGISTRY),
  ]
}

describe('a default post-condition contains only decidable checks', () => {
  it('no category commits to nonce_advanced or native_balance_delta by default', () => {
    // `nonce_advanced`: under sponsoring, `tx.from` is the KeeperHub relayer and
    // `checks/nonce.ts` throws `UnsupportedCheckError` (its docstring says so:
    // "must not appear in default post-conditions").
    // `native_balance_delta`: `checks/native.ts` refuses to guess without a
    // tracer, and no tracer is wired up.
    // Both let the warrant expire into `reclaim`: `unknown`, charged at maxBond,
    // was the one category whose bond could never be slashed.
    for (const c of allClassifications()) {
      const seenKinds = kinds(
        buildConditionSpec(c, POLICY, { executor: EXECUTOR }).checks,
      )
      expect(seenKinds).not.toContain('nonce_advanced')
      expect(seenKinds).not.toContain('native_balance_delta')
      expect(seenKinds.length).toBeGreaterThan(0)
    }
  })

  it('unknown: every committed check is derived from the receipt', () => {
    const DECIDABLE = ['no_new_approvals', 'erc20_balance_delta']
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    const spec = buildConditionSpec(c, {
      ...POLICY,
      watchedTokens: [USDC_ETH],
    } as Policy)
    for (const kind of kinds(spec.checks)) {
      expect(DECIDABLE).toContain(kind)
    }
    // The maximum bond is now backed by something that can actually be slashed.
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('unknown with neither a target nor watchedTokens is refused rather than emptied', () => {
    const orphan: Classification = {
      category: 'unknown',
      params: { chainId: '1' },
      notionalUSD: '0',
      registryRef: REF,
    }
    expect(() => buildConditionSpec(orphan, POLICY)).toThrowError(PolicyError)
  })

  it('unknown: too many watched tokens is an explicit refusal, not an invalid spec', () => {
    const tooMany = {
      ...POLICY,
      watchedTokens: Array.from(
        { length: 8 },
        (_, i) => (`0x${String(i + 1).repeat(40)}` as Address),
      ),
    } as Policy
    expect(() =>
      buildConditionSpec(classify(action({ target: SHITCOIN }), REGISTRY), tooMany),
    ).toThrowError(/MAX_CHECKS|maximum/)
  })

  it('nonce_advanced only appears on an unsponsored policy, and never as `gte 1`', () => {
    // `count(evalBlock) − count(txBlock − 1) >= 1` is true as soon as the account
    // has submitted the evaluated transaction: a tautology, hence zero
    // constraint. The normative form of docs/07 § 2.8 is "exactly one
    // transaction".
    const unsponsored = { ...POLICY, unsponsoredExecution: true } as Policy
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, unsponsored, { executor: EXECUTOR })
    expect(find(spec.checks, 'nonce_advanced')[0]).toMatchObject({
      account: EXECUTOR,
      op: 'eq',
      value: '1',
    })
    // Absent a known executor, it is the treasury that is committed.
    expect(
      find(buildConditionSpec(c, unsponsored).checks, 'nonce_advanced')[0]!
        .account,
    ).toBe(TREASURY)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Commit only to what is attributable to the agent's transaction.
// ─────────────────────────────────────────────────────────────────────────────

describe('no shared absolute balance in a post-condition', () => {
  it('erc20.transfer no longer commits to erc20_balance(dest): the beneficiary could manufacture the slash', () => {
    // `balanceOf(dest)` is read at end of block. If `dest` — an allowlist
    // address, hence the capital owner's, or a hot wallet sweeping into cold
    // storage — spends after the action and in the same block, the balance falls
    // back below `amount` and the bond is slashed, while the twin delta proves in
    // that very verdict that the agent did what was committed.
    for (const c of [
      classify(action(), REGISTRY),
      classify(
        action({ calldata: transferCalldata(ATTACKER, 1_000_000n) }),
        REGISTRY,
      ),
    ]) {
      const spec = buildConditionSpec(c, POLICY)
      expect(kinds(spec.checks)).not.toContain('erc20_balance')
      // The delta, for its part, stays: it only passes if the funds arrived.
      expect(find(spec.checks, 'erc20_balance_delta')[1]).toMatchObject({
        account: PAYROLL,
        op: 'gte',
      })
    }
  })

  it('a self-transfer to the allowlisted treasury is not a slash', () => {
    // `dest === treasury`: the funds do not move, the delta cancels out in the
    // logs (`from === to`). Requiring `>= amount` slashed a legitimate transfer.
    const toSelf: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': {
          riskBps: 200,
          allowedDest: [TREASURY],
          maxOutflow: '250000000',
        },
      },
    }
    const c = classify(
      action({ calldata: transferCalldata(TREASURY, 100_000_000n) }),
      REGISTRY,
    )
    const deltas = find(buildConditionSpec(c, toSelf).checks, 'erc20_balance_delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[1]).toMatchObject({ account: TREASURY, op: 'gte', value: '0' })

    // And the diversion stays blocked: the committed destination remains the
    // treasury, whose delta would then be `-amount`, below the `0` bound.
    const diverted = classify(
      action({ calldata: transferCalldata(ATTACKER, 100_000_000n) }),
      REGISTRY,
    )
    expect(
      find(buildConditionSpec(diverted, toSelf).checks, 'erc20_balance_delta')[1],
    ).toMatchObject({ account: TREASURY, value: '0' })
  })

  it('aavev3.withdraw to the treasury does commit to `>= amount`: there, the funds come in', () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('withdraw', [USDC_ETH, 5_000_000n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(
      find(buildConditionSpec(c, POLICY).checks, 'erc20_balance_delta')[0],
    ).toMatchObject({ account: TREASURY, op: 'gte', value: '5000000' })
  })

  it('every post-condition produced validates against the DSL', () => {
    const policy = {
      ...POLICY,
      watchedTokens: [USDC_ETH],
      unsponsoredExecution: true,
    } as Policy
    for (const c of allClassifications()) {
      for (const p of [POLICY, policy]) {
        expect(() =>
          validateConditionSpec(buildConditionSpec(c, p, { executor: EXECUTOR })),
        ).not.toThrow()
      }
    }
  })
})
