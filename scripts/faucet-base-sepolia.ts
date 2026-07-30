#!/usr/bin/env node
/**
 * Réclamation du faucet Base Sepolia par l'API Coinbase Developer Platform.
 *
 * Pourquoi un script et pas un clic dans le portail : les trois adresses à
 * alimenter le sont pour des raisons différentes (gas de déploiement, gas de
 * règlement, capital de caution), et il faudra recommencer — le faucet est
 * plafonné par 24 h et une campagne de volume consomme du gas. Un script rend
 * l'opération répétable et journalisée.
 *
 * Le même compte CDP sert ensuite au facilitateur x402 **mainnet** : le
 * facilitateur public `x402.org` ne couvre que Base Sepolia, donc toute cible
 * mainnet passe par CDP. Ce n'est pas une dépendance de confort.
 *
 * Usage :
 *   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… pnpm faucet
 */

import { CdpClient } from '@coinbase/cdp-sdk'

/** Ce qu'il faut, et pour quoi faire. */
const REQUESTS = [
  {
    address: '0xE9D3d40A1e80F1C20A318EDFC70869D61F971567',
    token: 'eth',
    why: 'gas de déploiement (opener, et déployeur donc owner)',
  },
  {
    address: '0xE9D3d40A1e80F1C20A318EDFC70869D61F971567',
    token: 'usdc',
    why: "capital de caution — c'est cette adresse qui signe les autorisations EIP-3009",
  },
  {
    address: '0x3e7f79962eD7C93BDf4A88Ce35Fb1061048136Ec',
    token: 'eth',
    why: 'gas de règlement (settler) — honor et slash ne sont pas sponsorisés',
  },
  {
    address: '0x1F854780EAEA8ec169c6cF96597934Da2573bfA1',
    token: 'usdc',
    why: "wallet d'execution KeeperHub — il emet l'action engagee, et un USDC reel ne se minte pas",
  },
] as const

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new Error(
      `variable d'environnement manquante: ${name} — à créer sur portal.cdp.coinbase.com`,
    )
  }
  return v.trim()
}

async function main(): Promise<void> {
  const cdp = new CdpClient({
    apiKeyId: required('CDP_API_KEY_ID'),
    apiKeySecret: required('CDP_API_KEY_SECRET'),
  })

  for (const req of REQUESTS) {
    try {
      const res = await cdp.evm.requestFaucet({
        address: req.address as `0x${string}`,
        network: 'base-sepolia',
        token: req.token,
      })
      console.log(
        JSON.stringify({
          msg: 'faucet réclamé',
          address: req.address,
          token: req.token,
          why: req.why,
          tx: res.transactionHash,
        }),
      )
    } catch (err) {
      // Un plafond atteint n'est pas un échec du script : les autres demandes
      // doivent aboutir, et l'opérateur a besoin de savoir laquelle a manqué.
      console.error(
        JSON.stringify({
          msg: 'faucet refusé',
          address: req.address,
          token: req.token,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
}

await main()
