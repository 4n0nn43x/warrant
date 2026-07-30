/**
 * Enregistrement de l'identité ERC-8004 d'un agent — outil d'exploitation.
 *
 * Ce script est la pièce sans laquelle toute la surface ERC-8004 du dépôt reste
 * inerte. `reputation.ts` sait construire le document de feedback, calculer son
 * `feedbackHash` et appeler `giveFeedback` ; `daemon.ts` sait quand écrire. Mais
 * `giveFeedback` prend un `agentId`, et cet `agentId` n'existe que si quelqu'un
 * a appelé `IdentityRegistry.register`. Personne ne le faisait. Le Settler
 * réglait donc les mandats et sautait l'inscription avec, à chaque tour, la même
 * raison : « aucun agentId ERC-8004 connu pour cet agent ».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pourquoi c'est l'agent qui signe, et jamais Warrant
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `register` frappe le NFT au profit de `msg.sender` — il n'existe aucune
 * surcharge `registerFor(owner, …)`. Si Warrant enregistrait l'agent depuis une
 * de ses propres adresses, Warrant en deviendrait le owner, et
 * `ReputationRegistry.giveFeedback` refuserait ensuite **à jamais** tout verdict
 * émis par le Settler : le registre exige
 * `!isAuthorizedOrOwner(msg.sender, agentId)` (ReputationRegistryUpgradeable.sol:110).
 * Une identité mal enregistrée est donc irréparable — on ne peut pas « rendre »
 * le jeton et recommencer sans en frapper un second et abandonner le premier.
 *
 * D'où la forme de ce script : il **prépare** la transaction avec
 * `buildAgentRegistration` — la même fonction que celle testée dans
 * `reputation.test.ts`, pas une réimplémentation — et la fait signer par la clé
 * de l'agent (`OPENER_PRIVATE_KEY`, la seule clé du dépôt qui appartienne à
 * l'agent). Puis il **vérifie**, une fois le jeton frappé, que le Settler n'en
 * est ni owner ni operator. Cette vérification n'est pas décorative : c'est la
 * seule qui distingue une identité utilisable d'une identité qui fera révèrter
 * chaque `giveFeedback` jusqu'à la fin des temps.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * La chaîne, et l'erreur qu'on ne refera pas
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Un `agentId` n'a de sens que sur la chaîne où il a été frappé : c'est un
 * `tokenId` ERC-721. La table d'identités de ce dépôt contenait un `agentId`
 * enregistré sur Ethereum Sepolia alors que l'escrow, la caution et le Settler
 * vivent sur Base Sepolia — donc un identifiant qui ne désignait rien, et un
 * `ownerOf` qui révèrtait. Ce script refuse toute divergence de chaîne, et
 * revérifie le `chainId` que répond réellement le RPC avant d'envoyer quoi que
 * ce soit. Une identité frappée sur la mauvaise chaîne coûte du gas et ne se
 * corrige pas.
 *
 * Usage :
 *   pnpm --filter @warrant/server register-agent
 *   pnpm --filter @warrant/server register-agent -- --dry-run
 *   pnpm --filter @warrant/server register-agent -- --agent-uri https://…/card.json
 *   pnpm --filter @warrant/server register-agent -- --from-block 44700000
 *   pnpm --filter @warrant/server register-agent -- --force
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ERC8004, type Address, type Hex } from '@warrant/core'
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  hexToString,
  http,
  parseEventLogs,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import {
  METADATA_KEYS,
  buildAgentRegistration,
  identityRegistryAbi,
  inspectAgentIdentity,
  reputationRegistryAbi,
} from '../reputation.js'

// ─────────────────────────────────────────────────────────────────────────────
// Environnement et arguments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un nom canonique par variable, **aucun alias** — convention de `.env.example`,
 * reprise telle quelle de `bin/settler.ts` et `bin/open-warrant.ts`. Ces lecteurs
 * sont dupliqués dans chaque binaire parce qu'un binaire d'exploitation doit
 * rester lisible seul ; les factoriser dans un module partagé ferait dépendre
 * l'outil d'un fichier qu'on relirait de toute façon.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `variable d'environnement manquante: ${name} — ` +
        'voir packages/server/src/bin/register-agent.ts',
    )
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Toute adresse est ramenée en minuscules.
 *
 * Ce n'est pas cosmétique : viem valide le checksum EIP-55 et **rejette** une
 * adresse dont la casse ne correspond pas — les adresses ERC-8004 à préfixe
 * vanity telles qu'elles circulent (`0x8004A818BFb912233C491871b3d84C89A494Bd9e`)
 * n'ont pas un checksum valide et font échouer `readContract` avant même
 * d'atteindre le réseau. Les constantes de `@warrant/core` sont en minuscules
 * pour la même raison.
 */
function address(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} : adresse EVM attendue, reçu "${value}"`)
  }
  return value.toLowerCase() as Address
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const next = process.argv[index + 1]
  return index !== -1 && next && !next.startsWith('--') ? next : fallback
}

function switchOn(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/** Journal structuré, une ligne JSON par événement. Jamais de secret. */
function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

/**
 * Chaînes connues, table alignée sur `bin/settler.ts`.
 *
 * ⚠ Elle est volontairement dupliquée, mais elle doit rester **au plus aussi
 * permissive** que celle du Settler : autoriser ici une chaîne que le Settler
 * refuse produirait une identité frappée pour rien.
 */
const CHAINS = { 1: mainnet, 8453: base, 84532: baseSepolia, 11155111: sepolia } as const

/** Même ensemble que `bin/settler.ts` : hors de lui, la chaîne est un mainnet. */
const TESTNET_CHAIN_IDS = new Set([11155111, 84532, 421614, 11155420, 17000, 80002, 97])

// ─────────────────────────────────────────────────────────────────────────────
// La table `adresse d'agent → agentId`
// ─────────────────────────────────────────────────────────────────────────────

/** Nom de fichier de la table. Le Settler n'en connaît que le chemin complet. */
export const AGENT_IDS_BASENAME = 'agent-ids.json'

export interface AgentIdsFileLocation {
  /** Chemin absolu, résolu. C'est lui qui doit figurer dans `.env`. */
  path: string
  /** Ce qui a décidé de ce chemin — la seule information utile en diagnostic. */
  source: 'ERC8004_AGENT_IDS_FILE' | 'WARRANT_JOURNAL_FILE' | 'default'
}

/**
 * Où vit la table.
 *
 * `bin/settler.ts` ne lit la table **que** si `ERC8004_AGENT_IDS_FILE` est
 * définie : sans elle, `loadAgentIds()` rend `undefined`, aucun `agentId` n'est
 * résolu, et l'inscription est sautée à chaque mandat. La variable n'est donc pas
 * un réglage, c'est l'interrupteur de toute la surface ERC-8004.
 *
 * En son absence, ce script écrit **à côté du journal des mandats**, et c'est un
 * choix argumenté : la table et le journal sont lus par le même processus, et
 * `WARRANT_JOURNAL_FILE` est déjà un chemin absolu précisément parce qu'un chemin
 * relatif se résolvait au répertoire courant de chaque process — le Gateway
 * écrivait un journal, le Settler en lisait un autre. La table hériterait du même
 * piège, en pire : son absence ne casse rien de visible, elle rend seulement la
 * réputation silencieusement vide. Le défaut retenu fait donc que la ligne `.env`
 * à ajouter désigne exactement le fichier que ce script vient d'écrire.
 */
export function agentIdsFilePath(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): AgentIdsFileLocation {
  const explicit = env['ERC8004_AGENT_IDS_FILE']?.trim()
  if (explicit) {
    return { path: resolve(cwd, explicit), source: 'ERC8004_AGENT_IDS_FILE' }
  }
  const journal = env['WARRANT_JOURNAL_FILE']?.trim()
  if (journal) {
    return {
      path: join(dirname(resolve(cwd, journal)), AGENT_IDS_BASENAME),
      source: 'WARRANT_JOURNAL_FILE',
    }
  }
  return { path: resolve(cwd, '.warrant', AGENT_IDS_BASENAME), source: 'default' }
}

/** La ligne exacte à coller dans `.env`. Ce script ne modifie jamais `.env`. */
export function envLineFor(path: string): string {
  return `ERC8004_AGENT_IDS_FILE=${path}`
}

/** Table lue sur disque. Un fichier absent est une table vide, pas une erreur. */
export function readAgentIds(path: string): Record<string, string> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const parsed = JSON.parse(raw) as Record<string, string | number>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    // `BigInt(value)` valide au passage : une valeur non entière ferait lever
    // `loadAgentIds()` au démarrage du Settler, c'est-à-dire trop tard.
    out[key.toLowerCase()] = BigInt(value).toString(10)
  }
  return out
}

/**
 * Insère ou remplace l'entrée d'un agent, sans toucher aux autres.
 *
 * Le remplacement est délibéré : une entrée périmée — un `agentId` frappé sur
 * une autre chaîne, par exemple — est précisément ce qu'on vient corriger. La
 * conserver ne servirait qu'à ce que le Settler continue de lire une valeur
 * fausse. `main()` ne remplace toutefois jamais une entrée sans l'avoir d'abord
 * confrontée à la chaîne (`inspectAgentIdentity`).
 */
export function upsertAgentId(
  table: Readonly<Record<string, string>>,
  agent: Address,
  agentId: bigint,
): Record<string, string> {
  return { ...table, [agent.toLowerCase()]: agentId.toString(10) }
}

/**
 * Écriture atomique : fichier temporaire puis `rename`. Le Settler peut lire ce
 * fichier au même instant — il le relit à chaque démarrage — et un JSON tronqué
 * le ferait échouer au démarrage plutôt que de simplement sauter l'inscription.
 *
 * Deux espaces d'indentation et un retour final : ce fichier est aussi édité à
 * la main, et une seule ligne de 400 caractères ne se relit pas.
 */
export function writeAgentIds(path: string, table: Readonly<Record<string, string>>): void {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = `${JSON.stringify(table, null, 2)}\n`
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, 'utf8')
  renameSync(temp, path)
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture de l'`agentId` frappé
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisteredLog {
  address?: string
  topics: readonly string[]
  data: string
}

/**
 * Extrait l'`agentId` de l'event `Registered` du reçu.
 *
 * On ne se contente pas de la valeur de retour de `register` : une transaction
 * envoyée en `sendTransaction` ne rend aucune donnée de retour, et une
 * simulation faite **avant** l'envoi peut être invalidée par une autre
 * inscription arrivée entre-temps — l'`agentId` est un compteur. Le reçu est la
 * seule source qui dise ce qui a réellement été frappé.
 *
 * Le filtre par adresse compte : le registre est un ERC-721, il émet aussi
 * `Transfer` et éventuellement `MetadataSet` dans la même transaction, et une
 * transaction pourrait toucher plusieurs contrats.
 */
export function agentIdFromLogs(
  logs: readonly RegisteredLog[],
  identityRegistry: Address,
): bigint {
  const registry = identityRegistry.toLowerCase()
  const events = parseEventLogs({
    abi: identityRegistryAbi,
    eventName: 'Registered',
    logs: logs.filter((l) => (l.address ?? '').toLowerCase() === registry) as never,
  })
  const first = events[0]
  if (!first) {
    throw new Error(
      `aucun event Registered émis par ${registry} dans ce reçu : le jeton n'a pas ` +
        "été frappé, ou l'ABI de l'implémentation courante a divergé de celle figée " +
        'dans reputation.ts (les registres sont upgradeable)',
    )
  }
  return (first.args as { agentId: bigint }).agentId
}

// ─────────────────────────────────────────────────────────────────────────────
// Chaîne
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainDecision {
  escrowChainId: number
  erc8004ChainId: number
  /** `undefined` quand rien n'interdit d'écrire sur cette chaîne. */
  refusal?: string
}

/**
 * Sur quelle chaîne enregistrer, et faut-il refuser ?
 *
 * Deux refus, tous deux repris de `bin/settler.ts` pour que l'outil ne puisse pas
 * produire une identité que le Settler ignorera :
 *
 *   • **divergence de chaîne** — le Settler « ne signe que sur une chaîne à la
 *     fois » et refuse d'écrire si `ERC8004_CHAIN_ID` diffère de la chaîne de
 *     l'escrow. Frapper un jeton ailleurs revient à payer du gas pour un
 *     identifiant que rien ne lira ; c'est exactement ce qui est arrivé avec
 *     l'`agentId` 8986 d'Ethereum Sepolia ;
 *   • **mainnet par défaut refusé** — la liste des mainnets est ouverte, celle
 *     des testnets qu'on utilise ne l'est pas. Une identité mainnet est une trace
 *     publique définitive et ne doit pas partir par héritage d'une variable.
 */
export function decideChain(
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): ChainDecision {
  const escrowChainId = Number(env['WARRANT_ESCROW_CHAIN_ID']?.trim() || '11155111')
  const erc8004ChainId = Number(
    env['ERC8004_CHAIN_ID']?.trim() || String(escrowChainId),
  )
  const allowMainnet =
    /^(1|true|yes|on)$/i.test(env['ERC8004_ALLOW_MAINNET']?.trim() ?? '') ||
    argv.includes('--allow-mainnet')

  if (!Number.isInteger(erc8004ChainId) || !CHAINS[erc8004ChainId as keyof typeof CHAINS]) {
    return {
      escrowChainId,
      erc8004ChainId,
      refusal: `chaîne ${erc8004ChainId} inconnue de la table CHAINS : valeurs acceptées ${Object.keys(CHAINS).join(', ')}`,
    }
  }
  if (erc8004ChainId !== escrowChainId) {
    return {
      escrowChainId,
      erc8004ChainId,
      refusal:
        `ERC8004_CHAIN_ID=${erc8004ChainId} ≠ chaîne de l'escrow ${escrowChainId} : ` +
        "le Settler ne signe que sur une chaîne à la fois et n'écrirait aucun " +
        `feedback pour un agentId frappé sur ${erc8004ChainId}. Un agentId est un ` +
        "tokenId ERC-721 : il ne désigne rien hors de sa chaîne d'origine.",
    }
  }
  if (!TESTNET_CHAIN_IDS.has(erc8004ChainId) && !allowMainnet) {
    return {
      escrowChainId,
      erc8004ChainId,
      refusal:
        `chaîne ${erc8004ChainId} traitée comme un mainnet : enregistrement refusé ` +
        "sans ERC8004_ALLOW_MAINNET=1 (ou --allow-mainnet). Une identité mainnet est " +
        'une trace publique définitive.',
    }
  }
  return { escrowChainId, erc8004ChainId }
}

// ─────────────────────────────────────────────────────────────────────────────
// L'URI de la carte d'agent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `agentURI` par défaut.
 *
 * La spec veut une URI qui serve la carte de l'agent. Rien dans ce dépôt ne sert
 * une telle carte aujourd'hui — et on préfère l'écrire ici plutôt que de laisser
 * croire l'inverse : l'URI est donc dérivée de `VERDICT_BASE_URI`, l'unique base
 * publique que le projet annonce déjà, et reste surchargeable par
 * `--agent-uri` / `ERC8004_AGENT_URI`. Elle n'entre dans aucun hash et rien
 * n'échoue si elle ne résout pas encore ; ce qui échouerait, en revanche, c'est
 * de la changer après coup en croyant que `register` peut être rejoué.
 */
export function defaultAgentUri(agent: Address, verdictBaseUri: string): string {
  const base = verdictBaseUri.replace(/\/v\/?$/, '/').replace(/\/?$/, '/')
  return `${base}agents/${agent.toLowerCase()}.json`
}

// ─────────────────────────────────────────────────────────────────────────────
// Déroulé
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Même repli que `bin/settler.ts` : le script npm charge `../../.env` via
  // `node --env-file-if-exists`, cette boucle couvre le lancement direct.
  for (const candidate of [optional('WARRANT_ENV_FILE', ''), '.env', '../../.env']) {
    if (!candidate) continue
    try {
      process.loadEnvFile(candidate)
      break
    } catch {
      // Absent ou illisible : au suivant, puis l'environnement du process fait foi.
    }
  }

  const dryRun = switchOn('dry-run')
  const force = switchOn('force')

  // ── 1. La chaîne, avant tout le reste ──────────────────────────────────────
  const decision = decideChain(process.env, process.argv)
  if (decision.refusal) throw new Error(decision.refusal)
  const chainId = decision.erc8004ChainId
  const chain = CHAINS[chainId as keyof typeof CHAINS]!

  const rpc = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])
  const publicClient = createPublicClient({ chain, transport: http(rpc) })

  const observedChainId = await publicClient.getChainId()
  if (observedChainId !== chainId) {
    throw new Error(
      `le RPC ${rpc} répond chainId ${observedChainId}, alors que la configuration ` +
        `annonce ${chainId} : le jeton serait frappé sur la mauvaise chaîne, et un ` +
        'agentId frappé ailleurs ne se corrige pas',
    )
  }

  // ── 2. Registres ───────────────────────────────────────────────────────────
  const registries = TESTNET_CHAIN_IDS.has(chainId) ? ERC8004.testnet : ERC8004.mainnet
  const identityRegistry = address(
    'ERC8004_IDENTITY',
    optional('ERC8004_IDENTITY', registries.identity),
  )
  const reputationRegistry = address(
    'ERC8004_REPUTATION',
    optional('ERC8004_REPUTATION', registries.reputation),
  )

  const code = await publicClient.getCode({ address: identityRegistry })
  if (!code || code === '0x') {
    throw new Error(
      `aucun code à ${identityRegistry} sur la chaîne ${chainId} : il n'y a pas ` +
        "d'IdentityRegistry ERC-8004 à cette adresse",
    )
  }

  /**
   * Le `ReputationRegistry` porte l'adresse du registre d'identités qu'il
   * consulte, et c'est **lui** qui décidera si le Settler peut noter. Enregistrer
   * dans un autre registre que celui-là donnerait un `agentId` que
   * `giveFeedback` lirait ailleurs : `ownerOf` révèrterait, et la transaction
   * échouerait sans que rien, dans notre table, n'ait l'air faux.
   */
  const boundIdentity = (
    (await publicClient.readContract({
      address: reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: 'getIdentityRegistry',
    })) as string
  ).toLowerCase()
  if (boundIdentity !== identityRegistry) {
    throw new Error(
      `le ReputationRegistry ${reputationRegistry} consulte l'IdentityRegistry ` +
        `${boundIdentity}, pas ${identityRegistry} : un agentId frappé ici ne serait ` +
        'pas celui que giveFeedback vérifierait',
    )
  }

  // ── 3. L'agent et le Settler ───────────────────────────────────────────────
  /**
   * `OPENER_PRIVATE_KEY` est la clé de l'agent.
   *
   * Le nom vient d'une topologie antérieure où elle signait `open()` ; depuis que
   * le rôle `opener` est le wallet KeeperHub, son seul emploi est de signer ce
   * qui appartient à l'agent — l'autorisation EIP-3009 dans `open-warrant.ts`,
   * et ici son propre enregistrement. Aucune autre clé du dépôt ne peut le faire
   * à sa place : le owner du NFT sera `msg.sender`.
   */
  const agentAccount = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as Hex)
  const agent = agentAccount.address.toLowerCase() as Address
  const escrow = address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS'))

  /**
   * Le Settler est lu **sur l'escrow**, pas dérivé de `SETTLER_PRIVATE_KEY`.
   *
   * Deux raisons. La première est de principe : un outil qui n'a aucune raison de
   * signer au nom du Settler n'a aucune raison de connaître son secret. La
   * seconde est que `settler()` onchain est la seule adresse qui compte — c'est
   * celle qui pourra appeler `honor`/`slash`, donc celle qui écrira les
   * feedbacks, et `bin/settler.ts` refuse de démarrer si la clé configurée en
   * diverge.
   */
  const settler = (
    (await publicClient.readContract({
      address: escrow,
      abi: warrantEscrowAbi,
      functionName: 'settler',
    })) as string
  ).toLowerCase() as Address

  if (settler === agent) {
    throw new Error(
      `le Settler et l'agent sont la même adresse (${agent}) : giveFeedback ` +
        'reverterait en « Self-feedback not allowed » pour tout verdict, et aucune ' +
        "identité n'y changerait quoi que ce soit (invariant I10)",
    )
  }

  // ── 4. La table ────────────────────────────────────────────────────────────
  const location = agentIdsFilePath(process.env)
  const table = readAgentIds(location.path)
  const known = table[agent]

  log({
    msg: 'register-agent',
    chainId,
    rpc,
    identityRegistry,
    reputationRegistry,
    agent,
    settler,
    escrow,
    agentIdsFile: location.path,
    agentIdsFileSource: location.source,
    knownAgentId: known ?? null,
    dryRun,
    force,
  })

  /**
   * Une entrée déjà présente est confrontée à la chaîne avant toute décision.
   *
   * `inspectAgentIdentity` ne lève jamais et distingue les quatre situations qui
   * comptent — et elles appellent trois conduites différentes :
   *
   *   • `usable`      → il n'y a rien à faire, et frapper un second jeton serait
   *                     du gas dépensé pour rendre le premier orphelin ;
   *   • `absent`      → l'entrée ne désigne rien sur cette chaîne (le cas de
   *                     l'`agentId` 8986 frappé sur Ethereum Sepolia). On
   *                     enregistre et on remplace ;
   *   • `unnotable`   → le jeton existe mais le Settler en est owner ou operator.
   *                     Irréparable sur ce jeton : on en frappe un neuf, dont
   *                     l'agent sera owner ;
   *   • `unavailable` → le RPC n'a pas répondu. On ne conclut rien et on
   *                     n'écrase rien : c'est la même règle que celle du Settler,
   *                     « dans le doute on n'écrit pas ».
   */
  if (known !== undefined) {
    const status = await inspectAgentIdentity(BigInt(known), settler, {
      publicClient: publicClient as never,
      identityRegistry,
    })
    log({ msg: 'identité connue: état onchain', agentId: known, status })

    if (status.status === 'usable' && !force) {
      log({
        msg: 'rien à enregistrer',
        agentId: known,
        detail:
          `l'agentId ${known} existe sur la chaîne ${chainId} et le Settler ${settler} ` +
          'peut le noter. --force frapperait un second jeton, ce qui rendrait le ' +
          'premier orphelin sans rien améliorer.',
      })
      // On revérifie quand même, intégralement : relancer l'outil est le geste
      // naturel pour savoir si l'inscription est en état de marche, et une
      // réponse « rien à faire » sans preuve ne vaut rien.
      await assertNotable(publicClient, {
        agentId: BigInt(known),
        agent,
        settler,
        identityRegistry,
        chainId,
        location,
      })
      return
    }
    if (status.status === 'unavailable' && !force) {
      throw new Error(
        `l'état de l'agentId ${known} n'a pas pu être établi (${status.reason}) : on ` +
          "n'écrase pas une entrée existante sur une lecture non concluante. " +
          'Réessayer quand le RPC répond, ou forcer avec --force.',
      )
    }
  }

  // ── 5. La transaction, préparée par `reputation.ts` ────────────────────────
  const verdictBaseUri = optional('VERDICT_BASE_URI', 'https://warrant.sh/v/')
  const agentUri = arg('agent-uri', optional('ERC8004_AGENT_URI', defaultAgentUri(agent, verdictBaseUri)))
  /**
   * `since` vient du timestamp du dernier bloc, pas de l'horloge locale : la
   * métadonnée doit être comparable à ce que lit un tiers depuis la chaîne, et
   * une horloge de machine décalée produirait une date antérieure à
   * l'enregistrement lui-même.
   */
  const since = Number((await publicClient.getBlock({ blockTag: 'latest' })).timestamp)

  const registration = buildAgentRegistration({
    identityRegistry,
    agentURI: agentUri,
    escrow,
    since,
  })
  log({
    msg: 'transaction préparée',
    to: registration.to,
    value: registration.value,
    agentURI: agentUri,
    metadata: [METADATA_KEYS.escrow, METADATA_KEYS.since],
    since,
    calldataBytes: (registration.data.length - 2) / 2,
    note: registration.note,
  })

  /**
   * Simulation avant envoi, sur **les octets exacts** qui partiront.
   *
   * `eth_call` sur le calldata construit, et non `simulateContract` sur des
   * arguments reconstruits : ce qui est éprouvé doit être ce qui est signé. La
   * valeur de retour donne l'`agentId` prévu — utile à afficher, mais jamais
   * retenue comme vérité : le compteur peut avancer entre la simulation et
   * l'inclusion. Ce que la simulation garantit, c'est qu'on ne paie pas du gas
   * pour un revert.
   */
  const simulated = await publicClient.call({
    account: agent,
    to: registration.to,
    data: registration.data,
    value: registration.value,
  })
  const predicted = simulated.data
    ? (decodeFunctionResult({
        abi: identityRegistryAbi,
        functionName: 'register',
        data: simulated.data,
      }) as bigint)
    : undefined

  const gas = await publicClient.estimateGas({
    account: agent,
    to: registration.to,
    data: registration.data,
    value: registration.value,
  })
  const gasPrice = await publicClient.getGasPrice()
  const balance = await publicClient.getBalance({ address: agent })
  log({
    msg: 'simulation',
    predictedAgentId: predicted ?? null,
    gas,
    gasPriceWei: gasPrice,
    costWei: gas * gasPrice,
    agentBalanceWei: balance,
  })
  if (balance < gas * gasPrice) {
    throw new Error(
      `l'agent ${agent} a ${balance} wei et l'enregistrement coûte ${gas * gasPrice} wei : ` +
        'la transaction ne partirait pas. `pnpm faucet` approvisionne Base Sepolia ' +
        '(plafonné à 24 h).',
    )
  }

  if (dryRun) {
    log({
      msg: '--dry-run : rien envoyé',
      to: registration.to,
      data: registration.data,
      value: registration.value,
      predictedAgentId: predicted ?? null,
    })
    return
  }

  // ── 6. L'envoi, signé par l'agent ─────────────────────────────────────────
  const wallet = createWalletClient({ account: agentAccount, chain, transport: http(rpc) })
  const txHash = await wallet.sendTransaction({
    to: registration.to,
    data: registration.data,
    value: registration.value,
  })
  log({ msg: 'enregistrement envoyé', txHash })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 })
  if (receipt.status !== 'success') {
    throw new Error(
      `la transaction d'enregistrement ${txHash} a échoué (status=${receipt.status}) : ` +
        'aucun agentId frappé, la table est laissée intacte',
    )
  }

  const agentId = agentIdFromLogs(receipt.logs as never, identityRegistry)
  log({
    msg: 'agentId frappé',
    agentId,
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    ...(predicted !== undefined && predicted !== agentId
      ? {
          warning:
            `la simulation prévoyait ${predicted} : une autre inscription a été ` +
            "incluse entre-temps. C'est le reçu qui fait foi.",
        }
      : {}),
  })

  // ── 7. La table, écrite avant la vérification ────────────────────────────
  //    L'ordre est délibéré : le jeton est frappé, il ne se dé-frappe pas. Perdre
  //    l'`agentId` parce qu'une vérification de lecture a échoué juste après
  //    obligerait à balayer les logs pour le retrouver.
  const updated = upsertAgentId(table, agent, agentId)
  writeAgentIds(location.path, updated)
  log({
    msg: 'table écrite',
    path: location.path,
    entries: Object.keys(updated).length,
    ...(known !== undefined && known !== agentId.toString(10) ? { replaced: known } : {}),
  })

  // ── 8. La vérification qui décide de tout ─────────────────────────────────
  await assertNotable(publicClient, {
    agentId,
    agent,
    settler,
    identityRegistry,
    chainId,
    location,
    /**
     * Le nœud doit d'abord voir le bloc du reçu.
     *
     * `waitForTransactionReceipt` a rendu, donc **un** nœud avait la
     * transaction ; rien ne garantit que le suivant l'ait, un RPC public étant
     * un répartiteur devant des nœuds inégalement à jour. Sans cette attente,
     * `ownerOf` révèrte en `ERC721NonexistentToken` sur un jeton qui existe
     * pourtant — c'est exactement ce qui s'est produit au premier
     * enregistrement réel, quelques secondes après l'inclusion au bloc
     * 44805365.
     */
    minBlock: receipt.blockNumber,
  })
}

/**
 * Vérifie qu'un `agentId` est **notable** par le Settler, et lève sinon.
 *
 * C'est la seule chose qui distingue une identité utilisable d'une identité qui
 * fera révèrter chaque `giveFeedback` : `ReputationRegistry` exige
 * `!isAuthorizedOrOwner(msg.sender, agentId)`. On lit donc ce prédicat **tel
 * quel**, sur la chaîne, plutôt que de se contenter d'un raisonnement — « le
 * owner est l'agent, donc le Settler ne l'est pas » serait vrai pour `ownerOf` et
 * muet sur `approve` et `setApprovalForAll`. `inspectAgentIdentity` couvre
 * ensuite les trois branches d'un coup et rend un état lisible, y compris quand
 * la lecture directe n'est pas concluante.
 *
 * Appelée aux deux endroits qui en ont besoin : après un enregistrement, et
 * quand l'outil est relancé sur une identité déjà connue.
 */
async function assertNotable(
  publicClient: {
    readContract(args: never): Promise<unknown>
    getBlockNumber(): Promise<bigint>
  },
  opts: {
    agentId: bigint
    agent: Address
    settler: Address
    identityRegistry: Address
    chainId: number
    location: AgentIdsFileLocation
    minBlock?: bigint
  },
): Promise<void> {
  const { agentId, agent, settler, identityRegistry } = opts

  if (opts.minBlock !== undefined) await awaitBlock(publicClient, opts.minBlock)

  /**
   * Les deux lectures qui décident sont réessayées.
   *
   * Elles révèrtent toutes deux en `ERC721NonexistentToken` sur un nœud en
   * retard, et un revert est indistinguable d'un vrai « ce jeton n'existe pas ».
   * Un échec de lecture ne doit pas se conclure en « identité inutilisable »
   * alors que le jeton vient d'être frappé.
   */
  const owner = (
    (await retry('ownerOf', () =>
      publicClient.readContract({
        address: identityRegistry,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [agentId],
      } as never),
    )) as string
  ).toLowerCase()

  const authorized = (await retry('isAuthorizedOrOwner', () =>
    publicClient.readContract({
      address: identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'isAuthorizedOrOwner',
      args: [settler, agentId],
    } as never),
  )) as boolean

  const status = await inspectAgentIdentity(agentId, settler, {
    publicClient: publicClient as never,
    identityRegistry,
  })

  log({
    msg: 'vérification onchain',
    agentId,
    ownerOf: owner,
    ownerIsAgent: owner === agent,
    'isAuthorizedOrOwner(settler, agentId)': authorized,
    identityStatus: status.status,
    metadata: {
      [METADATA_KEYS.escrow]: await readMetadata(
        publicClient,
        identityRegistry,
        agentId,
        METADATA_KEYS.escrow,
      ),
      [METADATA_KEYS.since]: await readMetadata(
        publicClient,
        identityRegistry,
        agentId,
        METADATA_KEYS.since,
      ),
    },
  })

  const failures: string[] = []
  if (owner !== agent) {
    failures.push(
      `ownerOf(${agentId}) = ${owner}, attendu l'agent ${agent} : le NFT a été frappé ` +
        "au profit de quelqu'un d'autre",
    )
  }
  if (authorized) {
    failures.push(
      `isAuthorizedOrOwner(${settler}, ${agentId}) = true : giveFeedback reverterait ` +
        'en « Self-feedback not allowed » à chaque verdict. Le Settler doit être une ' +
        'adresse tierce, ni owner, ni operator, ni approuvée sur le jeton.',
    )
  }
  if (status.status !== 'usable') {
    failures.push(
      `inspectAgentIdentity rend '${status.status}' : ${'reason' in status ? status.reason : ''}`,
    )
  }

  if (failures.length > 0) {
    throw new Error(
      `l'agentId ${agentId} est frappé et inscrit dans la table, mais il n'est PAS ` +
        `notable :\n  - ${failures.join('\n  - ')}`,
    )
  }

  log({
    msg: 'identité utilisable',
    agentId,
    detail:
      `le Settler ${settler} peut inscrire des verdicts pour l'agentId ${agentId} sur ` +
      `la chaîne ${opts.chainId}`,
    ...(opts.location.source === 'ERC8004_AGENT_IDS_FILE'
      ? {}
      : {
          envLine: envLineFor(opts.location.path),
          envHint:
            'bin/settler.ts ne lit la table QUE si ERC8004_AGENT_IDS_FILE est ' +
            'définie : sans cette ligne, aucun agentId ne sera résolu et ' +
            "l'inscription restera sautée à chaque mandat.",
        }),
  })
}

/** Attend que le nœud interrogé annonce au moins ce bloc. Jamais bloquant à l'infini. */
async function awaitBlock(
  client: { getBlockNumber(): Promise<bigint> },
  target: bigint,
  attempts = 20,
  delayMs = 1_000,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await client.getBlockNumber()) >= target) return
    } catch {
      // Un nœud muet est traité comme un nœud en retard : on réessaie.
    }
    await sleep(delayMs)
  }
  // On n'échoue pas ici : les lectures qui suivent ont leur propre retry, et
  // c'est leur résultat — pas la hauteur annoncée — qui compte.
  log({
    msg: 'avertissement: le RPC annonce toujours un bloc antérieur',
    target: target.toString(10),
    detail:
      "les vérifications qui suivent peuvent échouer alors que l'enregistrement " +
      'est correct ; relancer la commande les rejouera sans rien frapper',
  })
}

/** Réessaie une lecture. Le dernier échec est propagé tel quel. */
async function retry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 5,
  delayMs = 1_500,
): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (i + 1 < attempts) {
        log({ msg: `lecture ${label} en échec, nouvel essai`, attempt: i + 1, of: attempts })
        await sleep(delayMs)
      }
    }
  }
  throw last
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Métadonnée UTF-8, ou `null`. Une clé absente rend `0x`, ce n'est pas une erreur. */
async function readMetadata(
  client: { readContract(args: never): Promise<unknown> },
  identityRegistry: Address,
  agentId: bigint,
  key: string,
): Promise<string | null> {
  try {
    const raw = (await client.readContract({
      address: identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'getMetadata',
      args: [agentId, key],
    } as never)) as Hex
    return raw && raw !== '0x' ? hexToString(raw) : null
  } catch {
    return null
  }
}

/**
 * `main()` ne part que si ce fichier est le point d'entrée : les helpers
 * ci-dessus sont testés, et un `import` depuis un test ne doit pas signer une
 * transaction.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch((e: unknown) => {
    console.error(
      JSON.stringify({
        msg: 'enregistrement impossible',
        error: e instanceof Error ? e.message : String(e),
      }),
    )
    process.exit(1)
  })
}
