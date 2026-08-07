/**
 * Entry point of the settlement daemon.
 *
 * The component that was missing: without it, warrants open, actions execute, and
 * nothing ever settles. It is the only process in the system that moves funds to
 * a third party, and that is why it carries a key distinct from the Gateway's
 * (invariant I10).
 *
 * What it does, in a loop:
 *
 *   1. sweeps `WarrantOpened` and re-reads `warrants(id)` — the chain is
 *      authoritative;
 *   2. fetches the warrant's spec from the ledger, and **verifies** it against the
 *      onchain commitments before using it;
 *   3. queries the KeeperHub audit trail to locate the transaction;
 *   4. waits for confirmations on an independent RPC, re-evaluates the
 *      post-condition at a pinned block, and calls `decide()`;
 *   5. submits `honor` / `slash`, or abstains and lets `reclaim` refund;
 *   6. publishes the verdict document at a stable URI it serves itself;
 *   7. records the verdict in ERC-8004: immediately on `slashed`, in batches on
 *      `honored`, never on `reclaimed`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What makes startup fail, and why
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A misconfigured settlement daemon is worse than an absent one: it burns gas on
 * transactions that revert, or — far more serious — it judges on false reads.
 * Four checks therefore precede the first loop, and each one is blocking:
 *
 *   • the `chainId` of the escrow's RPC is the one announced;
 *   • the onchain `settler()` **is** the address derived from
 *     `SETTLER_PRIVATE_KEY` — otherwise `honor` and `slash` would revert with
 *     `NotSettler()`;
 *   • the evaluation RPC knows how to answer a **read at a past block**. An
 *     evaluation at a pinned block is, in JSON-RPC terms, an archive request: a
 *     node that refuses them makes every verdict unreplayable and, worse, would
 *     have us judge on reads that are not the ones announced;
 *   • the Settler's gas balance is non-zero, otherwise no settlement will ever go
 *     out.
 *
 * Usage:
 *   pnpm --filter @warrant/server settler
 *   SETTLER_ONCE=1 pnpm --filter @warrant/server settler   # a single pass
 */

import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { ERC8004, type Address, type Hex } from 'warrant-core'
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import { KeeperHubClient } from '../keeperhub.js'
import {
  createSettlementDaemon,
  erc8004Sink,
  journalMandateSource,
  viemEscrowReader,
  type AgentIdResolver,
  type ReputationSink,
} from '../daemon.js'
import { fileWarrantStore } from '../journal.js'
import { VerdictBatcher } from '../reputation.js'
import { createVerdictServer, fileVerdictPublisher } from '../verdicts.js'

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One canonical name per variable, **no alias**: that is the `.env.example`
 * convention, and its reason is that a binary accepting two spellings ends up
 * reading the one that is not filled in.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `missing environment variable: ${name} — ` +
        'see packages/server/src/bin/settler.ts for the full list',
    )
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

function flag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(optional(name, ''))
}

function address(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name}: EVM address expected, got "${value}"`)
  }
  return value.toLowerCase() as Address
}

/**
 * Known chains. The testnets are enumerated explicitly: it is this list that
 * authorizes an ERC-8004 write without further confirmation.
 */
const CHAINS = { 1: mainnet, 8453: base, 84532: baseSepolia, 11155111: sepolia } as const

/**
 * Test chains. Any chain absent from this set is treated as a **mainnet**, and
 * the ERC-8004 write is refused there barring explicit authorization. Refusal by
 * default is deliberate: the list of mainnets is open-ended, the list of testnets
 * we use is not.
 */
const TESTNET_CHAIN_IDS = new Set([11155111, 84532, 421614, 11155420, 17000, 80002, 97])

/**
 * The `agent address → agentId` ERC-8004 table.
 *
 * The `IdentityRegistry` exposes no reverse lookup by owner, and sweeping
 * `Registered` from the genesis block is not practicable on a public RPC. The
 * table is therefore supplied by operations. Its absence prevents nothing: the
 * warrant is settled and the verdict published, only the ERC-8004 record is
 * skipped, with an explicit reason.
 */
function loadAgentIds(): AgentIdResolver | undefined {
  const file = optional('ERC8004_AGENT_IDS_FILE', '')
  if (!file) return undefined
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | number>
  const table = new Map<string, bigint>()
  for (const [key, value] of Object.entries(raw)) {
    table.set(key.toLowerCase(), BigInt(value))
  }
  return (agent: Address) => table.get(agent.toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does the evaluation RPC know how to read **past** state?
 *
 * Many public nodes serve `latest` and refuse archive: the answer is then a
 * JSON-RPC error, not a silence, and it only appears at the first verdict — that
 * is to say, too late. So we probe at startup, on a block old enough to be
 * outside the hot window of a non-archive node.
 *
 * The probe is on `eth_getBalance` and **not** on a call to the escrow. An
 * `eth_call` against the contract conflated two very different failures: "this
 * node refuses archive" and "the contract did not exist yet at that block". A
 * freshly deployed escrow therefore failed startup on a perfectly capable archive
 * node — the message accused the RPC wrongly. An address's balance, on the other
 * hand, is defined at every block since genesis: the failure can no longer mean
 * more than one thing.
 */
async function assertArchiveCapable(
  client: PublicClient,
  escrow: Address,
  depth: bigint,
): Promise<{ probedBlock: bigint }> {
  const head = await client.getBlockNumber()
  const probed = head > depth ? head - depth : 0n
  try {
    await client.getBalance({ address: escrow, blockNumber: probed })
  } catch (e) {
    throw new Error(
      `the evaluation RPC cannot read at a past block (tried at block ${probed}, ` +
        `head ${head}): ${e instanceof Error ? e.message : String(e)}.\n` +
        'Evaluating a post-condition is a read at a pinned block, hence an archive ' +
        'request. On a non-archive node, no verdict is replayable and the Settler ' +
        'would judge on reads that are not the ones announced. ' +
        'Point EVALUATOR_RPC at an archive node (see .env).',
    )
  }
  return { probedBlock: probed }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // The `pnpm settler` script already loads `../../.env` via
  // `node --env-file-if-exists`. This fallback covers the direct launch
  // (`tsx src/bin/settler.ts`): without it, the same file would be loaded in one
  // case and not in the other, and the difference would only show up at the first
  // missing variable. Node ≥ 20.12 can do it with no dependency.
  for (const candidate of [optional('WARRANT_ENV_FILE', ''), '.env', '../../.env']) {
    if (!candidate) continue
    try {
      process.loadEnvFile(candidate)
      break
    } catch {
      // Absent or unreadable: we try the next one, then the process environment
      // is authoritative.
    }
  }

  const escrowChainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', '11155111'))
  const chain = CHAINS[escrowChainId as keyof typeof CHAINS]
  if (!chain) throw new Error(`unsupported WARRANT_ESCROW_CHAIN_ID: ${escrowChainId}`)

  const escrow = address('WARRANT_ESCROW_ADDRESS', required('WARRANT_ESCROW_ADDRESS'))
  const escrowRpc = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])
  /**
   * Evaluation RPC: **independent of KeeperHub**, and published as-is in every
   * verdict. Using the same provider to execute and to judge would reintroduce
   * the circularity the whole project sets out to avoid.
   */
  const evaluatorRpc = optional('EVALUATOR_RPC', escrowRpc)

  const account = privateKeyToAccount(required('SETTLER_PRIVATE_KEY') as Hex)
  const settler = account.address.toLowerCase() as Address

  const escrowClient = createPublicClient({ chain, transport: http(escrowRpc) })
  const actionClient = createPublicClient({ chain, transport: http(evaluatorRpc) })
  const localWallet = createWalletClient({ account, chain, transport: http(escrowRpc) })

  /**
   * The **local** account is re-injected on every write.
   *
   * `SubmitOptions.account` is typed `Address`, and viem treats a bare address as
   * a JSON-RPC account: it then attempts `eth_sendTransaction`, which public nodes
   * do not serve — the settlement transaction would fail with "method is not
   * available", that is to say at the worst possible moment, once the decision has
   * been taken. Re-injecting the `Account` object restores local signing without
   * touching `settler.ts`, whose signature remains correct: the address is indeed
   * what identifies the Settler, it simply is not what signs.
   */
  const walletClient = {
    ...localWallet,
    writeContract: (args: Record<string, unknown>) =>
      localWallet.writeContract({ ...args, account } as never),
  } as unknown as ReturnType<typeof createWalletClient>

  // ── Blocking checks ────────────────────────────────────────────────────────
  const observedChainId = await escrowClient.getChainId()
  if (observedChainId !== escrowChainId) {
    throw new Error(
      `RPC ${escrowRpc} answers chainId ${observedChainId}, while ` +
        `WARRANT_ESCROW_CHAIN_ID announces ${escrowChainId}: a settlement would go out on the wrong chain`,
    )
  }

  const onchainSettler = (await escrowClient.readContract({
    address: escrow,
    abi: warrantEscrowAbi,
    functionName: 'settler',
  })) as Address
  if (onchainSettler.toLowerCase() !== settler) {
    throw new Error(
      `onchain settler() is ${onchainSettler}, the configured key is ${settler}: ` +
        'honor and slash would revert with NotSettler(). Nothing would ever be settled.',
    )
  }

  const probe = await assertArchiveCapable(
    actionClient as PublicClient,
    escrow,
    BigInt(optional('SETTLER_ARCHIVE_PROBE_DEPTH', '5000')),
  )

  const gas = await escrowClient.getBalance({ address: settler })
  if (gas === 0n) {
    throw new Error(
      `Settler ${settler} has no gas on chain ${escrowChainId}: ` +
        'no settlement transaction could be broadcast',
    )
  }

  // ── Ledger, verdicts, ERC-8004 ─────────────────────────────────────────────
  const journal = fileWarrantStore({
    path: optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl'),
  })

  const port = Number(optional('SETTLER_PORT', '8403'))
  const verdictBaseUri = optional('VERDICT_BASE_URI', `http://localhost:${port}/v/`)
  const verdictDir = optional('VERDICT_DIR', '.warrant/verdicts')
  const publisher = fileVerdictPublisher({ dir: verdictDir, baseUri: verdictBaseUri })

  const erc8004ChainId = Number(optional('ERC8004_CHAIN_ID', String(escrowChainId)))
  const isTestnet = TESTNET_CHAIN_IDS.has(erc8004ChainId)
  const registries = isTestnet ? ERC8004.testnet : ERC8004.mainnet
  const identityRegistry = address(
    'ERC8004_IDENTITY',
    optional('ERC8004_IDENTITY', registries.identity),
  )
  const reputationRegistry = address(
    'ERC8004_REPUTATION',
    optional('ERC8004_REPUTATION', registries.reputation),
  )

  /**
   * Refusal by default on mainnet.
   *
   * An ERC-8004 write is a real transaction, with a real cost and a permanent
   * public trace. Nothing here must be able to go out on a mainnet by mere
   * inheritance of an environment variable.
   */
  const mainnetBlocked = !isTestnet && !flag('ERC8004_ALLOW_MAINNET')
  const erc8004Enabled =
    !flag('ERC8004_DISABLED') && erc8004ChainId === escrowChainId && !mainnetBlocked

  const reputation: ReputationSink | undefined = erc8004Enabled
    ? erc8004Sink({
        chainId: erc8004ChainId,
        identityRegistry,
        reputationRegistry,
        settler,
        publicClient: escrowClient as never,
        walletClient: walletClient as never,
        chain,
        publisher,
        batcher: new VerdictBatcher({
          maxBatchSize: Number(optional('ERC8004_BATCH_SIZE', '25')),
          maxAgeMs: Number(optional('ERC8004_BATCH_MAX_AGE_MS', String(24 * 60 * 60 * 1000))),
        }),
        feedbackURIBase: verdictBaseUri,
        logger: emit,
      })
    : undefined

  const kh = new KeeperHubClient({
    apiKey: required('KH_API_KEY'),
    baseUrl: optional('KH_BASE_URL', 'https://app.keeperhub.com'),
  })

  /**
   * First block swept.
   *
   * With no explicit value, we do not restart from block 0: a warrant lives at
   * most `MAX_DURATION` = 7 days (WarrantEscrow.sol), so **no** warrant older
   * than that window can still be in `Open` status. Sweeping beyond it would cost
   * hundreds of `eth_getLogs` requests at every startup to discover nothing
   * settleable. 60,000 blocks cover 7 days on a chain with 12 s blocks, with room
   * to spare.
   */
  const head = await escrowClient.getBlockNumber()
  const lookback = BigInt(optional('SETTLER_LOOKBACK_BLOCKS', '60000'))
  const fromBlock = process.env['SETTLER_FROM_BLOCK']
    ? BigInt(required('SETTLER_FROM_BLOCK'))
    : head > lookback
      ? head - lookback
      : 0n
  const daemon = createSettlementDaemon({
    escrow,
    chainId: escrowChainId,
    settler,
    identityRegistry,
    reader: viemEscrowReader({
      client: escrowClient,
      address: escrow,
      fromBlock,
      chunkBlocks: BigInt(optional('SETTLER_LOG_CHUNK', '9000')),
      onScanError: (error) => emit({ msg: 'settler: incomplete sweep', error }),
    }),
    mandates: journalMandateSource(journal, loadAgentIds()),
    // The audit trail locates and dates; it decides nothing.
    executions: { get: (id) => kh.getDirectExecution(id) },
    actionClient: actionClient as PublicClient,
    evaluatorRpcUrl: evaluatorRpc,
    escrowClient,
    // Without `SETTLER_DRY_RUN`, the daemon writes onchain. Observation mode is
    // explicit: a daemon believed to be active that settles nothing would be the
    // worst of both worlds.
    ...(flag('SETTLER_DRY_RUN')
      ? {}
      : { submitOptions: { escrow, walletClient, account: settler, chain } }),
    publisher,
    ...(reputation ? { reputation } : {}),
    logger: emit,
    confirmationTimeoutMs: Number(optional('SETTLER_CONFIRMATION_TIMEOUT_MS', '120000')),
  })

  // ── Verdict server ─────────────────────────────────────────────────────────
  const verdictServer = createVerdictServer({ dir: verdictDir, baseUri: verdictBaseUri })
  serve({ fetch: verdictServer.fetch, port })

  emit({
    msg: 'warrant settler',
    escrow,
    escrowChainId,
    settler,
    gasWei: gas.toString(10),
    escrowRpc,
    evaluatorRpc,
    archiveProbeBlock: probe.probedBlock.toString(10),
    journal: journal.path,
    fromBlock: fromBlock.toString(10),
    verdictDir,
    verdictBaseUri,
    verdictPort: port,
    dryRun: flag('SETTLER_DRY_RUN'),
    erc8004: erc8004Enabled
      ? { chainId: erc8004ChainId, identityRegistry, reputationRegistry }
      : {
          disabled: true,
          reason: mainnetBlocked
            ? `chain ${erc8004ChainId} treated as a mainnet: write refused without ERC8004_ALLOW_MAINNET=1`
            : erc8004ChainId !== escrowChainId
              ? `ERC8004_CHAIN_ID=${erc8004ChainId} ≠ escrow chain ${escrowChainId}: ` +
                'the Settler signs on one chain at a time only'
              : 'ERC8004_DISABLED',
        },
  })

  const once = flag('SETTLER_ONCE')
  const intervalMs = Number(optional('SETTLER_INTERVAL_MS', '15000'))
  let stopping = false

  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    emit({ msg: 'settler: stopping', signal })
    // Pending batches go out before the stop: keeping them in memory would amount
    // to losing verdicts that have already been rendered.
    const flushed = await daemon.flushReputation(true)
    if (flushed.length > 0) emit({ msg: 'settler: batches flushed', flushed })
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  for (;;) {
    const started = Date.now()
    try {
      const report = await daemon.tick()
      emit({
        msg: 'settler: tick',
        open: report.open,
        processed: report.outcomes.length,
        settled: report.outcomes.filter((o) => o.kind === 'settled').length,
        deferred: report.outcomes.filter((o) => o.kind === 'deferred').length,
        failed: report.outcomes.filter((o) => o.kind === 'failed').length,
        reputation: report.reputation,
        ...(report.scanError ? { scanError: report.scanError } : {}),
        durationMs: Date.now() - started,
      })
    } catch (e) {
      // A failed pass does not kill the daemon: the next one will retry. A stopped
      // Settler lets warrants expire that it could have settled.
      emit({ msg: 'settler: tick failed', error: e instanceof Error ? e.message : String(e) })
    }
    if (once) {
      const flushed = await daemon.flushReputation(true)
      if (flushed.length > 0) emit({ msg: 'settler: batches flushed', flushed })
      process.exit(0)
    }
    await sleep(intervalMs)
  }
}

/** Structured log, one JSON line per event. Never a secret. */
function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: 'settler: startup failed', error: String(e) }))
  process.exit(1)
})
