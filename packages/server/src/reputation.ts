/**
 * ERC-8004 — inscribing Warrant verdicts into the Reputation Registry.
 *
 * This module does three things, and nothing else:
 *
 *   1. it builds the **off-chain feedback document** in the normalised format of
 *      the ERC-8004 spec (§ "Off-Chain Feedback File Structure"), including the
 *      `proofOfPayment` field, which is the standard bridge between the x402
 *      payment and reputation;
 *   2. it computes `feedbackHash = keccak256(canonicalize(doc))` with
 *      `@warrant/core`'s JCS canonicalisation — the same one that produces the
 *      onchain `conditionHash`: one implementation, never two;
 *   3. it calls `giveFeedback` from the Settler's address.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Vocabulary — an ERC-8004 feedback is never a signed attestation
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EIP-712 and ERC-1271 are used there only by `setAgentWallet`. No signature is
 * attached to a feedback: authenticity rests **solely on `msg.sender`**, here the
 * Settler's address. The word "signed" in the spec qualifies the *value*
 * (`int128`, hence possibly negative), not the message. There is neither a
 * detached attestation nor any possibility of relaying by a third party: whoever
 * rates is whoever sends the transaction.
 *
 * So the exact wording is: a verdict **inscribed** into the registry by the
 * Settler's address, with a `keccak256` commitment over its content.
 *
 * Verifiability comes from the `feedbackURI` + `feedbackHash` pair: anyone
 * downloads the document, canonicalises it, recomputes the `keccak256` and
 * compares — see `verifyFeedbackHash`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What is not readable from storage
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `endpoint`, `feedbackURI` and `feedbackHash` are **not stored**. They are only
 * emitted in the `NewFeedback` event. `readFeedback` returns only `value`,
 * `valueDecimals`, `tag1`, `tag2` and `isRevoked`. Reading a Warrant verdict back
 * therefore requires indexing the logs — which is what
 * `@warrant/reputation-reader` does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Sources
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ABI and invariants taken verbatim from `erc-8004/erc-8004-contracts@master`:
 *   - `abis/ReputationRegistry.json`, `abis/IdentityRegistry.json`
 *   - `contracts/ReputationRegistryUpgradeable.sol` (anti-self-rating guard)
 *   - `ERC8004SPEC.md` (feedback file structure, `proofOfPayment`)
 *
 * See docs/10-erc8004.md.
 */

import {
  ERC8004,
  canonicalize,
  hashCanonical,
  normalizeActionSpec,
  normalizeConditionSpec,
} from '@warrant/core'
import type {
  ActionSpec,
  Address,
  CheckResult,
  Classification,
  ConditionSpec,
  Hex,
  VerdictDocument,
} from '@warrant/core'
import { encodeFunctionData, stringToHex } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// ABI — obtained, never invented
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ReputationRegistry`, the useful subset of
 * `erc-8004/erc-8004-contracts@master:abis/ReputationRegistry.json`.
 *
 * `giveFeedback` takes **eight** parameters. `endpoint`, in sixth position, is the
 * trap: it is optional, it is of no use to us, and omitting it shifts
 * `feedbackURI` and `feedbackHash`. We pass it as an empty string, never absent.
 *
 * ⚠ The registries are **upgradeable** (UUPS behind an ERC-1967). The ABI is
 * frozen here, but it describes the current implementation: re-verify it against
 * the implementation, not only against the proxy.
 */
export const reputationRegistryAbi = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'readFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'getIdentityRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true },
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeedbackRevoked',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: true },
    ],
  },
] as const

/**
 * `IdentityRegistry` (ERC-721), the useful subset.
 *
 * ⚠ `isAuthorizedOrOwner` is present in the deployed implementation
 * (`contracts/IdentityRegistryUpgradeable.sol`, line 205) and it is **that**
 * function `ReputationRegistry.giveFeedback` calls in order to forbid
 * self-rating. It is nevertheless **absent from `abis/IdentityRegistry.json`**:
 * the published ABI file lags behind the source. We declare it explicitly, and
 * `canGiveFeedback` knows how to fall back to the equivalent ERC-721
 * decomposition (`ownerOf` / `getApproved` / `isApprovedForAll`) if the call
 * fails.
 *
 * Only one `register` is declared — the two-argument overload — so as not to
 * expose viem to an ambiguous overload resolution.
 */
export const identityRegistryAbi = [
  {
    type: 'function',
    name: 'isAuthorizedOrOwner',
    stateMutability: 'view',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getApproved',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getMetadata',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'setMetadata',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
      {
        name: 'metadata',
        type: 'tuple[]',
        components: [
          { name: 'metadataKey', type: 'string' },
          { name: 'metadataValue', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Constants of the Warrant → ERC-8004 mapping
// ─────────────────────────────────────────────────────────────────────────────

/** Makes every Warrant feedback filterable by any ERC-8004 client. */
export const FEEDBACK_TAG1 = 'warrant' as const

/**
 * `endpoint`, the sixth parameter of `giveFeedback`. Always the empty string:
 * Warrant does not rate an HTTP endpoint, it rates a warrant. Never omitted —
 * omitting it would shift `feedbackURI` and `feedbackHash`.
 */
export const FEEDBACK_ENDPOINT = '' as const

/** `valueDecimals = 2` → `value = ±100` reads as `+1.00` / `−1.00`. */
export const VERDICT_VALUE_DECIMALS = 2 as const

/** `int128 value`, in units of 10⁻². Negative = slash. */
export const VERDICT_VALUE = {
  honored: 100n,
  slashed: -100n,
} as const

/** `require(valueDecimals <= 18)` — ReputationRegistryUpgradeable.sol:105. */
export const MAX_VALUE_DECIMALS = 18

/** `MAX_ABS_VALUE = 1e38` — ReputationRegistryUpgradeable.sol:12. */
export const MAX_ABS_VALUE = 10n ** 38n

/** Default URI base of the verdict document. */
export const DEFAULT_FEEDBACK_URI_BASE = 'https://warrant.sh/v/'

/** Metadata keys written onto the agent's identity (docs/10 § 4). */
export const METADATA_KEYS = {
  escrow: 'warrant.escrow',
  since: 'warrant.since',
} as const

/** The possible verdicts of a warrant, `reclaimed` included. */
export type WarrantVerdict = 'honored' | 'slashed' | 'reclaimed'

/**
 * The verdict document as the Settler produces it, widened to `reclaimed`.
 * `@warrant/core`'s `VerdictDocument` only knows `honored` / `slashed`: an expired
 * warrant produces no publishable document, but it still travels through
 * `publishVerdict`, which must be able to refuse it explicitly.
 */
export type PublishableVerdictDocument = Omit<VerdictDocument, 'verdict'> & {
  verdict: WarrantVerdict
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class ReputationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReputationError'
  }
}

/** The reason the submitter cannot rate this `agentId`. */
export type AuthorizationBlocker =
  | 'owner'
  | 'operator'
  | 'approved'
  | 'agent-not-registered'
  | 'unknown'

/**
 * The submitter cannot write this feedback. Thrown **before** any transaction:
 * discovering the problem after 150 settled warrants and zero published feedback
 * is not an option.
 */
export class ReputationAuthorizationError extends ReputationError {
  readonly blocker: AuthorizationBlocker
  readonly agentId: bigint
  readonly submitter: Address
  readonly agentOwner?: Address

  constructor(opts: {
    message: string
    blocker: AuthorizationBlocker
    agentId: bigint
    submitter: Address
    agentOwner?: Address
  }) {
    super(opts.message)
    this.name = 'ReputationAuthorizationError'
    this.blocker = opts.blocker
    this.agentId = opts.agentId
    this.submitter = opts.submitter
    if (opts.agentOwner) this.agentOwner = opts.agentOwner
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clients — minimal structural interfaces, so they stay mockable
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadContractRequest {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}

export interface WriteContractRequest {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
  account: Address
  chain?: unknown
}

/** The subset of `PublicClient` this module needs. */
export interface ReputationPublicClient {
  readContract(request: ReadContractRequest): Promise<unknown>
}

/** The subset of `WalletClient` this module needs. */
export interface ReputationWalletClient {
  writeContract(request: WriteContractRequest): Promise<Hex>
}

// ─────────────────────────────────────────────────────────────────────────────
// The off-chain feedback document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The standard bridge between the x402 payment and reputation, as defined by
 * `ERC8004SPEC.md`: *"this can be used for x402 proof of payment"*.
 *
 * We use it rather than a home-grown format precisely so that an ERC-8004 client
 * that knows nothing of Warrant can still tie the feedback back to the settlement
 * that funded it.
 *
 * `txHash` is the hash of the warrant's **opening** transaction, not the
 * `fundingRef`: since `open()` pulls the EIP-3009 payment itself, that is the
 * transaction that moves the USDC, and `fundingRef` is now only a nonce — unique,
 * but designating no transaction. A consumer that resolves `txHash` on an
 * explorer must land on a real transfer.
 */
export interface ProofOfPayment {
  fromAddress: Address
  toAddress: Address
  /** Decimal string, as in the spec's example (`"1"`). */
  chainId: string
  txHash: Hex
}

/** Deterministic projection of a settled warrant inside the document. */
export interface WarrantVerdictRecord {
  warrantId: Hex
  executionId: string
  txHash: Hex
  blockNumber: string
  gasUsed: string
  outcome: string
  conditionSpec: ConditionSpec
  actionSpec: ActionSpec
  classification: Classification
  checks: CheckResult[]
  verdict: 'honored' | 'slashed'
  evaluatedAtBlock: string
  rpcUrl: string
  /** `null` when the settlement has no hash yet — never absent. */
  settlementTx: Hex | null
  /** Present only in an aggregated document, where it sits per warrant. */
  proofOfPayment?: ProofOfPayment
}

/** Fields common to both, in `ERC8004SPEC.md`'s normalised format. */
export interface FeedbackDocumentBase {
  // The spec's MUST FIELDS
  agentRegistry: string
  agentId: number
  clientAddress: string
  createdAt: string
  value: number
  valueDecimals: number
  // The OPTIONAL FIELDS Warrant fills in
  tag1: typeof FEEDBACK_TAG1
  tag2: 'honored' | 'slashed'
  endpoint: string
}

/** One warrant, one feedback. The slash case. */
export interface SingleFeedbackDocument extends FeedbackDocumentBase {
  proofOfPayment?: ProofOfPayment
  warrant: WarrantVerdictRecord
}

/** N honored warrants, one aggregated feedback. The batch case (docs/10 § 5). */
export interface BatchFeedbackDocument extends FeedbackDocumentBase {
  warrantCount: number
  warrants: WarrantVerdictRecord[]
}

export type FeedbackDocument = SingleFeedbackDocument | BatchFeedbackDocument

/** `eip155:<chainId>:<address>` — the CAIP-10 form the spec uses. */
export function caip10(chainId: number, address: Address): string {
  return `eip155:${chainId}:${address.toLowerCase()}`
}

function lowerHex(value: string, path: string): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new ReputationError(`${path}: expected a 0x… hex string, got ${JSON.stringify(value)}`)
  }
  return value.toLowerCase() as Hex
}

/**
 * Rebuilds a warrant record from an allow-list.
 *
 * Two deliberate exclusions:
 *   - `reputationTx`: the hash of the ERC-8004 transaction is only known after
 *     the write. Including it would make `feedbackHash` circular and
 *     unverifiable.
 *   - any unexpected field of the input document: nothing unforeseen must slip
 *     into what gets hashed.
 *
 * An absent `settlementTx` becomes `null` rather than being omitted — the same
 * rule as `@warrant/core`: no absent optional field, otherwise two semantically
 * identical documents would produce two hashes (docs/07 § 4, rule 4).
 */
export function toVerdictRecord(
  doc: PublishableVerdictDocument,
  proofOfPayment?: ProofOfPayment,
): WarrantVerdictRecord {
  if (doc.verdict === 'reclaimed') {
    throw new ReputationError(
      "a 'reclaimed' warrant produces no feedback document: expiry is nobody's " +
        'fault (docs/10 § 5)',
    )
  }

  const record: WarrantVerdictRecord = {
    warrantId: lowerHex(doc.warrantId, 'warrantId'),
    executionId: String(doc.executionId),
    txHash: lowerHex(doc.txHash, 'txHash'),
    blockNumber: String(doc.blockNumber),
    gasUsed: String(doc.gasUsed),
    outcome: String(doc.outcome),
    conditionSpec: normalizeConditionSpec(doc.conditionSpec),
    actionSpec: normalizeActionSpec(doc.actionSpec),
    classification: {
      category: doc.classification.category,
      params: { ...doc.classification.params },
      notionalUSD: String(doc.classification.notionalUSD),
      registryRef: lowerHex(doc.classification.registryRef, 'classification.registryRef'),
    },
    checks: doc.checks.map((c) => ({
      kind: c.kind,
      expected: String(c.expected),
      observed: String(c.observed),
      pass: Boolean(c.pass),
    })),
    verdict: doc.verdict,
    evaluatedAtBlock: String(doc.evaluatedAtBlock),
    rpcUrl: String(doc.rpcUrl),
    settlementTx: doc.settlementTx ? lowerHex(doc.settlementTx, 'settlementTx') : null,
  }

  if (proofOfPayment) record.proofOfPayment = normalizeProof(proofOfPayment)
  return record
}

function normalizeProof(p: ProofOfPayment): ProofOfPayment {
  return {
    fromAddress: p.fromAddress.toLowerCase() as Address,
    toAddress: p.toAddress.toLowerCase() as Address,
    chainId: String(p.chainId),
    txHash: lowerHex(p.txHash, 'proofOfPayment.txHash'),
  }
}

export interface BuildFeedbackOptions {
  agentId: bigint | number
  chainId: number
  /** The Settler's address — the onchain author, and the only proof of origin. */
  settler: Address
  /** The chain's `IdentityRegistry`, for the `agentRegistry` field. */
  identityRegistry: Address
  /** The warrant's x402 proof of payment (`fundingRef`). */
  proofOfPayment?: ProofOfPayment
  /** ISO 8601 UTC. Injected to make the hash reproducible in tests. */
  createdAt?: string
}

function agentIdAsNumber(agentId: bigint | number): number {
  const n = typeof agentId === 'bigint' ? Number(agentId) : agentId
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ReputationError(
      `agentId ${agentId} is not a safe JSON integer; the spec's feedback document ` +
        'serialises it as a number, not as a string — this implementation will have ' +
        'to be revisited if the registry ever reaches 2⁵³ identities',
    )
  }
  return n
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function baseDocument(
  verdict: 'honored' | 'slashed',
  opts: BuildFeedbackOptions,
): FeedbackDocumentBase {
  return {
    agentRegistry: caip10(opts.chainId, opts.identityRegistry),
    agentId: agentIdAsNumber(opts.agentId),
    clientAddress: caip10(opts.chainId, opts.settler),
    createdAt: opts.createdAt ?? nowIso(),
    value: Number(VERDICT_VALUE[verdict]),
    valueDecimals: VERDICT_VALUE_DECIMALS,
    tag1: FEEDBACK_TAG1,
    tag2: verdict,
    endpoint: FEEDBACK_ENDPOINT,
  }
}

/**
 * Builds the feedback document of a single warrant.
 *
 * @throws {ReputationError} on a `reclaimed` verdict — there is nothing to publish.
 */
export function buildFeedbackDocument(
  doc: PublishableVerdictDocument,
  opts: BuildFeedbackOptions,
): SingleFeedbackDocument {
  if (doc.verdict === 'reclaimed') {
    throw new ReputationError(
      "no feedback is published for a 'reclaimed' warrant: an infrastructure " +
        "failure must never degrade an agent's reputation (docs/10 § 5)",
    )
  }

  const out: SingleFeedbackDocument = {
    ...baseDocument(doc.verdict, opts),
    warrant: toVerdictRecord(doc),
  }
  if (opts.proofOfPayment) out.proofOfPayment = normalizeProof(opts.proofOfPayment)
  return out
}

/**
 * Builds the aggregated document of a batch of honored warrants.
 *
 * `proofOfPayment` stays at the level of each warrant: a batch covers N distinct
 * x402 settlements, and hoisting a single one up to document level would suggest
 * it covered them all.
 */
export function buildBatchFeedbackDocument(
  docs: readonly PublishableVerdictDocument[],
  opts: BuildFeedbackOptions & {
    proofsByWarrantId?: Readonly<Record<string, ProofOfPayment>>
  },
): BatchFeedbackDocument {
  if (docs.length === 0) {
    throw new ReputationError('empty batch: nothing to publish')
  }
  const offenders = docs.filter((d) => d.verdict !== 'honored')
  if (offenders.length > 0) {
    throw new ReputationError(
      'a batch only aggregates honored warrants; a slash is written immediately ' +
        `and on its own (verdicts received: ${[...new Set(offenders.map((d) => d.verdict))].join(', ')})`,
    )
  }

  const warrants = docs.map((d) =>
    toVerdictRecord(d, opts.proofsByWarrantId?.[d.warrantId.toLowerCase()]),
  )

  return {
    ...baseDocument('honored', opts),
    warrantCount: warrants.length,
    warrants,
  }
}

/**
 * `feedbackHash = keccak256(utf8(canonicalize(doc)))`.
 *
 * The same JCS canonicalisation as the onchain `conditionHash`: one
 * implementation, reimplementable byte-for-byte in Python or in Go.
 */
export function feedbackHashOf(doc: FeedbackDocument): Hex {
  return hashCanonical(canonicalize(doc))
}

/** The canonical form served at `feedbackURI`. It is the one that gets hashed. */
export function canonicalFeedbackDocument(doc: FeedbackDocument): string {
  return canonicalize(doc)
}

/**
 * Third-party verification: download the document, canonicalise it, recompute the
 * `keccak256`, compare against what was emitted in `NewFeedback`.
 */
export function verifyFeedbackHash(doc: FeedbackDocument, expected: Hex): boolean {
  return feedbackHashOf(doc) === expected.toLowerCase()
}

/** Stable URI of a warrant's verdict document. */
export function feedbackUriFor(warrantId: Hex, base = DEFAULT_FEEDBACK_URI_BASE): string {
  return `${base}${warrantId.toLowerCase()}`
}

/** Stable URI of a batch, indexed by the hash of its content. */
export function batchFeedbackUriFor(
  feedbackHash: Hex,
  base = DEFAULT_FEEDBACK_URI_BASE,
): string {
  return `${base}batch/${feedbackHash.toLowerCase()}`
}

// ─────────────────────────────────────────────────────────────────────────────
// The eight arguments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The positional tuple of `giveFeedback`, in the exact order of the ABI:
 * `agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash`.
 */
export type GiveFeedbackArgs = readonly [
  agentId: bigint,
  value: bigint,
  valueDecimals: number,
  tag1: string,
  tag2: string,
  endpoint: string,
  feedbackURI: string,
  feedbackHash: Hex,
]

/**
 * Assembles the eight arguments. Split from the send so that the mapping is
 * testable dry, with neither client nor network.
 */
export function giveFeedbackArgs(opts: {
  agentId: bigint | number
  verdict: 'honored' | 'slashed'
  feedbackURI: string
  feedbackHash: Hex
}): GiveFeedbackArgs {
  const agentId = BigInt(opts.agentId)
  const value = VERDICT_VALUE[opts.verdict]

  // Bounds taken as-is from ReputationRegistryUpgradeable.sol.
  if (value < -MAX_ABS_VALUE || value > MAX_ABS_VALUE) {
    throw new ReputationError(`value ${value} is outside the ±1e38 bounds`)
  }
  if (VERDICT_VALUE_DECIMALS > MAX_VALUE_DECIMALS) {
    throw new ReputationError(`valueDecimals must stay ≤ ${MAX_VALUE_DECIMALS}`)
  }

  return [
    agentId,
    value,
    VERDICT_VALUE_DECIMALS,
    FEEDBACK_TAG1,
    opts.verdict,
    // Sixth position. Empty, never absent.
    FEEDBACK_ENDPOINT,
    opts.feedbackURI,
    lowerHex(opts.feedbackHash, 'feedbackHash'),
  ] as const
}

// ─────────────────────────────────────────────────────────────────────────────
// The anti-self-rating guard
// ─────────────────────────────────────────────────────────────────────────────

export interface IdentityContext {
  publicClient: ReputationPublicClient
  identityRegistry: Address
}

export interface AuthorizationVerdict {
  ok: boolean
  blocker?: AuthorizationBlocker
  agentOwner?: Address
  /** How the answer was obtained — useful when diagnosing. */
  via: 'isAuthorizedOrOwner' | 'erc721-decomposition'
}

/**
 * Can the submitter rate this `agentId`?
 *
 * `giveFeedback` requires `!isAuthorizedOrOwner(msg.sender, agentId)` — the
 * submitter must be neither the owner, nor an approved operator, nor approved on
 * the token (ReputationRegistryUpgradeable.sol:110). We reproduce exactly the same
 * predicate, calling first the function the registry itself calls.
 *
 * If that call fails — the current implementation may differ, and the function is
 * absent from the published ABI — we fall back to the equivalent ERC-721
 * decomposition, the one OpenZeppelin's `_isAuthorized` implements.
 */
export async function canGiveFeedback(
  agentId: bigint | number,
  submitter: Address,
  ctx: IdentityContext,
): Promise<AuthorizationVerdict> {
  const id = BigInt(agentId)
  const who = submitter.toLowerCase() as Address

  try {
    const authorized = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'isAuthorizedOrOwner',
      args: [who, id],
    })) as boolean
    if (!authorized) return { ok: true, via: 'isAuthorizedOrOwner' }
    // The registry would refuse. We look up the owner for a useful message.
    const owner = await safeOwnerOf(id, ctx)
    return {
      ok: false,
      blocker: owner && owner === who ? 'owner' : 'operator',
      ...(owner ? { agentOwner: owner } : {}),
      via: 'isAuthorizedOrOwner',
    }
  } catch {
    // Fallback: ERC-721 decomposition.
  }

  const lookup = await lookupOwner(id, ctx)
  if (lookup.kind !== 'found') {
    // Telling the two failures apart matters: a nonexistent agent is a normal
    // situation (the ERC-8004 identity is optional), whereas a silent RPC lets us
    // conclude nothing — and when in doubt we do not write.
    return {
      ok: false,
      blocker: lookup.kind === 'nonexistent' ? 'agent-not-registered' : 'unknown',
      via: 'erc721-decomposition',
    }
  }
  const owner = lookup.owner
  if (owner === who) {
    return { ok: false, blocker: 'owner', agentOwner: owner, via: 'erc721-decomposition' }
  }

  try {
    const approved = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'getApproved',
      args: [id],
    })) as Address
    if (approved && approved.toLowerCase() === who) {
      return {
        ok: false,
        blocker: 'approved',
        agentOwner: owner,
        via: 'erc721-decomposition',
      }
    }

    const forAll = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'isApprovedForAll',
      args: [owner, who],
    })) as boolean
    if (forAll) {
      return {
        ok: false,
        blocker: 'operator',
        agentOwner: owner,
        via: 'erc721-decomposition',
      }
    }
  } catch {
    // Indeterminate: we do not conclude it is authorised, we refuse to write.
    return {
      ok: false,
      blocker: 'unknown',
      agentOwner: owner,
      via: 'erc721-decomposition',
    }
  }

  return { ok: true, agentOwner: owner, via: 'erc721-decomposition' }
}

type OwnerLookup =
  | { kind: 'found'; owner: Address }
  /** `ERC721NonexistentToken` — the agentId was never minted. */
  | { kind: 'nonexistent' }
  /** The chain did not answer. We conclude nothing from it. */
  | { kind: 'unavailable'; error: string }

/**
 * An application-level revert is recognised by its text; everything else
 * (transport, timeout, saturated node) stays "indeterminate". A deliberate
 * approximation: viem exposes error classes, but we do not want to couple this
 * module to their hierarchy, nor to reproduce it in every test mock.
 */
function looksLikeRevert(e: unknown): boolean {
  const text = `${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`.toLowerCase()
  return (
    text.includes('revert') ||
    text.includes('erc721') ||
    text.includes('nonexistent') ||
    text.includes('invalidtoken')
  )
}

async function lookupOwner(agentId: bigint, ctx: IdentityContext): Promise<OwnerLookup> {
  try {
    const owner = (await ctx.publicClient.readContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [agentId],
    })) as Address
    return owner
      ? { kind: 'found', owner: owner.toLowerCase() as Address }
      : { kind: 'nonexistent' }
  } catch (e) {
    return looksLikeRevert(e)
      ? { kind: 'nonexistent' }
      : { kind: 'unavailable', error: errText(e) }
  }
}

async function safeOwnerOf(
  agentId: bigint,
  ctx: IdentityContext,
): Promise<Address | undefined> {
  const lookup = await lookupOwner(agentId, ctx)
  return lookup.kind === 'found' ? lookup.owner : undefined
}

const BLOCKER_MESSAGE: Record<AuthorizationBlocker, string> = {
  owner: 'it is its **owner**',
  operator: 'it is an approved **operator** of it',
  approved: 'it is **approved** on that token',
  'agent-not-registered': 'that agentId does not exist in the IdentityRegistry',
  unknown: 'the onchain check failed',
}

/**
 * Refuses to write if the submitter cannot rate this agent.
 *
 * To be called **before** the transaction. Without it, we would discover the
 * problem with 150 settled warrants and zero published feedback.
 *
 * @throws {ReputationAuthorizationError}
 */
export async function assertCanGiveFeedback(
  agentId: bigint | number,
  settler: Address,
  ctx: IdentityContext,
): Promise<void> {
  const verdict = await canGiveFeedback(agentId, settler, ctx)
  if (verdict.ok) return

  const blocker = verdict.blocker ?? 'unknown'
  const id = BigInt(agentId)
  const detail = BLOCKER_MESSAGE[blocker]

  const remedy =
    blocker === 'agent-not-registered'
      ? 'Register the agent from its own address before rating it — Warrant ' +
        'registration is optional and never blocking (docs/10 § 4).'
      : blocker === 'unknown'
        ? 'When in doubt we do not write: a feedback that would revert is wasted ' +
          'gas, and a feedback written by mistake cannot be taken back. Retry once ' +
          'the RPC answers.'
        : 'The agent must be the owner of its own ERC-8004 NFT, never Warrant, and ' +
        'the Settler must be a third-party address, neither owner nor operator. If ' +
        'the agent was registered from a Warrant address, no verdict will ever be ' +
        'inscribable for it (docs/10 § 4).'

  throw new ReputationAuthorizationError({
    blocker,
    agentId: id,
    submitter: settler.toLowerCase() as Address,
    ...(verdict.agentOwner ? { agentOwner: verdict.agentOwner } : {}),
    message:
      `giveFeedback would revert ("Self-feedback not allowed"): submitter ` +
      `${settler.toLowerCase()} cannot rate agentId ${id} because ${detail}` +
      (verdict.agentOwner ? ` (current owner: ${verdict.agentOwner})` : '') +
      `. ${remedy}`,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Write policy (docs/10 § 5)
// ─────────────────────────────────────────────────────────────────────────────

export type WritePolicy = 'immediate' | 'batch' | 'never'

/**
 * When to write.
 *
 *   - `slashed`   → immediately. That is the signal that carries value.
 *   - `honored`   → in batches. Writing on every settlement would double the
 *                   transaction count for a signal that is barely informative
 *                   taken in isolation.
 *   - `reclaimed` → **never**. An expired warrant is nobody's fault; rating our
 *                   own infrastructure's failure negatively would turn Warrant
 *                   into a vector of disparagement.
 */
export function writePolicyFor(verdict: WarrantVerdict): WritePolicy {
  switch (verdict) {
    case 'slashed':
      return 'immediate'
    case 'honored':
      return 'batch'
    case 'reclaimed':
      return 'never'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishVerdictOptions extends BuildFeedbackOptions {
  reputationRegistry: Address
  walletClient: ReputationWalletClient
  publicClient: ReputationPublicClient
  chain?: unknown
  /** URI base of the verdict document. */
  feedbackURIBase?: string
  /** Explicit URI, when the document is not served at the default location. */
  feedbackURI?: string
  /**
   * `auto` (the default) applies docs/10 § 5: immediate on `slashed`, deferred on
   * `honored`, never on `reclaimed`. `immediate` forces the write of an isolated
   * `honored` — and **cannot** force that of a `reclaimed`.
   */
  mode?: 'auto' | 'immediate'
  /**
   * Short-circuits the onchain pre-check. To be used only when authorization has
   * just been verified for the same (agentId, settler) pair.
   */
  skipAuthorizationCheck?: boolean
}

export type PublishSkipReason =
  /** `reclaimed` verdict: no write, ever. */
  | 'reclaimed'
  /** `honored` verdict: the document is ready, the write goes out with the batch. */
  | 'batched'

export type PublishResult =
  | {
      written: true
      txHash: Hex
      feedbackURI: string
      feedbackHash: Hex
      document: FeedbackDocument
      args: GiveFeedbackArgs
    }
  | {
      written: false
      reason: PublishSkipReason
      /** Absent on `reclaimed`: there is nothing to publish, now or later. */
      document?: SingleFeedbackDocument
      feedbackURI?: string
      feedbackHash?: Hex
    }

/**
 * Inscribes a verdict into the Reputation Registry.
 *
 * The order is this one, and it matters:
 *   1. write policy — a `reclaimed` stops here;
 *   2. construction of the normalised document and of its `feedbackHash`;
 *   3. verification that the Settler can rate this agent;
 *   4. `giveFeedback`, eight arguments, from the Settler's address.
 */
export async function publishVerdict(
  verdictDocument: PublishableVerdictDocument,
  opts: PublishVerdictOptions,
): Promise<PublishResult> {
  const policy = writePolicyFor(verdictDocument.verdict)

  // 1. `reclaimed`: nothing, whatever the mode. Non-negotiable.
  if (policy === 'never') {
    return { written: false, reason: 'reclaimed' }
  }

  // 2. The document and its commitment.
  const document = buildFeedbackDocument(verdictDocument, opts)
  const feedbackHash = feedbackHashOf(document)
  const feedbackURI =
    opts.feedbackURI ??
    feedbackUriFor(document.warrant.warrantId, opts.feedbackURIBase)

  if (policy === 'batch' && (opts.mode ?? 'auto') === 'auto') {
    return { written: false, reason: 'batched', document, feedbackURI, feedbackHash }
  }

  // 3. Can the Settler rate this agent?
  if (!opts.skipAuthorizationCheck) {
    await assertCanGiveFeedback(opts.agentId, opts.settler, {
      publicClient: opts.publicClient,
      identityRegistry: opts.identityRegistry,
    })
  }

  // 4. The write. The account used *is* the proof of origin: no signature is
  //    attached to an ERC-8004 feedback.
  const args = giveFeedbackArgs({
    agentId: opts.agentId,
    verdict: document.tag2,
    feedbackURI,
    feedbackHash,
  })

  const txHash = await opts.walletClient.writeContract({
    address: opts.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args,
    account: opts.settler,
    chain: opts.chain,
  })

  return { written: true, txHash, feedbackURI, feedbackHash, document, args }
}

/** Inscribes a batch of honored warrants as a single aggregated feedback. */
export async function publishBatch(
  verdictDocuments: readonly PublishableVerdictDocument[],
  opts: PublishVerdictOptions & {
    proofsByWarrantId?: Readonly<Record<string, ProofOfPayment>>
  },
): Promise<PublishResult> {
  const document = buildBatchFeedbackDocument(verdictDocuments, opts)
  const feedbackHash = feedbackHashOf(document)
  const feedbackURI =
    opts.feedbackURI ?? batchFeedbackUriFor(feedbackHash, opts.feedbackURIBase)

  if (!opts.skipAuthorizationCheck) {
    await assertCanGiveFeedback(opts.agentId, opts.settler, {
      publicClient: opts.publicClient,
      identityRegistry: opts.identityRegistry,
    })
  }

  const args = giveFeedbackArgs({
    agentId: opts.agentId,
    verdict: 'honored',
    feedbackURI,
    feedbackHash,
  })

  const txHash = await opts.walletClient.writeContract({
    address: opts.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args,
    account: opts.settler,
    chain: opts.chain,
  })

  return { written: true, txHash, feedbackURI, feedbackHash, document, args }
}

// ─────────────────────────────────────────────────────────────────────────────
// The batch
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchPolicy {
  /** Number of honored warrants beyond which the batch goes out. */
  maxBatchSize: number
  /** Age of the oldest pending warrant beyond which the batch goes out. */
  maxAgeMs: number
}

/** "every N executions or every 24 h" (docs/10 § 5). */
export const DEFAULT_BATCH_POLICY: BatchPolicy = {
  maxBatchSize: 25,
  maxAgeMs: 24 * 60 * 60 * 1000,
}

interface Pending {
  documents: PublishableVerdictDocument[]
  oldestAt: number
}

/**
 * Queue of honored warrants, keyed by `agentId`.
 *
 * Deliberately in memory and free of I/O: the Settler persists it if it wants to.
 * What it guarantees is that nothing other than an `honored` gets in — a slash is
 * written immediately, a `reclaimed` is never written.
 */
export class VerdictBatcher {
  readonly policy: BatchPolicy
  private readonly clock: () => number
  private readonly queues = new Map<string, Pending>()

  constructor(policy: Partial<BatchPolicy> = {}, clock: () => number = Date.now) {
    this.policy = { ...DEFAULT_BATCH_POLICY, ...policy }
    this.clock = clock
  }

  /** @throws {ReputationError} if the verdict is not `honored`. */
  enqueue(agentId: bigint | number, doc: PublishableVerdictDocument): void {
    if (doc.verdict !== 'honored') {
      throw new ReputationError(
        `only honored warrants are batched; got '${doc.verdict}' ` +
          '(a slash is written immediately, an expiry is never written)',
      )
    }
    const key = BigInt(agentId).toString()
    const q = this.queues.get(key)
    if (q) q.documents.push(doc)
    else this.queues.set(key, { documents: [doc], oldestAt: this.clock() })
  }

  size(agentId: bigint | number): number {
    return this.queues.get(BigInt(agentId).toString())?.documents.length ?? 0
  }

  /** The `agentId` values whose batch has reached the trigger size or age. */
  due(): bigint[] {
    const now = this.clock()
    const out: bigint[] = []
    for (const [key, q] of this.queues) {
      if (
        q.documents.length >= this.policy.maxBatchSize ||
        now - q.oldestAt >= this.policy.maxAgeMs
      ) {
        out.push(BigInt(key))
      }
    }
    return out
  }

  /** Empties an agent's queue and returns the pending documents. */
  drain(agentId: bigint | number): PublishableVerdictDocument[] {
    const key = BigInt(agentId).toString()
    const q = this.queues.get(key)
    if (!q) return []
    this.queues.delete(key)
    return q.documents
  }

  /** Every `agentId` with at least one pending warrant. */
  agents(): bigint[] {
    return [...this.queues.keys()].map((k) => BigInt(k))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity — optional, never blocking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `IdentityRegistry.register` **mints the NFT to `msg.sender`**: there is no
 * `registerFor(owner, …)` overload. Warrant therefore cannot register an agent
 * "on its behalf" from its own address without becoming its owner — which would
 * then forbid the Settler from ever rating it.
 *
 * The consequence we accept: Warrant **prepares** the transaction, the agent
 * sends it. That is what this function returns — a `{ to, data }` for the agent to
 * sign.
 */
export function buildAgentRegistration(opts: {
  identityRegistry?: Address
  agentURI: string
  escrow?: Address
  since?: number
}): { to: Address; data: Hex; value: 0n; note: string } {
  const metadata: { metadataKey: string; metadataValue: Hex }[] = []
  if (opts.escrow) {
    metadata.push({
      metadataKey: METADATA_KEYS.escrow,
      metadataValue: stringToHex(opts.escrow.toLowerCase()),
    })
  }
  if (opts.since !== undefined) {
    metadata.push({
      metadataKey: METADATA_KEYS.since,
      metadataValue: stringToHex(String(opts.since)),
    })
  }

  const to = (opts.identityRegistry ?? ERC8004.mainnet.identity) as Address
  return {
    to,
    data: encodeFunctionData({
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [opts.agentURI, metadata],
    }),
    value: 0n,
    note:
      'this transaction must be sent by the agent itself: `register` mints the ' +
      'NFT to `msg.sender`, and an agent that Warrant owned could never again be ' +
      'rated by the Settler (docs/10 § 4)',
  }
}

/**
 * Calldata for updating the Warrant metadata.
 *
 * `setMetadata` is open only to the owner and to operators: these calls, too, are
 * for the agent to send, not Warrant. The values are UTF-8 strings — the spec
 * fixes no encoding for `bytes metadataValue`, and a string stays readable as-is
 * in an explorer.
 */
export function buildWarrantMetadataCalls(opts: {
  identityRegistry?: Address
  agentId: bigint | number
  escrow: Address
  since: number
}): { to: Address; data: Hex; key: string }[] {
  const to = (opts.identityRegistry ?? ERC8004.mainnet.identity) as Address
  const id = BigInt(opts.agentId)
  const entries: [string, string][] = [
    [METADATA_KEYS.escrow, opts.escrow.toLowerCase()],
    [METADATA_KEYS.since, String(opts.since)],
  ]
  return entries.map(([key, value]) => ({
    to,
    key,
    data: encodeFunctionData({
      abi: identityRegistryAbi,
      functionName: 'setMetadata',
      args: [id, key, stringToHex(value)],
    }),
  }))
}

export type IdentityStatus =
  /** The agent has a usable `agentId` and the Settler can rate it. */
  | { status: 'usable'; agentId: bigint }
  /** The agent has an `agentId`, but the Settler cannot rate it. */
  | { status: 'unnotable'; agentId: bigint; reason: string }
  /** No ERC-8004 identity. Warrant works all the same. */
  | { status: 'absent'; reason: string }
  /** The chain did not answer. We infer nothing from it. */
  | { status: 'unavailable'; reason: string }

/**
 * Establishes what can be done with an agent's ERC-8004 identity, **without ever
 * throwing**. An agent can use Warrant with no ERC-8004 identity: it simply will
 * not have a reputation trace. None of these situations must prevent a warrant
 * from opening or from settling.
 */
export async function inspectAgentIdentity(
  agentId: bigint | number | undefined,
  settler: Address,
  ctx: IdentityContext,
): Promise<IdentityStatus> {
  if (agentId === undefined || agentId === null) {
    return {
      status: 'absent',
      reason: 'no agentId supplied — the ERC-8004 identity is optional',
    }
  }
  const id = BigInt(agentId)
  try {
    const verdict = await canGiveFeedback(id, settler, ctx)
    if (verdict.ok) return { status: 'usable', agentId: id }
    if (verdict.blocker === 'agent-not-registered') {
      return { status: 'absent', reason: `agentId ${id} unknown to the IdentityRegistry` }
    }
    if (verdict.blocker === 'unknown') {
      return {
        status: 'unavailable',
        reason: `inconclusive onchain check for agentId ${id}`,
      }
    }
    return {
      status: 'unnotable',
      agentId: id,
      reason:
        `the Settler ${settler.toLowerCase()} is ${verdict.blocker} of agentId ` +
        `${id}: no verdict will be inscribable`,
    }
  } catch (e) {
    return { status: 'unavailable', reason: errText(e) }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
