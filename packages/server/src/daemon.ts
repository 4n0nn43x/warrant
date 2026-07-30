/**
 * Settlement daemon — the orchestration around `decide()`.
 *
 * `settler.ts` knows how to decide the fate of **one** warrant whose every
 * element is handed to it; this file knows how to *find* the warrants, bring
 * them what they need, submit the decision, publish the verdict and record it
 * in ERC-8004. It rewrites none of those bricks: it calls them in order.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file does not call `settle()`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `settle()` chains `pollExecution` + `decide` + `submit`, which is the right
 * split for a **one-off** settlement. For a loop, two details disqualify it:
 *
 * 1. `pollExecution` blocks for up to 180 s on a terminal state. A warrant
 *    whose execution drags would tie up the loop and delay the settlement of
 *    every other one — and the settlement window is bounded by `expiry`.
 * 2. `decide()` translates "execution not finished" into `let-expire`, which is
 *    right for a single call and wrong for a daemon: on the next round, the
 *    execution may well be finished. A daemon must **defer**, not give up — and
 *    give up only once the window really closes.
 *
 * So the daemon reads the execution itself, and calls `decide()` only once the
 * terminal state is reached. `decide()` remains the sole authority on the
 * verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The two rules of conduct, as they apply here
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   "A transaction that fails is not a violated post-condition."
 *   "Doubt benefits the agent, never the protocol."
 *
 * Concretely, in this file: **no** error path leads to `slash`. An unreadable
 * journal, a diverging commitment, a silent RPC, an ERC-8004 identity that
 * cannot be rated — all of that produces an abstention, hence an expiry towards
 * `reclaim`, hence a full refund to the agent. The only thing that can make a
 * bond be slashed is a complete `checks[]`, read at a frozen block, one of
 * whose verifications fails.
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
// What the chain says about a warrant
// ─────────────────────────────────────────────────────────────────────────────

export interface OnchainWarrant {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  /** Immutable commitment: it is what validates the journal's spec. */
  conditionHash: Hex
  actionHash: Hex
  /**
   * The **EIP-3009 nonce** of the authorization that funded the bond.
   *
   * This used to be nothing but a decorative transaction hash; it is now the
   * value whose uniqueness per authorizer the token itself guarantees. Concrete
   * consequence for this file: it is **no longer** a transaction hash, hence no
   * longer a value a block explorer can resolve — see `proofOfPayment` below.
   */
  fundingRef: Hex
  expiry: number
  openedAt: number
  /** Fee rate frozen at opening. The current rate no longer applies. */
  feeBpsAtOpen: number
  status: WarrantStatus
}

export interface DiscoveryResult {
  ids: Hex[]
  /** Last block actually scanned. Serves as the cursor for the next round. */
  scannedTo: bigint
  /**
   * Incomplete scan. Not fatal: the identifiers already known from the journal
   * are still processed, and the cursor does not advance.
   */
  error?: string
}

/**
 * Read access to the escrow.
 *
 * The chain is authoritative on *what exists* and *in which state*. The journal
 * is authoritative on nothing — see the header of `journal.ts`.
 */
export interface EscrowReader {
  discover(): Promise<DiscoveryResult>
  read(id: Hex): Promise<OnchainWarrant | undefined>
}

export interface ViemEscrowReaderOptions {
  client: Pick<PublicClient, 'readContract' | 'getLogs' | 'getBlockNumber'>
  address: Address
  /** First block scanned. In practice, the escrow's deployment block. */
  fromBlock: bigint
  /**
   * `eth_getLogs` window size.
   *
   * 9,000 by default, and that is not arbitrary: public nodes cap the range
   * (drpc refuses beyond 10,000 blocks, others far lower). A request refused
   * for too wide a range looks like an outage when it is in fact a quota
   * policy — so we chunk from the outset.
   */
  chunkBlocks?: bigint
  /** Log sink for scan errors. */
  onScanError?: (error: string) => void
}

/**
 * `EscrowReader` backed by a viem client.
 *
 * The cursor lives in memory: a restart rescans from `fromBlock`, which is of
 * no consequence — discovery is only a means of learning identifiers, and
 * `read()` gives back the current status anyway. A warrant already settled is
 * skipped at triage, not at scanning.
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
          // The cursor does not advance: the window is replayed next round.
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
       * `getWarrant` and not the `warrants` getter: it returns **a struct**,
       * hence an object with named members, where the generated getter flattens
       * into a positional tuple of ten values.
       *
       * This choice is the fix for a proven trap. The `Warrant` struct gained
       * `feeBpsAtOpen` in ninth position, **before** `status`: any positional
       * decoding written against the old shape now reads `feeBpsAtOpen` where
       * it expects `status`. And it does not crash — it reads 250, the current
       * deployment's rate, which `WarrantStatus[250]` renders as `undefined`.
       * The daemon would then conclude that no warrant is `Open` and would let
       * everything expire towards `reclaim`, without a single error in the log.
       *
       * Naming the fields removes the whole bug class: a member added, removed
       * or moved inside the struct becomes a compilation error or an explicit
       * `undefined` read, never a silent shift.
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
        // The authorization's EIP-3009 nonce, and no longer a transaction
        // hash: that is what the contract writes from now on.
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
// What the journal adds to what the chain says
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The strict minimum needed to evaluate a warrant.
 *
 * Deliberately narrower than `WarrantRecord`: the daemon needs neither the
 * quote, nor the payment rail, nor the simulation. Reducing the surface reduces
 * what a forged journal line could influence.
 */
export interface SettlementMandate {
  warrantId: Hex
  executionId: string
  conditionSpec: ConditionSpec
  actionSpec: ActionSpec
  classification: Classification
  /** The agent's ERC-8004 identity, if it is known. Always optional. */
  agentId?: bigint
  /**
   * Hash of the opening transaction — the one that **also** charged the bond,
   * `open()` pulling the EIP-3009 payment itself.
   *
   * Needed ever since `fundingRef` became a nonce rather than a transaction
   * hash: `proofOfPayment.txHash` must stay resolvable by a block explorer,
   * without which ERC-8004's normalised proof of payment designates a value
   * nobody can verify. The chain does not return it through `getWarrant`, so it
   * comes from the journal — and its absence blocks the proof of payment only,
   * never the settlement.
   */
  fundingTx?: Hex
}

export interface MandateSource {
  /** Takes into account whatever was added since the last call. */
  refresh(): void
  get(id: Hex): SettlementMandate | undefined
  ids(): Hex[]
}

/** Resolves the ERC-8004 `agentId` of an agent address. Never blocking. */
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
 * `MandateSource` backed by the Gateway's journal.
 *
 * The `agentId` is not in `WarrantRecord` — the Gateway does not know it — and
 * the `IdentityRegistry` exposes no reverse lookup by owner. So it comes from
 * an `address → agentId` table supplied by operations. Its absence blocks
 * nothing: the warrant is settled, the verdict published, and only the ERC-8004
 * record is skipped, with an explicit reason.
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

/** What the daemon expects of the KeeperHub audit trail: locate and date. */
export interface ExecutionSource {
  get(executionId: string): Promise<Execution>
}

// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 recording
// ─────────────────────────────────────────────────────────────────────────────

export type ReputationOutcome =
  | {
      written: true
      scope: 'single' | 'batch'
      agentId: string
      txHash: Hex
      feedbackURI: string
      feedbackHash: Hex
      /** Number of warrants covered by this write. */
      count: number
    }
  | { written: false; reason: string; agentId?: string }

export interface ReputationSink {
  /** Handles the verdict of a settled warrant. **Never throws.** */
  record(input: {
    agentId: bigint | undefined
    document: PublishableVerdictDocument
    createdAt: string
    /** URI where the publishable document has already been served. */
    feedbackURI: string
    /** Hash computed at publication. Cross-checked with the onchain write. */
    expectedHash?: Hex
    proofOfPayment?: ProofOfPayment
  }): Promise<ReputationOutcome>
  /** Writes the batches that have come due. **Never throws.** */
  flush(force?: boolean): Promise<ReputationOutcome[]>
  /** Number of honored warrants awaiting a batch, across all agents. */
  pending(): number
}

export interface Erc8004SinkOptions {
  chainId: number
  identityRegistry: Address
  reputationRegistry: Address
  /** The Settler's address: the onchain author, and the only proof of origin. */
  settler: Address
  publicClient: ReputationPublicClient
  walletClient: ReputationWalletClient
  chain?: unknown
  /** Publishes the batch documents. Single documents already are. */
  publisher: VerdictPublisher
  batcher?: VerdictBatcher
  feedbackURIBase?: string
  logger?: (event: Record<string, unknown>) => void
}

/**
 * Records verdicts in the Reputation Registry, following the policy already
 * settled: **immediate on `slashed`, batched on `honored`, never on
 * `reclaimed`** (docs/11, `writePolicyFor`).
 *
 * Three guarantees, in the order in which they matter:
 *
 * 1. **Never throws.** An unavailable registry, an agent the Settler cannot
 *    rate, a revert: none of that must prevent the next warrant from being
 *    settled. Reputation is a by-product of settlement, not a condition of it.
 * 2. **Does not rewrite the document.** The document published at the URI and
 *    the document hashed onchain are the same one, to the byte: we freeze
 *    `createdAt` and pass the URI explicitly, then cross-check the hash
 *    returned by `publishVerdict` against the publication's. A discrepancy is
 *    reported loudly — it would mean that what is served does not match what is
 *    committed.
 * 3. **Checks authorization before writing.** `publishVerdict` calls
 *    `assertCanGiveFeedback`; we merely catch the refusal and make it readable
 *    rather than crashing (docs/10 § 4).
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
            'no ERC-8004 agentId known for this agent — the identity is ' +
            'optional and its absence prevents neither the settlement nor the ' +
            'publication of the verdict (docs/10 § 4)',
        }
      }
      const agentId = input.agentId
      const policy = writePolicyFor(input.document.verdict)
      if (policy === 'never') {
        return {
          written: false,
          reason:
            "verdict 'reclaimed': no write, ever — an expiry is nobody's " +
            'fault',
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
          // Only `honored` gets here: the document is ready, the write leaves
          // with the batch. We keep the warrant's proof of payment so that the
          // aggregated document carries it at the right level — one batch
          // covers N distinct x402 settlements.
          batcher.enqueue(agentId, input.document)
          if (input.proofOfPayment) {
            proofs.set(input.document.warrantId.toLowerCase(), input.proofOfPayment)
          }
          return {
            written: false,
            agentId: agentId.toString(),
            reason: `batched (${batcher.size(agentId)}/${batcher.policy.maxBatchSize})`,
          }
        }

        if (input.expectedHash && result.feedbackHash !== input.expectedHash) {
          log({
            msg: 'erc8004: served document diverges from hashed document',
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

        // The batch document is published **before** the onchain write, at the
        // URI that write will reference: a `feedbackURI` recorded before the
        // document exists would give a 404 to whoever wanted to verify.
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
            reason: `cannot publish the batch: ${errText(e)}`,
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
              msg: 'erc8004: served batch diverges from hashed batch',
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
          // The batch is **not** requeued: if the Settler cannot rate this
          // agent, requeuing it would make it retry indefinitely and grow
          // without end. The aggregated document stays published and
          // verifiable; only the onchain record is missing, and the reason is
          // logged.
          outcomes.push({
            written: false,
            agentId: agentId.toString(),
            reason: `batch of ${documents.length} warrant(s) not recorded: ${reputationReason(e)}`,
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
// The daemon
// ─────────────────────────────────────────────────────────────────────────────

export type MandateOutcome =
  /** Settled onchain: `honor` or `slash` broadcast. */
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
  /** Nothing to do for now; we come back on the next round. */
  | { kind: 'deferred'; warrantId: Hex; reason: string }
  /** Nothing to do ever: already settled, out of scope, or window closed. */
  | { kind: 'skipped'; warrantId: Hex; reason: string }
  /** Abstention decision: the bond goes back to the agent via `reclaim`. */
  | { kind: 'let-expire'; warrantId: Hex; reason: string; verdictUri?: string }
  /** Technical failure of the settlement itself. Never a slash. */
  | { kind: 'failed'; warrantId: Hex; error: string }

export interface TickReport {
  at: number
  /** Onchain warrants in `Open` status at the time of the scan. */
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
   * Client on the RPC **independent of KeeperHub**: confirmations and
   * evaluation reads. It is this RPC that is published in every verdict.
   */
  actionClient: PublicClient
  evaluatorRpcUrl: string
  /** Client on the escrow's chain, to await the settlement receipt. */
  escrowClient: Pick<PublicClient, 'waitForTransactionReceipt'>
  /**
   * Absent → **observation mode**: we decide, we publish, we write nothing
   * onchain. Useful to check a deployment without risking a slash.
   */
  submitOptions?: SubmitOptions
  publisher: VerdictPublisher
  reputation?: ReputationSink
  /** The escrow's chain, for the feedback document's `proofOfPayment`. */
  chainId: number
  /**
   * The Settler's address. It appears in the feedback document's
   * `clientAddress`: in ERC-8004 no signature is attached to a feedback, the
   * author *is* `msg.sender`. It is therefore part of the hashed document, even
   * in observation mode where nothing is written.
   */
  settler: Address
  /**
   * `IdentityRegistry` recorded in the feedback document's `agentRegistry`.
   * Must be the one the write will be made against: two different values here
   * and in the reputation sink would produce a document that designates a
   * registry which is not its own.
   */
  identityRegistry?: Address
  now?: () => number
  logger?: (event: Record<string, unknown>) => void
  marginSeconds?: number
  /**
   * Cap on how long we wait for the action transaction's confirmations.
   *
   * Without a cap, `waitForTransactionReceipt` can tie up the loop while the
   * settlement window of the **other** warrants closes. Exceeding it is not a
   * violation: `decide()` translates it into an abstention.
   */
  confirmationTimeoutMs?: number
}

export interface SettlementDaemon {
  tick(): Promise<TickReport>
  /** Writes the pending batches, on daemon shutdown for instance. */
  flushReputation(force?: boolean): Promise<ReputationOutcome[]>
}

export function createSettlementDaemon(cfg: DaemonConfig): SettlementDaemon {
  /**
   * Warrants seen onchain and not yet out of `Open` status.
   *
   * `discover()` only returns an **incremental discovery**: on the next round,
   * the same logs are no longer rescanned. Without this memory, a warrant seen
   * once and absent from the journal would drop out of the daemon's field of
   * vision, and the journal line arriving afterwards — the Gateway writes after
   * opening — would not bring it back as long as no other path mentions it. So
   * we keep the identifier for as long as the chain says it is `Open`, and
   * forget it as soon as it is not: the set does not grow indefinitely.
   */
  const tracked = new Set<string>()
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000))
  const log = cfg.logger ?? (() => {})
  const margin = cfg.marginSeconds ?? SETTLEMENT_MARGIN_SECONDS
  const confirmationTimeoutMs = cfg.confirmationTimeoutMs ?? 120_000

  /**
   * Confirmation client bounded in time.
   *
   * This is not a test double: it is the real client, with a deadline.
   * `decide()` takes `Pick<PublicClient, 'waitForTransactionReceipt'>`
   * precisely so that the caller can choose its own waiting policy.
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

    // 1. Is the warrant still to be settled? The chain is authoritative — not
    //    our memory, not the journal.
    if (warrant.status !== WarrantStatus.Open) {
      return { kind: 'skipped', warrantId: id, reason: `status ${WarrantStatus[warrant.status]}` }
    }

    // 2. Invariant I9: `honor` and `slash` revert past `expiry`. Emitting too
    //    late burns gas for nothing and takes the place of the agent's
    //    `reclaim`.
    if (now() + margin >= warrant.expiry) {
      return {
        kind: 'skipped',
        warrantId: id,
        reason:
          `settlement window closed (expiry ${warrant.expiry}, margin ${margin} s) — ` +
          'the bond goes back to the agent through reclaim',
      }
    }

    // 3. The spec. Without it there is nothing to evaluate: a hash is not
    //    invertible. We abstain, and the agent is refunded.
    const mandate = cfg.mandates.get(id)
    if (!mandate) {
      return {
        kind: 'deferred',
        warrantId: id,
        reason:
          'no spec in the journal for this warrant — evaluation impossible ' +
          '(the onchain commitment carries hashes only)',
      }
    }

    // 4. The journal is never believed: we recompute both commitments and
    //    compare them with what is recorded onchain. A forged line produces an
    //    abstention, never a slash.
    const recomputedCondition = hashCondition(mandate.conditionSpec).toLowerCase()
    const recomputedAction = hashAction(mandate.actionSpec).toLowerCase()
    if (recomputedCondition !== warrant.conditionHash) {
      return {
        kind: 'skipped',
        warrantId: id,
        reason:
          `conditionHash diverges: journal ${recomputedCondition}, ` +
          `onchain ${warrant.conditionHash} — the journal's spec is not the committed one`,
      }
    }
    if (recomputedAction !== warrant.actionHash) {
      return {
        kind: 'skipped',
        warrantId: id,
        reason:
          `actionHash diverges: journal ${recomputedAction}, ` +
          `onchain ${warrant.actionHash} — the journal's action is not the committed one`,
      }
    }

    // 5. The KeeperHub audit trail: it locates and dates, it decides nothing.
    let execution: Execution
    try {
      execution = await cfg.executions.get(mandate.executionId)
    } catch (e) {
      return {
        kind: 'deferred',
        warrantId: id,
        reason: `unreadable audit trail: ${errText(e)}`,
      }
    }

    // 6. Execution not finished → we **defer**. That is the difference between
    //    a one-off settlement and a daemon: giving up now would deprive the
    //    execution of the time it has left before `expiry`.
    if (execution.status === 'pending' || execution.status === 'running' || execution.status === 'unknown') {
      return {
        kind: 'deferred',
        warrantId: id,
        reason: `execution ${mandate.executionId} in status ${execution.status}`,
      }
    }

    // 7. The decision. Sole authority on the verdict, and a pure function.
    //
    //    Two values are captured along the way rather than re-read afterwards:
    //    the inclusion block, which `decide()` does not return, and the
    //    evaluation result in its original type — `SettlementDecision`
    //    describes it structurally with `kind: string`, which would lose the
    //    fact that each `kind` belongs to `CheckKind`'s closed catalogue.
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
            // The RPC actually used, never a constant: it is the one that
            // will be published in the verdict, to make it replayable.
            rpcUrl: cfg.evaluatorRpcUrl,
            registryRef: mandate.actionSpec.registryRef,
          })
          return evaluation
        },
      })
    } catch (e) {
      // `decide()` only lets programming errors through: an invalid spec, an
      // unknown `kind`. Never an RPC read.
      return { kind: 'failed', warrantId: id, error: errText(e) }
    }

    // 8. Submission. `let-expire` broadcasts nothing, by construction.
    let settlementTx: Hex | undefined
    if (decision.action.kind !== 'let-expire') {
      if (!cfg.submitOptions) {
        return {
          kind: 'let-expire',
          warrantId: id,
          reason: `observation mode: ${decision.action.kind} not submitted`,
        }
      }
      try {
        settlementTx = await submit(decision, cfg.submitOptions)
        if (settlementTx) {
          // Awaiting the receipt serves two purposes: observing the inclusion,
          // and serialising the writes. Two concurrent `writeContract` calls
          // from the same key would fight over the same nonce.
          await cfg.escrowClient.waitForTransactionReceipt({ hash: settlementTx })
        }
      } catch (e) {
        return { kind: 'failed', warrantId: id, error: `submission: ${errText(e)}` }
      }
    }

    // 9. The verdict document. Published as soon as an evaluation exists —
    //    including when we abstain: "we evaluated and chose not to settle" is
    //    verifiable information, and keeping it quiet would be an audit gap.
    if (!decision.evaluation || !evaluation) {
      return {
        kind: 'let-expire',
        warrantId: id,
        reason: decision.action.kind === 'let-expire' ? decision.action.reason : 'no evaluation',
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
     * The normalised x402 → reputation bridge, as defined by the spec.
     *
     * `txHash` used to be the warrant's `fundingRef`, back when that was a
     * transaction hash. That is no longer the case: `fundingRef` is the
     * EIP-3009 nonce, whose uniqueness the token guarantees but which
     * designates no transaction. The hash that actually moved the USDC is the
     * opening's — `open()` charges the bond in its own transaction.
     *
     * Omitted when the journal does not carry that hash, rather than filled in
     * with the nonce: a proof of payment pointing at a transaction that does
     * not exist is worse than an absent proof, because it presents itself as
     * verifiable.
     */
    const proofOfPayment: ProofOfPayment | undefined = mandate.fundingTx
      ? {
          fromAddress: warrant.agent,
          toAddress: cfg.escrow,
          chainId: String(cfg.chainId),
          txHash: mandate.fundingTx,
        }
      : undefined

    // The document served is the **normalised feedback document** whenever an
    // ERC-8004 identity exists — it is the one whose hash is committed onchain,
    // and it contains the complete verdict. Without an identity there is
    // nothing to commit: we then serve the raw `VerdictDocument`, which remains
    // the project's documented format. In both cases, what is served is exactly
    // what is hashed.
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
      log({ msg: 'verdict publication failed', warrantId: id, error: errText(e) })
      return settlementTx
        ? {
            kind: 'failed',
            warrantId: id,
            error: `settlement broadcast (${settlementTx}) but verdict not published: ${errText(e)}`,
          }
        : { kind: 'failed', warrantId: id, error: `verdict not published: ${errText(e)}` }
    }

    // 10. ERC-8004. A failure here cancels nothing: the warrant is settled, the
    //     verdict is published, only the reputation trace is missing.
    const reputation: ReputationOutcome = cfg.reputation
      ? await cfg.reputation.record({
          agentId: mandate.agentId,
          document,
          createdAt,
          feedbackURI: published.uri,
          expectedHash: published.hash,
          proofOfPayment,
        })
      : { written: false, reason: 'ERC-8004 recording disabled' }

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

      // Union of the two sources: the chain for what exists, the journal for
      // what we know what to do with. A warrant known to the journal but never
      // seen in a log — incomplete scan, refused range — is still processed.
      const ids = new Set<string>([
        ...tracked,
        ...cfg.mandates.ids().map((id) => id.toLowerCase()),
      ])

      const outcomes: MandateOutcome[] = []
      let open = 0

      // **Sequential** processing, and that is a choice: every settlement
      // transaction leaves from the same key. Two concurrent submissions would
      // fight over the nonce, and the second would fail with "nonce too low" at
      // the precise moment the settlement window is closing.
      for (const key of ids) {
        const id = key as Hex
        let warrant: OnchainWarrant | undefined
        try {
          warrant = await cfg.reader.read(id)
        } catch (e) {
          outcomes.push({ kind: 'deferred', warrantId: id, reason: `escrow read: ${errText(e)}` })
          continue
        }
        if (!warrant) {
          tracked.delete(key)
          outcomes.push({ kind: 'skipped', warrantId: id, reason: 'unknown to the escrow' })
          continue
        }
        // Settled, slashed or refunded: there is nothing left to do with it,
        // and re-reading it every round would cost an RPC call forever.
        if (warrant.status === WarrantStatus.Open) open += 1
        else tracked.delete(key)

        try {
          const outcome = await settleOne(warrant)
          outcomes.push(outcome)
          if (outcome.kind !== 'skipped') log({ msg: 'settler', ...outcome })
        } catch (e) {
          // Safety net: an unexpected exception on one warrant must not
          // prevent the following ones from being settled.
          outcomes.push({ kind: 'failed', warrantId: id, error: errText(e) })
          log({ msg: 'settler: uncaught exception', warrantId: id, error: errText(e) })
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

/** ISO 8601 UTC to the second — same shape as `reputation.ts`. */
export function isoNow(now?: () => number): string {
  const ms = now ? now() * 1000 : Date.now()
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
