/**
 * Recoupement des compteurs contre la chaîne — le binaire qui a le droit de dire
 * que nos chiffres sont faux.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Pourquoi `counters` ne suffit pas
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `bin/counters.ts` lit le journal pour obtenir une liste d'`id`, puis
 * `getWarrant(id)` pour obtenir leur statut. C'est déjà mieux qu'un compteur de
 * journal — le statut vient de la chaîne — mais la construction garde deux angles
 * morts, et ce sont exactement les deux qu'un jury cherchera :
 *
 *   1. **la liste vient de nous.** Un mandat ouvert onchain et absent du journal
 *      n'est dans aucune liste, donc dans aucun total. Le compteur peut être
 *      parfaitement cohérent *et* sous-déclarer le volume. Pire dans l'autre
 *      sens : rien n'y détecte un mandat que nous revendiquons et qui n'existe
 *      pas — `unknown` le compte, mais personne ne le vérifie ;
 *   2. **les montants sont dérivés.** `fees` vaut `bond × feeBpsAtOpen / 10000`,
 *      calculé par nous, jamais lu. Si le contrat prélevait autre chose que ce
 *      qu'il annonce, le compteur afficherait ce que nous croyons, pas ce qui a
 *      été transféré. La dérivation est juste — `feeBpsAtOpen` est figée à
 *      l'ouverture précisément pour ça — mais « juste par construction » n'est pas
 *      « vérifié ».
 *
 * Ce binaire construit donc un **troisième** compteur, à partir des seuls events
 * de l'escrow, en énumérant les `id` au lieu de les recevoir et en lisant `fee`,
 * `refunded` et `amount` dans les payloads. Puis il croise les trois et n'accorde
 * de valeur qu'à ce qui se recoupe :
 *
 *   journal  ─┐
 *             ├─→ ids ─→ getWarrant  ─→ compteur d'ÉTAT   ─┐
 *   events  ──┴─────────────────────────→ compteur d'EVENTS ┴─→ égalité ou échec
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * Les invariants vérifiés, et ce que chacun attraperait
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   I-A  état ≡ events, champ par champ sur l'intersection des `id`.
 *        Attrape : un décodage de `status` décalé, une dérivation de frais fausse.
 *   I-B  `totalLocked()` == Σ caution des mandats ouverts, selon les events.
 *        Attrape : un mandat ouvert non compté, ou compté deux fois. C'est le
 *        seul invariant qui confronte notre agrégat à un agrégat que **le
 *        contrat** tient lui-même.
 *   I-C  conservation par mandat honoré : `refunded + fee == bond`.
 *        Attrape : une caution partiellement rendue, un prélèvement hors frais.
 *   I-D  conservation par saisie : `amount == bond`.
 *        Attrape : une saisie partielle — le contrat n'en prévoit pas.
 *   I-E  solde USDC de la trésorerie ≥ Σ frais, et == si elle n'a rien dépensé.
 *        Attrape : des frais annoncés qui n'ont jamais atterri. Vérification
 *        externe au contrat : elle passe par le token, pas par l'escrow.
 *   I-F  couverture du journal : tout `id` du journal existe dans les events, et
 *        tout mandat de **notre** agent apparaît au journal.
 *        Attrape : le mandat orphelin (ouvert, non journalisé, donc non réglable)
 *        et le mandat revendiqué qui n'existe pas.
 *
 * Sortie 0 si tout se recoupe, 1 sinon. Un compteur qu'aucun processus ne peut
 * contredire n'est pas un compteur, c'est une affirmation.
 *
 * Usage :
 *   pnpm --filter @warrant/runner verify
 *   pnpm --filter @warrant/runner verify -- --json
 */

import { resolve } from 'node:path'
import type { Address, Hex } from '@warrant/core'
import {
  ERC20_READ_ABI,
  deploymentBlock,
  publicClientFor,
  readEscrowRoles,
  readWarrants,
  scanWarrantEvents,
  usdcBalance,
  type EventWarrant,
} from '../chain.js'
import { address, bigint, integer, optional, required, usdc } from '../env.js'
import { openLedger, tally, type Tally } from '../ledger.js'
import { loadEnv } from '../runner.js'

loadEnv()

/** Un écart constaté. `attendu`/`obtenu` sont toujours des chaînes exactes. */
interface Divergence {
  invariant: string
  sujet: string
  attendu: string
  obtenu: string
  conséquence: string
}

/**
 * Le compteur reconstruit à partir des events seuls.
 *
 * Même forme que `Tally` pour que la comparaison soit champ par champ et non
 * « à peu près la même chose ». Les montants viennent des payloads : `fee` et
 * `refunded` de `WarrantHonored`, `amount` de `WarrantSlashed`, `refunded` de
 * `WarrantReclaimed`. Aucune multiplication par `feeBps` ici — c'est tout
 * l'intérêt.
 */
function tallyFromEvents(warrants: Iterable<EventWarrant>): Tally {
  let opened = 0
  let honored = 0
  let slashed = 0
  let reclaimed = 0
  let open = 0
  let locked = 0n
  let destroyed = 0n
  let fees = 0n
  let refunded = 0n
  for (const w of warrants) {
    opened += 1
    if (w.honored) {
      honored += 1
      fees += w.honored.fee
      refunded += w.honored.refunded
    } else if (w.slashed) {
      slashed += 1
      destroyed += w.slashed.amount
    } else if (w.reclaimed) {
      reclaimed += 1
      refunded += w.reclaimed.refunded
    } else {
      open += 1
      locked += w.bond
    }
  }
  const settled = honored + slashed
  const d6 = (a: bigint) => `${a / 1_000_000n}.${(a % 1_000_000n).toString(10).padStart(6, '0')}`
  return {
    opened,
    honored,
    slashed,
    reclaimed,
    open,
    locked: locked.toString(10),
    locked_usdc: d6(locked),
    destroyed: destroyed.toString(10),
    destroyed_usdc: d6(destroyed),
    fees: fees.toString(10),
    fees_usdc: d6(fees),
    refunded: refunded.toString(10),
    refunded_usdc: d6(refunded),
    slashRateBps: settled === 0 ? 0 : Math.round((slashed * 10_000) / settled),
  }
}

function compareTallies(
  label: string,
  fromState: Tally,
  fromEvents: Tally,
  out: Divergence[],
): void {
  const fields: (keyof Tally)[] = [
    'opened',
    'honored',
    'slashed',
    'reclaimed',
    'open',
    'locked',
    'destroyed',
    'fees',
    'refunded',
    'slashRateBps',
  ]
  for (const f of fields) {
    if (String(fromState[f]) !== String(fromEvents[f])) {
      out.push({
        invariant: 'I-A état ≡ events',
        sujet: `${label}.${f}`,
        attendu: `${String(fromEvents[f])} (events)`,
        obtenu: `${String(fromState[f])} (getWarrant)`,
        conséquence:
          "le compteur publié ne décrit pas ce que la chaîne a émis : il n'a aucune " +
          'valeur probante en l’état',
      })
    }
  }
}

async function main(): Promise<void> {
  const jsonOnly = process.argv.includes('--json')
  const chainId = integer('WARRANT_ESCROW_CHAIN_ID', 84532)
  const escrow = address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS')) as Address
  const token = address('WARRANT_ASSET', required('WARRANT_ASSET')) as Address
  const campaign = optional('RUNNER_CAMPAIGN', 'hackathon')
  const client = publicClientFor(chainId, optional('WARRANT_ESCROW_RPC', 'https://sepolia.base.org'))

  const observed = await client.getChainId()
  if (observed !== chainId) {
    throw new Error(`le RPC répond chainId ${observed}, attendu ${chainId}`)
  }

  const roles = await readEscrowRoles(client, escrow)

  // ── Le balayage, sur toute l'histoire du contrat ──────────────────────────
  const deployed = await deploymentBlock(client, escrow)
  const from = bigint('VERIFY_FROM_BLOCK', deployed.block)
  const scan = await scanWarrantEvents(client, escrow, from, deployed.head)

  // ── Le journal, et les mandats qu'il revendique ───────────────────────────
  const repoRoot = resolve(
    optional('RUNNER_REPO_ROOT', new URL('../../../../', import.meta.url).pathname),
  )
  const ledger = openLedger(
    resolve(repoRoot, optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl')),
    campaign,
  )
  const records = ledger.all()
  const journalIds = records.map((r) => r.id.toLowerCase() as Hex)
  const campaignIds = new Set(
    records.filter((r) => r.runner?.campaign === campaign).map((r) => r.id.toLowerCase()),
  )
  const state = await readWarrants(client, escrow, journalIds)

  const divergences: Divergence[] = []

  // ── I-A : état ≡ events, sur l'intersection ───────────────────────────────
  //
  // L'intersection et non l'union : comparer un total d'events sur *toute*
  // l'histoire à un total d'état sur *les ids du journal* mesurerait la
  // couverture du journal (c'est I-F) et non l'accord des deux lectures.
  const intersection = journalIds.filter((id) => scan.warrants.has(id))
  compareTallies(
    'journal',
    tally(intersection.map((id) => state.get(id)!).filter(Boolean)),
    tallyFromEvents(intersection.map((id) => scan.warrants.get(id)!)),
    divergences,
  )
  const campaignIntersection = intersection.filter((id) => campaignIds.has(id))
  compareTallies(
    `campagne(${campaign})`,
    tally(campaignIntersection.map((id) => state.get(id)!).filter(Boolean)),
    tallyFromEvents(campaignIntersection.map((id) => scan.warrants.get(id)!)),
    divergences,
  )

  // ── I-B : `totalLocked()` == Σ caution des ouverts, selon les events ──────
  const eventsAll = tallyFromEvents(scan.warrants.values())
  if (roles.totalLocked.toString(10) !== eventsAll.locked) {
    divergences.push({
      invariant: 'I-B totalLocked() ≡ Σ bond des ouverts',
      sujet: 'escrow.totalLocked()',
      attendu: `${eventsAll.locked} (Σ bond des ${eventsAll.open} mandats ouverts d'après les events)`,
      obtenu: roles.totalLocked.toString(10),
      conséquence:
        'un mandat ouvert échappe au balayage (fenêtre de blocs trop courte) ou le ' +
        'contrat immobilise du capital qui n’est rattaché à aucun mandat',
    })
  }

  // ── I-C / I-D : conservation, mandat par mandat ───────────────────────────
  for (const w of scan.warrants.values()) {
    if (w.honored && w.honored.refunded + w.honored.fee !== w.bond) {
      divergences.push({
        invariant: 'I-C refunded + fee ≡ bond',
        sujet: w.id,
        attendu: w.bond.toString(10),
        obtenu: `${w.honored.refunded} + ${w.honored.fee}`,
        conséquence: 'de la caution a disparu entre le dépôt et le règlement',
      })
    }
    if (w.slashed && w.slashed.amount !== w.bond) {
      divergences.push({
        invariant: 'I-D amount ≡ bond',
        sujet: w.id,
        attendu: w.bond.toString(10),
        obtenu: w.slashed.amount.toString(10),
        conséquence: 'saisie partielle : le contrat ne devrait pas savoir en produire',
      })
    }
  }
  if (scan.orphanSettlements.length > 0) {
    divergences.push({
      invariant: 'I-B règlements rattachés',
      sujet: `${scan.orphanSettlements.length} règlement(s) sans ouverture`,
      attendu: '0',
      obtenu: scan.orphanSettlements.slice(0, 5).join(', '),
      conséquence:
        `le balayage commence au bloc ${from} et rate l'ouverture de ces mandats : ` +
        'baisser VERIFY_FROM_BLOCK',
    })
  }

  // ── I-E : les frais ont réellement atterri sur la trésorerie ─────────────
  const treasuryUsdc = await usdcBalance(client, token, roles.treasury)
  const feesTotal = BigInt(eventsAll.fees)
  if (treasuryUsdc < feesTotal) {
    divergences.push({
      invariant: 'I-E trésorerie ≥ Σ frais',
      sujet: roles.treasury,
      attendu: `≥ ${feesTotal}`,
      obtenu: treasuryUsdc.toString(10),
      conséquence:
        'des frais comptés dans le compteur n’ont jamais été transférés — le compteur ' +
        'décrit une intention, pas un mouvement de fonds',
    })
  }

  // ── I-F : couverture du journal dans les deux sens ────────────────────────
  const missingFromChain = journalIds.filter((id) => !scan.warrants.has(id))
  if (missingFromChain.length > 0) {
    divergences.push({
      invariant: 'I-F journal ⊆ events',
      sujet: `${missingFromChain.length} mandat(s) revendiqués et introuvables`,
      attendu: '0',
      obtenu: missingFromChain.slice(0, 5).join(', '),
      conséquence:
        'le journal revendique des mandats que la chaîne ne connaît pas : le volume ' +
        'annoncé est surévalué d’autant',
    })
  }
  const ours = new Set(journalIds)
  // Seuls les mandats de **nos** agents nous concernent : l'escrow est public, et
  // un tiers qui y ouvre un mandat n'est pas un défaut de notre comptabilité.
  const ourAgents = new Set(records.map((r) => r.agent.toLowerCase()))
  const agentUnjournaled = [...scan.warrants.values()].filter(
    (w) => !ours.has(w.id) && ourAgents.has(w.agent),
  )
  if (agentUnjournaled.length > 0) {
    divergences.push({
      invariant: 'F-1 mandats de notre agent ⊆ journal',
      sujet: `${agentUnjournaled.length} mandat(s) ouverts hors journal`,
      attendu: '0',
      obtenu: agentUnjournaled
        .slice(0, 5)
        .map((w) => `${w.id}@${w.openedAtBlock}`)
        .join(', '),
      conséquence:
        'ces mandats sont ORPHELINS : le Settler n’a pas leur ConditionSpec, il ' +
        'refusera de juger, et leur caution attend reclaim() à expiration',
    })
  }

  // ── Rapport ───────────────────────────────────────────────────────────────
  const report = {
    at: new Date().toISOString(),
    chainId,
    escrow,
    campaign,
    scan: {
      fromBlock: scan.fromBlock.toString(10),
      toBlock: scan.toBlock.toString(10),
      blocs: (scan.toBlock - scan.fromBlock + 1n).toString(10),
      requêtesGetLogs: scan.requests,
      blocDeDéploiement: deployed.block.toString(10),
      histoireComplète: deployed.complete,
    },
    escrowOnchain: {
      opener: roles.opener,
      settler: roles.settler,
      treasury: roles.treasury,
      feeBps: roles.feeBps,
      totalLocked: roles.totalLocked.toString(10),
      treasuryUsdc: treasuryUsdc.toString(10),
    },
    tousMandatsDeLEscrow_events: eventsAll,
    journal_events: tallyFromEvents(intersection.map((id) => scan.warrants.get(id)!)),
    journal_état: tally(intersection.map((id) => state.get(id)!).filter(Boolean)),
    campagne_events: tallyFromEvents(campaignIntersection.map((id) => scan.warrants.get(id)!)),
    campagne_état: tally(campaignIntersection.map((id) => state.get(id)!).filter(Boolean)),
    journalRecords: records.length,
    mandatsDeNosAgentsHorsJournal: agentUnjournaled.length,
    divergences,
    verdict: divergences.length === 0 ? 'RECOUPÉ' : 'DIVERGENT',
  }

  if (!jsonOnly) {
    const e = report.campagne_events
    const g = report.tousMandatsDeLEscrow_events
    console.error(
      [
        '',
        `WARRANT — recoupement onchain (chainId ${chainId}, escrow ${escrow})`,
        `balayage ${scan.fromBlock}..${scan.toBlock} (${scan.toBlock - scan.fromBlock + 1n} blocs, ` +
          `${scan.requests} requêtes eth_getLogs, déploiement au bloc ${deployed.block})`,
        '',
        `Escrow entier, d'après les EVENTS seuls`,
        `  mandats ouverts ............. ${g.opened}`,
        `  honorés ..................... ${g.honored}`,
        `  saisis ...................... ${g.slashed}`,
        `  réclamés .................... ${g.reclaimed}`,
        `  encore ouverts .............. ${g.open}`,
        `  capital immobilisé .......... ${g.locked_usdc} USDC  (totalLocked() = ${usdc(roles.totalLocked)})`,
        `  capital détruit ............. ${g.destroyed_usdc} USDC`,
        `  frais prélevés .............. ${g.fees_usdc} USDC  (trésorerie = ${usdc(treasuryUsdc)})`,
        `  capital rendu à l'agent ..... ${g.refunded_usdc} USDC`,
        '',
        `Campagne « ${campaign} », d'après les EVENTS`,
        `  ouverts ${e.opened} · honorés ${e.honored} · saisis ${e.slashed} · ` +
          `réclamés ${e.reclaimed} · ouverts ${e.open}`,
        `  détruit ${e.destroyed_usdc} · frais ${e.fees_usdc} · rendu ${e.refunded_usdc} USDC`,
        '',
        divergences.length === 0
          ? '✓ RECOUPÉ — état, events, journal et agrégats du contrat concordent (I-A…I-F)'
          : `✗ DIVERGENT — ${divergences.length} écart(s) :`,
        ...divergences.map(
          (d) => `    [${d.invariant}] ${d.sujet}\n      attendu ${d.attendu}\n      obtenu  ${d.obtenu}\n      → ${d.conséquence}`,
        ),
        '',
      ].join('\n'),
    )
  }
  console.log(JSON.stringify(report, null, 2))
  if (divergences.length > 0) process.exit(1)
}

main().catch((e: unknown) => {
  console.error(
    JSON.stringify({ msg: 'verify: échec', error: e instanceof Error ? e.message : String(e) }),
  )
  process.exit(1)
})
