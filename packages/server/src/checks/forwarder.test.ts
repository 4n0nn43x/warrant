/**
 * Tests built on a **real** sponsored transaction.
 *
 * Base Sepolia, block 44736245:
 * `0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315`
 *
 * This is the first call this project executed through KeeperHub, and it is what
 * revealed that `tx.to` designates a forwarder rather than the target contract
 * as soon as the gas is sponsored. Freezing these bytes here guarantees that a
 * regression in the unwrapping shows up immediately, without depending on the
 * network.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import {
  FORWARDER_EXECUTE_SELECTOR,
  extractInnerCalldata,
  unwrapForwarder,
} from './forwarder.js'

/** Real top-level calldata of the sponsored transaction. */
const REAL_FORWARDER_INPUT =
  '0x9aefaff8' +
  '0000000000000000000000001f854780eaea8ec169c6cf96597934da2573bfa1' + // org wallet
  '000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e' + // USDC target
  '0000000000000000000000000000000000000000000000000000000000000000' + // value
  '0000000000000000000000000000000000000000000000000000000000000080' + // offset bytes
  '0000000000000000000000000000000000000000000000000000000000000099' + // length 153
  '5f14e21922e4e2a9f606e6ca773ac116d193af5daaf3946c547943208418014855d80bd52c66b74bcde87e62045df4c9870b8d001942b2fe310d60272c10f0141c000000000000000000000000000000006a68aad8095ea7b3000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000'

const FORWARDER = '0x5aF5194B4b0909eB978e3Cf1e25333852277f07D'
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const ORG_WALLET = '0x1F854780EAEA8ec169c6cF96597934Da2573bfA1'

describe('unwrapForwarder — real sponsored transaction', () => {
  const call = unwrapForwarder({
    to: FORWARDER,
    value: 0n,
    input: REAL_FORWARDER_INPUT as Hex,
  })

  it('recognises the sponsoring envelope', () => {
    expect(call.viaForwarder).toBe(true)
  })

  it('recovers the target contract, not the forwarder', () => {
    expect(call.target.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase())
    expect(call.target.toLowerCase()).not.toBe(FORWARDER.toLowerCase())
  })

  it('recovers the wallet on whose behalf the forwarder acts', () => {
    expect(call.wallet?.toLowerCase()).toBe(ORG_WALLET.toLowerCase())
  })

  it('extracts a well-formed `approve` calldata', () => {
    // 4 selector bytes + 2 words of 32 bytes.
    expect(call.calldata.slice(0, 10)).toBe('0x095ea7b3')
    expect((call.calldata.length - 2) / 2).toBe(68)
  })

  it('decodes the committed arguments — spender and amount', () => {
    const args = call.calldata.slice(10)
    expect(args.slice(0, 64).endsWith('dead')).toBe(true)
    expect(BigInt(`0x${args.slice(64, 128)}`)).toBe(0n)
  })
})

describe('unwrapForwarder — the direct case stays untouched', () => {
  it('returns the transaction as-is when there is no sponsoring', () => {
    const direct = unwrapForwarder({
      to: USDC_BASE_SEPOLIA,
      value: 0n,
      input: '0x095ea7b3' as Hex,
    })
    expect(direct.viaForwarder).toBe(false)
    expect(direct.target).toBe(USDC_BASE_SEPOLIA)
    expect(direct.calldata).toBe('0x095ea7b3')
  })

  it('handles a contract creation without throwing', () => {
    const created = unwrapForwarder({ to: null, value: 0n, input: '0x6080' as Hex })
    expect(created.viaForwarder).toBe(false)
    expect(created.target).toBe('0x0000000000000000000000000000000000000000')
  })
})

describe('unwrapForwarder — conservative when in doubt', () => {
  it('guesses nothing when the selector matches but the shape does not follow', () => {
    const bogus = unwrapForwarder({
      to: FORWARDER,
      value: 0n,
      input: `${FORWARDER_EXECUTE_SELECTOR}deadbeef` as Hex,
    })
    // Falls back to the raw transaction: the check will fail, which is correct.
    expect(bogus.viaForwarder).toBe(false)
    expect(bogus.target).toBe(FORWARDER)
  })

  it('leaves a calldata with a different selector untouched', () => {
    const other = unwrapForwarder({
      to: USDC_BASE_SEPOLIA,
      value: 0n,
      input: '0xa9059cbb0000' as Hex,
    })
    expect(other.viaForwarder).toBe(false)
    expect(other.calldata).toBe('0xa9059cbb0000')
  })
})

describe('extractInnerCalldata', () => {
  it('rejects a payload too short to hold signature + selector', () => {
    expect(extractInnerCalldata(`0x${'00'.repeat(68)}` as Hex)).toBeUndefined()
  })

  it('returns a calldata of valid ABI length — 4 + 32·n bytes', () => {
    const inner = extractInnerCalldata(
      `0x${'11'.repeat(65)}${'22'.repeat(8)}095ea7b3${'33'.repeat(64)}` as Hex,
    )
    expect(inner).toBeDefined()
    const len = (inner!.length - 2) / 2
    expect((len - 4) % 32).toBe(0)
  })
})
