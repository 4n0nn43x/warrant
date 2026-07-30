/**
 * Tests du serveur MCP, exécutés à travers un vrai client MCP.
 *
 * Tout passe par `InMemoryTransport` et le `Client` officiel plutôt que par des
 * appels directs aux handlers : ce qu'on veut vérifier, c'est ce qu'un client —
 * Claude Code, ElizaOS, n'importe lequel — voit réellement sur le fil. Un test
 * qui appelle le handler en direct valide notre code ; celui-ci valide le
 * protocole.
 *
 * **Ce fichier teste l'ère 2025.** `Client.connect()` négocie par défaut
 * `mode: 'legacy'` (la révision 2026-07-28 ne se sélectionne que via un probe
 * `server/discover`, cf. `ClientOptions.versionNegotiation`), et le probe
 * n'existe pas sur `InMemoryTransport`. Loin d'être une limite, c'est ce qui
 * fait la valeur de ce fichier après la migration : il prouve, comportement par
 * comportement, qu'un client resté en 2025 obtient exactement ce qu'il obtenait
 * avant. L'ère 2026-07-28 est couverte sur vraie socket dans `http.test.ts`,
 * où le probe peut avoir lieu.
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
  if (!block || block.type !== 'text') throw new Error('content[0] n\'est pas un bloc texte')
  return block.text
}

/** Un paiement plausible. Le Gateway mocké l'accepte sur parole. */
function paymentFor(required: PaymentRequired): PaymentPayload {
  const accepted = required.accepts[0]
  if (!accepted) throw new Error('PaymentRequired sans offre')
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
  it('expose exactement quatre outils — pas cinq', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_warrant',
      'list_warrants',
      'quote_risk',
      'request_warrant',
    ])
    // `execute_metered` est parti avec le régime routine (docs/09 § 2).
    expect(tools.map((t) => t.name)).not.toContain('execute_metered')
  })

  it('publie un JSON Schema d\'entrée exploitable pour chaque outil', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()

    for (const tool of tools) {
      expect(tool.description, `${tool.name} sans description`).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties, `${tool.name} sans properties`).toBeDefined()
      // Une propriété non documentée est une propriété que le modèle remplira mal.
      expect(JSON.stringify(tool.inputSchema)).toContain('description')
    }
  })

  it('déclare les bons champs requis', async () => {
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

  it('n\'accepte ni category ni notional dans aucun schéma', async () => {
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
        // `list_warrants` filtre a posteriori sur une catégorie déjà dérivée —
        // c'est le seul endroit où le mot peut légitimement apparaître.
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

  it('signale quel outil est payant', async () => {
    const { client } = await connect(gateway)
    const { tools } = await client.listTools()
    const paid = tools.filter((t) => t._meta?.['x402/paid'] === true).map((t) => t.name)

    expect(paid).toEqual(['request_warrant'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('quote_risk — gratuit', () => {
  it('rend un devis sans exiger de paiement', async () => {
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

  it('rend la post-condition qui sera engagée', async () => {
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

  it('sérialise le même objet dans les deux formats', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'quote_risk',
      arguments: { actionSpec: ACTION_SPEC },
    })) as CallToolResult

    expect(JSON.parse(firstText(result))).toEqual(result.structuredContent)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('request_warrant — transport x402 v2 sur MCP', () => {
  it('sans paiement : isError, avec le PaymentRequired dans les deux formats', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
    })) as CallToolResult

    // Étape 2 du flux (docs/05 § 1.7).
    expect(result.isError).toBe(true)

    const fromStructured = structured<PaymentRequired>(result)
    expect(fromStructured.x402Version).toBe(2)
    expect(fromStructured.accepts).toHaveLength(1)
    expect(fromStructured.accepts[0]?.scheme).toBe('exact')
    expect(fromStructured.accepts[0]?.network).toBe('eip155:8453')
    expect(fromStructured.resource.url).toBeTruthy()

    // L'exigence du double format : `content[0].text` est exactement
    // `JSON.stringify` de `structuredContent`.
    const fromText = JSON.parse(firstText(result)) as PaymentRequired
    expect(fromText).toEqual(fromStructured)
    expect(firstText(result)).toBe(JSON.stringify(fromStructured))

    // Aucun mandat n'a été ouvert.
    expect(gateway.warrants.size).toBe(0)
  })

  it('les deux formats restent équivalents champ par champ', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
    })) as CallToolResult

    const structuredKeys = Object.keys(result.structuredContent ?? {}).sort()
    const textKeys = Object.keys(JSON.parse(firstText(result)) as object).sort()
    expect(textKeys).toEqual(structuredKeys)
    // Un client qui ne sait lire que le texte doit obtenir un objet payable.
    const parsed = JSON.parse(firstText(result)) as PaymentRequired
    expect(parsed.accepts[0]?.amount).toBe(
      structured<PaymentRequired>(result).accepts[0]?.amount,
    )
  })

  it('avec paiement dans _meta : succès, règlement dans _meta', async () => {
    const { client } = await connect(gateway)
    const args = { actionSpec: ACTION_SPEC, beneficiary: TREASURY }

    const challenge = (await client.callTool({
      name: 'request_warrant',
      arguments: args,
    })) as CallToolResult
    const required = structured<PaymentRequired>(challenge)

    // Étapes 3 et 4 : le client rejoue avec le paiement dans `_meta`.
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

    // Étape 6 : le règlement voyage dans `_meta["x402/payment-response"]`.
    const settlement = settled._meta?.[X402_PAYMENT_RESPONSE_META_KEY] as {
      success: boolean
      transaction: string
      amount: string
    }
    expect(settlement.success).toBe(true)
    expect(settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/)
    expect(settlement.amount).toBe(required.accepts[0]?.amount)

    // Le paiement a bien atteint le Gateway.
    expect(gateway.seen.payments.at(-1)).toBeDefined()
  })

  it('un _meta["x402/payment"] malformé est traité comme absent', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: TREASURY },
      _meta: { [X402_PAYMENT_META_KEY]: { nope: true } },
    })) as CallToolResult

    // Un nouveau challenge, pas une erreur de protocole : le client peut se corriger.
    expect(result.isError).toBe(true)
    expect(structured<PaymentRequired>(result).x402Version).toBe(2)
  })

  it('la caution ne dépend pas du client — deux appels, même montant', async () => {
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

describe('rien n\'est déclaré, tout est dérivé', () => {
  it('un champ `category` parasite dans l\'actionSpec est ignoré', async () => {
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
    // Le prix est identique : le champ n'a eu aucun effet.
    expect(structured(cheating)).toEqual(structured(honest))

    // Et surtout : le Gateway n'a jamais vu le champ. C'est ce qui compte, car
    // l'`actionHash` est calculé sur ce qu'il reçoit — un champ parasite qui
    // survivrait jusque-là changerait l'engagement.
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

  it('un `category` parasite ne change pas non plus la caution exigée', async () => {
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

  it('un `category` de premier niveau est ignoré lui aussi', async () => {
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
  it('rend le mandat et son tableau checks[]', async () => {
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

  it('expose le verdict complet quand le mandat est réglé', async () => {
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
    // Les vérifications qui passent sont publiées aussi : sans elles, le verdict
    // n'est pas auditable.
    expect(view.checks).toHaveLength(2)
    expect(view.checks.filter((c) => c.pass)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('list_warrants', () => {
  it('rend l\'historique et les statistiques', async () => {
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

  it('rend un historique vide plutôt qu\'une erreur pour un agent inconnu', async () => {
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

describe('erreurs actionnables', () => {
  interface ErrorBody {
    error: { code: string; message: string; hint: string; docs: string; field?: string }
  }

  it('une adresse invalide nomme le champ fautif et dit quoi faire', async () => {
    const { client } = await connect(gateway)
    const result = (await client.callTool({
      name: 'request_warrant',
      arguments: { actionSpec: ACTION_SPEC, beneficiary: 'pas-une-adresse' },
    })) as CallToolResult

    expect(result.isError).toBe(true)
    const body = structured<ErrorBody>(result)
    expect(body.error.code).toBe('invalid_input')
    expect(body.error.field).toBe('$.beneficiary')
    expect(body.error.hint).toBeTruthy()
    expect(body.error.docs).toMatch(/^https:\/\//)
  })

  it('un calldata malformé est rejeté à l\'ouverture, champ nommé', async () => {
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

  it('un mandat inconnu rend warrant_not_found, pas une erreur de protocole', async () => {
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

  it('un outil inconnu rend une erreur qui liste les outils existants', async () => {
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

  it('une panne du Gateway reste actionnable', async () => {
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

  it('toute erreur porte hint et docs, et respecte le double format', async () => {
    const { client } = await connect(gateway)
    const cases = [
      { name: 'quote_risk', arguments: {} },
      { name: 'request_warrant', arguments: { actionSpec: ACTION_SPEC } },
      { name: 'get_warrant', arguments: { warrantId: '0xdeadbeef' } },
      { name: 'list_warrants', arguments: { agent: 'nope' } },
    ]

    for (const call of cases) {
      const result = (await client.callTool(call)) as CallToolResult
      expect(result.isError, `${call.name} aurait dû échouer`).toBe(true)
      const body = structured<ErrorBody>(result)
      expect(body.error.hint, `${call.name} sans hint`).toBeTruthy()
      expect(body.error.docs, `${call.name} sans docs`).toBeTruthy()
      expect(JSON.parse(firstText(result))).toEqual(result.structuredContent)
    }
  })
})
