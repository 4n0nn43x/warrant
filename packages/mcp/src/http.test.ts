/**
 * Le transport HTTP streamable, testé sur une vraie socket.
 *
 * `claude mcp add --transport http warrant …` est la première commande qu'un
 * builder tape. Si elle échoue, il n'y a pas de deuxième minute — d'où un test
 * qui monte le serveur, l'interroge avec le client HTTP officiel, et vérifie
 * que le flux de paiement traverse le transport intact.
 */

import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { PaymentRequired } from '@warrant/sdk'
import { X402_PAYMENT_META_KEY, X402_PAYMENT_RESPONSE_META_KEY } from '@warrant/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createWarrantHttpServer } from './http.js'
import { createMockGateway, type MockGateway } from './mock-gateway.js'

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

beforeAll(async () => {
  gateway = createMockGateway()
  httpServer = createWarrantHttpServer({ client: gateway })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))
  const client = new Client({ name: 'warrant-http-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

describe('transport HTTP streamable', () => {
  it('répond à /health', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('rend un 404 actionnable hors du chemin MCP', async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { hint: string } }
    expect(body.error.hint).toContain('claude mcp add')
  })

  it('sert les quatre outils à travers HTTP', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(4)
    await client.close()
  })

  it('porte le flux x402 de bout en bout sur HTTP', async () => {
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
    if (!accepted) throw new Error('PaymentRequired sans offre')
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

  it('reste sans état : deux clients successifs sont servis indépendamment', async () => {
    const a = await connect()
    const b = await connect()
    const [ra, rb] = await Promise.all([a.listTools(), b.listTools()])
    expect(ra.tools).toHaveLength(4)
    expect(rb.tools).toHaveLength(4)
    await Promise.all([a.close(), b.close()])
  })
})
