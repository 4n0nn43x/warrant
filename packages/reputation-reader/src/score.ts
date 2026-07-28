/**
 * Le score pondéré par le capital — l'apport réel de Warrant à ERC-8004.
 *
 *   stakeWeightedScore(agent) = Σ(bond_honored) / (Σ(bond_honored) + Σ(bond_slashed))
 *   totalAtRisk(agent)        = Σ(bond) sur tous les mandats réglés
 *
 * `getSummary` du registre donne une moyenne de notes : elle traite 200 mandats
 * à 5 $ comme 200 mandats à 250 $. Ce que le registre ne dit pas — **combien un
 * agent a réellement risqué** — se dérive des events de l'escrow, sans faire
 * confiance à Warrant.
 *
 * Ce que ce calcul suppose, dit franchement :
 *
 *   - les **montants** ne supposent rien : ils viennent des events
 *     `WarrantHonored` / `WarrantSlashed` du contrat d'escrow, qui a lui-même
 *     déplacé les fonds ;
 *   - le **rattachement** d'un mandat à un `agentId` vient du `feedbackURI`
 *     inscrit par le Settler. On fait donc confiance au Settler sur le lien, pas
 *     sur les sommes. Ce lien se recoupe indépendamment avec
 *     `WarrantOpened.agent` : voir l'option `agentAddresses`.
 *
 * Tout ce fichier est pur. Aucune E/S, aucun réseau, rien à mocker.
 */

import type {
  Address,
  FeedbackRecord,
  Hex,
  OpeningRecord,
  SettledWarrant,
  SettlementRecord,
  Verdict,
} from './types.js'

import { feedbackKey } from './decode.js'

/** Facteur du point fixe utilisé pour le score exact. */
export const WAD = 10n ** 18n

/** `tag1` sous lequel Warrant inscrit ses verdicts. */
export const WARRANT_TAG1 = 'warrant'

export interface AgentReputation {
  agentId: bigint
  /** Nombre de mandats réglés pris en compte. */
  settledCount: number
  honoredCount: number
  slashedCount: number
  /** Σ des cautions des mandats honorés, en unités atomiques. */
  honoredBond: bigint
  /** Σ des cautions des mandats saisis, en unités atomiques. */
  slashedBond: bigint
  /** Σ des cautions sur tous les mandats réglés. Ce que l'agent a mis en jeu. */
  totalAtRisk: bigint
  /**
   * Le score, en point fixe 1e18. `null` quand aucun mandat n'a été réglé —
   * l'absence de score n'est pas un score de 0.
   */
  stakeWeightedScoreWad: bigint | null
  /** Le même score en flottant, pour l'affichage. `null` dans le même cas. */
  stakeWeightedScore: number | null
  warrants: SettledWarrant[]
}

/**
 * Calcule le score d'un agent depuis ses mandats réglés.
 *
 * Les doublons de `warrantId` sont écartés : un mandat n'est réglé qu'une fois
 * (invariant de l'escrow), et une fenêtre de logs redemandée après réorg peut
 * en rapporter deux copies. Le premier vu gagne.
 *
 * Quand Σ = 0, `stakeWeightedScore` vaut `null` — jamais 0, jamais 1, et
 * surtout aucune division. Un agent sans mandat réglé n'a pas un mauvais score :
 * il n'en a pas.
 */
export function computeAgentReputation(
  agentId: bigint,
  warrants: readonly SettledWarrant[],
): AgentReputation {
  const seen = new Set<string>()
  const kept: SettledWarrant[] = []

  let honoredBond = 0n
  let slashedBond = 0n
  let honoredCount = 0
  let slashedCount = 0

  for (const w of warrants) {
    const id = w.warrantId.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(w)
    if (w.verdict === 'honored') {
      honoredBond += w.bond
      honoredCount += 1
    } else {
      slashedBond += w.bond
      slashedCount += 1
    }
  }

  const totalAtRisk = honoredBond + slashedBond
  const scoreWad = totalAtRisk === 0n ? null : (honoredBond * WAD) / totalAtRisk

  return {
    agentId,
    settledCount: kept.length,
    honoredCount,
    slashedCount,
    honoredBond,
    slashedBond,
    totalAtRisk,
    stakeWeightedScoreWad: scoreWad,
    stakeWeightedScore: scoreWad === null ? null : Number(scoreWad) / Number(WAD),
    warrants: kept,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recoupement feedbacks ↔ règlements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrait les identifiants de mandat d'un `feedbackURI`.
 *
 * Convention Warrant : `https://warrant.sh/v/<warrantId>` pour un mandat isolé.
 * Un lot (`.../v/batch/<feedbackHash>`) ne porte pas ses identifiants dans son
 * URI — il faut alors télécharger le document, ce que fait l'appelant via
 * l'option `warrantIdsOf`.
 */
export function warrantIdsFromFeedbackURI(uri: string): Hex[] {
  const m = /\/v\/(0x[0-9a-fA-F]{64})\s*$/.exec(uri.trim())
  return m?.[1] ? [m[1].toLowerCase() as Hex] : []
}

export interface CrossReferenceOptions {
  agentId: bigint
  feedbacks: readonly FeedbackRecord[]
  settlements: readonly SettlementRecord[]
  /**
   * Adresses clientes retenues. **À renseigner en pratique** : n'importe qui
   * peut inscrire un feedback `tag1='warrant'` pour n'importe quel agent, et
   * sans cette restriction on compterait les mandats d'un Settler inconnu.
   * Vide ou absent = tous les clients, ce qui n'a de sens qu'en exploration.
   */
  clients?: readonly Address[]
  /** Clés `agentId:client:index` révoquées, cf. `decodeRevocations`. */
  revoked?: ReadonlySet<string>
  /** Résolution des identifiants de mandat d'un feedback. Défaut : l'URI. */
  warrantIdsOf?: (feedback: FeedbackRecord) => readonly Hex[]
  /**
   * Ouvertures de mandat, pour recouper l'attribution sans croire le Settler.
   * Combinée à `agentAddresses`, elle écarte tout mandat dont l'agent onchain
   * n'est pas l'un de ceux attendus.
   */
  openings?: readonly OpeningRecord[]
  /** Adresses onchain connues de l'agent. Ignorée sans `openings`. */
  agentAddresses?: readonly Address[]
}

export interface CrossReferenceResult {
  warrants: SettledWarrant[]
  /** Feedbacks dont aucun mandat n'a pu être relié à un règlement onchain. */
  unmatched: FeedbackRecord[]
  /** Le verdict inscrit et le règlement onchain divergent. L'onchain gagne. */
  mismatched: { warrantId: Hex; onchain: Verdict; feedbackTag2: string }[]
  /** Mandats écartés parce que `WarrantOpened.agent` ne correspondait pas. */
  rejectedByOpening: Hex[]
}

/**
 * Croise les `NewFeedback` d'ERC-8004 avec les règlements de `WarrantEscrow`.
 *
 * Le verdict retenu est **celui de l'escrow**, jamais celui du feedback : le
 * premier a déplacé des fonds, le second est une déclaration. Une divergence
 * est signalée plutôt que silencieusement arbitrée.
 */
export function crossReference(opts: CrossReferenceOptions): CrossReferenceResult {
  const bySettlement = new Map<string, SettlementRecord>()
  for (const s of opts.settlements) {
    const id = s.warrantId.toLowerCase()
    if (!bySettlement.has(id)) bySettlement.set(id, s)
  }

  const byOpening = new Map<string, OpeningRecord>()
  for (const o of opts.openings ?? []) {
    const id = o.warrantId.toLowerCase()
    if (!byOpening.has(id)) byOpening.set(id, o)
  }

  const allowedClients =
    opts.clients && opts.clients.length > 0
      ? new Set(opts.clients.map((c) => c.toLowerCase()))
      : undefined
  const allowedAgents =
    opts.agentAddresses && opts.agentAddresses.length > 0
      ? new Set(opts.agentAddresses.map((a) => a.toLowerCase()))
      : undefined

  const idsOf = opts.warrantIdsOf ?? ((f: FeedbackRecord) => warrantIdsFromFeedbackURI(f.feedbackURI))

  const warrants: SettledWarrant[] = []
  const unmatched: FeedbackRecord[] = []
  const mismatched: CrossReferenceResult['mismatched'] = []
  const rejectedByOpening: Hex[] = []
  const seen = new Set<string>()

  for (const f of opts.feedbacks) {
    if (f.agentId !== opts.agentId) continue
    if (f.tag1 !== WARRANT_TAG1) continue
    if (allowedClients && !allowedClients.has(f.clientAddress.toLowerCase())) continue
    if (opts.revoked?.has(feedbackKey(f.agentId, f.clientAddress, f.feedbackIndex))) {
      continue
    }

    let matchedAny = false
    for (const rawId of idsOf(f)) {
      const id = rawId.toLowerCase()
      const settlement = bySettlement.get(id)
      if (!settlement) continue
      matchedAny = true

      if (settlement.verdict !== f.tag2) {
        mismatched.push({
          warrantId: id as Hex,
          onchain: settlement.verdict,
          feedbackTag2: f.tag2,
        })
      }

      if (allowedAgents) {
        const opening = byOpening.get(id)
        if (!opening || !allowedAgents.has(opening.agent.toLowerCase())) {
          rejectedByOpening.push(id as Hex)
          continue
        }
      }

      if (seen.has(id)) continue
      seen.add(id)
      warrants.push({
        warrantId: id as Hex,
        verdict: settlement.verdict,
        bond: settlement.bond,
        blockNumber: settlement.blockNumber,
      })
    }

    if (!matchedAny) unmatched.push(f)
  }

  return { warrants, unmatched, mismatched, rejectedByOpening }
}

/** Recoupement puis calcul, en une passe. Le point d'entrée pur habituel. */
export function reputationFromEvents(
  opts: CrossReferenceOptions,
): AgentReputation & { crossReference: CrossReferenceResult } {
  const xref = crossReference(opts)
  return { ...computeAgentReputation(opts.agentId, xref.warrants), crossReference: xref }
}

/**
 * Formate un score pour l'affichage. `null` devient `'n/a'` : afficher `0.00`
 * pour un agent sans historique le ferait passer pour un agent défaillant.
 */
export function formatScore(score: number | null, digits = 4): string {
  return score === null ? 'n/a' : score.toFixed(digits)
}

/** Formate un montant atomique dans ses unités décimales (USDC : 6). */
export function formatBond(bond: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = bond / base
  const frac = (bond % base).toString().padStart(decimals, '0')
  return decimals === 0 ? whole.toString() : `${whole}.${frac}`
}
