/**
 * The streamable HTTP transport, tested over a real socket.
 *
 * `claude mcp add --transport http warrant …` is the first command a builder
 * types. If it fails, there is no second minute — hence a test that stands the
 * server up, queries it with the official HTTP client, and checks that the
 * payment flow crosses the transport intact.
 *
 * This is also the only place where the **2026-07-28** era is genuinely
 * exercised: the client only selects it after a `server/discover` probe, which
 * presupposes a real HTTP transport (`server.test.ts`, in memory, stays on 2025).
 * Some of the tests below therefore speak `fetch` directly, without the SDK: for
 * the *transport* requirements — mandatory headers, `-32020`, `405`,
 * `resultType`, `ttlMs` — the official client is a poor witness, since it sets
 * the right headers by itself and strips the wire fields out of the result before
 * handing it back to us. We want to see the byte, not the SDK's view of it.
 */

import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { PaymentRequired } from '@warrant/sdk'
import { X402_PAYMENT_META_KEY, X402_PAYMENT_RESPONSE_META_KEY } from '@warrant/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createWarrantHttpServer } from './http.js'
import { createMockGateway, type MockGateway } from './mock-gateway.js'

const PROTOCOL_VERSION = '2026-07-28'

const TREASURY = '0x2222222222222222222222222222222222222222'
const ACTION_SPEC = {
  version: 1 as const,
  chainId: 8453,
  target: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  value: '0',
  calldata:
    '0xa9059cbb' +
    '0000000000000000000000003333333333333333333333333333333333333333' +
    '00000000000000000000000000000000000000000000000000000000017d7840',
  registryRef: `0x${'ab'.repeat(32)}`,
}

let gateway: MockGateway
let httpServer: ReturnType<typeof createWarrantHttpServer>
let baseUrl: string
let mcpUrl: string

beforeAll(async () => {
  gateway = createMockGateway()
  httpServer = createWarrantHttpServer({ client: gateway })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  mcpUrl = `${baseUrl}/mcp`
})

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

/**
 * A client pinned to 2026-07-28.
 *
 * The v2 SDK default is `mode: 'legacy'` — connecting without specifying
 * anything would speak 2025 and would not test what we think we are testing.
 * `pin` fails loudly if the server cannot serve the revision, which is exactly
 * the assertion we want.
 */
async function connect() {
  const client = new Client(
    { name: 'warrant-http-test', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
  return client
}

/** The `_meta` envelope that 2026-07-28 makes mandatory on every request. */
function envelope() {
  return {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'warrant-raw-test', version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

/** A raw MCP POST: we choose every header ourselves. */
async function rawPost(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('streamable HTTP transport', () => {
  it('answers on /health', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('returns an actionable 404 outside the MCP path', async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { hint: string } }
    expect(body.error.hint).toContain('claude mcp add')
  })

  it('serves the four tools over HTTP', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(4)
    await client.close()
  })

  it('carries the x402 flow end to end over HTTP', async () => {
    const client = await connect()
    const args = { actionSpec: ACTION_SPEC, beneficiary: TREASURY }

    const challenge = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
    })) as CallToolResult
    expect(challenge.isError).toBe(true)
    const required = challenge.structuredContent as unknown as PaymentRequired
    expect(JSON.parse((challenge.content[0] as { text: string }).text)).toEqual(required)

    const accepted = required.accepts[0]
    if (!accepted) throw new Error('PaymentRequired with no offer')
    const settled = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
      _meta: {
        [X402_PAYMENT_META_KEY]: {
          x402Version: 2,
          resource: { url: required.resource.url },
          accepted,
          payload: { signature: `0x${'2d'.repeat(65)}`, authorization: { from: TREASURY } },
        },
      },
    })) as CallToolResult

    expect(settled.isError).toBeFalsy()
    expect(settled._meta?.[X402_PAYMENT_RESPONSE_META_KEY]).toMatchObject({ success: true })
    await client.close()
  })

  it('refuses an unknown browser origin, before any routing', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; hint: string } }
    expect(body.error.code).toBe('forbidden_origin')
    expect(body.error.hint).toContain('DNS rebinding')
  })

  it('accepts a local origin, and the absence of an origin', async () => {
    const local = await fetch(`${baseUrl}/health`, { headers: { origin: 'http://localhost:5173' } })
    expect(local.status).toBe(200)
    // Claude Code and the SDK send no Origin: the spec only targets the header
    // when it is present and invalid.
    const none = await fetch(`${baseUrl}/health`)
    expect(none.status).toBe(200)
  })

  it('stays stateless: two successive clients are served independently', async () => {
    const a = await connect()
    const b = await connect()
    const [ra, rb] = await Promise.all([a.listTools(), b.listTools()])
    expect(ra.tools).toHaveLength(4)
    expect(rb.tools).toHaveLength(4)
    await Promise.all([a.close(), b.close()])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// What the 2026-07-28 revision adds on the wire.
// ─────────────────────────────────────────────────────────────────────────────

describe('2026-07-28 revision — the wire', () => {
  it('serves the revision without initialize or Mcp-Session-Id', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
    )

    expect(res.status).toBe(200)
    // The protocol is stateless: the server stamps no session.
    expect(res.headers.get('mcp-session-id')).toBeNull()
    const body = (await res.json()) as { result: { tools: unknown[] } }
    expect(body.result.tools).toHaveLength(4)
  })

  it('sets resultType: "complete" on every result', async () => {
    const list = await rawPost(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
    )
    expect(((await list.json()) as { result: { resultType: string } }).result.resultType).toBe(
      'complete',
    )

    // Including — and this is the case that matters — on the payment challenge,
    // which is an erroring result: `isError` and `resultType` are two independent
    // axes. The second says the exchange is over, not that it succeeded.
    const call = await rawPost(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'request_warrant',
          arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
          _meta: envelope(),
        },
      },
      {
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'request_warrant',
      },
    )
    const { result } = (await call.json()) as {
      result: { resultType: string; isError: boolean; structuredContent: PaymentRequired }
    }
    expect(result.resultType).toBe('complete')
    expect(result.isError).toBe(true)
    expect(result.structuredContent.x402Version).toBe(2)
  })

  it('announces ttlMs and cacheScope on tools/list', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
    )
    const { result } = (await res.json()) as { result: { ttlMs: number; cacheScope: string } }

    // Our four tools are frozen at compile time: reloading them on every agent
    // turn is pure waste.
    expect(result.ttlMs).toBe(3_600_000)
    // The list depends on no authorization: a shared cache is legitimate.
    expect(result.cacheScope).toBe('public')
  })

  it('rejects an Mcp-Name that lies about the body — 400 and -32020', async () => {
    const res = await rawPost(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'quote_risk', arguments: { actionSpec: ACTION_SPEC }, _meta: envelope() },
      },
      {
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'tools/call',
        // An intermediary routing on the header would believe this to be a paid
        // call where the body calls a free one — or the other way round. That is
        // exactly the divergence the header↔body validation closes.
        'Mcp-Name': 'request_warrant',
      },
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32020)
    expect(body.error.message).toContain('quote_risk')
  })

  it('rejects an Mcp-Method that lies about the body', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/call' },
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020)
  })

  it('rejects a header version that lies about the envelope', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/list' },
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020)
  })

  it('answers 405 on GET and DELETE — no more GET stream, no session to close', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fetch(mcpUrl, {
        method,
        headers: { accept: 'text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION },
      })
      expect(res.status, `${method} should have been refused`).toBe(405)
    }
  })

  it('ignores Last-Event-ID: the streams are not resumable', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: envelope() } },
      {
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
        'Last-Event-ID': '42',
      },
    )

    // Ignored, not rejected: the spec asks that it be disregarded.
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('backward compatibility', () => {
  /**
   * The migration cuts nobody off. A 2025 client sends no envelope header;
   * `createMcpHandler` routes it to a sessionless 2025 service, carried by the
   * same factory and therefore by the same four tools. One day after the
   * revision was published, that is still most of the installed base.
   */
  it('serves a client with no envelope header (2025 era)', async () => {
    const res = await rawPost({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, {})

    expect(res.status).toBe(200)
    // The fallback may answer in SSE: we read the raw text and look for the
    // payload in it, without presuming the framing.
    const text = await res.text()
    expect(text).toContain('quote_risk')
    expect(text).toContain('request_warrant')
    // The 2026 vocabulary has no business in a 2025 response: a client that does
    // not know it should not have to ignore it.
    expect(text).not.toContain('resultType')
    expect(text).not.toContain('cacheScope')
  })

  it('makes the x402 flow work for a 2025 client too', async () => {
    // No negotiation option: this is the SDK default, hence 2025.
    const client = new Client({ name: 'warrant-2025-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))

    const challenge = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
    })) as CallToolResult

    expect(challenge.isError).toBe(true)
    const required = challenge.structuredContent as unknown as PaymentRequired
    expect(required.x402Version).toBe(2)
    expect(JSON.parse((challenge.content[0] as { text: string }).text)).toEqual(required)
    await client.close()
  })
})
