/**
 * Tests of the Vercel AI SDK adapter.
 *
 * The last test measures the size of the file. This is not vanity: the
 * "adapters under 100 lines" constraint (docs/09 § 5) is what stops logic from
 * migrating out of the single source and into the adapters, and a constraint
 * that is not measured is a constraint that is not upheld.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { warrantTools } from './ai.js'
import type { GatewayClient } from './gateway.js'
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
  resource: { url: 'https://gateway.example/v1/warrants' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '125000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x00000000000000000000000000000000000000a1',
      maxTimeoutSeconds: 60,
    },
  ],
}

function stubGateway(): GatewayClient {
  return {
    quote: vi.fn(async () => ({
      category: 'erc20.transfer' as const,
      bond: '125000',
      riskBps: 50,
      notionalUSD: '25',
      conditionSpec: { version: 1, chainId: 8453, evaluateAt: 'tx+1', confirmations: 3, checks: [] },
      rationale: 'stub',
    })),
    requestWarrant: vi.fn(async (_req, payment?: PaymentPayload) =>
      payment
        ? {
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
        : { status: 'payment-required' as const, paymentRequired: PAYMENT_REQUIRED },
    ),
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
  } as GatewayClient
}

describe('warrantTools', () => {
  it('exposes the four tools in the shape the Vercel AI SDK expects', () => {
    const tools = warrantTools({ client: stubGateway() })
    expect(Object.keys(tools).sort()).toEqual([
      'get_warrant',
      'list_warrants',
      'quote_risk',
      'request_warrant',
    ])
    for (const tool of Object.values(tools)) {
      expect(typeof tool.description).toBe('string')
      expect(typeof tool.execute).toBe('function')
      expect(tool.inputSchema).toBeDefined()
    }
  })

  it('runs quote_risk without payment', async () => {
    const tools = warrantTools({ client: stubGateway() })
    const result = (await tools['quote_risk']?.execute({ actionSpec: ACTION_SPEC })) as {
      category: string
    }
    expect(result.category).toBe('erc20.transfer')
  })

  it('settles the bond when a wallet is supplied', async () => {
    const tools = warrantTools({
      client: stubGateway(),
      wallet: {
        createPayment: (required) => ({
          x402Version: 2,
          resource: required.resource,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          accepted: required.accepts[0]!,
          payload: { type: 'proof' },
        }),
      },
    })

    const result = (await tools['request_warrant']?.execute({
      actionSpec: ACTION_SPEC,
      beneficiary: TREASURY,
    })) as { warrantId: string; settlement: { success: boolean } }

    expect(result.warrantId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(result.settlement.success).toBe(true)
  })

  it('returns the PaymentRequired to the model rather than throwing, with no wallet', async () => {
    const tools = warrantTools({ client: stubGateway() })
    const result = (await tools['request_warrant']?.execute({
      actionSpec: ACTION_SPEC,
      beneficiary: TREASURY,
    })) as { paymentRequired: PaymentRequired; hint: string }

    expect(result.paymentRequired.x402Version).toBe(2)
    expect(result.hint).toContain('wallet')
  })

  it('can expose a read-only subset only', () => {
    const tools = warrantTools({ client: stubGateway(), only: ['quote_risk', 'get_warrant'] })
    expect(Object.keys(tools).sort()).toEqual(['get_warrant', 'quote_risk'])
  })

  it('stays under 100 lines', () => {
    const source = readFileSync(fileURLToPath(new URL('./ai.ts', import.meta.url)), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return t !== '' && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//')
      })
    expect(code.length).toBeLessThan(100)
  })
})
