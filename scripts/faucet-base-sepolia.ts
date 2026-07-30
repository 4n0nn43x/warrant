#!/usr/bin/env node
/**
 * Claims the Base Sepolia faucet through the Coinbase Developer Platform API.
 *
 * Why a script rather than a click in the portal: the three addresses being
 * funded are funded for different reasons (deployment gas, settlement gas, bond
 * capital), and it will have to be done again — the faucet is rate-limited per
 * 24 h and a volume campaign burns gas. A script makes the operation repeatable
 * and logged.
 *
 * The same CDP account later serves the **mainnet** x402 facilitator: the public
 * `x402.org` facilitator covers Base Sepolia only, so any mainnet target goes
 * through CDP. This is not a convenience dependency.
 *
 * Usage:
 *   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… pnpm faucet
 */

import { CdpClient } from '@coinbase/cdp-sdk'

/** What is needed, and what for. */
const REQUESTS = [
  {
    address: '0xE9D3d40A1e80F1C20A318EDFC70869D61F971567',
    token: 'eth',
    why: 'deployment gas (opener, and deployer hence owner)',
  },
  {
    address: '0xE9D3d40A1e80F1C20A318EDFC70869D61F971567',
    token: 'usdc',
    why: 'bond capital — this is the address that signs the EIP-3009 authorizations',
  },
  {
    address: '0x3e7f79962eD7C93BDf4A88Ce35Fb1061048136Ec',
    token: 'eth',
    why: 'settlement gas (settler) — honor and slash are not sponsored',
  },
  {
    address: '0x1F854780EAEA8ec169c6cF96597934Da2573bfA1',
    token: 'usdc',
    why: 'KeeperHub execution wallet — it emits the committed action, and real USDC cannot be minted',
  },
] as const

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new Error(
      `missing environment variable: ${name} — create it at portal.cdp.coinbase.com`,
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
          msg: 'faucet claimed',
          address: req.address,
          token: req.token,
          why: req.why,
          tx: res.transactionHash,
        }),
      )
    } catch (err) {
      // Hitting a rate limit is not a failure of the script: the other requests
      // must still go through, and the operator needs to know which one missed.
      console.error(
        JSON.stringify({
          msg: 'faucet refused',
          address: req.address,
          token: req.token,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
}

await main()
