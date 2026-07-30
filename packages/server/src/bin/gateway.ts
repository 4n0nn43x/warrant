/**
 * Point d'entrée du Gateway 402.
 *
 * Toute la configuration vient de l'environnement, et rien n'a de valeur par
 * défaut permissive : une variable manquante fait échouer le démarrage avec le
 * nom de la variable. Un serveur qui démarre à moitié configuré ouvrirait des
 * mandats qu'il ne saurait pas régler.
 *
 * **Convention de nommage des variables** (identique dans `.env`,
 * `.env.example` et ici — aucun alias n'est accepté, un nom et un seul) :
 *
 * - le **préfixe** est le nom que le sous-système se donne lui-même : `KH_`
 *   pour KeeperHub (sa CLI est `kh`, ses clés commencent par `kh_`), `X402_`,
 *   `MPP_`, `ERC8004_`, et `WARRANT_` pour ce qui appartient à ce dépôt ;
 * - le **suffixe** nomme le type de la valeur quand il est ambigu : `_RPC` pour
 *   un point de terminaison JSON-RPC, `_URL` pour une URL de service HTTP,
 *   `_KEY` pour un secret, `_FILE` pour un chemin, `_CHAIN_ID`, `_BPS` ;
 * - une variable qui désigne une **adresse EVM** porte le nom du *rôle* et non
 *   celui du type (`WARRANT_BENEFICIARY`, `WARRANT_TREASURY`, `WARRANT_ASSET`,
 *   `WARRANT_PAY_TO`) : le rôle est ce qui se vérifie, l'adresse ne fait que
 *   l'incarner.
 *
 * `MPP_SECRET_KEY`, `OPENER_PRIVATE_KEY` et `KH_API_KEY` ne sont jamais
 * journalisées, jamais incluses dans une réponse, et n'apparaissent pas dans le
 * résumé de démarrage — seule une empreinte tronquée du secret MPP y figure.
 *
 * Usage :
 *   pnpm --filter @warrant/server gateway
 */

import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { loadRegistry, parseRegistry, type Address, type Policy } from '@warrant/core'
import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import {
  createGateway,
  keeperHubEscrow,
  keeperHubExecutor,
  viemEscrow,
  type EscrowPort,
} from '../gateway.js'
import { fileWarrantStore } from '../journal.js'
import { KeeperHubClient } from '../keeperhub.js'
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
/**
 * Une liste d'adresses séparées par des virgules.
 *
 * Elle est déclarée `required` et non `optional`, et c'est le point : une
 * catégorie sortante sans destination autorisée produisait, jusqu'ici, une
 * post-condition d'où les deux checks de destination avaient disparu **en
 * silence**. Un transfert vers une adresse quelconque passait alors les checks
 * restants et la caution était rendue. `buildConditionSpec` refuse désormais ce
 * cas, mais un refus au moment d'ouvrir un mandat est une mauvaise nouvelle
 * tardive : mieux vaut que le serveur ne démarre pas du tout, en nommant la
 * variable qui manque.
 */
function addressList(name: string, raw: string): Address[] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (items.length === 0) {
    throw new Error(`${name} : au moins une adresse est requise, la liste est vide`)
  }
  return items.map((value) => address(name, value))
}

function loadPolicy(): Policy {
  const file = process.env['WARRANT_POLICY_FILE']
  if (file && file.trim() !== '') {
    return JSON.parse(readFileSync(file.trim(), 'utf8')) as Policy
  }
  const allowedDest = addressList('WARRANT_ALLOWED_DEST', required('WARRANT_ALLOWED_DEST'))
  const watchedTokens = process.env['WARRANT_WATCHED_TOKENS']
    ? addressList('WARRANT_WATCHED_TOKENS', process.env['WARRANT_WATCHED_TOKENS'])
    : undefined

  return {
    beneficiary: address('WARRANT_BENEFICIARY', required('WARRANT_BENEFICIARY')),
    treasury: address('WARRANT_TREASURY', required('WARRANT_TREASURY')),
    minBond: optional('WARRANT_MIN_BOND', '5000000'),
    maxBond: optional('WARRANT_MAX_BOND', '250000000'),
    duration: Number(optional('WARRANT_DURATION', '3600')),
    ...(watchedTokens ? { watchedTokens } : {}),
    categories: {
      'erc20.transfer': {
        riskBps: 100,
        maxOutflow: optional('WARRANT_MAX_OUTFLOW', '0'),
        allowedDest,
      },
      'erc20.approve': { riskBps: 50, maxOutflow: '0', allowedDest },
      'aavev3.repay': { riskBps: 25 },
      'aavev3.supply': { riskBps: 25 },
      'aavev3.withdraw': { riskBps: 150, allowedDest },
      'aavev3.borrow': { riskBps: 200, allowedDest },
    },
  }
}

/**
 * Chaînes où un escrow peut être déployé.
 *
 * Sepolia y figure parce que c'est là que `WarrantEscrow` tourne réellement
 * aujourd'hui (deployments/ethereum-sepolia.json) ; les mainnets y figurent
 * parce qu'ils sont la cible de la soumission. Une chaîne absente de cette
 * table fait échouer le démarrage plutôt que de laisser viem deviner un RPC —
 * ouvrir un mandat sur la mauvaise chaîne est irréversible.
 */
const CHAINS = {
  1: mainnet,
  8453: base,
  11155111: sepolia,
  84532: baseSepolia,
} as const

/**
 * Le facilitateur x402 configure sert-il bien notre schema et notre chaine ?
 *
 * On ne lui delegue pas la verification de signature — l'escrow consomme
 * `receiveWithAuthorization`, hors du schema `exact`, et le token fait autorite
 * dans `open()`. Mais on annonce ce facilitateur dans chaque challenge 402 :
 * s'il ne couvre pas notre reseau, on emet des challenges que personne ne peut
 * honorer, et l'echec n'apparait qu'au premier paiement.
 *
 * Non fatal a dessein. Un facilitateur momentanement injoignable n'invalide
 * aucun mandat deja ouvert, et refuser de demarrer pour cela immobiliserait le
 * reglement — or c'est le reglement qui protege les cautions.
 */
async function facilitatorPreflight(
  facilitator: FacilitatorClient,
  network: string,
): Promise<void> {
  try {
    const { kinds } = await facilitator.supported()
    const served = kinds.some((k) => k.scheme === 'exact' && k.network === network)
    console.log(
      JSON.stringify({
        msg: 'preflight facilitateur',
        network,
        sertExactSurNotreReseau: served,
        schemes: [...new Set(kinds.map((k) => k.scheme))],
        note: served
          ? undefined
          : `le facilitateur ne declare pas servir exact sur ${network} : les challenges 402 seront inhonorables`,
      }),
    )
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'preflight facilitateur injoignable — demarrage poursuivi',
        detail: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/** Fabrique le port d'ouverture, et rend l'adresse qui signera réellement. */
async function buildEscrow(opts: {
  mode: string
  escrowAddress: Address
  chainId: number
  chain: (typeof CHAINS)[keyof typeof CHAINS]
  rpcUrl: string
  keeperHubApiKey: string
  keeperHubBaseUrl: string
}): Promise<{ escrow: EscrowPort; opener: Address; via: string }> {
  if (opts.mode === 'viem') {
    // Chemin conservé pour un déploiement où l'`opener` est une clé locale.
    // Il n'est plus le chemin par défaut : l'`opener` onchain est aujourd'hui
    // le wallet de l'organisation KeeperHub, et cette clé se ferait répondre
    // `NotOpener()`. Le contrôle de cohérence plus bas le dira sans ambiguïté.
    const account = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as `0x${string}`)
    const walletClient = createWalletClient({
      account,
      chain: opts.chain,
      transport: http(opts.rpcUrl),
    })
    return {
      escrow: viemEscrow(
        {
          address: opts.escrowAddress,
          account: account.address.toLowerCase() as Address,
          chain: opts.chain,
          walletClient: walletClient as unknown as {
            writeContract(args: Record<string, unknown>): Promise<`0x${string}`>
          },
        },
        warrantEscrowAbi,
      ),
      opener: account.address.toLowerCase() as Address,
      via: `clé locale ${account.address}`,
    }
  }

  if (opts.mode !== 'keeperhub') {
    throw new Error(
      `WARRANT_ESCROW_PORT inconnu: "${opts.mode}" — valeurs acceptées : keeperhub, viem`,
    )
  }

  const client = new KeeperHubClient({
    apiKey: opts.keeperHubApiKey,
    baseUrl: opts.keeperHubBaseUrl,
  })
  // Le wallet est *organization-scoped* : une organisation n'en a qu'un, et
  // c'est lui qui signera. On le lit plutôt que de le configurer — une adresse
  // recopiée à la main dans un `.env` est une occasion de plus de diverger de
  // la réalité onchain.
  const wallet = await client.getWallet()
  if (!wallet.hasWallet || !wallet.walletAddress) {
    throw new Error(
      "KeeperHub ne rapporte aucun wallet d'exécution pour cette organisation : " +
        "impossible d'ouvrir un mandat (GET /api/user/wallet)",
    )
  }
  return {
    escrow: keeperHubEscrow({
      address: opts.escrowAddress,
      chainId: opts.chainId,
      client,
      abi: warrantEscrowAbi,
    }),
    opener: wallet.walletAddress.toLowerCase() as Address,
    via: `wallet KeeperHub ${wallet.walletAddress}`,
  }
}

/**
 * Contrôle de cohérence au démarrage : l'adresse qui ouvrira est-elle bien
 * l'`opener` du contrat ?
 *
 * Ce n'est pas du zèle. La divergence est arrivée — le rôle `opener` a été
 * transféré au wallet KeeperHub sans que la configuration locale le sache — et
 * elle ne se voit qu'au premier mandat **payant** : la caution est réglée, puis
 * `open()` révèrte en `NotOpener()`. Le coût d'un démarrage refusé est nul, le
 * coût d'une découverte en production est une caution prélevée pour rien.
 *
 * On lit aussi le `settler`, uniquement pour vérifier l'invariant I10 : si le
 * contrat avait fini avec `opener == settler`, le composant qui ouvre pourrait
 * saisir, et toute l'argumentation de sécurité serait fausse.
 *
 * Un échec **réseau** ne bloque pas le démarrage : on ne peut pas distinguer un
 * RPC indisponible d'une vraie divergence, et refuser de démarrer pour un RPC
 * qui hoquette serait un déni de service qu'on s'infligerait. Une divergence
 * *constatée*, elle, est fatale.
 */
async function preflight(opts: {
  escrowAddress: Address
  chain: (typeof CHAINS)[keyof typeof CHAINS]
  rpcUrl: string
  opener: Address
  beneficiary: Address
  asset: Address
}): Promise<
  | { opener: Address; settler: Address; feeBps: number; treasury: Address; token: Address }
  | undefined
> {
  const publicClient = createPublicClient({
    chain: opts.chain,
    transport: http(opts.rpcUrl),
  })
  let onchain: {
    opener: Address
    settler: Address
    feeBps: number
    treasury: Address
    token: Address
  }
  try {
    const [opener, settler, feeBps, treasury, token] = await Promise.all([
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'opener',
      }),
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'settler',
      }),
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'feeBps',
      }),
      // `treasury` et `token` sont `immutable` : ces deux lectures valent pour
      // la durée de vie du contrat, et permettent de refuser au démarrage deux
      // configurations qui ne révèrteraient qu'au premier mandat payant.
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'treasury',
      }),
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'token',
      }),
    ])
    onchain = {
      opener: (opener as string).toLowerCase() as Address,
      settler: (settler as string).toLowerCase() as Address,
      feeBps: Number(feeBps),
      treasury: (treasury as string).toLowerCase() as Address,
      token: (token as string).toLowerCase() as Address,
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'préflight escrow injoignable — démarrage poursuivi',
        detail: err instanceof Error ? err.message : String(err),
        rpc: opts.rpcUrl,
      }),
    )
    return undefined
  }

  if (onchain.opener !== opts.opener) {
    throw new Error(
      `opener incohérent : le contrat ${opts.escrowAddress} a pour opener ` +
        `${onchain.opener}, mais le Gateway ouvrirait avec ${opts.opener}. ` +
        'Tout `open()` reverterait en NotOpener() *après* que la caution ait été ' +
        'réglée. Corriger WARRANT_ESCROW_PORT, ou transférer le rôle onchain.',
    )
  }
  if (onchain.opener === onchain.settler) {
    throw new Error(
      `invariant I10 violé onchain : opener == settler == ${onchain.opener}. ` +
        'Le composant qui ouvre pourrait saisir.',
    )
  }

  // Le bénéficiaire de la politique est refusé par `open()` s'il est la
  // trésorerie du contrat (`BeneficiaryIsTreasury`, invariant I6 : une saisie ne
  // doit pas enrichir le protocole). La trésorerie étant `immutable`, la
  // divergence est permanente — et se découvrirait au premier mandat payant,
  // après que l'agent a signé son autorisation.
  if (onchain.treasury === opts.beneficiary) {
    throw new Error(
      `WARRANT_BENEFICIARY (${opts.beneficiary}) est la trésorerie du contrat ` +
        `${opts.escrowAddress} : tout open() reverterait en BeneficiaryIsTreasury(). ` +
        'Une saisie ne peut pas alimenter le protocole (invariant I6).',
    )
  }

  // L'actif annoncé dans le 402 doit être le token que l'escrow tirera. Un
  // écart signifie que l'agent signerait une autorisation EIP-3009 sur un
  // domaine EIP-712 — donc un token — que le contrat n'appellera jamais.
  if (onchain.token !== opts.asset) {
    throw new Error(
      `WARRANT_ASSET (${opts.asset}) n'est pas le token de l'escrow ` +
        `(${onchain.token}). L'autorisation EIP-3009 serait signée pour le mauvais ` +
        'token et open() reverterait.',
    )
  }
  return onchain
}

async function main(): Promise<void> {
  const port = Number(optional('PORT', '8402'))
  const baseUrl = optional('WARRANT_BASE_URL', `http://localhost:${port}`)
  const escrowChainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', '8453'))
  const chain = CHAINS[escrowChainId as keyof typeof CHAINS]
  if (!chain) {
    throw new Error(
      `WARRANT_ESCROW_CHAIN_ID non supportée: ${escrowChainId} — ` +
        `chaînes connues : ${Object.keys(CHAINS).join(', ')}`,
    )
  }
  const rpcUrl = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])

  const registryFile = process.env['WARRANT_REGISTRY_FILE']
  const registry =
    registryFile && registryFile.trim() !== ''
      ? parseRegistry(readFileSync(registryFile.trim(), 'utf8'))
      : loadRegistry()

  const policy = loadPolicy()
  const escrowAddress = address(
    'WARRANT_ESCROW_ADDRESS',
    required('WARRANT_ESCROW_ADDRESS'),
  )

  // Clé d'organisation `kh_`. Une clé `wfb_` est une clé webhook utilisateur et
  // sera rejetée en 401 sur les routes d'exécution.
  const keeperHubApiKey = required('KH_API_KEY')
  const keeperHubBaseUrl = optional('KH_BASE_URL', 'https://app.keeperhub.com')
  if (keeperHubApiKey.startsWith('wfb_')) {
    console.warn(
      'attention: KH_API_KEY commence par `wfb_`, une clé webhook utilisateur. ' +
        "Les routes d'exécution exigent une clé d'organisation `kh_`.",
    )
  }

  // KeeperHub par défaut, parce que c'est l'état réel du déploiement et non une
  // préférence : `opener()` est le wallet de l'organisation (docs/transactions
  // § 3). Le défaut doit être ce qui marche, pas ce qui a marché.
  const escrowMode = optional('WARRANT_ESCROW_PORT', 'keeperhub')
  const { escrow, opener, via } = await buildEscrow({
    mode: escrowMode,
    escrowAddress,
    chainId: escrowChainId,
    chain,
    rpcUrl,
    keeperHubApiKey,
    keeperHubBaseUrl,
  })

  const asset = address('WARRANT_ASSET', required('WARRANT_ASSET'))

  /**
   * `payTo` **est** l'escrow, et ce n'est plus un choix de configuration.
   *
   * `open()` appelle `receiveWithAuthorization`, dont la variante `receive`
   * exige `to == msg.sender` — donc `to == address(escrow)`. Or `to` est dans le
   * digest EIP-712 que l'agent signe, et il vaut `payTo` par construction du
   * schéma `exact`. Un `WARRANT_PAY_TO` distinct de l'escrow produirait donc une
   * signature que le token refuse en `CallerMustBePayee()`, au moment du
   * paiement, sans rien qui désigne la variable fautive.
   *
   * C'était une adresse de coffre libre du temps où le facilitateur réglait le
   * paiement puis virait les fonds ; l'ouverture encaissant elle-même, les deux
   * rôles ont fusionné.
   */
  const payTo = address('WARRANT_PAY_TO', required('WARRANT_PAY_TO'))
  if (payTo !== escrowAddress) {
    throw new Error(
      `WARRANT_PAY_TO (${payTo}) doit être l'adresse de l'escrow ` +
        `(WARRANT_ESCROW_ADDRESS = ${escrowAddress}) : open() appelle ` +
        'receiveWithAuthorization, dont la variante `receive` exige to == msg.sender. ' +
        'Toute autorisation signée pour une autre adresse serait refusée par le token ' +
        'en CallerMustBePayee().',
    )
  }

  const onchain =
    optional('WARRANT_SKIP_PREFLIGHT', '0') === '1'
      ? undefined
      : await preflight({
          escrowAddress,
          chain,
          rpcUrl,
          opener,
          beneficiary: policy.beneficiary,
          asset,
        })

  const mppSecret = required('MPP_SECRET_KEY')

  // Sorti en variable pour etre sondable au demarrage : on annonce ce
  // facilitateur dans chaque challenge 402, autant verifier qu'il sert notre
  // reseau avant d'en emettre un.
  const facilitator = new FacilitatorClient({
    url: optional('X402_FACILITATOR', 'https://x402.org/facilitator'),
    ...(process.env['X402_FACILITATOR_API_KEY']
      ? { apiKey: process.env['X402_FACILITATOR_API_KEY'] }
      : {}),
  })
  const network = optional('WARRANT_NETWORK', `eip155:${escrowChainId}`)
  await facilitatorPreflight(facilitator, network)

  const app = createGateway({
    registry,
    policy,
    baseUrl,
    /**
     * Le journal, et non le store en mémoire.
     *
     * Les events onchain ne portent que des *hashs* : `conditionHash` n'est pas
     * inversible, donc la chaîne seule ne suffit pas à réévaluer un mandat. Le
     * Settler a besoin des `ConditionSpec` et `ActionSpec` en clair, et c'est le
     * Gateway — seul à les avoir vues — qui doit les écrire.
     *
     * Avec `memoryWarrantStore()`, un redémarrage du Gateway rendait
     * définitivement inévaluable tout mandat déjà ouvert : la caution restait
     * bloquée jusqu'à `reclaim`. C'est arrivé pour de vrai, sur deux mandats.
     *
     * Le journal reste sans autorité : le Settler recalcule `conditionHash` et
     * `actionHash` depuis les specs lues ici et les compare à l'engagement
     * onchain. Une ligne falsifiée fait donc abstention, jamais saisie.
     */
    store: fileWarrantStore(optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl')),
    realm: optional('WARRANT_REALM', 'warrant.sh'),
    network,
    asset,
    payTo,
    assetExtra: {
      name: optional('WARRANT_ASSET_NAME', 'USDC'),
      // ⚠ Le domaine EIP-712 réel du token. À lire onchain plutôt qu'à croire
      // sur parole : une `version` erronée fait échouer toutes les signatures.
      version: optional('WARRANT_ASSET_VERSION', '2'),
    },
    facilitator,
    executor: keeperHubExecutor({
      apiKey: keeperHubApiKey,
      baseUrl: keeperHubBaseUrl,
    }),
    escrow,
    mppSecret,
    mppMethod: optional('MPP_METHOD', 'tempo'),
    mppCurrency: optional('MPP_CURRENCY', 'USDC'),
    challengeTtlSeconds: Number(optional('MPP_CHALLENGE_TTL', '300')),
  })

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      JSON.stringify({
        msg: 'warrant gateway',
        port: info.port,
        baseUrl,
        escrowChainId,
        escrow: escrowAddress,
        escrowPort: escrowMode,
        opener,
        openerVia: via,
        // Confirmation que ce qui a été lu onchain correspond à ce qu'on croit.
        // Absent si le RPC n'a pas répondu — l'absence est alors l'information.
        ...(onchain
          ? { onchainSettler: onchain.settler, onchainFeeBps: onchain.feeBps }
          : { preflight: 'ignoré' }),
        beneficiary: policy.beneficiary,
        treasury: policy.treasury,
        bondRange: [policy.minBond, policy.maxBond],
        // Empreinte du secret, jamais le secret. Permet de vérifier qu'on a
        // bien déployé la même clé que le client sans jamais l'exposer.
        mppSecretFingerprint: createHash('sha256')
          .update(mppSecret)
          .digest('hex')
          .slice(0, 8),
      }),
    )
  })
}

main().catch((err: unknown) => {
  // Un démarrage refusé doit dire *quoi* corriger, sur une seule ligne, et
  // sortir en échec : un superviseur qui redémarre en boucle sur un message
  // clair coûte moins cher qu'un serveur qui tourne mal configuré.
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
