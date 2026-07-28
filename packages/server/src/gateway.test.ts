import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMMITMENT_KIND,
  loadRegistry,
  registryRefOf,
  type Address,
  type Hex,
  type Policy,
} from '@warrant/core'
import {
  createGateway,
  decodeActionSpec,
  encodeActionSpec,
  keeperHubCallOf,
  memoryWarrantStore,
  warrantIdOf,
  type ExecutionOutcome,
  type ExecutorPort,
  type GatewayConfig,
  type KeeperHubCall,
  type OpenWarrantArgs,
  type SimulationOutcome,
  type VerdictView,
} from './gateway.js'
import {
  HEADER_AUTHORIZATION,
  HEADER_PAYMENT_RECEIPT,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_WWW_AUTHENTICATE,
  decodeHeaderObject,
  decodeJcs,
  decodeReceipt,
  encodeCredential,
  encodeHeaderObject,
  parseChallengeHeader,
  type MppCredential,
  type MppRequestBody,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from './x402.js'

// ─────────────────────────────────────────────────────────────────────────────
// Décor
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = loadRegistry()
const REGISTRY_REF = registryRefOf(REGISTRY)

/** USDC natif Ethereum — présent au registre pour `transfer` et `approve`. */
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const DEST = `0x${'de'.repeat(20)}` as Address
const TREASURY = `0x${'71'.repeat(20)}` as Address
const BENEFICIARY = `0x${'be'.repeat(20)}` as Address
const VAULT = `0x${'a1'.repeat(20)}` as Address
const AGENT = `0x${'a9'.repeat(20)}` as Address
const SETTLEMENT_TX = `0x${'5e'.repeat(32)}` as Hex
const OPEN_TX = `0x${'0e'.repeat(32)}` as Hex

const NOW = 1_785_000_000

const POLICY: Policy = {
  beneficiary: BENEFICIARY,
  treasury: TREASURY,
  minBond: '5000000',
  maxBond: '250000000',
  duration: 3600,
  categories: {
    'erc20.transfer': { riskBps: 100, maxOutflow: '500000000', allowedDest: [DEST] },
    'erc20.approve': { riskBps: 50, maxOutflow: '0', allowedDest: [DEST] },
  },
}

/** `transfer(DEST, 100 USDC)` sur l'USDC Ethereum. */
function transferAction() {
  return encodeActionSpec({
    chainId: 1,
    target: USDC,
    signature: 'transfer(address,uint256)',
    args: [DEST, '100000000'],
    registryRef: REGISTRY_REF,
  })
}

/** Une action dont le couple (chainId, target, selector) est hors registre. */
function unknownAction() {
  return encodeActionSpec({
    chainId: 1,
    target: `0x${'99'.repeat(20)}` as Address,
    signature: 'poke(uint256)',
    args: ['1'],
    registryRef: REGISTRY_REF,
  })
}

const AUTHORIZATION = {
  from: AGENT,
  to: VAULT,
  value: '5000000',
  validAfter: String(NOW),
  validBefore: String(NOW + 60),
  nonce: `0x${'f3'.repeat(32)}` as Hex,
}

function requirements(amount = '5000000'): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount,
    asset: USDC_BASE,
    payTo: VAULT,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
  }
}

function x402Header(amount = '5000000'): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: 'http://warrant.test/v1/warrants' },
    accepted: requirements(amount),
    payload: {
      signature: `0x${'2d'.repeat(65)}` as Hex,
      authorization: { ...AUTHORIZATION, value: amount },
    },
    extensions: {},
  }
  return encodeHeaderObject(payload)
}

interface Harness {
  app: ReturnType<typeof createGateway>
  opened: OpenWarrantArgs[]
  simulated: KeeperHubCall[]
  executed: KeeperHubCall[]
  verified: number
  settled: number
  store: ReturnType<typeof memoryWarrantStore>
  verdicts: Map<string, VerdictView>
}

function harness(over: Partial<GatewayConfig> = {}): Harness {
  const opened: OpenWarrantArgs[] = []
  const simulated: KeeperHubCall[] = []
  const executed: KeeperHubCall[] = []
  const store = memoryWarrantStore()
  const verdicts = new Map<string, VerdictView>()
  const counters = { verified: 0, settled: 0 }

  const executor: ExecutorPort = {
    async simulateContractCall(call): Promise<SimulationOutcome> {
      simulated.push(call)
      return { success: true, wouldRevert: false, gasEstimate: '48000' }
    },
    async executeContractCall(call): Promise<ExecutionOutcome> {
      executed.push(call)
      return { executionId: 'exec_warrant_1', status: 'success' }
    },
  }

  const settlement: SettlementResponse = {
    success: true,
    transaction: SETTLEMENT_TX,
    network: 'eip155:8453',
    payer: AGENT,
    amount: '5000000',
  }

  const cfg: GatewayConfig = {
    registry: REGISTRY,
    policy: POLICY,
    baseUrl: 'http://warrant.test',
    realm: 'warrant.sh',
    network: 'eip155:8453',
    asset: USDC_BASE,
    payTo: VAULT,
    assetExtra: { name: 'USDC', version: '2' },
    facilitator: {
      async verify() {
        counters.verified++
        return { isValid: true, payer: AGENT }
      },
      async settle() {
        counters.settled++
        return settlement
      },
    },
    executor,
    escrow: {
      async open(args) {
        opened.push(args)
        return OPEN_TX
      },
    },
    mppSecret: 'secret-de-test',
    mppCurrency: 'USDC',
    store,
    verdicts: { get: (id) => verdicts.get(id.toLowerCase()) },
    now: () => NOW,
    challengeSalt: (() => {
      let n = 0
      return () => `salt-${n++}`
    })(),
    ...over,
  }

  const h = {
    app: createGateway(cfg),
    opened,
    simulated,
    executed,
    store,
    verdicts,
    get verified() {
      return counters.verified
    },
    get settled() {
      return counters.settled
    },
  }
  return h as Harness
}

function post(h: Harness, path: string, body: unknown, headers: Record<string, string> = {}) {
  return h.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Enchaînement complet du rail MPP : 402, puis Credential. */
async function payWithMpp(h: Harness, body: unknown) {
  const challenged = await post(h, '/v1/warrants', body)
  const challenge = parseChallengeHeader(challenged.headers.get(HEADER_WWW_AUTHENTICATE) as string)
  const credential: MppCredential = {
    challenge,
    payload: {
      type: 'transaction',
      signature: `0x${'2d'.repeat(65)}` as Hex,
      authorization: AUTHORIZATION,
    },
    source: `did:pkh:eip155:8453:${AGENT}`,
  }
  const header = `Payment ${encodeCredential(credential)}`
  const paid = await post(h, '/v1/warrants', body, { [HEADER_AUTHORIZATION]: header })
  return { challenged, challenge, credential, header, paid }
}

// ─────────────────────────────────────────────────────────────────────────────
// encodeActionSpec ⇄ functionName + functionArgs
// ─────────────────────────────────────────────────────────────────────────────

describe('encodeActionSpec / decodeActionSpec', () => {
  it('produit un aller-retour exact', () => {
    const spec = transferAction()
    const decoded = decodeActionSpec(spec, { registry: REGISTRY })

    expect(decoded.signature).toBe('transfer(address,uint256)')
    expect(decoded.functionName).toBe('transfer')
    expect(decoded.args).toEqual([DEST, '100000000'])

    const reencoded = encodeActionSpec({
      chainId: spec.chainId,
      target: spec.target,
      signature: decoded.signature,
      args: decoded.args,
      registryRef: spec.registryRef,
    })
    expect(reencoded).toEqual(spec)
  })

  it('rend `functionArgs` comme une **chaîne** JSON, pas un tableau', () => {
    const call = keeperHubCallOf(transferAction(), { registry: REGISTRY })
    expect(typeof call.functionArgs).toBe('string')
    expect(Array.isArray(call.functionArgs)).toBe(false)
    expect(JSON.parse(call.functionArgs)).toEqual([DEST, '100000000'])
    expect(call).toMatchObject({
      chainId: 1,
      contractAddress: USDC,
      functionName: 'transfer',
    })
    // Aucun champ de calldata brut : l'API KeeperHub les ignore tous.
    expect(call).not.toHaveProperty('data')
    expect(call).not.toHaveProperty('calldata')
  })

  it('nomme aussi les signatures à plusieurs arguments', () => {
    const spec = encodeActionSpec({
      chainId: 1,
      target: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as Address,
      signature: 'withdraw(address,uint256,address)',
      args: [USDC, '1000000', DEST],
      registryRef: REGISTRY_REF,
    })
    const call = keeperHubCallOf(spec, { registry: REGISTRY })
    expect(call.functionName).toBe('withdraw')
    expect(JSON.parse(call.functionArgs)).toEqual([USDC, '1000000', DEST])
  })

  it('refuse une action hors registre sans signature fournie', () => {
    expect(() => keeperHubCallOf(unknownAction(), { registry: REGISTRY })).toThrow(
      /absent du registre/,
    )
  })

  it('accepte une signature fournie, mais la vérifie contre le calldata', () => {
    const spec = unknownAction()
    const call = keeperHubCallOf(spec, { registry: REGISTRY, signature: 'poke(uint256)' })
    expect(call.functionName).toBe('poke')
    // Une signature mensongère ne peut pas renommer ce qui est engagé.
    expect(() =>
      keeperHubCallOf(spec, { registry: REGISTRY, signature: 'transfer(address,uint256)' }),
    ).toThrow(/incohérente avec le sélecteur/)
  })

  it("refuse un calldata non canonique : la forme transmise divergerait d'actionHash", () => {
    const spec = transferAction()
    const padded = { ...spec, calldata: `${spec.calldata}00000000` as Hex }
    expect(() => decodeActionSpec(padded, { registry: REGISTRY })).toThrow()
  })
})

describe('warrantIdOf', () => {
  it('vaut keccak256(abi.encode(agent, nonce, actionHash))', () => {
    const id = warrantIdOf(AGENT, 7n, `0x${'11'.repeat(32)}` as Hex)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    // Déterministe, et sensible à chacun des trois arguments.
    expect(warrantIdOf(AGENT, 7n, `0x${'11'.repeat(32)}` as Hex)).toBe(id)
    expect(warrantIdOf(AGENT, 8n, `0x${'11'.repeat(32)}` as Hex)).not.toBe(id)
    expect(warrantIdOf(DEST, 7n, `0x${'11'.repeat(32)}` as Hex)).not.toBe(id)
    expect(warrantIdOf(AGENT, 7n, `0x${'22'.repeat(32)}` as Hex)).not.toBe(id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/quote
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/quote', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('est gratuit et sans authentification', async () => {
    const res = await post(h, '/v1/quote', { actionSpec: transferAction() })
    expect(res.status).toBe(200)
    expect(res.headers.get(HEADER_PAYMENT_REQUIRED)).toBeNull()
    expect(res.headers.get(HEADER_WWW_AUTHENTICATE)).toBeNull()
  })

  it('dérive la catégorie et le notionnel du calldata', async () => {
    const res = await post(h, '/v1/quote', { actionSpec: transferAction() })
    const body = (await res.json()) as Record<string, unknown>
    expect(body['category']).toBe('erc20.transfer')
    expect(body['notionalUSD']).toBe('100000000')
    // 100 bps × 100 $ = 1 $, sous le plancher : la caution est minBond.
    expect(body['bond']).toBe('5000000')
  })

  it('rend un conditionHash reproductible', async () => {
    const a = (await (await post(h, '/v1/quote', { actionSpec: transferAction() })).json()) as Record<
      string,
      unknown
    >
    const b = (await (await post(h, '/v1/quote', { actionSpec: transferAction() })).json()) as Record<
      string,
      unknown
    >
    expect(a['conditionHash']).toBe(b['conditionHash'])
    expect(a['actionHash']).toBe(b['actionHash'])
    expect(a['conditionSpec']).toEqual(b['conditionSpec'])
  })

  it('ignore une catégorie déclarée : c\'est le calldata qui décide', async () => {
    const honest = (await (
      await post(h, '/v1/quote', { actionSpec: transferAction() })
    ).json()) as Record<string, unknown>
    const liar = (await (
      await post(h, '/v1/quote', {
        actionSpec: transferAction(),
        category: 'erc20.approve',
        notionalUSD: '1',
        bond: '1',
      })
    ).json()) as Record<string, unknown>

    expect(liar['category']).toBe('erc20.transfer')
    expect(liar['bond']).toBe(honest['bond'])
    expect(liar['conditionHash']).toBe(honest['conditionHash'])
    expect(liar['ignoredFields']).toMatchObject({ category: 'erc20.approve' })
  })

  it('injecte calldata_matches_commitment dans toute conditionSpec produite', async () => {
    const body = (await (
      await post(h, '/v1/quote', { actionSpec: transferAction() })
    ).json()) as { conditionSpec: { checks: { kind: string; actionHash?: string }[] } }
    const commitments = body.conditionSpec.checks.filter((c) => c.kind === COMMITMENT_KIND)
    expect(commitments).toHaveLength(1)
    expect(commitments[0]?.actionHash).toBe(
      (
        (await (await post(h, '/v1/quote', { actionSpec: transferAction() })).json()) as Record<
          string,
          string
        >
      )['actionHash'],
    )
  })

  it('tarifie une action non classifiée à maxBond', async () => {
    const res = await post(h, '/v1/quote', { actionSpec: unknownAction() })
    const body = (await res.json()) as Record<string, unknown>
    expect(body['category']).toBe('unknown')
    expect(body['bond']).toBe(POLICY.maxBond)
  })

  it('refuse en RFC 9457 un calldata que le registre ne sait pas décoder', async () => {
    // Sélecteur `transfer` sur l'USDC, mais sans ses arguments : le décodage
    // ABI échoue, et un décodage en échec est un refus, jamais un repli.
    const spec = { ...transferAction(), calldata: '0xa9059cbb' as Hex }
    const res = await post(h, '/v1/quote', { actionSpec: spec })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('classification_refused')
    expect(body['code']).toBe('DECODE_FAILED')
  })

  it('refuse un sélecteur enveloppant de routeur générique', async () => {
    const spec = {
      ...transferAction(),
      // `execute(address,uint256,bytes)` — la classification ne verrait qu'une
      // enveloppe et ne pourrait rien affirmer de l'effet réel.
      calldata: '0xb61d27f6' as Hex,
    }
    const res = await post(h, '/v1/quote', { actionSpec: spec })
    expect(res.status).toBe(422)
    expect((await res.json())['code']).toBe('GENERIC_ROUTER')
  })

  it("refuse un registryRef qui n'est pas celui du registre utilisé", async () => {
    const spec = { ...transferAction(), registryRef: `0x${'00'.repeat(32)}` as Hex }
    const res = await post(h, '/v1/quote', { actionSpec: spec })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('registry_mismatch')
    // La valeur attendue est rendue : la correction tient en un aller-retour.
    expect(body['expected']).toBe(REGISTRY_REF)
  })

  it('refuse une ActionSpec malformée avec le chemin du champ fautif', async () => {
    const res = await post(h, '/v1/quote', {
      actionSpec: { ...transferAction(), target: 'pas-une-adresse' },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('invalid_spec')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 402 dual-rail
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/warrants — le 402', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('émet les deux challenges simultanément, avec un corps {}', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    expect(res.status).toBe(402)
    expect(res.headers.get(HEADER_PAYMENT_REQUIRED)).toBeTruthy()
    expect(res.headers.get(HEADER_WWW_AUTHENTICATE)).toBeTruthy()
    expect(await res.json()).toEqual({})
  })

  it('le PAYMENT-REQUIRED est un PaymentRequired v2 décodable en base64', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const header = res.headers.get(HEADER_PAYMENT_REQUIRED) as string
    expect(header).toMatch(/^[A-Za-z0-9+/=]+$/)
    const required = decodeHeaderObject<PaymentRequired>(header)
    expect(required.x402Version).toBe(2)
    expect(required.resource.url).toBe('http://warrant.test/v1/warrants')
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '5000000',
      asset: USDC_BASE,
      payTo: VAULT,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
    })
  })

  it('le WWW-Authenticate est un Challenge MPP charge complet', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const header = res.headers.get(HEADER_WWW_AUTHENTICATE) as string
    expect(header.startsWith('Payment ')).toBe(true)

    const challenge = parseChallengeHeader(header)
    expect(challenge.realm).toBe('warrant.sh')
    expect(challenge.method).toBe('tempo')
    expect(challenge.intent).toBe('charge')
    expect(challenge.id).toBeTruthy()
    expect(challenge.expires).toBeTruthy()

    const request = decodeJcs<MppRequestBody>(challenge.request)
    expect(request).toEqual({ amount: '5000000', currency: 'USDC', recipient: VAULT })

    // Le montant annoncé est le même sur les deux rails.
    const required = decodeHeaderObject<PaymentRequired>(
      res.headers.get(HEADER_PAYMENT_REQUIRED) as string,
    )
    expect(request.amount).toBe(required.accepts[0]?.amount)
  })

  it("n'ouvre rien et ne règle rien tant que le paiement n'est pas là", async () => {
    await post(h, '/v1/warrants', { actionSpec: transferAction() })
    expect(h.opened).toHaveLength(0)
    expect(h.settled).toBe(0)
    expect(h.simulated).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Les deux rails, un seul mandat
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/warrants — rail x402', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('ouvre le mandat et exécute', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['executionId']).toBe('exec_warrant_1')
    expect(body['warrantId']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(body['expiry']).toBe(NOW + POLICY.duration)
    expect(h.opened).toHaveLength(1)
    expect(h.executed).toHaveLength(1)
  })

  it('rend PAYMENT-RESPONSE, et pas Payment-Receipt', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    const receipt = res.headers.get(HEADER_PAYMENT_RESPONSE) as string
    expect(receipt).toBeTruthy()
    expect(res.headers.get(HEADER_PAYMENT_RECEIPT)).toBeNull()
    expect(decodeHeaderObject<SettlementResponse>(receipt)).toMatchObject({
      success: true,
      transaction: SETTLEMENT_TX,
    })
  })

  it('enregistre le fundingRef du facilitateur', async () => {
    await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    expect(h.opened[0]?.fundingRef).toBe(SETTLEMENT_TX)
  })

  it("transmet à KeeperHub la forme nominative, pas le calldata", async () => {
    await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    expect(h.executed[0]).toEqual({
      chainId: 1,
      contractAddress: USDC,
      functionName: 'transfer',
      functionArgs: JSON.stringify([DEST, '100000000']),
    })
  })

  it('refuse un paiement dont le montant ne vaut pas la caution', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header('1'),
    })
    expect(res.status).toBe(402)
    const required = decodeHeaderObject<PaymentRequired>(
      res.headers.get(HEADER_PAYMENT_REQUIRED) as string,
    )
    expect(required.error).toContain('amount_mismatch')
    expect(h.opened).toHaveLength(0)
    expect(h.settled).toBe(0)
  })

  it('refuse quand le facilitateur invalide le paiement', async () => {
    const strict = harness({
      facilitator: {
        async verify() {
          return { isValid: false, invalidReason: 'insufficient_funds' }
        },
        async settle() {
          throw new Error('ne doit jamais être appelé')
        },
      },
    })
    const res = await post(strict, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    expect(res.status).toBe(402)
    expect(strict.opened).toHaveLength(0)
  })
})

describe('POST /v1/warrants — rail MPP', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('ouvre le mandat depuis un Credential', async () => {
    const { paid } = await payWithMpp(h, { actionSpec: transferAction() })
    expect(paid.status).toBe(200)
    expect(h.opened).toHaveLength(1)
  })

  it('rend Payment-Receipt, et pas PAYMENT-RESPONSE', async () => {
    const { paid, challenge } = await payWithMpp(h, { actionSpec: transferAction() })
    const header = paid.headers.get(HEADER_PAYMENT_RECEIPT) as string
    expect(header).toBeTruthy()
    expect(paid.headers.get(HEADER_PAYMENT_RESPONSE)).toBeNull()
    expect(decodeReceipt(header)).toMatchObject({
      challengeId: challenge.id,
      method: 'tempo',
      reference: SETTLEMENT_TX,
      status: 'success',
      settlement: { amount: '5000000', currency: 'USDC' },
    })
  })

  it('refuse strictement le rejeu du même Credential', async () => {
    const { header, paid } = await payWithMpp(h, { actionSpec: transferAction() })
    expect(paid.status).toBe(200)

    const replay = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_AUTHORIZATION]: header,
    })
    expect(replay.status).toBe(409)
    expect(replay.headers.get('content-type')).toContain('application/problem+json')
    const body = (await replay.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('challenge_replayed')

    // Aucun second mandat, aucun second règlement, aucune seconde exécution.
    expect(h.opened).toHaveLength(1)
    expect(h.settled).toBe(1)
    expect(h.executed).toHaveLength(1)
  })

  it('refuse un Credential dont le Challenge a été altéré', async () => {
    const challenged = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const challenge = parseChallengeHeader(
      challenged.headers.get(HEADER_WWW_AUTHENTICATE) as string,
    )
    const credential: MppCredential = {
      challenge: { ...challenge, opaque: 'eyJyb3V0ZSI6Ii92MS9hdXRyZSJ9' },
      payload: {
        type: 'transaction',
        signature: `0x${'2d'.repeat(65)}` as Hex,
        authorization: AUTHORIZATION,
      },
      source: AGENT,
    }
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_AUTHORIZATION]: `Payment ${encodeCredential(credential)}`,
    })
    expect(res.status).toBe(402)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('opaque_mismatch')
    expect(h.opened).toHaveLength(0)
  })

  it('rend ses erreurs de paiement en RFC 9457, avec les deux challenges', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_AUTHORIZATION]: 'Payment pas-un-credential',
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe(402)
    expect(String(body['type'])).toMatch(/^https:\/\/warrant\.sh\/problems\//)
    expect(res.headers.get(HEADER_WWW_AUTHENTICATE)).toBeTruthy()
    expect(res.headers.get(HEADER_PAYMENT_REQUIRED)).toBeTruthy()
  })
})

describe('les deux rails produisent un mandat identique', () => {
  it('même conditionHash, même caution, même forme de fundingRef', async () => {
    const viaX402 = harness()
    const viaMpp = harness()

    const x402Res = await post(viaX402, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    const { paid: mppRes } = await payWithMpp(viaMpp, { actionSpec: transferAction() })

    expect(x402Res.status).toBe(200)
    expect(mppRes.status).toBe(200)

    // 1. Le corps de la réponse, champ à champ.
    expect(await mppRes.json()).toEqual(await x402Res.json())

    // 2. Les arguments d'ouverture onchain, champ à champ.
    const a = viaX402.opened[0] as OpenWarrantArgs
    const b = viaMpp.opened[0] as OpenWarrantArgs
    expect(b).toEqual(a)
    for (const key of Object.keys(a) as (keyof OpenWarrantArgs)[]) {
      expect(b[key]).toBe(a[key])
    }
    expect(a.fundingRef).toBe(SETTLEMENT_TX)

    // 3. Le mandat enregistré, hors le rail lui-même.
    const recordA = (await viaX402.store.get(a.id)) as Record<string, unknown>
    const recordB = (await viaMpp.store.get(b.id)) as Record<string, unknown>
    expect(recordA['rail']).toBe('x402')
    expect(recordB['rail']).toBe('mpp')
    const { rail: _a, ...restA } = recordA
    const { rail: _b, ...restB } = recordB
    expect(restB).toEqual(restA)

    // 4. Et l'appel transmis à KeeperHub.
    expect(viaMpp.executed).toEqual(viaX402.executed)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Simulation
// ─────────────────────────────────────────────────────────────────────────────

describe('simulation KeeperHub', () => {
  function failingExecutor(over: Partial<SimulationOutcome>) {
    const executed: KeeperHubCall[] = []
    return {
      executed,
      executor: {
        async simulateContractCall(): Promise<SimulationOutcome> {
          return { success: false, wouldRevert: true, revertReason: 'ERC20: transfer amount exceeds balance', ...over }
        },
        async executeContractCall(call: KeeperHubCall): Promise<ExecutionOutcome> {
          executed.push(call)
          return { executionId: 'ne-doit-pas-arriver', status: 'success' }
        },
      } as ExecutorPort,
    }
  }

  it('simulation en échec → 4xx, aucun mandat ouvert, aucune caution prélevée', async () => {
    const { executor, executed } = failingExecutor({})
    const h = harness({ executor })

    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('simulation_failed')
    expect(String(body['detail'])).toContain('exceeds balance')
    expect(body['warrantOpened']).toBe(false)

    // Aucun mandat, aucune caution, aucune exécution.
    expect(h.opened).toHaveLength(0)
    expect(h.settled).toBe(0)
    expect(executed).toHaveLength(0)
  })

  it("un `wouldRevert` seul suffit à refuser, même si `success` est vrai", async () => {
    const { executor } = failingExecutor({ success: true, wouldRevert: true })
    const h = harness({ executor })
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    expect(res.status).toBe(422)
    expect(h.settled).toBe(0)
  })

  it('simule avant de régler — le drapeau inverse est explicite', async () => {
    const order: string[] = []
    const h = harness({
      executor: {
        async simulateContractCall() {
          order.push('simulate')
          return { success: true, wouldRevert: false }
        },
        async executeContractCall(call) {
          order.push('execute')
          return { executionId: 'e', status: 'success' }
        },
      },
      facilitator: {
        async verify() {
          order.push('verify')
          return { isValid: true, payer: AGENT }
        },
        async settle() {
          order.push('settle')
          return {
            success: true,
            transaction: SETTLEMENT_TX,
            network: 'eip155:8453',
            payer: AGENT,
          }
        },
      },
    })
    await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    expect(order).toEqual(['verify', 'simulate', 'settle', 'execute'])
  })

  it('simule bien la même action que celle engagée', async () => {
    const h = harness()
    await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    expect(h.simulated).toEqual(h.executed)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La catégorie déclarée reste ignorée sur la route payante
// ─────────────────────────────────────────────────────────────────────────────

describe('la catégorie déclarée est ignorée jusque dans le mandat', () => {
  it('produit le même engagement avec ou sans champ `category`', async () => {
    const honest = harness()
    const liar = harness()

    await post(honest, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(),
    })
    await post(
      liar,
      '/v1/warrants',
      { actionSpec: transferAction(), category: 'erc20.approve', bond: '1' },
      { [HEADER_PAYMENT_SIGNATURE]: x402Header() },
    )

    expect(liar.opened[0]).toEqual(honest.opened[0])
    expect(liar.opened[0]?.bond).toBe('5000000')
  })

  it('refuse une action non exécutable par KeeperHub avant toute ouverture', async () => {
    const h = harness()
    const res = await post(h, '/v1/warrants', { actionSpec: unknownAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(POLICY.maxBond),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('unencodable_action')
    expect(h.opened).toHaveLength(0)
    expect(h.settled).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/warrants/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/warrants/:id', () => {
  it('rend le mandat, sa conditionSpec engagée, et pas encore de verdict', async () => {
    const h = harness()
    const opened = (await (
      await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
        [HEADER_PAYMENT_SIGNATURE]: x402Header(),
      })
    ).json()) as Record<string, string>

    const res = await h.app.request(`/v1/warrants/${opened['warrantId']}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const warrant = body['warrant'] as Record<string, unknown>
    expect(warrant['id']).toBe(opened['warrantId'])
    expect(warrant['status']).toBe('Open')
    expect(warrant['fundingRef']).toBe(SETTLEMENT_TX)
    expect(warrant['expiry']).toBe(NOW + POLICY.duration)
    expect(body['verdict']).toBeNull()
    expect(body['checks']).toEqual([])

    const spec = body['conditionSpec'] as { checks: { kind: string }[] }
    expect(spec.checks.some((c) => c.kind === COMMITMENT_KIND)).toBe(true)
  })

  it('rend le verdict et le détail checks[] une fois réglé', async () => {
    const h = harness()
    const opened = (await (
      await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
        [HEADER_PAYMENT_SIGNATURE]: x402Header(),
      })
    ).json()) as Record<string, string>

    h.verdicts.set((opened['warrantId'] as string).toLowerCase(), {
      verdict: 'slashed',
      evaluatedAtBlock: '21000000',
      checks: [
        { kind: 'erc20_balance_delta', expected: '>=100000000', observed: '0', pass: false },
        { kind: COMMITMENT_KIND, expected: 'match', observed: 'match', pass: true },
      ],
      rpcUrl: 'https://rpc.example',
    })

    const body = (await (await h.app.request(`/v1/warrants/${opened['warrantId']}`)).json()) as
      Record<string, unknown>
    expect((body['verdict'] as Record<string, unknown>)['verdict']).toBe('slashed')
    expect(body['checks']).toHaveLength(2)
    expect((body['checks'] as { pass: boolean }[])[0]?.pass).toBe(false)
  })

  it('rend un Problem Details 404 pour un mandat inconnu', async () => {
    const h = harness()
    const res = await h.app.request(`/v1/warrants/0x${'00'.repeat(32)}`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
  })

  it('refuse un identifiant qui n\'est pas un bytes32', async () => {
    const h = harness()
    expect((await h.app.request('/v1/warrants/pas-un-id')).status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /openapi.json', () => {
  it('sert un OpenAPI 3.1 avec x-payment-info au format observé chez KeeperHub', async () => {
    const h = harness()
    const doc = (await (await h.app.request('/openapi.json')).json()) as Record<string, any>

    expect(doc['openapi']).toBe('3.1.0')

    const info = doc['paths']['/v1/warrants']['post']['x-payment-info']
    expect(info['protocols']).toEqual([
      { x402: { network: 'eip155:8453' } },
      { mpp: { method: 'tempo', intent: 'charge', currency: 'USDC' } },
    ])

    // Prix dynamique : il est calculé par le Risk Pricer, il ne peut pas être fixe.
    expect(info['price']['mode']).toBe('dynamic')
    expect(info['price']['currency']).toBe('USD')
    expect(info['price']['min']).toBe('5')
    expect(info['price']['max']).toBe('250')
    expect(info['price']['quote']).toMatchObject({ path: '/v1/quote', cost: 'free' })
  })

  it('décrit les deux rails sur la route payante', async () => {
    const h = harness()
    const doc = (await (await h.app.request('/openapi.json')).json()) as Record<string, any>
    const responses = doc['paths']['/v1/warrants']['post']['responses']
    expect(Object.keys(responses['402']['headers'])).toEqual([
      'WWW-Authenticate',
      'PAYMENT-REQUIRED',
    ])
    expect(Object.keys(responses['200']['headers'])).toEqual([
      'PAYMENT-RESPONSE',
      'Payment-Receipt',
    ])
  })

  it('ne facture pas /v1/quote', async () => {
    const h = harness()
    const doc = (await (await h.app.request('/openapi.json')).json()) as Record<string, any>
    expect(doc['paths']['/v1/quote']['post']['x-payment-info']).toBeUndefined()
  })
})
