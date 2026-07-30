/**
 * Le runner de volume.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Ce que c'est, et ce que ce n'est pas
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Le critère le plus pondéré du hackathon est « est-ce que ça s'exécute onchain
 * via KeeperHub ». Un protocole correct avec un seul mandat ne le satisfait pas.
 * Ce processus existe pour transformer une démonstration unitaire en volume :
 * il ouvre des mandats en continu, mélange les scénarios honorés et détournés,
 * et s'arrête proprement quand un budget nommé est atteint.
 *
 * Ce n'est **pas** un service, et il ne réimplémente rien : l'ouverture est
 * déléguée à `packages/server/src/bin/open-warrant.ts` (voir `opener.ts` pour
 * l'argument du sous-processus), le règlement au daemon
 * `packages/server/src/bin/settler.ts`, la persistance au journal JSONL. Le
 * runner n'ajoute que trois choses : un plan, un budget, et un compteur.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * L'observation qui rend la cible atteignable
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * **Le capital se recycle.** Un mandat honoré rend `bond − fee` à l'agent : à
 * `feeBps = 250` et `bond = 0,2 USDC`, un cycle coûte 0,005 USDC. Les 2 USDC de
 * l'agent financent donc ≈ 240 cycles honorés, et non 10 mandats. Ce qui borne
 * le volume, ce n'est pas le capital, c'est le débit — et l'ouverture étant
 * sponsorisée par KeeperHub (tx d'ouverture émise par le relayer `0x6331eb45…`
 * via le forwarder `0x5aF5194B…`), ce n'est pas le gas non plus, sauf celui du
 * règlement.
 *
 * **Une saisie, elle, détruit le capital.** La caution part au bénéficiaire et
 * ne revient jamais. C'est le seul poste qui consomme du principal, et c'est
 * pourquoi il a son propre plafond. Voir `budget.ts` pour les chiffres mesurés
 * et le calcul de débit complet.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Variables d'environnement — à ajouter au `.env`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Aucune n'est obligatoire : les défauts sont calibrés sur les soldes réels du
 * 30/07/2026 après faucet (agent 2,165 USDC / 0,000385 ETH, Settler
 * 0,000365 ETH). Le runner réutilise sinon exactement les variables du Gateway
 * et du Settler.
 *
 *   RUNNER_CAMPAIGN=hackathon           libellé isolant les budgets entre séries
 *   RUNNER_TARGET=150                   mandats visés
 *   RUNNER_SLASH_TARGET=3               saisies visées (le critère en demande ≥ 3)
 *   RUNNER_CONCURRENCY=3                ouvertures simultanées
 *   RUNNER_BACKLOG_CAP=6                mandats ouverts simultanément au plus
 *   RUNNER_BOND=200000                  caution, unités atomiques
 *   RUNNER_AMOUNT=1                     montant transféré par l'action
 *   RUNNER_DURATION=900                 durée du mandat, secondes (= MIN_DURATION)
 *   RUNNER_SLASH_PRINCIPAL_BUDGET=800000  principal destructible par les saisies
 *   RUNNER_FEE_BUDGET=1000000           frais cumulés autorisés sur les honorés
 *   RUNNER_AGENT_RESERVE=50000          USDC intouchable sur l'agent
 *   RUNNER_GAS_FLOOR_WEI=20000000000000 plancher de solde du Settler (0,00002 ETH)
 *   RUNNER_GAS_SPEND_WEI=150000000000000  gas consommable par ce processus
 *   RUNNER_KH_REQ_PER_MIN=60            débit KeeperHub retenu
 *   RUNNER_KH_REQ_PER_MANDATE=11        coût en requêtes, au pire cas
 *   RUNNER_MAX_RUNTIME_MS=5400000       90 min
 *   RUNNER_DRAIN_MS=420000              attente du drainage après le dernier open
 *   RUNNER_COUNTERS_FILE=.warrant/counters.json
 *   RUNNER_ALLOWED_DEST=0x…dEaD         destination engagée
 *   RUNNER_DIVERTED_DEST=0x…DeaDBeef    destination servie dans le détournement
 *   RUNNER_SETTLER=auto                 auto | 1 | 0 — superviser le Settler
 *   RUNNER_OPEN_TIMEOUT_MS=180000       délai de garde d'une ouverture
 *   RUNNER_RECLAIM_INTERVAL_MS=60000    période du balayage des cautions expirées
 *   RUNNER_AGENT_GAS_FLOOR_WEI=5000000000000  plancher d'ETH de l'agent, sous
 *                                       lequel le balayage reclaim() se suspend
 *                                       — un reclaim coûte ≈ 380e9 wei, mesuré
 *   RUNNER_POLL_MS=5000                 période de l'instantané onchain
 *   RUNNER_SETTLER_INTERVAL_MS=8000     SETTLER_INTERVAL_MS imposé à l'enfant
 *
 * Et deux corrections que le runner impose au Settler qu'il supervise, parce que
 * leurs défauts sont faux sur Base Sepolia :
 *
 *   SETTLER_LOG_CHUNK        celui de l'environnement s'il est renseigné, borné à
 *                            2001 — `sepolia.base.org` refuse tout eth_getLogs
 *                            dont `toBlock − fromBlock` dépasse 2000. Le défaut
 *                            de 9000 de `bin/settler.ts` fait échouer **tous**
 *                            les chunks, donc le Settler ne découvre aucun mandat
 *                            et le backlog ne se drainerait jamais.
 *   SETTLER_FROM_BLOCK=…     dérivé du plus ancien mandat encore ouvert. Le
 *                            défaut balaye 60 000 blocs, soit 30 chunks de
 *                            requêtes à chaque tour de boucle pour ne rien
 *                            découvrir de plus.
 *
 * Le runner lit par ailleurs `ERC8004_BATCH_SIZE` sans la modifier : elle ne
 * change aucune décision, mais elle amortit le gas d'inscription ERC-8004 des
 * mandats honorés dans la borne annoncée (voir `budget.ts` § 1).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { WarrantStatus, type Address, type Hex } from '@warrant/core'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createWalletClient, http, type PublicClient } from 'viem'
import {
  ERC20_READ_ABI,
  RECLAIM_ABI,
  VOLUME_ALLOWED_CHAIN_IDS,
  chainOf,
  publicClientFor,
  readEscrowRoles,
  readWarrants,
  usdcBalance,
  type OnchainWarrant,
} from './chain.js'
import {
  GAS_FEEDBACK_WEI,
  GAS_HONOR_WEI,
  GAS_SLASH_WEI,
  decide,
  volumeBound,
  type BudgetCaps,
  type BudgetState,
  type StopCap,
} from './budget.js'
import { address, bigint, eth, flag, integer, optional, required, usdc } from './env.js'
import { TokenBucket, openWarrant, type OpenerConfig } from './opener.js'
import { computeCounters, openLedger, tally, type Ledger, type Scenario } from './ledger.js'

/**
 * Débits mesurés, nommés une fois — les répandre en littéraux dans les calculs
 * garantit qu'une remesure n'en corrige que la moitié.
 *
 * `MANDATES_PER_MINUTE_PER_WORKER` : 60 000 / 17 384 ms, moyenne des 8 mandats de
 * la campagne « borne ». `SETTLER_MANDATES_PER_MINUTE` : le drainage d'une clé
 * unique, voir `budget.ts` § 2 (c).
 */
const MANDATES_PER_MINUTE_PER_WORKER = 3.45
const SETTLER_MANDATES_PER_MINUTE = 6

/** Journal structuré, une ligne JSON par événement. Jamais de secret. */
export function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Y a-t-il déjà un Settler en vie ?
 *
 * On sonde le port du serveur de verdicts, que `bin/settler.ts` ouvre
 * inconditionnellement au démarrage. Ce n'est pas une preuve formelle — un
 * autre processus pourrait tenir ce port — mais c'est le seul indice local et
 * bon marché, et l'erreur qu'il évite est grave : deux Settlers sur la même clé
 * signeraient avec le même nonce, et l'un des deux verrait ses règlements
 * rejetés en `replacement transaction underpriced`. Le doute conduit donc à ne
 * **pas** en lancer un second.
 */
function settlerListening(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolveP) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (answer: boolean) => {
      socket.destroy()
      resolveP(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export interface RunnerConfig {
  campaign: string
  repoRoot: string
  chainId: number
  escrowRpc: string
  escrow: Address
  token: Address
  agent: Address
  /**
   * Le compte de l'agent. Ne sert qu'à `reclaim()` — l'ouverture, elle, signe
   * l'autorisation EIP-3009 dans le sous-processus, avec sa propre copie de la
   * clé lue dans l'environnement. Le runner ne journalise jamais cet objet.
   */
  agentAccount: PrivateKeyAccount
  /** Plancher d'ETH sous lequel le runner cesse de réclamer. */
  agentGasFloorWei: bigint
  settlerKeyAddress: Address
  journalFile: string
  countersFile: string
  caps: BudgetCaps
  opener: OpenerConfig
  concurrency: number
  pollMs: number
  drainMs: number
  khReqPerMin: number
  khReqPerMandate: number
  settlerMode: 'auto' | 'on' | 'off'
  settlerPort: number
  settlerIntervalMs: number
}

export function loadConfig(): RunnerConfig {
  const repoRoot = resolve(
    optional('RUNNER_REPO_ROOT', new URL('../../../', import.meta.url).pathname),
  )
  const chainId = integer('WARRANT_ESCROW_CHAIN_ID', 84532)
  const chain = chainOf(chainId)
  const bond = bigint('RUNNER_BOND', bigint('WARRANT_MIN_BOND', 200_000n))
  const agentAccount = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as Hex)

  return {
    campaign: optional('RUNNER_CAMPAIGN', 'hackathon'),
    repoRoot,
    chainId,
    escrowRpc: optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0]),
    escrow: address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS')),
    token: address('WARRANT_ASSET', required('WARRANT_ASSET')),
    agent: agentAccount.address.toLowerCase() as Address,
    agentAccount,
    agentGasFloorWei: bigint('RUNNER_AGENT_GAS_FLOOR_WEI', 5_000_000_000_000n),
    settlerKeyAddress: privateKeyToAccount(
      required('SETTLER_PRIVATE_KEY') as Hex,
    ).address.toLowerCase() as Address,
    journalFile: optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl'),
    countersFile: optional('RUNNER_COUNTERS_FILE', '.warrant/counters.json'),
    caps: {
      slashPrincipal: bigint('RUNNER_SLASH_PRINCIPAL_BUDGET', 800_000n),
      fees: bigint('RUNNER_FEE_BUDGET', 1_000_000n),
      gasFloorWei: bigint('RUNNER_GAS_FLOOR_WEI', 20_000_000_000_000n),
      gasSpendWei: bigint('RUNNER_GAS_SPEND_WEI', 150_000_000_000_000n),
      agentReserve: bigint('RUNNER_AGENT_RESERVE', 50_000n),
      target: integer('RUNNER_TARGET', 150),
      slashTarget: integer('RUNNER_SLASH_TARGET', 3),
      maxRuntimeMs: integer('RUNNER_MAX_RUNTIME_MS', 90 * 60 * 1000),
      backlogCap: integer('RUNNER_BACKLOG_CAP', 6),
      // Lue et non supposée : c'est la variable que le Settler lira lui aussi,
      // et elle amortit le gas d'inscription ERC-8004 des honorés. Le défaut est
      // celui de `bin/settler.ts`.
      erc8004BatchSize: integer('ERC8004_BATCH_SIZE', 25),
    },
    opener: {
      repoRoot,
      script: resolve(repoRoot, 'packages/server/src/bin/open-warrant.ts'),
      bond,
      amount: bigint('RUNNER_AMOUNT', 1n),
      duration: integer('RUNNER_DURATION', 900),
      allowedDest: optional('RUNNER_ALLOWED_DEST', '0x000000000000000000000000000000000000dEaD'),
      divertedDest: optional('RUNNER_DIVERTED_DEST', '0x00000000000000000000000000000000DeaDBeef'),
      timeoutMs: integer('RUNNER_OPEN_TIMEOUT_MS', 180_000),
    },
    concurrency: integer('RUNNER_CONCURRENCY', 3),
    pollMs: integer('RUNNER_POLL_MS', 5_000),
    drainMs: integer('RUNNER_DRAIN_MS', 7 * 60 * 1000),
    khReqPerMin: integer('RUNNER_KH_REQ_PER_MIN', 60),
    khReqPerMandate: integer('RUNNER_KH_REQ_PER_MANDATE', 11),
    settlerMode: (() => {
      const raw = optional('RUNNER_SETTLER', 'auto').toLowerCase()
      if (raw === 'auto') return 'auto'
      return /^(1|true|yes|on)$/.test(raw) ? 'on' : 'off'
    })(),
    settlerPort: integer('SETTLER_PORT', 8403),
    settlerIntervalMs: integer('RUNNER_SETTLER_INTERVAL_MS', 8_000),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Préflight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce qui fait échouer le démarrage, et pourquoi.
 *
 * Un runner de volume mal configuré ne se plante pas : il dépense. Chacune de
 * ces vérifications correspond à un mode d'échec qui, sans elle, ne se
 * découvrirait qu'après N ouvertures — c'est-à-dire N cautions.
 */
export async function preflight(
  cfg: RunnerConfig,
  client: PublicClient,
  /**
   * Les mandats déjà connus du journal. Servent à une seule chose ici, et elle
   * est décisive : distinguer « l'agent est à sec » de « le capital de l'agent
   * est en vol ». Voir le correctif du contrôle de capital plus bas.
   */
  journalIds: readonly Hex[] = [],
): Promise<{
  feeBps: number
  agentUsdc: bigint
  settlerWei: bigint
  executor: Address
  inherited: { open: number; recoverable: bigint }
}> {
  // Chaîne. La première parce que se tromper de chaîne est la seule erreur
  // irréversible de la liste.
  const observed = await client.getChainId()
  if (observed !== cfg.chainId) {
    throw new Error(
      `le RPC ${cfg.escrowRpc} répond chainId ${observed}, WARRANT_ESCROW_CHAIN_ID annonce ` +
        `${cfg.chainId} : la campagne partirait sur la mauvaise chaîne`,
    )
  }
  if (!VOLUME_ALLOWED_CHAIN_IDS.has(cfg.chainId)) {
    throw new Error(
      `chaîne ${cfg.chainId} refusée : un runner de volume n'ouvre des centaines de mandats ` +
        'sans confirmation humaine que sur un testnet. Chaînes autorisées : ' +
        `${[...VOLUME_ALLOWED_CHAIN_IDS].join(', ')}`,
    )
  }

  const roles = await readEscrowRoles(client, cfg.escrow)

  // `settler()` onchain. Sans elle, `honor`/`slash` reverteraient en
  // `NotSettler()` : le runner ouvrirait 150 mandats dont aucun ne se réglerait,
  // et il faudrait attendre 150 expirations pour récupérer les cautions.
  if (roles.settler !== cfg.settlerKeyAddress) {
    throw new Error(
      `settler() onchain vaut ${roles.settler}, SETTLER_PRIVATE_KEY dérive ` +
        `${cfg.settlerKeyAddress} : rien ne serait jamais réglé`,
    )
  }
  // `opener()` doit être le wallet KeeperHub, sinon `open()` révèrte en
  // `NotOpener()` — et si c'était une clé locale, le gas d'ouverture cesserait
  // d'être sponsorisé, ce qui déplacerait la borne du volume de l'USDC vers
  // l'ETH de l'agent, dont il a 0,00019.
  if (roles.token !== cfg.token) {
    throw new Error(
      `token() onchain vaut ${roles.token}, WARRANT_ASSET annonce ${cfg.token} : ` +
        "l'autorisation EIP-3009 serait signée sur le domaine du mauvais token",
    )
  }

  const [agentUsdc, settlerWei, executorUsdc, assetName] = await Promise.all([
    usdcBalance(client, cfg.token, cfg.agent),
    client.getBalance({ address: cfg.settlerKeyAddress }),
    usdcBalance(client, cfg.token, roles.opener),
    client.readContract({ address: cfg.token, abi: ERC20_READ_ABI, functionName: 'name' }),
  ])

  /**
   * Le capital en vol, lu onchain, avant de refuser de démarrer.
   *
   * ⚠ Même correctif qu'au § « correctif nº 2 » de `budget.ts`, appliqué ici
   * parce que le préflight avait la version dure du même raisonnement — et à un
   * endroit bien pire : il **jetait**. Un runner tué au milieu d'une campagne
   * laisse `backlogCap` cautions immobilisées ; relancé, il trouvait un solde
   * libre sous la caution et refusait de démarrer. Or c'est lui qui lance le
   * Settler, donc rien ne réglait les mandats en vol, donc le capital ne
   * revenait jamais : le préflight se rendait sa propre condition d'échec
   * permanente. L'interblocage était complet et le message d'erreur — « recharger
   * avec pnpm faucet » — désignait un faucet plafonné à 1 USDC / 24 h comme
   * seule issue à une situation qui se dénouait toute seule en trente secondes.
   *
   * Un solde insuffisant reste bloquant, mais seulement quand **rien** n'est en
   * vol. Sinon c'est un avertissement, et la boucle attend (`decide` rend `wait`).
   */
  const inherited = await (async () => {
    if (journalIds.length === 0) return { open: 0, recoverable: 0n }
    const known = await readWarrants(client, cfg.escrow, journalIds)
    let open = 0
    let recoverable = 0n
    for (const w of known.values()) {
      if (w.status !== WarrantStatus.Open || w.agent !== cfg.agent) continue
      open += 1
      // Prudence délibérée : on ne suppose pas le verdict à venir. `bond − fee`
      // est ce qu'un honoré rend, et c'est le plancher de ce qui peut revenir —
      // un `reclaim` rendrait `bond` entier, une saisie ne rendrait rien. Ce
      // champ ne sert qu'à répondre « oui, quelque chose revient », et une
      // sous-estimation y est du bon côté.
      recoverable += w.bond - (w.bond * BigInt(w.feeBpsAtOpen)) / 10_000n
    }
    return { open, recoverable }
  })()

  if (agentUsdc < cfg.opener.bond + cfg.caps.agentReserve) {
    if (inherited.recoverable === 0n) {
      throw new Error(
        `l'agent ${cfg.agent} détient ${usdc(agentUsdc)} USDC : insuffisant pour une caution de ` +
          `${usdc(cfg.opener.bond)} plus ${usdc(cfg.caps.agentReserve)} de réserve, et aucun ` +
          'mandat en vol ne peut rendre de capital. Recharger avec `pnpm faucet` ' +
          '(1 USDC / adresse / 24 h) : c\'est la borne dure du volume.',
      )
    }
    emit({
      msg: 'runner: avertissement — capital de l\'agent momentanément en vol',
      soldeLibre: usdc(agentUsdc),
      requis: usdc(cfg.opener.bond + cfg.caps.agentReserve),
      mandatsEnVol: inherited.open,
      capitalRécupérable: usdc(inherited.recoverable),
      conséquence:
        'le runner démarre, lance le Settler et attend le premier règlement. ' +
        "Refuser de démarrer ici empêcherait le seul processus capable de rendre ce capital.",
    })
  }
  if (settlerWei < cfg.caps.gasFloorWei) {
    throw new Error(
      `le Settler ${cfg.settlerKeyAddress} détient ${eth(settlerWei)} ETH, sous le plancher ` +
        `${eth(cfg.caps.gasFloorWei)} : aucun règlement ne partirait`,
    )
  }
  /**
   * Le stock d'USDC du **wallet d'exécution**, et c'est la vérification la moins
   * évidente de la liste.
   *
   * La post-condition exige que la destination engagée soit créditée de
   * `amount`. Ce montant sort du wallet KeeperHub, qui détenait 0 USDC au
   * 30/07/2026. Sans stock, l'action `transfer` révèrte, la post-condition
   * échoue, et **tous** les mandats — y compris ceux prévus honorés — seraient
   * saisis. Soit 0,2 USDC détruits par mandat au lieu de 0,005 : le capital de
   * l'agent partirait en dix mandats, et le runner aurait sagement respecté tous
   * ses budgets en produisant exactement l'inverse de ce qu'on lui demandait.
   */
  if (executorUsdc < cfg.opener.amount) {
    throw new Error(
      `le wallet d'exécution KeeperHub ${roles.opener} détient ${usdc(executorUsdc)} USDC, ` +
        `il en faut au moins ${usdc(cfg.opener.amount)} pour que l'action honorée aboutisse. ` +
        "Sans stock, l'action révèrte et TOUS les mandats sont saisis — 0,2 USDC détruits " +
        'par mandat. Lui transférer un stock depuis l\'agent avant de lancer la campagne.',
    )
  }
  const affordableMandates = cfg.opener.amount === 0n ? Infinity : executorUsdc / cfg.opener.amount
  if (affordableMandates < BigInt(cfg.caps.target)) {
    emit({
      msg: 'runner: avertissement — stock du wallet d\'exécution juste',
      executor: roles.opener,
      stock: usdc(executorUsdc),
      mandatsFinançables: affordableMandates.toString(10),
      cible: cfg.caps.target,
    })
  }
  if (cfg.opener.duration < 900) {
    throw new Error(
      `RUNNER_DURATION=${cfg.opener.duration} est sous MIN_DURATION (900 s) : ` +
        'open() révèrterait en BadDuration()',
    )
  }
  const minBond = bigint('WARRANT_MIN_BOND', 200_000n)
  const maxBond = bigint('WARRANT_MAX_BOND', 500_000n)
  if (cfg.opener.bond < minBond || cfg.opener.bond > maxBond) {
    throw new Error(
      `RUNNER_BOND=${cfg.opener.bond} hors [${minBond}, ${maxBond}] : la politique locale ` +
        'ramènerait la caution à son plancher et le nonce EIP-3009 ne vaudrait plus ' +
        'termsHash(...) — open() révèrterait en TermsMismatch()',
    )
  }
  if (cfg.concurrency > cfg.caps.backlogCap) {
    throw new Error(
      `RUNNER_CONCURRENCY=${cfg.concurrency} dépasse RUNNER_BACKLOG_CAP=${cfg.caps.backlogCap} : ` +
        'les workers ouvriraient au-delà du plafond de capital immobilisé',
    )
  }

  emit({
    msg: 'runner: préflight',
    chainId: cfg.chainId,
    escrow: cfg.escrow,
    token: cfg.token,
    assetName,
    feeBps: roles.feeBps,
    opener: roles.opener,
    settler: roles.settler,
    treasury: roles.treasury,
    totalLocked: usdc(roles.totalLocked),
    agent: cfg.agent,
    agentUsdc: usdc(agentUsdc),
    settlerEth: eth(settlerWei),
    executorUsdc: usdc(executorUsdc),
    mandatsHéritésEnVol: inherited.open,
    capitalRécupérable: usdc(inherited.recoverable),
  })

  return { feeBps: roles.feeBps, agentUsdc, settlerWei, executor: roles.opener, inherited }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervision du Settler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lance le Settler si — et seulement si — il n'y en a pas déjà un.
 *
 * Le runner pourrait laisser l'exploitant s'en charger. Il ne le fait pas parce
 * qu'un runner sans Settler est un piège : il ouvre à plein débit, rien ne se
 * règle, le capital s'immobilise, et l'arrêt tombe sur
 * `capital-agent-insuffisant` — un message vrai qui désigne la mauvaise cause.
 *
 * `SETTLER_FROM_BLOCK` est calculé et non laissé au défaut : `fromBlock` dérive
 * du plus ancien mandat **encore ouvert**, à 2 s par bloc sur Base, avec 300
 * blocs de marge. Le défaut de 60 000 blocs coûterait 32 requêtes `eth_getLogs`
 * par tour de boucle — sur le quota partagé avec l'ouverture — pour ne rien
 * découvrir de plus.
 */
async function superviseSettler(
  cfg: RunnerConfig,
  client: PublicClient,
  oldestOpenAt: number | undefined,
): Promise<ChildProcess | undefined> {
  if (cfg.settlerMode === 'off') {
    emit({ msg: 'runner: settler non supervisé', raison: 'RUNNER_SETTLER=0' })
    return undefined
  }
  if (cfg.settlerMode === 'auto' && (await settlerListening(cfg.settlerPort))) {
    emit({
      msg: 'runner: settler déjà en vie',
      port: cfg.settlerPort,
      raison: 'un second Settler sur la même clé produirait un conflit de nonce',
    })
    return undefined
  }

  const head = await client.getBlockNumber()
  const ageSeconds = oldestOpenAt ? Math.max(0, Math.floor(Date.now() / 1000) - oldestOpenAt) : 0
  const back = BigInt(Math.ceil(ageSeconds / 2) + 300)
  const fromBlock = head > back ? head - back : 0n

  /**
   * `SETTLER_LOG_CHUNK` : la valeur de l'exploitant si elle existe, bornée.
   *
   * Le runner imposait 1900 en dur. C'était sûr mais faux de deux façons : d'une
   * part il écrasait silencieusement la valeur de `.env` — un exploitant qui
   * corrige un plafond de RPC et voit son réglage ignoré sans un mot cherche
   * longtemps ; d'autre part 1900 laisse 5 % de la fenêtre sur la table. Mesuré
   * sur `sepolia.base.org` : l'erreur est `query exceeds max block range 2000` et
   * elle porte sur `toBlock − fromBlock`, non sur le nombre de blocs — une plage
   * de 2001 blocs passe, 2002 non. Le `viemEscrowReader` calcule
   * `to = cursor + chunk − 1`, donc `chunk = 2001` est la valeur maximale
   * acceptée. On borne à cela, et l'on dit ce qu'on a fait.
   */
  const RPC_MAX_LOG_SPAN = 2001
  const requestedChunk = integer('SETTLER_LOG_CHUNK', RPC_MAX_LOG_SPAN)
  const logChunk = Math.max(1, Math.min(RPC_MAX_LOG_SPAN, requestedChunk))
  if (logChunk !== requestedChunk) {
    emit({
      msg: 'runner: SETTLER_LOG_CHUNK ramené au plafond du RPC',
      demandé: requestedChunk,
      appliqué: logChunk,
      raison:
        'sepolia.base.org refuse eth_getLogs au-delà de 2000 blocs d\'écart ; au-delà, ' +
        'TOUS les chunks échouent et le Settler ne découvre aucun mandat',
    })
  }

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(cfg.repoRoot, 'packages/server/src/bin/settler.ts')],
    {
      cwd: cfg.repoRoot,
      env: {
        ...process.env,
        // Le défaut de 9000 fait échouer *tous* les chunks sur le RPC public de
        // Base Sepolia, qui refuse eth_getLogs au-delà de 2000 blocs d'écart. Le
        // Settler dégrade proprement (« balayage incomplet ») et ne découvre
        // donc **aucun** mandat : le backlog ne se drainerait jamais.
        SETTLER_LOG_CHUNK: String(logChunk),
        SETTLER_FROM_BLOCK: fromBlock.toString(10),
        SETTLER_INTERVAL_MS: String(cfg.settlerIntervalMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  // Les lignes du Settler sont réémises préfixées : un runner qui avale les logs
  // de son enfant rend indiagnosticable le seul processus qui déplace des fonds.
  const forward = (stream: NodeJS.ReadableStream, level: 'out' | 'err') => {
    let pending = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk: string) => {
      pending += chunk
      let nl: number
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).trim()
        pending = pending.slice(nl + 1)
        if (line !== '') console.log(`[settler:${level}] ${line}`)
      }
    })
  }
  forward(child.stdout!, 'out')
  forward(child.stderr!, 'err')
  child.once('exit', (code, signal) =>
    emit({ msg: 'runner: settler terminé', code, signal }),
  )

  emit({
    msg: 'runner: settler lancé',
    pid: child.pid,
    fromBlock: fromBlock.toString(10),
    logChunk,
    intervalMs: cfg.settlerIntervalMs,
  })
  // Le temps qu'il fasse son préflight — chaîne, rôle, sonde d'archive, gas —
  // et ouvre son serveur de verdicts. Ouvrir un mandat avant qu'il soit prêt
  // n'est pas grave (il le découvrira au tour suivant) mais échouer son
  // préflight après 50 ouvertures le serait.
  await sleep(6_000)
  if (child.exitCode !== null) {
    throw new Error(
      `le Settler s'est arrêté immédiatement (code ${child.exitCode}) : ` +
        'son préflight a échoué. Voir les lignes [settler:err] ci-dessus.',
    )
  }
  return child
}

// ─────────────────────────────────────────────────────────────────────────────
// La boucle
// ─────────────────────────────────────────────────────────────────────────────

/** L'état partagé entre workers. Une seule instance, un seul point de vérité. */
interface Shared {
  ledger: Ledger
  client: PublicClient
  cfg: RunnerConfig
  feeBps: number
  startedAt: number
  settlerWeiAtStart: bigint
  /** Dernier instantané onchain, et l'instant de sa lecture. */
  snapshot: {
    at: number
    warrants: Map<string, OnchainWarrant>
    agentUsdc: bigint
    settlerWei: bigint
  }
  /** Ouvertures en cours, par scénario. Réservées avant le spawn. */
  inFlight: { honored: number; diverted: number }
  /** Vrai dès qu'un plafond a été atteint. Les workers sortent. */
  stop?: { cap: StopCap; why: string }
  /** Sérialise la décision : deux workers ne réservent pas la même saisie. */
  gate: Promise<void>
  /**
   * Sérialise l'étiquetage. Verrou **distinct** de `gate`, et c'est délibéré :
   * étiqueter demande une lecture-puis-écriture du journal, mais n'a pas besoin
   * de bloquer les décisions d'ouverture. Les confondre ferait attendre trois
   * workers pendant un `appendFileSync`. Sans verrou du tout, deux workers
   * terminant en même temps liraient le même `nextSeq()` et deux mandats
   * porteraient le rang 7 — un rang dupliqué ne fausse aucun budget (ils sont
   * tous calculés onchain) mais il rend le journal illisible à qui l'audite.
   */
  tagGate: Promise<void>
  bucket: TokenBucket
  /** Compteurs cumulés de la session — ce que le runner a lui-même observé. */
  session: { opened: number; failed: number; orphans: number }
}

/**
 * Rafraîchit l'instantané onchain, au plus une fois par `pollMs`.
 *
 * Le cache n'est pas une optimisation cosmétique : à 3 workers décidant chacun
 * avant chaque ouverture, une lecture systématique ferait 3 multicalls plus 6
 * lectures de solde toutes les 15 s, sur le même RPC public que le Settler
 * utilise pour ses évaluations d'archive. Le rationner protège le composant qui
 * décide des verdicts.
 */
async function refreshSnapshot(s: Shared, force = false): Promise<void> {
  if (!force && Date.now() - s.snapshot.at < s.cfg.pollMs) return
  s.ledger.refresh()
  const ids = s.ledger.all().map((r) => r.id.toLowerCase() as Hex)
  const [warrants, agentUsdc, settlerWei] = await Promise.all([
    readWarrants(s.client, s.cfg.escrow, ids),
    usdcBalance(s.client, s.cfg.token, s.cfg.agent),
    s.client.getBalance({ address: s.cfg.settlerKeyAddress }),
  ])
  s.snapshot = { at: Date.now(), warrants, agentUsdc, settlerWei }
}

/** Projette l'instantané et le journal dans l'état que `decide` attend. */
function budgetState(s: Shared): BudgetState {
  const campaign = s.ledger.campaign()
  const w = s.snapshot.warrants

  let slashed = 0
  let divertedPending = 0
  let destroyed = 0n
  let fees = 0n
  for (const record of campaign) {
    const onchain = w.get(record.id.toLowerCase())
    const status = onchain?.status ?? WarrantStatus.Open
    if (status === WarrantStatus.Slashed) {
      slashed += 1
      destroyed += onchain?.bond ?? s.cfg.opener.bond
    } else if (status === WarrantStatus.Honored && onchain) {
      fees += (onchain.bond * BigInt(onchain.feeBpsAtOpen)) / 10_000n
    }
    // Une saisie « en vol » est un mandat étiqueté `diverted` dont le verdict
    // n'est pas tombé. Le compter est ce qui évite d'en ouvrir quatre pour en
    // obtenir trois — la sur-saisie coûte 0,2 USDC l'unité.
    if (record.runner.scenario === 'diverted' && status === WarrantStatus.Open) {
      divertedPending += 1
    }
  }

  // Le backlog compte **tous** les mandats ouverts, campagne ou non : c'est la
  // charge réelle du Settler et le capital réellement immobilisé.
  const backlog = [...w.values()].filter((x) => x.status === WarrantStatus.Open).length

  /**
   * Le capital que les mandats en vol vont rendre — la donnée qui transforme un
   * arrêt définitif en attente de trente secondes (voir `decide`, correctif nº 2).
   *
   * Trois régimes, et il faut les trois : un mandat étiqueté `diverted` ne rend
   * **rien** (sa caution part au bénéficiaire), un mandat déjà expiré rend `bond`
   * **entier** (`reclaim` ne prélève pas de frais, et le balayeur du runner
   * l'appelle), un mandat honorable rend `bond − fee`. Compter uniformément
   * `bond − fee` surestimerait le retour d'une campagne à forte proportion de
   * saisies, et le runner attendrait un capital qui ne revient pas — c'est-à-dire
   * qu'il remplacerait un faux arrêt par une fausse attente.
   *
   * Seuls les mandats de **notre** agent comptent : le backlog inclut ceux d'un
   * tiers, dont le règlement ne nous rend rien.
   */
  const now = Math.floor(Date.now() / 1000)
  const scenarioOf = new Map(
    campaign.map((r) => [r.id.toLowerCase(), r.runner.scenario] as const),
  )
  let recoverable = 0n
  for (const x of w.values()) {
    if (x.status !== WarrantStatus.Open || x.agent !== s.cfg.agent) continue
    if (scenarioOf.get(x.id) === 'diverted') continue
    recoverable += x.expiry < now ? x.bond : x.bond - (x.bond * BigInt(x.feeBpsAtOpen)) / 10_000n
  }

  return {
    opened: campaign.length + s.inFlight.honored + s.inFlight.diverted,
    slashed,
    divertedInFlight: divertedPending + s.inFlight.diverted,
    destroyed,
    fees,
    backlog: backlog + s.inFlight.honored + s.inFlight.diverted,
    agentUsdc: s.snapshot.agentUsdc,
    recoverable,
    settlerWei: s.snapshot.settlerWei,
    settlerWeiAtStart: s.settlerWeiAtStart,
    elapsedMs: Date.now() - s.startedAt,
    bond: s.cfg.opener.bond,
    feeBps: s.feeBps,
  }
}

/**
 * Réserve un créneau d'ouverture, sous verrou.
 *
 * Le verrou (`s.gate`) n'est pas décoratif : `decide` lit `divertedInFlight`
 * pour savoir combien de saisies sont déjà acquises. Sans sérialisation, trois
 * workers appelant `decide` au même instant liraient tous « 0 saisie » et
 * ouvriraient trois saisies pour en obtenir une — 0,4 USDC détruits par
 * inadvertance, soit 20 % du capital de l'agent.
 */
async function reserve(s: Shared): Promise<{ scenario: Scenario; why: string } | 'wait' | 'stop'> {
  let release!: () => void
  const previous = s.gate
  s.gate = new Promise<void>((r) => (release = r))
  await previous
  try {
    if (s.stop) return 'stop'
    await refreshSnapshot(s)
    const decision = decide(s.cfg.caps, budgetState(s))
    if (decision.kind === 'stop') {
      s.stop = { cap: decision.cap, why: decision.why }
      return 'stop'
    }
    if (decision.kind === 'wait') return 'wait'
    s.inFlight[decision.scenario] += 1
    return { scenario: decision.scenario, why: decision.why }
  } finally {
    release()
  }
}

/**
 * Balaie les mandats expirés et récupère leur caution.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pourquoi ce balayage existe, et pourquoi il appartient au runner
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Le Settler s'abstient quand il ne peut pas juger : action KeeperHub en échec,
 * `ConditionSpec` absente du journal, exécution introuvable. Il émet
 * `kind: 'let-expire'` et passe — c'est le bon comportement, le doute doit
 * bénéficier à l'agent. Mais l'abstention ne rembourse rien par elle-même :
 * `reclaim()` doit être appelé, et **le Settler ne l'appelle jamais** (à dessein :
 * ce n'est pas au juge de rembourser). Personne d'autre ne le fait non plus.
 *
 * Sans ce balayage, chaque mandat abandonné gèle 0,2 USDC définitivement. Sur la
 * campagne mesurée, 8 mandats sur 15 ont vu leur action KeeperHub échouer sous
 * concurrence 4 : c'est 1,6 USDC, soit **les deux tiers du capital de l'agent**,
 * et 320 cycles honorés perdus. Le balayage les rend intégralement — `reclaim`
 * rembourse `bond` sans prélever de frais.
 *
 * Il appartient au runner et non au Settler parce que c'est une opération de
 * *trésorerie de l'agent*, pas de règlement : elle part de la clé de l'agent,
 * elle ne rend aucun verdict, et elle ne touche jamais au bénéficiaire.
 *
 * Séquentiel, et sans négociation : une seule clé, donc un seul nonce. Deux
 * `reclaim` en parallèle sur la même clé produiraient un
 * `replacement transaction underpriced`.
 */
async function reclaimExpired(s: Shared): Promise<{ reclaimed: number; recovered: bigint }> {
  const now = Math.floor(Date.now() / 1000)
  const expired = [...s.snapshot.warrants.values()].filter(
    (w) =>
      w.status === WarrantStatus.Open &&
      w.expiry < now &&
      // Uniquement les cautions de **notre** agent : `reclaim` est
      // permissionless, mais réclamer pour un tiers dépenserait notre gas pour
      // rembourser quelqu'un d'autre.
      w.agent === s.cfg.agent,
  )
  if (expired.length === 0) return { reclaimed: 0, recovered: 0n }

  const gas = await s.client.getBalance({ address: s.cfg.agent })
  if (gas < s.cfg.agentGasFloorWei) {
    emit({
      msg: 'runner: balayage reclaim suspendu',
      raison: `l'agent est à ${eth(gas)} ETH, plancher ${eth(s.cfg.agentGasFloorWei)}`,
      expirés: expired.length,
      gelé: usdc(expired.reduce((acc, w) => acc + w.bond, 0n)),
    })
    return { reclaimed: 0, recovered: 0n }
  }

  const wallet = createWalletClient({
    account: s.cfg.agentAccount,
    chain: chainOf(s.cfg.chainId),
    transport: http(s.cfg.escrowRpc),
  })
  let reclaimed = 0
  let recovered = 0n
  for (const w of expired) {
    try {
      const tx = await wallet.writeContract({
        address: s.cfg.escrow,
        abi: RECLAIM_ABI,
        functionName: 'reclaim',
        args: [w.id],
      })
      await s.client.waitForTransactionReceipt({ hash: tx, confirmations: 1 })
      reclaimed += 1
      recovered += w.bond
      emit({
        msg: 'runner: caution récupérée',
        warrantId: w.id,
        bond: usdc(w.bond),
        reclaimTx: tx,
      })
    } catch (e) {
      // `NotOpen()` signifie que le Settler a réglé entre la lecture et l'envoi
      // — bénin, et fréquent. Toute autre erreur mérite d'être vue.
      emit({
        msg: 'runner: reclaim en échec',
        warrantId: w.id,
        error: e instanceof Error ? e.message.split('\n')[0] : String(e),
      })
    }
  }
  return { reclaimed, recovered }
}

/** Exécute `body` en exclusion mutuelle sur le journal. Voir `Shared.tagGate`. */
async function withTagLock<T>(s: Shared, body: () => T): Promise<T> {
  let release!: () => void
  const previous = s.tagGate
  s.tagGate = new Promise<void>((r) => (release = r))
  await previous
  try {
    return body()
  } finally {
    release()
  }
}

async function worker(s: Shared, slot: number): Promise<void> {
  for (;;) {
    if (s.stop) return
    const slotDecision = await reserve(s)
    if (slotDecision === 'stop') return
    if (slotDecision === 'wait') {
      await sleep(s.cfg.pollMs)
      continue
    }

    // Le débit KeeperHub est réservé **après** la décision et avant le spawn :
    // réserver avant la décision immobiliserait des jetons pour une ouverture
    // qui peut être refusée par le budget.
    await s.bucket.take(s.cfg.khReqPerMandate)

    const { scenario, why } = slotDecision
    emit({ msg: 'runner: ouverture', slot, scenario, raison: why, jetons: s.bucket.available() })
    let outcome
    try {
      outcome = await openWarrant(s.cfg.opener, scenario)
    } finally {
      s.inFlight[scenario] -= 1
    }

    if (outcome.ok && outcome.warrantId) {
      s.session.opened += 1
      const seq = await withTagLock(s, () => {
        const next = s.ledger.nextSeq()
        s.ledger.tag(outcome.warrantId!, {
          campaign: s.cfg.campaign,
          seq: next,
          scenario,
          taggedAt: Date.now(),
        })
        return next
      })
      emit({
        msg: 'runner: mandat ouvert',
        slot,
        seq,
        scenario,
        warrantId: outcome.warrantId,
        openTx: outcome.openTx,
        actionTx: outcome.actionTx,
        executionId: outcome.executionId,
        durationMs: outcome.durationMs,
      })
      await refreshSnapshot(s, true)
      await writeCounters(s)
      continue
    }

    // Échec. Deux cas très différents, et les confondre coûterait cher.
    if (outcome.openTx && !outcome.journalWritten) {
      // Mandat ouvert onchain, caution encaissée, pas de ligne de journal : le
      // Settler ne saura pas quoi évaluer. Ce n'est pas une perte de principal
      // — `reclaim()` remboursera à l'expiration — mais c'est du capital gelé
      // 900 s et un mandat qui ne comptera ni honoré ni saisi.
      s.session.orphans += 1
      emit({
        msg: 'runner: mandat ORPHELIN — ouvert sans ligne de journal',
        slot,
        warrantId: outcome.warrantId,
        openTx: outcome.openTx,
        conséquence:
          "le Settler refusera d'évaluer faute de ConditionSpec ; la caution sera " +
          'remboursée par reclaim() à expiration',
        error: outcome.error,
        tail: outcome.tail,
      })
    } else {
      s.session.failed += 1
      emit({
        msg: 'runner: ouverture en échec',
        slot,
        scenario,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        error: outcome.error,
        tail: outcome.tail,
      })
    }
    // Un échec ne tue pas la campagne, mais il ne doit pas boucler à plein
    // débit : un 429 ou une panne KeeperHub se répéterait à l'identique.
    await sleep(Math.min(30_000, s.cfg.pollMs * 3))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compteur public
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Écrit le compteur public, et l'écrit **atomiquement**.
 *
 * Un dashboard qui interroge ce fichier en boucle finirait sinon par lire un
 * JSON tronqué — `writeFileSync` n'est pas atomique sur un fichier existant.
 * Écrire à côté puis renommer l'est, sur le même système de fichiers.
 */
export async function writeCounters(s: Shared): Promise<void> {
  const counters = await computeCounters({
    ledger: s.ledger,
    client: s.client,
    escrow: s.cfg.escrow,
    chainId: s.cfg.chainId,
    campaign: s.cfg.campaign,
  })
  const enriched = {
    ...counters,
    session: {
      ...s.session,
      startedAt: new Date(s.startedAt).toISOString(),
      elapsedSeconds: Math.round((Date.now() - s.startedAt) / 1000),
      agentUsdc: s.snapshot.agentUsdc.toString(10),
      agentUsdcDecimal: usdc(s.snapshot.agentUsdc),
      settlerWei: s.snapshot.settlerWei.toString(10),
      settlerEth: eth(s.snapshot.settlerWei),
      gasSpentWei: (s.settlerWeiAtStart > s.snapshot.settlerWei
        ? s.settlerWeiAtStart - s.snapshot.settlerWei
        : 0n
      ).toString(10),
    },
    caps: {
      target: s.cfg.caps.target,
      slashTarget: s.cfg.caps.slashTarget,
      slashPrincipal: s.cfg.caps.slashPrincipal.toString(10),
      fees: s.cfg.caps.fees.toString(10),
      backlogCap: s.cfg.caps.backlogCap,
      gasFloorWei: s.cfg.caps.gasFloorWei.toString(10),
    },
    ...(s.stop ? { stop: s.stop } : {}),
  }
  const path = resolve(s.cfg.repoRoot, s.cfg.countersFile)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(enriched, null, 2)}\n`, 'utf8')
  const { renameSync } = await import('node:fs')
  renameSync(tmp, path)
  emit({
    msg: 'runner: compteur',
    campagne: counters.campaignTally,
    total: counters.total,
    fichier: path,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrée
// ─────────────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const cfg = loadConfig()
  const client = publicClientFor(cfg.chainId, cfg.escrowRpc)

  // Le journal est ouvert **avant** le préflight, et ce n'est pas un détail de
  // séquence : le préflight a besoin de savoir ce qui est déjà en vol pour ne pas
  // refuser de démarrer sur un capital qui ne demande qu'à revenir. Voir le
  // contrôle de capital de `preflight`.
  const ledger = openLedger(resolve(cfg.repoRoot, cfg.journalFile), cfg.campaign)
  const journalIds = ledger.all().map((r) => r.id.toLowerCase() as Hex)
  const { feeBps, agentUsdc, settlerWei } = await preflight(cfg, client, journalIds)

  // La reprise. Rien à reconstruire : le journal porte déjà les étiquettes de
  // campagne, donc le rang, donc le nombre de saisies déjà provoquées. Le
  // runner reprend au rang suivant sans rien rouvrir.
  const resumed = ledger.campaign()

  /**
   * L'état déjà acquis de la campagne, lu **onchain**, pour que la borne annoncée
   * soit celle du reste à faire et non celle d'une campagne vierge. Le journal
   * donne la liste des mandats, la chaîne donne leur sort : c'est la même règle
   * de partage qu'ailleurs dans ce fichier.
   */
  const acquired = await (async () => {
    if (resumed.length === 0) return { opened: 0, slashed: 0, destroyed: 0n, fees: 0n }
    const onchain = await readWarrants(
      client,
      cfg.escrow,
      resumed.map((r) => r.id.toLowerCase() as Hex),
    )
    const t = tally(onchain.values())
    return { opened: resumed.length, slashed: t.slashed, destroyed: BigInt(t.destroyed), fees: BigInt(t.fees) }
  })()

  const bound = volumeBound(cfg.caps, {
    agentUsdc,
    bond: cfg.opener.bond,
    feeBps,
    settlerWei,
    ...acquired,
  })
  emit({
    msg: 'runner: démarrage',
    campagne: cfg.campaign,
    reprise: resumed.length,
    rangSuivant: ledger.nextSeq(),
    cible: cfg.caps.target,
    cibleSaisies: cfg.caps.slashTarget,
    concurrence: cfg.concurrency,
    plafondBacklog: cfg.caps.backlogCap,
    caution: usdc(cfg.opener.bond),
    montantAction: usdc(cfg.opener.amount),
    durée: cfg.opener.duration,
    acquis: {
      ouverts: acquired.opened,
      saisis: acquired.slashed,
      principalDétruit: usdc(acquired.destroyed),
      fraisPayés: usdc(acquired.fees),
    },
    // La borne réelle, annoncée avant d'ouvrir quoi que ce soit — et bornée par
    // les quatre contraintes à la fois, `contrainte` nommant celle qui mord.
    borne: {
      mandatsEncoreFinançables: bound.total,
      dontSaisies: bound.slashes,
      dontHonorés: bound.honored,
      contrainte: bound.binding,
      gasUtilisableEth: eth(bound.gasUsableWei),
      règlementsFinançablesParLeGas: bound.settlementsPerGas,
      // 3,45 mandats/min par worker, moyenne des 8 ouvertures de la campagne
      // « borne » (17 384 ms par mandat) et non les 3,7 dérivés des deux mandats
      // de « smoke » — deux mesures ne font pas une moyenne. Plafonné par le
      // débit du Settler : une seule clé, un règlement à la fois, ≈ 6/min.
      // Annoncer 3,45 × C serait annoncer un débit d'ouverture que le drainage ne
      // suit pas — le backlog absorbe la différence jusqu'à son plafond, puis le
      // runner attend.
      débitOuvertureParMinute: Number((MANDATES_PER_MINUTE_PER_WORKER * cfg.concurrency).toFixed(1)),
      débitSoutenuParMinute: Math.min(
        SETTLER_MANDATES_PER_MINUTE,
        Number((MANDATES_PER_MINUTE_PER_WORKER * cfg.concurrency).toFixed(1)),
      ),
      minutesPourÉpuiserLaBorne: Math.ceil(
        bound.total /
          Math.min(
            SETTLER_MANDATES_PER_MINUTE,
            Math.max(0.1, MANDATES_PER_MINUTE_PER_WORKER * cfg.concurrency),
          ),
      ),
    },
  })

  const oldestOpen = (() => {
    const times = resumed.map((r) => r.openedAt).filter((t): t is number => typeof t === 'number')
    return times.length === 0 ? undefined : Math.min(...times)
  })()
  const settlerChild = await superviseSettler(cfg, client, oldestOpen)

  const shared: Shared = {
    ledger,
    client,
    cfg,
    feeBps,
    startedAt: Date.now(),
    settlerWeiAtStart: settlerWei,
    snapshot: { at: 0, warrants: new Map(), agentUsdc, settlerWei },
    inFlight: { honored: 0, diverted: 0 },
    gate: Promise.resolve(),
    tagGate: Promise.resolve(),
    bucket: new TokenBucket(cfg.khReqPerMin, cfg.khReqPerMin),
    session: { opened: 0, failed: 0, orphans: 0 },
  }
  await refreshSnapshot(shared, true)
  await writeCounters(shared)

  let interrupted = false
  const onSignal = (signal: string) => {
    if (interrupted) process.exit(130)
    interrupted = true
    shared.stop = {
      cap: 'durée-maximale',
      why: `interruption par ${signal} — les mandats en vol restent réglables`,
    }
    emit({ msg: 'runner: interruption demandée', signal })
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  /**
   * Le balayeur de cautions expirées — **une seule instance**, et c'est la
   * contrainte qui dicte sa forme.
   *
   * Il ne peut pas vivre dans `worker()` : `reclaim` part de la clé de l'agent,
   * et quatre workers réclamant en parallèle produiraient des transactions au
   * même nonce. Il ne peut pas non plus être dans `Promise.all` avec les workers,
   * puisqu'il doit continuer à tourner pendant le drainage — c'est même là qu'il
   * est le plus utile, quand plus rien ne s'ouvre et que les abandons restent.
   */
  let sweeping = true
  const reclaimIntervalMs = integer('RUNNER_RECLAIM_INTERVAL_MS', 60_000)
  const sweeper = (async () => {
    let totalReclaimed = 0
    let totalRecovered = 0n
    while (sweeping) {
      await sleep(Math.min(reclaimIntervalMs, 10_000))
      if (!sweeping) break
      if (Date.now() - shared.snapshot.at > reclaimIntervalMs) await refreshSnapshot(shared, true)
      const swept = await reclaimExpired(shared)
      totalReclaimed += swept.reclaimed
      totalRecovered += swept.recovered
      if (swept.reclaimed > 0) await refreshSnapshot(shared, true)
    }
    return { totalReclaimed, totalRecovered }
  })()

  await Promise.all(
    Array.from({ length: cfg.concurrency }, (_, slot) => worker(shared, slot)),
  )

  emit({
    msg: 'runner: ouvertures terminées',
    plafond: shared.stop?.cap,
    raison: shared.stop?.why,
    session: shared.session,
  })

  // ── Drainage ───────────────────────────────────────────────────────────────
  //
  // On n'arrête pas le runner sur le dernier `open`. Les mandats en vol ne sont
  // pas encore réglés, et ce sont eux qui portent le chiffre qui compte : un
  // mandat ouvert ne prouve rien, un mandat **réglé** prouve que la
  // post-condition a été évaluée et que la caution a bougé. On attend donc que
  // le backlog se vide, et on continue à publier le compteur pendant ce temps.
  const drainUntil = Date.now() + cfg.drainMs
  for (;;) {
    await refreshSnapshot(shared, true)
    await writeCounters(shared)
    const open = [...shared.snapshot.warrants.values()].filter(
      (w) => w.status === WarrantStatus.Open,
    ).length
    if (open === 0) {
      emit({ msg: 'runner: backlog drainé' })
      break
    }
    if (Date.now() > drainUntil) {
      const now = Math.floor(Date.now() / 1000)
      const past = [...shared.snapshot.warrants.values()].filter(
        (w) => w.status === WarrantStatus.Open && w.expiry < now,
      ).length
      emit({
        msg: 'runner: drainage interrompu',
        ouvertsRestants: open,
        dontExpirés: past,
        raison:
          `RUNNER_DRAIN_MS=${cfg.drainMs} écoulé. Les non-expirés sont encore réglables : ` +
          'laisser le Settler tourner. Les expirés attendent un reclaim() — relancer le ' +
          'runner suffit, son balayeur les récupère.',
      })
      break
    }
    await sleep(Math.max(5_000, cfg.settlerIntervalMs))
  }

  sweeping = false
  const swept = await sweeper

  /**
   * ⚠ Le Settler est arrêté **avant** le relevé final, et non après.
   *
   * Défaut constaté sur la campagne « borne » : le rapport annonçait
   * 0,000004641 ETH de gas consommé, alors que la somme des reçus valait
   * 0,000005446 ETH — 17 % de moins. La cause n'est pas une erreur de calcul mais
   * un ordre : `bin/settler.ts` vide ses lots ERC-8004 en attente sur `SIGTERM`
   * (« les garder en mémoire reviendrait à perdre des verdicts déjà rendus »),
   * donc **une transaction de 806e9 wei part après** le dernier relevé de solde.
   * Un rapport de gas qui exclut systématiquement la dernière écriture de
   * réputation sous-provisionne la campagne suivante, et il le fait d'autant plus
   * que le lot est petit.
   *
   * On lui envoie donc le signal, on attend sa sortie, puis on relit le solde. Le
   * Settler qui tournait déjà survit — ce n'est pas au runner de tuer un processus
   * qu'il n'a pas lancé — et dans ce cas le relevé reste approximatif, ce que le
   * champ `gasSettlerHorsRunner` du rapport dit explicitement.
   */
  if (settlerChild && settlerChild.exitCode === null) {
    settlerChild.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((r) => settlerChild.once('exit', () => r())),
      sleep(20_000),
    ])
  }
  await refreshSnapshot(shared, true)

  const final = await computeCounters({
    ledger,
    client,
    escrow: cfg.escrow,
    chainId: cfg.chainId,
    campaign: cfg.campaign,
  })
  emit({
    msg: 'runner: terminé',
    plafondAtteint: shared.stop?.cap ?? 'aucun',
    raison: shared.stop?.why,
    campagne: final.campaignTally,
    total: final.total,
    cautionsRécupérées: swept.totalReclaimed,
    capitalRécupéré: usdc(swept.totalRecovered),
    gasConsommé: eth(
      shared.settlerWeiAtStart > shared.snapshot.settlerWei
        ? shared.settlerWeiAtStart - shared.snapshot.settlerWei
        : 0n,
    ),
    // Coût **tout compris** par règlement : le gas mesuré sur la clé du Settler
    // divisé par les règlements de la campagne. Inclut donc l'inscription
    // ERC-8004, immédiate sur les saisies et amortie en lot sur les honorés.
    coûtMoyenRèglementWei:
      final.campaignTally.honored + final.campaignTally.slashed > 0
        ? (
            (shared.settlerWeiAtStart - shared.snapshot.settlerWei) /
            BigInt(final.campaignTally.honored + final.campaignTally.slashed)
          ).toString(10)
        : '0',
    provisionRèglementWei: {
      honor: GAS_HONOR_WEI.toString(10),
      slash: GAS_SLASH_WEI.toString(10),
      inscriptionErc8004: GAS_FEEDBACK_WEI.toString(10),
    },
    // Le relevé n'est exact que si le Settler mesuré est celui que le runner a
    // lancé et arrêté : sinon ses lots partent hors de la fenêtre de mesure.
    gasSettlerHorsRunner: settlerChild === undefined,
  })
}

/** Charge `.env` comme le font `bin/settler.ts` et `bin/open-warrant.ts`. */
export function loadEnv(): void {
  for (const candidate of [optional('WARRANT_ENV_FILE', ''), '.env', '../../.env']) {
    if (!candidate) continue
    try {
      process.loadEnvFile(candidate)
      return
    } catch {
      /* suivant */
    }
  }
}

export { flag }
