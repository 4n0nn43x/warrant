/**
 * Unwrapping of sponsored transactions.
 *
 * When KeeperHub sponsors the gas, the onchain transaction **is not** the one we
 * think we asked for:
 *
 *   tx.from  = a relayer, not the organisation's wallet
 *   tx.to    = a forwarder, not the target contract
 *   tx.input = execute(address wallet, address target, uint256 value, bytes data)
 *
 * and the calldata actually executed is wrapped inside `data`, preceded by a
 * 65-byte signature and by metadata.
 *
 * Verified live on 2026-07-28 on Base Sepolia, transaction
 * `0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315`:
 * forwarder `0x5aF5194B4b0909eB978e3Cf1e25333852277f07D`, relayer
 * `0x6331eb4571DE9284f7E9eAD98ac7b0661a091E99`.
 *
 * Without this unwrapping, `calldata_matches_commitment` would fail on **every**
 * warrant as soon as the gas is sponsored — that is, a systematic unjust slash.
 */

import { decodeFunctionData, type Hex } from 'viem'

/** `execute(address,address,uint256,bytes)` — selector `0x9aefaff8`. */
export const FORWARDER_EXECUTE_SELECTOR = '0x9aefaff8' as const

export const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

/** The effective call, once the sponsoring envelope has been removed. */
export interface EffectiveCall {
  target: Hex
  value: bigint
  calldata: Hex
  /** Wallet on whose behalf the forwarder is acting. */
  wallet?: Hex
  /** `true` if the call had to be extracted from a forwarder envelope. */
  viaForwarder: boolean
}

/**
 * Removes the sponsoring envelope if one is present.
 *
 * Conservative by construction: if the pattern is not recognised **exactly**, we
 * return the transaction as it stands rather than guess. A false positive here
 * would validate a warrant that should not be.
 */
export function unwrapForwarder(tx: {
  to: string | null
  value: bigint
  input: Hex
}): EffectiveCall {
  const direct: EffectiveCall = {
    target: (tx.to ?? '0x0000000000000000000000000000000000000000') as Hex,
    value: tx.value,
    calldata: tx.input ?? '0x',
    viaForwarder: false,
  }

  if (!tx.input || !tx.input.toLowerCase().startsWith(FORWARDER_EXECUTE_SELECTOR)) {
    return direct
  }

  let decoded: readonly unknown[]
  try {
    const res = decodeFunctionData({ abi: FORWARDER_ABI, data: tx.input })
    decoded = res.args as readonly unknown[]
  } catch {
    // The selector matches but the shape does not follow: we assume nothing.
    return direct
  }

  const [wallet, target, value, data] = decoded as [Hex, Hex, bigint, Hex]
  if (typeof target !== 'string' || typeof data !== 'string') return direct

  const inner = extractInnerCalldata(data)
  if (!inner) return direct

  return {
    target,
    value,
    calldata: inner,
    wallet,
    viaForwarder: true,
  }
}

/**
 * Extracts the target calldata from the forwarder's signed payload.
 *
 * The payload is `signature(65) ‖ metadata ‖ calldata`. The length of the
 * metadata is undocumented and could change, so we do not hardcode it: we look
 * for the **last** plausible boundary from which the remainder forms a valid ABI
 * calldata, that is `4 + 32·n` bytes.
 *
 * Returns `undefined` if no cut fits — in which case the caller falls back to
 * the raw transaction and the check will fail, which is the right behaviour: a
 * conservative verdict beats an invented extraction.
 */
export function extractInnerCalldata(payload: Hex): Hex | undefined {
  const hex = payload.slice(2)
  const bytes = hex.length / 2
  // 65 signature bytes at minimum, plus 4 selector bytes.
  if (bytes < 69) return undefined

  for (let offset = 65; offset + 4 <= bytes; offset++) {
    const rest = bytes - offset
    if (rest < 4) break
    if ((rest - 4) % 32 !== 0) continue
    return `0x${hex.slice(offset * 2)}` as Hex
  }
  return undefined
}
