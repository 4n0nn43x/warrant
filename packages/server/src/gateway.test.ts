import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMMITMENT_KIND,
  loadRegistry,
  registryRefOf,
  type Address,
  type Hex,
  type Policy,
} from 'warrant-core'
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
import { DEFAULT_MPP_METHOD } from './openapi.js'
import {
  challengeFromResponse,
  decodeReceipt as decodeSdkReceipt,
  mppAuthorization,
} from 'warrant-sdk/mpp'
import { X402_VERSION } from 'warrant-sdk'
import type { PaymentRequired, PaymentSigner } from 'warrant-sdk'
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
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = loadRegistry()
const REGISTRY_REF = registryRefOf(REGISTRY)

/** Native Ethereum USDC — present in the registry for `transfer` and `approve`. */
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const DEST = `0x${'de'.repeat(20)}` as Address
const TREASURY = `0x${'71'.repeat(20)}` as Address
const BENEFICIARY = `0x${'be'.repeat(20)}` as Address
const VAULT = `0x${'a1'.repeat(20)}` as Address
const AGENT = `0x${'a9'.repeat(20)}` as Address
const OPEN_TX = `0x${'0e'.repeat(32)}` as Hex

/**
 * A 65-byte signature whose last byte is 0x1b = 27.
 *
 * The old `0x2d…2d` padding had the right length and a `v` of 45, which
 * `ecrecover` cannot recover. Of no importance while the signature was merely
 * an opaque blob forwarded to the facilitator; it is now split into `v`/`r`/`s`
 * and passed to the contract, so its shape matters.
 */
const SIGNATURE = `0x${'aa'.repeat(32)}${'bb'.repeat(32)}1b` as Hex

/**
 * The **warrant** nonce — the one that enters `warrantId`.
 *
 * Distinct from the EIP-3009 authorization nonce, which equals `termsHash(...)`
 * and is therefore no longer free. Conflating the two was possible as long as
 * the second was random; it is now circular, `termsHash` containing `id` which
 * contains this very nonce.
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

/** `transfer(DEST, 100 USDC)` on Ethereum USDC. */
function transferAction() {
  return encodeActionSpec({
    chainId: 1,
    target: USDC,
    signature: 'transfer(address,uint256)',
    args: [DEST, '100000000'],
    registryRef: REGISTRY_REF,
  })
}

/** An action whose (chainId, target, selector) triple is outside the registry. */
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
 * The EIP-3009 authorization the rail carries.
 *
 * `to` equals `payTo`, and `payTo` **must** be the escrow in production: it is
 * the escrow that will call `receiveWithAuthorization`, and the `receive`
 * variant requires `to == msg.sender`. `bin/gateway.ts` refuses to start if the
 * two diverge; here `VAULT` plays both roles.
 */
const AUTHORIZATION = {
  from: AGENT,
  to: VAULT,
  value: '5000000',
  validAfter: String(NOW),
  validBefore: String(NOW + 60),
  // Replaced by the real `termsHash` in every payment: see `termsFrom`.
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

/** The terms a client must derive from the 402 before it can sign. */
interface Terms {
  /** The announced warrant nonce, to be sent back verbatim in `body.nonce`. */
  nonce: string
  id: Hex
  /** `termsHash(...)` — the nonce the EIP-3009 authorization must carry. */
  authNonce: Hex
  bond: string
}

/**
 * Replays what a client does: read the 402, derive `id`, compute the
 * `termsHash`.
 *
 * None of those computations were needed before: the client drew a random nonce
 * and signed six fields. The nonce now being the hash of the terms, signing the
 * payment *is* signing the terms — so they have to be known.
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
  // `id` is not announced and cannot be: the server does not yet know the
  // address that will sign. It is up to the client to compose it.
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
    realm: 'warrant',
    network: 'eip155:8453',
    asset: USDC_BASE,
    payTo: VAULT,
    assetExtra: { name: 'USDC', version: '2' },
    facilitator: {
      async verify() {
        counters.verified++
        return { isValid: true, payer: AGENT }
      },
      // `settle` is no longer on the opening path: `open()` charges the bond
      // itself. The counter stays, and staying at zero is the assertion.
      async settle() {
        counters.settled++
        throw new Error('settle() must no longer be called: open() charges')
      },
    },
    executor,
    escrow: {
      async open(args) {
        opened.push(args)
        return OPEN_TX
      },
    },
    mppSecret: 'test-secret',
    mppCurrency: 'USDC',
    store,
    verdicts: { get: (id) => verdicts.get(id.toLowerCase()) },
    now: () => NOW,
    // The warrant nonce is drawn when the 402 is issued and announced to the
    // client. Freezing it makes the terms — hence the `termsHash` —
    // reproducible under test.
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
 * The full x402 rail sequence: 402, terms derivation, payment.
 *
 * The two requests are now inseparable — the warrant nonce announced by the
 * first must come back in the second, or the `termsHash` no longer matches.
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

/** The full MPP rail sequence: 402, then Credential. */
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
  it('produces an exact round trip', () => {
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

  it('returns `functionArgs` as a JSON **string**, not an array', () => {
    const call = keeperHubCallOf(transferAction(), { registry: REGISTRY })
    expect(typeof call.functionArgs).toBe('string')
    expect(Array.isArray(call.functionArgs)).toBe(false)
    expect(JSON.parse(call.functionArgs)).toEqual([DEST, '100000000'])
    expect(call).toMatchObject({
      chainId: 1,
      contractAddress: USDC,
      functionName: 'transfer',
    })
    // No raw calldata field: the KeeperHub API ignores every one of them.
    expect(call).not.toHaveProperty('data')
    expect(call).not.toHaveProperty('calldata')
  })

  it('names multi-argument signatures too', () => {
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

  it('refuses an out-of-registry action when no signature is provided', () => {
    expect(() => keeperHubCallOf(unknownAction(), { registry: REGISTRY })).toThrow(
      /absent from the registry/,
    )
  })

  it('accepts a provided signature, but checks it against the calldata', () => {
    const spec = unknownAction()
    const call = keeperHubCallOf(spec, { registry: REGISTRY, signature: 'poke(uint256)' })
    expect(call.functionName).toBe('poke')
    // A lying signature cannot rename what is committed.
    expect(() =>
      keeperHubCallOf(spec, { registry: REGISTRY, signature: 'transfer(address,uint256)' }),
    ).toThrow(/inconsistent with the calldata's selector/)
  })

  it('refuses non-canonical calldata: the forwarded form would diverge from actionHash', () => {
    const spec = transferAction()
    const padded = { ...spec, calldata: `${spec.calldata}00000000` as Hex }
    expect(() => decodeActionSpec(padded, { registry: REGISTRY })).toThrow()
  })
})

describe('termsHashOf', () => {
  it('reproduces Solidity `abi.encode`, byte for byte', () => {
    // Vector obtained with `cast abi-encode` then `cast keccak` on the exact
    // signature of `WarrantEscrow.termsHash`. It is the only check that really
    // counts here: `termsHashOf` reimplements an onchain formula, and a
    // divergence would show up only as `TermsMismatch()` on the first paid
    // warrant — after the agent has signed.
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

  it('is sensitive to each of the six terms', () => {
    const base = {
      id: `0x${'11'.repeat(32)}` as Hex,
      beneficiary: '0x00000000000000000000000000000000000000b1' as Address,
      bond: '5000000',
      conditionHash: `0x${'22'.repeat(32)}` as Hex,
      actionHash: `0x${'33'.repeat(32)}` as Hex,
      duration: 3600,
    }
    const ref = termsHashOf(base)
    // Every term must move the hash: a term that does not enter it would be a
    // term the agent does not sign, hence one the opener could choose.
    expect(termsHashOf({ ...base, id: `0x${'12'.repeat(32)}` as Hex })).not.toBe(ref)
    expect(
      termsHashOf({ ...base, beneficiary: `0x${'be'.repeat(20)}` as Address }),
    ).not.toBe(ref)
    expect(termsHashOf({ ...base, bond: '5000001' })).not.toBe(ref)
    expect(termsHashOf({ ...base, conditionHash: `0x${'23'.repeat(32)}` as Hex })).not.toBe(ref)
    expect(termsHashOf({ ...base, actionHash: `0x${'34'.repeat(32)}` as Hex })).not.toBe(ref)
    // `duration` in particular: that is the one an opener would have raised to
    // MAX_DURATION in order to delay the agent's `reclaim`.
    expect(termsHashOf({ ...base, duration: 604800 })).not.toBe(ref)
  })
})

describe('warrantIdOf', () => {
  it('equals keccak256(abi.encode(agent, nonce, actionHash))', () => {
    const id = warrantIdOf(AGENT, 7n, `0x${'11'.repeat(32)}` as Hex)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    // Deterministic, and sensitive to each of the three arguments.
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

  it('is free and unauthenticated', async () => {
    const res = await post(h, '/v1/quote', { actionSpec: transferAction() })
    expect(res.status).toBe(200)
    expect(res.headers.get(HEADER_PAYMENT_REQUIRED)).toBeNull()
    expect(res.headers.get(HEADER_WWW_AUTHENTICATE)).toBeNull()
  })

  it('derives the category and the notional from the calldata', async () => {
    const res = await post(h, '/v1/quote', { actionSpec: transferAction() })
    const body = (await res.json()) as Record<string, unknown>
    expect(body['category']).toBe('erc20.transfer')
    expect(body['notionalUSD']).toBe('100000000')
    // 100 bps × $100 = $1, below the floor: the bond is minBond.
    expect(body['bond']).toBe('5000000')
  })

  it('returns a reproducible conditionHash', async () => {
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

  it('ignores a declared category: the calldata is what decides', async () => {
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

  it('injects calldata_matches_commitment into every conditionSpec produced', async () => {
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

  it('prices an unclassified action at maxBond', async () => {
    const res = await post(h, '/v1/quote', { actionSpec: unknownAction() })
    const body = (await res.json()) as Record<string, unknown>
    expect(body['category']).toBe('unknown')
    expect(body['bond']).toBe(POLICY.maxBond)
  })

  it('refuses in RFC 9457 a calldata the registry cannot decode', async () => {
    // `transfer` selector on USDC, but without its arguments: ABI decoding
    // fails, and a failed decoding is a refusal, never a fallback.
    const spec = { ...transferAction(), calldata: '0xa9059cbb' as Hex }
    const res = await post(h, '/v1/quote', { actionSpec: spec })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('classification_refused')
    expect(body['code']).toBe('DECODE_FAILED')
  })

  it('refuses a generic router wrapper selector', async () => {
    const spec = {
      ...transferAction(),
      // `execute(address,uint256,bytes)` — classification would see nothing but
      // an envelope and could assert nothing about the real effect.
      calldata: '0xb61d27f6' as Hex,
    }
    const res = await post(h, '/v1/quote', { actionSpec: spec })
    expect(res.status).toBe(422)
    expect((await res.json())['code']).toBe('GENERIC_ROUTER')
  })

  it('refuses a registryRef that is not the one of the registry in use', async () => {
    const spec = { ...transferAction(), registryRef: `0x${'00'.repeat(32)}` as Hex }
    const res = await post(h, '/v1/quote', { actionSpec: spec })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('registry_mismatch')
    // The expected value is returned: the correction takes a single round trip.
    expect(body['expected']).toBe(REGISTRY_REF)
  })

  it('refuses a malformed ActionSpec, with the path of the offending field', async () => {
    const res = await post(h, '/v1/quote', {
      actionSpec: { ...transferAction(), target: 'not-an-address' },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('invalid_spec')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 402 dual-rail
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/warrants — the 402', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('emits both challenges simultaneously, with a {} body', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    expect(res.status).toBe(402)
    expect(res.headers.get(HEADER_PAYMENT_REQUIRED)).toBeTruthy()
    expect(res.headers.get(HEADER_WWW_AUTHENTICATE)).toBeTruthy()
    expect(await res.json()).toEqual({})
  })

  it('the PAYMENT-REQUIRED is a base64-decodable PaymentRequired v2', async () => {
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

  it('the WWW-Authenticate is a complete MPP charge Challenge', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const header = res.headers.get(HEADER_WWW_AUTHENTICATE) as string
    expect(header.startsWith('Payment ')).toBe(true)

    const challenge = parseChallengeHeader(header)
    expect(challenge.realm).toBe('warrant')
    // `evm` and not `tempo`: two distinct methods in the MPP registry. We settle
    // an EIP-3009 authorization through the x402 facilitator on an EVM chain,
    // which is what `evm` designates; `tempo` is TIP-20 on the Tempo chain, a
    // request schema this Gateway does not implement.
    expect(challenge.method).toBe(DEFAULT_MPP_METHOD)
    expect(DEFAULT_MPP_METHOD).toBe('evm')
    expect(challenge.intent).toBe('charge')
    expect(challenge.id).toBeTruthy()
    expect(challenge.expires).toBeTruthy()

    const request = decodeJcs<MppRequestBody>(challenge.request)
    expect(request).toEqual({ amount: '5000000', currency: 'USDC', recipient: VAULT })

    // The announced amount is the same on both rails.
    const required = decodeHeaderObject<PaymentRequired>(
      res.headers.get(HEADER_PAYMENT_REQUIRED) as string,
    )
    expect(request.amount).toBe(required.accepts[0]?.amount)
  })

  it('opens nothing and settles nothing for as long as the payment is not there', async () => {
    await post(h, '/v1/warrants', { actionSpec: transferAction() })
    expect(h.opened).toHaveLength(0)
    expect(h.settled).toBe(0)
    expect(h.simulated).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Two rails, one and the same warrant
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/warrants — x402 rail', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('opens the warrant and executes', async () => {
    const { paid: res } = await payWithX402(h, { actionSpec: transferAction() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['executionId']).toBe('exec_warrant_1')
    expect(body['warrantId']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(body['expiry']).toBe(NOW + POLICY.duration)
    expect(h.opened).toHaveLength(1)
    expect(h.executed).toHaveLength(1)
  })

  it('returns PAYMENT-RESPONSE, and not Payment-Receipt', async () => {
    const { paid: res } = await payWithX402(h, { actionSpec: transferAction() })
    const receipt = res.headers.get(HEADER_PAYMENT_RESPONSE) as string
    expect(receipt).toBeTruthy()
    expect(res.headers.get(HEADER_PAYMENT_RECEIPT)).toBeNull()
    // The settlement reference is the hash of the `open`: that transaction is
    // the one that moved the USDC, the facilitator broadcasts none any more.
    expect(decodeHeaderObject<SettlementResponse>(receipt)).toMatchObject({
      success: true,
      transaction: OPEN_TX,
      payer: AGENT,
      amount: '5000000',
    })
  })

  it('no longer calls the facilitator: open() charges the bond', async () => {
    await payWithX402(h, { actionSpec: transferAction() })
    // Neither `/settle` — settlement lives inside `open()` — nor `/verify`,
    // which the facilitator would wrongly fail on a `receive` typehash.
    expect(h.settled).toBe(0)
    expect(h.verified).toBe(0)
  })

  it('passes the authorization to open(), split into v/r/s', async () => {
    const { terms } = await payWithX402(h, { actionSpec: transferAction() })
    expect(h.opened[0]?.authorization).toEqual({
      from: AGENT,
      value: 5000000n,
      validAfter: BigInt(NOW),
      validBefore: BigInt(NOW + 60),
      // The nonce **is** the hash of the terms: that is what binds the
      // signature to the warrant, where EIP-3009's six fields say nothing of it.
      nonce: terms.authNonce,
      v: 27,
      r: `0x${'aa'.repeat(32)}`,
      s: `0x${'bb'.repeat(32)}`,
    })
    expect(h.opened[0]?.id).toBe(terms.id)
  })

  it('refuses an authorization whose nonce does not equal the termsHash', async () => {
    // The hijack the contract closes: a valid authorization, signed for one
    // warrant, reused on different terms. Here we simulate the reverse — a
    // nonce that commits to no terms at all — and it is refused.
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

  it('requires the warrant nonce announced in the 402', async () => {
    const challenged = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const terms = termsFrom(challenged)
    // Correct payment, but `body.nonce` omitted: the server would draw another
    // one, hence another `id`, hence another termsHash. A named refusal rather
    // than an onchain TermsMismatch().
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_PAYMENT_SIGNATURE]: x402Header(terms),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('missing_nonce')
    expect(h.opened).toHaveLength(0)
  })

  it('the 402 announces every term the client has to sign', async () => {
    const challenged = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    const required = decodeHeaderObject<PaymentRequired>(
      challenged.headers.get(HEADER_PAYMENT_REQUIRED) as string,
    )
    const info = (
      required.extensions?.['warrant/commitment'] as { info: Record<string, unknown> }
    ).info
    // Without these six values, a client cannot compute the termsHash — hence
    // cannot sign an authorization that `open()` would accept.
    expect(info).toMatchObject({
      nonce: `0x${'7c'.repeat(32)}`,
      beneficiary: BENEFICIARY,
      bond: '5000000',
      duration: POLICY.duration,
      escrow: VAULT,
    })
    expect(info['conditionHash']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(info['actionHash']).toMatch(/^0x[0-9a-f]{64}$/)
    // And the typehash to sign, which is not the `exact` scheme's default one.
    expect(required.accepts[0]?.extra?.primaryType).toBe('ReceiveWithAuthorization')
  })

  it('no longer passes `agent` or `fundingRef`: the contract derives them', async () => {
    await payWithX402(h, { actionSpec: transferAction() })
    // This is the fix itself: an opener that declares the agent can award
    // itself any free balance of the contract.
    expect(h.opened[0]).not.toHaveProperty('agent')
    expect(h.opened[0]).not.toHaveProperty('fundingRef')
  })

  it('the signed bond must equal exactly the recomputed bond', async () => {
    // `open()` reverts with `ValueMismatch()` otherwise. We refuse upstream, so
    // that the client knows to re-sign rather than read an onchain revert.
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: 'http://warrant.test/v1/warrants' },
      accepted: requirements('5000000'),
      payload: {
        signature: SIGNATURE,
        // The announced amount is right, the **signed** one is not.
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

  it('refuses a signature that is not 65 bytes', async () => {
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

  it('forwards the named form to KeeperHub, not the calldata', async () => {
    await payWithX402(h, { actionSpec: transferAction() })
    expect(h.executed[0]).toEqual({
      chainId: 1,
      contractAddress: USDC,
      functionName: 'transfer',
      functionArgs: JSON.stringify([DEST, '100000000']),
    })
  })

  it('refuses a payment whose amount does not equal the bond', async () => {
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

  it('refuses when the facilitator invalidates the payment — if we ask it to', async () => {
    // `verifyWithFacilitator` is false by default, and that default is a
    // choice: a facilitator conformant to the `exact` scheme verifies the
    // `TransferWithAuthorization` typehash and would therefore invalidate every
    // one of our authorizations, which carry `ReceiveWithAuthorization`. The
    // check stays available for the day the facilitator can verify the right
    // variant.
    const strict = harness({
      verifyWithFacilitator: true,
      facilitator: {
        async verify() {
          return { isValid: false, invalidReason: 'insufficient_funds' }
        },
        async settle() {
          throw new Error('must never be called')
        },
      },
    })
    const { paid: res } = await payWithX402(strict, { actionSpec: transferAction() })
    expect(res.status).toBe(402)
    expect(strict.opened).toHaveLength(0)
  })
})

describe('POST /v1/warrants — MPP rail', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('opens the warrant from a Credential', async () => {
    const { paid } = await payWithMpp(h, { actionSpec: transferAction() })
    expect(paid.status).toBe(200)
    expect(h.opened).toHaveLength(1)
  })

  it('returns Payment-Receipt, and not PAYMENT-RESPONSE', async () => {
    const { paid, challenge } = await payWithMpp(h, { actionSpec: transferAction() })
    const header = paid.headers.get(HEADER_PAYMENT_RECEIPT) as string
    expect(header).toBeTruthy()
    expect(paid.headers.get(HEADER_PAYMENT_RESPONSE)).toBeNull()
    expect(decodeReceipt(header)).toMatchObject({
      challengeId: challenge.id,
      method: DEFAULT_MPP_METHOD,
      reference: OPEN_TX,
      status: 'success',
      settlement: { amount: '5000000', currency: 'USDC' },
    })
  })

  it('strictly refuses the replay of the same Credential', async () => {
    const { header, paid } = await payWithMpp(h, { actionSpec: transferAction() })
    expect(paid.status).toBe(200)

    const replay = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_AUTHORIZATION]: header,
    })
    expect(replay.status).toBe(409)
    expect(replay.headers.get('content-type')).toContain('application/problem+json')
    const body = (await replay.json()) as Record<string, unknown>
    expect(String(body['type'])).toContain('challenge_replayed')

    // No second warrant, no second execution. And still no call to the
    // facilitator: the replay is refused before it even reaches the opening.
    expect(h.opened).toHaveLength(1)
    expect(h.settled).toBe(0)
    expect(h.executed).toHaveLength(1)
  })

  it('refuses a Credential whose Challenge has been altered', async () => {
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

  it('returns its payment errors in RFC 9457, with both challenges', async () => {
    const res = await post(h, '/v1/warrants', { actionSpec: transferAction() }, {
      [HEADER_AUTHORIZATION]: 'Payment not-a-credential',
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe(402)
    expect(String(body['type'])).toMatch(/^urn:warrant:problem:/)
    expect(res.headers.get(HEADER_WWW_AUTHENTICATE)).toBeTruthy()
    expect(res.headers.get(HEADER_PAYMENT_REQUIRED)).toBeTruthy()
  })
})

describe('the MPP rail, driven by the published SDK', () => {
  /**
   * The rail exercised through `warrant-sdk/mpp` rather than through this
   * file's own helper.
   *
   * `payWithMpp` above builds the Credential by hand, so it proves the server
   * against itself: if the Gateway put its Challenge somewhere no real client
   * looks, or accepted a shape no published client emits, every test here would
   * still pass. This one goes through the functions an integrator actually
   * imports, and would fail on exactly that class of divergence.
   */
  it('finds the Challenge on the real 402 and gets a warrant opened', async () => {
    const h = harness()
    const challenged = await post(h, '/v1/warrants', { actionSpec: transferAction() })
    expect(challenged.status).toBe(402)

    // The SDK reads the response's headers, not a value we hand it.
    const challenge = challengeFromResponse(challenged.headers)
    expect(challenge).toBeDefined()
    expect(challenge!.method).toBe(DEFAULT_MPP_METHOD)

    const terms = termsFrom(challenged)
    const requiredHeader = challenged.headers.get(HEADER_PAYMENT_REQUIRED) as string
    const required = decodeHeaderObject<PaymentRequired>(requiredHeader)

    const signer: PaymentSigner = {
      createPayment: () => ({
        x402Version: X402_VERSION,
        resource: { url: 'http://warrant.test/v1/warrants' },
        accepted: required.accepts[0]!,
        payload: {
          signature: SIGNATURE,
          authorization: { ...AUTHORIZATION, nonce: terms.authNonce },
        },
      }),
    }

    const authorization = await mppAuthorization({
      required,
      challenge: challenge!,
      signer,
      source: `did:pkh:eip155:8453:${AGENT}`,
    })

    const paid = await post(
      h,
      '/v1/warrants',
      { actionSpec: transferAction(), nonce: terms.nonce },
      { [HEADER_AUTHORIZATION]: authorization },
    )
    expect(paid.status).toBe(200)

    // And the receipt the SDK decodes is the one the Gateway emitted.
    const receipt = decodeSdkReceipt(paid.headers.get('Payment-Receipt') as string)
    expect(receipt.challengeId).toBe(challenge!.id)
    expect(receipt.method).toBe(DEFAULT_MPP_METHOD)
    expect(receipt.status).toBe('success')

    const record = (await h.store.get((h.opened[0] as OpenWarrantArgs).id)) as Record<string, unknown>
    expect(record['rail']).toBe('mpp')
  })
})

describe('both rails produce an identical warrant', () => {
  it('same conditionHash, same bond, same fundingRef', async () => {
    const viaX402 = harness()
    const viaMpp = harness()

    const { paid: x402Res } = await payWithX402(viaX402, { actionSpec: transferAction() })
    const { paid: mppRes } = await payWithMpp(viaMpp, { actionSpec: transferAction() })

    expect(x402Res.status).toBe(200)
    expect(mppRes.status).toBe(200)

    // 1. The body of the response, field by field.
    expect(await mppRes.json()).toEqual(await x402Res.json())

    // 2. The onchain opening arguments, field by field.
    const a = viaX402.opened[0] as OpenWarrantArgs
    const b = viaMpp.opened[0] as OpenWarrantArgs
    expect(b).toEqual(a)
    for (const key of Object.keys(a) as (keyof OpenWarrantArgs)[]) {
      // `toEqual` and not `toBe`: `authorization` is a struct rebuilt on either
      // side, hence never the same instance. It is its content that must be
      // identical — and it is, both rails carrying the same signature.
      expect(b[key]).toEqual(a[key])
    }
    // The `fundingRef` is the authorization's nonce, that is to say the hash of
    // the terms. Both rails serving the same terms, it is identical by
    // construction — where the old settlement hash depended on the facilitator.
    expect(a.authorization.nonce).toBe(b.authorization.nonce)
    expect(a.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/)

    // 3. The recorded warrant, apart from the rail itself.
    const recordA = (await viaX402.store.get(a.id)) as Record<string, unknown>
    const recordB = (await viaMpp.store.get(b.id)) as Record<string, unknown>
    expect(recordA['rail']).toBe('x402')
    expect(recordB['rail']).toBe('mpp')
    const { rail: _a, ...restA } = recordA
    const { rail: _b, ...restB } = recordB
    expect(restB).toEqual(restA)

    // 4. And the call forwarded to KeeperHub.
    expect(viaMpp.executed).toEqual(viaX402.executed)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Simulation
// ─────────────────────────────────────────────────────────────────────────────

describe('KeeperHub simulation', () => {
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
          return { executionId: 'must-not-happen', status: 'success' }
        },
      } as ExecutorPort,
    }
  }

  it('failed simulation → 4xx, no warrant opened, no bond charged', async () => {
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

    // No warrant, no bond, no execution.
    expect(h.opened).toHaveLength(0)
    expect(h.settled).toBe(0)
    expect(executed).toHaveLength(0)
  })

  it('a lone `wouldRevert` is enough to refuse, even when `success` is true', async () => {
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
          throw new Error('settle() must no longer be called')
        },
      },
      ...over,
    })
    return { h, order }
  }

  it('simulates before opening — the opening charges, it must not pay for a foreseeable failure', async () => {
    const { h, order } = ordered()
    await payWithX402(h, { actionSpec: transferAction() })
    // No more `settle` step: `open` contains it. And no `verify` by default.
    expect(order).toEqual(['simulate', 'open', 'execute'])
  })

  it('`openBeforeSimulate` restores the literal order of docs/04', async () => {
    const { h, order } = ordered({ openBeforeSimulate: true })
    await payWithX402(h, { actionSpec: transferAction() })
    expect(order).toEqual(['open', 'simulate', 'execute'])
  })

  it('`verifyWithFacilitator` inserts the check up front, without settling', async () => {
    const { h, order } = ordered({ verifyWithFacilitator: true })
    await payWithX402(h, { actionSpec: transferAction() })
    expect(order).toEqual(['verify', 'simulate', 'open', 'execute'])
    expect(order).not.toContain('settle')
  })

  it('simulates the very action that is committed', async () => {
    const h = harness()
    await payWithX402(h, { actionSpec: transferAction() })
    expect(h.simulated).toEqual(h.executed)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The declared category stays ignored on the paid route
// ─────────────────────────────────────────────────────────────────────────────

describe('the declared category is ignored all the way into the warrant', () => {
  it('produces the same commitment with or without a `category` field', async () => {
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

  it('refuses an action KeeperHub cannot execute, before any opening', async () => {
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
  it('returns the warrant, its committed conditionSpec, and no verdict yet', async () => {
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
    // The `fundingRef` is the EIP-3009 nonce, that is to say the hash of the
    // terms — no longer a transaction hash.
    expect(warrant['fundingRef']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(warrant['expiry']).toBe(NOW + POLICY.duration)
    expect(body['verdict']).toBeNull()
    expect(body['checks']).toEqual([])

    const spec = body['conditionSpec'] as { checks: { kind: string }[] }
    expect(spec.checks.some((c) => c.kind === COMMITMENT_KIND)).toBe(true)
  })

  it('returns the verdict and the checks[] detail once settled', async () => {
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

  it('returns a 404 Problem Details for an unknown warrant', async () => {
    const h = harness()
    const res = await h.app.request(`/v1/warrants/0x${'00'.repeat(32)}`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
  })

  it('refuses an identifier that is not a bytes32', async () => {
    const h = harness()
    expect((await h.app.request('/v1/warrants/not-an-id')).status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /openapi.json', () => {
  it('serves an OpenAPI 3.1 with x-payment-info in the format observed at KeeperHub', async () => {
    const h = harness()
    const doc = (await (await h.app.request('/openapi.json')).json()) as Record<string, any>

    expect(doc['openapi']).toBe('3.1.0')

    const info = doc['paths']['/v1/warrants']['post']['x-payment-info']
    expect(info['protocols']).toEqual([
      { x402: { network: 'eip155:8453' } },
      { mpp: { method: DEFAULT_MPP_METHOD, intent: 'charge', currency: 'USDC' } },
    ])

    // Dynamic price: it is computed by the Risk Pricer, it cannot be fixed.
    expect(info['price']['mode']).toBe('dynamic')
    expect(info['price']['currency']).toBe('USD')
    expect(info['price']['min']).toBe('5')
    expect(info['price']['max']).toBe('250')
    expect(info['price']['quote']).toMatchObject({ path: '/v1/quote', cost: 'free' })
  })

  it('describes both rails on the paid route', async () => {
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

  it('does not charge for /v1/quote', async () => {
    const h = harness()
    const doc = (await (await h.app.request('/openapi.json')).json()) as Record<string, any>
    expect(doc['paths']['/v1/quote']['post']['x-payment-info']).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// keeperHubEscrow — the opening goes through KeeperHub, not through a local key
// ─────────────────────────────────────────────────────────────────────────────

describe('keeperHubEscrow', () => {
  const ESCROW = `0x${'ad'.repeat(20)}` as Address
  /** Some `termsHash` or other: this port does not compute it, it carries it. */
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

  /** The `Authorization` struct as it must leave for KeeperHub. */
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

  /** Recording execution client — a test double, never a runtime path. */
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

  it('calls open() with the arguments in ABI order and returns the hash', async () => {
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
    // The order is the ABI's: KeeperHub positions, it does not name.
    // `agent` and `fundingRef` are gone — the contract derives them from `auth`.
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

  it('passes the `Authorization` struct as a named object, not as an array', async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open(
      OPEN_ARGS,
    )
    const auth = calls[0]!.req.functionArgs[6]
    // viem requires named components for a named tuple. A positional array of
    // eight fields, four of which are 32-byte words, would be encoded in an
    // order that nothing would check.
    expect(Array.isArray(auth)).toBe(false)
    expect(auth).toEqual(AUTH_ARG)
  })

  it('`value` and the validity bounds stay decimal strings', async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    const huge = 2n ** 255n
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open({
      ...OPEN_ARGS,
      bond: huge.toString(10),
      authorization: { ...OPEN_ARGS.authorization, value: huge },
    })
    const auth = calls[0]!.req.functionArgs[6] as Record<string, unknown>
    // A `uint256` serialised as a JSON `number` would lose atomic units in
    // silence — and `value` must equal `bond` to the bit (ValueMismatch).
    expect(auth['value']).toBe(huge.toString(10))
    expect(typeof auth['validAfter']).toBe('string')
    expect(typeof auth['validBefore']).toBe('string')
  })

  it('passes the ABI: the escrow is not verified, auto-resolution would fail', async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open(
      OPEN_ARGS,
    )
    expect(calls[0]!.req.abi).toBe(ESCROW_ABI)
  })

  it('`bond` and `duration` stay strings: a uint256 does not fit in a number', async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    const bond = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open({
      ...OPEN_ARGS,
      bond,
    })
    expect(calls[0]!.req.functionArgs[2]).toBe(bond)
    expect(typeof calls[0]!.req.functionArgs[5]).toBe('string')
  })

  it('uses the warrant identifier as the idempotency key', async () => {
    const { calls, client } = recorder({ txHash: OPEN_TX })
    await keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI }).open(
      OPEN_ARGS,
    )
    expect(calls[0]!.idempotencyKey).toBe(`warrant-open-${OPEN_ARGS.id}`)
  })

  it('refuses a success with no hash: the Settler would have nothing to re-read', async () => {
    const { client } = recorder({ status: 'success' })
    const escrow = keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI })
    await expect(escrow.open(OPEN_ARGS)).rejects.toThrow(/without a transaction hash/)
  })

  it('propagates an execution failure together with its executionId', async () => {
    const { client } = recorder({ status: 'failed', error: 'NotOpener()' })
    const escrow = keeperHubEscrow({ address: ESCROW, chainId: 1, client, abi: ESCROW_ABI })
    await expect(escrow.open(OPEN_ARGS)).rejects.toThrow(/NotOpener\(\).*exec_open_1/s)
  })

  it('the real KeeperHubClient satisfies the port, with no adapter', () => {
    // A type assertion, not a network call: this is where we verify that the
    // structural redeclaration of `KeeperHubEscrowClient` does not diverge from
    // the real client. A divergence breaks compilation, not production.
    const conforms: (c: KeeperHubClient) => KeeperHubEscrowClient = (c) => c
    expect(typeof conforms).toBe('function')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// keeperHubExecutor — the hash is not in the POST response
// ─────────────────────────────────────────────────────────────────────────────

describe('keeperHubExecutor', () => {
  const CALL: KeeperHubCall = {
    chainId: 11155111,
    contractAddress: USDC_BASE,
    functionName: 'transfer',
    functionArgs: JSON.stringify([DEST, '1000000']),
  }

  it('fetches the hash from the status route when POST does not carry it', async () => {
    // The shape actually observed on Sepolia: POST returns a 202 with
    // `{ executionId, status }` and nothing else; the hash is only on /status.
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

  it('does not call the status route when the hash is already there', async () => {
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
