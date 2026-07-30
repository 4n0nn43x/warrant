/**
 * Registering an agent's ERC-8004 identity — an operations tool.
 *
 * This script is the piece without which the whole ERC-8004 surface of the
 * repository stays inert. `reputation.ts` knows how to build the feedback
 * document, compute its `feedbackHash` and call `giveFeedback`; `daemon.ts` knows
 * when to write. But `giveFeedback` takes an `agentId`, and that `agentId` only
 * exists if somebody called `IdentityRegistry.register`. Nobody was doing it. The
 * Settler therefore settled warrants and skipped the record with, on every pass,
 * the same reason: "no ERC-8004 agentId known for this agent".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why it is the agent that signs, and never Warrant
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `register` mints the NFT to the benefit of `msg.sender` — there exists no
 * `registerFor(owner, …)` overload. If Warrant registered the agent from one of
 * its own addresses, Warrant would become its owner, and
 * `ReputationRegistry.giveFeedback` would then refuse **forever** every verdict
 * issued by the Settler: the registry requires
 * `!isAuthorizedOrOwner(msg.sender, agentId)` (ReputationRegistryUpgradeable.sol:110).
 * A badly registered identity is therefore irreparable — you cannot "hand back"
 * the token and start again without minting a second one and abandoning the
 * first.
 *
 * Hence the shape of this script: it **prepares** the transaction with
 * `buildAgentRegistration` — the same function as the one tested in
 * `reputation.test.ts`, not a reimplementation — and has it signed by the agent's
 * key (`OPENER_PRIVATE_KEY`, the only key in the repository that belongs to the
 * agent). Then it **verifies**, once the token is minted, that the Settler is
 * neither owner nor operator. That verification is not decorative: it is the only
 * one that tells a usable identity from an identity that will make every
 * `giveFeedback` revert until the end of time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The chain, and the mistake we will not make twice
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An `agentId` only means something on the chain where it was minted: it is an
 * ERC-721 `tokenId`. This repository's identity table contained an `agentId`
 * registered on Ethereum Sepolia while the escrow, the bond and the Settler live
 * on Base Sepolia — hence an identifier that designated nothing, and an `ownerOf`
 * that reverted. This script refuses any chain divergence, and re-checks the
 * `chainId` the RPC actually answers before sending anything at all. An identity
 * minted on the wrong chain costs gas and does not get corrected.
 *
 * Usage:
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
// Environment and arguments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One canonical name per variable, **no alias** — the `.env.example` convention,
 * taken as-is from `bin/settler.ts` and `bin/open-warrant.ts`. These readers are
 * duplicated in every binary because an operations binary must stay readable on
 * its own; factoring them into a shared module would make the tool depend on a
 * file one would re-read anyway.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `missing environment variable: ${name} — ` +
        'see packages/server/src/bin/register-agent.ts',
    )
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Every address is brought down to lowercase.
 *
 * This is not cosmetic: viem validates the EIP-55 checksum and **rejects** an
 * address whose case does not match — the vanity-prefixed ERC-8004 addresses as
 * they circulate (`0x8004A818BFb912233C491871b3d84C89A494Bd9e`) do not have a
 * valid checksum and make `readContract` fail before even reaching the network.
 * The constants in `@warrant/core` are lowercase for the same reason.
 */
function address(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name}: EVM address expected, got "${value}"`)
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

/** Structured log, one JSON line per event. Never a secret. */
function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

/**
 * Known chains, table aligned with `bin/settler.ts`.
 *
 * ⚠ It is deliberately duplicated, but it must remain **at most as permissive**
 * as the Settler's: allowing a chain here that the Settler refuses would produce
 * an identity minted for nothing.
 */
const CHAINS = { 1: mainnet, 8453: base, 84532: baseSepolia, 11155111: sepolia } as const

/** Same set as `bin/settler.ts`: outside it, the chain is a mainnet. */
const TESTNET_CHAIN_IDS = new Set([11155111, 84532, 421614, 11155420, 17000, 80002, 97])

// ─────────────────────────────────────────────────────────────────────────────
// The `agent address → agentId` table
// ─────────────────────────────────────────────────────────────────────────────

/** File name of the table. The Settler knows only its full path. */
export const AGENT_IDS_BASENAME = 'agent-ids.json'

export interface AgentIdsFileLocation {
  /** Absolute path, resolved. This is what must figure in `.env`. */
  path: string
  /** What decided this path — the only useful diagnostic information. */
  source: 'ERC8004_AGENT_IDS_FILE' | 'WARRANT_JOURNAL_FILE' | 'default'
}

/**
 * Where the table lives.
 *
 * `bin/settler.ts` reads the table **only** if `ERC8004_AGENT_IDS_FILE` is set:
 * without it, `loadAgentIds()` returns `undefined`, no `agentId` is resolved, and
 * the record is skipped on every warrant. The variable is therefore not a
 * setting, it is the switch for the entire ERC-8004 surface.
 *
 * In its absence, this script writes **next to the warrant ledger**, and that is
 * an argued choice: the table and the ledger are read by the same process, and
 * `WARRANT_JOURNAL_FILE` is already an absolute path precisely because a relative
 * path resolved against each process's current directory — the Gateway wrote one
 * ledger, the Settler read another. The table would inherit the same trap, and
 * worse: its absence breaks nothing visible, it merely leaves reputation silently
 * empty. The default chosen therefore ensures that the `.env` line to add points
 * at exactly the file this script has just written.
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

/** The exact line to paste into `.env`. This script never modifies `.env`. */
export function envLineFor(path: string): string {
  return `ERC8004_AGENT_IDS_FILE=${path}`
}

/** Table read from disk. A missing file is an empty table, not an error. */
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
    // `BigInt(value)` validates along the way: a non-integer value would make
    // `loadAgentIds()` throw at the Settler's startup, that is to say too late.
    out[key.toLowerCase()] = BigInt(value).toString(10)
  }
  return out
}

/**
 * Inserts or replaces an agent's entry, without touching the others.
 *
 * The replacement is deliberate: a stale entry — an `agentId` minted on another
 * chain, for instance — is precisely what we have come to fix. Keeping it would
 * serve only to have the Settler go on reading a false value. `main()` never
 * replaces an entry, however, without first having confronted it with the chain
 * (`inspectAgentIdentity`).
 */
export function upsertAgentId(
  table: Readonly<Record<string, string>>,
  agent: Address,
  agentId: bigint,
): Record<string, string> {
  return { ...table, [agent.toLowerCase()]: agentId.toString(10) }
}

/**
 * Atomic write: temporary file then `rename`. The Settler may be reading this
 * file at the same instant — it re-reads it at every startup — and a truncated
 * JSON would make it fail at startup rather than simply skip the record.
 *
 * Two spaces of indentation and a trailing newline: this file is also edited by
 * hand, and a single 400-character line does not read.
 */
export function writeAgentIds(path: string, table: Readonly<Record<string, string>>): void {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = `${JSON.stringify(table, null, 2)}\n`
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, 'utf8')
  renameSync(temp, path)
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the minted `agentId`
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisteredLog {
  address?: string
  topics: readonly string[]
  data: string
}

/**
 * Extracts the `agentId` from the receipt's `Registered` event.
 *
 * We do not settle for `register`'s return value: a transaction sent with
 * `sendTransaction` returns no return data, and a simulation done **before**
 * sending can be invalidated by another registration arriving in the meantime —
 * the `agentId` is a counter. The receipt is the only source that says what was
 * actually minted.
 *
 * Filtering by address matters: the registry is an ERC-721, it also emits
 * `Transfer` and possibly `MetadataSet` in the same transaction, and one
 * transaction could touch several contracts.
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
      `no Registered event emitted by ${registry} in this receipt: the token was not ` +
        'minted, or the ABI of the current implementation has diverged from the one ' +
        'frozen in reputation.ts (the registries are upgradeable)',
    )
  }
  return (first.args as { agentId: bigint }).agentId
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainDecision {
  escrowChainId: number
  erc8004ChainId: number
  /** `undefined` when nothing forbids writing on this chain. */
  refusal?: string
}

/**
 * Which chain to register on, and must we refuse?
 *
 * Two refusals, both taken from `bin/settler.ts` so that the tool cannot produce
 * an identity the Settler will ignore:
 *
 *   • **chain divergence** — the Settler "signs on one chain at a time only" and
 *     refuses to write if `ERC8004_CHAIN_ID` differs from the escrow's chain.
 *     Minting a token elsewhere amounts to paying gas for an identifier nothing
 *     will read; that is exactly what happened with Ethereum Sepolia's `agentId`
 *     8986;
 *   • **mainnet refused by default** — the list of mainnets is open-ended, the
 *     list of testnets we use is not. A mainnet identity is a permanent public
 *     trace and must not go out by inheritance of a variable.
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
      refusal: `chain ${erc8004ChainId} unknown to the CHAINS table: accepted values ${Object.keys(CHAINS).join(', ')}`,
    }
  }
  if (erc8004ChainId !== escrowChainId) {
    return {
      escrowChainId,
      erc8004ChainId,
      refusal:
        `ERC8004_CHAIN_ID=${erc8004ChainId} ≠ escrow chain ${escrowChainId}: ` +
        'the Settler signs on one chain at a time only and would write no ' +
        `feedback for an agentId minted on ${erc8004ChainId}. An agentId is an ` +
        'ERC-721 tokenId: it designates nothing outside its chain of origin.',
    }
  }
  if (!TESTNET_CHAIN_IDS.has(erc8004ChainId) && !allowMainnet) {
    return {
      escrowChainId,
      erc8004ChainId,
      refusal:
        `chain ${erc8004ChainId} treated as a mainnet: registration refused ` +
        'without ERC8004_ALLOW_MAINNET=1 (or --allow-mainnet). A mainnet identity is ' +
        'a permanent public trace.',
    }
  }
  return { escrowChainId, erc8004ChainId }
}

// ─────────────────────────────────────────────────────────────────────────────
// The agent card's URI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default `agentURI`.
 *
 * The spec wants a URI that serves the agent's card. Nothing in this repository
 * serves such a card today — and we would rather write that here than let anyone
 * believe otherwise: the URI is therefore derived from `VERDICT_BASE_URI`, the
 * only public base the project already announces, and stays overridable through
 * `--agent-uri` / `ERC8004_AGENT_URI`. It enters no hash and nothing fails if it
 * does not resolve yet; what *would* fail, on the other hand, is changing it
 * after the fact in the belief that `register` can be replayed.
 */
export function defaultAgentUri(agent: Address, verdictBaseUri: string): string {
  const base = verdictBaseUri.replace(/\/v\/?$/, '/').replace(/\/?$/, '/')
  return `${base}agents/${agent.toLowerCase()}.json`
}

// ─────────────────────────────────────────────────────────────────────────────
// The sequence
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Same fallback as `bin/settler.ts`: the npm script loads `../../.env` via
  // `node --env-file-if-exists`, this loop covers the direct launch.
  for (const candidate of [optional('WARRANT_ENV_FILE', ''), '.env', '../../.env']) {
    if (!candidate) continue
    try {
      process.loadEnvFile(candidate)
      break
    } catch {
      // Absent or unreadable: on to the next, then the process environment is
      // authoritative.
    }
  }

  const dryRun = switchOn('dry-run')
  const force = switchOn('force')

  // ── 1. The chain, before everything else ───────────────────────────────────
  const decision = decideChain(process.env, process.argv)
  if (decision.refusal) throw new Error(decision.refusal)
  const chainId = decision.erc8004ChainId
  const chain = CHAINS[chainId as keyof typeof CHAINS]!

  const rpc = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])
  const publicClient = createPublicClient({ chain, transport: http(rpc) })

  const observedChainId = await publicClient.getChainId()
  if (observedChainId !== chainId) {
    throw new Error(
      `RPC ${rpc} answers chainId ${observedChainId}, while the configuration ` +
        `announces ${chainId}: the token would be minted on the wrong chain, and an ` +
        'agentId minted elsewhere does not get corrected',
    )
  }

  // ── 2. Registries ──────────────────────────────────────────────────────────
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
      `no code at ${identityRegistry} on chain ${chainId}: there is no ERC-8004 ` +
        'IdentityRegistry at this address',
    )
  }

  /**
   * The `ReputationRegistry` carries the address of the identity registry it
   * consults, and it is **that one** that will decide whether the Settler can
   * rate. Registering in a registry other than that one would give an `agentId`
   * that `giveFeedback` would look up elsewhere: `ownerOf` would revert, and the
   * transaction would fail without anything in our table looking wrong.
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
      `ReputationRegistry ${reputationRegistry} consults IdentityRegistry ` +
        `${boundIdentity}, not ${identityRegistry}: an agentId minted here would not ` +
        'be the one giveFeedback would check',
    )
  }

  // ── 3. The agent and the Settler ───────────────────────────────────────────
  /**
   * `OPENER_PRIVATE_KEY` is the agent's key.
   *
   * The name comes from an earlier topology where it signed `open()`; ever since
   * the `opener` role became the KeeperHub wallet, its only use is to sign what
   * belongs to the agent — the EIP-3009 authorization in `open-warrant.ts`, and
   * here its own registration. No other key in the repository can do it in its
   * place: the NFT's owner will be `msg.sender`.
   */
  const agentAccount = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as Hex)
  const agent = agentAccount.address.toLowerCase() as Address
  const escrow = address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS'))

  /**
   * The Settler is read **from the escrow**, not derived from
   * `SETTLER_PRIVATE_KEY`.
   *
   * Two reasons. The first is a matter of principle: a tool that has no reason to
   * sign on the Settler's behalf has no reason to know its secret. The second is
   * that the onchain `settler()` is the only address that counts — it is the one
   * that will be able to call `honor`/`slash`, hence the one that will write the
   * feedbacks, and `bin/settler.ts` refuses to start if the configured key
   * diverges from it.
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
      `the Settler and the agent are the same address (${agent}): giveFeedback ` +
        'would revert with "Self-feedback not allowed" for every verdict, and no ' +
        'identity would change anything about it (invariant I10)',
    )
  }

  // ── 4. The table ───────────────────────────────────────────────────────────
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
   * An entry already present is confronted with the chain before any decision.
   *
   * `inspectAgentIdentity` never throws and distinguishes the four situations
   * that count — and they call for three different courses of action:
   *
   *   • `usable`      → there is nothing to do, and minting a second token would
   *                     be gas spent to leave the first one orphaned;
   *   • `absent`      → the entry designates nothing on this chain (the case of
   *                     the `agentId` 8986 minted on Ethereum Sepolia). We
   *                     register and replace;
   *   • `unnotable`   → the token exists but the Settler is owner or operator of
   *                     it. Irreparable on that token: we mint a fresh one, of
   *                     which the agent will be owner;
   *   • `unavailable` → the RPC did not answer. We conclude nothing and overwrite
   *                     nothing: it is the same rule as the Settler's, "when in
   *                     doubt, do not write".
   */
  if (known !== undefined) {
    const status = await inspectAgentIdentity(BigInt(known), settler, {
      publicClient: publicClient as never,
      identityRegistry,
    })
    log({ msg: 'known identity: onchain state', agentId: known, status })

    if (status.status === 'usable' && !force) {
      log({
        msg: 'nothing to register',
        agentId: known,
        detail:
          `agentId ${known} exists on chain ${chainId} and the Settler ${settler} ` +
          'can rate it. --force would mint a second token, which would leave the ' +
          'first one orphaned without improving anything.',
      })
      // We re-verify all the same, in full: relaunching the tool is the natural
      // gesture for finding out whether the registration is in working order, and
      // a "nothing to do" answer without proof is worth nothing.
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
        `the state of agentId ${known} could not be established (${status.reason}): we ` +
          'do not overwrite an existing entry on an inconclusive read. ' +
          'Retry when the RPC answers, or force it with --force.',
      )
    }
  }

  // ── 5. The transaction, prepared by `reputation.ts` ────────────────────────
  const verdictBaseUri = optional('VERDICT_BASE_URI', 'https://warrant.sh/v/')
  const agentUri = arg('agent-uri', optional('ERC8004_AGENT_URI', defaultAgentUri(agent, verdictBaseUri)))
  /**
   * `since` comes from the last block's timestamp, not from the local clock: the
   * metadata must be comparable to what a third party reads from the chain, and a
   * skewed machine clock would produce a date earlier than the registration
   * itself.
   */
  const since = Number((await publicClient.getBlock({ blockTag: 'latest' })).timestamp)

  const registration = buildAgentRegistration({
    identityRegistry,
    agentURI: agentUri,
    escrow,
    since,
  })
  log({
    msg: 'transaction prepared',
    to: registration.to,
    value: registration.value,
    agentURI: agentUri,
    metadata: [METADATA_KEYS.escrow, METADATA_KEYS.since],
    since,
    calldataBytes: (registration.data.length - 2) / 2,
    note: registration.note,
  })

  /**
   * Simulation before sending, on **the exact bytes** that will go out.
   *
   * `eth_call` on the constructed calldata, and not `simulateContract` on
   * reconstructed arguments: what is tested must be what is signed. The return
   * value gives the expected `agentId` — useful to display, but never taken as
   * truth: the counter can advance between the simulation and inclusion. What the
   * simulation guarantees is that we do not pay gas for a revert.
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
      `agent ${agent} has ${balance} wei and the registration costs ${gas * gasPrice} wei: ` +
        'the transaction would not go out. `pnpm faucet` funds Base Sepolia ' +
        '(capped per 24 h).',
    )
  }

  if (dryRun) {
    log({
      msg: '--dry-run: nothing sent',
      to: registration.to,
      data: registration.data,
      value: registration.value,
      predictedAgentId: predicted ?? null,
    })
    return
  }

  // ── 6. The send, signed by the agent ──────────────────────────────────────
  const wallet = createWalletClient({ account: agentAccount, chain, transport: http(rpc) })
  const txHash = await wallet.sendTransaction({
    to: registration.to,
    data: registration.data,
    value: registration.value,
  })
  log({ msg: 'registration sent', txHash })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 })
  if (receipt.status !== 'success') {
    throw new Error(
      `registration transaction ${txHash} failed (status=${receipt.status}): ` +
        'no agentId minted, the table is left intact',
    )
  }

  const agentId = agentIdFromLogs(receipt.logs as never, identityRegistry)
  log({
    msg: 'agentId minted',
    agentId,
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    ...(predicted !== undefined && predicted !== agentId
      ? {
          warning:
            `the simulation predicted ${predicted}: another registration was ` +
            'included in the meantime. The receipt is authoritative.',
        }
      : {}),
  })

  // ── 7. The table, written before the verification ────────────────────────
  //    The order is deliberate: the token is minted, it does not get un-minted.
  //    Losing the `agentId` because a read verification failed just afterwards
  //    would force a sweep of the logs to find it again.
  const updated = upsertAgentId(table, agent, agentId)
  writeAgentIds(location.path, updated)
  log({
    msg: 'table written',
    path: location.path,
    entries: Object.keys(updated).length,
    ...(known !== undefined && known !== agentId.toString(10) ? { replaced: known } : {}),
  })

  // ── 8. The verification that decides everything ───────────────────────────
  await assertNotable(publicClient, {
    agentId,
    agent,
    settler,
    identityRegistry,
    chainId,
    location,
    /**
     * The node must first see the receipt's block.
     *
     * `waitForTransactionReceipt` returned, so **one** node had the transaction;
     * nothing guarantees the next one has it, a public RPC being a load balancer
     * in front of unevenly up-to-date nodes. Without this wait, `ownerOf` reverts
     * with `ERC721NonexistentToken` on a token that nonetheless exists — which is
     * exactly what happened at the first real registration, a few seconds after
     * inclusion at block 44805365.
     */
    minBlock: receipt.blockNumber,
  })
}

/**
 * Verifies that an `agentId` is **rateable** by the Settler, and throws
 * otherwise.
 *
 * It is the only thing that tells a usable identity from an identity that will
 * make every `giveFeedback` revert: `ReputationRegistry` requires
 * `!isAuthorizedOrOwner(msg.sender, agentId)`. So we read that predicate **as
 * it stands**, on the chain, rather than settle for a piece of reasoning — "the
 * owner is the agent, therefore the Settler is not" would be true of `ownerOf`
 * and silent on `approve` and `setApprovalForAll`. `inspectAgentIdentity` then
 * covers the three branches at once and returns a readable state, including when
 * the direct read is inconclusive.
 *
 * Called at the two places that need it: after a registration, and when the tool
 * is relaunched on an already-known identity.
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
   * The two reads that decide are retried.
   *
   * Both of them revert with `ERC721NonexistentToken` on a lagging node, and a
   * revert is indistinguishable from a genuine "this token does not exist". A read
   * failure must not conclude in "unusable identity" when the token has just been
   * minted.
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
    msg: 'onchain verification',
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
      `ownerOf(${agentId}) = ${owner}, expected the agent ${agent}: the NFT was minted ` +
        'to the benefit of somebody else',
    )
  }
  if (authorized) {
    failures.push(
      `isAuthorizedOrOwner(${settler}, ${agentId}) = true: giveFeedback would revert ` +
        'with "Self-feedback not allowed" at every verdict. The Settler must be a ' +
        'third-party address, neither owner, nor operator, nor approved on the token.',
    )
  }
  if (status.status !== 'usable') {
    failures.push(
      `inspectAgentIdentity returns '${status.status}': ${'reason' in status ? status.reason : ''}`,
    )
  }

  if (failures.length > 0) {
    throw new Error(
      `agentId ${agentId} is minted and recorded in the table, but it is NOT ` +
        `rateable:\n  - ${failures.join('\n  - ')}`,
    )
  }

  log({
    msg: 'identity usable',
    agentId,
    detail:
      `the Settler ${settler} can record verdicts for agentId ${agentId} on ` +
      `chain ${opts.chainId}`,
    ...(opts.location.source === 'ERC8004_AGENT_IDS_FILE'
      ? {}
      : {
          envLine: envLineFor(opts.location.path),
          envHint:
            'bin/settler.ts reads the table ONLY if ERC8004_AGENT_IDS_FILE is ' +
            'set: without this line, no agentId will be resolved and the record ' +
            'will stay skipped on every warrant.',
        }),
  })
}

/** Waits for the queried node to announce at least this block. Never blocks forever. */
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
      // A silent node is treated as a lagging node: we retry.
    }
    await sleep(delayMs)
  }
  // We do not fail here: the reads that follow have their own retry, and it is
  // their result — not the announced height — that counts.
  log({
    msg: 'warning: the RPC still announces an earlier block',
    target: target.toString(10),
    detail:
      'the verifications that follow may fail even though the registration is ' +
      'correct; relaunching the command will replay them without minting anything',
  })
}

/** Retries a read. The last failure is propagated as-is. */
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
        log({ msg: `read ${label} failed, retrying`, attempt: i + 1, of: attempts })
        await sleep(delayMs)
      }
    }
  }
  throw last
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** UTF-8 metadata, or `null`. A missing key returns `0x`, which is not an error. */
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
 * `main()` only runs if this file is the entry point: the helpers above are
 * tested, and an `import` from a test must not sign a transaction.
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
        msg: 'registration failed',
        error: e instanceof Error ? e.message : String(e),
      }),
    )
    process.exit(1)
  })
}
