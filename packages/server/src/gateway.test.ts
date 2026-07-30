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
  keeperHubEscrow,
  keeperHubExecutor,
  memoryWarrantStore,
  termsHashOf,
  warrantIdOf,
  type EscrowContractCall,
  type EscrowExecution,
  type ExecutionOutcome,
  type ExecutorPort,
  type GatewayConfig,
  type KeeperHubCall,
  type KeeperHubEscrowClient,
  type OpenWarrantArgs,
  type SimulationOutcome,
  type VerdictView,
} from './gateway.js'
import type { KeeperHubClient } from './keeperhub.js'
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
const OPEN_TX = `0x${'0e'.repeat(32)}` as Hex

/**
 * Signature de 65 octets dont le dernier vaut 0x1b = 27.
 *
 * L'ancien remplissage `0x2d…2d` avait la bonne longueur et un `v` de 45, que
 * `ecrecover` ne sait pas recouvrer. Sans importance quand la signature n'était
 * qu'un opaque transmis au facilitateur ; elle est maintenant découpée en
 * `v`/`r`/`s` et passée au contrat, donc sa forme compte.
 */
const SIGNATURE = `0x${'aa'.repeat(32)}${'bb'.repeat(32)}1b` as Hex

/**
 * Le nonce **de mandat** — celui qui entre dans `warrantId`.
 *
 * Distinct du nonce de l'autorisation EIP-3009, qui vaut `termsHash(...)` et
 * n'est donc plus libre. Les confondre était possible tant que le second était
 * aléatoire ; c'est désormais circulaire, `termsHash` contenant `id` qui contient
 * ce nonce-ci.
 */
const WARRANT_NONCE = BigInt(`0x${'7c'.repeat(32)}`)

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

/**
 * L'autorisation EIP-3009 que le rail transporte.
 *
 * `to` vaut `payTo`, et `payTo` **doit** être l'escrow en exploitation : c'est
 * l'escrow qui appellera `receiveWithAuthorization`, et la variante `receive`
 * exige `to == msg.sender`. `bin/gateway.ts` refuse de démarrer si les deux
 * divergent ; ici `VAULT` tient les deux rôles.
 */
const AUTHORIZATION = {
  from: AGENT,
  to: VAULT,
  value: '5000000',
  validAfter: String(NOW),
  validBefore: String(NOW + 60),
  // Remplacé par le `termsHash` réel dans chaque paiement : voir `termsFor`.
  nonce: `0x${'00'.repeat(32)}` as Hex,
}

function requirements(amount = '5000000'): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount,
    asset: USDC_BASE,
    payTo: VAULT,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009-receive' },
  }
}

/** Les termes qu'un client doit dériver du 402 avant de pouvoir signer. */
interface Terms {
  /** Le nonce de mandat annoncé, à renvoyer tel quel dans `body.nonce`. */
  nonce: string
  id: Hex
  /** `termsHash(...)` — le nonce que l'autorisation EIP-3009 doit porter. */
  authNonce: Hex
  bond: string
}

/**
 * Rejoue ce que fait un client : lire le 402, dériver `id`, calculer le
 * `termsHash`.
 *
 * Aucun de ces calculs n'était nécessaire avant : le client tirait un nonce
 * aléatoire et signait six champs. Le nonce valant désormais le hash des termes,
 * signer le paiement *est* signer les termes — et il faut donc les connaître.
 */
function termsFrom(challenged: Response): Terms {
  const required = decodeHeaderObject<PaymentRequired>(
    challenged.headers.get(HEADER_PAYMENT_REQUIRED) as string,
  )
  const info = (
    required.extensions?.['warrant/commitment'] as { info: Record<string, string | number> }
  ).info
  const nonce = String(info['nonce'])
  const actionHash = String(info['actionHash']) as Hex
  // `id` n'est pas annoncé et ne peut pas l'être : le serveur ne connaît pas
  // encore l'adresse qui signera. C'est au client de le composer.
  const id = warrantIdOf(AGENT, BigInt(nonce), actionHash)
  const authNonce = termsHashOf({
    id,
    beneficiary: String(info['beneficiary']) as Address,
    bond: String(info['bond']),
    conditionHash: String(info['conditionHash']) as Hex,
    actionHash,
    duration: Number(info['duration']),
  })
  return { nonce, id, authNonce, bond: String(info['bond']) }
}

function x402Header(
  terms: Terms,
  over: { amount?: string; authNonce?: Hex; signature?: Hex } = {},
): string {
  const amount = over.amount ?? terms.bond
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: 'http://warrant.test/v1/warrants' },
    accepted: requirements(amount),
    payload: {
      signature: over.signature ?? SIGNATURE,
      authorization: {
        ...AUTHORIZATION,
        value: amount,
        nonce: over.authNonce ?? terms.authNonce,
      },
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
      // `settle` n'est plus sur le chemin d'ouverture : `open()` encaisse la
      // caution lui-même. Le compteur reste, et rester à zéro est l'assertion.
      async settle() {
        counters.settled++
        throw new Error('settle() ne doit plus être appelé : open() encaisse')
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
    // Le nonce de mandat est tiré à l'émission du 402 et annoncé au client. Le
    // figer rend les termes — donc le `termsHash` — reproductibles en test.
    randomNonce: () => WARRANT_NONCE,
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

/**
 * Enchaînement complet du rail x402 : 402, dérivation des termes, paiement.
 *
 * Les deux requêtes sont désormais indissociables — le nonce de mandat annoncé
 * par la première doit revenir dans la seconde, sinon le `termsHash` ne
 * correspond plus.
 */
async function payWithX402(
  h: Harness,
  body: Record<string, unknown>,
  over: { amount?: string; authNonce?: Hex; signature?: Hex; nonce?: string } = {},
) {
  const challenged = await post(h, '/v1/warrants', body)
  const terms = termsFrom(challenged)
  const paid = await post(
    h,
    '/v1/warrants',
    { ...body, nonce: over.nonce ?? terms.nonce },
    { [HEADER_PAYMENT_SIGNATURE]: x402Header(terms, over) },
  )
  return { challenged, terms, paid }
}

/** Enchaînement complet du rail MPP : 402, puis Credential. */
async function payWithMpp(h: Harness, body: Record<string, unknown>) {
  const challenged = await post(h, '/v1/warrants', body)
  const challenge = parseChallengeHeader(challenged.headers.get(HEADER_WWW_AUTHENTICATE) as string)
  const terms = termsFrom(challenged)
  const credential: MppCredential = {
    challenge,
    payload: {
      type: 'transaction',
      signature: SIGNATURE,
      authorization: { ...AUTHORIZATION, nonce: terms.authNonce },
    },
    source: `did:pkh:eip155:8453:${AGENT}`,
  }
  const header = `Payment ${encodeCredential(credential)}`
  const paidBody = { ...body, nonce: terms.nonce }
  const paid = await post(h, '/v1/warrants', paidBody, { [HEADER_AUTHORIZATION]: header })
  return { challenged, challenge, credential, header, paid, terms, paidBody }
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

describe('termsHashOf', () => {
  it('reproduit `abi.encode` de Solidity, octet pour octet', () => {
    // Vecteur obtenu par `cast abi-encode` puis `cast keccak` sur la signature
    // exacte de `WarrantEscrow.termsHash`. C'est la seule vérification qui
    // compte vraiment ici : `termsHashOf` réimplémente une formule onchain, et
    // une divergence ne se verrait qu'en `TermsMismatch()` au premier mandat
    // payant — après que l'agent a signé.
    expect(
      termsHashOf({
        id: `0x${'11'.repeat(32)}` as Hex,
        beneficiary: '0x00000000000000000000000000000000000000b1' as Address,
        bond: '5000000',
        conditionHash: `0x${'22'.repeat(32)}` as Hex,
        actionHash: `0x${'33'.repeat(32)}` as Hex,
        duration: 3600,
      }),
    ).toBe('0x000512926ed2fc649aff43db8e28d4fbdebe7892d403312dc594cccdb2a840cc')
  })

  it('est sensible à chacun des six termes', () => {
    const base = {
      id: `0x${'11'.repeat(32)}` as Hex,
      beneficiary: '0x00000000000000000000000000000000000000b1' as Address,
      bond: '5000000',
      conditionHash: `0x${'22'.repeat(32)}` as Hex,
      actionHash: `0x${'33'.repeat(32)}` as Hex,
      duration: 3600,
    }
    const ref = termsHashOf(base)
    // Chaque terme doit bouger le hash : un terme qui n'y entre pas serait un
    // terme que l'agent ne signe pas, donc que l'opener pourrait choisir.
    expect(termsHashOf({ ...base, id: `0x${'12'.repeat(32)}` as Hex })).not.toBe(ref)
    expect(
      termsHashOf({ ...base, beneficiary: `0x${'be'.repeat(20)}` as Address }),
    ).not.toBe(ref)
    expect(termsHashOf({ ...base, bond: '5000001' })).not.toBe(ref)
    expect(termsHashOf({ ...base, conditionHash: `0x${'23'.repeat(32)}` as Hex })).not.toBe(ref)
    expect(termsHashOf({ ...base, actionHash: `0x${'34'.repeat(32)}` as Hex })).not.toBe(ref)
    // `duration` en particulier : c'est celui qu'un opener aurait porté à
    // MAX_DURATION pour retarder le `reclaim` de l'agent.
    expect(termsHashOf({ ...base, duration: 604800 })).not.toBe(ref)
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
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009-receive' },
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
    const { paid: res } = await payWithX402(h, { actionSpec: transferAction() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['executionId']).toBe('exec_warrant_1')
    expect(body['warrantId']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(body['expiry']).toBe(NOW + POLICY.duration)
    expect(h.opened).toHaveLength(1)
    expect(h.executed).toHaveLength(1)
  })

  it('rend PAYMENT-RESPONSE, et pas Payment-Receipt', async () => {
    const { paid: res } = await payWithX402(h, { actionSpec: transferAction() })
    const receipt = res.headers.get(HEADER_PAYMENT_RESPONSE) as string
    expect(receipt).toBeTruthy()
    expect(res.headers.get(HEADER_PAYMENT_RECEIPT)).toBeNull()
    // La référence de règlement est le hash de l'`open` : c'est cette
    // transaction qui a déplacé l'USDC, le facilitateur n'en diffuse plus aucune.
    expect(decodeHeaderObject<SettlementResponse>(receipt)).toMatchObject({
      success: true,
      transaction: OPEN_TX,
      payer: AGENT,
      amount: '5000000',
    })
  })

  it("n'appelle plus le facilitateur : open() encaisse la caution", async () => {
    await payWithX402(h, { actionSpec: transferAction() })
    // Ni `/settle` — le règlement est dans `open()` — ni `/verify`, que le
    // facilitateur ferait échouer à tort sur un typehash `receive`.
    expect(h.settled).toBe(0)
    expect(h.verified).toBe(0)
  })

  it("passe l'autorisation à open(), découpée en v/r/s", async () => {
    const { terms } = await payWithX402(h, { actionSpec: transferAction() })
    expect(h.opened[0]?.authorization).toEqual({
      from: AGENT,
      value: 5000000n,
      validAfter: BigInt(NOW),
      validBefore: BigInt(NOW + 60),
      // Le nonce **est** le hash des termes : c'est ce qui lie la signature au
      // mandat, là où les six champs d'EIP-3009 ne disent rien de lui.
      nonce: terms.authNonce,
      v: 27,
      r: `0x${'aa'.repeat(32)}`,
      s: `0x${'bb'.repeat(32)}`,
    })
    expect(h.opened[0]?.id).toBe(terms.id)
  })

  it('refuse une autorisation dont le nonce ne vaut pas le termsHash', async () => {
    // Le détournement que le contrat referme : une autorisation valide, signée
    // pour un mandat, réutilisée sur des termes différents. Ici on simule
    // l'inverse — un nonce qui n'engage aucun terme — et c'est refusé.
    const { paid } = await payWithX402(h, { actionSpec: transferAction() }, {
      authNonce: `0x${'99'.repeat(32)}` as Hex,
    })
    expect(paid.status).toBe(402)
    const required = decodeHeaderObject<PaymentRequired>(
      paid.headers.get(HEADER_PAYMENT_REQUIRED) as string,
    )
    expect(required.error).toContain('terms_mismatch')
    expect(h.opened).toHaveLength(0)
  })

  it('exige le nonce de mandat annoncé dans le 402', async () => {
    const challenged = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const terms = termsFrom(challenged)
    // Paiement correct, mais `body.nonce` omis : le serveur en tirerait un
    // autre, donc un autre `id`, donc un autre termsHash. Refus nommé plutôt
    // que TermsMismatch() onchain.
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(terms),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('missing_nonce')
    expect(h.opened).toHaveLength(0)
  })

  it('le 402 annonce tous les termes que le client doit signer', async () => {
    const challenged = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const required = decodeHeaderObject<PaymentRequired>(
      challenged.headers.get(HEADER_PAYMENT_REQUIRED) as string,
    )
    const info = (
      required.extensions?.['warrant/commitment'] as { info: Record<string, unknown> }
    ).info
    // Sans ces six valeurs, un client ne peut pas calculer le termsHash — donc
    // ne peut pas signer une autorisation que `open()` accepterait.
    expect(info).toMatchObject({
      nonce: `0x${'7c'.repeat(32)}`,
      beneficiary: BENEFICIARY,
      bond: '5000000',
      duration: POLICY.duration,
      escrow: VAULT,
    })
    expect(info['conditionHash']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(info['actionHash']).toMatch(/^0x[0-9a-f]{64}$/)
    // Et le typehash à signer, qui n'est pas celui du schéma `exact` par défaut.
    expect(required.accepts[0]?.extra?.primaryType).toBe('ReceiveWithAuthorization')
  })

  it("ne passe plus ni `agent` ni `fundingRef` : le contrat les dérive", async () => {
    await payWithX402(h, { actionSpec: transferAction() })
    // C'est la correction elle-même : un opener qui déclare l'agent peut
    // s'attribuer tout solde libre du contrat.
    expect(h.opened[0]).not.toHaveProperty('agent')
    expect(h.opened[0]).not.toHaveProperty('fundingRef')
  })

  it('la caution signée doit valoir exactement le bond recalculé', async () => {
    // `open()` révèrte en `ValueMismatch()` sinon. On refuse en amont, pour que
    // le client sache resigner plutôt que de lire un revert onchain.
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: 'http://warrant.test/v1/warrants' },
      accepted: requirements('5000000'),
      payload: {
        signature: SIGNATURE,
        // Le montant annoncé est bon, celui **signé** ne l'est pas.
        authorization: { ...AUTHORIZATION, value: '4999999' },
      },
      extensions: {},
    }
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: encodeHeaderObject(payload),
    })
    expect(res.status).toBe(402)
    expect(h.opened).toHaveLength(0)
  })

  it('refuse une signature qui ne fait pas 65 octets', async () => {
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: 'http://warrant.test/v1/warrants' },
      accepted: requirements(),
      payload: { signature: '0xdeadbeef' as Hex, authorization: AUTHORIZATION },
      extensions: {},
    }
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: encodeHeaderObject(payload),
    })
    expect(res.status).toBe(402)
    expect(h.opened).toHaveLength(0)
  })

  it("transmet à KeeperHub la forme nominative, pas le calldata", async () => {
    await payWithX402(h, { actionSpec: transferAction() })
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

  it('refuse quand le facilitateur invalide le paiement — si on le lui demande', async () => {
    // `verifyWithFacilitator` est faux par défaut, et ce défaut est un choix :
    // un facilitateur conforme au schéma `exact` vérifie le typehash
    // `TransferWithAuthorization` et invaliderait donc toutes nos autorisations,
    // qui portent `ReceiveWithAuthorization`. Le contrôle reste disponible pour
    // le jour où le facilitateur saura vérifier la bonne variante.
    const strict = harness({
      verifyWithFacilitator: true,
      facilitator: {
        async verify() {
          return { isValid: false, invalidReason: 'insufficient_funds' }
        },
        async settle() {
          throw new Error('ne doit jamais être appelé')
        },
      },
    })
    const { paid: res } = await payWithX402(strict, { actionSpec: transferAction() })
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
      reference: OPEN_TX,
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

    // Aucun second mandat, aucune seconde exécution. Et toujours aucun appel au
    // facilitateur : le rejeu est refusé avant même d'atteindre l'ouverture.
    expect(h.opened).toHaveLength(1)
    expect(h.settled).toBe(0)
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
        signature: SIGNATURE,
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
  it('même conditionHash, même caution, même fundingRef', async () => {
    const viaX402 = harness()
    const viaMpp = harness()

    const { paid: x402Res } = await payWithX402(viaX402, { actionSpec: transferAction() })
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
      // `toEqual` et non `toBe` : `authorization` est une struct reconstruite de
      // part et d'autre, donc jamais la même instance. C'est son contenu qui
      // doit être identique — et il l'est, les deux rails transportant la même
      // signature.
      expect(b[key]).toEqual(a[key])
    }
    // Le `fundingRef` est le nonce de l'autorisation, et les deux rails
    // transportent la **même** autorisation : il est identique par construction,
    // là où l'ancien hash de règlement dépendait du facilitateur.
    // Le `fundingRef` est le nonce de l'autorisation, c'est-à-dire le hash des
    // termes. Les deux rails servant les mêmes termes, il est identique par
    // construction — là où l'ancien hash de règlement dépendait du facilitateur.
    expect(a.authorization.nonce).toBe(b.authorization.nonce)
    expect(a.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/)

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

    const { paid: res } = await payWithX402(h, { actionSpec: transferAction() })

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
    const { paid: res } = await payWithX402(h, { actionSpec: transferAction() })
    expect(res.status).toBe(422)
    expect(h.settled).toBe(0)
  })

  function ordered(over: Partial<GatewayConfig> = {}) {
    const order: string[] = []
    const h = harness({
      executor: {
        async simulateContractCall() {
          order.push('simulate')
          return { success: true, wouldRevert: false }
        },
        async executeContractCall() {
          order.push('execute')
          return { executionId: 'e', status: 'success' }
        },
      },
      escrow: {
        async open() {
          order.push('open')
          return OPEN_TX
        },
      },
      facilitator: {
        async verify() {
          order.push('verify')
          return { isValid: true, payer: AGENT }
        },
        async settle() {
          order.push('settle')
          throw new Error('settle() ne doit plus être appelé')
        },
      },
      ...over,
    })
    return { h, order }
  }

  it("simule avant d'ouvrir — l'ouverture encaisse, elle ne doit pas payer un échec prévisible", async () => {
    const { h, order } = ordered()
    await payWithX402(h, { actionSpec: transferAction() })
    // Plus d'étape `settle` : `open` la contient. Et pas de `verify` par défaut.
    expect(order).toEqual(['simulate', 'open', 'execute'])
  })

  it('`openBeforeSimulate` retrouve l’ordre littéral de docs/04', async () => {
    const { h, order } = ordered({ openBeforeSimulate: true })
    await payWithX402(h, { actionSpec: transferAction() })
    expect(order).toEqual(['open', 'simulate', 'execute'])
  })

  it('`verifyWithFacilitator` insère le contrôle en tête, sans régler', async () => {
    const { h, order } = ordered({ verifyWithFacilitator: true })
    await payWithX402(h, { actionSpec: transferAction() })
    expect(order).toEqual(['verify', 'simulate', 'open', 'execute'])
    expect(order).not.toContain('settle')
  })

  it('simule bien la même action que celle engagée', async () => {
    const h = harness()
    await payWithX402(h, { actionSpec: transferAction() })
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

    await payWithX402(honest, { actionSpec: transferAction() })
    await payWithX402(liar, {
      actionSpec: transferAction(),
      category: 'erc20.approve',
      bond: '1',
    })

    expect(liar.opened[0]).toEqual(honest.opened[0])
    expect(liar.opened[0]?.bond).toBe('5000000')
  })

  it('refuse une action non exécutable par KeeperHub avant toute ouverture', async () => {
    const h = harness()
    const { paid: res } = await payWithX402(h, { actionSpec: unknownAction() })
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
      await payWithX402(h, { actionSpec: transferAction() })
    ).paid.json()) as Record<string, string>

    const res = await h.app.request(`/v1/warrants/${opened['warrantId']}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const warrant = body['warrant'] as Record<string, unknown>
    expect(warrant['id']).toBe(opened['warrantId'])
    expect(warrant['status']).toBe('Open')
    // Le `fundingRef` est le nonce EIP-3009, c'est-à-dire le hash des termes —
    // plus un hash de transaction.
    expect(warrant['fundingRef']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(warrant['expiry']).toBe(NOW + POLICY.duration)
    expect(body['verdict']).toBeNull()
    expect(body['checks']).toEqual([])

    const spec = body['conditionSpec'] as { checks: { kind: string }[] }
    expect(spec.checks.some((c) => c.kind === COMMITMENT_KIND)).toBe(true)
  })

  it('rend le verdict et le détail checks[] une fois réglé', async () => {
    const h = harness()
    const opened = (await (
      await payWithX402(h, { actionSpec: transferAction() })
    ).paid.json()) as Record<string, string>

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

// ─────────────────────────────────────────────────────────────────────────────
// keeperHubEscrow — l'ouverture passe par KeeperHub, pas par une clé locale
// ─────────────────────────────────────────────────────────────────────────────

describe('keeperHubEscrow', () => {
  const ESCROW = `0x${'ad'.repeat(20)}` as Address
  /** Un `termsHash` quelconque : ce port ne le calcule pas, il le transporte. */
  const TERMS_NONCE = `0x${'f3'.repeat(32)}` as Hex
  const ESCROW_ABI = [{ type: 'function', name: 'open', inputs: [], outputs: [] }] as const

  const OPEN_ARGS: OpenWarrantArgs = {
    id: `0x${'11'.repeat(32)}` as Hex,
    beneficiary: BENEFICIARY,
    bond: '5000000',
    conditionHash: `0x${'22'.repeat(32)}` as Hex,
    actionHash: `0x${'33'.repeat(32)}` as Hex,
    duration: 3600,
    authorization: {
      from: AGENT,
      value: 5000000n,
      validAfter: 0n,
      validBefore: BigInt(NOW + 60),
      nonce: TERMS_NONCE,
      v: 27,
      r: `0x${'aa'.repeat(32)}` as Hex,
      s: `0x${'bb'.repeat(32)}` as Hex,
    },
  }

  /** La struct `Authorization` telle qu'elle doit partir chez KeeperHub. */
  const AUTH_ARG = {
    from: AGENT,
    value: '5000000',
    validAfter: '0',
    validBefore: String(NOW + 60),
    nonce: TERMS_NONCE,
    v: 27,
    r: `0x${'aa'.repeat(32)}`,
    s: `0x${'bb'.repeat(32)}`,
  }

  /** Client d'exécution enregistreur — un double de test, jamais un chemin runtime. */
  function recorder(execution: Partial<EscrowExecution>) {
    const calls: { req: EscrowContractCall; idempotencyKey?: string }[] = []
    const client: KeeperHubEscrowClient = {
      async executeContractCall(req, idempotencyKey) {
        calls.push(idempotencyKey === undefined ? { req } : { req, idempotencyKey })
        return { executionId: 'exec_open_1', status: 'success', ...execution }
      },
    }
    return { calls, client }
  }

  it('appelle open() avec les arguments dans l’ordre de l’ABI et rend le hash', async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    const escrow = keeperHubEscrow({
      address: ESCROW,
      chainId: 11155111,
      client,
      abi: ESCROW_ABI,
    })

    await expect(escrow.open(OPEN_ARGS)).resolves.toBe(OPEN_TX)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.req).toMatchObject({
      chainId: 11155111,
      contractAddress: ESCROW,
      functionName: 'open',
      abi: ESCROW_ABI,
    })
    // L'ordre est celui de l'ABI : KeeperHub positionne, il ne nomme pas.
    // `agent` et `fundingRef` ont disparu — le contrat les dérive de `auth`.
    expect(calls[0]!.req.functionArgs).toEqual([
      OPEN_ARGS.id,
      OPEN_ARGS.beneficiary,
      OPEN_ARGS.bond,
      OPEN_ARGS.conditionHash,
      OPEN_ARGS.actionHash,
      '3600',
      AUTH_ARG,
    ])
  })

  it("passe la struct `Authorization` en objet nommé, pas en tableau", async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open(
      OPEN_ARGS,
    )
    const auth = calls[0]!.req.functionArgs[6]
    // viem exige des composants nommés pour un tuple nommé. Un tableau
    // positionnel de huit champs dont quatre mots de 32 octets serait encodé
    // dans un ordre que rien ne vérifierait.
    expect(Array.isArray(auth)).toBe(false)
    expect(auth).toEqual(AUTH_ARG)
  })

  it("`value` et les bornes de validité restent des chaînes décimales", async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    const huge = 2n ** 255n
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open({
      ...OPEN_ARGS,
      bond: huge.toString(10),
      authorization: { ...OPEN_ARGS.authorization, value: huge },
    })
    const auth = calls[0]!.req.functionArgs[6] as Record<string, unknown>
    // Un `uint256` sérialisé en `number` JSON perdrait des unités atomiques en
    // silence — et `value` doit valoir `bond` au bit près (ValueMismatch).
    expect(auth['value']).toBe(huge.toString(10))
    expect(typeof auth['validAfter']).toBe('string')
    expect(typeof auth['validBefore']).toBe('string')
  })

  it("passe l'ABI : l'escrow n'est pas vérifié, l'auto-résolution échouerait", async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open(
      OPEN_ARGS,
    )
    expect(calls[0]!.req.abi).toBe(ESCROW_ABI)
  })

  it("`bond` et `duration` restent des chaînes : un uint256 ne tient pas dans un number", async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    const bond = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open({
      ...OPEN_ARGS,
      bond,
    })
    expect(calls[0]!.req.functionArgs[2]).toBe(bond)
    expect(typeof calls[0]!.req.functionArgs[5]).toBe('string')
  })

  it('utilise l’identifiant du mandat comme clé d’idempotence', async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open(
      OPEN_ARGS,
    )
    expect(calls[0]!.idempotencyKey).toBe(`warrant-open-${OPEN_ARGS.id}`)
  })

  it('refuse un succès sans hash : le Settler n’aurait rien à relire', async () => {
    const { client } = recorder({ status: 'success' })
    const escrow = keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI })
    await expect(escrow.open(OPEN_ARGS)).rejects.toThrow(/sans hash de transaction/)
  })

  it('propage un échec d’exécution avec son executionId', async () => {
    const { client } = recorder({ status: 'failed', error: 'NotOpener()' })
    const escrow = keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI })
    await expect(escrow.open(OPEN_ARGS)).rejects.toThrow(/NotOpener\(\).*exec_open_1/s)
  })

  it('le vrai KeeperHubClient satisfait le port, sans adaptateur', () => {
    // Assertion de type, pas d'appel réseau : c'est ici qu'on vérifie que la
    // redéclaration structurelle de `KeeperHubEscrowClient` ne diverge pas du
    // client réel. Une divergence casse la compilation, pas la production.
    const conforme: (c: KeeperHubClient) => KeeperHubEscrowClient = (c) => c
    expect(typeof conforme).toBe('function')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// keeperHubExecutor — le hash n'est pas dans la réponse de POST
// ─────────────────────────────────────────────────────────────────────────────

describe('keeperHubExecutor', () => {
  const CALL: KeeperHubCall = {
    chainId: 11155111,
    contractAddress: USDC_BASE,
    functionName: 'transfer',
    functionArgs: JSON.stringify([DEST, '1000000']),
  }

  it('va chercher le hash sur la route de statut quand POST ne le porte pas', async () => {
    // Forme réellement observée sur Sepolia : POST rend un 202 avec
    // `{ executionId, status }` et rien d'autre ; le hash n'est que sur /status.
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url)
      seen.push(href)
      if (href.endsWith('/api/execute/contract-call')) {
        return new Response(JSON.stringify({ executionId: 'exec_9', status: 'completed' }), {
          status: 202,
        })
      }
      return new Response(
        JSON.stringify({
          executionId: 'exec_9',
          status: 'completed',
          transactionHash: OPEN_TX,
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const executor = keeperHubExecutor({ apiKey: 'kh_test', fetchImpl })
    const outcome = await executor.executeContractCall(CALL, 'idem-1')

    expect(outcome).toEqual({
      executionId: 'exec_9',
      status: 'completed',
      txHash: OPEN_TX,
    })
    expect(seen[1]).toContain('/api/execute/exec_9/status')
  })

  it("n'appelle pas la route de statut quand le hash est déjà là", async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url))
      return new Response(
        JSON.stringify({ executionId: 'exec_10', status: 'success', transactionHash: OPEN_TX }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const executor = keeperHubExecutor({ apiKey: 'kh_test', fetchImpl })
    await executor.executeContractCall(CALL)
    expect(seen).toHaveLength(1)
  })
})
