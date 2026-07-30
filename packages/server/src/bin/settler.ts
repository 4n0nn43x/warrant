/**
 * Point d'entrée du daemon de règlement.
 *
 * Le composant qui manquait : sans lui, des mandats s'ouvrent, des actions
 * s'exécutent, et rien ne se règle jamais. C'est le seul processus du système
 * qui déplace des fonds vers un tiers, et c'est pour ça qu'il porte une clé
 * distincte de celle du Gateway (invariant I10).
 *
 * Ce qu'il fait, en boucle :
 *
 *   1. balaye `WarrantOpened` et relit `warrants(id)` — la chaîne fait autorité ;
 *   2. récupère la spec du mandat dans le journal, et la **vérifie** contre les
 *      engagements onchain avant de s'en servir ;
 *   3. interroge l'audit trail KeeperHub pour localiser la transaction ;
 *   4. attend les confirmations sur un RPC indépendant, réévalue la
 *      post-condition à bloc figé, et appelle `decide()` ;
 *   5. soumet `honor` / `slash`, ou s'abstient et laisse `reclaim` rembourser ;
 *   6. publie le document de verdict à une URI stable qu'il sert lui-même ;
 *   7. inscrit le verdict dans ERC-8004 : immédiat sur `slashed`, par lots sur
 *      `honored`, jamais sur `reclaimed`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce qui fait échouer le démarrage, et pourquoi
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Un daemon de règlement mal configuré est pire qu'un daemon absent : il brûle
 * du gas sur des transactions qui révertent, ou — bien plus grave — il juge sur
 * des lectures fausses. Quatre vérifications précèdent donc la première boucle,
 * et chacune est bloquante :
 *
 *   • le `chainId` du RPC de l'escrow est celui annoncé ;
 *   • `settler()` onchain **est** l'adresse dérivée de `SETTLER_PRIVATE_KEY` —
 *     sinon `honor` et `slash` reverteraient en `NotSettler()` ;
 *   • le RPC d'évaluation sait répondre à une **lecture à bloc passé**. Une
 *     évaluation à bloc figé est, au sens JSON-RPC, une requête d'archive : un
 *     nœud qui les refuse rend tout verdict irrejouable et, pire, ferait juger
 *     sur des lectures qui ne sont pas celles annoncées ;
 *   • le solde en gas du Settler est non nul, sinon aucun règlement ne partira.
 *
 * Usage :
 *   pnpm --filter @warrant/server settler
 *   SETTLER_ONCE=1 pnpm --filter @warrant/server settler   # un seul tour
 */

import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { ERC8004, type Address, type Hex } from '@warrant/core'
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import { KeeperHubClient } from '../keeperhub.js'
import {
  createSettlementDaemon,
  erc8004Sink,
  journalMandateSource,
  viemEscrowReader,
  type AgentIdResolver,
  type ReputationSink,
} from '../daemon.js'
import { fileWarrantStore } from '../journal.js'
import { VerdictBatcher } from '../reputation.js'
import { createVerdictServer, fileVerdictPublisher } from '../verdicts.js'

// ─────────────────────────────────────────────────────────────────────────────
// Environnement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un nom canonique par variable, **aucun alias** : c'est la convention de
 * `.env.example`, et sa raison est qu'un binaire qui accepte deux orthographes
 * finit par lire celle qui n'est pas renseignée.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `variable d'environnement manquante: ${name} — ` +
        'voir packages/server/src/bin/settler.ts pour la liste complète',
    )
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

function flag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(optional(name, ''))
}

function address(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} : adresse EVM attendue, reçu "${value}"`)
  }
  return value.toLowerCase() as Address
}

/**
 * Chaînes connues. Les testnets sont énumérés explicitement : c'est cette liste
 * qui autorise une écriture ERC-8004 sans confirmation supplémentaire.
 */
const CHAINS = { 1: mainnet, 8453: base, 84532: baseSepolia, 11155111: sepolia } as const

/**
 * Chaînes de test. Toute chaîne absente de cet ensemble est traitée comme un
 * **mainnet**, et l'écriture ERC-8004 y est refusée sauf autorisation
 * explicite. Le défaut-refus est volontaire : la liste des mainnets est ouverte,
 * celle des testnets qu'on utilise ne l'est pas.
 */
const TESTNET_CHAIN_IDS = new Set([11155111, 84532, 421614, 11155420, 17000, 80002, 97])

/**
 * Table `adresse d'agent → agentId` ERC-8004.
 *
 * L'`IdentityRegistry` n'expose aucune recherche inverse par propriétaire, et
 * balayer `Registered` depuis le bloc de genèse n'est pas praticable sur un RPC
 * public. La table est donc fournie à l'exploitation. Son absence n'empêche
 * rien : le mandat est réglé et le verdict publié, seule l'inscription
 * ERC-8004 est sautée avec une raison explicite.
 */
function loadAgentIds(): AgentIdResolver | undefined {
  const file = optional('ERC8004_AGENT_IDS_FILE', '')
  if (!file) return undefined
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | number>
  const table = new Map<string, bigint>()
  for (const [key, value] of Object.entries(raw)) {
    table.set(key.toLowerCase(), BigInt(value))
  }
  return (agent: Address) => table.get(agent.toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// Vérifications de démarrage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le RPC d'évaluation sait-il lire un état **passé** ?
 *
 * Beaucoup de nœuds publics servent `latest` et refusent l'archive : la réponse
 * est alors une erreur JSON-RPC, pas un silence, et elle n'apparaît qu'au
 * premier verdict — c'est-à-dire trop tard. On sonde donc au démarrage, sur un
 * bloc suffisamment ancien pour être hors de la fenêtre chaude d'un nœud
 * non-archive.
 *
 * La sonde porte sur `eth_getBalance` et **non** sur un appel à l'escrow. Un
 * `eth_call` sur le contrat confondait deux échecs très différents : « ce nœud
 * refuse l'archive » et « le contrat n'existait pas encore à ce bloc ». Un
 * escrow fraîchement déployé faisait donc échouer le démarrage sur un nœud
 * d'archive parfaitement capable — le message accusait le RPC à tort. Le solde
 * d'une adresse, lui, est défini à tout bloc depuis la genèse : l'échec ne peut
 * plus signifier qu'une chose.
 */
async function assertArchiveCapable(
  client: PublicClient,
  escrow: Address,
  depth: bigint,
): Promise<{ probedBlock: bigint }> {
  const head = await client.getBlockNumber()
  const probed = head > depth ? head - depth : 0n
  try {
    await client.getBalance({ address: escrow, blockNumber: probed })
  } catch (e) {
    throw new Error(
      `le RPC d'évaluation ne sait pas lire à bloc passé (essai au bloc ${probed}, ` +
        `tête ${head}) : ${e instanceof Error ? e.message : String(e)}.\n` +
        "L'évaluation d'une post-condition est une lecture à bloc figé, donc une " +
        "requête d'archive. Sur un nœud non-archive, aucun verdict n'est rejouable " +
        'et le Settler jugerait sur des lectures qui ne sont pas celles annoncées. ' +
        'Configurer EVALUATOR_RPC sur un nœud d’archive (voir .env).',
    )
  }
  return { probedBlock: probed }
}

// ─────────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Le script `pnpm settler` charge déjà `../../.env` via
  // `node --env-file-if-exists`. Ce repli sert au lancement direct
  // (`tsx src/bin/settler.ts`) : sans lui, le même fichier serait chargé dans un
  // cas et pas dans l'autre, et la différence ne se verrait qu'à la première
  // variable manquante. Node ≥ 20.12 sait le faire sans dépendance.
  for (const candidate of [optional('WARRANT_ENV_FILE', ''), '.env', '../../.env']) {
    if (!candidate) continue
    try {
      process.loadEnvFile(candidate)
      break
    } catch {
      // Absent ou illisible : on essaie le suivant, puis l'environnement du
      // processus fait foi.
    }
  }

  const escrowChainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', '11155111'))
  const chain = CHAINS[escrowChainId as keyof typeof CHAINS]
  if (!chain) throw new Error(`WARRANT_ESCROW_CHAIN_ID non supportée: ${escrowChainId}`)

  const escrow = address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS'))
  const escrowRpc = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])
  /**
   * RPC d'évaluation : **indépendant de KeeperHub**, et publié tel quel dans
   * chaque verdict. Utiliser le même fournisseur pour exécuter et pour juger
   * réintroduirait la circularité que tout le projet cherche à éviter.
   */
  const evaluatorRpc = optional('EVALUATOR_RPC', escrowRpc)

  const account = privateKeyToAccount(required('SETTLER_PRIVATE_KEY') as Hex)
  const settler = account.address.toLowerCase() as Address

  const escrowClient = createPublicClient({ chain, transport: http(escrowRpc) })
  const actionClient = createPublicClient({ chain, transport: http(evaluatorRpc) })
  const localWallet = createWalletClient({ account, chain, transport: http(escrowRpc) })

  /**
   * Le compte **local** est réinjecté à chaque écriture.
   *
   * `SubmitOptions.account` est typé `Address`, et viem traite une adresse nue
   * comme un compte JSON-RPC : il tente alors `eth_sendTransaction`, que les
   * nœuds publics ne servent pas — la transaction de règlement échouerait avec
   * « method is not available », c'est-à-dire au pire moment, une fois la
   * décision prise. Réinjecter l'objet `Account` restaure la signature locale
   * sans toucher à `settler.ts`, dont la signature reste juste : l'adresse est
   * bien ce qui identifie le Settler, elle n'est simplement pas ce qui signe.
   */
  const walletClient = {
    ...localWallet,
    writeContract: (args: Record<string, unknown>) =>
      localWallet.writeContract({ ...args, account } as never),
  } as unknown as ReturnType<typeof createWalletClient>

  // ── Vérifications bloquantes ───────────────────────────────────────────────
  const observedChainId = await escrowClient.getChainId()
  if (observedChainId !== escrowChainId) {
    throw new Error(
      `le RPC ${escrowRpc} répond chainId ${observedChainId}, alors que ` +
        `WARRANT_ESCROW_CHAIN_ID annonce ${escrowChainId} : un règlement partirait sur la mauvaise chaîne`,
    )
  }

  const onchainSettler = (await escrowClient.readContract({
    address: escrow,
    abi: warrantEscrowAbi,
    functionName: 'settler',
  })) as Address
  if (onchainSettler.toLowerCase() !== settler) {
    throw new Error(
      `settler() onchain vaut ${onchainSettler}, la clé configurée est ${settler} : ` +
        'honor et slash reverteraient en NotSettler(). Rien ne serait jamais réglé.',
    )
  }

  const probe = await assertArchiveCapable(
    actionClient as PublicClient,
    escrow,
    BigInt(optional('SETTLER_ARCHIVE_PROBE_DEPTH', '5000')),
  )

  const gas = await escrowClient.getBalance({ address: settler })
  if (gas === 0n) {
    throw new Error(
      `le Settler ${settler} n'a aucun gas sur la chaîne ${escrowChainId} : ` +
        'aucune transaction de règlement ne pourrait être diffusée',
    )
  }

  // ── Journal, verdicts, ERC-8004 ────────────────────────────────────────────
  const journal = fileWarrantStore({
    path: optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl'),
  })

  const port = Number(optional('SETTLER_PORT', '8403'))
  const verdictBaseUri = optional('VERDICT_BASE_URI', `http://localhost:${port}/v/`)
  const verdictDir = optional('VERDICT_DIR', '.warrant/verdicts')
  const publisher = fileVerdictPublisher({ dir: verdictDir, baseUri: verdictBaseUri })

  const erc8004ChainId = Number(optional('ERC8004_CHAIN_ID', String(escrowChainId)))
  const isTestnet = TESTNET_CHAIN_IDS.has(erc8004ChainId)
  const registries = isTestnet ? ERC8004.testnet : ERC8004.mainnet
  const identityRegistry = address(
    'ERC8004_IDENTITY',
    optional('ERC8004_IDENTITY', registries.identity),
  )
  const reputationRegistry = address(
    'ERC8004_REPUTATION',
    optional('ERC8004_REPUTATION', registries.reputation),
  )

  /**
   * Refus par défaut sur mainnet.
   *
   * Une écriture ERC-8004 est une transaction réelle, avec un coût réel et une
   * trace publique définitive. Rien ici ne doit pouvoir partir sur un mainnet
   * par simple héritage d'une variable d'environnement.
   */
  const mainnetBlocked = !isTestnet && !flag('ERC8004_ALLOW_MAINNET')
  const erc8004Enabled =
    !flag('ERC8004_DISABLED') && erc8004ChainId === escrowChainId && !mainnetBlocked

  const reputation: ReputationSink | undefined = erc8004Enabled
    ? erc8004Sink({
        chainId: erc8004ChainId,
        identityRegistry,
        reputationRegistry,
        settler,
        publicClient: escrowClient as never,
        walletClient: walletClient as never,
        chain,
        publisher,
        batcher: new VerdictBatcher({
          maxBatchSize: Number(optional('ERC8004_BATCH_SIZE', '25')),
          maxAgeMs: Number(optional('ERC8004_BATCH_MAX_AGE_MS', String(24 * 60 * 60 * 1000))),
        }),
        feedbackURIBase: verdictBaseUri,
        logger: emit,
      })
    : undefined

  const kh = new KeeperHubClient({
    apiKey: required('KH_API_KEY'),
    baseUrl: optional('KH_BASE_URL', 'https://app.keeperhub.com'),
  })

  /**
   * Premier bloc balayé.
   *
   * Sans valeur explicite, on ne repart pas du bloc 0 : un mandat vit au plus
   * `MAX_DURATION` = 7 jours (WarrantEscrow.sol), donc **aucun** mandat plus
   * ancien que cette fenêtre ne peut encore être en statut `Open`. Balayer
   * au-delà coûterait des centaines de requêtes `eth_getLogs` à chaque
   * démarrage pour ne rien découvrir de réglable. 60 000 blocs couvrent 7 jours
   * sur une chaîne à 12 s de bloc, avec de la marge.
   */
  const head = await escrowClient.getBlockNumber()
  const lookback = BigInt(optional('SETTLER_LOOKBACK_BLOCKS', '60000'))
  const fromBlock = process.env['SETTLER_FROM_BLOCK']
    ? BigInt(required('SETTLER_FROM_BLOCK'))
    : head > lookback
      ? head - lookback
      : 0n
  const daemon = createSettlementDaemon({
    escrow,
    chainId: escrowChainId,
    settler,
    identityRegistry,
    reader: viemEscrowReader({
      client: escrowClient,
      address: escrow,
      fromBlock,
      chunkBlocks: BigInt(optional('SETTLER_LOG_CHUNK', '9000')),
      onScanError: (error) => emit({ msg: 'settler: balayage incomplet', error }),
    }),
    mandates: journalMandateSource(journal, loadAgentIds()),
    // L'audit trail localise et date ; il ne décide de rien.
    executions: { get: (id) => kh.getDirectExecution(id) },
    actionClient: actionClient as PublicClient,
    evaluatorRpcUrl: evaluatorRpc,
    escrowClient,
    // Sans `SETTLER_DRY_RUN`, le daemon écrit onchain. Le mode observation est
    // explicite : un daemon qu'on croit actif et qui ne règle rien serait le
    // pire des deux mondes.
    ...(flag('SETTLER_DRY_RUN')
      ? {}
      : { submitOptions: { escrow, walletClient, account: settler, chain } }),
    publisher,
    ...(reputation ? { reputation } : {}),
    logger: emit,
    confirmationTimeoutMs: Number(optional('SETTLER_CONFIRMATION_TIMEOUT_MS', '120000')),
  })

  // ── Serveur de verdicts ────────────────────────────────────────────────────
  const verdictServer = createVerdictServer({ dir: verdictDir, baseUri: verdictBaseUri })
  serve({ fetch: verdictServer.fetch, port })

  emit({
    msg: 'warrant settler',
    escrow,
    escrowChainId,
    settler,
    gasWei: gas.toString(10),
    escrowRpc,
    evaluatorRpc,
    archiveProbeBlock: probe.probedBlock.toString(10),
    journal: journal.path,
    fromBlock: fromBlock.toString(10),
    verdictDir,
    verdictBaseUri,
    verdictPort: port,
    dryRun: flag('SETTLER_DRY_RUN'),
    erc8004: erc8004Enabled
      ? { chainId: erc8004ChainId, identityRegistry, reputationRegistry }
      : {
          disabled: true,
          reason: mainnetBlocked
            ? `chaîne ${erc8004ChainId} traitée comme mainnet : écriture refusée sans ERC8004_ALLOW_MAINNET=1`
            : erc8004ChainId !== escrowChainId
              ? `ERC8004_CHAIN_ID=${erc8004ChainId} ≠ chaîne de l'escrow ${escrowChainId} : ` +
                "le Settler ne signe que sur une chaîne à la fois"
              : 'ERC8004_DISABLED',
        },
  })

  const once = flag('SETTLER_ONCE')
  const intervalMs = Number(optional('SETTLER_INTERVAL_MS', '15000'))
  let stopping = false

  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    emit({ msg: 'settler: arrêt', signal })
    // Les lots en attente partent avant l'arrêt : les garder en mémoire
    // reviendrait à perdre des verdicts déjà rendus.
    const flushed = await daemon.flushReputation(true)
    if (flushed.length > 0) emit({ msg: 'settler: lots vidés', flushed })
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  for (;;) {
    const started = Date.now()
    try {
      const report = await daemon.tick()
      emit({
        msg: 'settler: tick',
        open: report.open,
        traités: report.outcomes.length,
        réglés: report.outcomes.filter((o) => o.kind === 'settled').length,
        différés: report.outcomes.filter((o) => o.kind === 'deferred').length,
        échecs: report.outcomes.filter((o) => o.kind === 'failed').length,
        reputation: report.reputation,
        ...(report.scanError ? { scanError: report.scanError } : {}),
        durationMs: Date.now() - started,
      })
    } catch (e) {
      // Un tour raté ne tue pas le daemon : le suivant retentera. Un Settler
      // arrêté laisse expirer des mandats qu'il aurait pu régler.
      emit({ msg: 'settler: tick en échec', error: e instanceof Error ? e.message : String(e) })
    }
    if (once) {
      const flushed = await daemon.flushReputation(true)
      if (flushed.length > 0) emit({ msg: 'settler: lots vidés', flushed })
      process.exit(0)
    }
    await sleep(intervalMs)
  }
}

/** Journal structuré, une ligne JSON par événement. Jamais de secret. */
function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: 'settler: démarrage impossible', error: String(e) }))
  process.exit(1)
})
