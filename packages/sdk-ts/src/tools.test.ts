/**
 * Tests of the single source.
 *
 * What is verified here is true of **all** the integration surfaces at once —
 * MCP, Vercel AI, LangChain, CrewAI, the OpenClaw skill — since none of them
 * redefines a schema or any logic. That is the whole point of having only one
 * source: an invariant tested once is upheld five times.
 */

import { describe, expect, it, vi } from 'vitest'

import { WarrantError } from './errors.js'
import type { GatewayClient } from './gateway.js'
import {
  WARRANT_TOOLS,
  quoteRiskTool,
  requestWarrantTool,
  runTool,
  runToolByName,
  warrantToolByName,
} from './tools.js'
import type { PaymentPayload, PaymentRequired } from './x402.js'

const TREASURY = '0x2222222222222222222222222222222222222222'
const ACTION_SPEC = {
  version: 1 as const,
  chainId: 8453,
  target: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  value: '0',
  calldata: `0xa9059cbb${'00'.repeat(31)}03${'00'.repeat(28)}017d7840`,
  registryRef: `0x${'ab'.repeat(32)}`,
}

const PAYMENT_REQUIRED: PaymentRequired = {
  x402Version: 2,
  resource: { url: 'https://api.warrant.sh/v1/warrants' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '25000000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x00000000000000000000000000000000000000a1',
      maxTimeoutSeconds: 60,
    },
  ],
}

function stubGateway(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    quote: vi.fn(async () => ({
      category: 'erc20.transfer' as const,
      bond: '125000',
      riskBps: 50,
      notionalUSD: '25',
      conditionSpec: { version: 1, chainId: 8453, evaluateAt: 'tx+1', confirmations: 3, checks: [] },
      rationale: 'stub',
    })),
    requestWarrant: vi.fn(async () => ({
      status: 'payment-required' as const,
      paymentRequired: PAYMENT_REQUIRED,
    })),
    getWarrant: vi.fn(async () => null),
    listWarrants: vi.fn(async () => ({
      warrants: [],
      stats: {
        total: 0,
        open: 0,
        honored: 0,
        slashed: 0,
        reclaimed: 0,
        totalBonded: '0',
        totalSlashed: '0',
        honorRateBps: 0,
      },
    })),
    ...overrides,
  } as GatewayClient
}

describe('catalogue', () => {
  it('contains exactly the four tools of docs/09 § 2', () => {
    expect(WARRANT_TOOLS.map((t) => t.name)).toEqual([
      'quote_risk',
      'request_warrant',
      'get_warrant',
      'list_warrants',
    ])
  })

  it('has only one paid tool', () => {
    expect(WARRANT_TOOLS.filter((t) => t.paid).map((t) => t.name)).toEqual(['request_warrant'])
  })

  it('describes each tool for a model, not for a human in a hurry', () => {
    for (const tool of WARRANT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(80)
      expect(tool.title).toBeTruthy()
    }
  })

  it('resolves by name', () => {
    expect(warrantToolByName('quote_risk')).toBe(quoteRiskTool)
    expect(warrantToolByName('execute_metered')).toBeUndefined()
  })
})

describe('nothing is declared', () => {
  it('no schema exposes category or notional', () => {
    for (const tool of WARRANT_TOOLS) {
      const keys = Object.keys(tool.input.shape)
      expect(keys).not.toContain('notional')
      expect(keys).not.toContain('bond')
      if (tool.name !== 'list_warrants') expect(keys).not.toContain('category')
    }
  })

  it('strips stray fields before reaching the Gateway', async () => {
    const gateway = stubGateway()
    await quoteRiskTool.run(gateway, {
      actionSpec: { ...ACTION_SPEC, category: 'aavev3.repay', notionalUSD: '1' },
      beneficiary: TREASURY,
      bond: '1',
    })

    const call = vi.mocked(gateway.quote).mock.calls[0]?.[0]
    expect(Object.keys(call?.actionSpec ?? {}).sort()).toEqual([
      'calldata',
      'chainId',
      'registryRef',
      'target',
      'value',
      'version',
    ])
  })
})

describe('validation', () => {
  it('names the offending field and suggests a fix', async () => {
    const gateway = stubGateway()
    await expect(
      quoteRiskTool.run(gateway, { actionSpec: { ...ACTION_SPEC, target: '0x1234' } }),
    ).rejects.toMatchObject({
      name: 'WarrantError',
      code: 'invalid_input',
      field: '$.actionSpec.target',
    })
  })

  it('surfaces core errors together with their path', async () => {
    const gateway = stubGateway()
    // `value` passes the Zod regex but overflows uint256: it is @warrant/core
    // that catches it, and it is indeed the authority on what is hashable.
    const huge = (2n ** 256n).toString()
    await expect(
      quoteRiskTool.run(gateway, { actionSpec: { ...ACTION_SPEC, value: huge } }),
    ).rejects.toMatchObject({ name: 'WarrantError', field: '$.value' })
  })

  it('every error carries hint and docs', () => {
    const err = new WarrantError('classification_failed', 'unknown')
    expect(err.toJSON().error.hint).toBeTruthy()
    expect(err.toJSON().error.docs).toMatch(/^https:\/\//)
  })
})

describe('payment loop', () => {
  it('surfaces the PaymentRequired when no wallet is supplied', async () => {
    const outcome = await runTool(stubGateway(), requestWarrantTool, {
      actionSpec: ACTION_SPEC,
      beneficiary: TREASURY,
    })
    expect(outcome.kind).toBe('payment-required')
  })

  it('signs and replays exactly once when a wallet is supplied', async () => {
    let paid = false
    const gateway = stubGateway({
      requestWarrant: vi.fn(async (_req, payment?: PaymentPayload) => {
        if (!payment) {
          return { status: 'payment-required' as const, paymentRequired: PAYMENT_REQUIRED }
        }
        paid = true
        return {
          status: 'opened' as const,
          warrant: {
            warrantId: `0x${'01'.repeat(32)}` as `0x${string}`,
            executionId: 'exec_1',
            conditionHash: `0x${'02'.repeat(32)}` as `0x${string}`,
            actionHash: `0x${'03'.repeat(32)}` as `0x${string}`,
            expiry: 1785000000,
          },
          settlement: { success: true, transaction: `0x${'ab'.repeat(32)}` },
        }
      }),
    })

    const wallet = {
      createPayment: vi.fn((required: PaymentRequired): PaymentPayload => {
        const accepted = required.accepts[0]
        if (!accepted) throw new Error('offer missing')
        return { x402Version: 2, resource: required.resource, accepted, payload: { type: 'proof' } }
      }),
    }

    const outcome = await runTool(gateway, requestWarrantTool, {
      actionSpec: ACTION_SPEC,
      beneficiary: TREASURY,
    }, { wallet })

    expect(paid).toBe(true)
    expect(wallet.createPayment).toHaveBeenCalledTimes(1)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.settlement?.success).toBe(true)
  })

  it('bounds the replays against a Gateway that answers 402 forever', async () => {
    const wallet = {
      createPayment: vi.fn((required: PaymentRequired): PaymentPayload => ({
        x402Version: 2,
        resource: required.resource,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        accepted: required.accepts[0]!,
        payload: {},
      })),
    }
    const outcome = await runTool(
      stubGateway(),
      requestWarrantTool,
      { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
      { wallet, maxPaymentAttempts: 2 },
    )
    expect(outcome.kind).toBe('payment-required')
    expect(wallet.createPayment).toHaveBeenCalledTimes(2)
  })

  it('turns a refused signature into something actionable', async () => {
    const wallet = {
      createPayment: () => {
        throw new Error('user rejected')
      },
    }
    await expect(
      runTool(
        stubGateway(),
        requestWarrantTool,
        { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
        { wallet },
      ),
    ).rejects.toMatchObject({ code: 'payment_invalid' })
  })

  it('rejects an unknown tool while listing the four that exist', async () => {
    await expect(runToolByName(stubGateway(), 'execute_metered', {})).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})
