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
 * Une signature de 65 octets dont le dernier vaut 0x1b = 27.
 *
 * `v` ne peut être que 27 ou 28 — c'est ce qu'`ecrecover` accepte. L'ancien
 * remplissage `0x2d…2d` de ces tests donnait v = 45, que le contrat aurait
 * refusé : une signature de la bonne *longueur* n'est pas une signature de la
 * bonne *forme*.
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
    resource: { url: 'https://api.warrant.sh/v1/warrants' },
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

describe('x402 v2 — noms de fil', () => {
  it('utilise les en-têtes v2, jamais le X-PAYMENT de la v1', () => {
    expect(HEADER_PAYMENT_REQUIRED).toBe('PAYMENT-REQUIRED')
    expect(HEADER_PAYMENT_SIGNATURE).toBe('PAYMENT-SIGNATURE')
    expect(HEADER_PAYMENT_RESPONSE).toBe('PAYMENT-RESPONSE')
    expect(HEADER_PAYMENT_SIGNATURE).not.toBe('X-PAYMENT')
  })

  it('utilise les en-têtes RFC 9110 pour MPP', () => {
    expect(HEADER_WWW_AUTHENTICATE).toBe('WWW-Authenticate')
    expect(HEADER_AUTHORIZATION).toBe('Authorization')
    expect(HEADER_PAYMENT_RECEIPT).toBe('Payment-Receipt')
  })

  it('encode et décode un en-tête en base64 sans perte', () => {
    const encoded = encodeHeaderObject({ a: 1, é: 'ü' })
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(decodeHeaderObject(encoded)).toEqual({ a: 1, é: 'ü' })
  })

  it('refuse un en-tête illisible plutôt que de replier sur un objet vide', () => {
    expect(() => decodeHeaderObject('pas-du-json-encodé')).toThrow(WireFormatError)
  })
})

describe('PaymentRequired', () => {
  const required = buildPaymentRequired({
    resource: {
      url: 'https://api.warrant.sh/v1/warrants',
      description: 'Bond for a KeeperHub-executed action',
      mimeType: 'application/json',
    },
    network: 'eip155:8453',
    amount: '25000000',
    asset: USDC_BASE,
    payTo: VAULT,
    extra: { name: 'USDC', version: '2' },
  })

  it('annonce la version 2', () => {
    expect(required.x402Version).toBe(2)
  })

  it('annonce le réseau en CAIP-2, pas un chainId nu', () => {
    expect(required.accepts[0]?.network).toBe('eip155:8453')
    expect(required.accepts[0]?.network).toMatch(/^eip155:\d+$/)
  })

  it('annonce `eip3009-receive`, et NON le défaut normatif du schéma exact', () => {
    expect(required.accepts[0]?.scheme).toBe('exact')
    expect(required.accepts[0]?.extra?.assetTransferMethod).toBe(DEFAULT_TRANSFER_METHOD)

    // Cette assertion est là pour empêcher qu'on « corrige » le correctif.
    // La spec dit « if present, MUST be "eip3009" », et `eip3009` y désigne
    // `transferWithAuthorization`. L'escrow, lui, consomme
    // `receiveWithAuthorization`. Annoncer `eip3009` ferait signer le mauvais
    // typehash à tout client conforme, et `open()` révèrterait — vérifié contre
    // le facilitateur CDP, qui répond 400 invalid_exact_evm_payload_signature.
    // La non-conformité est donc délibérée, et elle est explicite plutôt que
    // cachée derrière un champ standard qui mentirait.
    expect(DEFAULT_TRANSFER_METHOD).toBe('eip3009-receive')
    expect(DEFAULT_TRANSFER_METHOD).not.toBe('eip3009')
  })

  it('porte le domaine EIP-712 du token dans extra', () => {
    expect(required.accepts[0]?.extra).toMatchObject({ name: 'USDC', version: '2' })
  })

  it('annonce le typehash `receive`, et non le défaut du schéma exact', () => {
    // Le seul champ du 402 qu'un client ne peut pas deviner : les deux
    // typehashes EIP-3009 portent exactement les mêmes champs, et signer le
    // mauvais ne se découvre qu'au revert du token.
    expect(required.accepts[0]?.extra?.primaryType).toBe('ReceiveWithAuthorization')
    expect(RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE).toBe('ReceiveWithAuthorization')
    expect(required.accepts[0]?.extra?.primaryType).not.toBe('TransferWithAuthorization')
  })

  it('serre la fenêtre de paiement à 60 s', () => {
    expect(required.accepts[0]?.maxTimeoutSeconds).toBe(60)
  })
})

describe('assertPayloadMatches', () => {
  it('accepte un payload conforme', () => {
    expect(() => assertPayloadMatches(payload(), REQUIREMENTS)).not.toThrow()
  })

  it('refuse un montant différent de celui exigé', () => {
    const p = payload({ accepted: { ...REQUIREMENTS, amount: '1' } })
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(PaymentRejected)
  })

  it('refuse une autorisation dont la valeur ne vaut pas le montant exigé', () => {
    const p = payload()
    p.payload.authorization.value = '1'
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(/amount|montant/i)
  })

  it('refuse une destination détournée', () => {
    const p = payload()
    p.payload.authorization.to = `0x${'ee'.repeat(20)}`
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(PaymentRejected)
  })

  it('refuse un autre réseau, un autre actif, un autre scheme', () => {
    for (const over of [
      { network: 'eip155:1' },
      { asset: `0x${'99'.repeat(20)}` },
      { scheme: 'upto' as unknown as 'exact' },
    ]) {
      const p = payload({ accepted: { ...REQUIREMENTS, ...over } })
      expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(PaymentRejected)
    }
  })

  it('refuse une version de protocole autre que 2', () => {
    const p = payload({ x402Version: 1 as unknown as typeof X402_VERSION })
    expect(() => assertPayloadMatches(p, REQUIREMENTS)).toThrow(/x402Version/)
  })

  it('compare les adresses sans tenir compte de la casse EIP-55', () => {
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

describe('facilitateur — /verify et /settle ne sont pas symétriques', () => {
  it('lit `isValid` sur /verify', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({ '/verify': { isValid: true, payer: AGENT } }),
    })
    await expect(client.verify(payload(), REQUIREMENTS)).resolves.toMatchObject({
      isValid: true,
      payer: AGENT,
    })
  })

  it('lit `success` sur /settle', async () => {
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

  it("refuse un /verify qui répondrait `success` — le piège d'asymétrie", async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({ '/verify': { success: true, payer: AGENT } }),
    })
    await expect(client.verify(payload(), REQUIREMENTS)).rejects.toThrow(FacilitatorError)
  })

  it("refuse un /settle qui répondrait `isValid`", async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({ '/settle': { isValid: true, transaction: TX } }),
    })
    await expect(client.settle(payload(), REQUIREMENTS)).rejects.toThrow(FacilitatorError)
  })

  it('propage isValid=false sans le confondre avec une erreur', async () => {
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

  it('appelle bien /verify puis /settle sur le facilitateur configuré', async () => {
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

  it('lève une FacilitatorError sur un statut HTTP non 2xx', async () => {
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetchImpl: stubFetch({}),
    })
    await expect(client.verify(payload(), REQUIREMENTS)).rejects.toThrow(FacilitatorError)
  })
})

describe('settlementTxOf', () => {
  it('est le hash de la transaction de règlement, en minuscules', () => {
    const settlement: SettlementResponse = {
      success: true,
      transaction: TX.toUpperCase() as Hex,
      network: 'eip155:8453',
      payer: AGENT,
    }
    expect(settlementTxOf(settlement)).toBe(TX)
  })

  it('refuse un règlement sans hash exploitable', () => {
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
  it("est le nonce de l'autorisation, en minuscules — pas un hash de transaction", () => {
    const nonce = `0x${'F3'.repeat(32)}` as Hex
    expect(fundingRefOfAuthorization({ ...payload().payload.authorization, nonce })).toBe(
      `0x${'f3'.repeat(32)}`,
    )
  })

  it('refuse un nonce qui ne fait pas 32 octets', () => {
    // Le contrat l'accepterait — l'encodeur ABI complèterait à gauche — mais la
    // valeur signée par l'agent ne serait alors pas celle soumise au token.
    for (const nonce of ['0xf3', `0x${'f3'.repeat(33)}`, 'pas-un-hex']) {
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
  it('découpe la signature en v, r, s et coerce les entiers', () => {
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

  it("n'expose pas `to` : le contrat passe address(this), il ne le déclare pas", () => {
    expect(escrowAuthorizationOf(payload().payload)).not.toHaveProperty('to')
  })

  it('refuse une signature qui ne fait pas 65 octets', () => {
    for (const signature of [`0x${'aa'.repeat(64)}`, `0x${'aa'.repeat(66)}`, '0x']) {
      expect(() =>
        escrowAuthorizationOf({
          ...payload().payload,
          signature: signature as Hex,
        }),
      ).toThrow(PaymentRejected)
    }
  })

  it('refuse un v que ecrecover ne saurait pas recouvrer', () => {
    // 0x2d = 45. C'est la valeur que produisait l'ancien remplissage de test :
    // longueur correcte, `v` impossible.
    expect(() =>
      escrowAuthorizationOf({
        ...payload().payload,
        signature: `0x${'aa'.repeat(32)}${'bb'.repeat(32)}2d` as Hex,
      }),
    ).toThrow(PaymentRejected)
  })

  it('normalise un dernier octet 0/1 en 27/28', () => {
    // viem rend `yParity` sans `v` sur cette forme ; le token fait un
    // `ecrecover`, qui veut 27 ou 28.
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

  it('refuse une autorisation dont les champs ne sont pas exploitables', () => {
    const base = payload().payload
    expect(() =>
      escrowAuthorizationOf({ ...base, authorization: { ...base.authorization, from: 'x' } }),
    ).toThrow(PaymentRejected)
    expect(() =>
      escrowAuthorizationOf({
        ...base,
        authorization: { ...base.authorization, value: 'beaucoup' },
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
    secret: 'secret-de-test',
    ttlSeconds: 300,
    now,
    salt: () => `salt-${n++}`,
  })
}

function issue(s: ReturnType<typeof store>) {
  return s.issue({
    realm: 'warrant.sh',
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

describe('Challenge MPP', () => {
  const challenge = issue(store())

  it('porte les paramètres requis, intent charge', () => {
    expect(challenge.realm).toBe('warrant.sh')
    expect(challenge.method).toBe('tempo')
    expect(challenge.intent).toBe('charge')
    expect(challenge.id).not.toBe('')
    expect(challenge.request).not.toBe('')
    expect(challenge.expires).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('encode `request` en JSON JCS base64url', () => {
    expect(challenge.request).not.toMatch(/[+/=]/)
    expect(decodeJcs(challenge.request)).toEqual(REQUEST)
    // JCS trie les clés : la forme est déterministe, donc rejouable.
    expect(b64decode(challenge.request)).toBe(
      '{"amount":"25000000","currency":"' + USDC_BASE + '","recipient":"' + VAULT + '"}',
    )
  })

  it("s'écrit et se relit en en-tête WWW-Authenticate", () => {
    const header = formatChallengeHeader(challenge)
    expect(header.startsWith('Payment ')).toBe(true)
    expect(header).toContain('intent="charge"')
    expect(parseChallengeHeader(header)).toEqual(challenge)
  })

  it("refuse un en-tête d'un autre schéma d'authentification", () => {
    expect(() => parseChallengeHeader('Bearer abc')).toThrow(WireFormatError)
  })

  it('lie son id aux paramètres : deux montants différents, deux ids', () => {
    const s = store()
    const a = s.issue({
      realm: 'warrant.sh',
      method: 'tempo',
      intent: 'charge',
      request: REQUEST,
      context: { bond: '25000000' },
    })
    const b = s.issue({
      realm: 'warrant.sh',
      method: 'tempo',
      intent: 'charge',
      request: { ...REQUEST, amount: '1' },
      context: { bond: '1' },
    })
    expect(a.id).not.toBe(b.id)
  })

  it('ne produit jamais deux fois le même id pour la même action', () => {
    const s = store()
    expect(issue(s).id).not.toBe(issue(s).id)
  })
})

describe('Credential MPP', () => {
  it("s'écrit et se relit en en-tête Authorization: Payment", () => {
    const s = store()
    const credential = credentialFor(issue(s))
    const header = `Payment ${encodeCredential(credential)}`
    expect(decodeCredentialHeader(header)).toEqual(credential)
  })

  it('est consommé une fois, et une seule', () => {
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

  it('refuse un Challenge inconnu', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    credential.challenge = { ...credential.challenge, id: 'jamais-émis' }
    try {
      s.consume(credential)
      expect.unreachable()
    } catch (err) {
      expect((err as MppError).code).toBe('unknown_challenge')
    }
  })

  it('refuse un Challenge expiré', () => {
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

  it('refuse un Challenge réécho avec un montant modifié', () => {
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

  it("refuse un `opaque` qui n'est pas renvoyé inchangé", () => {
    const s = store()
    const credential = credentialFor(issue(s))
    credential.challenge = {
      ...credential.challenge,
      opaque: encodeJcs({ route: '/v1/autre' }),
    }
    try {
      s.consume(credential)
      expect.unreachable()
    } catch (err) {
      expect((err as MppError).code).toBe('opaque_mismatch')
    }
  })

  it('purge les Challenges expirés', () => {
    let t = 1_785_000_000
    const s = store(() => t)
    issue(s)
    expect(s.size).toBe(1)
    t += 301
    s.gc()
    expect(s.size).toBe(0)
  })
})

describe('pont MPP → x402', () => {
  it('reconstruit un PaymentPayload que le facilitateur peut vérifier', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    const built = paymentPayloadFromCredential(
      credential,
      REQUIREMENTS,
      'https://api.warrant.sh/v1/warrants',
    )
    expect(built.x402Version).toBe(2)
    expect(() => assertPayloadMatches(built, REQUIREMENTS)).not.toThrow()
    // Même autorisation que sur le rail x402 : c'est ce qui rend le règlement,
    // donc le fundingRef, identique des deux côtés.
    expect(built.payload.authorization).toEqual(payload().payload.authorization)
  })

  it('refuse les payloads `hash` et `proof`, hors périmètre v1', () => {
    const s = store()
    const credential = credentialFor(issue(s))
    for (const type of ['hash', 'proof'] as const) {
      const c = { ...credential, payload: { ...credential.payload, type } }
      expect(() =>
        paymentPayloadFromCredential(c, REQUIREMENTS, 'https://x'),
      ).toThrow(PaymentRejected)
    }
  })

  it("refuse un payload `transaction` sans autorisation signée", () => {
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

  it("extrait l'adresse d'un source DID PKH comme d'une adresse nue", () => {
    expect(addressFromSource(`did:pkh:eip155:4217:${AGENT}`)).toBe(AGENT)
    expect(addressFromSource(AGENT.toUpperCase())).toBe(AGENT)
    expect(addressFromSource('anonyme')).toBeUndefined()
  })
})

describe('Receipt MPP', () => {
  it("s'encode en base64url et se relit", () => {
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
  it('produit un Problem Details typé', () => {
    const p = problem('challenge_replayed', 409, 'Credential déjà utilisé', 'détail', {
      rail: 'mpp',
    })
    expect(p.type).toBe('https://warrant.sh/problems/challenge_replayed')
    expect(p).toMatchObject({ title: 'Credential déjà utilisé', status: 409, rail: 'mpp' })
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json')
  })
})
