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
// Décor
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
 * Post-condition volontairement minimale : `event_emitted` ne lit que les logs
 * du receipt, donc le client n'a besoin de rien d'autre que ce que la
 * transaction porte déjà. C'est l'évaluateur réel qui tourne, pas un double.
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

/** Un receipt dont les logs satisfont — ou non — le `event_emitted` engagé. */
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
 * `IdentityRegistry` qui autorise la notation : `isAuthorizedOrOwner` faux
 * signifie que le Settler n'est ni owner ni operator, donc que `giveFeedback`
 * passera (ReputationRegistryUpgradeable.sol:110).
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

describe('daemon — un daemon diffère, il ne renonce pas', () => {
  it('exécution encore en cours : on repasse au tour suivant, sans rien soumettre', async () => {
    const { daemon, wallet } = build({ execution: execution({ status: 'running' }) })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('deferred')
    expect(wallet.calls).toHaveLength(0)
  })

  it('audit trail illisible : différé, jamais saisi', async () => {
    const wallet = walletSpy()
    const report = await daemonWithFailingExecutions(wallet).tick()
    expect(report.outcomes[0]).toMatchObject({ kind: 'deferred' })
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/audit trail/)
    expect(wallet.calls).toHaveLength(0)
  })

  it('aucune spec au journal : différé — un hash n’est pas inversible', async () => {
    const { daemon, wallet } = build({ mandate: undefined })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('deferred')
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/journal/)
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — le journal n’est jamais cru sur parole', () => {
  it('conditionSpec qui ne correspond pas à l’engagement onchain : abstention', async () => {
    const { daemon, wallet } = build({
      warrant: warrant({ conditionHash: `0x${'ff'.repeat(32)}` as Hex }),
    })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('skipped')
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/conditionHash divergent/)
    // Le point qui compte : une ligne de journal falsifiée ne fait jamais saisir.
    expect(wallet.calls).toHaveLength(0)
  })

  it('actionSpec qui ne correspond pas à l’engagement onchain : abstention', async () => {
    const { daemon, wallet } = build({
      warrant: warrant({ actionHash: `0x${'ff'.repeat(32)}` as Hex }),
    })
    const report = await daemon.tick()
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/actionHash divergent/)
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — invariant I9, la fenêtre de règlement', () => {
  it('n’émet rien quand l’expiration est trop proche', async () => {
    const { daemon, wallet } = build({ warrant: warrant({ expiry: NOW + 30 }) })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('skipped')
    expect((report.outcomes[0] as { reason: string }).reason).toMatch(/fenêtre de règlement close/)
    expect(wallet.calls).toHaveLength(0)
  })

  it('ignore un mandat déjà réglé', async () => {
    const { daemon, wallet } = build({ warrant: warrant({ status: WarrantStatus.Honored }) })
    const report = await daemon.tick()
    expect(report.outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'statut Honored' })
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — règlement', () => {
  it('post-condition tenue → honor, et le verdict est publié', async () => {
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
    // Ce qu'un tiers doit trouver pour rejouer : les checks, le bloc, le RPC.
    expect(document.checks).toHaveLength(1)
    expect(document.evaluatedAtBlock).toBe('11368824')
    expect(document.rpcUrl).toBe('https://sepolia.drpc.org')
    expect(document.settlementTx).toBe(SETTLEMENT_TX)
  })

  it('post-condition violée → slash, avec la raison inscrite onchain', async () => {
    const { daemon, wallet } = build({ postConditionHeld: false })
    const report = await daemon.tick()

    expect(report.outcomes[0]).toMatchObject({ kind: 'settled', action: 'slash', verdict: 'slashed' })
    expect(wallet.calls[0]?.functionName).toBe('slash')
    expect(String(wallet.calls[0]?.args[2])).toMatch(/event_emitted/)
  })

  it('mode observation : décide et publie, ne soumet rien', async () => {
    const { daemon, wallet } = build({ submit: false })
    const report = await daemon.tick()
    expect(report.outcomes[0]?.kind).toBe('let-expire')
    expect(wallet.calls).toHaveLength(0)
  })
})

describe('daemon — inscription ERC-8004', () => {
  it('une saisie s’inscrit immédiatement', async () => {
    const { daemon, wallet } = build({
      postConditionHeld: false,
      reputation: true,
      mandate: mandate({ agentId: 7n }),
    })
    const report = await daemon.tick()

    const feedback = wallet.calls.find((c) => c.functionName === 'giveFeedback')
    expect(feedback).toBeDefined()
    // Les huit arguments, dans l'ordre de l'ABI. `tag2` porte le verdict.
    expect(feedback?.args[0]).toBe(7n)
    expect(feedback?.args[1]).toBe(-100n)
    expect(feedback?.args[4]).toBe('slashed')
    expect(feedback?.args[6]).toBe(`https://verdicts.test/v/${WARRANT_ID}`)

    const outcome = report.outcomes[0] as { reputation: { written: boolean } }
    expect(outcome.reputation.written).toBe(true)
  })

  it('l’URI inscrite onchain sert bien le document dont le hash est engagé', async () => {
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

  it('un mandat honoré part en lot, pas en écriture immédiate', async () => {
    const { daemon, wallet, sink } = build({
      postConditionHeld: true,
      reputation: true,
      mandate: mandate({ agentId: 7n }),
    })
    const report = await daemon.tick()

    expect(wallet.calls.filter((c) => c.functionName === 'giveFeedback')).toHaveLength(0)
    expect(sink?.pending()).toBe(1)
    expect((report.outcomes[0] as { reputation: { reason: string } }).reputation.reason).toMatch(
      /lot/,
    )

    // À l'arrêt, le lot part.
    const flushed = await daemon.flushReputation(true)
    expect(flushed[0]).toMatchObject({ written: true, scope: 'batch', count: 1 })
    expect(wallet.calls.filter((c) => c.functionName === 'giveFeedback')).toHaveLength(1)
  })

  it('un Settler qui ne peut pas noter l’agent n’empêche pas le règlement', async () => {
    const { daemon, wallet } = build({
      postConditionHeld: false,
      reputation: true,
      authorized: true, // isAuthorizedOrOwner = vrai → giveFeedback reverterait
      mandate: mandate({ agentId: 7n }),
    })
    const report = await daemon.tick()

    // La saisie a bien eu lieu…
    expect(report.outcomes[0]).toMatchObject({ kind: 'settled', action: 'slash' })
    expect(wallet.calls.some((c) => c.functionName === 'slash')).toBe(true)
    // …et l'inscription a été refusée proprement, avec sa raison.
    expect(wallet.calls.some((c) => c.functionName === 'giveFeedback')).toBe(false)
    const reputation = (report.outcomes[0] as { reputation: { written: boolean; reason: string } })
      .reputation
    expect(reputation.written).toBe(false)
    expect(reputation.reason).toMatch(/Self-feedback|owner|operator/)
  })

  it('sans identité ERC-8004, le mandat est réglé et le verdict publié quand même', async () => {
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

/** Variante à source d'exécutions défaillante, pour le test de l'audit trail. */
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
// viemEscrowReader — le décodage de la struct `Warrant`
// ─────────────────────────────────────────────────────────────────────────────

describe('viemEscrowReader.read', () => {
  const ESCROW = '0x00000000000000000000000000000000000000ee' as Address
  const FUNDING_NONCE = `0x${'f3'.repeat(32)}` as Hex

  /**
   * La struct telle que `getWarrant` la rend : **dix** membres nommés, dont
   * `feeBpsAtOpen` en neuvième position, juste avant `status`.
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

  it('lit par `getWarrant`, qui rend une struct nommée', async () => {
    const { seen, reader } = readerOver(onchain())
    await reader.read(WARRANT_ID)
    // Et non le getter `warrants`, qui aplatit en dix valeurs positionnelles où
    // un membre inséré décale tout ce qui suit.
    expect(seen[0]?.['functionName']).toBe('getWarrant')
  })

  it('décode les dix membres, `status` compris', async () => {
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

  it("ne confond pas `status` avec `feeBpsAtOpen` — le décalage d'un champ", async () => {
    // La régression que cette migration devait éviter. Un décodage positionnel
    // écrit contre l'ancienne struct à neuf membres lirait `status` à l'index 8,
    // c'est-à-dire `feeBpsAtOpen` : 250 sur le déploiement courant. Or
    // `WarrantStatus[250]` vaut `undefined` et 250 !== WarrantStatus.None, donc
    // `read()` rendrait un mandat de statut inconnu au lieu de `Open` — sans
    // lever. Le daemon le rejetterait en `skipped` et laisserait la caution
    // expirer vers `reclaim`, silencieusement.
    const w = await readerOver(onchain()).reader.read(WARRANT_ID)
    expect(w?.status).toBe(WarrantStatus.Open)
    expect(w?.status).not.toBe(250)
    expect(w?.feeBpsAtOpen).toBe(250)
    // Et les deux restent distincts quand le taux change.
    const other = await readerOver(onchain({ feeBpsAtOpen: 0 })).reader.read(WARRANT_ID)
    expect(other?.status).toBe(WarrantStatus.Open)
    expect(other?.feeBpsAtOpen).toBe(0)
  })

  it('rend `undefined` sur un mandat inconnu de l’escrow', async () => {
    const { reader } = readerOver(onchain({ status: 0 }))
    await expect(reader.read(WARRANT_ID)).resolves.toBeUndefined()
  })

  it('le `fundingRef` est un nonce, et il est normalisé en minuscules', async () => {
    const w = await readerOver(onchain()).reader.read(WARRANT_ID)
    // Ce n'est plus un hash de transaction : c'est le nonce EIP-3009 que le
    // contrat inscrit, et dont le token garantit l'unicité par autorisant.
    expect(w?.fundingRef).toBe(FUNDING_NONCE)
  })
})
