/**
 * Ouverture d'un mandat — par **réutilisation** de `bin/open-warrant.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Pourquoi un sous-processus et non un `import`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `open-warrant.ts` marche déjà : il signe l'autorisation EIP-3009 avec le nonce
 * contraint à `termsHash(...)`, lit le `name` du domaine EIP-712 onchain plutôt
 * que de le supposer, passe par `keeperHubEscrow` — donc par l'opener réel — et
 * écrit la ligne de journal que le Settler attend. Réécrire tout cela dans le
 * runner ne produirait qu'une seconde implémentation à maintenir, et la
 * première divergence se paierait en cautions.
 *
 * L'importer n'est pas possible : c'est un script, son `main()` s'exécute au
 * chargement et il lit `process.argv`. Un `import()` dynamique ne l'exécuterait
 * qu'une fois — le cache de modules ESM ne se rejoue pas — donc un seul mandat
 * par processus. Le rendre importable demanderait d'écrire dans `packages/`, ce
 * que le périmètre interdit et qui serait de toute façon le mauvais découpage :
 * l'outil d'exploitation est très bien tel qu'il est.
 *
 * Le sous-processus n'est donc pas un pis-aller, il apporte trois choses qu'un
 * appel en ligne n'aurait pas :
 *
 *   • **isolation des pannes.** Un `throw` non rattrapé, une fuite de mémoire,
 *     un `process.exit(1)` : le runner l'observe comme un code de sortie et
 *     continue. En intra-processus, la même chose tuerait la campagne.
 *   • **un délai de garde exécutoire.** `executeContractCall` est bloquant côté
 *     API ; un appel qui ne revient jamais bloquerait un worker indéfiniment.
 *     Un sous-processus se tue.
 *   • **la journalisation structurée gratuite.** `open-warrant.ts` émet déjà une
 *     ligne JSON par étape. Le runner les lit sur `stdout` et n'a besoin
 *     d'aucune valeur de retour.
 *
 * Le prix assumé : ≈ 300 ms de démarrage de Node et une relecture du registre
 * par mandat, négligeables devant les ≈ 46 s que KeeperHub met à répondre.
 */

import { spawn } from 'node:child_process'
import type { Hex } from '@warrant/core'
import type { Scenario } from './ledger.js'

export interface OpenerConfig {
  /** Racine du monorepo. `cwd` de l'enfant, pour qu'il trouve `.env` et `tsx`. */
  repoRoot: string
  /** Chemin de `open-warrant.ts`. Explicite : il ne se devine pas. */
  script: string
  bond: bigint
  /**
   * Montant transféré par l'action, en unités atomiques.
   *
   * **1 unité, soit 0,000001 USDC**, et ce n'est pas de la timidité. Ce montant
   * sort du wallet d'exécution KeeperHub à chaque mandat, et il n'y revient
   * jamais : la post-condition exige que la destination *engagée* soit créditée.
   * À 1 USDC par mandat — le défaut de `open-warrant.ts` — le wallet
   * d'exécution serait vidé au premier mandat (il détient 0 USDC) et
   * `open-warrant.ts` tenterait un `mint()` qui n'existe pas sur l'USDC Circle :
   * révert, et rien d'ouvert. À 1 unité, 150 mandats coûtent 0,00015 USDC de
   * stock. Le montant ne change rien à la démonstration : ce qui est éprouvé
   * c'est que la post-condition distingue la bonne destination de la mauvaise,
   * pas la taille du transfert.
   */
  amount: bigint
  /**
   * Durée du mandat, en secondes. `MIN_DURATION` vaut 900 : on s'y tient.
   *
   * Une durée longue n'améliore rien et coûte : elle allonge la fenêtre pendant
   * laquelle une caution reste immobilisée si le Settler tombe, donc elle réduit
   * le volume atteignable à capital constant. Le Settler règle en ≈ 30 s ; 900 s
   * laissent trente fois la marge.
   */
  duration: number
  /** Destination **engagée**, celle de l'allowlist de la politique. */
  allowedDest: string
  /** Destination réellement servie dans le scénario détourné. */
  divertedDest: string
  /** Délai de garde. Au-delà, l'enfant est tué. */
  timeoutMs: number
}

export interface OpenerEvent {
  msg?: string
  [k: string]: unknown
}

export interface OpenOutcome {
  scenario: Scenario
  ok: boolean
  warrantId?: Hex
  openTx?: Hex
  openedAt?: number
  executionId?: string
  actionTx?: Hex
  /** L'enfant a-t-il écrit la ligne de journal ? Décisif — voir plus bas. */
  journalWritten: boolean
  durationMs: number
  exitCode: number | null
  signal: string | null
  error?: string
  /** Les dernières lignes émises, pour diagnostic en cas d'échec seulement. */
  tail: OpenerEvent[]
}

/**
 * Ouvre un mandat et rend ce que l'enfant a réussi à faire.
 *
 * Ne lève pas sur un échec d'ouverture : un runner qui remonte une exception par
 * mandat raté s'arrêterait au premier 429 de KeeperHub. L'échec est une valeur.
 *
 * Le cas qui compte vraiment est le **partiel** : `openTx` présent et
 * `journalWritten` faux. Le mandat existe alors onchain, la caution est
 * encaissée, et le Settler n'a pas la `ConditionSpec` pour l'évaluer — il
 * refusera de juger et la caution attendra `reclaim()` à l'expiration. Ce n'est
 * pas une perte de principal, mais c'est du capital gelé 900 s et un mandat qui
 * ne comptera ni comme honoré ni comme saisi. L'appelant doit le voir.
 */
export async function openWarrant(cfg: OpenerConfig, scenario: Scenario): Promise<OpenOutcome> {
  const started = Date.now()
  const args = [
    '--import',
    'tsx',
    cfg.script,
    '--scenario',
    scenario,
    '--bond',
    cfg.bond.toString(10),
    '--amount',
    cfg.amount.toString(10),
    '--duration',
    String(cfg.duration),
  ]

  const child = spawn(process.execPath, args, {
    cwd: cfg.repoRoot,
    env: {
      ...process.env,
      // Ces deux-là ne sont **pas** dans `.env` et n'ont pas à y être : elles
      // décrivent la mise en scène du runner, pas le déploiement. Les passer
      // par l'environnement de l'enfant évite d'exiger une édition de `.env`
      // pour lancer une campagne. Node ne réécrit pas une variable déjà définie
      // quand il charge un fichier d'environnement, donc `process.loadEnvFile`
      // côté enfant ne les écrasera pas.
      DEMO_ALLOWED_DEST: cfg.allowedDest,
      DEMO_DIVERTED_DEST: cfg.divertedDest,
      // L'ouverture doit passer par le wallet KeeperHub, sans quoi `open()`
      // révèrte en `NotOpener()` — et surtout le gas ne serait plus sponsorisé,
      // ce qui déplacerait la borne du volume de l'USDC vers l'ETH de l'agent,
      // dont il a 0,00019.
      WARRANT_ESCROW_PORT: 'keeperhub',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const events: OpenerEvent[] = []
  const out = { warrantId: undefined as Hex | undefined, openTx: undefined as Hex | undefined }
  let openedAt: number | undefined
  let executionId: string | undefined
  let actionTx: Hex | undefined
  let journalWritten = false
  let stderr = ''

  // Découpage sur `\n` et jamais sur un chunk : `stdout` d'un enfant arrive
  // fragmenté, et un `JSON.parse` sur une demi-ligne perdrait l'événement le
  // plus important — celui qui porte `openTx`.
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (line === '') continue
      let ev: OpenerEvent
      try {
        ev = JSON.parse(line) as OpenerEvent
      } catch {
        events.push({ msg: 'ligne non-JSON', raw: line.slice(0, 300) })
        continue
      }
      events.push(ev)
      switch (ev['msg']) {
        case 'mandat préparé':
          out.warrantId = ev['warrantId'] as Hex
          break
        case 'mandat ouvert':
          out.openTx = ev['openTx'] as Hex
          openedAt = Number(ev['openedAt'])
          break
        case 'action exécutée':
          executionId = ev['executionId'] as string
          actionTx = ev['txHash'] as Hex | undefined
          break
        case 'journal écrit':
          journalWritten = true
          break
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const timer = setTimeout(() => {
    // SIGTERM d'abord : `open-warrant.ts` n'installe pas de gestionnaire, donc
    // c'est un arrêt net. `SIGKILL` en dernier recours, après 5 s, pour le cas
    // où l'enfant serait bloqué dans un appel système.
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
  }, cfg.timeoutMs)

  const [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    child.once('error', (e) => resolve([null, `spawn: ${e.message}`]))
    child.once('close', (code, sig) => resolve([code, sig]))
  })
  clearTimeout(timer)

  const ok = exitCode === 0 && journalWritten && !!out.openTx
  return {
    scenario,
    ok,
    ...(out.warrantId ? { warrantId: out.warrantId } : {}),
    ...(out.openTx ? { openTx: out.openTx } : {}),
    ...(openedAt !== undefined ? { openedAt } : {}),
    ...(executionId ? { executionId } : {}),
    ...(actionTx ? { actionTx } : {}),
    journalWritten,
    durationMs: Date.now() - started,
    exitCode,
    signal,
    ...(ok
      ? {}
      : {
          error:
            stderr.trim().split('\n').slice(-3).join(' | ') ||
            (signal ? `tué par ${signal}` : `code de sortie ${exitCode}`),
        }),
    // On ne remonte la trace qu'en cas d'échec : en régime normal, 150 mandats
    // × 7 événements noieraient le journal du runner.
    tail: ok ? [] : events.slice(-6),
  }
}

/**
 * Seau à jetons — le respect du débit KeeperHub, en une classe.
 *
 * Pourquoi un seau et non un simple délai fixe entre lancements : le coût d'un
 * mandat en requêtes n'est pas constant (5 en nominal, jusqu'à 11 si
 * `resolveTransaction` épuise ses tentatives), et le Settler consomme le même
 * quota en parallèle sans se coordonner. Un délai fixe calibré sur le nominal
 * dépasserait la limite dès qu'un mandat retente ; calibré sur le pire cas, il
 * gaspillerait la moitié du débit. Le seau, lui, ne réserve que ce qu'il faut et
 * laisse le débit remonter dès que la charge redescend.
 *
 * Le remplissage est **continu et non par fenêtre** : une limite de 60 req/min
 * appliquée par fenêtre glissante autorise 60 requêtes en une seconde, et c'est
 * précisément la rafale qui déclenche le 429.
 */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    /** Capacité, en requêtes. Égale au débit par minute : une minute de réserve. */
    readonly capacity: number,
    /** Débit de remplissage, en requêtes par minute. */
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity
    this.last = now()
  }

  private refill(): void {
    const t = this.now()
    const gained = ((t - this.last) / 60_000) * this.perMinute
    if (gained <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + gained)
    this.last = t
  }

  /** Jetons disponibles, arrondis vers le bas. Diagnostic. */
  available(): number {
    this.refill()
    return Math.floor(this.tokens)
  }

  /** Attend d'avoir `cost` jetons, puis les consomme. */
  async take(cost: number): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= cost) {
        this.tokens -= cost
        return
      }
      const missing = cost - this.tokens
      const waitMs = Math.max(50, Math.ceil((missing / this.perMinute) * 60_000))
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}
