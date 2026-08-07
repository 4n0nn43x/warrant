/**
 * Opening a warrant **through the Gateway**, on the rail of your choosing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this exists next to `open-warrant.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `open-warrant.ts` deliberately bypasses the Gateway: it signs and calls
 * `open()` itself, which is what makes it a good test of the escrow and a bad
 * test of the product. Everything the Gateway is *for* — the dual 402, the
 * Challenge, the facilitator settling the payment, the rail-specific receipt —
 * has never been exercised outside a unit test against a real deployment. The
 * result was a corpus of warrants that traversed no payment rail at all, on a
 * route whose central claim is that **both rails produce an identical warrant**.
 *
 * This script closes that gap. It speaks HTTP to a running Gateway, pays on the
 * rail you name, and lets the Gateway do the classification, the pricing, the
 * simulation, the opening and the execution. Nothing here reimplements any of
 * that — if it did, it would prove the reimplementation and not the product.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The handshake, and the one part the client cannot be told
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. POST with no payment → 402. The x402 `PAYMENT-REQUIRED` carries the
 *      committed terms under `extensions["warrant/commitment"].info`; the MPP
 *      Challenge travels in `WWW-Authenticate: Payment`, on the same response.
 *   2. The client composes `warrantId` itself. The server cannot announce it: it
 *      does not yet know which address will sign, and `warrantId` is derived
 *      from that address.
 *   3. The EIP-3009 nonce is **not random** — it is `termsHash(...)` over those
 *      terms. Signing the payment is therefore signing the mandate, and the
 *      contract rejects any other pairing with `TermsMismatch`.
 *   4. POST again, echoing `body.nonce` and carrying the payment on one rail.
 *
 * The MPP rail goes through `warrant-sdk/mpp`, not through a local copy of the
 * format: the point is to prove the SDK an integrator would use, and a private
 * implementation here would prove nothing about it.
 *
 * Usage:
 *   pnpm --filter @warrant/server open-via-gateway -- --rail mpp
 *   pnpm --filter @warrant/server open-via-gateway -- --rail x402 --amount 1000000
 *   pnpm --filter @warrant/server open-via-gateway -- --rail mpp --action approve
 */

import {
  HEADER_AUTHORIZATION,
  HEADER_PAYMENT_RECEIPT,
  challengeFromResponse,
  decodeReceipt,
  mppAuthorization,
} from 'warrant-sdk/mpp'
import type { PaymentPayload, PaymentRequired, PaymentSigner } from 'warrant-sdk'
import { readFileSync } from 'node:fs'
import {
  parseRegistry,
  registryRefOf,
  type ActionSpec,
  type Address,
  type Hex,
} from 'warrant-core'
import { createPublicClient, encodeFunctionData, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { termsHashOf, warrantIdOf } from '../gateway.js'
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  RECEIVE_WITH_AUTHORIZATION_TYPE,
  X402_VERSION,
} from '../x402.js'

const erc20Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') throw new Error(`missing environment variable: ${name}`)
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

/** base64 → object, for the x402 headers. */
function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

/** The committed terms the 402 discloses, all as wire strings. */
interface CommitmentInfo {
  nonce: string
  actionHash: Hex
  beneficiary: Address
  bond: string
  conditionHash: Hex
  duration: number
}

function commitmentFrom(required402: PaymentRequired): CommitmentInfo {
  const ext = required402.extensions?.['warrant/commitment'] as
    | { info?: Record<string, string | number> }
    | undefined
  const info = ext?.info
  if (!info) {
    throw new Error(
      'the 402 carries no `warrant/commitment` extension: the Gateway did not disclose the ' +
        'terms, and a client cannot compose the EIP-3009 nonce without them',
    )
  }
  return {
    nonce: String(info['nonce']),
    actionHash: String(info['actionHash']) as Hex,
    beneficiary: String(info['beneficiary']) as Address,
    bond: String(info['bond']),
    conditionHash: String(info['conditionHash']) as Hex,
    duration: Number(info['duration']),
  }
}

async function main(): Promise<void> {
  for (const candidate of ['.env', '../../.env']) {
    try {
      process.loadEnvFile(candidate)
      break
    } catch {
      /* next */
    }
  }

  const rail = arg('rail', 'mpp')
  if (rail !== 'mpp' && rail !== 'x402') {
    throw new Error(`--rail must be mpp or x402, got "${rail}"`)
  }
  const action = arg('action', 'transfer')
  if (action !== 'transfer' && action !== 'approve') {
    throw new Error(`--action must be transfer or approve, got "${action}"`)
  }

  const gateway = arg('gateway', optional('WARRANT_GATEWAY_URL', 'http://127.0.0.1:8402')).replace(
    /\/+$/,
    '',
  )

  const CHAINS = { 1: mainnet, 8453: base, 11155111: sepolia, 84532: baseSepolia } as const
  const chainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', String(baseSepolia.id)))
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) throw new Error(`unsupported WARRANT_ESCROW_CHAIN_ID: ${chainId}`)

  const rpc = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])
  const escrow = required('WARRANT_ESCROW_ADDRESS').toLowerCase() as Address
  const token = required('WARRANT_ASSET').toLowerCase() as Address

  const agentAccount = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as Hex)
  const agent = agentAccount.address.toLowerCase() as Address

  const REGISTRY_FILES: Record<number, string> = {
    1: 'packages/core/registry/mainnet.json',
    8453: 'packages/core/registry/mainnet.json',
    11155111: 'deployments/registry-ethereum-sepolia.json',
    84532: 'deployments/registry-base-sepolia.json',
  }
  const registryFile = optional(
    'WARRANT_REGISTRY_FILE',
    new URL(`../../../../${REGISTRY_FILES[chainId]}`, import.meta.url).pathname,
  )
  const registryRef = registryRefOf(parseRegistry(readFileSync(registryFile, 'utf8')))

  const amount = BigInt(arg('amount', '1000000'))
  const dest = optional('DEMO_ALLOWED_DEST', '0x000000000000000000000000000000000000dEaD')
    .toLowerCase() as Address

  const actionSpec: ActionSpec = {
    version: 1,
    chainId,
    target: token,
    value: '0',
    calldata: encodeFunctionData({ abi: erc20Abi, functionName: action, args: [dest, amount] }),
    registryRef,
  }

  const publicClient = createPublicClient({ chain, transport: http(rpc) })
  const assetName = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'name',
  })) as string
  const assetVersion = optional('WARRANT_ASSET_VERSION', '2')

  const url = `${gateway}/v1/warrants`
  const body: Record<string, unknown> = { actionSpec }

  log({ msg: 'requesting the 402', rail, action, gateway, agent })

  // ── 1. The unpaid request, and its dual 402 ────────────────────────────────
  const challenged = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (challenged.status !== 402) {
    throw new Error(
      `expected 402, got ${challenged.status}: ${(await challenged.text()).slice(0, 400)}`,
    )
  }

  const requiredHeader = challenged.headers.get(HEADER_PAYMENT_REQUIRED)
  if (!requiredHeader) throw new Error(`402 without a ${HEADER_PAYMENT_REQUIRED} header`)
  const required402 = decodeHeader<PaymentRequired>(requiredHeader)
  const challenge = challengeFromResponse(challenged.headers)

  log({
    msg: '402 received — both rails offered on one response',
    x402: { accepts: required402.accepts.length, network: required402.accepts[0]?.network },
    mpp: challenge ? { method: challenge.method, intent: challenge.intent } : null,
  })
  if (rail === 'mpp' && !challenge) {
    throw new Error('the 402 carries no MPP Challenge: this Gateway serves the x402 rail only')
  }

  // ── 2-3. Compose the warrant id, then sign the terms through the nonce ─────
  const terms = commitmentFrom(required402)
  const warrantId = warrantIdOf(agent, BigInt(terms.nonce), terms.actionHash)
  const authNonce = termsHashOf({
    id: warrantId,
    beneficiary: terms.beneficiary,
    bond: terms.bond,
    conditionHash: terms.conditionHash,
    actionHash: terms.actionHash,
    duration: terms.duration,
  })

  const validAfter = 0n
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const authorization = {
    from: agent,
    to: escrow,
    value: terms.bond,
    validAfter: validAfter.toString(10),
    validBefore: validBefore.toString(10),
    nonce: authNonce,
  }

  const signature = await agentAccount.signTypedData({
    domain: { name: assetName, version: assetVersion, chainId, verifyingContract: token },
    types: RECEIVE_WITH_AUTHORIZATION_TYPE,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: agent,
      to: escrow,
      value: BigInt(terms.bond),
      validAfter,
      validBefore,
      nonce: authNonce,
    },
  })

  log({
    msg: 'EIP-3009 authorization signed',
    warrantId,
    bond: terms.bond,
    nonceIsTermsHash: true,
    fundingRef: authNonce,
  })

  // The one object both rails carry. Building it once, and letting each rail
  // wrap it, is what makes "the rail is only a way of paying" checkable here and
  // not merely asserted in a comment.
  const payment: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: { url },
    accepted: required402.accepts[0]!,
    payload: { signature, authorization },
  }
  const signer: PaymentSigner = { createPayment: () => payment }

  // ── 4. Pay, on the chosen rail ─────────────────────────────────────────────
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (rail === 'mpp') {
    headers[HEADER_AUTHORIZATION] = await mppAuthorization({
      required: required402,
      challenge: challenge!,
      signer,
      source: `did:pkh:eip155:${chainId}:${agent}`,
    })
  } else {
    headers[HEADER_PAYMENT_SIGNATURE] = encodeHeader(payment)
  }

  const paid = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, nonce: terms.nonce }),
  })
  const text = await paid.text()
  if (!paid.ok) {
    throw new Error(`payment refused — HTTP ${paid.status}: ${text.slice(0, 600)}`)
  }

  const receiptHeader = paid.headers.get(HEADER_PAYMENT_RECEIPT)
  log({
    msg: 'warrant opened through the Gateway',
    rail,
    warrantId,
    // Each rail answers with its own receipt: `Payment-Receipt` on MPP,
    // `PAYMENT-RESPONSE` on x402. Reading the wrong one would look like a
    // missing receipt.
    receipt: receiptHeader ? decodeReceipt(receiptHeader) : (paid.headers.get('PAYMENT-RESPONSE') ?? null),
    body: JSON.parse(text) as unknown,
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
