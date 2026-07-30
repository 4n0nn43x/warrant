/**
 * ABI fragments and event signatures used by the checks.
 *
 * The `topic0` values are derived from the signatures rather than transcribed: a
 * wrong constant would produce a wrong verdict without ever raising an error.
 */

import { toEventSelector } from 'viem'
import type { Hex } from './types.js'

export const erc20Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Aave V3 `Pool.getUserAccountData(user)` → 6-tuple.
 * The `healthFactor` is the **6th** element, scaled by 1e18 (docs/07 § 2.5).
 */
export const aavePoolAbi = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const

/** Index of `healthFactor` within the returned tuple. */
export const AAVE_HEALTH_FACTOR_INDEX = 5

/** `Transfer(address,address,uint256)` */
export const TOPIC_TRANSFER: Hex = toEventSelector('Transfer(address,address,uint256)')

/** `Approval(address,address,uint256)` */
export const TOPIC_APPROVAL: Hex = toEventSelector('Approval(address,address,uint256)')

/**
 * An ERC-20 `Transfer` has exactly 3 topics (`topic0`, `from`, `to`); the
 * ERC-721 variant has 4, because `tokenId` is indexed. Counting a `tokenId` as a
 * fungible amount would manufacture an absurd delta.
 */
export const ERC20_EVENT_TOPIC_COUNT = 3
