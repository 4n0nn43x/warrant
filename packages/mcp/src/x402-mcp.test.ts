/**
 * Le double format, testé pour lui-même.
 *
 * `server.test.ts` vérifie qu'il traverse le protocole ; ici on vérifie
 * l'invariant à la source, y compris sur les cas où une sérialisation naïve
 * diverge : accents, guillemets, sauts de ligne, valeurs `undefined`.
 */

import type { InputRequiredResult } from '@modelcontextprotocol/server'
import type { PaymentRequired, SettlementResponse } from '@warrant/sdk'
import { describe, expect, it, expectTypeOf } from 'vitest'

import {
  X402_PAYMENT_META_KEY,
  X402_PAYMENT_RESPONSE_META_KEY,
  dualFormat,
  extractPayment,
  paymentRequiredResult,
  withSettlement,
} from './x402-mcp.js'

const PAYMENT_REQUIRED: PaymentRequired = {
  x402Version: 2,
  error: 'PAYMENT-SIGNATURE header is required',
  resource: {
    url: 'https://api.warrant.sh/v1/warrants',
    description: 'Caution pour une action exécutée par KeeperHub — « post-condition » incluse',
    mimeType: 'application/json',
  },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '25000000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x00000000000000000000000000000000000000a1',
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2' },
    },
  ],
  extensions: {},
}

describe('dualFormat', () => {
  it('sérialise exactement l\'objet placé dans structuredContent', () => {
    const result = dualFormat({ a: 1, b: 'deux' })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: 'text', text: '{"a":1,"b":"deux"}' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    )
  })

  it('tient sur les caractères qui piègent une sérialisation naïve', () => {
    const payload = {
      accents: 'caution saisie — « violée »',
      quotes: 'il a dit "non"',
      newline: 'ligne1\nligne2',
      backslash: 'C:\\warrant',
      emojiFree: '\u00e9\u00e8\u00ea',
    }
    const result = dualFormat(payload)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    )
  })

  it('ne marque isError que sur demande', () => {
    expect(dualFormat({}).isError).toBeUndefined()
    expect(dualFormat({}, true).isError).toBe(true)
  })
})

describe('paymentRequiredResult', () => {
  it('porte le PaymentRequired dans les deux formats, en erreur', () => {
    const result = paymentRequiredResult(PAYMENT_REQUIRED)

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual(PAYMENT_REQUIRED)
    expect((result.content[0] as { text: string }).text).toBe(JSON.stringify(PAYMENT_REQUIRED))
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    )
  })

  it('reste exploitable par un client qui ne lit que le texte', () => {
    const result = paymentRequiredResult(PAYMENT_REQUIRED)
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as PaymentRequired

    // Tout ce dont un client a besoin pour construire un PaymentPayload.
    expect(parsed.x402Version).toBe(2)
    expect(parsed.resource.url).toBe(PAYMENT_REQUIRED.resource.url)
    expect(parsed.accepts[0]).toEqual(PAYMENT_REQUIRED.accepts[0])
  })
})

describe('withSettlement', () => {
  const settlement: SettlementResponse = {
    success: true,
    transaction: `0x${'ab'.repeat(32)}`,
    network: 'eip155:8453',
    payer: '0x1111111111111111111111111111111111111111',
    amount: '25000000',
  }

  it('place le règlement sous la clé de la spec', () => {
    const result = withSettlement(dualFormat({ ok: true }), settlement)
    expect(result._meta?.[X402_PAYMENT_RESPONSE_META_KEY]).toEqual(settlement)
  })

  it('laisse le résultat intact sans règlement', () => {
    const base = dualFormat({ ok: true })
    expect(withSettlement(base, undefined)).toBe(base)
  })
})

describe('extractPayment', () => {
  const payload = {
    x402Version: 2,
    resource: { url: 'https://api.warrant.sh/v1/warrants' },
    accepted: PAYMENT_REQUIRED.accepts[0],
    payload: { type: 'proof' },
  }

  it('lit le paiement sous la clé de la spec', () => {
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: payload })).toEqual(payload)
  })

  it('ignore un _meta absent, vide ou d\'un autre type', () => {
    expect(extractPayment(undefined)).toBeUndefined()
    expect(extractPayment(null)).toBeUndefined()
    expect(extractPayment('x402/payment')).toBeUndefined()
    expect(extractPayment({})).toBeUndefined()
  })

  it('ignore un paiement malformé plutôt que de lever', () => {
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: { x402Version: 1 } })).toBeUndefined()
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: { accepted: {} } })).toBeUndefined()
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: 'nope' })).toBeUndefined()
  })

  it('ne confond pas la clé de paiement avec celle de réponse', () => {
    expect(extractPayment({ [X402_PAYMENT_RESPONSE_META_KEY]: payload })).toBeUndefined()
  })
})

describe('MRTR — la raison de ne pas y passer, épinglée', () => {
  /**
   * L'argument de tête de `x402-mcp.ts` tient à un fait vérifiable :
   * `InputRequiredResult` n'offre aucun emplacement pour un `PaymentRequired`
   * lisible par le client. Ce test le transforme en assertion.
   *
   * Le jour où une révision ajoutera `content`/`structuredContent` à ce type —
   * ou une requête de paiement à `inputRequests` — ce test cassera à la
   * compilation, et la décision devra être réexaminée plutôt qu'héritée. C'est
   * précisément ce qu'on veut d'un commentaire de conception : qu'il se
   * périme bruyamment.
   */
  it('InputRequiredResult ne peut porter ni content ni structuredContent', () => {
    expectTypeOf<InputRequiredResult>().not.toHaveProperty('content')
    expectTypeOf<InputRequiredResult>().not.toHaveProperty('structuredContent')
    // Les seuls porteurs de charge utile sont opaques (`requestState`) ou d'un
    // type fermé aux trois requêtes d'entrée (`inputRequests`).
    expectTypeOf<InputRequiredResult>().toHaveProperty('requestState')
    expectTypeOf<InputRequiredResult>().toHaveProperty('inputRequests')
  })

  it('le challenge reste un CallToolResult à double format', () => {
    const result = paymentRequiredResult(PAYMENT_REQUIRED)
    // Ce qu'un `input_required` ne saurait pas faire : montrer l'objet payable
    // au modèle, dans les deux formats, sans qu'il ait à comprendre MRTR.
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify(PAYMENT_REQUIRED),
    })
    expect(result).not.toHaveProperty('resultType')
    expect(result).not.toHaveProperty('requestState')
  })
})
