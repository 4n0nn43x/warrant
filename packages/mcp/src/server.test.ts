/**
 * Tests of the MCP server, run through a real MCP client.
 *
 * Everything goes through `InMemoryTransport` and the official `Client` rather
 * than through direct calls to the handlers: what we want to verify is what a
 * client — Claude Code, ElizaOS, any of them — actually sees on the wire. A test
 * that calls the handler directly validates our code; this one validates the
 * protocol.
 *
 * **This file tests the 2025 era.** `Client.connect()` negotiates `mode:
 * 'legacy'` by default (the 2026-07-28 revision is only selected via a
 * `server/discover` probe, cf. `ClientOptions.versionNegotiation`), and the probe
 * does not exist on `InMemoryTransport`. Far from being a limitation, that is
 * what makes this file valuable after the migration: it proves, behaviour by
 * behaviour, that a client still on 2025 gets exactly what it got before. The
 * 2026-07-28 era is covered over a real socket in `http.test.ts`, where the probe
 * can take place.
 */

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server'
import type { PaymentPayload, PaymentRequired } from '@warrant/sdk'
import { X402_PAYMENT_META_KEY, X402_PAYMENT_RESPONSE_META_KEY } from '@warrant/sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMockGateway, type MockGateway } from './mock-gateway.js'
import { createWarrantMcpServer } from './server.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const AGENT = '0x1111111111111111111111111111111111111111'
const TREASURY = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const REGISTRY_REF = `0x${'ab'.repeat(32)}`

/** `transfer(0x3333…, 25_000_000)` — 25 USDC. */
const TRANSFER_CALLDATA =
  '0xa9059cbb' +
  '0000000000000000000000003333333333333333333333333333333333333333' +
  '00000000000000000000000000000000000000000000000000000000017d7840'

const ACTION_SPEC = {
  version: 1 as const,
  chainId: 8453,
  target: USDC,
  value: '0',
  calldata: TRANSFER_CALLDATA,
  registryRef: REGISTRY_REF,
}

async function connect(gateway: MockGateway) {
  const server = createWarrantMcpServer({ client: gateway })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'warrant-test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

function structured<T>(result: CallToolResult): T {
  return result.structuredContent as T
}

function firstText(result: CallToolResult): string {
  const block = result.content[0]
  if (!block || block.type !== 'text') throw new Error('content[0] is not a text block')
  return block.text
}

/** A plausible payment. The mocked Gateway takes it on trust. */
function paymentFor(required: PaymentRequired): PaymentPayload {
  const accepted = required.accepts[0]
  if (!accepted) throw new Error('PaymentRequired with no offer')
  return {
    x402Version: 2,
    resource: { url: required.resource.url },
    accepted,
    payload: {
      signature: `0x${'2d'.repeat(65)}`,
      authorization: {
        from: AGENT,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: '1785000000',
        validBefore: '1785000060',
        nonce: `0x${'f3'.repeat(32)}`,
      },
    },
    extensions: {},
  }
}

let gateway: MockGateway

beforeEach(() => {
  gateway = createMockGateway()
})

// ─────────────────────────────────────────────────────────────────────────────

describe('tools/list', () => {
  it('exposes exactly four tools — not five', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_warrant',
      'list_warrants',
      'quote_risk',
      'request_warrant',
    ])
    // `execute_metered` left along with the routine regime (docs/09 § 2).
    expect(tools.map((t) => t.name)).not.toContain('execute_metered')
  })

  it('publishes a usable input JSON Schema for every tool', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()

    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties, `${tool.name} has no properties`).toBeDefined()
      // An undocumented property is a property the model will fill in badly.
      expect(JSON.stringify(tool.inputSchema)).toContain('description')
    }
  })

  it('declares the right required fields', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    expect(byName['quote_risk']?.inputSchema.required).toEqual(['actionSpec'])
    expect(byName['request_warrant']?.inputSchema.required).toEqual([
      'actionSpec',
      'beneficiary',
    ])
    expect(byName['get_warrant']?.inputSchema.required).toEqual(['warrantId'])
    expect(byName['list_warrants']?.inputSchema.required).toEqual(['agent'])
  })

  it('accepts neither category nor notional in any schema', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()

    for (const tool of tools) {
      const properties = tool.inputSchema.properties as Record<string, unknown> | undefined
      const actionSpec = properties?.['actionSpec'] as
        | { properties?: Record<string, unknown> }
        | undefined

      expect(Object.keys(properties ?? {})).not.toContain('notional')
      expect(Object.keys(properties ?? {})).not.toContain('notionalUSD')
      if (tool.name !== 'list_warrants') {
        // `list_warrants` filters after the fact on an already-derived category —
        // it is the only place where the word may legitimately appear.
        expect(Object.keys(properties ?? {})).not.toContain('category')
      }
      if (actionSpec) {
        expect(Object.keys(actionSpec.properties ?? {}).sort()).toEqual([
          'calldata',
          'chainId',
          'registryRef',
          'target',
          'value',
          'version',
        ])
      }
    }
  })

  it('signals which tool is paid', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()
    const paid = tools.filter((t) => t._meta?.['x402/paid'] === true).map((t) => t.name)

    expect(paid).toEqual(['request_warrant'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('quote_risk — free', () => {
  it('returns a quote without requiring payment', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: ACTION_SPEC },
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    const quote = structured<{ category: string; bond: string; riskBps: number }>(result)
    expect(quote.category).toBe('erc20.transfer')
    expect(quote.riskBps).toBe(50)
    expect(BigInt(quote.bond)).toBeGreaterThan(0n)
    expect(result._meta?.[X402_PAYMENT_RESPONSE_META_KEY]).toBeUndefined()
  })

  it('returns the post-condition that will be committed', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
    })) as CallToolResult

    const quote = structured<{ conditionSpec: { checks: { kind: string }[] } }>(result)
    expect(quote.conditionSpec.checks.map((c) => c.kind)).toContain(
      'calldata_matches_commitment',
    )
  })

  it('serialises the same object into both formats', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: ACTION_SPEC },
    })) as CallToolResult

    expect(JSON.parse(firstText(result))).toEqual(result.structuredContent)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('request_warrant — x402 v2 transport over MCP', () => {
  it('without payment: isError, carrying the PaymentRequired in both formats', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
    })) as CallToolResult

    // Step 2 of the flow (docs/05 § 1.7).
    expect(result.isError).toBe(true)

    const fromStructured = structured<PaymentRequired>(result)
    expect(fromStructured.x402Version).toBe(2)
    expect(fromStructured.accepts).toHaveLength(1)
    expect(fromStructured.accepts[0]?.scheme).toBe('exact')
    expect(fromStructured.accepts[0]?.network).toBe('eip155:8453')
    expect(fromStructured.resource.url).toBeTruthy()

    // The dual-format requirement: `content[0].text` is exactly
    // `JSON.stringify` of `structuredContent`.
    const fromText = JSON.parse(firstText(result)) as PaymentRequired
    expect(fromText).toEqual(fromStructured)
    expect(firstText(result)).toBe(JSON.stringify(fromStructured))

    // No warrant was opened.
    expect(gateway.warrants.size).toBe(0)
  })

  it('keeps the two formats equivalent field by field', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
    })) as CallToolResult

    const structuredKeys = Object.keys(result.structuredContent ?? {}).sort()
    const textKeys = Object.keys(JSON.parse(firstText(result)) as object).sort()
    expect(textKeys).toEqual(structuredKeys)
    // A client that can only read the text must still get a payable object.
    const parsed = JSON.parse(firstText(result)) as PaymentRequired
    expect(parsed.accepts[0]?.amount).toBe(
      structured<PaymentRequired>(result).accepts[0]?.amount,
    )
  })

  it('with the payment in _meta: success, settlement in _meta', async () => {
    const { client } = await connect(gateway)
    const args = { actionSpec: ACTION_SPEC, beneficiary: TREASURY }

    const challenge = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
    })) as CallToolResult
    const required = structured<PaymentRequired>(challenge)

    // Steps 3 and 4: the client replays with the payment in `_meta`.
    const settled = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
      _meta: { [X402_PAYMENT_META_KEY]: paymentFor(required) },
    })) as CallToolResult

    expect(settled.isError).toBeFalsy()
    const warrant = structured<{
      warrantId: string
      executionId: string
      conditionHash: string
      actionHash: string
      expiry: number
    }>(settled)
    expect(warrant.warrantId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(warrant.executionId).toBeTruthy()
    expect(warrant.conditionHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(warrant.actionHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(warrant.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // Step 6: the settlement travels in `_meta["x402/payment-response"]`.
    const settlement = settled._meta?.[X402_PAYMENT_RESPONSE_META_KEY] as {
      success: boolean
      transaction: string
      amount: string
    }
    expect(settlement.success).toBe(true)
    expect(settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/)
    expect(settlement.amount).toBe(required.accepts[0]?.amount)

    // The payment did reach the Gateway.
    expect(gateway.seen.payments.at(-1)).toBeDefined()
  })

  it('treats a malformed _meta["x402/payment"] as absent', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
      _meta: { [X402_PAYMENT_META_KEY]: { nope: true } },
    })) as CallToolResult

    // A fresh challenge, not a protocol error: the client can correct itself.
    expect(result.isError).toBe(true)
    expect(structured<PaymentRequired>(result).x402Version).toBe(2)
  })

  it('makes the bond independent of the client — two calls, same amount', async () => {
    const { client } = await connect(gateway)
    const args = { actionSpec: ACTION_SPEC, beneficiary: TREASURY }

    const a = (await client.callTool({ name: 'request_warrant', arguments: args })) as CallToolResult
    const b = (await client.callTool({ name: 'request_warrant', arguments: args })) as CallToolResult

    expect(structured<PaymentRequired>(a).accepts[0]?.amount).toBe(
      structured<PaymentRequired>(b).accepts[0]?.amount,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('nothing is declared, everything is derived', () => {
  it('ignores a stray `category` field inside the actionSpec', async () => {
    const { client } = await connect(gateway)

    const honest = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: ACTION_SPEC },
    })) as CallToolResult

    const cheating = (await client.callTool({
      name: 'quote_risk',
      arguments: {
        actionSpec: { ...ACTION_SPEC, category: 'aavev3.repay', notionalUSD: '1' },
      },
    })) as CallToolResult

    expect(cheating.isError).toBeFalsy()
    // The price is identical: the field had no effect.
    expect(structured(cheating)).toEqual(structured(honest))

    // And above all: the Gateway never saw the field. That is what counts, since
    // the `actionHash` is computed over what it receives — a stray field that
    // survived that far would change the commitment.
    const forwarded = gateway.seen.actionSpecs.at(-1) as unknown as Record<string, unknown>
    expect(forwarded).not.toHaveProperty('category')
    expect(forwarded).not.toHaveProperty('notionalUSD')
    expect(Object.keys(forwarded).sort()).toEqual([
      'calldata',
      'chainId',
      'registryRef',
      'target',
      'value',
      'version',
    ])
  })

  it('does not let a stray `category` change the bond required either', async () => {
    const { client } = await connect(gateway)

    const honest = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
    })) as CallToolResult

    const cheating = (await client.callTool({
      name: 'request_warrant',
      arguments: {
        actionSpec: { ...ACTION_SPEC, category: 'aavev3.repay' },
        beneficiary: TREASURY,
      },
    })) as CallToolResult

    expect(structured<PaymentRequired>(cheating).accepts[0]?.amount).toBe(
      structured<PaymentRequired>(honest).accepts[0]?.amount,
    )
  })

  it('ignores a top-level `category` too', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: ACTION_SPEC, category: 'aavev3.repay', notional: '1' },
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(structured<{ category: string }>(result).category).toBe('erc20.transfer')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('get_warrant', () => {
  it('returns the warrant and its checks[] array', async () => {
    const { client } = await connect(gateway)
    const args = { actionSpec: ACTION_SPEC, beneficiary: TREASURY }
    const challenge = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
    })) as CallToolResult
    const opened = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
      _meta: { [X402_PAYMENT_META_KEY]: paymentFor(structured<PaymentRequired>(challenge)) },
    })) as CallToolResult
    const { warrantId } = structured<{ warrantId: string }>(opened)

    const result = (await client.callTool({
      name: 'get_warrant',
      arguments: { warrantId },
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    const view = structured<{ warrantId: string; status: number; checks: unknown[] }>(result)
    expect(view.warrantId).toBe(warrantId)
    expect(view.status).toBe(1) // Open
    expect(Array.isArray(view.checks)).toBe(true)
  })

  it('exposes the full verdict once the warrant is settled', async () => {
    const { client } = await connect(gateway)
    const id = `0x${'0c'.repeat(32)}`
    gateway.warrants.set(id as `0x${string}`, {
      warrantId: id as `0x${string}`,
      agent: AGENT as `0x${string}`,
      beneficiary: TREASURY as `0x${string}`,
      bond: '25000000',
      conditionHash: `0x${'01'.repeat(32)}`,
      actionHash: `0x${'02'.repeat(32)}`,
      expiry: 1785000000,
      openedAt: 1784999000,
      status: 3, // Slashed
      checks: [
        { kind: 'erc20_balance_delta', expected: '-25000000', observed: '-30000000', pass: false },
        { kind: 'calldata_matches_commitment', expected: 'match', observed: 'match', pass: true },
      ],
      verdict: {
        verdict: 'slashed',
        evaluatedAtBlock: '31337',
        rpcUrl: 'https://mainnet.base.org',
      },
    })

    const result = (await client.callTool({
      name: 'get_warrant',
      arguments: { warrantId: id },
    })) as CallToolResult

    const view = structured<{
      verdict: { verdict: string; evaluatedAtBlock: string }
      checks: { pass: boolean }[]
    }>(result)
    expect(view.verdict.verdict).toBe('slashed')
    expect(view.verdict.evaluatedAtBlock).toBe('31337')
    // The checks that pass are published as well: without them, the verdict is
    // not auditable.
    expect(view.checks).toHaveLength(2)
    expect(view.checks.filter((c) => c.pass)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('list_warrants', () => {
  it('returns the history and the statistics', async () => {
    const { client } = await connect(gateway)
    const args = { actionSpec: ACTION_SPEC, beneficiary: TREASURY }
    const challenge = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
    })) as CallToolResult
    await client.callTool({
      name: 'request_warrant',
      arguments: args,
      _meta: { [X402_PAYMENT_META_KEY]: paymentFor(structured<PaymentRequired>(challenge)) },
    })

    const result = (await client.callTool({
      name: 'list_warrants',
      arguments: { agent: AGENT },
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    const list = structured<{ warrants: unknown[]; stats: { total: number; open: number } }>(result)
    expect(list.warrants).toHaveLength(1)
    expect(list.stats.total).toBe(1)
    expect(list.stats.open).toBe(1)
  })

  it('returns an empty history rather than an error for an unknown agent', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'list_warrants',
      arguments: { agent: '0x9999999999999999999999999999999999999999' },
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    const list = structured<{ warrants: unknown[]; stats: { total: number } }>(result)
    expect(list.warrants).toEqual([])
    expect(list.stats.total).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('actionable errors', () => {
  interface ErrorBody {
    error: { code: string; message: string; hint: string; docs: string; field?: string }
  }

  it('names the offending field and says what to do on an invalid address', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: 'not-an-address' },
    })) as CallToolResult

    expect(result.isError).toBe(true)
    const body = structured<ErrorBody>(result)
    expect(body.error.code).toBe('invalid_input')
    expect(body.error.field).toBe('$.beneficiary')
    expect(body.error.hint).toBeTruthy()
    expect(body.error.docs).toMatch(/^https:\/\//)
  })

  it('rejects a malformed calldata up front, with the field named', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: { ...ACTION_SPEC, calldata: '0xabc' } },
    })) as CallToolResult

    expect(result.isError).toBe(true)
    const body = structured<ErrorBody>(result)
    expect(body.error.field).toContain('calldata')
    expect(body.error.hint).toBeTruthy()
  })

  it('returns warrant_not_found for an unknown warrant, not a protocol error', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'get_warrant',
      arguments: { warrantId: `0x${'ff'.repeat(32)}` },
    })) as CallToolResult

    expect(result.isError).toBe(true)
    const body = structured<ErrorBody>(result)
    expect(body.error.code).toBe('warrant_not_found')
    expect(body.error.hint).toContain('list_warrants')
  })

  it('returns an error listing the existing tools for an unknown tool', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'execute_metered',
      arguments: {},
    })) as CallToolResult

    expect(result.isError).toBe(true)
    const body = structured<ErrorBody>(result)
    expect(body.error.hint).toContain('quote_risk')
    expect(body.error.hint).toContain('request_warrant')
  })

  it('keeps a Gateway outage actionable', async () => {
    const broken = createMockGateway()
    broken.quote = async () => {
      throw new Error('ECONNREFUSED')
    }
    const { client } = await connect(broken)
    const result = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: ACTION_SPEC },
    })) as CallToolResult

    expect(result.isError).toBe(true)
    const body = structured<ErrorBody>(result)
    expect(body.error.message).toContain('ECONNREFUSED')
    expect(body.error.hint).toBeTruthy()
    expect(body.error.docs).toBeTruthy()
  })

  it('makes every error carry hint and docs, and honour the dual format', async () => {
    const { client } = await connect(gateway)
    const cases = [
      { name: 'quote_risk', arguments: {} },
      { name: 'request_warrant', arguments: { actionSpec: ACTION_SPEC } },
      { name: 'get_warrant', arguments: { warrantId: '0xdeadbeef' } },
      { name: 'list_warrants', arguments: { agent: 'nope' } },
    ]

    for (const call of cases) {
      const result = (await client.callTool(call)) as CallToolResult
      expect(result.isError, `${call.name} should have failed`).toBe(true)
      const body = structured<ErrorBody>(result)
      expect(body.error.hint, `${call.name} has no hint`).toBeTruthy()
      expect(body.error.docs, `${call.name} has no docs`).toBeTruthy()
      expect(JSON.parse(firstText(result))).toEqual(result.structuredContent)
    }
  })
})
