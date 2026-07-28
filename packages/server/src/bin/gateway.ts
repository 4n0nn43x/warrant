/**
 * Point d'entrée du Gateway 402.
 *
 * Toute la configuration vient de l'environnement, et rien n'a de valeur par
 * défaut permissive : une variable manquante fait échouer le démarrage avec le
 * nom de la variable. Un serveur qui démarre à moitié configuré ouvrirait des
 * mandats qu'il ne saurait pas régler.
 *
 * `MPP_SECRET_KEY` et `OPENER_PRIVATE_KEY` ne sont jamais journalisées, jamais
 * incluses dans une réponse, et n'apparaissent pas dans le résumé de démarrage.
 *
 * Usage :
 *   node --experimental-strip-types src/bin/gateway.ts
 */

import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { loadRegistry, parseRegistry, type Address, type Policy } from '@warrant/core'
import { createHash } from 'node:crypto'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import { createGateway, keeperHubExecutor, viemEscrow } from '../gateway.js'
import { FacilitatorClient } from '../x402.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `variable d'environnement manquante: ${name} — ` +
        'voir packages/server/src/bin/gateway.ts pour la liste complète',
    )
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

function address(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} : adresse EVM attendue, reçu "${value}"`)
  }
  return value.toLowerCase() as Address
}

/**
 * Politique du propriétaire du capital.
 *
 * Fichier JSON de préférence (`WARRANT_POLICY_FILE`) : une politique est un
 * document qu'on relit et qu'on versionne, pas une poignée de variables
 * d'environnement. Le repli par variables existe pour la démo.
 */
function loadPolicy(): Policy {
  const file = process.env['WARRANT_POLICY_FILE']
  if (file && file.trim() !== '') {
    return JSON.parse(readFileSync(file.trim(), 'utf8')) as Policy
  }
  return {
    beneficiary: address('WARRANT_BENEFICIARY', required('WARRANT_BENEFICIARY')),
    treasury: address('WARRANT_TREASURY', required('WARRANT_TREASURY')),
    minBond: optional('WARRANT_MIN_BOND', '5000000'),
    maxBond: optional('WARRANT_MAX_BOND', '250000000'),
    duration: Number(optional('WARRANT_DURATION', '3600')),
    categories: {
      'erc20.transfer': { riskBps: 100, maxOutflow: optional('WARRANT_MAX_OUTFLOW', '0') },
      'erc20.approve': { riskBps: 50, maxOutflow: '0' },
      'aavev3.repay': { riskBps: 25 },
      'aavev3.supply': { riskBps: 25 },
      'aavev3.withdraw': { riskBps: 150 },
      'aavev3.borrow': { riskBps: 200 },
    },
  }
}

const CHAINS = { 1: mainnet, 8453: base, 84532: baseSepolia } as const

function main(): void {
  const port = Number(optional('PORT', '8402'))
  const baseUrl = optional('WARRANT_BASE_URL', `http://localhost:${port}`)
  const escrowChainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', '8453'))
  const chain = CHAINS[escrowChainId as keyof typeof CHAINS]
  if (!chain) {
    throw new Error(`WARRANT_ESCROW_CHAIN_ID non supportée: ${escrowChainId}`)
  }

  const registryFile = process.env['WARRANT_REGISTRY_FILE']
  const registry =
    registryFile && registryFile.trim() !== ''
      ? parseRegistry(readFileSync(registryFile.trim(), 'utf8'))
      : loadRegistry()

  const policy = loadPolicy()

  const openerKey = required('OPENER_PRIVATE_KEY')
  const account = privateKeyToAccount(openerKey as `0x${string}`)
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(optional('WARRANT_ESCROW_RPC_URL', chain.rpcUrls.default.http[0])),
  })

  const app = createGateway({
    registry,
    policy,
    baseUrl,
    realm: optional('WARRANT_REALM', 'warrant.sh'),
    network: optional('WARRANT_NETWORK', `eip155:${escrowChainId}`),
    asset: address('WARRANT_ASSET', required('WARRANT_ASSET')),
    payTo: address('WARRANT_PAY_TO', required('WARRANT_PAY_TO')),
    assetExtra: {
      name: optional('WARRANT_ASSET_NAME', 'USDC'),
      // ⚠ Le domaine EIP-712 réel du token. À lire onchain plutôt qu'à croire
      // sur parole : une `version` erronée fait échouer toutes les signatures.
      version: optional('WARRANT_ASSET_VERSION', '2'),
    },
    facilitator: new FacilitatorClient({
      url: optional('X402_FACILITATOR_URL', 'https://x402.org/facilitator'),
      ...(process.env['X402_FACILITATOR_API_KEY']
        ? { apiKey: process.env['X402_FACILITATOR_API_KEY'] }
        : {}),
    }),
    executor: keeperHubExecutor({
      // Clé d'organisation `kh_`. Une clé `wfb_` est une clé webhook
      // utilisateur et sera rejetée en 401 sur cette route.
      apiKey: required('KEEPERHUB_API_KEY'),
      baseUrl: optional('KEEPERHUB_BASE_URL', 'https://app.keeperhub.com'),
    }),
    escrow: viemEscrow(
      {
        address: address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS')),
        account: account.address.toLowerCase() as Address,
        chain,
        walletClient: walletClient as unknown as {
          writeContract(args: Record<string, unknown>): Promise<`0x${string}`>
        },
      },
      warrantEscrowAbi,
    ),
    mppSecret: required('MPP_SECRET_KEY'),
    mppMethod: optional('MPP_METHOD', 'tempo'),
    mppCurrency: optional('MPP_CURRENCY', 'USDC'),
    challengeTtlSeconds: Number(optional('MPP_CHALLENGE_TTL', '300')),
  })

  if (process.env['KEEPERHUB_API_KEY']?.startsWith('wfb_')) {
    console.warn(
      'attention: KEEPERHUB_API_KEY commence par `wfb_`, une clé webhook utilisateur. ' +
        "Les routes d'exécution exigent une clé d'organisation `kh_`.",
    )
  }

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      JSON.stringify({
        msg: 'warrant gateway',
        port: info.port,
        baseUrl,
        escrowChainId,
        opener: account.address,
        beneficiary: policy.beneficiary,
        treasury: policy.treasury,
        bondRange: [policy.minBond, policy.maxBond],
        // Empreinte du secret, jamais le secret. Permet de vérifier qu'on a
        // bien déployé la même clé que le client sans jamais l'exposer.
        mppSecretFingerprint: createHash('sha256')
          .update(required('MPP_SECRET_KEY'))
          .digest('hex')
          .slice(0, 8),
      }),
    )
  })
}

main()
