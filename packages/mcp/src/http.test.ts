/**
 * Le transport HTTP streamable, testé sur une vraie socket.
 *
 * `claude mcp add --transport http warrant …` est la première commande qu'un
 * builder tape. Si elle échoue, il n'y a pas de deuxième minute — d'où un test
 * qui monte le serveur, l'interroge avec le client HTTP officiel, et vérifie
 * que le flux de paiement traverse le transport intact.
 *
 * C'est aussi le seul endroit où l'ère **2026-07-28** est réellement exercée :
 * le client ne la sélectionne qu'après un probe `server/discover`, lequel
 * suppose un vrai transport HTTP (`server.test.ts`, en mémoire, reste en 2025).
 * Une partie des tests ci-dessous parle donc `fetch` directement, sans SDK :
 * pour les exigences de *transport* — en-têtes obligatoires, `-32020`, `405`,
 * `resultType`, `ttlMs` — le client officiel est un mauvais témoin, puisqu'il
 * pose les bons en-têtes tout seul et retire du résultat les champs de fil
 * avant de nous le rendre. On veut voir l'octet, pas la vue du SDK.
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
 * Un client épinglé sur 2026-07-28.
 *
 * Le défaut du SDK v2 est `mode: 'legacy'` — connecter sans rien préciser
 * parlerait 2025 et ne testerait pas ce qu'on croit tester. `pin` échoue
 * bruyamment si le serveur ne sait pas servir la révision, ce qui est
 * exactement l'assertion voulue.
 */
async function connect() {
  const client = new Client(
    { name: 'warrant-http-test', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
  return client
}

/** L'enveloppe `_meta` que 2026-07-28 rend obligatoire sur chaque requête. */
function envelope() {
  return {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'warrant-raw-test', version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

/** Un POST MCP brut : on choisit nous-mêmes chaque en-tête. */
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

  it('refuse une origine navigateur inconnue, avant tout routage', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; hint: string } }
    expect(body.error.code).toBe('forbidden_origin')
    expect(body.error.hint).toContain('DNS rebinding')
  })

  it('accepte une origine locale, et l’absence d’origine', async () => {
    const local = await fetch(`${baseUrl}/health`, { headers: { origin: 'http://localhost:5173' } })
    expect(local.status).toBe(200)
    // Claude Code et le SDK n'envoient pas d'Origin : la spec ne vise que
    // l'en-tête présent et invalide.
    const none = await fetch(`${baseUrl}/health`)
    expect(none.status).toBe(200)
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

// ─────────────────────────────────────────────────────────────────────────────
// Ce que la révision 2026-07-28 ajoute sur le fil.
// ─────────────────────────────────────────────────────────────────────────────

describe('révision 2026-07-28 — le fil', () => {
  it('sert la révision sans initialize ni Mcp-Session-Id', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
    )

    expect(res.status).toBe(200)
    // Le protocole est sans état : le serveur ne frappe aucune session.
    expect(res.headers.get('mcp-session-id')).toBeNull()
    const body = (await res.json()) as { result: { tools: unknown[] } }
    expect(body.result.tools).toHaveLength(4)
  })

  it('pose resultType: "complete" sur tout résultat', async () => {
    const list = await rawPost(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
    )
    expect(((await list.json()) as { result: { resultType: string } }).result.resultType).toBe(
      'complete',
    )

    // Y compris — et c'est le cas qui compte — sur le challenge de paiement,
    // qui est un résultat en erreur : `isError` et `resultType` sont deux axes
    // indépendants. Le second dit que l'échange est terminé, pas qu'il a réussi.
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

  it('annonce ttlMs et cacheScope sur tools/list', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
    )
    const { result } = (await res.json()) as { result: { ttlMs: number; cacheScope: string } }

    // Nos quatre outils sont figés à la compilation : les recharger à chaque
    // tour d'agent est du gaspillage pur.
    expect(result.ttlMs).toBe(3_600_000)
    // La liste ne dépend d'aucune autorisation : un cache partagé est légitime.
    expect(result.cacheScope).toBe('public')
  })

  it('rejette un Mcp-Name qui ment sur le corps — 400 et -32020', async () => {
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
        // Un intermédiaire qui routerait sur l'en-tête croirait à un appel
        // payant là où le corps en appelle un gratuit — ou l'inverse. C'est
        // exactement la divergence que la validation en-tête↔corps ferme.
        'Mcp-Name': 'request_warrant',
      },
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32020)
    expect(body.error.message).toContain('quote_risk')
  })

  it('rejette un Mcp-Method qui ment sur le corps', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/call' },
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020)
  })

  it('rejette une version d’en-tête qui ment sur l’enveloppe', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/list' },
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020)
  })

  it('répond 405 sur GET et DELETE — plus de flux GET ni de session à clore', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fetch(mcpUrl, {
        method,
        headers: { accept: 'text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION },
      })
      expect(res.status, `${method} aurait dû être refusé`).toBe(405)
    }
  })

  it('ignore Last-Event-ID : les flux ne sont pas reprenables', async () => {
    const res = await rawPost(
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: envelope() } },
      {
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
        'Last-Event-ID': '42',
      },
    )

    // Ignoré, pas rejeté : la spec demande de ne pas en tenir compte.
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('compatibilité descendante', () => {
  /**
   * La migration ne coupe personne. Un client 2025 n'envoie aucun en-tête
   * d'enveloppe ; `createMcpHandler` le route vers un service 2025 sans session,
   * porté par la même fabrique et donc par les mêmes quatre outils. Un jour
   * après la publication de la révision, c'est encore l'essentiel du parc.
   */
  it('sert un client sans en-tête d’enveloppe (ère 2025)', async () => {
    const res = await rawPost({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, {})

    expect(res.status).toBe(200)
    // Le repli peut répondre en SSE : on lit le texte brut et on y cherche la
    // charge utile, sans présumer du cadrage.
    const text = await res.text()
    expect(text).toContain('quote_risk')
    expect(text).toContain('request_warrant')
    // Le vocabulaire 2026 n'a rien à faire dans une réponse 2025 : un client
    // qui ne le connaît pas ne doit pas avoir à l'ignorer.
    expect(text).not.toContain('resultType')
    expect(text).not.toContain('cacheScope')
  })

  it('le flux x402 fonctionne aussi pour un client 2025', async () => {
    // Aucune option de négociation : c'est le défaut du SDK, donc 2025.
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
