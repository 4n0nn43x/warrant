import { describe, expect, it } from 'vitest'
import type { Hex } from '@warrant/core'
import { RpcReadError } from './checks/errors.js'
import type { Execution } from './keeperhub.js'
import {
  SETTLEMENT_MARGIN_SECONDS,
  decide,
  execRef,
  summarizeFailures,
} from './settler.js'

const WARRANT_ID = `0x${'11'.repeat(32)}` as Hex
const TX_HASH = `0x${'22'.repeat(32)}` as Hex

const NOW = 1_785_000_000
const FAR_EXPIRY = NOW + 3600

function execution(over: Partial<Execution> = {}): Execution {
  return {
    executionId: 'exec_abc',
    status: 'success',
    txHash: TX_HASH,
    raw: {},
    ...over,
  }
}

const publicClient = {
  waitForTransactionReceipt: async () => ({ blockNumber: 1234n }) as never,
}

const failingClient = {
  waitForTransactionReceipt: async () => {
    throw new Error('timed out waiting for confirmations')
  },
}

function evaluateTo(verdict: 'honored' | 'slashed', checks = passingChecks()) {
  return async () => ({
    verdict,
    evaluatedAtBlock: '1234',
    checks,
    rpcUrl: 'https://rpc.example',
  })
}

function passingChecks() {
  return [
    { kind: 'erc20_balance', expected: '>=1000', observed: '2000', pass: true },
  ]
}

function failingChecks() {
  return [
    { kind: 'erc20_balance', expected: '>=1000', observed: '0', pass: false },
    {
      kind: 'erc20_balance_delta',
      expected: '>=-500',
      observed: '-9000',
      pass: false,
    },
    { kind: 'no_new_approvals', expected: 'none', observed: 'none', pass: true },
  ]
}

const base = {
  warrantId: WARRANT_ID,
  expiry: FAR_EXPIRY,
  confirmations: 12,
  publicClient,
  now: () => NOW,
}

describe('decide — a transaction that fails is not a violated post-condition', () => {
  it('lets the warrant expire when KeeperHub reports an execution failure', async () => {
    const d = await decide({
      ...base,
      execution: execution({ status: 'failed', outcome: 'reverted' }),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.action.kind).toBe('let-expire')
    expect(d.evaluation).toBeUndefined()
  })

  it('lets the warrant expire while the execution is not finished', async () => {
    const d = await decide({
      ...base,
      execution: execution({ status: 'running' }),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
  })

  it('lets the warrant expire when the audit trail reports no txHash', async () => {
    const d = await decide({
      ...base,
      execution: { executionId: 'exec_abc', status: 'success', raw: {} },
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
    if (d.action.kind === 'let-expire') {
      expect(d.action.reason).toMatch(/txHash/)
    }
  })

  it('lets the warrant expire when the confirmations never come', async () => {
    const d = await decide({
      ...base,
      publicClient: failingClient,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
  })
})

describe('decide — doubt benefits the agent', () => {
  it('an RPC read error NEVER produces a slash', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: async () => {
        throw new RpcReadError('node unreachable')
      },
    })
    expect(d.action.kind).toBe('let-expire')
    expect(d.action.kind).not.toBe('slash')
  })

  it('a non-RPC error propagates instead of being swallowed', async () => {
    await expect(
      decide({
        ...base,
        execution: execution(),
        evaluate: async () => {
          throw new TypeError('programming bug')
        },
      }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe('decide — verdicts', () => {
  it('post-condition held → honor, with execRef', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('honor')
    if (d.action.kind === 'honor') {
      expect(d.action.execRef).toBe(execRef('exec_abc', TX_HASH))
    }
    expect(d.evaluation?.checks).toHaveLength(1)
  })

  it('post-condition violated → slash, with the failed checks as the reason', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.action.kind).toBe('slash')
    if (d.action.kind === 'slash') {
      expect(d.action.reason).toContain('erc20_balance')
      expect(d.action.reason).toContain('erc20_balance_delta')
      // Passing checks do not pollute the reason.
      expect(d.action.reason).not.toContain('no_new_approvals')
    }
  })

  it('publishes checks[] in full, passing checks included', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.evaluation?.checks).toHaveLength(3)
    expect(d.evaluation?.checks.filter((c) => c.pass)).toHaveLength(1)
  })
})

describe('decide — settlement window (invariant I9)', () => {
  it('abstains when expiry is too close, even on a slashed verdict', async () => {
    const d = await decide({
      ...base,
      expiry: NOW + SETTLEMENT_MARGIN_SECONDS - 1,
      execution: execution(),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.action.kind).toBe('let-expire')
    // The evaluation is published all the same: the verdict stays auditable.
    expect(d.evaluation?.verdict).toBe('slashed')
  })

  it('abstains on a too-late honored verdict as well', async () => {
    const d = await decide({
      ...base,
      expiry: NOW + 1,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
  })

  it('settles normally just above the margin', async () => {
    const d = await decide({
      ...base,
      expiry: NOW + SETTLEMENT_MARGIN_SECONDS + 1,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('honor')
  })
})

describe('execRef', () => {
  it('is deterministic', () => {
    expect(execRef('exec_abc', TX_HASH)).toBe(execRef('exec_abc', TX_HASH))
  })

  it('separates two different executions on the same transaction', () => {
    expect(execRef('exec_a', TX_HASH)).not.toBe(execRef('exec_b', TX_HASH))
  })

  it('separates two different transactions on the same execution', () => {
    const other = `0x${'33'.repeat(32)}` as Hex
    expect(execRef('exec_a', TX_HASH)).not.toBe(execRef('exec_a', other))
  })
})

describe('summarizeFailures', () => {
  it('lists only the failures', () => {
    expect(summarizeFailures(failingChecks())).not.toContain('no_new_approvals')
  })

  it('bounds the length so it fits in an event', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      kind: `check_${i}`,
      expected: 'x'.repeat(50),
      observed: 'y'.repeat(50),
      pass: false,
    }))
    expect(summarizeFailures(many).length).toBeLessThanOrEqual(400)
  })

  it('stays explicit when nothing failed', () => {
    expect(summarizeFailures(passingChecks())).toMatch(/no failed check/)
  })
})
