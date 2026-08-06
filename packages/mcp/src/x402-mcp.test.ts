/**
 * The dual format, tested on its own terms.
 *
 * `server.test.ts` verifies that it crosses the protocol; here we verify the
 * invariant at the source, including the cases where a naive serialisation
 * diverges: accented characters, quotation marks, newlines, `undefined` values.
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
    url: 'https://gateway.example/v1/warrants',
    description: 'Bond for a KeeperHub-executed action — « post-condition » included',
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
  it('serialises exactly the object placed in structuredContent', () => {
    const result = dualFormat({ a: 1, b: 'two' })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: 'text', text: '{"a":1,"b":"two"}' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    )
  })

  it('holds up on the characters that trap a naive serialisation', () => {
    const payload = {
      accents: 'bond slashed — « naïve façade »',
      quotes: 'he said "no"',
      newline: 'line1\nline2',
      backslash: 'C:\\warrant',
      emojiFree: '\u00e9\u00e8\u00ea',
    }
    const result = dualFormat(payload)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    )
  })

  it('marks isError only on request', () => {
    expect(dualFormat({}).isError).toBeUndefined()
    expect(dualFormat({}, true).isError).toBe(true)
  })
})

describe('paymentRequiredResult', () => {
  it('carries the PaymentRequired in both formats, as an error', () => {
    const result = paymentRequiredResult(PAYMENT_REQUIRED)

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual(PAYMENT_REQUIRED)
    expect((result.content[0] as { text: string }).text).toBe(JSON.stringify(PAYMENT_REQUIRED))
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.structuredContent,
    )
  })

  it('stays usable by a client that only reads the text', () => {
    const result = paymentRequiredResult(PAYMENT_REQUIRED)
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as PaymentRequired

    // Everything a client needs in order to build a PaymentPayload.
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

  it('places the settlement under the key from the spec', () => {
    const result = withSettlement(dualFormat({ ok: true }), settlement)
    expect(result._meta?.[X402_PAYMENT_RESPONSE_META_KEY]).toEqual(settlement)
  })

  it('leaves the result untouched when there is no settlement', () => {
    const base = dualFormat({ ok: true })
    expect(withSettlement(base, undefined)).toBe(base)
  })
})

describe('extractPayment', () => {
  const payload = {
    x402Version: 2,
    resource: { url: 'https://gateway.example/v1/warrants' },
    accepted: PAYMENT_REQUIRED.accepts[0],
    payload: { type: 'proof' },
  }

  it('reads the payment from under the key from the spec', () => {
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: payload })).toEqual(payload)
  })

  it('ignores a _meta that is absent, empty or of another type', () => {
    expect(extractPayment(undefined)).toBeUndefined()
    expect(extractPayment(null)).toBeUndefined()
    expect(extractPayment('x402/payment')).toBeUndefined()
    expect(extractPayment({})).toBeUndefined()
  })

  it('ignores a malformed payment rather than throwing', () => {
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: { x402Version: 1 } })).toBeUndefined()
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: { accepted: {} } })).toBeUndefined()
    expect(extractPayment({ [X402_PAYMENT_META_KEY]: 'nope' })).toBeUndefined()
  })

  it('does not confuse the payment key with the response key', () => {
    expect(extractPayment({ [X402_PAYMENT_RESPONSE_META_KEY]: payload })).toBeUndefined()
  })
})

describe('MRTR — the reason not to go there, pinned down', () => {
  /**
   * The argument at the head of `x402-mcp.ts` rests on a verifiable fact:
   * `InputRequiredResult` offers no slot for a `PaymentRequired` that the client
   * can read. This test turns that into an assertion.
   *
   * The day a revision adds `content`/`structuredContent` to that type — or a
   * payment request to `inputRequests` — this test will break at compile time,
   * and the decision will have to be re-examined rather than inherited. That is
   * precisely what one wants of a design comment: that it expire loudly.
   */
  it('proves InputRequiredResult can carry neither content nor structuredContent', () => {
    expectTypeOf<InputRequiredResult>().not.toHaveProperty('content')
    expectTypeOf<InputRequiredResult>().not.toHaveProperty('structuredContent')
    // The only payload carriers are either opaque (`requestState`) or of a type
    // closed to the three input requests (`inputRequests`).
    expectTypeOf<InputRequiredResult>().toHaveProperty('requestState')
    expectTypeOf<InputRequiredResult>().toHaveProperty('inputRequests')
  })

  it('keeps the challenge a dual-format CallToolResult', () => {
    const result = paymentRequiredResult(PAYMENT_REQUIRED)
    // What an `input_required` could not do: show the payable object to the
    // model, in both formats, without it having to understand MRTR.
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify(PAYMENT_REQUIRED),
    })
    expect(result).not.toHaveProperty('resultType')
    expect(result).not.toHaveProperty('requestState')
  })
})
