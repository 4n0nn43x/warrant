/**
 * Le journal comme source de vérité — et le compteur public qui en sort.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pourquoi le runner n'a pas d'état propre
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Un runner de volume doit pouvoir être tué et relancé sans rouvrir ce qu'il a
 * déjà ouvert. La tentation est un fichier d'état à lui — `runner.state.json`,
 * un compteur, une liste d'ids. C'est un second registre à réconcilier avec le
 * premier, et le jour où les deux divergent (SIGKILL entre l'ouverture et
 * l'écriture de l'état), c'est celui qui ment qu'on croira.
 *
 * Le runner n'en a donc aucun. Il **réutilise** `WARRANT_JOURNAL_FILE`, celui
 * qu'`open-warrant.ts` écrit et que le Settler suit, et il y ajoute la seule
 * chose que ce journal ne porte pas encore : sous quel **scénario** un mandat a
 * été ouvert. Le journal est append-only et « la dernière ligne gagne au
 * rechargement » (voir `packages/server/src/journal.ts`) : réécrire un
 * enregistrement enrichi d'un champ `runner` est donc une opération légitime du
 * format, pas un détournement. Le Settler relit la ligne, n'y trouve rien de
 * changé dans les champs qu'il connaît, et continue.
 *
 * Ce que ce champ permet, et qu'aucune lecture onchain ne donnerait :
 *
 *   • **la reprise exacte du plan.** Le scénario n'est pas déductible de la
 *     chaîne ni du journal : `actionSpec.calldata` encode la destination
 *     *engagée*, jamais celle réellement servie. Sans étiquette, un runner
 *     relancé ne saurait pas combien de saisies il a déjà provoquées, et
 *     rouvrirait des saisies à 0,2 USDC pièce — le seul poste qui détruit du
 *     principal ;
 *   • **la séparation entre campagnes.** Les mandats ouverts à la main avant le
 *     runner comptent dans le compteur public (ce sont de vrais mandats) mais
 *     pas dans le budget de la campagne en cours.
 *
 * Et le budget, lui, ne croit jamais l'étiquette : le principal détruit est
 * calculé sur `status == Slashed` **lu onchain**. L'étiquette sert au plan, la
 * chaîne sert à la comptabilité.
 */

import { WarrantStatus, type Address, type Hex } from '@warrant/core'
import type { PublicClient } from 'viem'
import { fileWarrantStore, type WarrantJournal } from '../../../packages/server/src/journal.js'
import type { WarrantRecord } from '../../../packages/server/src/gateway.js'
import { readWarrants, type OnchainWarrant } from './chain.js'

export type Scenario = 'honored' | 'diverted'

/** Étiquette de campagne ajoutée par le runner à un enregistrement du journal. */
export interface RunnerTag {
  /** Libellé de campagne — `RUNNER_CAMPAIGN`. Isole les budgets entre séries. */
  campaign: string
  /** Rang dans la campagne, à partir de 1. Diagnostic, jamais un identifiant. */
  seq: number
  /** Scénario demandé à `open-warrant.ts`. Le seul champ non déductible. */
  scenario: Scenario
  /** Millisecondes epoch. Sert à mesurer le débit réellement obtenu. */
  taggedAt: number
}

export type TaggedRecord = WarrantRecord & { runner?: RunnerTag }

export interface Ledger {
  readonly journal: WarrantJournal
  /** Consomme les lignes ajoutées par les autres processus. */
  refresh(): void
  /** Tous les enregistrements, dernière version gagnante. */
  all(): TaggedRecord[]
  /** Ceux étiquetés de la campagne courante, par rang croissant. */
  campaign(): (TaggedRecord & { runner: RunnerTag })[]
  /** Réécrit un enregistrement enrichi de son étiquette. Idempotent. */
  tag(id: Hex, tag: RunnerTag): void
  /** Prochain rang libre de la campagne. */
  nextSeq(): number
}

export function openLedger(path: string, campaign: string): Ledger {
  const journal = fileWarrantStore({
    path,
    // Une ligne illisible n'interrompt rien, mais elle ne doit pas être
    // silencieuse : c'est un mandat que le Settler ne réglera jamais, donc une
    // caution qui n'attend plus que l'expiration.
    onDefect: (d) =>
      console.warn(
        JSON.stringify({ msg: 'runner: ligne de journal illisible', line: d.line, error: d.error }),
      ),
  })

  const isCampaign = (r: TaggedRecord): r is TaggedRecord & { runner: RunnerTag } =>
    r.runner?.campaign === campaign

  return {
    journal,
    refresh(): void {
      journal.refresh()
    },
    all(): TaggedRecord[] {
      return journal.list() as TaggedRecord[]
    },
    campaign(): (TaggedRecord & { runner: RunnerTag })[] {
      return (journal.list() as TaggedRecord[])
        .filter(isCampaign)
        .sort((a, b) => a.runner.seq - b.runner.seq)
    },
    tag(id: Hex, tag: RunnerTag): void {
      journal.refresh()
      const record = journal.get(id) as TaggedRecord | undefined
      if (!record) {
        // L'enfant a ouvert le mandat mais le journal ne le porte pas : refuser
        // d'inventer une ligne. Un enregistrement fabriqué ici aurait une
        // `conditionSpec` que personne n'a signée, et le Settler recalculerait
        // `conditionHash(spec) != conditionHash onchain` — donc un refus
        // d'évaluer, donc une expiration. Mieux vaut le dire tout de suite.
        throw new Error(
          `mandat ${id} absent du journal ${path} : il a été ouvert onchain mais ` +
            "open-warrant.ts n'a pas écrit sa ligne. Le Settler ne pourra pas " +
            "l'évaluer et la caution attendra reclaim().",
        )
      }
      journal.put({ ...record, runner: tag } as WarrantRecord)
    },
    nextSeq(): number {
      journal.refresh()
      const seqs = (journal.list() as TaggedRecord[])
        .filter(isCampaign)
        .map((r) => r.runner.seq)
      return seqs.length === 0 ? 1 : Math.max(...seqs) + 1
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compteur public
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce que le dashboard et le jury lisent.
 *
 * Clés ASCII et montants en chaînes décimales d'unités atomiques : un compteur
 * consommé par un autre processus ne doit ni dépendre d'un accent ni passer par
 * un `number` — 0,2 USDC vaut 200000, et une caution qui transite en flottant
 * perdrait des unités sans rien signaler. Les mêmes montants sont doublés en
 * représentation décimale `*_usdc` pour l'affichage, et seule celle-là est
 * destinée à être lue par un humain.
 */
export interface Counters {
  campaign: string
  /** ISO 8601, instant de calcul. Un compteur sans date ne se compare pas. */
  at: string
  chainId: number
  escrow: Address
  /** Sur l'ensemble du journal — l'histoire complète du déploiement. */
  total: Tally
  /** Sur les seuls mandats étiquetés de la campagne courante. */
  campaignTally: Tally
  /** Mandats présents au journal mais introuvables onchain. Doit rester à 0. */
  unknown: number
}

export interface Tally {
  /** Mandats existants onchain (statut ≠ None). C'est le volume revendiqué. */
  opened: number
  honored: number
  slashed: number
  reclaimed: number
  /** Encore ouverts : le backlog que le Settler doit drainer. */
  open: number
  /** Σ caution des mandats ouverts — capital immobilisé, récupérable. */
  locked: string
  locked_usdc: string
  /** Σ caution des mandats saisis — capital **détruit**, parti au bénéficiaire. */
  destroyed: string
  destroyed_usdc: string
  /** Σ frais des mandats honorés — le vrai coût du recyclage. */
  fees: string
  fees_usdc: string
  /** Σ `bond − fee` rendu à l'agent sur les honorés. */
  refunded: string
  refunded_usdc: string
  /** saisis / (honorés + saisis), en points de base. Sans réglé : 0. */
  slashRateBps: number
}

function emptyTally(): Tally {
  return {
    opened: 0,
    honored: 0,
    slashed: 0,
    reclaimed: 0,
    open: 0,
    locked: '0',
    locked_usdc: '0.000000',
    destroyed: '0',
    destroyed_usdc: '0.000000',
    fees: '0',
    fees_usdc: '0.000000',
    refunded: '0',
    refunded_usdc: '0.000000',
    slashRateBps: 0,
  }
}

function decimals6(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = (atomic % 1_000_000n).toString(10).padStart(6, '0')
  return `${whole}.${frac}`
}

/**
 * Agrège une liste de mandats lus onchain.
 *
 * `fee` est dérivée de `bond × feeBpsAtOpen / 10000` et non lue dans
 * `WarrantHonored` : les logs de cet escrow ne sont pas interrogeables sur une
 * fenêtre large avec le RPC public de Base Sepolia, qui refuse tout
 * `eth_getLogs` de plus de 2000 blocs. `feeBpsAtOpen` est figée à l'ouverture
 * par le contrat précisément pour que ce calcul soit exact même si le taux
 * change ensuite — le dériver est donc aussi juste que le lire, et ne coûte
 * aucune requête.
 */
export function tally(warrants: Iterable<OnchainWarrant>): Tally {
  const t = emptyTally()
  let locked = 0n
  let destroyed = 0n
  let fees = 0n
  let refunded = 0n
  for (const w of warrants) {
    if (w.status === WarrantStatus.None) continue
    t.opened += 1
    const fee = (w.bond * BigInt(w.feeBpsAtOpen)) / 10_000n
    switch (w.status) {
      case WarrantStatus.Open:
        t.open += 1
        locked += w.bond
        break
      case WarrantStatus.Honored:
        t.honored += 1
        fees += fee
        refunded += w.bond - fee
        break
      case WarrantStatus.Slashed:
        t.slashed += 1
        destroyed += w.bond
        break
      case WarrantStatus.Reclaimed:
        t.reclaimed += 1
        refunded += w.bond
        break
    }
  }
  const settled = t.honored + t.slashed
  t.locked = locked.toString(10)
  t.locked_usdc = decimals6(locked)
  t.destroyed = destroyed.toString(10)
  t.destroyed_usdc = decimals6(destroyed)
  t.fees = fees.toString(10)
  t.fees_usdc = decimals6(fees)
  t.refunded = refunded.toString(10)
  t.refunded_usdc = decimals6(refunded)
  t.slashRateBps = settled === 0 ? 0 : Math.round((t.slashed * 10_000) / settled)
  return t
}

export interface CountersInput {
  ledger: Ledger
  client: PublicClient
  escrow: Address
  chainId: number
  campaign: string
}

/** Recalcule le compteur public : journal pour la liste, chaîne pour le statut. */
export async function computeCounters(input: CountersInput): Promise<Counters> {
  input.ledger.refresh()
  const records = input.ledger.all()
  const ids = records.map((r) => r.id.toLowerCase() as Hex)
  const onchain = await readWarrants(input.client, input.escrow, ids)

  const campaignIds = new Set(
    records
      .filter((r) => r.runner?.campaign === input.campaign)
      .map((r) => r.id.toLowerCase()),
  )

  return {
    campaign: input.campaign,
    at: new Date().toISOString(),
    chainId: input.chainId,
    escrow: input.escrow,
    total: tally(onchain.values()),
    campaignTally: tally([...onchain.values()].filter((w) => campaignIds.has(w.id))),
    unknown: ids.length - onchain.size,
  }
}
