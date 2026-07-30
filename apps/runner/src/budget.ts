/**
 * Budget et dimensionnement — la partie du runner qui a le droit de dire non.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. Ce que coûte réellement un mandat, mesuré sur Base Sepolia
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Les trois chiffres ci-dessous ne sont pas des estimations : ils viennent des
 * reçus du premier mandat réglé sur le déploiement courant
 * (`0x3ae9ad53…`, chainId 84532, `feeBps` 250).
 *
 *   • **ouverture** — tx `0xf95b25e4…`, 319 607 gas, frais L1 23 661 378 860 wei,
 *     coût total 0,00000194 ETH. `from` est le relayer KeeperHub
 *     `0x6331eb45…`, `to` le forwarder `0x5aF5194B…` : l'ouverture est
 *     **sponsorisée**. Elle ne consomme donc *rien* de nos clés — ni gas, ni
 *     nonce. C'est le fait qui rend le volume possible.
 *   • **honor** — tx `0x3220b47e…`, 86 013 gas, frais L1 6 845 289 219 wei,
 *     coût total **0,000000523 ETH**, `from` le Settler. `refunded` 195 000,
 *     `fee` 5 000 : la caution de 200 000 revient à 97,5 %.
 *   • **slash** — même forme, et **à peine plus cher** : 493e9 wei mesurés contre
 *     477e9 pour un honor. Le provisionnement d'origine à 1,5 × honor supposait
 *     que la chaîne `reason` alourdissait sensiblement les frais L1 ; elle est
 *     trop courte pour cela. Voir les constantes plus bas.
 *   • **inscription ERC-8004** — poste **nouveau**, et il n'existait pas quand
 *     les trois chiffres ci-dessus ont été relevés : `ERC8004_AGENT_IDS_FILE`
 *     est désormais renseignée, donc `erc8004Sink` résout un `agentId` et écrit
 *     réellement dans le `ReputationRegistry`, sur la clé du Settler. La
 *     politique d'écriture n'est pas uniforme (`daemon.ts`, `writePolicyFor`) et
 *     c'est ce qui rend le provisionnement asymétrique :
 *
 *       – `slashed`   → écriture **immédiate**, une transaction par saisie ;
 *       – `honored`   → **mise en lot**, une transaction par `ERC8004_BATCH_SIZE`
 *                       verdicts (25 par défaut) ou au `flush` de l'arrêt ;
 *       – `reclaimed` → jamais.
 *
 *     Le gas d'une saisie double donc presque, tandis que celui d'un mandat
 *     honoré n'augmente que d'un vingt-cinquième de transaction. Provisionner
 *     l'inscription au même prix sur les deux postes surestimerait le coût du
 *     volume honoré d'un facteur 2 — et rendrait la borne annoncée fausse dans
 *     le sens pessimiste, ce qui est encore une borne fausse.
 *
 * Conséquences chiffrées, à `bond = 200 000` et `feeBps = 250` :
 *
 *   coût d'un mandat **honoré**   = 5 000 unités = 0,005 USDC de frais
 *                                 + 477e9 wei de règlement
 *                                 + 806e9/25 ≈ 32e9 wei d'inscription en lot
 *                                 ────────────────────── ≈ 510e9 wei
 *   coût d'un mandat **saisi**    = 200 000 unités = 0,2 USDC de principal
 *                                 + 494e9 wei de règlement
 *                                 + 806e9 wei d'inscription immédiate
 *                                 ────────────────────── ≈ 1 300e9 wei, soit 2,6 ×
 *
 * Autrement dit : **le capital se recycle, sauf sur les saisies.** Un mandat
 * honoré consomme 1/40e de sa caution ; un mandat saisi la consomme en entier.
 * Le budget doit donc traiter ces deux postes séparément, et c'est exactement
 * ce que fait `Budget` : un plafond de principal pour les saisies, un plafond
 * de frais pour le recyclage, un plafond de gas pour le règlement. Un plafond
 * unique en USDC laisserait 240 mandats honorés consommer autant que
 * 6 saisies — et masquerait celui des deux qui a vidé la clé.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. Dimensionnement du débit — le calcul, et sa borne réelle
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Quatre limites se superposent. La plus basse gouverne, et ce n'est pas celle
 * qu'on croit.
 *
 * **(a) Le débit d'API KeeperHub.** 100 req/min authentifié annoncé,
 * 60 req/min documenté sur l'exécution directe (voir le commentaire de
 * `KeeperHubClient.request`). On retient la plus stricte : 60. Une ouverture
 * complète par `open-warrant.ts` coûte, en nominal :
 *
 *     1 × GET  /api/user/wallet                        (getWallet)
 *     1 × POST /api/execute/contract-call              (open)
 *     1 × GET  /api/execute/{id}/status                (resolveTransaction)
 *     1 × POST /api/execute/contract-call              (l'action)
 *     1 × GET  /api/execute/{id}/status                (resolveTransaction)
 *     ────────────────────────────────────────────────────────────────
 *     5 requêtes par mandat, jusqu'à 11 si `resolveTransaction` épuise ses
 *     4 tentatives sur les deux appels.
 *
 * Auxquelles s'ajoute le Settler : 1 GET par mandat **encore ouvert** et par
 * tour, soit `backlog × 60/intervalMs` req/min. À backlog 6 et tour de 15 s :
 * 24 req/min. Reste 36 req/min pour l'ouverture, soit
 * **⌊36 / 5⌋ = 7 mandats/min** — 11 en comptant les retries au pire :
 * ⌊36 / 11⌋ = 3 mandats/min. On dimensionne sur le pire cas.
 *
 * **(b) La latence de KeeperHub.** `executeContractCall` est *bloquant côté
 * API* : la réponse n'arrive qu'une fois l'exécution terminée. Le commentaire de
 * `KeeperHubClient` annonce ≈ 23 s par appel, mesurés sur Ethereum Sepolia ;
 * **sur Base Sepolia, mesuré sur la campagne « smoke », un mandat complet — deux
 * appels bloquants, plus le démarrage de Node du sous-processus, plus l'attente
 * du reçu d'ouverture — prend 14,3 s et 18,4 s.** Soit ≈ 16 s, donc
 * **≈ 3,7 mandats/min par worker**, presque trois fois l'estimation dérivée de
 * Sepolia. Les blocs de 2 s de Base expliquent l'essentiel de l'écart.
 *
 * À `C` workers : ≈ 3,7 × C mandats/min. Saturer (a) demande donc C ≈ 1 dans le
 * pire cas en requêtes (3 mandats/min) et C ≈ 2 en nominal (7/min) : sur Base,
 * **c'est le débit d'API qui devient la contrainte avant la latence**, l'inverse
 * de ce que la mesure Sepolia laissait croire. Le seau à jetons n'est donc pas
 * une précaution théorique — c'est lui qui régule.
 *
 * **(c) Le débit du Settler.** Une seule clé, donc un seul nonce, donc un
 * règlement à la fois — paralléliser réintroduirait le conflit de nonce que
 * l'invariant I10 cherche à éviter. Mesuré : ouverture au bloc 44 804 490,
 * `honor` au bloc 44 804 505, soit 15 blocs ≈ 30 s de bout en bout, dont
 * 3 confirmations (≈ 6 s) et un tour de boucle. Le coût *marginal* d'un mandat
 * supplémentaire dans un même tour est l'évaluation plus l'inclusion d'une
 * transaction : les tours mesurés qui règlent effectivement durent 4,8 s
 * (`durationMs` du tick), contre 1,9 s pour un tour qui ne règle rien. Soit
 * **≈ 12 mandats/min** au mieux, et l'on retient 6 pour tenir compte des
 * lectures d'archive et de la variance du RPC public.
 *
 * Conséquence, et c'est elle qui dicte le plafond de backlog : le Settler drainant
 * ≈ 6/min et le runner ouvrant ≈ 3,7 × C, tout `C > 2` produit un backlog qui
 * croît. Ce n'est pas grave — le plafond de backlog le rattrape et le runner
 * attend — mais cela veut dire que **le débit soutenable de la campagne est celui
 * du Settler, pas celui de l'ouverture**. Annoncer 11 mandats/min avec C = 3
 * serait faux : la mesure soutenue est de 6.
 *
 * **(d) Le capital en vol.** Et c'est la vraie borne. Chaque mandat ouvert
 * immobilise `bond` jusqu'à son règlement. Avec 1,995 USDC sur l'agent et
 * `bond = 0,2 USDC`, **au plus 9 mandats peuvent être ouverts simultanément** —
 * le dixième se heurterait à un solde insuffisant, c'est-à-dire à un
 * `receiveWithAuthorization` qui révèrte après que KeeperHub a payé le gas.
 *
 * D'où le dimensionnement retenu, et son ordre de dérivation :
 *
 *     backlogCap L = min(⌊(soldeAgent − réserve) / bond⌋, plafond configuré)
 *     concurrence C = min(L, RUNNER_CONCURRENCY)
 *     débit soutenu = min(3,4 × C, débit du Settler ≈ 6, plafond du seau)
 *
 * **Mesuré sur la campagne « borne »** (30/07/2026, 8 mandats, C = 2,
 * `backlogCap` 3) : 17 384 ms par mandat en moyenne sur les huit ouvertures
 * réussies (min 10 809, max 22 149), soit **3,45 mandats/min par worker** — la
 * valeur de 3,7 dérivée de la campagne « smoke » sur deux mandats était
 * optimiste de 7 %. À C = 2, cela donne 6,9 mandats/min d'ouverture, que le
 * Settler à ≈ 6/min ne suit déjà plus : la conclusion du § 2 (c) tient, **le
 * débit soutenable est celui du Settler**.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 3. La borne, en régime soutenu : ce n'est ni le capital ni le débit
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `volumeBound` répond à « combien avec le solde d'aujourd'hui ». La question
 * qui gouverne une démonstration de plusieurs jours est différente : **combien
 * par jour**, et là c'est le faucet qui borne, à 1 USDC et ≈ 0,0001 ETH par
 * adresse et par 24 h.
 *
 *     capital : 1 USDC / 5 000 unités de frais      = 200 mandats honorés / jour
 *     gas     : 0,0001 ETH / 532e9 wei par honoré   = 187 règlements / jour
 *     ────────────────────────────────────────────────────────────────────────
 *     borne soutenue ≈ 187 mandats honorés / jour, **bornée par le gas**
 *
 * Les deux postes sont à 7 % l'un de l'autre, ce qui n'est pas un hasard : c'est
 * le plafond du faucet qui les a rendus comparables, pas une propriété du
 * protocole. Et le poste qui mord est celui que l'inscription ERC-8004 a rendu
 * dominant — sans elle, le gas financerait 200 règlements et le capital serait
 * la contrainte. Sur les **saisies**, l'écart est brutal : 5 par jour côté
 * capital contre 75 côté gas, le principal détruit bornant quinze fois plus tôt.
 *
 * Le plafond de backlog joue trois rôles à la fois, et c'est ce qui le rend
 * juste : il borne le capital immobilisé, il borne la charge du Settler, et il
 * borne le risque d'expiration — `MIN_DURATION` vaut 900 s, un backlog de 6
 * drainé à 6/min se vide en une minute, soit quinze fois la marge.
 */

import { usdc, eth } from './env.js'
import type { Scenario } from './ledger.js'

/**
 * Coûts de gas, en wei, **relevés sur les reçus** de la campagne « borne »
 * (30/07/2026, 8 mandats, chainId 84532), puis arrondis vers le haut.
 *
 *   honor              7 tx · 78 507 gas · 477 499 325 875 wei en moyenne
 *   slash              1 tx · 78 289 gas · 493 551 244 498 wei
 *   giveFeedback seul  1 tx · 131 948 gas · 805 661 985 040 wei
 *   giveFeedback lot   1 tx · 131 636 gas · 804 692 195 881 wei  (7 verdicts)
 *   reclaim            2 tx · 59 535 gas · 363 150 905 216 wei   (clé de l'agent)
 *
 * Deux surprises, et elles corrigent toutes les deux le provisionnement d'origine :
 *
 *   • **une saisie ne coûte presque pas plus qu'un honor** — 493e9 contre 477e9,
 *     soit +3 %, là où le provisionnement d'origine supposait +50 %. La chaîne
 *     `reason` du slash est courte (« post-condition non satisfaite »), donc son
 *     surcoût de frais L1 est marginal. Provisionner 1,5 × honor gonflait le
 *     poste le plus rare de 60 %, ce qui n'est pas grave en soi, mais qui masquait
 *     le vrai poste dominant ;
 *   • **l'inscription ERC-8004 coûte plus cher que le règlement qu'elle décrit** —
 *     806e9 contre 477e9, soit 1,7 ×. Une saisie, qui déclenche une inscription
 *     immédiate, coûte donc 1 299e9 wei tout compris : **2,7 × un honor nu**. Et
 *     le coût du lot est indépendant de sa taille (804e9 pour 7 verdicts, contre
 *     806e9 pour 1) parce que le registre ne reçoit qu'une URI et un hash, jamais
 *     les documents. Le lot amortit donc linéairement : 806e9 / 25 ≈ 32e9 par
 *     mandat honoré à lot plein.
 *
 * Autrement dit, depuis que `ERC8004_AGENT_IDS_FILE` est renseignée, le gas d'une
 * campagne n'est plus dominé par le nombre de règlements mais par le nombre de
 * **saisies**. C'est exactement l'inverse de l'intuition, et c'est ce que la
 * borne annoncée doit refléter.
 */
export const GAS_HONOR_WEI = 500_000_000_000n
export const GAS_SLASH_WEI = 520_000_000_000n
export const GAS_FEEDBACK_WEI = 810_000_000_000n
/** `reclaim`, sur la clé de **l'agent** et non celle du Settler. Ne mélange pas. */
export const GAS_RECLAIM_WEI = 380_000_000_000n

export interface BudgetCaps {
  /** Plafond de principal que les saisies ont le droit de détruire. */
  slashPrincipal: bigint
  /** Plafond cumulé de frais sur les mandats honorés. */
  fees: bigint
  /**
   * Plancher de solde du Settler, en wei. **Invariant au redémarrage** : c'est
   * lui, et non le plafond de consommation, qui empêche de vider la clé.
   */
  gasFloorWei: bigint
  /**
   * Plafond de consommation de gas **pour ce processus**, mesuré depuis le
   * solde relevé au démarrage. Ne survit pas à un redémarrage, et le dit.
   */
  gasSpendWei: bigint
  /** Réserve d'USDC intouchable sur l'agent, au-delà des cautions en vol. */
  agentReserve: bigint
  /** Nombre de mandats visé pour la campagne. */
  target: number
  /** Nombre de saisies visé. Le critère du hackathon en demande ≥ 3. */
  slashTarget: number
  /** Durée maximale du processus, en millisecondes. */
  maxRuntimeMs: number
  /** Plafond de mandats simultanément ouverts. Voir § 2 (d). */
  backlogCap: number
  /**
   * `ERC8004_BATCH_SIZE` tel que le Settler le lira. N'entre dans aucune
   * décision : sert uniquement à amortir le gas d'inscription des honorés dans
   * la borne annoncée. Une valeur fausse ici ne fait pas dépenser, elle fait
   * mal annoncer — ce qui, devant un jury, est le même défaut.
   */
  erc8004BatchSize: number
}

/** Ce que le runner sait de l'état du monde au moment de décider. */
export interface BudgetState {
  /** Mandats de la campagne déjà ouverts (tous statuts). */
  opened: number
  /** Saisies **constatées onchain** sur la campagne. */
  slashed: number
  /** Mandats de la campagne dont on attend encore un scénario de saisie. */
  divertedInFlight: number
  /** Principal détruit par les saisies de la campagne, lu onchain. */
  destroyed: bigint
  /** Frais payés par les mandats honorés de la campagne, lus onchain. */
  fees: bigint
  /** Mandats encore ouverts, campagne comprise ou non : c'est la charge réelle. */
  backlog: number
  /** Solde USDC de l'agent. */
  agentUsdc: bigint
  /**
   * Capital que les mandats **en vol** vont rendre à l'agent, en unités
   * atomiques : `bond − fee` par mandat ouvert destiné à être honoré, `bond`
   * entier par mandat ouvert déjà expiré (que le balayeur `reclaim` récupère
   * sans frais), et **zéro** pour un mandat étiqueté `diverted`, dont la caution
   * part au bénéficiaire.
   *
   * C'est le champ qui distingue « l'agent est à sec » de « l'agent attend son
   * propre argent ». Voir le correctif nº 2 commenté dans `decide` : sans lui,
   * un runner en régime nominal s'arrête définitivement pour une pénurie qui
   * dure trente secondes.
   */
  recoverable: bigint
  /** Solde ETH du Settler. */
  settlerWei: bigint
  /** Solde ETH du Settler au démarrage du processus. */
  settlerWeiAtStart: bigint
  /** Millisecondes écoulées depuis le démarrage. */
  elapsedMs: number
  /** Caution d'un mandat, en unités atomiques. */
  bond: bigint
  /** Taux de frais figé par le contrat, en points de base. */
  feeBps: number
}

export type Decision =
  | { kind: 'open'; scenario: Scenario; why: string }
  | { kind: 'wait'; why: string }
  | { kind: 'stop'; cap: StopCap; why: string }

/**
 * Les arrêts possibles, nommés.
 *
 * Un runner qui s'arrête sans dire **lequel** de ses plafonds a été atteint est
 * inutilisable : on ne sait pas s'il faut recharger le faucet, réduire les
 * saisies, ou simplement le relancer parce que la cible est atteinte. Chaque
 * valeur de cet ensemble correspond à une action différente de l'exploitant.
 *
 * Noter ce qui **n'est pas** dans cette liste : le plafond de principal des
 * saisies. Il borne les saisies, pas la campagne — voir le correctif commenté
 * dans `decide`. Un plafond qui n'empêche qu'une *variante* d'action ne doit pas
 * pouvoir arrêter le processus.
 *
 * Et noter ce qui y est resté mais ne s'y déclenche plus dans le même cas :
 * `capital-agent-insuffisant` ne vaut que si **rien** ne revient. Un solde
 * momentanément sous la caution alors que des mandats en vol vont rendre
 * `bond − fee` chacun n'est pas un épuisement, c'est une file d'attente.
 */
export type StopCap =
  | 'cible'
  | 'budget-frais'
  | 'plancher-gas-settler'
  | 'budget-gas-processus'
  | 'capital-agent-insuffisant'
  | 'durée-maximale'

/**
 * La décision, dans l'ordre où elle doit être prise.
 *
 * L'ordre n'est pas indifférent. Les arrêts *durs* (capital, gas) passent avant
 * les arrêts *doux* (cible atteinte) : un runner qui annoncerait « cible
 * atteinte » alors qu'il vient d'épuiser le gas du Settler mentirait sur la
 * raison, et l'exploitant relancerait pour rien. Et la dégradation d'une saisie
 * en mandat honoré passe avant l'arrêt : quand le quota de saisies est épuisé,
 * il reste du volume à produire, et il ne coûte que des frais.
 */
export function decide(caps: BudgetCaps, s: BudgetState): Decision {
  const feePerHonor = (s.bond * BigInt(s.feeBps)) / 10_000n

  // ── Arrêts durs : ce qui ne se répare pas en attendant ─────────────────────
  if (s.settlerWei < caps.gasFloorWei) {
    return {
      kind: 'stop',
      cap: 'plancher-gas-settler',
      why:
        `le Settler est à ${eth(s.settlerWei)} ETH, sous le plancher de ` +
        `${eth(caps.gasFloorWei)} ETH. Continuer à ouvrir produirait des mandats que ` +
        'personne ne réglerait, et ils expireraient vers reclaim(). ' +
        'Recharger la clé du Settler (pnpm faucet), puis relancer.',
    }
  }
  const gasSpent = s.settlerWeiAtStart > s.settlerWei ? s.settlerWeiAtStart - s.settlerWei : 0n
  if (gasSpent >= caps.gasSpendWei) {
    return {
      kind: 'stop',
      cap: 'budget-gas-processus',
      why:
        `ce processus a consommé ${eth(gasSpent)} ETH de gas de règlement, ` +
        `plafond ${eth(caps.gasSpendWei)} ETH. Relever RUNNER_GAS_SPEND_WEI pour ` +
        'continuer — le plancher de la clé, lui, est encore respecté.',
    }
  }
  /**
   * ⚠ Correctif nº 2, même famille que le nº 1 commenté plus bas, et découvert
   * en relisant la liste des arrêts avec la bonne question : « ce plafond
   * mesure-t-il quelque chose de **consommé**, ou quelque chose d'**immobilisé** ? »
   *
   * Le solde USDC de l'agent est immobilisé, pas consommé. En régime nominal —
   * `backlogCap` mandats en vol, chacun immobilisant `bond` — le solde libre
   * descend mécaniquement sous une caution : c'est le cas *normal*, celui vers
   * lequel le plafond de backlog fait converger le runner. Un arrêt dur ici
   * signifie donc que le runner s'arrête définitivement pour une pénurie qui se
   * résorbe au règlement suivant, soit ≈ 30 s plus tard, et qu'il rend un
   * diagnostic — « recharger l'agent » — dont l'exploitant n'a aucun besoin.
   *
   * L'arrêt ne devient légitime que si **rien ne revient** : `recoverable` vaut
   * alors 0, aucun mandat en vol ne rendra de capital, et attendre est une
   * boucle infinie. Le distinguer coûte un champ d'état et évite de confondre
   * « à sec » avec « en attente de son propre argent ».
   */
  if (s.agentUsdc < s.bond + caps.agentReserve) {
    if (s.recoverable > 0n) {
      return {
        kind: 'wait',
        why:
          `solde libre ${usdc(s.agentUsdc)} USDC sous la caution ${usdc(s.bond)} + réserve ` +
          `${usdc(caps.agentReserve)}, mais ${usdc(s.recoverable)} USDC reviennent des ` +
          `${s.backlog} mandats en vol. On attend le règlement, on n'arrête pas la campagne.`,
      }
    }
    return {
      kind: 'stop',
      cap: 'capital-agent-insuffisant',
      why:
        `l'agent détient ${usdc(s.agentUsdc)} USDC, il faut ${usdc(s.bond)} de caution ` +
        `plus ${usdc(caps.agentReserve)} de réserve, et **rien n'est en vol** qui puisse ` +
        "rendre du capital. L'autorisation EIP-3009 révèrterait à l'encaissement, après " +
        'que KeeperHub a payé le gas d\'ouverture. Recharger l\'agent (pnpm faucet, ' +
        '1 USDC / adresse / 24 h) : c\'est la borne dure du volume.',
    }
  }
  if (s.elapsedMs >= caps.maxRuntimeMs) {
    return {
      kind: 'stop',
      cap: 'durée-maximale',
      why:
        `durée maximale atteinte (${Math.round(s.elapsedMs / 1000)} s). Les mandats en ` +
        'vol restent réglables par le Settler : relancer le runner reprend le compte ' +
        'où il est, le journal faisant foi.',
    }
  }

  // ── Cible ──────────────────────────────────────────────────────────────────
  if (s.opened >= caps.target) {
    return {
      kind: 'stop',
      cap: 'cible',
      why: `cible de ${caps.target} mandats atteinte sur cette campagne (${s.opened} ouverts).`,
    }
  }

  // ── Attente : le backlog n'est pas un plafond, c'est une file ──────────────
  if (s.backlog >= caps.backlogCap) {
    return {
      kind: 'wait',
      why:
        `${s.backlog} mandats ouverts, plafond ${caps.backlogCap} : ` +
        `${usdc(BigInt(s.backlog) * s.bond)} USDC immobilisés. On laisse le Settler drainer.`,
    }
  }

  // ── Choix du scénario ──────────────────────────────────────────────────────
  //
  // La règle est un **ratio**, pas un modulo. Un modulo (« une saisie tous les
  // N ») se désynchronise dès qu'un mandat échoue à l'ouverture, et surtout il
  // ne se recalcule pas à l'identique après un redémarrage — deux exécutions
  // successives rejoueraient la même position. Le ratio, lui, ne dépend que de
  // l'état constaté : « suis-je en retard sur la proportion de saisies visée ? ».
  // Il converge, il est idempotent, et il reprend seul après interruption.
  //
  // Le mandat n° 1 est **toujours** honoré. Une saisie en premier détruirait
  // 0,2 USDC — 10 % du capital de l'agent — avant qu'on sache que la chaîne
  // d'exécution fonctionne de bout en bout. Le premier mandat est un test de
  // fumée, et il doit être le moins cher des deux.
  const slashesAcquired = s.slashed + s.divertedInFlight
  const behindOnSlashes = slashesAcquired * caps.target < caps.slashTarget * (s.opened + 1)
  const slashRoom = caps.slashPrincipal - s.destroyed - BigInt(s.divertedInFlight) * s.bond

  /**
   * Les deux scénarios, chacun avec sa propre condition de faisabilité. Les
   * garder symétriques est tout l'objet des deux correctifs commentés ci-dessous :
   * **un plafond ne referme que le scénario qu'il finance.**
   */
  const slashOwed = s.opened >= 1 && slashesAcquired < caps.slashTarget
  const slashAffordable = slashRoom >= s.bond
  const honoredAffordable = s.fees + feePerHonor <= caps.fees

  /**
   * ⚠ Correctif nº 1, issu de l'exécution réelle, et il vaut d'être expliqué
   * parce que la version fautive paraissait raisonnable.
   *
   * Il y avait plus bas un arrêt `budget-principal-saisies`, déclenché dès que la
   * cible de saisies **et** le plafond de principal étaient tous deux atteints.
   * Lancé sur la campagne « hackathon » avec `slashTarget = 4` et
   * `slashPrincipal = 0,8 USDC`, le runner s'est arrêté au 43e mandat sur 52,
   * message à l'appui : « budget de principal des saisies épuisé (0,800000 USDC
   * détruits sur 0,800000) et cible de saisies atteinte ». Vrai, et absurde : il
   * restait 0,82 USDC de budget de frais, soit 164 mandats honorés, et il a
   * renoncé à les produire pour protéger un principal qu'un mandat honoré ne
   * touche pas — un honoré rend `bond − fee`, il ne détruit que 1/40e de la
   * caution.
   *
   * Le plafond de saisies **borne les saisies, pas la campagne**. Épuisé, il ne
   * doit rien faire d'autre que ramener tous les mandats suivants au scénario
   * honoré. Seuls les quatre postes qui consomment réellement quelque chose ont
   * le droit d'arrêter : le gas, les frais, le capital *irrécupérable*, le temps.
   * Confondre « je ne peux plus saisir » avec « je ne peux plus rien faire » a
   * coûté 9 mandats.
   *
   * ⚠ Correctif nº 3, l'image en miroir du nº 1, et il n'aurait pas manqué de se
   * produire : le plafond de **frais** referme le volume honoré, il n'a pas plus
   * de raison de refermer les saisies. Sans le `|| !honoredAffordable` ci-dessous,
   * un budget de frais épuisé arrêtait la campagne alors qu'une saisie restait
   * due *et* finançable sur son propre budget de principal — la cible de saisies,
   * qui est le critère du hackathon, restait manquée pour protéger un poste qui
   * n'était pas en cause. Le ratio `behindOnSlashes` masquait le cas en régime
   * nominal, ce qui en faisait précisément le genre de défaut qui se révèle sur
   * la campagne de démonstration.
   */
  const wantSlash = slashOwed && slashAffordable && (behindOnSlashes || !honoredAffordable)

  if (wantSlash) {
    return {
      kind: 'open',
      scenario: 'diverted',
      why:
        `saisie ${slashesAcquired + 1}/${caps.slashTarget} — ` +
        `principal restant pour les saisies ${usdc(slashRoom)} USDC` +
        (honoredAffordable ? '' : ' (budget de frais épuisé : seules les saisies restent)'),
    }
  }

  if (!honoredAffordable) {
    return {
      kind: 'stop',
      cap: 'budget-frais',
      why:
        `budget de frais atteint : ${usdc(s.fees)} USDC consommés, plafond ` +
        `${usdc(caps.fees)}, un mandat honoré de plus en coûterait ${usdc(feePerHonor)}. ` +
        (slashOwed
          ? `Il reste ${caps.slashTarget - slashesAcquired} saisie(s) due(s) mais le principal ` +
            `qui leur est réservé est épuisé lui aussi (${usdc(slashRoom)} restants). `
          : '') +
        "Relever RUNNER_FEE_BUDGET si le capital de l'agent le permet.",
    }
  }

  return {
    kind: 'open',
    scenario: 'honored',
    why:
      slashOwed && !slashAffordable
        ? `saisie dégradée en mandat honoré : plafond de principal des saisies atteint ` +
          `(${usdc(slashRoom)} USDC restants, une saisie en coûte ${usdc(s.bond)}). ` +
          'Le volume continue, il ne coûte que des frais.'
        : `mandat honoré — frais ${usdc(feePerHonor)}, caution rendue ${usdc(s.bond - feePerHonor)}`,
  }
}

/**
 * La borne réelle du volume atteignable, à état constant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce que la première version annonçait de faux
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Elle prenait `slashesRemaining` en paramètre — et l'appelant lui passait
 * `caps.slashTarget` tel quel. Sur une reprise de campagne où trois saisies
 * étaient déjà constatées onchain, la borne réservait donc trois cautions de
 * plus qu'il n'en fallait, soit 0,6 USDC, soit 120 cycles honorés escamotés de
 * l'annonce. Elle ignorait de surcroît le plafond de principal des saisies, qui
 * peut rendre la cible de saisies inatteignable indépendamment du capital.
 *
 * Elle ignorait aussi le plafond de **frais**, alors que c'est le seul des deux
 * budgets USDC qui borne le volume honoré, et elle dérivait la borne de gas de
 * `gasSpendWei` seul — c'est-à-dire d'un plafond de politique, jamais du solde
 * réellement présent sur la clé du Settler. Un plafond de 0,00015 ETH sur une
 * clé qui en détient 0,00002 annonçait 187 règlements finançables là où il y en
 * avait 25 : la borne annoncée dépassait la borne physique d'un facteur 7.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Le calcul, dans l'ordre où les contraintes mordent
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   saisies    s = min(cible − acquises, ⌊principal restant / bond⌋)
 *   capital    utilisable u = solde − réserve − bond   (une caution reste en vol)
 *   honorés    h ≤ ⌊(u − s × bond) / fee⌋              (capital)
 *              h ≤ ⌊(plafond de frais − frais payés) / fee⌋   (budget de frais)
 *   gas        s × (slash + inscription) + h × (honor + inscription/lot) ≤ g
 *              avec g = min(plafond du processus, solde du Settler − plancher)
 *   cible      s + h ≤ cible − déjà ouverts
 *
 * `binding` nomme celle des quatre qui a mordu la première. C'est le seul chiffre
 * de la sortie qui dise à l'exploitant *quoi recharger*.
 */
export interface VolumeBound {
  /** Saisies encore finançables — cible et principal réservé pris ensemble. */
  slashes: number
  /** Mandats honorés encore finançables. */
  honored: number
  total: number
  binding: 'cible' | 'capital' | 'frais' | 'gas'
  /** Gas réellement disponible, en wei : plafond de processus ∧ solde − plancher. */
  gasUsableWei: bigint
  /** Règlements que ce gas finance si **tous** sont honorés. Repère, pas un plan. */
  settlementsPerGas: number
}

export function volumeBound(
  caps: BudgetCaps,
  s: Pick<
    BudgetState,
    'agentUsdc' | 'bond' | 'feeBps' | 'settlerWei' | 'destroyed' | 'fees' | 'slashed' | 'opened'
  >,
): VolumeBound {
  const feePerHonor = (s.bond * BigInt(s.feeBps)) / 10_000n
  const gasPerHonor = GAS_HONOR_WEI + GAS_FEEDBACK_WEI / BigInt(Math.max(1, caps.erc8004BatchSize))
  const gasPerSlash = GAS_SLASH_WEI + GAS_FEEDBACK_WEI

  // (a) Saisies : la cible **et** le principal qui leur est réservé.
  const slashRoom = caps.slashPrincipal > s.destroyed ? caps.slashPrincipal - s.destroyed : 0n
  const slashesByTarget = Math.max(0, caps.slashTarget - s.slashed)
  const slashesByPrincipal = s.bond === 0n ? 0 : Number(slashRoom / s.bond)
  let slashes = Math.min(slashesByTarget, slashesByPrincipal)

  // (b) Capital de l'agent. Une caution reste immobilisée en permanence.
  const usable =
    s.agentUsdc > caps.agentReserve + s.bond ? s.agentUsdc - caps.agentReserve - s.bond : 0n
  // Le capital finance d'abord les saisies : c'est le poste destructif, et le
  // sous-provisionner produirait une cible de saisies annoncée puis manquée.
  const bondsForSlashes = BigInt(slashes) * s.bond
  if (bondsForSlashes > usable) {
    slashes = s.bond === 0n ? 0 : Number(usable / s.bond)
  }
  const afterSlashes = usable - BigInt(slashes) * s.bond
  const honoredByCapital = feePerHonor === 0n ? 0 : Number(afterSlashes / feePerHonor)

  // (c) Budget de frais.
  const feeRoom = caps.fees > s.fees ? caps.fees - s.fees : 0n
  const honoredByFees = feePerHonor === 0n ? 0 : Number(feeRoom / feePerHonor)

  // (d) Gas du Settler : le plafond de politique **et** le solde physique.
  const settlerRoom = s.settlerWei > caps.gasFloorWei ? s.settlerWei - caps.gasFloorWei : 0n
  const gasUsableWei = caps.gasSpendWei < settlerRoom ? caps.gasSpendWei : settlerRoom
  const gasForSlashes = BigInt(slashes) * gasPerSlash
  if (gasForSlashes > gasUsableWei) {
    slashes = Number(gasUsableWei / gasPerSlash)
  }
  const gasLeft = gasUsableWei - BigInt(slashes) * gasPerSlash
  const honoredByGas = Number(gasLeft / gasPerHonor)

  // (e) Cible de campagne.
  const roomToTarget = Math.max(0, caps.target - s.opened)

  let honored = Math.min(honoredByCapital, honoredByFees, honoredByGas)
  let binding: VolumeBound['binding'] =
    honored === honoredByGas
      ? 'gas'
      : honored === honoredByFees
        ? 'frais'
        : 'capital'
  if (slashes + honored > roomToTarget) {
    honored = Math.max(0, roomToTarget - slashes)
    binding = 'cible'
  }

  return {
    slashes,
    honored,
    total: slashes + honored,
    binding,
    gasUsableWei,
    settlementsPerGas: Number(gasUsableWei / gasPerHonor),
  }
}
