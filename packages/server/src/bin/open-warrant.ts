/**
 * Ouverture d'un mandat de bout en bout — outil d'exploitation, pas un service.
 *
 * À quoi il sert : éprouver le daemon de règlement contre la vraie chaîne.
 * Sans mandat ouvert, un Settler qui tourne ne prouve rien. Ce script en ouvre
 * un **par le chemin réel** — `open()` signé par le wallet KeeperHub, action
 * exécutée par KeeperHub, journal alimenté — puis rend la main. Le daemon fait
 * le reste, sans savoir que ce mandat vient d'ici.
 *
 * Ce n'est **pas** une alternative au Gateway : il n'y a ni 402, ni x402, ni
 * MPP, et l'USDC de l'agent est frappé sur le MockUSDC de développement au lieu
 * d'être détenu. Ce qui est identique au chemin de production, en revanche, et
 * c'est ce qui rend l'épreuve valable :
 *
 *   • la classification, la tarification et la `ConditionSpec` sortent de
 *     `classify` / `priceRisk`, exactement comme dans `priceAction` ;
 *   • `conditionHash` et `actionHash` sont calculés par `@warrant/core` ;
 *   • l'ouverture passe par `keeperHubEscrow`, le port réellement déployé ;
 *   • **la caution est tirée par `open()` contre une autorisation EIP-3009 que
 *     l'agent signe**, exactement comme le Gateway le fait avec l'autorisation
 *     que le rail x402 lui transporte. Seule l'origine de la signature diffère :
 *     ici une clé locale, là un agent tiers. Le contrat, lui, ne voit aucune
 *     différence — il dérive l'agent de la signature dans les deux cas ;
 *   • l'enregistrement est écrit dans le même journal, au même format.
 *
 * Deux scénarios, et le second est celui qui compte :
 *
 *   --scenario honored   l'action exécutée est celle engagée ;
 *   --scenario diverted  l'action **exécutée** transfère vers une autre
 *                        destination que celle **engagée**. C'est le détournement
 *                        de docs/13 § 5 : la post-condition, écrite par la
 *                        politique et non par l'agent, désigne la destination de
 *                        l'allowlist. Un transfert détourné échoue donc par
 *                        construction, et la caution part au bénéficiaire.
 *
 * Usage :
 *   pnpm --filter @warrant/server open-warrant -- --scenario honored
 *   pnpm --filter @warrant/server open-warrant -- --scenario diverted --amount 1000000
 */

import { readFileSync } from 'node:fs'
import {
  WarrantStatus,
  actionHash as hashAction,
  classify,
  conditionHash as hashCondition,
  parseRegistry,
  priceRisk,
  registryRefOf,
  type ActionSpec,
  type Address,
  type Hex,
  type Policy,
} from '@warrant/core'
import { createPublicClient, createWalletClient, encodeFunctionData, http, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import { keeperHubEscrow, termsHashOf, viemEscrow, warrantIdOf } from '../gateway.js'
import { KeeperHubClient } from '../keeperhub.js'
import { fileWarrantStore } from '../journal.js'
import {
  RECEIVE_WITH_AUTHORIZATION_TYPE,
  escrowAuthorizationOf,
} from '../x402.js'

/** ABI du MockUSDC de développement. `mint` y est publique, par conception. */
const mockUsdcAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
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
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Le `name` du domaine EIP-712 : lu onchain, jamais supposé. Une divergence
  // d'un seul caractère change le `DOMAIN_SEPARATOR`, donc le digest, donc
  // l'adresse recouvrée — et `receiveWithAuthorization` révèrte en
  // `InvalidSignature` sans dire pourquoi.
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/** Un nom canonique par variable, aucun alias — convention de `.env.example`. */
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`variable d'environnement manquante: ${name}`)
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

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

async function main(): Promise<void> {
  for (const candidate of ['.env', '../../.env']) {
    try {
      process.loadEnvFile(candidate)
      break
    } catch {
      /* suivant */
    }
  }

  const scenario = arg('scenario', 'honored')
  if (scenario !== 'honored' && scenario !== 'diverted') {
    throw new Error(`--scenario doit valoir honored ou diverted, reçu "${scenario}"`)
  }

  // Table des chaînes, alignée sur celle de `bin/gateway.ts`. L'outil était
  // verrouillé sur Ethereum Sepolia : coder une chaîne en dur dans un outil
  // d'exploitation le rend inutilisable dès qu'on redéploie ailleurs, ce qui est
  // exactement ce qui arrive quand le facilitateur de paiement n'existe que sur
  // une autre chaîne. Une chaîne absente de la table fait échouer le démarrage
  // plutôt que de laisser viem deviner un RPC — ouvrir sur la mauvaise chaîne
  // est irréversible.
  const CHAINS = { 1: mainnet, 8453: base, 11155111: sepolia, 84532: baseSepolia } as const
  const chainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', String(baseSepolia.id)))
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) {
    throw new Error(
      `WARRANT_ESCROW_CHAIN_ID non supportée: ${chainId} — ` +
        `valeurs acceptées : ${Object.keys(CHAINS).join(', ')}`,
    )
  }

  const rpc = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])
  const escrow = required('WARRANT_ESCROW_ADDRESS').toLowerCase() as Address
  const token = required('WARRANT_ASSET').toLowerCase() as Address

  // L'agent : celui qui paie la caution et à qui elle revient si le mandat est
  // honoré. Sa clé n'a **aucun** rôle onchain sur l'escrow — `opener` est le
  // wallet KeeperHub, `settler` est une troisième clé (invariant I10). Elle sert
  // ici à **signer l'autorisation EIP-3009**, ce qui est désormais son seul rôle
  // dans l'ouverture : le contrat dérive l'agent de cette signature.
  const agentAccount = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as Hex)
  const agent = agentAccount.address.toLowerCase() as Address

  /**
   * Le bénéficiaire d'une saisie — `WARRANT_BENEFICIARY`, et requis.
   *
   * Ce paramètre valait `optional('WARRANT_TREASURY', agent)`, ce que l'audit a
   * relevé : les deux branches sont désormais des reverts. La trésorerie est
   * refusée par `BeneficiaryIsTreasury` (une saisie ne doit pas enrichir le
   * protocole, invariant I6) ; l'agent lui-même est refusé par `BadBeneficiary`
   * (une saisie rembourserait le fautif, la caution ne veut plus rien dire).
   * Aucun repli ne peut donc être correct — et un repli qui révèrte à coup sûr
   * est pire qu'une variable manquante, parce qu'il ne se découvre qu'onchain.
   */
  const beneficiary = address('WARRANT_BENEFICIARY', required('WARRANT_BENEFICIARY'))
  if (beneficiary === agent) {
    throw new Error(
      `WARRANT_BENEFICIARY (${beneficiary}) est l'agent lui-même : open() révèrterait ` +
        'en BadBeneficiary(). Une saisie rembourserait le fautif.',
    )
  }
  if (beneficiary === escrow) {
    throw new Error(
      `WARRANT_BENEFICIARY (${beneficiary}) est l'escrow : open() révèrterait en ` +
        'BadBeneficiary(). La caution sortirait du passif sans sortir du contrat.',
    )
  }

  const publicClient = createPublicClient({ chain, transport: http(rpc) })
  const wallet = createWalletClient({ account: agentAccount, chain, transport: http(rpc) })

  // La trésorerie **du contrat**, pas celle de la politique locale : c'est à
  // elle que `open()` compare le bénéficiaire. `treasury` est `immutable`, donc
  // cette lecture est définitive pour ce déploiement.
  const onchainTreasury = (
    (await publicClient.readContract({
      address: escrow,
      abi: warrantEscrowAbi,
      functionName: 'treasury',
    })) as string
  ).toLowerCase() as Address
  if (beneficiary === onchainTreasury) {
    throw new Error(
      `WARRANT_BENEFICIARY (${beneficiary}) est la trésorerie de l'escrow : open() ` +
        'révèrterait en BeneficiaryIsTreasury(). Une saisie ne peut pas alimenter le ' +
        'protocole (invariant I6).',
    )
  }

  const kh = new KeeperHubClient({
    apiKey: required('KH_API_KEY'),
    baseUrl: optional('KH_BASE_URL', 'https://app.keeperhub.com'),
  })
  const executor = ((await kh.getWallet()).walletAddress ?? '').toLowerCase() as Address
  if (!executor) throw new Error("KeeperHub ne rapporte aucun wallet d'organisation")

  const registryFile = optional(
    'WARRANT_REGISTRY_FILE',
    // Le registre suit la chaîne : un `registryRef` est propre à un réseau.
    optional(
      'WARRANT_REGISTRY_FILE',
      new URL('../../../../deployments/registry-ethereum-sepolia.json', import.meta.url).pathname,
    ),
  )
  const registry = parseRegistry(readFileSync(registryFile, 'utf8'))
  const registryRef = registryRefOf(registry)

  const amount = BigInt(arg('amount', '1000000'))
  // Le plancher de la politique, et non une constante : sur une chaîne dont le
  // capital vient d'un faucet plafonné, un bond en dur rend l'outil
  // inutilisable — c'est ce qui est arrivé sur Base Sepolia, où le faucet CDP
  // délivre 1 USDC par adresse et par 24 h.
  const bond = BigInt(arg('bond', optional('WARRANT_MIN_BOND', '5000000')))
  const duration = Number(arg('duration', '1800'))

  // Destination **engagée**, celle de l'allowlist de la politique.
  const allowedDest = optional('DEMO_ALLOWED_DEST', '0x000000000000000000000000000000000000dEaD')
    .toLowerCase() as Address
  // Destination réellement servie. Elle ne diffère que dans le scénario détourné.
  const executedDest =
    scenario === 'diverted'
      ? (optional('DEMO_DIVERTED_DEST', '0x00000000000000000000000000000000DeaDBeef').toLowerCase() as Address)
      : allowedDest

  /**
   * La politique du propriétaire du capital.
   *
   * `treasury` est le compte **protégé** : ici le wallet d'exécution KeeperHub,
   * puisque c'est lui qui détient et déplace les fonds. `allowedDest` est
   * l'allowlist — c'est elle, et non le calldata, qui décide de la destination
   * engagée dans la post-condition.
   */
  const policy: Policy = {
    beneficiary,
    treasury: executor,
    minBond: optional('WARRANT_MIN_BOND', '5000000'),
    maxBond: optional('WARRANT_MAX_BOND', '250000000'),
    duration,
    categories: {
      'erc20.transfer': {
        riskBps: 100,
        maxOutflow: amount.toString(10),
        allowedDest: [allowedDest],
      },
    },
  }

  // 1. L'action engagée. Seul intrant de la classification et de la tarification.
  const actionSpec: ActionSpec = {
    version: 1,
    chainId,
    target: token,
    value: '0',
    calldata: encodeFunctionData({
      abi: mockUsdcAbi,
      functionName: 'transfer',
      args: [allowedDest, amount],
    }),
    registryRef,
  }

  const classification = classify(actionSpec, registry)
  const actionHash = hashAction(actionSpec)
  const quote = priceRisk(classification, policy, { chainId, actionHash, executor })
  const conditionSpec = quote.conditionSpec
  const conditionHash = hashCondition(conditionSpec)

  const nonce = BigInt(toHex(crypto.getRandomValues(new Uint8Array(32))))
  const warrantId = warrantIdOf(agent, nonce, actionHash)

  log({
    msg: 'mandat préparé',
    scenario,
    warrantId,
    agent,
    beneficiary,
    executor,
    bond: bond.toString(10),
    category: quote.category,
    conditionHash,
    actionHash,
    registryRef,
    checks: conditionSpec.checks.map((c) => c.kind),
  })

  // 2. Approvisionner **l'agent**, et non le coffre.
  //
  //    C'est le changement de fond de cette étape. `open()` ne s'attend plus à
  //    trouver les fonds sur le contrat — il les *tire* de l'agent, contre sa
  //    signature, dans sa propre transaction. Verser d'avance au coffre
  //    reconstituerait exactement la faille corrigée : un solde libre que
  //    l'`opener` peut s'attribuer, et qu'aucune fonction ne sait balayer si
  //    l'ouverture n'a pas lieu.
  const agentBalance = (await publicClient.readContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [agent],
  })) as bigint
  if (agentBalance < bond) {
    const funded = await wallet.writeContract({
      address: token,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [agent, bond * 10n],
    })
    await publicClient.waitForTransactionReceipt({ hash: funded })
    log({ msg: 'agent approvisionné', tx: funded, bond: bond.toString(10) })
  }

  // 3. L'autorisation EIP-3009, signée par l'agent.
  //
  //    ⚠ `ReceiveWithAuthorization`, **pas** `TransferWithAuthorization`. Les
  //    deux types portent les mêmes champs et produisent deux typehashes
  //    différents, donc deux digests différents. Le contrat appelle la variante
  //    `receive` parce qu'elle impose `to == msg.sender` : sans elle, un tiers
  //    pourrait soumettre l'autorisation au token directement, consommer le
  //    nonce, et faire révèrter l'`open` légitime. Signer le mauvais type ne
  //    produit aucune erreur ici — seulement un `InvalidSignature()` onchain.
  const assetName = (await publicClient.readContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'name',
  })) as string
  const assetVersion = optional('WARRANT_ASSET_VERSION', '2')

  /**
   * Le nonce de l'autorisation **n'est pas aléatoire** : il vaut le hash des
   * termes du mandat, et le contrat le vérifie (`TermsMismatch`).
   *
   * C'est la parade au détournement d'autorisation. EIP-3009 ne signe que six
   * champs, dont aucun ne dit *pour quel mandat* : un `opener` pouvait donc
   * prendre une autorisation et ouvrir des termes de son choix — autre
   * bénéficiaire, autre post-condition, `duration` au maximum. Comme le nonce
   * est dans le digest signé, le contraindre à valoir `termsHash(...)` fait que
   * signer le paiement revient à signer les termes. Une seule signature.
   *
   * L'unicité qu'EIP-3009 exige du nonce reste assurée : `warrantId` contient
   * `nonce`, lui aléatoire, et entre dans le hash.
   */
  const authNonce = termsHashOf({
    id: warrantId,
    beneficiary,
    bond: bond.toString(10),
    conditionHash,
    actionHash,
    duration,
  })
  const validAfter = 0n
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600)

  const signature = await agentAccount.signTypedData({
    domain: {
      name: assetName,
      version: assetVersion,
      chainId,
      verifyingContract: token,
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPE,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: agent,
      // `to` est l'escrow, et le contrat passera `address(this)` au token : les
      // deux doivent coïncider, sinon `CallerMustBePayee()`.
      to: escrow,
      value: bond,
      validAfter,
      validBefore,
      nonce: authNonce,
    },
  })

  const authorization = escrowAuthorizationOf({
    signature,
    authorization: {
      from: agent,
      to: escrow,
      value: bond.toString(10),
      validAfter: validAfter.toString(10),
      validBefore: validBefore.toString(10),
      nonce: authNonce,
    },
  })
  const fundingRef = authorization.nonce
  log({
    msg: 'autorisation EIP-3009 signée',
    primaryType: 'ReceiveWithAuthorization',
    // Le nonce EST le hash des termes : la signature lie le paiement au mandat.
    nonceIsTermsHash: true,
    from: agent,
    to: escrow,
    value: bond.toString(10),
    fundingRef,
  })

  // 4. Le wallet d'exécution doit détenir de quoi transférer.
  const executorBalance = (await publicClient.readContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [executor],
  })) as bigint
  if (executorBalance < amount) {
    const topUp = await wallet.writeContract({
      address: token,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [executor, amount * 10n],
    })
    await publicClient.waitForTransactionReceipt({ hash: topUp })
    log({ msg: "wallet d'exécution approvisionné", tx: topUp })
  }

  // 5. Ouverture. Cette transaction encaisse la caution **et** ouvre le mandat :
  //    si elle révèrte, le nonce n'est pas consommé et rien n'a bougé.
  //
  //    Le port suit `WARRANT_ESCROW_PORT`, comme le Gateway, parce que le
  //    contrat supporte les deux topologies : `keeperhub` quand l'`opener` est
  //    le wallet de l'organisation (ouverture sponsorisée en gas, le cas du
  //    volume), `viem` quand c'est une clé locale. Coder l'une des deux en dur
  //    rendait l'outil inutilisable sur la moitié des déploiements.
  const escrowPort =
    optional('WARRANT_ESCROW_PORT', 'keeperhub') === 'viem'
      ? viemEscrow(
          {
            address: escrow,
            account: agentAccount.address.toLowerCase() as Address,
            chain: publicClient.chain!,
            walletClient: wallet as unknown as {
              writeContract(args: Record<string, unknown>): Promise<Hex>
            },
          },
          warrantEscrowAbi,
        )
      : keeperHubEscrow({ address: escrow, chainId, client: kh, abi: warrantEscrowAbi })

  const openTx = await escrowPort.open({
    id: warrantId,
    beneficiary,
    bond: bond.toString(10),
    conditionHash,
    actionHash,
    duration,
    authorization,
  })
  // `waitForTransactionReceipt` et non `getTransactionReceipt` : le second ne
  // patiente pas, et sur un RPC public le receipt n'est pas encore indexé quand
  // la transaction vient de partir. L'outil échouait donc APRÈS avoir ouvert le
  // mandat onchain — et sans écrire le journal, ce qui rendait la caution
  // inévaluable par le Settler jusqu'à expiration.
  const openReceipt = await publicClient.waitForTransactionReceipt({
    hash: openTx,
    confirmations: 1,
  })
  const openedAt = Number(
    (await publicClient.getBlock({ blockNumber: openReceipt.blockNumber })).timestamp,
  )
  log({ msg: 'mandat ouvert', warrantId, openTx, openedAt, expiry: openedAt + duration })

  // 6. L'action. Dans le scénario détourné, ce qui part sur la chaîne n'est
  //    **pas** ce qui a été engagé — c'est tout l'intérêt.
  const execution = await kh.executeContractCall(
    {
      chainId,
      contractAddress: token,
      functionName: 'transfer',
      functionArgs: [executedDest, amount.toString(10)],
      abi: mockUsdcAbi,
    },
    warrantId,
  )
  log({
    msg: 'action exécutée',
    executionId: execution.executionId,
    status: execution.status,
    txHash: execution.txHash,
    executedDest,
    engagedDest: allowedDest,
    diverted: executedDest !== allowedDest,
  })

  // 7. Le journal. C'est la seule chose que le Settler ne peut pas retrouver
  //    seul : la chaîne ne porte que des hashs. `openTx` y est indispensable :
  //    c'est la transaction qui a encaissé la caution, donc la seule preuve de
  //    paiement résoluble — `fundingRef` n'est plus qu'un nonce.
  const journal = fileWarrantStore({ path: optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl') })
  journal.put({
    id: warrantId,
    agent,
    beneficiary,
    bond: bond.toString(10),
    conditionHash,
    actionHash,
    fundingRef,
    expiry: openedAt + duration,
    openedAt,
    status: WarrantStatus.Open,
    rail: 'x402',
    executionId: execution.executionId,
    openTx,
    actionSpec,
    conditionSpec,
    classification,
    quote,
    simulation: { success: true },
    settlement: {
      success: true,
      // La transaction de règlement **est** l'ouverture, depuis que `open()`
      // tire le paiement EIP-3009 lui-même.
      transaction: openTx,
      network: `eip155:${chainId}`,
      payer: agent,
      amount: bond.toString(10),
    },
  })
  log({ msg: 'journal écrit', path: journal.path, warrantId })
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: 'ouverture impossible', error: String(e) }))
  process.exit(1)
})
