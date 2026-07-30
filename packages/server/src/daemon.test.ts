import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WarrantStatus,
  actionHash as hashAction,
  conditionHash as hashCondition,
  type ActionSpec,
  type Address,
  type ConditionSpec,
  type Hex,
} from '@warrant/core'
import type { PublicClient } from 'viem'
import {
  createSettlementDaemon,
  erc8004Sink,
  viemEscrowReader,
  type EscrowReader,
  type ExecutionSource,
  type MandateSource,
  type OnchainWarrant,
  type SettlementMandate,
} from './daemon.js'
import type { Execution } from './keeperhub.js'
import { fileVerdictPublisher } from './verdicts.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const WARRANT_ID = `0x${'11'.repeat(32)}` as Hex
const TX_HASH = `0x${'22'.repeat(32)}` as Hex
const SETTLEMENT_TX = `0x${'99'.repeat(32)}` as Hex
const REPUTATION_TX = `0x${'88'.repeat(32)}` as Hex
const TOKEN = '0x00000000000000000000000000000000000000cc' as Address
const AGENT = '0x00000000000000000000000000000000000000a1' as Address
const SETTLER = '0x00000000000000000000000000000000000000e5' as Address
const TOPIC_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex

const NOW = 1_800_000_000
const now = () => NOW

const actionSpec: ActionSpec = {
  version: 1,
  chainId: 11155111,
  target: TOKEN,
  value: '0',
  calldata: '0xa9059cbb',
  registryRef: `0x${'55'.repeat(32)}` as Hex,
}

/**
 * Deliberately minimal post-condition: `event_emitted` reads nothing but the
 * receipt's logs, so the client needs nothing beyond what the transaction
 * already carries. It is the real evaluator running here, not a double.
 */
const conditionSpec: ConditionSpec = {
  version: 1,
  chainId: 11155111,
  evaluateAt: 'tx',
  confirmations: 1,
  checks: [{ kind: 'event_emitted', address: TOKEN, topic0: TOPIC_TRANSFER, minCount: 1 }],
}

function mandate(over: Partial<SettlementMandate> = {}): SettlementMandate {
  return {
    warrantId: WARRANT_ID,
    executionId: 'exec_1',
    conditionSpec,
    actionSpec,
    classification: {
      category: 'erc20.transfer',
      params: { token: TOKEN },
      notionalUSD: '1000000',
      registryRef: actionSpec.registryRef,
    },
    ...over,
  }
}

function warrant(over: Partial<OnchainWarrant> = {}): OnchainWarrant {
  return {
    id: WARRANT_ID,
    agent: AGENT,
    beneficiary: '0x00000000000000000000000000000000000000b1' as Address,
    bond: 25_000_000n,
    conditionHash: hashCondition(conditionSpec).toLowerCase() as Hex,
    actionHash: hashAction(actionSpec).toLowerCase() as Hex,
    fundingRef: `0x${'44'.repeat(32)}` as Hex,
    expiry: NOW + 3600,
    openedAt: NOW - 60,
    feeBpsAtOpen: 250,
    status: WarrantStatus.Open,
    ...over,
  }
}

function execution(over: Partial<Execution> = {}): Execution {
  return {
    executionId: 'exec_1',
    status: 'success',
    txHash: TX_HASH,
    transactions: [{ hash: TX_HASH }],
    gasUsedWei: 97_164n,
    outcome: 'success',
    raw: {},
    ...over,
  }
}

/** A receipt whose logs satisfy — or not — the committed `event_emitted`. */
function receipt(withTransfer: boolean) {
  return {
    blockNumber: 11_368_824n,
    logs: withTransfer
      ? [{ address: TOKEN, topics: [TOPIC_TRANSFER], data: '0x' as Hex }]
      : [],
  }
}

function chainClient(withTransfer: boolean) {
  return {
    waitForTransactionReceipt: async () => receipt(withTransfer),
    getTransactionReceipt: async () => receipt(withTransfer),
    getTransaction: async () => ({
      to: TOKEN,
      value: 0n,
      input: '0xa9059cbb' as Hex,
      chainId: 11155111,
    }),
  } as unknown as PublicClient
}

function reader(w: OnchainWarrant | undefined): EscrowReader {
  return {
    discover: async () => ({ ids: w ? [w.id] : [], scannedTo: 0n }),
    read: async () => w,
  }
}

function mandates(m: SettlementMandate | undefined): MandateSource {
  return {
    refresh: () => {},
    get: () => m,
    ids: () => (m ? [m.warrantId] : []),
  }
}

function executions(e: Execution): ExecutionSource {
  return { get: async () => e }
}

function publisher() {
  return fileVerdictPublisher({
    dir: mkdtempSync(join(tmpdir(), 'warrant-daemon-')),
    baseUri: 'https://verdicts.test/v/',
  })
}

interface Submitted {
  functionName: string
  args: readonly unknown[]
}

function walletSpy(): { calls: Submitted[]; client: { writeContract: (a: never) => Promise<Hex> } } {
  const calls: Submitted[] = []
  return {
    calls,
    client: {
      writeContract: async (args: never) => {
        const call = args as unknown as Submitted
        calls.push({ functionName: call.functionName, args: call.args })
        return call.functionName === 'giveFeedback' ? REPUTATION_TX : SETTLEMENT_TX
      },
    },
  }
}

/**
 * `IdentityRegistry` that authorizes rating: `isAuthorizedOrOwner` false means
 * the Settler is neither owner nor operator, hence that `giveFeedback` will go
 * through (ReputationRegistryUpgradeable.sol:110).
 */
function identityAllows(authorized: boolean) {
  return {
    readContract: async () => authorized,
  }
}

interface DaemonOver {
  warrant?: OnchainWarrant | undefined
  mandate?: SettlementMandate | undefined
  execution?: Execution
  postConditionHeld?: boolean
  submit?: boolean
  reputation?: boolean
  authorized?: boolean
}

function build(over: DaemonOver = {}) {
  const wallet = walletSpy()
  const pub = publisher()
  const client = chainClient(over.postConditionHeld ?? true)
  const sink = over.reputation
    ? erc8004Sink({
        chainId: 11155111,
        identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e' as Address,
        reputationRegistry: '0x8004b663056a597dffe9eccc1965a193b7388713' as Address,
        settler: SETTLER,
        publicClient: identityAllows(over.authorized ?? false),
        walletClient: wallet.client as never,
        publisher: pub,
      })
    : undefined

  const daemon = createSettlementDaemon({
    escrow: '0x00000000000000000000000000000000000000ee' as Address,
    chainId: 11155111,
    settler: SETTLER,
    identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e' as Address,
    reader: reader('warrant' in over ? over.warrant : warrant()),
    mandates: mandates('mandate' in over ? over.mandate : mandate()),
    executions: executions(over.execution ?? execution()),
    actionClient: client,
    evaluatorRpcUrl: 'https://sepolia.drpc.org',
    escrowClient: client,
    ...(over.submit === false
      ? {}
      : {
          submitOptions: {
            escrow: '0x00000000000000000000000000000000000000ee' as Address,
            walletClient: wallet.client as never,
            account: SETTLER,
            chain: undefined,
          },
        }),
    publisher: pub,
    ...(sink ? { reputation: sink } : {}),
    now,
  })

  return { daemon, wallet, publisher: pub, sink }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('daemon — a daemon defers, it does not give up', () => {
  it('execution still running: we come back next round, submitting nothing', async () => {
    const { daemon, wallet } = build({ execution: execution({ status: 'running' }) })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('deferred')
    expect(wallet.calls).toHaveLength(0)
  })

  it('unreadable audit trail: deferred, never slashed', async () => {
    const wallet = walletSpy()
    const report = await daemonWithFailingExecutions(wallet).tick()
    expect(report.outcomes[0]).toMatchObject({ kind: 'deferred' })
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/audit trail/)
    expect(wallet.calls).toHaveLength(0)
  })

  it('no spec in the journal: deferred — a hash is not invertible', async () => {
    const { daemon, wallet } = build({ mandate: undefined })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('deferred')
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/journal/)
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — the journal is never taken at its word', () => {
  it('conditionSpec that does not match the onchain commitment: abstention', async () => {
    const { daemon, wallet } = build({
      warrant: warrant({ conditionHash: `0x${'ff'.repeat(32)}` as Hex }),
    })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('skipped')
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/conditionHash diverges/)
    // The point that matters: a forged journal line never causes a slash.
    expect(wallet.calls).toHaveLength(0)
  })

  it('actionSpec that does not match the onchain commitment: abstention', async () => {
    const { daemon, wallet } = build({
      warrant: warrant({ actionHash: `0x${'ff'.repeat(32)}` as Hex }),
    })
    const report = await daemon.tick()
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/actionHash diverges/)
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — invariant I9, the settlement window', () => {
  it('emits nothing when expiry is too close', async () => {
    const { daemon, wallet } = build({ warrant: warrant({ expiry: NOW + 30 }) })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('skipped')
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/settlement window closed/)
    expect(wallet.calls).toHaveLength(0)
  })

  it('ignores a warrant that is already settled', async () => {
    const { daemon, wallet } = build({ warrant: warrant({ status: WarrantStatus.Honored }) })
    const report = await daemon.tick()
    expect(report.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'status Honored' })
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — settlement', () => {
  it('post-condition held → honor, and the verdict is published', async () => {
    const { daemon, wallet, publisher: pub } = build({ postConditionHeld: true })
    const report = await daemon.tick()

    const outcome = report.outcomes[0]
    expect(outcome).toMatchObject({ kind: 'settled', action: 'honor', verdict: 'honored' })
    expect(wallet.calls[0]?.functionName).toBe('honor')

    const served = pub.read(WARRANT_ID)
    expect(served).toBeDefined()
    const document = JSON.parse(served as string) as {
      checks: unknown[]
      evaluatedAtBlock: string
      rpcUrl: string
      settlementTx: string
    }
    // What a third party must find in order to replay: the checks, the block, the RPC.
    expect(document.checks).toHaveLength(1)
    expect(document.evaluatedAtBlock).toBe('11368824')
    expect(document.rpcUrl).toBe('https://sepolia.drpc.org')
    expect(document.settlementTx).toBe(SETTLEMENT_TX)
  })

  it('post-condition violated → slash, with the reason recorded onchain', async () => {
    const { daemon, wallet } = build({ postConditionHeld: false })
    const report = await daemon.tick()

    expect(report.outcomes[0]).toMatchObject({ kind: 'settled', action: 'slash', verdict: 'slashed' })
    expect(wallet.calls[0]?.functionName).toBe('slash')
    expect(String(wallet.calls[0]?.args[2])).toMatch(/event_emitted/)
  })

  it('observation mode: decides and publishes, submits nothing', async () => {
    const { daemon, wallet } = build({ submit: false })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('let-expire')
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — ERC-8004 recording', () => {
  it('a slash is recorded immediately', async () => {
    const { daemon, wallet } = build({
      postConditionHeld: false,
      reputation: true,
      mandate: mandate({ agentId: 7n }),
    })
    const report = await daemon.tick()

    const feedback = wallet.calls.find((c) => c.functionName === 'giveFeedback')
    expect(feedback).toBeDefined()
    // The eight arguments, in ABI order. `tag2` carries the verdict.
    expect(feedback?.args[0]).toBe(7n)
    expect(feedback?.args[1]).toBe(-100n)
    expect(feedback?.args[4]).toBe('slashed')
    expect(feedback?.args[6]).toBe(`https://verdicts.test/v/${WARRANT_ID}`)

    const outcome = report.outcomes[0] as { reputation: { written: boolean } }
    expect(outcome.reputation.written).toBe(true)
  })

  it('the URI recorded onchain does serve the document whose hash is committed', async () => {
    const { daemon, wallet, publisher: pub } = build({
      postConditionHeld: false,
      reputation: true,
      mandate: mandate({ agentId: 7n }),
    })
    await daemon.tick()

    const feedback = wallet.calls.find((c) => c.functionName === 'giveFeedback')
    const { hashCanonical } = await import('@warrant/core')
    expect(hashCanonical(pub.read(WARRANT_ID) as string)).toBe(feedback?.args[7])
  })

  it('an honored warrant leaves in a batch, not as an immediate write', async () => {
    const { daemon, wallet, sink } = build({
      postConditionHeld: true,
      reputation: true,
      mandate: mandate({ agentId: 7n }),
    })
    const report = await daemon.tick()

    expect(wallet.calls.filter((c) => c.functionName === 'giveFeedback')).toHaveLength(0)
    expect(sink?.pending()).toBe(1)
    expect((report.outcomes[0] as { reputation: { reason: string } }).reputation.reason).toMatch(
      /batched/,
    )

    // On shutdown, the batch leaves.
    const flushed = await daemon.flushReputation(true)
    expect(flushed[0]).toMatchObject({ written: true, scope: 'batch', count: 1 })
    expect(wallet.calls.filter((c) => c.functionName === 'giveFeedback')).toHaveLength(1)
  })

  it('a Settler that cannot rate the agent does not prevent settlement', async () => {
    const { daemon, wallet } = build({
      postConditionHeld: false,
      reputation: true,
      authorized: true, // isAuthorizedOrOwner = true → giveFeedback would revert
      mandate: mandate({ agentId: 7n }),
    })
    const report = await daemon.tick()

    // The slash did happen…
    expect(report.outcomes[0]).toMatchObject({ kind: 'settled', action: 'slash' })
    expect(wallet.calls.some((c) => c.functionName === 'slash')).toBe(true)
    // …and the recording was refused cleanly, with its reason.
    expect(wallet.calls.some((c) => c.functionName === 'giveFeedback')).toBe(false)
    const reputation = (report.outcomes[0] as { reputation: { written: boolean; reason: string } })
      .reputation
    expect(reputation.written).toBe(false)
    expect(reputation.reason).toMatch(/Self-feedback|owner|operator/)
  })

  it('without an ERC-8004 identity, the warrant is settled and the verdict published anyway', async () => {
    const { daemon, wallet, publisher: pub } = build({
      postConditionHeld: false,
      reputation: true,
    })
    const report = await daemon.tick()

    expect(report.outcomes[0]).toMatchObject({ kind: 'settled', action: 'slash' })
    expect(pub.read(WARRANT_ID)).toBeDefined()
    expect(wallet.calls.some((c) => c.functionName === 'giveFeedback')).toBe(false)
    expect((report.outcomes[0] as { reputation: { reason: string } }).reputation.reason).toMatch(
      /agentId/,
    )
  })
})

/** Variant with a failing execution source, for the audit-trail test. */
function daemonWithFailingExecutions(wallet: ReturnType<typeof walletSpy>) {
  return createSettlementDaemon({
    escrow: '0x00000000000000000000000000000000000000ee' as Address,
    chainId: 11155111,
    settler: SETTLER,
    reader: reader(warrant()),
    mandates: mandates(mandate()),
    executions: {
      get: async () => {
        throw new Error('KeeperHub 502')
      },
    },
    actionClient: chainClient(true),
    evaluatorRpcUrl: 'https://sepolia.drpc.org',
    escrowClient: chainClient(true),
    submitOptions: {
      escrow: '0x00000000000000000000000000000000000000ee' as Address,
      walletClient: wallet.client as never,
      account: SETTLER,
      chain: undefined,
    },
    publisher: publisher(),
    now,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// viemEscrowReader — decoding the `Warrant` struct
// ─────────────────────────────────────────────────────────────────────────────

describe('viemEscrowReader.read', () => {
  const ESCROW = '0x00000000000000000000000000000000000000ee' as Address
  const FUNDING_NONCE = `0x${'f3'.repeat(32)}` as Hex

  /**
   * The struct as `getWarrant` returns it: **ten** named members, with
   * `feeBpsAtOpen` in ninth position, just before `status`.
   */
  function onchain(over: Record<string, unknown> = {}) {
    return {
      agent: '0x00000000000000000000000000000000000000A1',
      beneficiary: '0x00000000000000000000000000000000000000B1',
      bond: 25_000_000n,
      conditionHash: `0x${'CC'.repeat(32)}`,
      actionHash: `0x${'DD'.repeat(32)}`,
      fundingRef: FUNDING_NONCE.toUpperCase(),
      expiry: BigInt(NOW + 3600),
      openedAt: BigInt(NOW - 60),
      feeBpsAtOpen: 250,
      status: 1, // Open
      ...over,
    }
  }

  function readerOver(result: unknown) {
    const seen: Record<string, unknown>[] = []
    const client = {
      readContract: async (args: Record<string, unknown>) => {
        seen.push(args)
        return result
      },
      getLogs: async () => [],
      getBlockNumber: async () => 100n,
    } as unknown as Pick<PublicClient, 'readContract' | 'getLogs' | 'getBlockNumber'>
    return { seen, reader: viemEscrowReader({ client, address: ESCROW, fromBlock: 0n }) }
  }

  it('reads through `getWarrant`, which returns a named struct', async () => {
    const { seen, reader } = readerOver(onchain())
    await reader.read(WARRANT_ID)
    // And not the `warrants` getter, which flattens into ten positional values
    // where an inserted member shifts everything that follows.
    expect(seen[0]?.['functionName']).toBe('getWarrant')
  })

  it('decodes all ten members, `status` included', async () => {
    const { reader } = readerOver(onchain())
    await expect(reader.read(WARRANT_ID)).resolves.toEqual({
      id: WARRANT_ID,
      agent: '0x00000000000000000000000000000000000000a1',
      beneficiary: '0x00000000000000000000000000000000000000b1',
      bond: 25_000_000n,
      conditionHash: `0x${'cc'.repeat(32)}`,
      actionHash: `0x${'dd'.repeat(32)}`,
      fundingRef: FUNDING_NONCE,
      expiry: NOW + 3600,
      openedAt: NOW - 60,
      feeBpsAtOpen: 250,
      status: WarrantStatus.Open,
    })
  })

  it('does not confuse `status` with `feeBpsAtOpen` — the one-field shift', async () => {
    // The regression this migration had to avoid. A positional decoding written
    // against the old nine-member struct would read `status` at index 8, that
    // is, `feeBpsAtOpen`: 250 on the current deployment. But
    // `WarrantStatus[250]` is `undefined` and 250 !== WarrantStatus.None, so
    // `read()` would return a warrant of unknown status instead of `Open` —
    // without throwing. The daemon would reject it as `skipped` and let the
    // bond expire towards `reclaim`, silently.
    const w = await readerOver(onchain()).reader.read(WARRANT_ID)
    expect(w?.status).toBe(WarrantStatus.Open)
    expect(w?.status).not.toBe(250)
    expect(w?.feeBpsAtOpen).toBe(250)
    // And the two stay distinct when the rate changes.
    const other = await readerOver(onchain({ feeBpsAtOpen: 0 })).reader.read(WARRANT_ID)
    expect(other?.status).toBe(WarrantStatus.Open)
    expect(other?.feeBpsAtOpen).toBe(0)
  })

  it('returns `undefined` for a warrant unknown to the escrow', async () => {
    const { reader } = readerOver(onchain({ status: 0 }))
    await expect(reader.read(WARRANT_ID)).resolves.toBeUndefined()
  })

  it('the `fundingRef` is a nonce, and it is normalised to lowercase', async () => {
    const w = await readerOver(onchain()).reader.read(WARRANT_ID)
    // It is no longer a transaction hash: it is the EIP-3009 nonce the contract
    // writes, and whose uniqueness per authorizer the token guarantees.
    expect(w?.fundingRef).toBe(FUNDING_NONCE)
  })
})
