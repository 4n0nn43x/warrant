/**
 * Tests of the HTTP client.
 *
 * The HTTP rail of x402 v2 uses headers that were renamed between v1 and v2
 * (`X-PAYMENT` → `PAYMENT-SIGNATURE`, docs/05 § 1.2). Getting a header wrong
 * produces a 402 loop with no useful error message — hence tests that check the
 * names literally.
 */

import { describe, expect, it, vi } from 'vitest'

import { WarrantClient } from './client.js'
import type { PaymentRequired, SettlementResponse } from './x402.js'

const TREASURY = '0x2222222222222222222222222222222222222222'
const ACTION_SPEC = {
  version: 1 as const,
  chainId: 8453,
  target: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
  value: '0',
  calldata: `0xa9059cbb${'00'.repeat(31)}03${'00'.repeat(28)}017d7840` as `0x${string}`,
  registryRef: `0x${'ab'.repeat(32)}` as `0x${string}`,
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

const SETTLEMENT: SettlementResponse = {
  success: true,
  transaction: `0x${'ab'.repeat(32)}`,
  network: 'eip155:8453',
  payer: TREASURY,
  amount: '125000',
}

function b64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

describe('WarrantClient', () => {
  it('translates a 402 into payment-required rather than an exception', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': b64(PAYMENT_REQUIRED) },
        }),
    )
    const client = new WarrantClient({ baseUrl: 'https://gateway.example', fetch: fetchMock })

    const result = await client.requestWarrant({
      actionSpec: ACTION_SPEC,
      beneficiary: TREASURY as `0x${string}`,
    })

    expect(result.status).toBe('payment-required')
    if (result.status === 'payment-required') {
      expect(result.paymentRequired.accepts[0]?.amount).toBe('125000')
    }
  })

  it('sends the payment in PAYMENT-SIGNATURE and reads PAYMENT-RESPONSE', async () => {
    const opened = {
      warrantId: `0x${'01'.repeat(32)}`,
      executionId: 'exec_1',
      conditionHash: `0x${'02'.repeat(32)}`,
      actionHash: `0x${'03'.repeat(32)}`,
      expiry: 1785000000,
    }
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (!headers['PAYMENT-SIGNATURE']) {
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': b64(PAYMENT_REQUIRED) },
        })
      }
      return new Response(JSON.stringify(opened), {
        status: 200,
        headers: { 'content-type': 'application/json', 'PAYMENT-RESPONSE': b64(SETTLEMENT) },
      })
    })

    const client = new WarrantClient({
      baseUrl: 'https://gateway.example',
      fetch: fetchMock as unknown as typeof fetch,
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

    const outcome = await client.call('request_warrant', {
      actionSpec: ACTION_SPEC,
      beneficiary: TREASURY,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.data).toMatchObject({ warrantId: opened.warrantId })
      expect(outcome.settlement).toEqual(SETTLEMENT)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('flattens the Gateway envelope and translates the status into an integer', async () => {
    const envelope = {
      warrant: {
        id: `0x${'01'.repeat(32)}`,
        agent: TREASURY,
        beneficiary: TREASURY,
        bond: '125000',
        conditionHash: `0x${'02'.repeat(32)}`,
        actionHash: `0x${'03'.repeat(32)}`,
        fundingRef: `0x${'04'.repeat(32)}`,
        expiry: 1785000000,
        openedAt: 1784999000,
        status: 'Slashed',
      },
      execution: { executionId: 'exec_1' },
      quote: { category: 'erc20.transfer' },
      actionSpec: ACTION_SPEC,
      verdict: { verdict: 'slashed', evaluatedAtBlock: '31337' },
      checks: [{ kind: 'erc20_balance_delta', expected: '0', observed: '-1', pass: false }],
    }
    const client = new WarrantClient({
      baseUrl: 'https://gateway.example',
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ) as unknown as typeof fetch,
    })

    const view = await client.getWarrant(`0x${'01'.repeat(32)}`)
    expect(view).toMatchObject({
      warrantId: envelope.warrant.id,
      status: 3,
      executionId: 'exec_1',
      category: 'erc20.transfer',
    })
    expect(view?.checks).toHaveLength(1)
    expect(view?.verdict?.verdict).toBe('slashed')
    expect(view).not.toHaveProperty('id')
  })

  it('lets an already-flat response through', async () => {
    const flat = {
      warrantId: `0x${'01'.repeat(32)}`,
      agent: TREASURY,
      beneficiary: TREASURY,
      bond: '1',
      conditionHash: `0x${'02'.repeat(32)}`,
      actionHash: `0x${'03'.repeat(32)}`,
      expiry: 1,
      openedAt: 0,
      status: 1,
      checks: [],
    }
    const client = new WarrantClient({
      baseUrl: 'https://gateway.example',
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify(flat), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ) as unknown as typeof fetch,
    })
    await expect(client.getWarrant(flat.warrantId as `0x${string}`)).resolves.toEqual(flat)
  })

  it('returns null — not an exception — for a missing warrant', async () => {
    const client = new WarrantClient({
      baseUrl: 'https://gateway.example',
      fetch: vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    })
    await expect(client.getWarrant(`0x${'ff'.repeat(32)}`)).resolves.toBeNull()
  })

  it('turns a network failure into an actionable error', async () => {
    const client = new WarrantClient({
      baseUrl: 'https://gateway.example',
      fetch: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    await expect(client.quote({ actionSpec: ACTION_SPEC })).rejects.toMatchObject({
      code: 'gateway_unreachable',
    })
  })

  it('serialises the list_warrants filters into a query string', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const client = new WarrantClient({
      baseUrl: 'https://gateway.example',
      fetch: fetchMock as unknown as typeof fetch,
    })

    await client.listWarrants({ agent: TREASURY as `0x${string}`, status: 'slashed', limit: 5 })

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('agent=')
    expect(url).toContain('status=slashed')
    expect(url).toContain('limit=5')
  })

  it('explains what to do when no wallet is configured', async () => {
    const client = new WarrantClient({
      baseUrl: 'https://gateway.example',
      fetch: vi.fn(
        async () =>
          new Response(null, {
            status: 402,
            headers: { 'PAYMENT-REQUIRED': b64(PAYMENT_REQUIRED) },
          }),
      ) as unknown as typeof fetch,
    })

    await expect(
      client.openWarrant({ actionSpec: ACTION_SPEC, beneficiary: TREASURY }),
    ).rejects.toMatchObject({ code: 'payment_invalid' })
  })
})
