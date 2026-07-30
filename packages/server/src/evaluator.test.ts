/**
 * Tests for the post-condition evaluator.
 *
 * Approach: a simulated `PublicClient` behaving like a small chain indexed by
 * block. Chosen over an anvil fork because the properties to be proven here are
 * *temporal and adversarial* — "a third-party transaction in the same block
 * must not be imputed to the agent", "reading at the wrong block changes the
 * verdict", "an RPC outage never slashes" — and they are built exactly, in
 * milliseconds, without depending on an external binary or on fork state.
 *
 * The mock **refuses every read that carries no `blockNumber`**: the "never
 * `latest`" rule is therefore verified by construction on each of these tests.
 */

import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem'
import {
  ContextMismatchError,
  InvalidSpecError,
  RpcReadError,
  UnknownCheckKindError,
  UnsupportedCheckError,
  evaluate,
  resolveEvaluateAt,
  type EvaluationContext,
} from './evaluator.js'
import { TOPIC_APPROVAL, TOPIC_TRANSFER } from './checks/abi.js'
import { actionHash as defaultActionHash, canonicalize } from '@warrant/core'
import type { Check, ConditionSpec } from './checks/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const TREASURY = '0x2222222222222222222222222222222222222222' as const
const SPENDER = '0x3333333333333333333333333333333333333333' as const
const DEST = '0x4444444444444444444444444444444444444444' as const
const AGENT = '0x5555555555555555555555555555555555555555' as const
const POOL = '0x6666666666666666666666666666666666666666' as const
const THIRD_PARTY = '0x7777777777777777777777777777777777777777' as const
const OTHER_TOKEN = '0x8888888888888888888888888888888888888888' as const

const TX_HASH = `0x${'ab'.repeat(32)}` as Hex
const REGISTRY_REF = `0x${'cd'.repeat(32)}` as Hex
const TX_BLOCK = 101n
const UINT256_MAX = 2n ** 256n - 1n

const REVOKE_CALLDATA = encodeFunctionData({
  abi: [
    {
      type: 'function',
      name: 'approve',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [{ name: '', type: 'bool' }],
    },
  ],
  functionName: 'approve',
  args: [SPENDER, 0n],
})

// ─────────────────────────────────────────────────────────────────────────────
// Simulated chain
// ─────────────────────────────────────────────────────────────────────────────

interface MockLog {
  address: string
  topics: Hex[]
  data: Hex
}

interface MockTx {
  from: string
  to: string | null
  value: bigint
  input: Hex
  chainId?: number
  gasPrice?: bigint
}

interface MockReceipt {
  blockNumber: bigint
  gasUsed: bigint
  effectiveGasPrice: bigint
  status: 'success' | 'reverted'
  logs: MockLog[]
}

/** Onchain state declared at a given block; later blocks inherit it. */
interface Snapshot {
  allowance?: Record<string, bigint>
  balanceOf?: Record<string, bigint>
  nonce?: Record<string, number>
  aave?: Record<string, bigint[]>
  call?: Record<string, Hex>
  code?: Record<string, Hex>
}

interface Scenario {
  snapshots: Record<number, Snapshot>
  txs: Record<string, { tx: MockTx; receipt: MockReceipt }>
  rpcUrl?: string
  /** Methods that must fail, so as to simulate an RPC outage. */
  failing?: string[]
}

interface MockClient {
  client: PublicClient
  /** Read log: `method@block`. Serves to prove the absence of `latest`. */
  reads: string[]
}

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join('/')

function stateAt(scenario: Scenario, block: bigint): Required<Snapshot> {
  const merged: Required<Snapshot> = {
    allowance: {},
    balanceOf: {},
    nonce: {},
    aave: {},
    call: {},
    code: {},
  }
  const blocks = Object.keys(scenario.snapshots)
    .map(Number)
    .sort((a, b) => a - b)
  for (const at of blocks) {
    if (BigInt(at) > block) continue
    const snapshot = scenario.snapshots[at]!
    Object.assign(merged.allowance, snapshot.allowance ?? {})
    Object.assign(merged.balanceOf, snapshot.balanceOf ?? {})
    Object.assign(merged.nonce, snapshot.nonce ?? {})
    Object.assign(merged.aave, snapshot.aave ?? {})
    Object.assign(merged.call, snapshot.call ?? {})
    Object.assign(merged.code, snapshot.code ?? {})
  }
  return merged
}

function createMockClient(scenario: Scenario): MockClient {
  const reads: string[] = []
  const failing = new Set(scenario.failing ?? [])

  /** Every state read must carry an explicit block. Never `latest`. */
  const requireBlock = (method: string, blockNumber: bigint | undefined): bigint => {
    if (blockNumber === undefined || blockNumber === null) {
      throw new Error(`FORBIDDEN: ${method} called without an explicit blockNumber (latest read)`)
    }
    reads.push(`${method}@${blockNumber}`)
    return blockNumber
  }

  const guard = (method: string) => {
    if (failing.has(method)) throw new Error(`node unavailable: ${method}`)
  }

  const client = {
    transport: { url: scenario.rpcUrl ?? 'https://rpc.independent.example/eth' },

    async getTransactionReceipt({ hash }: { hash: string }) {
      guard('getTransactionReceipt')
      reads.push('getTransactionReceipt')
      const entry = scenario.txs[hash.toLowerCase()]
      if (!entry) throw new Error(`unknown transaction ${hash}`)
      return entry.receipt
    },

    async getTransaction({ hash }: { hash: string }) {
      guard('getTransaction')
      reads.push('getTransaction')
      const entry = scenario.txs[hash.toLowerCase()]
      if (!entry) throw new Error(`unknown transaction ${hash}`)
      return entry.tx
    },

    async readContract(args: {
      address: string
      functionName: string
      args: readonly unknown[]
      blockNumber?: bigint
    }) {
      guard(args.functionName)
      const block = requireBlock(args.functionName, args.blockNumber)
      const state = stateAt(scenario, block)
      switch (args.functionName) {
        case 'allowance': {
          const k = key(args.address, String(args.args[0]), String(args.args[1]))
          return state.allowance[k] ?? 0n
        }
        case 'balanceOf': {
          const k = key(args.address, String(args.args[0]))
          return state.balanceOf[k] ?? 0n
        }
        case 'getUserAccountData': {
          const k = key(args.address, String(args.args[0]))
          const data = state.aave[k]
          if (!data) throw new Error(`no aave data for ${k}`)
          return data
        }
        default:
          throw new Error(`unexpected readContract ${args.functionName}`)
      }
    },

    async call(args: { to: string; data: Hex; blockNumber?: bigint }) {
      guard('call')
      const block = requireBlock('call', args.blockNumber)
      const state = stateAt(scenario, block)
      const result = state.call[key(args.to, args.data)]
      if (result === undefined) throw new Error(`staticcall reverted at block ${block}`)
      return { data: result }
    },

    async getTransactionCount(args: { address: string; blockNumber?: bigint }) {
      guard('getTransactionCount')
      const block = requireBlock('getTransactionCount', args.blockNumber)
      return stateAt(scenario, block).nonce[args.address.toLowerCase()] ?? 0
    },

    async getCode(args: { address: string; blockNumber?: bigint }) {
      guard('getCode')
      const block = requireBlock('getCode', args.blockNumber)
      return stateAt(scenario, block).code[args.address.toLowerCase()] ?? '0x'
    },
  }

  return { client: client as unknown as PublicClient, reads }
}

// ─────────────────────────────────────────────────────────────────────────────
// Log builders
// ─────────────────────────────────────────────────────────────────────────────

const topicOf = (address: string): Hex => pad(address as Hex, { size: 32 })
const amountData = (value: bigint): Hex => toHex(value, { size: 32 })

const transferLog = (token: string, from: string, to: string, value: bigint): MockLog => ({
  address: token,
  topics: [TOPIC_TRANSFER, topicOf(from), topicOf(to)],
  data: amountData(value),
})

/** ERC-721 `Transfer`: the `tokenId` is indexed, hence 4 topics. */
const erc721TransferLog = (token: string, from: string, to: string, id: bigint): MockLog => ({
  address: token,
  topics: [TOPIC_TRANSFER, topicOf(from), topicOf(to), amountData(id)],
  data: '0x',
})

const approvalLog = (token: string, owner: string, spender: string, value: bigint): MockLog => ({
  address: token,
  topics: [TOPIC_APPROVAL, topicOf(owner), topicOf(spender)],
  data: amountData(value),
})

// ─────────────────────────────────────────────────────────────────────────────
// Base scenario: allowance revocation, the Circuit/Bankr case
// ─────────────────────────────────────────────────────────────────────────────

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    rpcUrl: 'https://rpc.independent.example/eth',
    snapshots: {
      100: {
        allowance: { [key(TOKEN, TREASURY, SPENDER)]: 10n ** 30n },
        balanceOf: { [key(TOKEN, TREASURY)]: 1_000_000_000n, [key(TOKEN, DEST)]: 0n },
        nonce: { [AGENT]: 4_000_000 },
        aave: { [key(POOL, TREASURY)]: [10n, 5n, 2n, 8000n, 7500n, 2n * 10n ** 18n] },
        code: { [TOKEN]: '0x60806040' },
        call: {
          [key(TOKEN, '0xdeadbeef')]: encodeAbiParameters([{ type: 'uint256' }], [42n]),
        },
      },
      101: {
        allowance: { [key(TOKEN, TREASURY, SPENDER)]: 0n },
        nonce: { [AGENT]: 4_000_001 },
        call: {
          [key(TOKEN, '0xdeadbeef')]: encodeAbiParameters([{ type: 'uint256' }], [0n]),
        },
      },
    },
    txs: {
      [TX_HASH.toLowerCase()]: {
        tx: {
          from: AGENT,
          to: TOKEN,
          value: 0n,
          input: REVOKE_CALLDATA,
          chainId: 1,
        },
        receipt: {
          blockNumber: TX_BLOCK,
          gasUsed: 46_000n,
          effectiveGasPrice: 10n ** 9n,
          status: 'success',
          logs: [approvalLog(TOKEN, TREASURY, SPENDER, 0n)],
        },
      },
    },
    ...overrides,
  }
}

function spec(checks: Check[], overrides: Partial<ConditionSpec> = {}): ConditionSpec {
  return {
    version: 1,
    chainId: 1,
    evaluateAt: 'tx',
    confirmations: 12,
    checks,
    ...overrides,
  }
}

async function run(
  checks: Check[],
  scenario: Scenario = baseScenario(),
  specOverrides: Partial<ConditionSpec> = {},
  ctxOverrides: Partial<EvaluationContext> = {},
) {
  const { client, reads } = createMockClient(scenario)
  const result = await evaluate(spec(checks, specOverrides), {
    txHash: TX_HASH,
    blockNumber: TX_BLOCK,
    client,
    registryRef: REGISTRY_REF,
    ...ctxOverrides,
  })
  return { result, reads }
}

/** A single check: a reading shortcut. */
async function one(
  check: Check,
  scenario: Scenario = baseScenario(),
  specOverrides: Partial<ConditionSpec> = {},
  ctxOverrides: Partial<EvaluationContext> = {},
) {
  const { result } = await run([check], scenario, specOverrides, ctxOverrides)
  return result.checks[0]!
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.1 erc20_allowance
// ─────────────────────────────────────────────────────────────────────────────

describe('erc20_allowance', () => {
  const check = (value: string, op: 'eq' | 'lte' | 'gte' = 'eq'): Check => ({
    kind: 'erc20_allowance',
    token: TOKEN,
    owner: TREASURY,
    spender: SPENDER,
    op,
    value,
  })

  it('passes: the allowance was indeed revoked at the transaction block', async () => {
    const result = await one(check('0'))
    expect(result.pass).toBe(true)
    expect(result.observed).toBe('0')
    expect(result.expected).toContain('eq 0')
  })

  it('fails: the allowance is still open', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.allowance = { [key(TOKEN, TREASURY, SPENDER)]: 1n }
    const result = await one(check('0'), scenario)
    expect(result.pass).toBe(false)
    expect(result.observed).toBe('1')
  })

  it('edge case: uint256 max compared without loss of precision', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.allowance = { [key(TOKEN, TREASURY, SPENDER)]: UINT256_MAX }
    const exact = await one(check(UINT256_MAX.toString(), 'lte'), scenario)
    expect(exact.pass).toBe(true)
    const off_by_one = await one(check((UINT256_MAX - 1n).toString(), 'lte'), scenario)
    expect(off_by_one.pass).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.2 erc20_balance
// ─────────────────────────────────────────────────────────────────────────────

describe('erc20_balance', () => {
  const check = (account: string, op: 'eq' | 'lte' | 'gte', value: string): Check => ({
    kind: 'erc20_balance',
    token: TOKEN,
    account: account as Hex,
    op,
    value,
  })

  it('passes: the allowed destination did receive', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.balanceOf = { [key(TOKEN, DEST)]: 1_000_000_000n }
    const result = await one(check(DEST, 'gte', '1000000000'), scenario)
    expect(result.pass).toBe(true)
  })

  it('fails: the allowed destination received nothing', async () => {
    const result = await one(check(DEST, 'gte', '1000000000'))
    expect(result.pass).toBe(false)
    expect(result.observed).toBe('0')
  })

  it('edge case: strict equality at the bound, no implicit tolerance', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.balanceOf = { [key(TOKEN, DEST)]: 999_999_999n }
    const result = await one(check(DEST, 'gte', '1000000000'), scenario)
    expect(result.pass).toBe(false) // one missing atomic unit is enough
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.3 erc20_balance_delta — the checker being fixed
// ─────────────────────────────────────────────────────────────────────────────

describe('erc20_balance_delta', () => {
  const check = (op: 'eq' | 'lte' | 'gte', value: string): Check => ({
    kind: 'erc20_balance_delta',
    token: TOKEN,
    account: TREASURY,
    op,
    value,
  })

  function withTransfers(logs: MockLog[]): Scenario {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = logs
    return scenario
  }

  it('passes: the treasury outflow stays within the committed bound', async () => {
    const scenario = withTransfers([transferLog(TOKEN, TREASURY, DEST, 200n)])
    const result = await one(check('gte', '-300'), scenario)
    expect(result.pass).toBe(true)
    expect(result.observed).toContain('-200')
  })

  it('fails: the outflow exceeds the committed bound', async () => {
    const scenario = withTransfers([transferLog(TOKEN, TREASURY, DEST, 500n)])
    const result = await one(check('gte', '-300'), scenario)
    expect(result.pass).toBe(false)
    expect(result.observed).toContain('-500')
  })

  it('edge case: a self-transfer cancels out, zero delta', async () => {
    const scenario = withTransfers([transferLog(TOKEN, TREASURY, TREASURY, 10n ** 12n)])
    const result = await one(check('eq', '0'), scenario)
    expect(result.pass).toBe(true)
    expect(result.observed).toContain('0 (in=1000000000000, out=1000000000000')
  })

  it('edge case: an ERC-721 Transfer (4 topics) is not a fungible amount', async () => {
    const scenario = withTransfers([erc721TransferLog(TOKEN, TREASURY, DEST, 777n)])
    const result = await one(check('eq', '0'), scenario)
    expect(result.pass).toBe(true)
  })

  it('edge case: transfers of another token do not count', async () => {
    const scenario = withTransfers([transferLog(OTHER_TOKEN, TREASURY, DEST, 10_000n)])
    const result = await one(check('eq', '0'), scenario)
    expect(result.pass).toBe(true)
  })

  it('THE BUG THAT WAS FIXED: a third-party transaction in the same block is not imputed to the agent', async () => {
    // Block 100: the treasury holds 1,000,000,000.
    // Block 101: the agent's transaction sends 200 out. A third-party
    // transaction, included in the same block, sends 500 more out. The closing
    // balance is therefore 700 lower — but 500 of that is not the agent's doing.
    const scenario = withTransfers([transferLog(TOKEN, TREASURY, DEST, 200n)])
    scenario.snapshots[101]!.balanceOf = { [key(TOKEN, TREASURY)]: 999_999_300n }

    // First we prove the trap is real: the difference of balances between
    // blocks does read -700 and would slash the bond.
    const { client } = createMockClient(scenario)
    const before = (await (client as unknown as {
      readContract(a: unknown): Promise<bigint>
    }).readContract({
      address: TOKEN,
      functionName: 'balanceOf',
      args: [TREASURY],
      blockNumber: 100n,
    })) as bigint
    const after = (await (client as unknown as {
      readContract(a: unknown): Promise<bigint>
    }).readContract({
      address: TOKEN,
      functionName: 'balanceOf',
      args: [TREASURY],
      blockNumber: 101n,
    })) as bigint
    expect(after - before).toBe(-700n) // the naive read: an unjust slash

    // The evaluator, for its part, keeps only the Transfers of the committed transaction.
    const result = await one(check('gte', '-300'), scenario)
    expect(result.observed).toContain('-200')
    expect(result.pass).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.4 native_balance_delta
// ─────────────────────────────────────────────────────────────────────────────

describe('native_balance_delta', () => {
  const check = (account: string, op: 'eq' | 'lte' | 'gte', value: string): Check => ({
    kind: 'native_balance_delta',
    account: account as Hex,
    op,
    value,
  })

  /** Pure native transfer: no calldata, recipient with no code. */
  function plainTransfer(): Scenario {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]! = {
      tx: { from: AGENT, to: TREASURY, value: 10n ** 18n, input: '0x', chainId: 1 },
      receipt: {
        blockNumber: TX_BLOCK,
        gasUsed: 21_000n,
        effectiveGasPrice: 10n ** 9n,
        status: 'success',
        logs: [],
      },
    }
    return scenario
  }

  it('passes: the recipient of a pure native transfer is credited exactly `value`', async () => {
    const result = await one(check(TREASURY, 'eq', (10n ** 18n).toString()), plainTransfer())
    expect(result.pass).toBe(true)
    expect(result.observed).toContain((10n ** 18n).toString())
  })

  it("fails: the sender's debit exceeds the bound", async () => {
    const result = await one(check(AGENT, 'gte', '-1000000000000000000'), plainTransfer())
    expect(result.pass).toBe(false) // value + gas > 1e18
  })

  it("edge case: the sender's gas is counted, exactly", async () => {
    const gas = 21_000n * 10n ** 9n
    const exact = -(10n ** 18n) - gas
    const result = await one(check(AGENT, 'eq', exact.toString()), plainTransfer())
    expect(result.pass).toBe(true)
  })

  it('edge case: an uninvolved third party has a zero delta', async () => {
    const result = await one(check(THIRD_PARTY, 'eq', '0'), plainTransfer())
    expect(result.pass).toBe(true)
  })

  it('not decidable without a tracer: throws, does not slash', async () => {
    // The base transaction carries calldata: internal transfers are possible
    // and invisible from the receipt.
    await expect(one(check(TREASURY, 'gte', '0'))).rejects.toBeInstanceOf(UnsupportedCheckError)
    await expect(one(check(TREASURY, 'gte', '0'))).rejects.toBeInstanceOf(RpcReadError)
  })

  it('not decidable if the recipient has code: its receive() may redistribute', async () => {
    const scenario = plainTransfer()
    scenario.snapshots[100]!.code = { ...scenario.snapshots[100]!.code, [TREASURY]: '0x6080' }
    await expect(one(check(TREASURY, 'gte', '0'), scenario)).rejects.toBeInstanceOf(
      UnsupportedCheckError,
    )
  })

  it('decidable with an injected tracer, internal calls included', async () => {
    const result = await one(check(TREASURY, 'eq', '500000000000000000'), baseScenario(), {}, {
      traceNativeTransfers: async () => [
        { from: TOKEN as Hex, to: TREASURY as Hex, value: 5n * 10n ** 17n },
      ],
    })
    expect(result.pass).toBe(true)
    expect(result.observed).toContain('trace(1 transfers)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.5 aave_health_factor
// ─────────────────────────────────────────────────────────────────────────────

describe('aave_health_factor', () => {
  const check = (op: 'eq' | 'lte' | 'gte', value: string): Check => ({
    kind: 'aave_health_factor',
    pool: POOL,
    user: TREASURY,
    op,
    value,
  })

  it('passes: health factor at 2.0 for a floor at 1.5', async () => {
    const result = await one(check('gte', '1500000000000000000'))
    expect(result.pass).toBe(true)
    expect(result.observed).toBe('2000000000000000000')
  })

  it('fails: health factor down to 1.2', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101] = {
      ...scenario.snapshots[101],
      aave: { [key(POOL, TREASURY)]: [10n, 8n, 0n, 8000n, 7500n, 12n * 10n ** 17n] },
    }
    const result = await one(check('gte', '1500000000000000000'), scenario)
    expect(result.pass).toBe(false)
    expect(result.observed).toBe('1200000000000000000')
  })

  it('edge case: position with no debt, uint256 max, compared as bigint', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101] = {
      ...scenario.snapshots[101],
      aave: { [key(POOL, TREASURY)]: [10n, 0n, 8n, 8000n, 7500n, UINT256_MAX] },
    }
    const result = await one(check('gte', '1500000000000000000'), scenario)
    expect(result.pass).toBe(true)
    expect(result.observed).toBe(UINT256_MAX.toString())
  })

  it('edge case: the 6th element of the tuple is indeed the one read', async () => {
    const scenario = baseScenario()
    // ltv (5th element) very large, healthFactor (6th) very small: an
    // evaluator that got the index wrong would pass.
    scenario.snapshots[101] = {
      ...scenario.snapshots[101],
      aave: { [key(POOL, TREASURY)]: [1n, 2n, 3n, 4n, UINT256_MAX, 1n] },
    }
    const result = await one(check('gte', '1500000000000000000'), scenario)
    expect(result.pass).toBe(false)
    expect(result.observed).toBe('1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.6 staticcall_result
// ─────────────────────────────────────────────────────────────────────────────

describe('staticcall_result', () => {
  const check = (
    op: 'eq' | 'lte' | 'gte',
    value: string,
    decodeAs: 'uint256' | 'int256' | 'bool' | 'address' | 'bytes32' = 'uint256',
  ): Check => ({
    kind: 'staticcall_result',
    target: TOKEN,
    data: '0xdeadbeef',
    decodeAs,
    op,
    value,
  })

  it('passes: the view read returns 0 at the evaluation block', async () => {
    const result = await one(check('lte', '0'))
    expect(result.pass).toBe(true)
    expect(result.observed).toBe('0')
  })

  it('fails: the view read returns an out-of-bound value', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.call = {
      [key(TOKEN, '0xdeadbeef')]: encodeAbiParameters([{ type: 'uint256' }], [7n]),
    }
    const result = await one(check('lte', '0'), scenario)
    expect(result.pass).toBe(false)
    expect(result.observed).toBe('7')
  })

  it('edge case: negative int256 decoding', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.call = {
      [key(TOKEN, '0xdeadbeef')]: encodeAbiParameters([{ type: 'int256' }], [-5n]),
    }
    const result = await one(check('gte', '-5', 'int256'), scenario)
    expect(result.pass).toBe(true)
    expect(result.observed).toBe('-5')
  })

  it('edge case: bool and address decoding', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.call = {
      [key(TOKEN, '0xdeadbeef')]: encodeAbiParameters([{ type: 'bool' }], [true]),
    }
    const asBool = await one(check('eq', 'true', 'bool'), scenario)
    expect(asBool.pass).toBe(true)
    expect(asBool.observed).toBe('true')

    scenario.snapshots[101]!.call = {
      [key(TOKEN, '0xdeadbeef')]: encodeAbiParameters([{ type: 'address' }], [DEST]),
    }
    const asAddress = await one(check('eq', DEST, 'address'), scenario)
    expect(asAddress.pass).toBe(true)
    expect(asAddress.observed).toBe(DEST.toLowerCase())
  })

  it('a revert is an inconclusive read, not a post-condition failure', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.call = {}
    scenario.snapshots[100]!.call = {}
    await expect(one(check('lte', '0'), scenario)).rejects.toBeInstanceOf(RpcReadError)
  })

  it('rejects a decodeAs outside the catalogue', async () => {
    const bad = { ...(check('eq', '0') as Record<string, unknown>), decodeAs: 'string' } as Check
    await expect(one(bad)).rejects.toBeInstanceOf(InvalidSpecError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.7 event_emitted
// ─────────────────────────────────────────────────────────────────────────────

describe('event_emitted', () => {
  const check = (minCount: number, address: string = TOKEN, topic0: Hex = TOPIC_APPROVAL): Check => ({
    kind: 'event_emitted',
    address: address as Hex,
    topic0,
    minCount,
  })

  it('passes: the expected Approval is present in the transaction logs', async () => {
    const result = await one(check(1))
    expect(result.pass).toBe(true)
    expect(result.observed).toBe('1')
  })

  it('fails: the expected event was not emitted by that address', async () => {
    const result = await one(check(1, OTHER_TOKEN))
    expect(result.pass).toBe(false)
    expect(result.observed).toBe('0')
  })

  it('edge case: minCount = 0 passes even with no occurrence', async () => {
    const result = await one(check(0, OTHER_TOKEN))
    expect(result.pass).toBe(true)
  })

  it('edge case: minCount = 2 with exactly 2 occurrences', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = [
      approvalLog(TOKEN, TREASURY, SPENDER, 0n),
      approvalLog(TOKEN, TREASURY, DEST, 0n),
    ]
    expect((await one(check(2), scenario)).pass).toBe(true)
    expect((await one(check(3), scenario)).pass).toBe(false)
  })

  it('rejects a negative minCount', async () => {
    await expect(one(check(-1))).rejects.toBeInstanceOf(InvalidSpecError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.8 nonce_advanced — a DELTA, never an absolute
// ─────────────────────────────────────────────────────────────────────────────

describe('nonce_advanced', () => {
  const check = (op: 'eq' | 'lte' | 'gte', value: string): Check => ({
    kind: 'nonce_advanced',
    account: AGENT,
    op,
    value,
  })

  it('passes: exactly one transaction, despite an absolute nonce of 4,000,001', async () => {
    const result = await one(check('eq', '1'))
    expect(result.pass).toBe(true)
    expect(result.observed).toContain('1 (before=4000000, after=4000001)')
  })

  it('fails: one extra parasitic action was emitted', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.nonce = { [AGENT]: 4_000_002 }
    const result = await one(check('eq', '1'), scenario)
    expect(result.pass).toBe(false)
    expect(result.observed).toContain('2 (')
  })

  it('edge case: the absolute nonce, arbitrarily large, does not sway the verdict', async () => {
    const scenario = baseScenario()
    scenario.snapshots[100]!.nonce = { [AGENT]: 999_999_999 }
    scenario.snapshots[101]!.nonce = { [AGENT]: 1_000_000_000 }
    const result = await one(check('eq', '1'), scenario)
    expect(result.pass).toBe(true) // a test on the absolute would have failed here
  })

  it('edge case: zero delta when the account emitted nothing', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.nonce = { [AGENT]: 4_000_000 }
    expect((await one(check('eq', '0'), scenario)).pass).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.9 no_new_approvals — the Bankr vector
// ─────────────────────────────────────────────────────────────────────────────

describe('no_new_approvals', () => {
  const check = (tokens: string[] = [TOKEN]): Check => ({
    kind: 'no_new_approvals',
    owner: TREASURY,
    tokens: tokens as Hex[],
  })

  it('passes: a revocation (Approval to 0) is allowed', async () => {
    const result = await one(check())
    expect(result.pass).toBe(true)
    expect(result.observed).toBe('0 new approvals')
  })

  it('fails: a non-zero approval was slipped into the transaction', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = [
      approvalLog(TOKEN, TREASURY, SPENDER, 0n),
      approvalLog(TOKEN, TREASURY, THIRD_PARTY, UINT256_MAX),
    ]
    const result = await one(check(), scenario)
    expect(result.pass).toBe(false)
    expect(result.observed).toContain(THIRD_PARTY)
  })

  it('edge case: an approval by another owner does not concern the warrant', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = [
      approvalLog(TOKEN, THIRD_PARTY, SPENDER, UINT256_MAX),
    ]
    expect((await one(check(), scenario)).pass).toBe(true)
  })

  it('edge case: an empty `tokens` watches every token, it does not disarm itself', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = [
      approvalLog(OTHER_TOKEN, TREASURY, THIRD_PARTY, 1n),
    ]
    expect((await one(check([]), scenario)).pass).toBe(false)
    // …and stays silent when the list does not cover that token.
    expect((await one(check([TOKEN]), scenario)).pass).toBe(true)
  })

  it('edge case: an ERC-721 ApprovalForAll (4 topics) is not an ERC-20 Approval', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = [
      {
        address: TOKEN,
        topics: [TOPIC_APPROVAL, topicOf(TREASURY), topicOf(SPENDER), amountData(1n)],
        data: '0x',
      },
    ]
    expect((await one(check(), scenario)).pass).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.10 calldata_matches_commitment
// ─────────────────────────────────────────────────────────────────────────────

describe('calldata_matches_commitment', () => {
  const committed = defaultActionHash({
    version: 1,
    chainId: 1,
    target: TOKEN,
    value: '0',
    calldata: REVOKE_CALLDATA,
    registryRef: REGISTRY_REF,
  })

  it('passes: the executed transaction is the committed one', async () => {
    const result = await one({ kind: 'calldata_matches_commitment', actionHash: committed })
    expect(result.pass).toBe(true)
  })

  it('fails: committed action ≠ executed action, and the offending check is named', async () => {
    const scenario = baseScenario()
    // Same selector, same target, but an unlimited approval amount.
    scenario.txs[TX_HASH.toLowerCase()]!.tx.input = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'approve',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ],
      functionName: 'approve',
      args: [SPENDER, UINT256_MAX],
    })
    const { result } = await run(
      [{ kind: 'calldata_matches_commitment', actionHash: committed }],
      scenario,
    )
    expect(result.verdict).toBe('slashed')
    expect(result.checks[0]!.kind).toBe('calldata_matches_commitment')
    expect(result.checks[0]!.pass).toBe(false)
  })

  it('edge case: the case of the committed address does not open two hashes', async () => {
    const checksummed = defaultActionHash({
      version: 1,
      chainId: 1,
      target: TOKEN.toUpperCase().replace('0X', '0x') as Hex,
      value: '0',
      calldata: REVOKE_CALLDATA,
      registryRef: REGISTRY_REF,
    })
    // Lowercase normalisation must make the two hashes identical.
    expect(checksummed).toBe(
      defaultActionHash({
        version: 1,
        chainId: 1,
        target: TOKEN,
        value: '0',
        calldata: REVOKE_CALLDATA,
        registryRef: REGISTRY_REF,
      }),
    )
  })

  it('edge case: a different registryRef changes the hash, classification stays replayable', async () => {
    const otherRef = `0x${'ef'.repeat(32)}` as Hex
    const result = await one(
      { kind: 'calldata_matches_commitment', actionHash: committed },
      baseScenario(),
      {},
      { registryRef: otherRef },
    )
    expect(result.pass).toBe(false)
  })

  it("accepts an injected hasher — @warrant/core's one in integration", async () => {
    const injected = `0x${'11'.repeat(32)}` as Hex
    const result = await one(
      { kind: 'calldata_matches_commitment', actionHash: injected },
      baseScenario(),
      {},
      { hashAction: () => injected },
    )
    expect(result.pass).toBe(true)
  })

  it('canonicalises to JCS: sorted keys, no whitespace', () => {
    expect(canonicalize({ b: '2', a: 1, c: [true, null] })).toBe('{"a":1,"b":"2","c":[true,null]}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Frozen block, idempotence, full publication
// ─────────────────────────────────────────────────────────────────────────────

describe('reading at a frozen block', () => {
  it('evaluateAt is honoured: reading at the wrong block changes the verdict', async () => {
    const scenario = baseScenario()
    // At block 102, a later transaction emptied the treasury.
    scenario.snapshots[102] = { balanceOf: { [key(TOKEN, TREASURY)]: 0n } }

    const check: Check = {
      kind: 'erc20_balance',
      token: TOKEN,
      account: TREASURY,
      op: 'gte',
      value: '1000000000',
    }

    const atTx = (await run([check], scenario, { evaluateAt: 'tx' })).result
    const atTxPlusOne = (await run([check], scenario, { evaluateAt: 'tx+1' })).result

    expect(atTx.evaluatedAtBlock).toBe('101')
    expect(atTx.verdict).toBe('honored')
    expect(atTxPlusOne.evaluatedAtBlock).toBe('102')
    expect(atTxPlusOne.verdict).toBe('slashed')
    expect(atTx.checks[0]!.observed).not.toBe(atTxPlusOne.checks[0]!.observed)
  })

  it('evaluateAt: { block: n } reads exactly that block', async () => {
    const scenario = baseScenario()
    const check: Check = {
      kind: 'erc20_allowance',
      token: TOKEN,
      owner: TREASURY,
      spender: SPENDER,
      op: 'eq',
      value: '0',
    }
    const before = (await run([check], scenario, { evaluateAt: { block: 100 } })).result
    expect(before.evaluatedAtBlock).toBe('100')
    expect(before.verdict).toBe('slashed') // the allowance was still open
  })

  it('no read leaves without an explicit blockNumber', async () => {
    const { reads } = await run([
      { kind: 'erc20_allowance', token: TOKEN, owner: TREASURY, spender: SPENDER, op: 'eq', value: '0' },
      { kind: 'erc20_balance', token: TOKEN, account: TREASURY, op: 'gte', value: '0' },
      { kind: 'aave_health_factor', pool: POOL, user: TREASURY, op: 'gte', value: '0' },
      { kind: 'nonce_advanced', account: AGENT, op: 'eq', value: '1' },
      { kind: 'staticcall_result', target: TOKEN, data: '0xdeadbeef', decodeAs: 'uint256', op: 'lte', value: '0' },
    ])
    const stateReads = reads.filter((r) => !r.startsWith('getTransaction'))
    expect(stateReads.length).toBeGreaterThan(0)
    for (const entry of stateReads) expect(entry).toMatch(/@\d+$/)
  })

  it('resolveEvaluateAt rejects an unknown shape', () => {
    expect(resolveEvaluateAt('tx', 10n)).toBe(10n)
    expect(resolveEvaluateAt('tx+1', 10n)).toBe(11n)
    expect(resolveEvaluateAt({ block: 7 }, 10n)).toBe(7n)
    expect(() => resolveEvaluateAt('latest' as never, 10n)).toThrow(InvalidSpecError)
  })
})

describe('idempotence and auditability', () => {
  const fullSpec: Check[] = [
    { kind: 'erc20_allowance', token: TOKEN, owner: TREASURY, spender: SPENDER, op: 'eq', value: '0' },
    { kind: 'no_new_approvals', owner: TREASURY, tokens: [TOKEN] },
    { kind: 'erc20_balance_delta', token: TOKEN, account: TREASURY, op: 'gte', value: '0' },
    { kind: 'nonce_advanced', account: AGENT, op: 'eq', value: '1' },
  ]

  it('two evaluations of the same warrant return an identical result', async () => {
    const first = (await run(fullSpec)).result
    const second = (await run(fullSpec)).result
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.verdict).toBe('honored')
  })

  it('checks[] is published in full, passing verifications included', async () => {
    const scenario = baseScenario()
    scenario.snapshots[101]!.allowance = { [key(TOKEN, TREASURY, SPENDER)]: 1n }
    const { result } = await run(fullSpec, scenario)

    expect(result.verdict).toBe('slashed')
    expect(result.checks).toHaveLength(fullSpec.length)
    expect(result.checks.map((c) => c.kind)).toEqual(fullSpec.map((c) => c.kind))
    expect(result.checks.filter((c) => c.pass)).toHaveLength(3)
    for (const check of result.checks) {
      expect(check.expected.length).toBeGreaterThan(0)
      expect(check.observed.length).toBeGreaterThan(0)
    }
  })

  it('publishes the rpcUrl, which makes the verdict replayable', async () => {
    const { result } = await run(fullSpec)
    expect(result.rpcUrl).toBe('https://rpc.independent.example/eth')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Doubt benefits the agent
// ─────────────────────────────────────────────────────────────────────────────

describe('a read failure ≠ a post-condition failure', () => {
  const check: Check = {
    kind: 'erc20_allowance',
    token: TOKEN,
    owner: TREASURY,
    spender: SPENDER,
    op: 'eq',
    value: '0',
  }

  it('an RPC outage raises RpcReadError and never returns a verdict', async () => {
    const scenario = baseScenario({ failing: ['allowance'] })
    await expect(run([check], scenario)).rejects.toBeInstanceOf(RpcReadError)
  })

  it('an outage on the receipt throws before any evaluation', async () => {
    const scenario = baseScenario({ failing: ['getTransactionReceipt'] })
    await expect(run([check], scenario)).rejects.toBeInstanceOf(RpcReadError)
  })

  it('a partial outage does not degenerate into slashed, even if another check fails', async () => {
    // The balance check would fail outright; the allowance read, meanwhile, is
    // down. The verdict must not exist.
    const scenario = baseScenario({ failing: ['allowance'] })
    const failing: Check = {
      kind: 'erc20_balance',
      token: TOKEN,
      account: DEST,
      op: 'gte',
      value: '1000000000',
    }
    let verdict: string | undefined
    try {
      verdict = (await run([failing, check], scenario)).result.verdict
    } catch (error) {
      expect(error).toBeInstanceOf(RpcReadError)
    }
    expect(verdict).toBeUndefined()
  })

  it('the first error raised is deterministic: two runs, same message', async () => {
    const scenario = baseScenario({ failing: ['allowance', 'balanceOf'] })
    const checks: Check[] = [
      { kind: 'erc20_balance', token: TOKEN, account: DEST, op: 'gte', value: '0' },
      check,
    ]
    const first = await run(checks, scenario).catch((e: Error) => e.message)
    const second = await run(checks, scenario).catch((e: Error) => e.message)
    expect(first).toBe(second)
    expect(String(first)).toContain('balanceOf')
  })

  it('an unexpected inclusion block (reorg) throws, it does not slash', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.blockNumber = 105n
    await expect(run([check], scenario)).rejects.toBeInstanceOf(ContextMismatchError)
    await expect(run([check], scenario)).rejects.toBeInstanceOf(RpcReadError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Spec validation
// ─────────────────────────────────────────────────────────────────────────────

describe('ConditionSpec validation', () => {
  const filler = (i: number): Check => ({
    kind: 'erc20_balance',
    token: TOKEN,
    account: `0x${String(i).padStart(40, '0')}` as Hex,
    op: 'gte',
    value: '0',
  })

  it('rejects a kind outside the catalogue', async () => {
    await expect(run([{ kind: 'price_was_good' } as unknown as Check])).rejects.toBeInstanceOf(
      UnknownCheckKindError,
    )
  })

  it('rejects an empty checks list', async () => {
    await expect(run([])).rejects.toBeInstanceOf(InvalidSpecError)
  })

  it('rejects more than 8 declared checks', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => filler(i + 1))
    await expect(run(nine)).rejects.toBeInstanceOf(InvalidSpecError)
  })

  it('calldata_matches_commitment is outside the quota: 8 + 1 is accepted', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => filler(i + 1))
    const committed = defaultActionHash({
      version: 1,
      chainId: 1,
      target: TOKEN,
      value: '0',
      calldata: REVOKE_CALLDATA,
      registryRef: REGISTRY_REF,
    })
    const { result } = await run([...eight, { kind: 'calldata_matches_commitment', actionHash: committed }])
    expect(result.checks).toHaveLength(9)
    expect(result.verdict).toBe('honored')
  })

  it('rejects a duplicated calldata_matches_commitment (override attempt)', async () => {
    const hash = `0x${'00'.repeat(32)}` as Hex
    await expect(
      run([
        { kind: 'calldata_matches_commitment', actionHash: hash },
        { kind: 'calldata_matches_commitment', actionHash: hash },
      ]),
    ).rejects.toBeInstanceOf(InvalidSpecError)
  })

  it('rejects an unknown DSL version', async () => {
    await expect(run([filler(1)], baseScenario(), { version: 2 as 1 })).rejects.toBeInstanceOf(
      InvalidSpecError,
    )
  })

  it('rejects a value that is not a decimal integer', async () => {
    const bad: Check = {
      kind: 'erc20_balance',
      token: TOKEN,
      account: TREASURY,
      op: 'gte',
      value: '1e18',
    }
    await expect(run([bad])).rejects.toBeInstanceOf(InvalidSpecError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The complete scenario from the doc § 6.1
// ─────────────────────────────────────────────────────────────────────────────

describe('Circuit/Bankr scenario (docs/07 § 6.1)', () => {
  const checks: Check[] = [
    { kind: 'erc20_allowance', token: TOKEN, owner: TREASURY, spender: SPENDER, op: 'eq', value: '0' },
    { kind: 'no_new_approvals', owner: TREASURY, tokens: [TOKEN] },
    { kind: 'erc20_balance_delta', token: TOKEN, account: TREASURY, op: 'gte', value: '0' },
  ]

  it('clean revocation → honored', async () => {
    const { result } = await run(checks)
    expect(result.verdict).toBe('honored')
    expect(result.checks.every((c) => c.pass)).toBe(true)
  })

  it('revocation that reopens a permission elsewhere → slashed, on the right check', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = [
      approvalLog(TOKEN, TREASURY, SPENDER, 0n),
      approvalLog(TOKEN, TREASURY, THIRD_PARTY, UINT256_MAX),
    ]
    const { result } = await run(checks, scenario)
    expect(result.verdict).toBe('slashed')
    const failed = result.checks.filter((c) => !c.pass)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.kind).toBe('no_new_approvals')
  })

  it('revocation that drains the treasury along the way → slashed on the delta', async () => {
    const scenario = baseScenario()
    scenario.txs[TX_HASH.toLowerCase()]!.receipt.logs = [
      approvalLog(TOKEN, TREASURY, SPENDER, 0n),
      transferLog(TOKEN, TREASURY, THIRD_PARTY, 1n),
    ]
    const { result } = await run(checks, scenario)
    expect(result.verdict).toBe('slashed')
    expect(result.checks.filter((c) => !c.pass).map((c) => c.kind)).toEqual([
      'erc20_balance_delta',
    ])
  })
})
