/**
 * Fragments d'ABI et signatures d'événements utilisés par les vérificateurs.
 *
 * Les `topic0` sont dérivés des signatures plutôt que recopiés : une constante
 * fausse produirait un verdict faux sans jamais lever d'erreur.
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
 * Aave V3 `Pool.getUserAccountData(user)` → tuple de 6.
 * Le `healthFactor` est le **6e** élément, en 1e18 (docs/07 § 2.5).
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

/** Index du `healthFactor` dans le tuple retourné. */
export const AAVE_HEALTH_FACTOR_INDEX = 5

/** `Transfer(address,address,uint256)` */
export const TOPIC_TRANSFER: Hex = toEventSelector('Transfer(address,address,uint256)')

/** `Approval(address,address,uint256)` */
export const TOPIC_APPROVAL: Hex = toEventSelector('Approval(address,address,uint256)')

/**
 * Un `Transfer` ERC-20 a exactement 3 topics (`topic0`, `from`, `to`) ; la
 * variante ERC-721 en a 4 parce que le `tokenId` est indexé. Compter un
 * `tokenId` comme un montant fongible fabriquerait un delta absurde.
 */
export const ERC20_EVENT_TOPIC_COUNT = 3
