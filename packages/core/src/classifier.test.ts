/**
 * Classifier tests.
 *
 * The first test in this file is the one that carries the project's thesis: an
 * agent does not choose its own risk category. Everything else verifies that the
 * fallback is never permissive.
 */

import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import { canonicalize } from './canonical.js'
import { hashCanonical } from './hash.js'
import { ClassificationError, classify } from './classifier.js'
import { buildConditionSpec } from './policy.js'
import {
  RegistryError,
  assertRegistryConsistent,
  canonicalizeRegistry,
  loadRegistry,
  mainnetRegistryRef,
  registryRefOf,
  type RegistryFile,
} from './registry.js'
import { priceRisk } from './risk.js'
import type { ActionSpec, Address, Hex, Policy } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = loadRegistry()
const REF = mainnetRegistryRef()

const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address
const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as Address
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as Address

const TREASURY = '0x1111111111111111111111111111111111111111' as Address
const PAYROLL = '0x2222222222222222222222222222222222222222' as Address
const ATTACKER = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as Address
/** Token unknown to the registry: same selector, different target. */
const SHITCOIN = '0x9999999999999999999999999999999999999999' as Address

const ERC20_ABI = [
  'function transfer(address,uint256)',
  'function approve(address,uint256)',
] as const

function transferCalldata(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { type: 'address', name: 'to' },
          { type: 'uint256', name: 'amount' },
        ],
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
        inputs: [
          { type: 'address', name: 'spender' },
          { type: 'uint256', name: 'amount' },
        ],
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

const POLICY: Policy = {
  beneficiary: TREASURY,
  treasury: TREASURY,
  minBond: '5000000', //   5 USDC
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

// ─────────────────────────────────────────────────────────────────────────────
// THE test
// ─────────────────────────────────────────────────────────────────────────────

describe('the category is derived from the calldata, never declared', () => {
  it("a request declaring 'allowance_revoke' with transfer calldata is classified erc20.transfer, priced at the transfer rate, and committed to the transfer post-condition", () => {
    // What the agent — compromised by prompt injection — claims to do, and what
    // it actually does. `ActionSpec` deliberately has no category field: the cast
    // shows that even if a stray field did arrive, it would have no path to the
    // decision.
    const liar = {
      ...action({ calldata: transferCalldata(ATTACKER, 100_000_000n) }),
      category: 'allowance_revoke',
      declaredNotionalUSD: '0',
      riskBps: 5,
      bond: '5000000',
    } as unknown as ActionSpec

    const classification = classify(liar, REGISTRY)

    // 1. The category comes from the (chainId, target, selector) tuple.
    expect(classification.category).toBe('erc20.transfer')

    // 2. The notional comes from the decoded arguments: 100 USDC.
    expect(classification.notionalUSD).toBe('100000000')

    // 3. The bond is the transfer's (200 bps × $100 = $2, raised to the $5
    //    floor), not the "cheap" $5 it hoped to get from an allowance
    //    revocation — and certainly not a rate of its own choosing.
    const quote = priceRisk(classification, POLICY)
    expect(quote.category).toBe('erc20.transfer')
    expect(quote.riskBps).toBe(200)
    expect(quote.bond).toBe('5000000')

    // 4. The post-condition is the transfer policy's, and the committed
    //    destination is the ALLOWLIST's — not the calldata's. The absolute
    //    balance `erc20_balance(dest)` was dropped in favour of the delta
    //    alone: see policy.ts, rule 2 ("attributable to the transaction").
    const engagedDest = quote.conditionSpec.checks
      .filter((c) => c.kind === 'erc20_balance_delta')
      .map((c) => (c as { account: string }).account)
    expect(engagedDest).toEqual([TREASURY, PAYROLL])
    expect(JSON.stringify(quote.conditionSpec)).not.toContain(
      ATTACKER.slice(2),
    )
    expect(quote.conditionSpec.checks.map((c) => c.kind)).toEqual([
      'erc20_balance_delta',
      'erc20_balance_delta',
      'no_new_approvals',
    ])
  })

  it('the classification is the same whether or not the request carries declarative fields', () => {
    const honest = action()
    const noisy = {
      ...honest,
      category: 'erc20.approve',
      notionalUSD: '1',
      urgency: 'high',
    } as unknown as ActionSpec

    expect(classify(noisy, REGISTRY)).toEqual(classify(honest, REGISTRY))
  })

  it('the notional follows the calldata amount, not what the request claims', () => {
    const small = classify(
      action({ calldata: transferCalldata(PAYROLL, 1_000_000n) }),
      REGISTRY,
    )
    const large = classify(
      {
        ...action({ calldata: transferCalldata(PAYROLL, 1_000_000_000_000n) }),
        // Stray declarative field: no effect, by construction.
        notionalUSD: '1',
      } as unknown as ActionSpec,
      REGISTRY,
    )
    expect(small.notionalUSD).toBe('1000000')
    expect(large.notionalUSD).toBe('1000000000000')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The key is the tuple, not the selector
// ─────────────────────────────────────────────────────────────────────────────

describe('the key is (chainId, target, selector)', () => {
  it('the same selector on two targets gives two categories', () => {
    const onUsdc = classify(action({ target: USDC_ETH }), REGISTRY)
    const onShitcoin = classify(action({ target: SHITCOIN }), REGISTRY)

    expect(onUsdc.category).toBe('erc20.transfer')
    expect(onShitcoin.category).toBe('unknown')
    expect(onUsdc.category).not.toBe(onShitcoin.category)
  })

  it('two targets can carry two differently named categories for one and the same selector', () => {
    const poolB = '0x3333333333333333333333333333333333333333' as Address
    const synthetic: RegistryFile = {
      version: 1,
      assets: {
        [`1:${USDC_ETH}`]: { symbol: 'USDC', decimals: 6, priceUSD: '1000000' },
      },
      entries: [
        {
          chainId: 1,
          target: AAVE_POOL,
          selector: '0x69328dec',
          category: 'aavev3.withdraw',
          signature: 'withdraw(address,uint256,address)',
          argNames: ['asset', 'amount', 'to'],
          targetAs: 'pool',
          amountArg: 'amount',
          assetArg: 'asset',
        },
        {
          chainId: 1,
          target: poolB,
          selector: '0x69328dec',
          category: 'aavev3.supply',
          signature: 'withdraw(address,uint256,address)',
          argNames: ['asset', 'amount', 'to'],
          targetAs: 'pool',
          amountArg: 'amount',
          assetArg: 'asset',
        },
      ],
    }
    assertRegistryConsistent(synthetic)

    const calldata = aaveCalldata('withdraw', [USDC_ETH, 10_000_000n, TREASURY])
    expect(
      classify(action({ target: AAVE_POOL, calldata }), synthetic).category,
    ).toBe('aavev3.withdraw')
    expect(
      classify(action({ target: poolB, calldata }), synthetic).category,
    ).toBe('aavev3.supply')
  })

  it('the same (target, selector) pair on two chains stays distinct', () => {
    const onBase = classify(
      action({ chainId: 8453, target: USDC_BASE }),
      REGISTRY,
    )
    expect(onBase.category).toBe('erc20.transfer')

    // Base USDC does not exist on Ethereum: tuple absent → `unknown`.
    const wrongChain = classify(
      action({ chainId: 1, target: USDC_BASE }),
      REGISTRY,
    )
    expect(wrongChain.category).toBe('unknown')
  })

  it('the target is compared case-insensitively', () => {
    const checksum = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
    const c = classify(action({ target: checksum }), REGISTRY)
    expect(c.category).toBe('erc20.transfer')
    expect(c.params['token']).toBe(USDC_ETH)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The fallback is never permissive
// ─────────────────────────────────────────────────────────────────────────────

describe('the fallback is never permissive', () => {
  it('unknown tuple → unknown category, zero notional, maximum bond', () => {
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    expect(c.category).toBe('unknown')
    expect(c.notionalUSD).toBe('0')
    expect(c.params['target']).toBe(SHITCOIN)
    expect(c.params['selector']).toBe('0xa9059cbb')

    const quote = priceRisk(c, POLICY)
    expect(quote.bond).toBe(POLICY.maxBond)
  })

  it('unknown selector on a known target → unknown', () => {
    const c = classify(
      action({ target: USDC_ETH, calldata: '0xdeadbeef' }),
      REGISTRY,
    )
    expect(c.category).toBe('unknown')
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('calldata shorter than 4 bytes → refused', () => {
    for (const calldata of ['0x', '0xa9', '0xa9059c'] as Hex[]) {
      expect(() => classify(action({ calldata }), REGISTRY)).toThrowError(
        ClassificationError,
      )
      try {
        classify(action({ calldata }), REGISTRY)
      } catch (err) {
        expect((err as ClassificationError).code).toBe('CALLDATA_TOO_SHORT')
      }
    }
  })

  it('non-hexadecimal calldata → refused', () => {
    expect(() =>
      classify(action({ calldata: 'a9059cbb' as Hex }), REGISTRY),
    ).toThrowError(/non-hexadecimal/)
    expect(() =>
      classify(action({ calldata: '0xzzzzzzzz' as Hex }), REGISTRY),
    ).toThrowError(ClassificationError)
  })

  it('ABI decoding failure → refused, never a fallback to unknown', () => {
    // Right selector, truncated arguments.
    const truncated = ('0xa9059cbb' + '00'.repeat(31)) as Hex
    let code: string | undefined
    try {
      classify(action({ calldata: truncated }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('DECODE_FAILED')

    // Right selector, surplus arguments.
    const tooMany = (transferCalldata(PAYROLL, 1n) + '00'.repeat(32)) as Hex
    expect(() => classify(action({ calldata: tooMany }), REGISTRY)).toThrowError(
      ClassificationError,
    )
  })

  it('generic router by target → refused', () => {
    let code: string | undefined
    try {
      classify(action({ target: MULTICALL3 }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('GENERIC_ROUTER')
  })

  it('wrapping selector → refused, whatever the target', () => {
    const wrappers: Hex[] = [
      '0xac9650d8', // multicall(bytes[])
      '0x5ae401dc', // multicall(uint256,bytes[])
      '0x252dba42', // aggregate((address,bytes)[])
      '0x82ad56cb', // aggregate3((address,bool,bytes)[])
      '0x3593564c', // execute(bytes,bytes[],uint256) — Universal Router
      '0x09c5eabe', // execute(bytes)
      '0xb61d27f6', // execute(address,uint256,bytes)
      '0x8d80ff0a', // multiSend(bytes)
      '0x6a761202', // execTransaction(...)
    ]
    for (const selector of wrappers) {
      const calldata = (selector + '00'.repeat(64)) as Hex
      let code: string | undefined
      try {
        classify(action({ target: SHITCOIN, calldata }), REGISTRY)
      } catch (err) {
        code = (err as ClassificationError).code
      }
      expect(code, `selector ${selector}`).toBe('GENERIC_ROUTER')
    }
  })

  it('value > 0 on a category that does not expect it → refused', () => {
    let code: string | undefined
    try {
      classify(action({ value: '1' }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('UNEXPECTED_VALUE')

    // Including when the action is not even classified.
    try {
      classify(action({ target: SHITCOIN, value: '1000000000000000000' }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('UNEXPECTED_VALUE')

    // value = "0" obviously remains acceptable.
    expect(classify(action({ value: '0' }), REGISTRY).category).toBe(
      'erc20.transfer',
    )
  })

  it('negative or non-numeric value → refused', () => {
    expect(() => classify(action({ value: '-1' }), REGISTRY)).toThrowError(
      ClassificationError,
    )
    expect(() => classify(action({ value: 'plenty' }), REGISTRY)).toThrowError(
      ClassificationError,
    )
  })

  it('asset absent from the price table → refused, never a zero notional', () => {
    const calldata = aaveCalldata('supply', [
      SHITCOIN,
      10n ** 24n,
      TREASURY,
      0,
    ])
    let code: string | undefined
    try {
      classify(action({ target: AAVE_POOL, calldata }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('UNPRICEABLE_ASSET')
  })

  it('registry entry with an inconsistent selector → refused', () => {
    // Hand-crafted registry, lying selector. `classify` recomputes it.
    const liar = {
      version: 1,
      entries: [
        {
          chainId: 1,
          target: USDC_ETH,
          selector: '0xa9059cbb',
          category: 'erc20.transfer',
          signature: 'approve(address,uint256)',
          argNames: ['spender', 'amount'],
          targetAs: 'token',
          amountArg: 'amount',
          assetDecimals: 6,
          assetPriceUSD: '1000000',
        },
      ],
    } as RegistryFile

    let code: string | undefined
    try {
      classify(action(), liar)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('REGISTRY_INCONSISTENT')
    expect(() => assertRegistryConsistent(liar)).toThrowError(RegistryError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Decoding and notional
// ─────────────────────────────────────────────────────────────────────────────

describe('argument decoding and notional derivation', () => {
  it('erc20.transfer: named arguments, lowercase addresses', () => {
    const c = classify(
      action({ calldata: transferCalldata(ATTACKER, 42_000_000n) }),
      REGISTRY,
    )
    expect(c.category).toBe('erc20.transfer')
    expect(c.params).toEqual({
      to: ATTACKER,
      amount: '42000000',
      token: USDC_ETH,
      chainId: '1',
    })
    expect(c.notionalUSD).toBe('42000000') // 42 USDC = $42.00
    expect(c.registryRef).toBe(REF)
  })

  it('erc20.approve: revocation to zero, zero notional', () => {
    const c = classify(
      action({ calldata: approveCalldata(ATTACKER, 0n) }),
      REGISTRY,
    )
    expect(c.category).toBe('erc20.approve')
    expect(c.params['spender']).toBe(ATTACKER)
    expect(c.params['amount']).toBe('0')
    expect(c.notionalUSD).toBe('0')
  })

  it('erc20.approve: an infinite allowance produces a colossal notional, hence the maximum bond', () => {
    const max = 2n ** 256n - 1n
    const c = classify(
      action({ calldata: approveCalldata(ATTACKER, max) }),
      REGISTRY,
    )
    expect(BigInt(c.notionalUSD)).toBe(max) // × $1 / 1e6 decimals
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('aavev3.repay: Aave V3 signature and arguments', () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 5_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(c.category).toBe('aavev3.repay')
    expect(c.params).toEqual({
      asset: USDC_ETH,
      amount: '5000000',
      interestRateMode: '2',
      onBehalfOf: TREASURY,
      pool: AAVE_POOL,
      chainId: '1',
    })
    expect(c.notionalUSD).toBe('5000000')
  })

  it('aavev3.supply / withdraw / borrow', () => {
    const supply = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('supply', [WETH, 10n ** 18n, TREASURY, 0]),
      }),
      REGISTRY,
    )
    expect(supply.category).toBe('aavev3.supply')
    // 1 WETH at $3,000, in 1e6 fixed point.
    expect(supply.notionalUSD).toBe('3000000000')

    const withdraw = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('withdraw', [USDC_ETH, 250_000_000n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(withdraw.category).toBe('aavev3.withdraw')
    expect(withdraw.params['to']).toBe(TREASURY)

    const borrow = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('borrow', [
          USDC_ETH,
          1_000_000_000n,
          2n,
          0,
          TREASURY,
        ]),
      }),
      REGISTRY,
    )
    expect(borrow.category).toBe('aavev3.borrow')
    expect(borrow.notionalUSD).toBe('1000000000')
  })

  it('the notional is rounded down, as an integer, never as a float', () => {
    // 1 wei of WETH at $3,000 is worth $3e-15: strictly below the atomic unit,
    // hence 0. No float appears anywhere.
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('supply', [WETH, 1n, TREASURY, 0]),
      }),
      REGISTRY,
    )
    expect(c.notionalUSD).toBe('0')
    expect(c.notionalUSD).not.toContain('e')
    expect(c.notionalUSD).not.toContain('.')
  })

  it('classify is deterministic', () => {
    const spec = action()
    const a = classify(spec, REGISTRY)
    const b = classify(spec, REGISTRY)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The registry itself
// ─────────────────────────────────────────────────────────────────────────────

describe('classification registry', () => {
  it("the repo's file is consistent: every selector is recomputed from its signature", () => {
    expect(() => assertRegistryConsistent(REGISTRY)).not.toThrow()
  })

  it('the Aave V3 selectors are those of the onchain Pool', () => {
    const bySignature = Object.fromEntries(
      REGISTRY.entries.map((e) => [e.signature, e.selector]),
    )
    expect(bySignature['supply(address,uint256,address,uint16)']).toBe(
      '0x617ba037',
    )
    expect(bySignature['withdraw(address,uint256,address)']).toBe('0x69328dec')
    expect(bySignature['borrow(address,uint256,uint256,uint16,address)']).toBe(
      '0xa415bcad',
    )
    expect(bySignature['repay(address,uint256,uint256,address)']).toBe(
      '0x573ade81',
    )
    expect(bySignature['transfer(address,uint256)']).toBe('0xa9059cbb')
    expect(bySignature['approve(address,uint256)']).toBe('0x095ea7b3')
  })

  it('covers at least USDC (Ethereum and Base) and the Ethereum Aave V3 Pool', () => {
    const tuples = REGISTRY.entries.map(
      (e) => `${e.chainId}:${e.target}:${e.category}`,
    )
    expect(tuples).toContain(`1:${USDC_ETH}:erc20.transfer`)
    expect(tuples).toContain(`1:${USDC_ETH}:erc20.approve`)
    expect(tuples).toContain(`8453:${USDC_BASE}:erc20.transfer`)
    expect(tuples).toContain(`8453:${USDC_BASE}:erc20.approve`)
    for (const cat of [
      'aavev3.repay',
      'aavev3.supply',
      'aavev3.withdraw',
      'aavev3.borrow',
    ]) {
      expect(tuples).toContain(`1:${AAVE_POOL}:${cat}`)
    }
  })

  it('the registryRef is the keccak256 of the JCS canonical form, insensitive to key order', () => {
    expect(REF).toMatch(/^0x[0-9a-f]{64}$/)
    // The same canonicalization as conditionHash / actionHash: one
    // implementation, hence a single opportunity to diverge (docs/13 R1).
    expect(REF).toBe(hashCanonical(canonicalize(REGISTRY)))
    expect(canonicalizeRegistry(REGISTRY)).toBe(canonicalize(REGISTRY))

    // Same data, keys written in reverse order: same fingerprint.
    const reordered = Object.fromEntries(
      Object.entries(REGISTRY).reverse(),
    ) as unknown as RegistryFile
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(REGISTRY))
    expect(registryRefOf(reordered)).toBe(REF)
  })

  it('modifying an entry changes the registryRef', () => {
    const modified = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    modified.entries[0]!.assetPriceUSD = '2000000'
    expect(registryRefOf(modified)).not.toBe(REF)
  })

  it('a duplicated or malformed registry is refused at load time', () => {
    const duplicated = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    duplicated.entries.push(duplicated.entries[0]!)
    expect(() => assertRegistryConsistent(duplicated)).toThrowError(/duplicate entry/)

    const broken = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    broken.entries[0]!.target = '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48' as Address
    expect(() => assertRegistryConsistent(broken)).toThrowError(/not normalized/)
  })

  it('the argument names match the arity of the signature', () => {
    const wrong = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    wrong.entries[0]!.argNames = ['to']
    expect(() => assertRegistryConsistent(wrong)).toThrowError(/argNames/)
  })

  it('reference ERC20_ABI — the registry signatures are these ones', () => {
    for (const sig of ERC20_ABI) {
      const bare = sig.replace('function ', '')
      expect(REGISTRY.entries.some((e) => e.signature === bare)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Closing the loop: classifier → policy
// ─────────────────────────────────────────────────────────────────────────────

describe('the classification feeds the policy, not the other way round', () => {
  it('a diverted transfer commits to the policy destination', () => {
    const c = classify(
      action({ calldata: transferCalldata(ATTACKER, 100_000_000n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY)
    const accounts = spec.checks
      .map((chk) => (chk as { account?: string }).account)
      .filter(Boolean)
    expect(accounts).toContain(PAYROLL)
    expect(accounts).not.toContain(ATTACKER)
  })
})
