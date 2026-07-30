/**
 * Frozen constants. Every value here is checked against a primary source — see
 * docs/14-references.md § 9.
 */

import type { Address } from './types.js'

export const CHAINS = {
  ethereum: { id: 1, caip2: 'eip155:1' },
  base: { id: 8453, caip2: 'eip155:8453' },
  baseSepolia: { id: 84532, caip2: 'eip155:84532' },
  tempoMainnet: { id: 4217, caip2: 'eip155:4217' },
  tempoModerato: { id: 42431, caip2: 'eip155:42431' },
} as const

export const ASSETS = {
  /** Circle-native USDC on Base. Not to be confused with the older bridged USDbC. */
  usdcBase: {
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address,
    decimals: 6,
    eip3009: true,
    /**
     * The token's EIP-712 domain. `version` is read onchain at startup rather
     * than taken on trust — see docs/05 § 3.
     */
    extra: { name: 'USDC', version: '2' },
  },
  usdcEthereum: {
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address,
    decimals: 6,
  },
} as const

/** Aave V3 Pool, Ethereum mainnet. */
export const AAVE_V3_POOL_ETHEREUM =
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as Address

/**
 * ERC-8004. Deterministic vanity-prefixed addresses, identical across every
 * chain of the same type. Presence on Base mainnet confirmed on 2026-07-28.
 *
 * The ValidationRegistry has no published address on any chain: its spec is
 * being reworked. It is out of scope for v1 (docs/10 § 2).
 */
export const ERC8004 = {
  mainnet: {
    identity: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432' as Address,
    reputation: '0x8004baa17c55a88189ae136b182e5fda19de9b63' as Address,
  },
  testnet: {
    identity: '0x8004a818bfb912233c491871b3d84c89a494bd9e' as Address,
    reputation: '0x8004b663056a597dffe9eccc1965a193b7388713' as Address,
  },
} as const

/** ERC-20 and Aave V3 selectors used by the classification registry. */
export const SELECTORS = {
  erc20Transfer: '0xa9059cbb' as const,
  erc20Approve: '0x095ea7b3' as const,
  erc20TransferFrom: '0x23b872dd' as const,
} as const

/** `Transfer(address,address,uint256)` */
export const TOPIC_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const

/** `Approval(address,address,uint256)` */
export const TOPIC_APPROVAL =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925' as const
