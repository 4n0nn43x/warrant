/**
 * Daemon de règlement — l'orchestration autour de `decide()`.
 *
 * `settler.ts` sait décider du sort d'**un** mandat dont on lui présente tout ;
 * ce fichier sait *trouver* les mandats, leur apporter ce qu'il faut, soumettre
 * la décision, publier le verdict et l'inscrire dans ERC-8004. Il ne réécrit
 * aucune de ces briques : il les appelle dans l'ordre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pourquoi ce fichier n'appelle pas `settle()`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `settle()` enchaîne `pollExecution` + `decide` + `submit`, ce qui est le bon
 * découpage pour un règlement **ponctuel**. Pour une boucle, deux détails le
 * disqualifient :
 *
 * 1. `pollExecution` bloque jusqu'à 180 s sur un état terminal. Un mandat dont
 *    l'exécution traîne immobiliserait la boucle et retarderait le règlement de
 *    tous les autres — or la fenêtre de règlement est bornée par `expiry`.
 * 2. `decide()` traduit « exécution non terminée » en `let-expire`, ce qui est
 *    juste pour un appel unique et faux pour un daemon : au tour suivant,
 *    l'exécution sera peut-être terminée. Un daemon doit **différer**, pas
 *    renoncer — et ne renoncer que lorsque la fenêtre se ferme réellement.
 *
 * Le daemon lit donc l'exécution lui-même, et n'appelle `decide()` qu'une fois
 * l'état terminal atteint. `decide()` reste la seule autorité sur le verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Les deux règles de conduite, appliquées ici
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   « Une transaction qui échoue n'est pas une post-condition violée. »
 *   « Le doute bénéficie à l'agent, jamais au protocole. »
 *
 * Concrètement, dans ce fichier : **aucun** chemin d'erreur ne mène à `slash`.
 * Journal illisible, engagement divergent, RPC muet, identité ERC-8004
 * impossible à noter — tout cela produit une abstention, donc une expiration
 * vers `reclaim`, donc un remboursement intégral de l'agent. La seule chose qui
 * peut faire saisir une caution est un `checks[]` complet, lu à bloc figé, dont
 * une vérification échoue.
 */

import {
  WarrantStatus,
  actionHash as hashAction,
  conditionHash as hashCondition,
  type ActionSpec,
  type Address,
  type Classification,
  type ConditionSpec,
  type EvaluationResult,
  type Hex,
  type VerdictDocument,
} from '@warrant/core'
import type { PublicClient } from 'viem'
import { warrantEscrowAbi } from './escrow-abi.js'
import { evaluate } from './evaluator.js'
import type { Execution } from './keeperhub.js'
import {
  ReputationAuthorizationError,
  VerdictBatcher,
  buildBatchFeedbackDocument,
  buildFeedbackDocument,
  publishBatch,
  publishVerdict,
  writePolicyFor,
  type BuildFeedbackOptions,
  type ProofOfPayment,
  type PublishableVerdictDocument,
  type ReputationPublicClient,
  type ReputationWalletClient,
} from './reputation.js'
import {
  SETTLEMENT_MARGIN_SECONDS,
  decide,
  submit,
  type SettlementDecision,
  type SubmitOptions,
} from './settler.js'
import type { PublishedVerdict, VerdictPublisher } from './verdicts.js'

// ─────────────────────────────────────────────────────────────────────────────
// Ce que la chaîne dit d'un mandat
// ─────────────────────────────────────────────────────────────────────────────

export interface OnchainWarrant {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  /** Engagement immuable : c'est lui qui valide la spec du journal. */
  conditionHash: Hex
  actionHash: Hex
  /**
   * Le **nonce EIP-3009** de l'autorisation qui a financé la caution.
   *
   * Ce n'était qu'un hash de transaction décoratif ; c'est maintenant la valeur
   * dont le token garantit lui-même l'unicité par autorisant. Conséquence
   * concrète pour ce fichier : ce n'est **plus** un hash de transaction, donc
   * plus une valeur qu'un explorateur de blocs sait résoudre — voir
   * `proofOfPayment` plus bas.
   */
  fundingRef: Hex
  expiry: number
  openedAt: number
  /** Taux de frais figé à l'ouverture. Le taux courant ne s'applique plus. */
  feeBpsAtOpen: number
  status: WarrantStatus
}

export interface DiscoveryResult {
  ids: Hex[]
  /** Dernier bloc réellement balayé. Sert de curseur au tour suivant. */
  scannedTo: bigint
  /**
   * Balayage incomplet. Non fatal : les identifiants connus du journal restent
   * traités, et le curseur n'avance pas.
   */
  error?: string
}

/**
 * Accès en lecture à l'escrow.
 *
 * La chaîne fait autorité sur *ce qui existe* et *dans quel état*. Le journal
 * ne fait autorité sur rien — voir l'en-tête de `journal.ts`.
 */
export interface EscrowReader {
  discover(): Promise<DiscoveryResult>
  read(id: Hex): Promise<OnchainWarrant | undefined>
}

export interface ViemEscrowReaderOptions {
  client: Pick<PublicClient, 'readContract' | 'getLogs' | 'getBlockNumber'>
  address: Address
  /** Premier bloc balayé. En pratique, le bloc de déploiement de l'escrow. */
  fromBlock: bigint
  /**
   * Taille de fenêtre d'`eth_getLogs`.
   *
   * 9 000 par défaut, et ce n'est pas arbitraire : les nœuds publics plafonnent
   * la plage (drpc refuse au-delà de 10 000 blocs, d'autres bien plus bas). Une
   * requête refusée pour cause de plage trop large ressemble à une panne alors
   * que c'est une politique de quota — on découpe donc d'emblée.
   */
  chunkBlocks?: bigint
  /** Journal des erreurs de balayage. */
  onScanError?: (error: string) => void
}

/**
 * `EscrowReader` adossé à un client viem.
 *
 * Le curseur est en mémoire : un redémarrage rebalaye depuis `fromBlock`, ce
 * qui est sans conséquence — la découverte n'est qu'un moyen d'apprendre des
 * identifiants, et `read()` redonne de toute façon le statut courant. Un mandat
 * déjà réglé est ignoré au tri, pas au balayage.
 */
export function viemEscrowReader(opts: ViemEscrowReaderOptions): EscrowReader {
  const chunk = opts.chunkBlocks ?? 9_000n
  let cursor = opts.fromBlock
  const known = new Set<string>()

  return {
    async discover(): Promise<DiscoveryResult> {
      let head: bigint
      try {
        head = await opts.client.getBlockNumber()
      } catch (e) {
        return { ids: [], scannedTo: cursor - 1n, error: errText(e) }
      }

      const found: Hex[] = []
      while (cursor <= head) {
        const to = cursor + chunk - 1n > head ? head : cursor + chunk - 1n
        try {
          const logs = await opts.client.getLogs({
            address: opts.address,
            event: WARRANT_OPENED_EVENT,
            fromBlock: cursor,
            toBlock: to,
          })
          for (const log of logs) {
            const id = (log as { args?: { id?: Hex } }).args?.id
            if (!id) continue
            const key = id.toLowerCase()
            if (known.has(key)) continue
            known.add(key)
            found.push(key as Hex)
          }
        } catch (e) {
          // Le curseur n'avance pas : la fenêtre sera rejouée au tour suivant.
          const message = `eth_getLogs ${cursor}..${to}: ${errText(e)}`
          opts.onScanError?.(message)
          return { ids: found, scannedTo: cursor - 1n, error: message }
        }
        cursor = to + 1n
      }
      return { ids: found, scannedTo: head }
    },

    async read(id: Hex): Promise<OnchainWarrant | undefined> {
      /**
       * `getWarrant` et non le getter `warrants` : il rend **une struct**, donc
       * un objet aux membres nommés, là où le getter généré aplatit en un tuple
       * positionnel de dix valeurs.
       *
       * Ce choix est le correctif d'un piège avéré. La struct `Warrant` a gagné
       * `feeBpsAtOpen` en neuvième position, **avant** `status` : tout décodage
       * positionnel écrit contre l'ancienne forme lit désormais `feeBpsAtOpen`
       * là où il attend `status`. Et il ne plante pas — il lit 250, le taux du
       * déploiement courant, que `WarrantStatus[250]` rend `undefined`. Le
       * daemon conclurait alors qu'aucun mandat n'est `Open` et laisserait tout
       * expirer vers `reclaim`, sans une seule erreur au journal.
       *
       * Nommer les champs supprime la classe de bug entière : un membre ajouté,
       * retiré ou déplacé dans la struct devient une erreur de compilation ou une
       * lecture `undefined` explicite, jamais un décalage silencieux.
       */
      const warrant = (await opts.client.readContract({
        address: opts.address,
        abi: warrantEscrowAbi,
        functionName: 'getWarrant',
        args: [id],
      })) as {
        agent: Address
        beneficiary: Address
        bond: bigint
        conditionHash: Hex
        actionHash: Hex
        fundingRef: Hex
        expiry: bigint
        openedAt: bigint
        feeBpsAtOpen: number
        status: number
      }

      const status = Number(warrant.status) as WarrantStatus
      if (status === WarrantStatus.None) return undefined
      return {
        id: id.toLowerCase() as Hex,
        agent: warrant.agent.toLowerCase() as Address,
        beneficiary: warrant.beneficiary.toLowerCase() as Address,
        bond: warrant.bond,
        conditionHash: warrant.conditionHash.toLowerCase() as Hex,
        actionHash: warrant.actionHash.toLowerCase() as Hex,
        // Le nonce EIP-3009 de l'autorisation, et non plus un hash de
        // transaction : c'est ce que le contrat inscrit désormais.
        fundingRef: warrant.fundingRef.toLowerCase() as Hex,
        expiry: Number(warrant.expiry),
        openedAt: Number(warrant.openedAt),
        feeBpsAtOpen: Number(warrant.feeBpsAtOpen),
        status,
      }
    },
  }
}

const WARRANT_OPENED_EVENT = warrantEscrowAbi.find(
  (item): item is Extract<(typeof warrantEscrowAbi)[number], { type: 'event' }> =>
    item.type === 'event' && item.name === 'WarrantOpened',
)!

// ─────────────────────────────────────────────────────────────────────────────
// Ce que le journal ajoute à ce que dit la chaîne
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le strict nécessaire pour évaluer un mandat.
 *
 * Volontairement plus étroit que `WarrantRecord` : le daemon n'a besoin ni du
 * devis, ni du rail de paiement, ni de la simulation. Réduire la surface, c'est
 * réduire ce qu'une ligne de journal falsifiée pourrait influencer.
 */
export interface SettlementMandate {
  warrantId: Hex
  executionId: string
  conditionSpec: ConditionSpec
  actionSpec: ActionSpec
  classification: Classification
  /** Identité ERC-8004 de l'agent, si elle est connue. Toujours optionnelle. */
  agentId?: bigint
  /**
   * Hash de la transaction d'ouverture — celle qui a **aussi** encaissé la
   * caution, `open()` tirant le paiement EIP-3009 lui-même.
   *
   * Nécessaire depuis que `fundingRef` est un nonce et non plus un hash de
   * transaction : `proofOfPayment.txHash` doit rester résoluble par un
   * explorateur de blocs, sans quoi la preuve de paiement normalisée d'ERC-8004
   * désigne une valeur que personne ne peut vérifier. La chaîne ne le rend pas
   * par `getWarrant`, il vient donc du journal — et son absence n'empêche que la
   * preuve de paiement, jamais le règlement.
   */
  fundingTx?: Hex
}

export interface MandateSource {
  /** Prend en compte ce qui a été ajouté depuis le dernier appel. */
  refresh(): void
  get(id: Hex): SettlementMandate | undefined
  ids(): Hex[]
}

/** Résout l'`agentId` ERC-8004 d'une adresse d'agent. Jamais bloquant. */
export type AgentIdResolver = (agent: Address) => bigint | undefined

export interface JournalLike {
  refresh(): number
  list(): {
    id: Hex
    agent: Address
    executionId: string
    conditionSpec: ConditionSpec
    actionSpec: ActionSpec
    classification: Classification
    openTx?: Hex
  }[]
}

/**
 * `MandateSource` adossée au journal du Gateway.
 *
 * L'`agentId` n'est pas dans `WarrantRecord` — le Gateway ne le connaît pas — et
 * l'`IdentityRegistry` n'expose aucune recherche inverse par propriétaire. Il
 * vient donc d'une table `adresse → agentId` fournie à l'exploitation. Son
 * absence n'empêche rien : le mandat est réglé, le verdict publié, seule
 * l'inscription ERC-8004 est sautée avec une raison explicite.
 */
export function journalMandateSource(
  journal: JournalLike,
  agentIdFor?: AgentIdResolver,
): MandateSource {
  const mandates = new Map<string, SettlementMandate>()

  function reload(): void {
    for (const record of journal.list()) {
      const agentId = agentIdFor?.(record.agent)
      mandates.set(record.id.toLowerCase(), {
        warrantId: record.id.toLowerCase() as Hex,
        executionId: record.executionId,
        conditionSpec: record.conditionSpec,
        actionSpec: record.actionSpec,
        classification: record.classification,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(record.openTx ? { fundingTx: record.openTx } : {}),
      })
    }
  }

  reload()

  return {
    refresh(): void {
      if (journal.refresh() > 0) reload()
    },
    get(id: Hex): SettlementMandate | undefined {
      return mandates.get(id.toLowerCase())
    },
    ids(): Hex[] {
      return [...mandates.keys()] as Hex[]
    },
  }
}

/** Ce que le daemon attend de l'audit trail KeeperHub : localiser et dater. */
export interface ExecutionSource {
  get(executionId: string): Promise<Execution>
}

// ─────────────────────────────────────────────────────────────────────────────
// Inscription ERC-8004
// ─────────────────────────────────────────────────────────────────────────────

export type ReputationOutcome =
  | {
      written: true
      scope: 'single' | 'batch'
      agentId: string
      txHash: Hex
      feedbackURI: string
      feedbackHash: Hex
      /** Nombre de mandats couverts par cette écriture. */
      count: number
    }
  | { written: false; reason: string; agentId?: string }

export interface ReputationSink {
  /** Traite le verdict d'un mandat réglé. **Ne lève jamais.** */
  record(input: {
    agentId: bigint | undefined
    document: PublishableVerdictDocument
    createdAt: string
    /** URI où le document publiable a déjà été servi. */
    feedbackURI: string
    /** Hash calculé à la publication. Recoupé avec celui écrit onchain. */
    expectedHash?: Hex
    proofOfPayment?: ProofOfPayment
  }): Promise<ReputationOutcome>
  /** Écrit les lots arrivés à échéance. **Ne lève jamais.** */
  flush(force?: boolean): Promise<ReputationOutcome[]>
  /** Nombre de mandats honorés en attente de lot, tous agents confondus. */
  pending(): number
}

export interface Erc8004SinkOptions {
  chainId: number
  identityRegistry: Address
  reputationRegistry: Address
  /** Adresse du Settler : l'auteur onchain, et la seule preuve d'origine. */
  settler: Address
  publicClient: ReputationPublicClient
  walletClient: ReputationWalletClient
  chain?: unknown
  /** Publie les documents de lot. Les documents unitaires le sont déjà. */
  publisher: VerdictPublisher
  batcher?: VerdictBatcher
  feedbackURIBase?: string
  logger?: (event: Record<string, unknown>) => void
}

/**
 * Inscription des verdicts dans le Reputation Registry, selon la politique
 * déjà tranchée : **immédiat sur `slashed`, par lots sur `honored`, jamais sur
 * `reclaimed`** (docs/11, `writePolicyFor`).
 *
 * Trois garanties, dans l'ordre où elles comptent :
 *
 * 1. **Ne lève jamais.** Un registre indisponible, un agent que le Settler ne
 *    peut pas noter, un revert : rien de tout cela ne doit empêcher le mandat
 *    suivant d'être réglé. La réputation est un produit dérivé du règlement,
 *    pas une condition de celui-ci.
 * 2. **Ne réécrit pas le document.** Le document publié à l'URI et le document
 *    haché onchain sont le même, à l'octet près : on fige `createdAt` et on
 *    passe l'URI explicitement, puis on recoupe le hash rendu par
 *    `publishVerdict` avec celui de la publication. Un écart est signalé
 *    bruyamment — il signifierait que ce qui est servi ne correspond pas à ce
 *    qui est engagé.
 * 3. **Vérifie l'autorisation avant d'écrire.** `publishVerdict` appelle
 *    `assertCanGiveFeedback` ; on se contente d'attraper le refus et de le
 *    rendre lisible plutôt que de planter (docs/10 § 4).
 */
export function erc8004Sink(opts: Erc8004SinkOptions): ReputationSink {
  const batcher = opts.batcher ?? new VerdictBatcher()
  const log = opts.logger ?? (() => {})
  const proofs = new Map<string, ProofOfPayment>()

  function baseOptions(agentId: bigint, createdAt: string): BuildFeedbackOptions {
    return {
      agentId,
      chainId: opts.chainId,
      settler: opts.settler,
      identityRegistry: opts.identityRegistry,
      createdAt,
    }
  }

  return {
    async record(input): Promise<ReputationOutcome> {
      if (input.agentId === undefined) {
        return {
          written: false,
          reason:
            "aucun agentId ERC-8004 connu pour cet agent — l'identité est " +
            "optionnelle et son absence n'empêche ni le règlement ni la " +
            'publication du verdict (docs/10 § 4)',
        }
      }
      const agentId = input.agentId
      const policy = writePolicyFor(input.document.verdict)
      if (policy === 'never') {
        return {
          written: false,
          agentId: agentId.toString(),
          reason:
            "verdict 'reclaimed' : aucune écriture, jamais — une expiration " +
            "n'est la faute de personne",
        }
      }

      try {
        const result = await publishVerdict(input.document, {
          ...baseOptions(agentId, input.createdAt),
          ...(input.proofOfPayment ? { proofOfPayment: input.proofOfPayment } : {}),
          reputationRegistry: opts.reputationRegistry,
          walletClient: opts.walletClient,
          publicClient: opts.publicClient,
          chain: opts.chain,
          feedbackURI: input.feedbackURI,
        })

        if (!result.written) {
          // Seul `honored` arrive ici : le document est prêt, l'écriture part
          // avec le lot. On conserve la preuve de paiement du mandat pour que
          // le document agrégé la porte au bon niveau — un lot recouvre N
          // règlements x402 distincts.
          batcher.enqueue(agentId, input.document)
          if (input.proofOfPayment) {
            proofs.set(input.document.warrantId.toLowerCase(), input.proofOfPayment)
          }
          return {
            written: false,
            agentId: agentId.toString(),
            reason: `mis en lot (${batcher.size(agentId)}/${batcher.policy.maxBatchSize})`,
          }
        }

        if (input.expectedHash && result.feedbackHash !== input.expectedHash) {
          log({
            msg: 'erc8004: divergence entre le document servi et le document haché',
            severity: 'error',
            warrantId: input.document.warrantId,
            published: input.expectedHash,
            written: result.feedbackHash,
          })
        }

        return {
          written: true,
          scope: 'single',
          agentId: agentId.toString(),
          txHash: result.txHash,
          feedbackURI: result.feedbackURI,
          feedbackHash: result.feedbackHash,
          count: 1,
        }
      } catch (e) {
        return { written: false, agentId: agentId.toString(), reason: reputationReason(e) }
      }
    },

    async flush(force = false): Promise<ReputationOutcome[]> {
      const due = force ? batcher.agents() : batcher.due()
      const outcomes: ReputationOutcome[] = []

      for (const agentId of due) {
        const documents = batcher.drain(agentId)
        if (documents.length === 0) continue
        const createdAt = isoNow()
        const proofsByWarrantId: Record<string, ProofOfPayment> = {}
        for (const doc of documents) {
          const proof = proofs.get(doc.warrantId.toLowerCase())
          if (proof) proofsByWarrantId[doc.warrantId.toLowerCase()] = proof
        }

        // Le document de lot est publié **avant** l'écriture onchain, à l'URI
        // que l'écriture référencera : un `feedbackURI` inscrit avant que le
        // document n'existe donnerait un 404 à qui voudrait vérifier.
        let published: PublishedVerdict
        try {
          published = opts.publisher.publishBatch(
            buildBatchFeedbackDocument(documents, {
              ...baseOptions(agentId, createdAt),
              proofsByWarrantId,
            }),
          )
        } catch (e) {
          outcomes.push({
            written: false,
            agentId: agentId.toString(),
            reason: `publication du lot impossible: ${errText(e)}`,
          })
          continue
        }

        try {
          const result = await publishBatch(documents, {
            ...baseOptions(agentId, createdAt),
            proofsByWarrantId,
            reputationRegistry: opts.reputationRegistry,
            walletClient: opts.walletClient,
            publicClient: opts.publicClient,
            chain: opts.chain,
            feedbackURI: published.uri,
          })
          if (result.written && result.feedbackHash !== published.hash) {
            log({
              msg: 'erc8004: divergence entre le lot servi et le lot haché',
              severity: 'error',
              published: published.hash,
              written: result.feedbackHash,
            })
          }
          for (const doc of documents) proofs.delete(doc.warrantId.toLowerCase())
          outcomes.push({
            written: true,
            scope: 'batch',
            agentId: agentId.toString(),
            txHash: result.written ? result.txHash : ('0x' as Hex),
            feedbackURI: published.uri,
            feedbackHash: published.hash,
            count: documents.length,
          })
        } catch (e) {
          // Le lot n'est **pas** remis en file : si le Settler ne peut pas noter
          // cet agent, le remettre en file le ferait réessayer indéfiniment et
          // grossir sans fin. Le document agrégé reste publié et vérifiable ;
          // seule l'inscription onchain manque, et la raison est journalisée.
          outcomes.push({
            written: false,
            agentId: agentId.toString(),
            reason: `lot de ${documents.length} mandat(s) non inscrit: ${reputationReason(e)}`,
          })
        }
      }

      return outcomes
    },

    pending(): number {
      return batcher.agents().reduce((total, id) => total + batcher.size(id), 0)
    },
  }
}

function reputationReason(e: unknown): string {
  if (e instanceof ReputationAuthorizationError) {
    return `${e.blocker}: ${e.message}`
  }
  return errText(e)
}

// ─────────────────────────────────────────────────────────────────────────────
// Le daemon
// ─────────────────────────────────────────────────────────────────────────────

export type MandateOutcome =
  /** Réglé onchain : `honor` ou `slash` diffusé. */
  | {
      kind: 'settled'
      warrantId: Hex
      action: 'honor' | 'slash'
      settlementTx: Hex
      verdict: 'honored' | 'slashed'
      verdictUri: string
      feedbackHash: Hex
      reputation: ReputationOutcome
    }
  /** Rien à faire pour l'instant ; on repasse au tour suivant. */
  | { kind: 'deferred'; warrantId: Hex; reason: string }
  /** Rien à faire jamais : mandat déjà réglé, hors périmètre, ou fenêtre close. */
  | { kind: 'skipped'; warrantId: Hex; reason: string }
  /** Décision d'abstention : la caution repartira à l'agent par `reclaim`. */
  | { kind: 'let-expire'; warrantId: Hex; reason: string; verdictUri?: string }
  /** Échec technique du règlement lui-même. Jamais une saisie. */
  | { kind: 'failed'; warrantId: Hex; error: string }

export interface TickReport {
  at: number
  /** Mandats onchain en statut `Open` au moment du balayage. */
  open: number
  outcomes: MandateOutcome[]
  reputation: ReputationOutcome[]
  scanError?: string
}

export interface DaemonConfig {
  escrow: Address
  reader: EscrowReader
  mandates: MandateSource
  executions: ExecutionSource
  /**
   * Client sur le RPC **indépendant de KeeperHub** : confirmations et lectures
   * d'évaluation. C'est ce RPC qui est publié dans chaque verdict.
   */
  actionClient: PublicClient
  evaluatorRpcUrl: string
  /** Client sur la chaîne de l'escrow, pour attendre le reçu du règlement. */
  escrowClient: Pick<PublicClient, 'waitForTransactionReceipt'>
  /**
   * Absent → **mode observation** : on décide, on publie, on n'écrit rien
   * onchain. Utile pour vérifier un déploiement sans risquer une saisie.
   */
  submitOptions?: SubmitOptions
  publisher: VerdictPublisher
  reputation?: ReputationSink
  /** Chaîne de l'escrow, pour le `proofOfPayment` du document de feedback. */
  chainId: number
  /**
   * Adresse du Settler. Elle figure dans `clientAddress` du document de
   * feedback : dans ERC-8004, aucune signature n'est attachée à un feedback,
   * l'auteur *est* `msg.sender`. Elle est donc part du document haché, même en
   * mode observation où rien n'est écrit.
   */
  settler: Address
  /**
   * `IdentityRegistry` inscrit dans `agentRegistry` du document de feedback.
   * Doit être celui contre lequel l'écriture sera faite : deux valeurs
   * différentes ici et dans le puits de réputation produiraient un document qui
   * désigne un registre qui n'est pas le sien.
   */
  identityRegistry?: Address
  now?: () => number
  logger?: (event: Record<string, unknown>) => void
  marginSeconds?: number
  /**
   * Plafond d'attente des confirmations de la transaction d'action.
   *
   * Sans plafond, `waitForTransactionReceipt` peut immobiliser la boucle pendant
   * que la fenêtre de règlement des **autres** mandats se referme. Un
   * dépassement n'est pas une violation : `decide()` le traduit en abstention.
   */
  confirmationTimeoutMs?: number
}

export interface SettlementDaemon {
  tick(): Promise<TickReport>
  /** Écrit les lots en attente, à l'arrêt du daemon par exemple. */
  flushReputation(force?: boolean): Promise<ReputationOutcome[]>
}

export function createSettlementDaemon(cfg: DaemonConfig): SettlementDaemon {
  /**
   * Mandats vus onchain et pas encore sortis du statut `Open`.
   *
   * `discover()` ne rend qu'une **découverte incrémentale** : au tour suivant,
   * les mêmes logs ne sont plus rebalayés. Sans cette mémoire, un mandat vu une
   * fois et absent du journal disparaîtrait du champ de vision du daemon, et la
   * ligne de journal qui arriverait ensuite — le Gateway écrit après avoir
   * ouvert — ne le ferait pas revenir tant qu'aucun autre chemin ne le
   * mentionne. On garde donc l'identifiant tant que la chaîne le dit `Open`, et
   * on l'oublie dès qu'il ne l'est plus : l'ensemble ne grossit pas
   * indéfiniment.
   */
  const tracked = new Set<string>()
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000))
  const log = cfg.logger ?? (() => {})
  const margin = cfg.marginSeconds ?? SETTLEMENT_MARGIN_SECONDS
  const confirmationTimeoutMs = cfg.confirmationTimeoutMs ?? 120_000

  /**
   * Client de confirmation borné dans le temps.
   *
   * Ce n'est pas un double de test : c'est le vrai client, avec une échéance.
   * `decide()` reçoit `Pick<PublicClient, 'waitForTransactionReceipt'>`
   * précisément pour que l'appelant puisse choisir sa politique d'attente.
   */
  const boundedClient = {
    waitForTransactionReceipt: (args: Parameters<PublicClient['waitForTransactionReceipt']>[0]) =>
      cfg.actionClient.waitForTransactionReceipt({
        ...args,
        timeout: confirmationTimeoutMs,
      }),
  } as Pick<PublicClient, 'waitForTransactionReceipt'>

  async function settleOne(warrant: OnchainWarrant): Promise<MandateOutcome> {
    const id = warrant.id

    // 1. Le mandat est-il encore à régler ? La chaîne fait autorité — pas notre
    //    mémoire, pas le journal.
    if (warrant.status !== WarrantStatus.Open) {
      return { kind: 'skipped', warrantId: id, reason: `statut ${WarrantStatus[warrant.status]}` }
    }

    // 2. Invariant I9 : `honor` et `slash` révertent passé `expiry`. Émettre
    //    trop tard, c'est brûler du gas pour rien et prendre la place du
    //    `reclaim` de l'agent.
    if (now() + margin >= warrant.expiry) {
      return {
        kind: 'skipped',
        warrantId: id,
        reason:
          `fenêtre de règlement close (expiry ${warrant.expiry}, marge ${margin} s) — ` +
          'la caution repart à l\'agent par reclaim',
      }
    }

    // 3. La spec. Sans elle, il n'y a rien à évaluer : un hash n'est pas
    //    inversible. On s'abstient, l'agent est remboursé.
    const mandate = cfg.mandates.get(id)
    if (!mandate) {
      return {
        kind: 'deferred',
        warrantId: id,
        reason:
          'aucune spec au journal pour ce mandat — évaluation impossible ' +
          "(l'engagement onchain ne porte que des hashs)",
      }
    }

    // 4. Le journal n'est jamais cru : on recalcule les deux engagements et on
    //    les compare à ce qui est inscrit onchain. Une ligne falsifiée produit
    //    une abstention, jamais une saisie.
    const recomputedCondition = hashCondition(mandate.conditionSpec).toLowerCase()
    const recomputedAction = hashAction(mandate.actionSpec).toLowerCase()
    if (recomputedCondition !== warrant.conditionHash) {
      return {
        kind: 'skipped',
        warrantId: id,
        reason:
          `conditionHash divergent : journal ${recomputedCondition}, ` +
          `onchain ${warrant.conditionHash} — la spec du journal n'est pas celle engagée`,
      }
    }
    if (recomputedAction !== warrant.actionHash) {
      return {
        kind: 'skipped',
        warrantId: id,
        reason:
          `actionHash divergent : journal ${recomputedAction}, ` +
          `onchain ${warrant.actionHash} — l'action du journal n'est pas celle engagée`,
      }
    }

    // 5. L'audit trail KeeperHub : il localise et date, il ne décide de rien.
    let execution: Execution
    try {
      execution = await cfg.executions.get(mandate.executionId)
    } catch (e) {
      return {
        kind: 'deferred',
        warrantId: id,
        reason: `audit trail illisible: ${errText(e)}`,
      }
    }

    // 6. Exécution non terminée → on **diffère**. C'est la différence entre un
    //    règlement ponctuel et un daemon : renoncer maintenant priverait
    //    l'exécution du temps qui lui reste avant `expiry`.
    if (execution.status === 'pending' || execution.status === 'running' || execution.status === 'unknown') {
      return {
        kind: 'deferred',
        warrantId: id,
        reason: `exécution ${mandate.executionId} en statut ${execution.status}`,
      }
    }

    // 7. La décision. Seule autorité sur le verdict, et fonction pure.
    //
    //    Deux valeurs sont capturées au passage plutôt que relues après coup :
    //    le bloc d'inclusion, que `decide()` ne rend pas, et le résultat
    //    d'évaluation dans son type d'origine — `SettlementDecision` le décrit
    //    structurellement avec `kind: string`, ce qui perdrait le fait que
    //    chaque `kind` appartient au catalogue fermé de `CheckKind`.
    let actionBlock: bigint | undefined
    let evaluation: EvaluationResult | undefined
    let decision: SettlementDecision
    try {
      decision = await decide({
        warrantId: id,
        expiry: warrant.expiry,
        confirmations: mandate.conditionSpec.confirmations,
        execution,
        publicClient: boundedClient,
        now,
        evaluate: async ({ txHash, blockNumber }) => {
          actionBlock = blockNumber
          evaluation = await evaluate(mandate.conditionSpec, {
            txHash,
            blockNumber,
            client: cfg.actionClient,
            // Le RPC réellement utilisé, jamais une constante : c'est lui qui
            // sera publié dans le verdict pour le rendre rejouable.
            rpcUrl: cfg.evaluatorRpcUrl,
            registryRef: mandate.actionSpec.registryRef,
          })
          return evaluation
        },
      })
    } catch (e) {
      // `decide()` ne laisse remonter que les erreurs de programmation : une
      // spec invalide, un `kind` inconnu. Jamais une lecture RPC.
      return { kind: 'failed', warrantId: id, error: errText(e) }
    }

    // 8. Soumission. `let-expire` ne diffuse rien, par construction.
    let settlementTx: Hex | undefined
    if (decision.action.kind !== 'let-expire') {
      if (!cfg.submitOptions) {
        return {
          kind: 'let-expire',
          warrantId: id,
          reason: `mode observation : ${decision.action.kind} non soumis`,
        }
      }
      try {
        settlementTx = await submit(decision, cfg.submitOptions)
        if (settlementTx) {
          // Attendre le reçu sert deux choses : constater l'inclusion, et
          // sérialiser les écritures. Deux `writeContract` concurrents depuis
          // la même clé se disputeraient le même nonce.
          await cfg.escrowClient.waitForTransactionReceipt({ hash: settlementTx })
        }
      } catch (e) {
        return { kind: 'failed', warrantId: id, error: `soumission: ${errText(e)}` }
      }
    }

    // 9. Le document de verdict. Publié dès qu'une évaluation existe — y compris
    //    quand on s'abstient : « nous avons évalué et choisi de ne pas régler »
    //    est une information vérifiable, et la taire serait une lacune d'audit.
    if (!decision.evaluation || !evaluation) {
      return {
        kind: 'let-expire',
        warrantId: id,
        reason: decision.action.kind === 'let-expire' ? decision.action.reason : 'sans évaluation',
      }
    }

    const document: VerdictDocument = {
      warrantId: id,
      executionId: mandate.executionId,
      txHash: execution.txHash as Hex,
      blockNumber: (actionBlock ?? 0n).toString(10),
      gasUsed: (execution.gasUsedWei ?? 0n).toString(10),
      outcome: execution.outcome ?? execution.status,
      conditionSpec: mandate.conditionSpec,
      actionSpec: mandate.actionSpec,
      classification: mandate.classification,
      checks: evaluation.checks,
      verdict: evaluation.verdict,
      evaluatedAtBlock: evaluation.evaluatedAtBlock,
      rpcUrl: evaluation.rpcUrl,
      ...(settlementTx ? { settlementTx } : {}),
    }

    const createdAt = isoNow(now)

    /**
     * Le pont normalisé x402 → réputation, tel que défini par la spec.
     *
     * `txHash` était le `fundingRef` du mandat, du temps où celui-ci était un
     * hash de transaction. Ce n'est plus le cas : `fundingRef` est le nonce
     * EIP-3009, dont l'unicité est garantie par le token mais qui ne désigne
     * aucune transaction. Le hash qui a réellement déplacé l'USDC est celui de
     * l'ouverture — `open()` encaisse la caution dans sa propre transaction.
     *
     * Omis quand le journal ne porte pas ce hash, plutôt que rempli avec le
     * nonce : une preuve de paiement qui pointe vers une transaction
     * inexistante est pire qu'une preuve absente, parce qu'elle se présente
     * comme vérifiable.
     */
    const proofOfPayment: ProofOfPayment | undefined = mandate.fundingTx
      ? {
          fromAddress: warrant.agent,
          toAddress: cfg.escrow,
          chainId: String(cfg.chainId),
          txHash: mandate.fundingTx,
        }
      : undefined

    // Le document servi est le **document de feedback normalisé** quand une
    // identité ERC-8004 existe — c'est celui dont le hash est engagé onchain,
    // et il contient le verdict complet. Sans identité, il n'y a rien à
    // engager : on sert alors le `VerdictDocument` brut, qui reste le format
    // documenté du projet. Dans les deux cas, ce qui est servi est exactement
    // ce qui est haché.
    let published: PublishedVerdict
    try {
      const artifact =
        mandate.agentId !== undefined
          ? buildFeedbackDocument(document, {
              agentId: mandate.agentId,
              chainId: cfg.chainId,
              settler: cfg.settler,
              identityRegistry: cfg.identityRegistry ?? ZERO_ADDRESS,
              proofOfPayment,
              createdAt,
            })
          : document
      published = cfg.publisher.publish(id, artifact)
    } catch (e) {
      log({ msg: 'publication du verdict impossible', warrantId: id, error: errText(e) })
      return settlementTx
        ? {
            kind: 'failed',
            warrantId: id,
            error: `règlement diffusé (${settlementTx}) mais verdict non publié: ${errText(e)}`,
          }
        : { kind: 'failed', warrantId: id, error: `verdict non publié: ${errText(e)}` }
    }

    // 10. ERC-8004. Un échec ici n'annule rien : le mandat est réglé, le verdict
    //     est publié, seule la trace de réputation manque.
    const reputation: ReputationOutcome = cfg.reputation
      ? await cfg.reputation.record({
          agentId: mandate.agentId,
          document,
          createdAt,
          feedbackURI: published.uri,
          expectedHash: published.hash,
          proofOfPayment,
        })
      : { written: false, reason: 'inscription ERC-8004 désactivée' }

    if (decision.action.kind === 'let-expire') {
      return {
        kind: 'let-expire',
        warrantId: id,
        reason: decision.action.reason,
        verdictUri: published.uri,
      }
    }

    return {
      kind: 'settled',
      warrantId: id,
      action: decision.action.kind,
      settlementTx: settlementTx as Hex,
      verdict: decision.evaluation.verdict,
      verdictUri: published.uri,
      feedbackHash: published.hash,
      reputation,
    }
  }

  return {
    async tick(): Promise<TickReport> {
      cfg.mandates.refresh()
      const discovery = await cfg.reader.discover()

      for (const id of discovery.ids) tracked.add(id.toLowerCase())

      // Union des deux sources : la chaîne pour ce qui existe, le journal pour
      // ce dont on sait quoi faire. Un mandat connu du journal mais jamais vu
      // en log — balayage incomplet, plage refusée — reste traité.
      const ids = new Set<string>([
        ...tracked,
        ...cfg.mandates.ids().map((id) => id.toLowerCase()),
      ])

      const outcomes: MandateOutcome[] = []
      let open = 0

      // Traitement **séquentiel**, et c'est un choix : toutes les transactions
      // de règlement partent de la même clé. Deux soumissions concurrentes se
      // disputeraient le nonce, et la seconde échouerait en « nonce too low »
      // au moment précis où la fenêtre de règlement se referme.
      for (const key of ids) {
        const id = key as Hex
        let warrant: OnchainWarrant | undefined
        try {
          warrant = await cfg.reader.read(id)
        } catch (e) {
          outcomes.push({ kind: 'deferred', warrantId: id, reason: `lecture escrow: ${errText(e)}` })
          continue
        }
        if (!warrant) {
          tracked.delete(key)
          outcomes.push({ kind: 'skipped', warrantId: id, reason: 'inconnu de l\'escrow' })
          continue
        }
        // Réglé, saisi ou remboursé : il n'y a plus rien à en faire, et le
        // relire à chaque tour coûterait un appel RPC pour toujours.
        if (warrant.status === WarrantStatus.Open) open += 1
        else tracked.delete(key)

        try {
          const outcome = await settleOne(warrant)
          outcomes.push(outcome)
          if (outcome.kind !== 'skipped') log({ msg: 'settler', ...outcome })
        } catch (e) {
          // Filet de sécurité : une exception inattendue sur un mandat ne doit
          // pas empêcher les suivants d'être réglés.
          outcomes.push({ kind: 'failed', warrantId: id, error: errText(e) })
          log({ msg: 'settler: exception non rattrapée', warrantId: id, error: errText(e) })
        }
      }

      const reputation = cfg.reputation ? await cfg.reputation.flush() : []

      return {
        at: now(),
        open,
        outcomes,
        reputation,
        ...(discovery.error ? { scanError: discovery.error } : {}),
      }
    },

    async flushReputation(force = true): Promise<ReputationOutcome[]> {
      return cfg.reputation ? cfg.reputation.flush(force) : []
    },
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/** ISO 8601 UTC à la seconde — même forme que `reputation.ts`. */
export function isoNow(now?: () => number): string {
  const ms = now ? now() * 1000 : Date.now()
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
