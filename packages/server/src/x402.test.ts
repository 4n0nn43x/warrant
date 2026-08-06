import { describe, expect, it } from 'vitest'
import type { Hex } from '@warrant/core'
import {
  ChallengeStore,
  DEFAULT_TRANSFER_METHOD,
  FacilitatorClient,
  FacilitatorError,
  HEADER_AUTHORIZATION,
  HEADER_PAYMENT_RECEIPT,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_WWW_AUTHENTICATE,
  MppError,
  PROBLEM_CONTENT_TYPE,
  PaymentRejected,
  WireFormatError,
  RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
  X402_VERSION,
  addressFromSource,
  assertPayloadMatches,
  b64decode,
  buildPaymentRequired,
  decodeCredentialHeader,
  decodeHeaderObject,
  decodeJcs,
  decodeReceipt,
  encodeCredential,
  encodeHeaderObject,
  encodeJcs,
  encodeReceipt,
  escrowAuthorizationOf,
  formatChallengeHeader,
  fundingRefOfAuthorization,
  parseChallengeHeader,
  paymentPayloadFromCredential,
  problem,
  settlementTxOf,
  type MppCredential,
  type MppRequestBody,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
} from './x402.js'

/**
 * A 65-byte signature whose last byte is 0x1b = 27.
 *
 * `v` can only be 27 or 28 — that is what `ecrecover` accepts. The old `0x2d…2d`
 * filler in these tests gave v = 45, which the contract would have refused: a
 * signature of the right *length* is not a signature of the right *shape*.
 */
const SIGNATURE = `0x${'aa'.repeat(32)}${'bb'.repeat(32)}1b` as Hex

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const VAULT = `0x${'ab'.repeat(20)}`
const AGENT = `0x${'cd'.repeat(20)}`
const TX = `0x${'12'.repeat(32)}` as Hex

const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '25000000',
  asset: USDC_BASE,
  payTo: VAULT,
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
}

function payload(over: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    resource: { url: 'https://gateway.example/v1/warrants' },
    accepted: REQUIREMENTS,
    payload: {
      signature: SIGNATURE,
      authorization: {
        from: AGENT,
        to: VAULT,
        value: '25000000',
        validAfter: '1785000000',
        validBefore: '1785000060',
        nonce: `0x${'f3'.repeat(32)}` as Hex,
      },
    },
    extensions: {},
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('x402 v2 — wire names', () => {
  it('uses the v2 headers, never v1’s X-PAYMENT', () => {
    expect(HEADER_PAYMENT_REQUIRED).toBe('PAYMENT-REQUIRED')
    expect(HEADER_PAYMENT_SIGNATURE).toBe('PAYMENT-SIGNATURE')
    expect(HEADER_PAYMENT_RESPONSE).toBe('PAYMENT-RESPONSE')
    expect(HEADER_PAYMENT_SIGNATURE).not.toBe('X-PAYMENT')
  })

  it('uses the RFC 9110 headers for MPP', () => {
    expect(HEADER_WWW_AUTHENTICATE).toBe('WWW-Authenticate')
    expect(HEADER_AUTHORIZATION).toBe('Authorization')
    expect(HEADER_PAYMENT_RECEIPT).toBe('Payment-Receipt')
  })

  it('encodes and decodes a header in base64 without loss', () => {
    const encoded = encodeHeaderObject({ a: 1, é: 'ü' })
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(decodeHeaderObject(encoded)).toEqual({ a: 1, é: 'ü' })
  })

  it('rejects an unreadable header rather than falling back to an empty object', () => {
    expect(() => decodeHeaderObject('not-encoded-json')).toThrow(WireFormatError)
  })
})

describe('PaymentRequired', () => {
  const required = buildPaymentRequired({
    resource: {
      url: 'https://gateway.example/v1/warrants',
      description: 'Bond for a KeeperHub-executed action',
      mimeType: 'application/json',
    },
    network: 'eip155:8453',
    amount: '25000000',
    asset: USDC_BASE,
    payTo: VAULT,
    extra: { name: 'USDC', version: '2' },
  })

  it('announces version 2', () => {
    expect(required.x402Version).toBe(2)
  })

  it('announces the network in CAIP-2, not a bare chainId', () => {
    expect(required.accepts[0]?.network).toBe('eip155:8453')
    expect(required.accepts[0]?.network).toMatch(/^eip155:\d+$/)
  })

  it('announces `eip3009-receive`, and NOT the normative default of the exact scheme', () => {
    expect(required.accepts[0]?.scheme).toBe('exact')
    expect(required.accepts[0]?.extra?.assetTransferMethod).toBe(DEFAULT_TRANSFER_METHOD)

    // This assertion exists to stop anyone from "fixing" the fix. The spec says
    // `if present, MUST be "eip3009"`, and `eip3009` there designates
    // `transferWithAuthorization`. The escrow, for its part, consumes
    // `receiveWithAuthorization`. Announcing `eip3009` would make every
    // conforming client sign the wrong typehash, and `open()` would revert —
    // verified against the CDP facilitator, which answers 400
    // invalid_exact_evm_payload_signature. The non-conformance is therefore
    // deliberate, and it is explicit rather than hidden behind a standard field
    // that would lie.
    expect(DEFAULT_TRANSFER_METHOD).toBe('eip3009-receive')
    expect(DEFAULT_TRANSFER_METHOD).not.toBe('eip3009')
  })

  it('carries the token’s EIP-712 domain in extra', () => {
    expect(required.accepts[0]?.extra).toMatchObject({ name: 'USDC', version: '2' })
  })

  it('announces the `receive` typehash, not the exact scheme’s default', () => {
    // The one field of the 402 a client cannot guess: the two EIP-3009 typehashes
    // carry exactly the same fields, and signing the wrong one is only discovered
    // when the token reverts.
    expect(required.accepts[0]?.extra?.primaryType).toBe('ReceiveWithAuthorization')
    expect(RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE).toBe('ReceiveWithAuthorization')
    expect(required.accepts[0]?.extra?.primaryType).not.toBe('TransferWithAuthorization')
  })

  it('tightens the payment window to 60 s', () => {
    expect(required.accepts[0]?.maxTimeoutSeconds).toBe(60)
  })
})

describe('assertPayloadMatches', () => {
  it('accepts a conforming payload', () => {
    expect(() => assertPayloadMatches(payload(), REQUIREMENTS)).not.toThrow()
  })

  it('rejects an amount other than the required one', () => {
    const p = payload({ accepted: { ...REQUIREMENTS, amount: '1' } })
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(PaymentRejected)
  })

  it('rejects an authorization whose value does not equal the required amount', () => {
    const p = payload()
    p.payload.authorization.value = '1'
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(/amount/i)
  })

  it('rejects a diverted destination', () => {
    const p = payload()
    p.payload.authorization.to = `0x${'ee'.repeat(20)}`
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(PaymentRejected)
  })

  it('rejects another network, another asset, another scheme', () => {
    for (const over of [
      { network: 'eip155:1' },
      { asset: `0x${'99'.repeat(20)}` },
      { scheme: 'upto' as unknown as 'exact' },
    ]) {
      const p = payload({ accepted: { ...REQUIREMENTS, ...over } })
      expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(PaymentRejected)
    }
  })

  it('rejects any protocol version other than 2', () => {
    const p = payload({ x402Version: 1 as unknown as typeof X402_VERSION })
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(/x402Version/)
  })

  it('compares addresses regardless of EIP-55 casing', () => {
    const p = payload({ accepted: { ...REQUIREMENTS, asset: USDC_BASE.toUpperCase() } })
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

function stubFetch(routes: Record<string, unknown>, seen: string[] = []) {
  const impl = (async (url: string, init?: { body?: string }) => {
    const path = new URL(url).pathname
    seen.push(path)
    const body = routes[path]
    if (body === undefined) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }
    if (init?.body) JSON.parse(init.body)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return impl
}

describe('facilitator — /verify and /settle are not symmetric', () => {
  it('reads `isValid` on /verify', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({ '/verify': { isValid: true, payer: AGENT } }),
    })
    await expect(client.verify(payload(), REQUIREMENTS)).resolves.toMatchObject({
      isValid: true,
      payer: AGENT,
    })
  })

  it('reads `success` on /settle', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({
        '/settle': {
          success: true,
          transaction: TX,
          network: 'eip155:8453',
          payer: AGENT,
        },
      }),
    })
    await expect(client.settle(payload(), REQUIREMENTS)).resolves.toMatchObject({
      success: true,
      transaction: TX,
    })
  })

  it('rejects a /verify that would answer `success` — the asymmetry trap', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({ '/verify': { success: true, payer: AGENT } }),
    })
    await expect(client.verify(payload(), REQUIREMENTS)).rejects.toThrow(FacilitatorError)
  })

  it('rejects a /settle that would answer `isValid`', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({ '/settle': { isValid: true, transaction: TX } }),
    })
    await expect(client.settle(payload(), REQUIREMENTS)).rejects.toThrow(FacilitatorError)
  })

  it('propagates isValid=false without confusing it with an error', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({
        '/verify': { isValid: false, invalidReason: 'insufficient_funds' },
      }),
    })
    await expect(client.verify(payload(), REQUIREMENTS)).resolves.toMatchObject({
      isValid: false,
      invalidReason: 'insufficient_funds',
    })
  })

  it('does call /verify then /settle on the configured facilitator', async () => {
    const seen: string[] = []
    const client = new FacilitatorClient({
      url: 'https://facilitator.test/',
      fetchImpl: stubFetch(
        {
          '/verify': { isValid: true },
          '/settle': { success: true, transaction: TX, network: 'eip155:8453', payer: AGENT },
        },
        seen,
      ),
    })
    await client.verify(payload(), REQUIREMENTS)
    await client.settle(payload(), REQUIREMENTS)
    expect(seen).toEqual(['/verify', '/settle'])
  })

  it('throws a FacilitatorError on a non-2xx HTTP status', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({}),
    })
    await expect(client.verify(payload(), REQUIREMENTS)).rejects.toThrow(FacilitatorError)
  })
})

describe('settlementTxOf', () => {
  it('is the settlement transaction hash, lowercased', () => {
    const settlement: SettlementResponse = {
      success: true,
      transaction: TX.toUpperCase() as Hex,
      network: 'eip155:8453',
      payer: AGENT,
    }
    expect(settlementTxOf(settlement)).toBe(TX)
  })

  it('rejects a settlement with no usable hash', () => {
    expect(() =>
      settlementTxOf({
        success: true,
        transaction: '0xdeadbeef' as Hex,
        network: 'eip155:8453',
        payer: AGENT,
      }),
    ).toThrow(PaymentRejected)
  })
})

describe('fundingRef = nonce EIP-3009', () => {
  it('is the authorization nonce, lowercased — not a transaction hash', () => {
    const nonce = `0x${'F3'.repeat(32)}` as Hex
    expect(fundingRefOfAuthorization({ ...payload().payload.authorization, nonce })).toBe(
      `0x${'f3'.repeat(32)}`,
    )
  })

  it('rejects a nonce that is not 32 bytes', () => {
    // The contract would accept it — the ABI encoder would left-pad — but the
    // value the agent signed would then not be the one submitted to the token.
    for (const nonce of ['0xf3', `0x${'f3'.repeat(33)}`, 'not-hex']) {
      expect(() =>
        fundingRefOfAuthorization({
          ...payload().payload.authorization,
          nonce: nonce as Hex,
        }),
      ).toThrow(PaymentRejected)
    }
  })
})

describe('escrowAuthorizationOf', () => {
  it('splits the signature into v, r, s and coerces the integers', () => {
    const auth = escrowAuthorizationOf(payload().payload)
    expect(auth).toEqual({
      from: AGENT,
      value: 25000000n,
      validAfter: 1785000000n,
      validBefore: 1785000060n,
      nonce: `0x${'f3'.repeat(32)}`,
      v: 27,
      r: `0x${'aa'.repeat(32)}`,
      s: `0x${'bb'.repeat(32)}`,
    })
  })

  it('does not expose `to`: the contract passes address(this), it does not declare it', () => {
    expect(escrowAuthorizationOf(payload().payload)).not.toHaveProperty('to')
  })

  it('rejects a signature that is not 65 bytes', () => {
    for (const signature of [`0x${'aa'.repeat(64)}`, `0x${'aa'.repeat(66)}`, '0x']) {
      expect(() =>
        escrowAuthorizationOf({
          ...payload().payload,
          signature: signature as Hex,
        }),
      ).toThrow(PaymentRejected)
    }
  })

  it('rejects a v that ecrecover could not recover from', () => {
    // 0x2d = 45. That is the value the old test filler produced: correct length,
    // impossible `v`.
    expect(() =>
      escrowAuthorizationOf({
        ...payload().payload,
        signature: `0x${'aa'.repeat(32)}${'bb'.repeat(32)}2d` as Hex,
      }),
    ).toThrow(PaymentRejected)
  })

  it('normalises a trailing byte of 0/1 into 27/28', () => {
    // viem returns `yParity` without `v` on this shape; the token does an
    // `ecrecover`, which wants 27 or 28.
    expect(
      escrowAuthorizationOf({
        ...payload().payload,
        signature: `0x${'aa'.repeat(32)}${'bb'.repeat(32)}00` as Hex,
      }).v,
    ).toBe(27)
    expect(
      escrowAuthorizationOf({
        ...payload().payload,
        signature: `0x${'aa'.repeat(32)}${'bb'.repeat(32)}01` as Hex,
      }).v,
    ).toBe(28)
  })

  it('rejects an authorization whose fields are not usable', () => {
    const base = payload().payload
    expect(() =>
      escrowAuthorizationOf({ ...base, authorization: { ...base.authorization, from: 'x' } }),
    ).toThrow(PaymentRejected)
    expect(() =>
      escrowAuthorizationOf({
        ...base,
        authorization: { ...base.authorization, value: 'lots' },
      }),
    ).toThrow(PaymentRejected)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MPP
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST: MppRequestBody = {
  amount: '25000000',
  currency: USDC_BASE,
  recipient: VAULT,
}

function store(now = () => 1_785_000_000) {
  let n = 0
  return new ChallengeStore<{ bond: string }>({
    secret: 'test-secret',
    ttlSeconds: 300,
    now,
    salt: () => `salt-${n++}`,
  })
}

function issue(s: ReturnType<typeof store>) {
  return s.issue({
    realm: 'warrant',
    method: 'tempo',
    intent: 'charge',
    request: REQUEST,
    opaque: { route: '/v1/warrants' },
    context: { bond: '25000000' },
  })
}

function credentialFor(challenge: ReturnType<typeof issue>): MppCredential {
  return {
    challenge,
    payload: {
      type: 'transaction',
      signature: SIGNATURE,
      authorization: payload().payload.authorization,
    },
    source: `did:pkh:eip155:8453:${AGENT}`,
  }
}

describe('MPP Challenge', () => {
  const challenge = issue(store())

  it('carries the required parameters, intent charge', () => {
    expect(challenge.realm).toBe('warrant')
    expect(challenge.method).toBe('tempo')
    expect(challenge.intent).toBe('charge')
    expect(challenge.id).not.toBe('')
    expect(challenge.request).not.toBe('')
    expect(challenge.expires).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('encodes `request` as base64url JCS JSON', () => {
    expect(challenge.request).not.toMatch(/[+/=]/)
    expect(decodeJcs(challenge.request)).toEqual(REQUEST)
    // JCS sorts the keys: the shape is deterministic, hence replayable.
    expect(b64decode(challenge.request)).toBe(
      '{"amount":"25000000","currency":"' + USDC_BASE + '","recipient":"' + VAULT + '"}',
    )
  })

  it('writes and reads back as a WWW-Authenticate header', () => {
    const header = formatChallengeHeader(challenge)
    expect(header.startsWith('Payment ')).toBe(true)
    expect(header).toContain('intent="charge"')
    expect(parseChallengeHeader(header)).toEqual(challenge)
  })

  it('rejects a header from another authentication scheme', () => {
    expect(() => parseChallengeHeader('Bearer abc')).toThrow(WireFormatError)
  })

  it('binds its id to the parameters: two different amounts, two ids', () => {
    const s = store()
    const a = s.issue({
      realm: 'warrant',
      method: 'tempo',
      intent: 'charge',
      request: REQUEST,
      context: { bond: '25000000' },
    })
    const b = s.issue({
      realm: 'warrant',
      method: 'tempo',
      intent: 'charge',
      request: { ...REQUEST, amount: '1' },
      context: { bond: '1' },
    })
    expect(a.id).not.toBe(b.id)
  })

  it('never produces the same id twice for the same action', () => {
    const s = store()
    expect(issue(s).id).not.toBe(issue(s).id)
  })
})

describe('MPP Credential', () => {
  it('writes and reads back as an Authorization: Payment header', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    const header = `Payment ${encodeCredential(credential)}`
    expect(decodeCredentialHeader(header)).toEqual(credential)
  })

  it('is consumed once, and only once', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    expect(s.consume(credential).context.bond).toBe('25000000')
    expect(() => s.consume(credential)).toThrow(MppError)
    try {
      s.consume(credential)
    } catch (err) {
      expect((err as MppError).code).toBe('challenge_replayed')
    }
  })

  it('rejects an unknown Challenge', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    credential.challenge = { ...credential.challenge, id: 'never-issued' }
    try {
      s.consume(credential)
      expect.unreachable()
    } catch (err) {
      expect((err as MppError).code).toBe('unknown_challenge')
    }
  })

  it('rejects an expired Challenge', () => {
    let t = 1_785_000_000
    const s = store(() => t)
    const credential = credentialFor(issue(s))
    t += 301
    try {
      s.consume(credential)
      expect.unreachable()
    } catch (err) {
      expect((err as MppError).code).toBe('challenge_expired')
    }
  })

  it('rejects a Challenge echoed back with a modified amount', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    credential.challenge = {
      ...credential.challenge,
      request: encodeJcs({ ...REQUEST, amount: '1' }),
    }
    try {
      s.consume(credential)
      expect.unreachable()
    } catch (err) {
      expect((err as MppError).code).toBe('challenge_tampered')
    }
  })

  it('rejects an `opaque` that is not sent back unchanged', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    credential.challenge = {
      ...credential.challenge,
      opaque: encodeJcs({ route: '/v1/other' }),
    }
    try {
      s.consume(credential)
      expect.unreachable()
    } catch (err) {
      expect((err as MppError).code).toBe('opaque_mismatch')
    }
  })

  it('purges the expired Challenges', () => {
    let t = 1_785_000_000
    const s = store(() => t)
    issue(s)
    expect(s.size).toBe(1)
    t += 301
    s.gc()
    expect(s.size).toBe(0)
  })
})

describe('MPP → x402 bridge', () => {
  it('rebuilds a PaymentPayload the facilitator can verify', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    const built = paymentPayloadFromCredential(
      credential,
      REQUIREMENTS,
      'https://gateway.example/v1/warrants',
    )
    expect(built.x402Version).toBe(2)
    expect(() => assertPayloadMatches(built, REQUIREMENTS)).not.toThrow()
    // The same authorization as on the x402 rail: that is what makes the
    // settlement, and hence the fundingRef, identical on both sides.
    expect(built.payload.authorization).toEqual(payload().payload.authorization)
  })

  it('rejects the `hash` and `proof` payloads, out of v1 scope', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    for (const type of ['hash', 'proof'] as const) {
      const c = { ...credential, payload: { ...credential.payload, type } }
      expect(() =>
        paymentPayloadFromCredential(c, REQUIREMENTS, 'https://x'),
      ).toThrow(PaymentRejected)
    }
  })

  it('rejects a `transaction` payload with no signed authorization', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    expect(() =>
      paymentPayloadFromCredential(
        { ...credential, payload: { type: 'transaction' } },
        REQUIREMENTS,
        'https://x',
      ),
    ).toThrow(PaymentRejected)
  })

  it('extracts the address from a PKH DID source as from a bare address', () => {
    expect(addressFromSource(`did:pkh:eip155:4217:${AGENT}`)).toBe(AGENT)
    expect(addressFromSource(AGENT.toUpperCase())).toBe(AGENT)
    expect(addressFromSource('anonymous')).toBeUndefined()
  })
})

describe('MPP Receipt', () => {
  it('encodes to base64url and reads back', () => {
    const receipt = {
      challengeId: 'abc',
      method: 'tempo' as const,
      reference: TX,
      settlement: { amount: '25000000', currency: 'USDC' },
      status: 'success' as const,
      timestamp: '2026-08-13T12:00:00.000Z',
    }
    const encoded = encodeReceipt(receipt)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(decodeReceipt(encoded)).toEqual(receipt)
  })
})

describe('RFC 9457', () => {
  it('produces a typed Problem Details', () => {
    const p = problem('challenge_replayed', 409, 'Credential already used', 'detail', {
      rail: 'mpp',
    })
    expect(p.type).toBe('urn:warrant:problem:challenge_replayed')
    expect(p).toMatchObject({ title: 'Credential already used', status: 409, rail: 'mpp' })
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json')
  })
})
