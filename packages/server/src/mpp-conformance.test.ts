/**
 * The two halves of the MPP rail, held against each other.
 *
 * `@warrant/sdk` packs a Credential; this package unpacks it. They are two files
 * in two packages that never import one another at runtime, and the format that
 * binds them lives only in a specification. That is exactly the shape of a
 * divergence nobody notices until a real client is refused — so the check is
 * written down rather than assumed.
 *
 * The test deliberately goes through the **public** surfaces of both sides:
 * `mppAuthorization` as an agent would call it, `decodeCredentialHeader` and
 * `paymentPayloadFromCredential` as the Gateway does. An assertion on the
 * intermediate JSON would pass while the wire encoding drifted.
 */

import { describe, expect, it } from 'vitest'
import {
  MPP_METHOD_EVM,
  authorizationHeader,
  challengeFromResponse,
  credentialFrom,
  mppAuthorization,
  parseChallengeHeader as parseChallengeSdk,
  type MppChallenge as SdkChallenge,
} from '@warrant/sdk/mpp'
import type { PaymentPayload, PaymentRequired, PaymentSigner } from '@warrant/sdk'
import {
  X402_VERSION,
  decodeCredentialHeader,
  formatChallengeHeader,
  paymentPayloadFromCredential,
  type MppChallenge,
  type PaymentRequirements,
} from './x402.js'

const AGENT = '0xe9d3d40a1e80f1c20a318edfc70869d61f971567'
const ESCROW = '0x3ae9ad53686383c80889f550065e810f72c2ff4e'
const RESOURCE = 'https://gateway.test/v1/warrants'

const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '5000000',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  payTo: ESCROW,
  maxTimeoutSeconds: 300,
}

const AUTHORIZATION = {
  from: AGENT,
  to: ESCROW,
  value: '5000000',
  validAfter: '0',
  validBefore: '99999999999',
  // The nonce IS the terms hash: this is the field whose survival across the
  // rail decides whether the warrant that opens is the one that was paid for.
  nonce: `0x${'ab'.repeat(32)}`,
}
const SIGNATURE = `0x${'cd'.repeat(65)}`

/** A signer that returns a fixed authorization: we are testing transport. */
const signer: PaymentSigner = {
  createPayment(required: PaymentRequired): PaymentPayload {
    return {
      x402Version: X402_VERSION,
      resource: { url: required.resource.url },
      accepted: required.accepts[0]!,
      payload: { signature: SIGNATURE, authorization: AUTHORIZATION },
    }
  },
}

const required: PaymentRequired = {
  x402Version: X402_VERSION,
  resource: { url: RESOURCE },
  accepts: [REQUIREMENTS],
}

/** A Challenge as the Gateway emits it, with the awkward fields populated. */
function challenge(over: Partial<MppChallenge> = {}): MppChallenge {
  return {
    id: 'sZ3-x_9aB0c',
    realm: 'warrant.sh',
    method: MPP_METHOD_EVM,
    intent: 'charge',
    request: 'eyJhbW91bnQiOiI1MDAwMDAwIn0',
    expires: '2026-08-06T12:00:00.000Z',
    opaque: 'eyJrIjoidiJ9',
    description: 'Bond for a warrant, 5 USDC',
    ...over,
  }
}

describe('MPP rail — the SDK packs what the Gateway unpacks', () => {
  it('a Credential built by the SDK is accepted by the server decoder', async () => {
    const header = formatChallengeHeader(challenge())
    const parsed = parseChallengeSdk(header)

    const authorization = await mppAuthorization({
      required,
      challenge: parsed,
      signer,
      source: `did:pkh:eip155:84532:${AGENT}`,
    })

    const credential = decodeCredentialHeader(authorization)
    expect(credential.payload.type).toBe('transaction')
    expect(credential.source).toContain(AGENT)

    // The Challenge must come back byte-identical: the server's `id` is a MAC
    // over these fields, so any re-serialisation reads as tampering.
    expect(credential.challenge).toEqual(challenge())
  })

  it('the authorization survives the round trip unchanged', async () => {
    const parsed = parseChallengeSdk(formatChallengeHeader(challenge()))
    const authorization = await mppAuthorization({
      required,
      challenge: parsed,
      signer,
      source: AGENT,
    })

    const payload = paymentPayloadFromCredential(
      decodeCredentialHeader(authorization),
      REQUIREMENTS,
      RESOURCE,
    )

    // `fundingRef` is this nonce. If the rail altered it, the warrant that opens
    // would not be the one that was signed for.
    expect(payload.payload).toEqual({ signature: SIGNATURE, authorization: AUTHORIZATION })
    expect(payload.accepted).toEqual(REQUIREMENTS)
    expect(payload.resource.url).toBe(RESOURCE)
  })

  it('the SDK parses every field the server serialises, escapes included', () => {
    // A description carrying a quote and a backslash: the one input that tells
    // a real quoted-string parser from a `split(',')`.
    const awkward = challenge({ description: 'bond "5 USDC" \\ per warrant' })
    expect(parseChallengeSdk(formatChallengeHeader(awkward))).toEqual(awkward)
  })

  it('an optional field the server omits is absent, not empty', () => {
    const bare: MppChallenge = {
      id: 'abc',
      realm: 'warrant.sh',
      method: MPP_METHOD_EVM,
      intent: 'charge',
      request: 'eyJhIjoxfQ',
    }
    const parsed = parseChallengeSdk(formatChallengeHeader(bare))
    expect(parsed).toEqual(bare)
    expect('opaque' in parsed).toBe(false)
  })

  it('picks the MPP Challenge out of a header that also carries another scheme', () => {
    const headers = new Headers()
    // `Headers.get` joins repeated values with ", " — the same separator the
    // Challenge uses between its own parameters. A naive split would shred it.
    headers.append('WWW-Authenticate', 'Bearer realm="other"')
    headers.append('WWW-Authenticate', formatChallengeHeader(challenge()))

    expect(challengeFromResponse(headers)).toEqual(challenge())
  })

  it('reports no MPP offer rather than inventing one', () => {
    const headers = new Headers({ 'WWW-Authenticate': 'Bearer realm="other"' })
    expect(challengeFromResponse(headers)).toBeUndefined()
    expect(challengeFromResponse(new Headers())).toBeUndefined()
  })

  it('refuses to build a Credential out of a payload with no EIP-3009 material', () => {
    const parsed: SdkChallenge = parseChallengeSdk(formatChallengeHeader(challenge()))
    const empty: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: { url: RESOURCE },
      accepted: REQUIREMENTS,
      payload: {},
    }
    expect(() => credentialFrom(parsed, empty, AGENT)).toThrow(/authorization/)
  })

  it('the Authorization header carries the Payment scheme', async () => {
    const parsed = parseChallengeSdk(formatChallengeHeader(challenge()))
    const header = authorizationHeader(credentialFrom(parsed, signer.createPayment(required) as PaymentPayload, AGENT))
    expect(header.startsWith('Payment ')).toBe(true)
  })
})
