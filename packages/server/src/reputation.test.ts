import { describe, expect, it, vi } from 'vitest'
import { canonicalize, hashCanonical } from '@warrant/core'
import type { Address, Hex } from '@warrant/core'
import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  stringToBytes,
} from 'viem'

import {
  DEFAULT_BATCH_POLICY,
  FEEDBACK_ENDPOINT,
  FEEDBACK_TAG1,
  MAX_VALUE_DECIMALS,
  ReputationAuthorizationError,
  ReputationError,
  VERDICT_VALUE_DECIMALS,
  VerdictBatcher,
  assertCanGiveFeedback,
  buildAgentRegistration,
  buildBatchFeedbackDocument,
  buildFeedbackDocument,
  buildWarrantMetadataCalls,
  caip10,
  canGiveFeedback,
  canonicalFeedbackDocument,
  feedbackHashOf,
  feedbackUriFor,
  giveFeedbackArgs,
  identityRegistryAbi,
  inspectAgentIdentity,
  publishBatch,
  publishVerdict,
  reputationRegistryAbi,
  verifyFeedbackHash,
  writePolicyFor,
} from './reputation.js'
import type {
  GiveFeedbackArgs,
  ProofOfPayment,
  PublishableVerdictDocument,
  ReadContractRequest,
  WriteContractRequest,
} from './reputation.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SETTLER = '0x5e77135e77135e77135e77135e77135e77135e77' as Address
const AGENT = '0xa9e47a9e47a9e47a9e47a9e47a9e47a9e47a9e47' as Address
const IDENTITY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432' as Address
const REPUTATION = '0x8004baa17c55a88189ae136b182e5fda19de9b63' as Address
const ESCROW = '0xe5c0e5c0e5c0e5c0e5c0e5c0e5c0e5c0e5c0e5c0' as Address
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const TREASURY = '0x7a5c7a5c7a5c7a5c7a5c7a5c7a5c7a5c7a5c7a5c' as Address

const WARRANT_ID = `0x${'11'.repeat(32)}` as Hex
const TX_HASH = `0x${'22'.repeat(32)}` as Hex
const FUNDING_REF = `0x${'33'.repeat(32)}` as Hex
const REGISTRY_REF = `0x${'44'.repeat(32)}` as Hex
const SETTLEMENT_TX = `0x${'55'.repeat(32)}` as Hex

const CREATED_AT = '2026-07-28T12:00:00Z'
const AGENT_ID = 4242n
const CHAIN_ID = 8453

function verdictDocument(
  over: Partial<PublishableVerdictDocument> = {},
): PublishableVerdictDocument {
  return {
    warrantId: WARRANT_ID,
    executionId: 'exec_abc',
    txHash: TX_HASH,
    blockNumber: '31000000',
    gasUsed: '128000',
    outcome: 'success',
    conditionSpec: {
      version: 1,
      chainId: CHAIN_ID,
      evaluateAt: 'tx',
      confirmations: 3,
      checks: [
        {
          kind: 'erc20_balance',
          token: TOKEN,
          account: TREASURY,
          op: 'gte',
          value: '1000000',
        },
      ],
    },
    actionSpec: {
      version: 1,
      chainId: CHAIN_ID,
      target: TOKEN,
      value: '0',
      calldata: '0xa9059cbb',
      registryRef: REGISTRY_REF,
    },
    classification: {
      category: 'erc20.transfer',
      params: { to: TREASURY, amount: '1000000' },
      notionalUSD: '1000000',
      registryRef: REGISTRY_REF,
    },
    checks: [
      { kind: 'erc20_balance', expected: '>=1000000', observed: '2000000', pass: true },
    ],
    verdict: 'honored',
    evaluatedAtBlock: '31000003',
    rpcUrl: 'https://base.rpc.example',
    settlementTx: SETTLEMENT_TX,
    ...over,
  } as PublishableVerdictDocument
}

const PROOF: ProofOfPayment = {
  fromAddress: AGENT,
  toAddress: ESCROW,
  chainId: String(CHAIN_ID),
  txHash: FUNDING_REF,
}

const buildOpts = {
  agentId: AGENT_ID,
  chainId: CHAIN_ID,
  settler: SETTLER,
  identityRegistry: IDENTITY,
  createdAt: CREATED_AT,
}

/** Registre d'identité mocké. `authorized` = le soumetteur est owner/operator. */
function identityMock(opts: {
  authorized?: boolean
  owner?: Address | null
  supportsIsAuthorized?: boolean
  approved?: Address
  approvedForAll?: boolean
}) {
  const readContract = vi.fn(async (req: ReadContractRequest): Promise<unknown> => {
    switch (req.functionName) {
      case 'isAuthorizedOrOwner':
        if (opts.supportsIsAuthorized === false) {
          throw new Error('function does not exist on this implementation')
        }
        return opts.authorized ?? false
      case 'ownerOf':
        if (opts.owner === null) throw new Error('ERC721NonexistentToken')
        return opts.owner ?? AGENT
      case 'getApproved':
        return opts.approved ?? '0x0000000000000000000000000000000000000000'
      case 'isApprovedForAll':
        return opts.approvedForAll ?? false
      default:
        throw new Error(`readContract inattendu: ${req.functionName}`)
    }
  })
  return { readContract }
}

function walletMock() {
  const calls: WriteContractRequest[] = []
  const writeContract = vi.fn(async (req: WriteContractRequest): Promise<Hex> => {
    calls.push(req)
    return `0x${'ab'.repeat(32)}` as Hex
  })
  return { writeContract, calls }
}

// ─────────────────────────────────────────────────────────────────────────────
// L'ABI
// ─────────────────────────────────────────────────────────────────────────────

describe('ABI ERC-8004', () => {
  it('giveFeedback déclare huit paramètres, dans l’ordre de la spec', () => {
    const fn = reputationRegistryAbi.find(
      (e) => e.type === 'function' && e.name === 'giveFeedback',
    )
    expect(fn).toBeDefined()
    const inputs = (fn as { inputs: readonly { name: string; type: string }[] }).inputs
    expect(inputs).toHaveLength(8)
    expect(inputs.map((i) => `${i.type} ${i.name}`)).toEqual([
      'uint256 agentId',
      'int128 value',
      'uint8 valueDecimals',
      'string tag1',
      'string tag2',
      'string endpoint',
      'string feedbackURI',
      'bytes32 feedbackHash',
    ])
  })

  it('NewFeedback est le seul porteur de endpoint / feedbackURI / feedbackHash', () => {
    const ev = reputationRegistryAbi.find(
      (e) => e.type === 'event' && e.name === 'NewFeedback',
    ) as { inputs: readonly { name: string }[] }
    const names = ev.inputs.map((i) => i.name)
    expect(names).toContain('endpoint')
    expect(names).toContain('feedbackURI')
    expect(names).toContain('feedbackHash')

    // readFeedback, lui, ne les rend pas : d'où la lecture par logs.
    const read = reputationRegistryAbi.find(
      (e) => e.type === 'function' && e.name === 'readFeedback',
    ) as { outputs: readonly { name: string }[] }
    expect(read.outputs.map((o) => o.name)).toEqual([
      'value',
      'valueDecimals',
      'tag1',
      'tag2',
      'isRevoked',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Les huit arguments
// ─────────────────────────────────────────────────────────────────────────────

describe('giveFeedbackArgs', () => {
  const args = giveFeedbackArgs({
    agentId: AGENT_ID,
    verdict: 'honored',
    feedbackURI: 'https://warrant.sh/v/0xdead',
    feedbackHash: `0x${'aa'.repeat(32)}` as Hex,
  })

  it('produit huit arguments positionnels', () => {
    expect(args).toHaveLength(8)
  })

  it('les ordonne exactement comme l’ABI', () => {
    expect(args[0]).toBe(AGENT_ID) // uint256 agentId
    expect(args[1]).toBe(100n) // int128 value
    expect(args[2]).toBe(2) // uint8 valueDecimals → +1.00
    expect(args[3]).toBe('warrant') // string tag1
    expect(args[4]).toBe('honored') // string tag2
    expect(args[5]).toBe('') // string endpoint
    expect(args[6]).toBe('https://warrant.sh/v/0xdead') // string feedbackURI
    expect(args[7]).toBe(`0x${'aa'.repeat(32)}`) // bytes32 feedbackHash
  })

  it('passe endpoint en chaîne vide, jamais absent', () => {
    expect(args[5]).toBe('')
    expect(args[5]).toBe(FEEDBACK_ENDPOINT)
    // Le piège : confondre endpoint et feedbackURI décalerait tout.
    expect(args[5]).not.toBe(args[6])
  })

  it('mappe slashed sur une valeur négative', () => {
    const slashed = giveFeedbackArgs({
      agentId: 1n,
      verdict: 'slashed',
      feedbackURI: 'u',
      feedbackHash: `0x${'00'.repeat(32)}` as Hex,
    })
    expect(slashed[1]).toBe(-100n)
    expect(slashed[4]).toBe('slashed')
    expect(slashed[3]).toBe(FEEDBACK_TAG1)
  })

  it('respecte les bornes du contrat (valueDecimals ≤ 18)', () => {
    expect(VERDICT_VALUE_DECIMALS).toBeLessThanOrEqual(MAX_VALUE_DECIMALS)
  })

  it('s’encode contre l’ABI réelle sans décalage', () => {
    // Aller-retour d'encodage : si l'ordre était faux, viem lèverait ici.
    const encoded = encodeGiveFeedback(args)
    const decoded = decodeFunctionData({ abi: reputationRegistryAbi, data: encoded })
    expect(decoded.functionName).toBe('giveFeedback')
    expect(decoded.args).toEqual([...args])
  })
})

function encodeGiveFeedback(args: GiveFeedbackArgs): Hex {
  return encodeFunctionData({
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args: args as never,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Le document et son hash
// ─────────────────────────────────────────────────────────────────────────────

describe('document de feedback', () => {
  const doc = buildFeedbackDocument(verdictDocument(), {
    ...buildOpts,
    proofOfPayment: PROOF,
  })

  it('suit le format normalisé de la spec ERC-8004', () => {
    expect(doc.agentRegistry).toBe(caip10(CHAIN_ID, IDENTITY))
    expect(doc.agentId).toBe(4242)
    expect(doc.clientAddress).toBe(caip10(CHAIN_ID, SETTLER))
    expect(doc.createdAt).toBe(CREATED_AT)
    expect(doc.value).toBe(100)
    expect(doc.valueDecimals).toBe(2)
    expect(doc.tag1).toBe('warrant')
    expect(doc.tag2).toBe('honored')
    expect(doc.endpoint).toBe('')
  })

  it('porte proofOfPayment, le pont normalisé x402 → réputation', () => {
    expect(doc.proofOfPayment).toEqual({
      fromAddress: AGENT,
      toAddress: ESCROW,
      chainId: '8453',
      txHash: FUNDING_REF,
    })
    // Le txHash de la preuve est le fundingRef du mandat, pas la tx d'action.
    expect(doc.proofOfPayment?.txHash).not.toBe(doc.warrant.txHash)
  })

  it('reste rejouable : checks, evaluatedAtBlock et rpcUrl sont dedans', () => {
    expect(doc.warrant.checks).toHaveLength(1)
    expect(doc.warrant.evaluatedAtBlock).toBe('31000003')
    expect(doc.warrant.rpcUrl).toBe('https://base.rpc.example')
  })

  it('normalise les adresses en minuscules', () => {
    const upper = buildFeedbackDocument(verdictDocument(), {
      ...buildOpts,
      settler: SETTLER.toUpperCase().replace('0X', '0x') as Address,
    })
    expect(upper.clientAddress).toBe(caip10(CHAIN_ID, SETTLER))
  })

  it('injecte null pour settlementTx absent plutôt que d’omettre le champ', () => {
    const d = buildFeedbackDocument(verdictDocument({ settlementTx: undefined }), buildOpts)
    expect(d.warrant.settlementTx).toBeNull()
    expect('settlementTx' in d.warrant).toBe(true)
  })

  it('exclut reputationTx : le hash ne peut pas dépendre de sa propre transaction', () => {
    const withTx = buildFeedbackDocument(
      verdictDocument({ reputationTx: `0x${'99'.repeat(32)}` as Hex }),
      buildOpts,
    )
    const without = buildFeedbackDocument(verdictDocument(), buildOpts)
    expect(feedbackHashOf(withTx)).toBe(feedbackHashOf(without))
    expect('reputationTx' in withTx.warrant).toBe(false)
  })
})

describe('feedbackHash', () => {
  const doc = buildFeedbackDocument(verdictDocument(), {
    ...buildOpts,
    proofOfPayment: PROOF,
  })

  it('vaut keccak256(utf8(canonicalize(doc)))', () => {
    const expected = keccak256(stringToBytes(canonicalize(doc)))
    expect(feedbackHashOf(doc)).toBe(expected)
    expect(feedbackHashOf(doc)).toBe(hashCanonical(canonicalize(doc)))
  })

  it('est reproductible : deux constructions identiques donnent le même hash', () => {
    const again = buildFeedbackDocument(verdictDocument(), {
      ...buildOpts,
      proofOfPayment: PROOF,
    })
    expect(feedbackHashOf(again)).toBe(feedbackHashOf(doc))
  })

  it('est recalculable par un tiers depuis le document servi à feedbackURI', () => {
    // Ce que fait un vérificateur : télécharger, canonicaliser, hacher, comparer.
    const served = canonicalFeedbackDocument(doc)
    const downloaded = JSON.parse(served) as typeof doc
    expect(verifyFeedbackHash(downloaded, feedbackHashOf(doc))).toBe(true)
  })

  it('change dès qu’un octet du verdict change', () => {
    const tampered = buildFeedbackDocument(
      verdictDocument({
        checks: [
          { kind: 'erc20_balance', expected: '>=1000000', observed: '1', pass: false },
        ],
      }),
      { ...buildOpts, proofOfPayment: PROOF },
    )
    expect(feedbackHashOf(tampered)).not.toBe(feedbackHashOf(doc))
  })

  it('rejette un hash qui ne correspond pas', () => {
    expect(verifyFeedbackHash(doc, `0x${'00'.repeat(32)}` as Hex)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Politique d'écriture (docs/10 § 5)
// ─────────────────────────────────────────────────────────────────────────────

describe('politique d’écriture', () => {
  it('écrit immédiatement une saisie', () => {
    expect(writePolicyFor('slashed')).toBe('immediate')
  })

  it('met les mandats honorés en lot', () => {
    expect(writePolicyFor('honored')).toBe('batch')
  })

  it('n’écrit jamais rien pour un reclaim', () => {
    expect(writePolicyFor('reclaimed')).toBe('never')
  })
})

describe('publishVerdict', () => {
  it('inscrit immédiatement une saisie, avec les huit arguments', async () => {
    const wallet = walletMock()
    const identity = identityMock({ authorized: false })

    const res = await publishVerdict(verdictDocument({ verdict: 'slashed' }), {
      ...buildOpts,
      reputationRegistry: REPUTATION,
      walletClient: wallet,
      publicClient: identity,
      proofOfPayment: PROOF,
    })

    expect(res.written).toBe(true)
    if (!res.written) throw new Error('unreachable')

    expect(wallet.calls).toHaveLength(1)
    const call = wallet.calls[0]!
    expect(call.address).toBe(REPUTATION)
    expect(call.functionName).toBe('giveFeedback')
    // Le compte utilisé EST la preuve d'origine : pas de signature détachée.
    expect(call.account).toBe(SETTLER)

    expect(call.args).toHaveLength(8)
    expect(call.args).toEqual([
      AGENT_ID,
      -100n,
      2,
      'warrant',
      'slashed',
      '',
      feedbackUriFor(WARRANT_ID),
      res.feedbackHash,
    ])
    expect(verifyFeedbackHash(res.document, res.feedbackHash)).toBe(true)
  })

  it('diffère un mandat honoré vers le lot, sans écrire', async () => {
    const wallet = walletMock()
    const identity = identityMock({ authorized: false })

    const res = await publishVerdict(verdictDocument(), {
      ...buildOpts,
      reputationRegistry: REPUTATION,
      walletClient: wallet,
      publicClient: identity,
    })

    expect(res.written).toBe(false)
    if (res.written) throw new Error('unreachable')
    expect(res.reason).toBe('batched')
    // Le document est prêt — il partira avec le lot.
    expect(res.document).toBeDefined()
    expect(res.feedbackHash).toBeDefined()
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it('écrit un honoré isolé quand on force le mode immédiat', async () => {
    const wallet = walletMock()
    const res = await publishVerdict(verdictDocument(), {
      ...buildOpts,
      reputationRegistry: REPUTATION,
      walletClient: wallet,
      publicClient: identityMock({ authorized: false }),
      mode: 'immediate',
    })
    expect(res.written).toBe(true)
    expect(wallet.calls[0]!.args[1]).toBe(100n)
    expect(wallet.calls[0]!.args[4]).toBe('honored')
  })

  it('n’écrit RIEN sur un reclaim, même en mode immédiat', async () => {
    const wallet = walletMock()
    const identity = identityMock({ authorized: false })

    for (const mode of ['auto', 'immediate'] as const) {
      const res = await publishVerdict(verdictDocument({ verdict: 'reclaimed' }), {
        ...buildOpts,
        reputationRegistry: REPUTATION,
        walletClient: wallet,
        publicClient: identity,
        mode,
      })
      expect(res.written).toBe(false)
      if (res.written) throw new Error('unreachable')
      expect(res.reason).toBe('reclaimed')
      // Aucun document n'est même construit : il n'y a rien à publier.
      expect(res.document).toBeUndefined()
    }

    // Une défaillance de notre infrastructure ne dégrade pas la réputation.
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(identity.readContract).not.toHaveBeenCalled()
  })

  it('refuse de construire un document pour un reclaim', () => {
    expect(() =>
      buildFeedbackDocument(verdictDocument({ verdict: 'reclaimed' }), buildOpts),
    ).toThrow(ReputationError)
  })

  it('utilise l’URI explicite quand elle est fournie', async () => {
    const wallet = walletMock()
    const res = await publishVerdict(verdictDocument({ verdict: 'slashed' }), {
      ...buildOpts,
      reputationRegistry: REPUTATION,
      walletClient: wallet,
      publicClient: identityMock({ authorized: false }),
      feedbackURI: 'ipfs://bafy…',
    })
    expect(res.written).toBe(true)
    expect(wallet.calls[0]!.args[6]).toBe('ipfs://bafy…')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le garde-fou anti-auto-notation
// ─────────────────────────────────────────────────────────────────────────────

describe('assertCanGiveFeedback', () => {
  it('laisse passer un Settler tiers', async () => {
    const identity = identityMock({ authorized: false })
    await expect(
      assertCanGiveFeedback(AGENT_ID, SETTLER, {
        publicClient: identity,
        identityRegistry: IDENTITY,
      }),
    ).resolves.toBeUndefined()
  })

  it('refuse si le Settler est owner du NFT d’agent', async () => {
    const identity = identityMock({ authorized: true, owner: SETTLER })
    const err = await assertCanGiveFeedback(AGENT_ID, SETTLER, {
      publicClient: identity,
      identityRegistry: IDENTITY,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ReputationAuthorizationError)
    const e = err as ReputationAuthorizationError
    expect(e.blocker).toBe('owner')
    expect(e.agentId).toBe(AGENT_ID)
    expect(e.message).toContain('Self-feedback not allowed')
    expect(e.message).toContain('owner')
    expect(e.message).toContain(String(AGENT_ID))
  })

  it('refuse si le Settler est operator', async () => {
    const identity = identityMock({ authorized: true, owner: AGENT })
    const err = (await assertCanGiveFeedback(AGENT_ID, SETTLER, {
      publicClient: identity,
      identityRegistry: IDENTITY,
    }).catch((x: unknown) => x)) as ReputationAuthorizationError

    expect(err).toBeInstanceOf(ReputationAuthorizationError)
    expect(err.blocker).toBe('operator')
    expect(err.agentOwner).toBe(AGENT)
  })

  it('retombe sur la décomposition ERC-721 si isAuthorizedOrOwner est absente', async () => {
    // L'ABI publiée ne déclare pas isAuthorizedOrOwner : le repli doit marcher.
    const identity = identityMock({ supportsIsAuthorized: false, owner: AGENT })
    const v = await canGiveFeedback(AGENT_ID, SETTLER, {
      publicClient: identity,
      identityRegistry: IDENTITY,
    })
    expect(v.ok).toBe(true)
    expect(v.via).toBe('erc721-decomposition')

    const asOwner = await canGiveFeedback(AGENT_ID, AGENT, {
      publicClient: identity,
      identityRegistry: IDENTITY,
    })
    expect(asOwner.ok).toBe(false)
    expect(asOwner.blocker).toBe('owner')
  })

  it('détecte l’approbation pour tous via le repli', async () => {
    const identity = identityMock({
      supportsIsAuthorized: false,
      owner: AGENT,
      approvedForAll: true,
    })
    const v = await canGiveFeedback(AGENT_ID, SETTLER, {
      publicClient: identity,
      identityRegistry: IDENTITY,
    })
    expect(v.ok).toBe(false)
    expect(v.blocker).toBe('operator')
  })

  it('détecte un agentId inexistant', async () => {
    const identity = identityMock({ supportsIsAuthorized: false, owner: null })
    const err = (await assertCanGiveFeedback(AGENT_ID, SETTLER, {
      publicClient: identity,
      identityRegistry: IDENTITY,
    }).catch((x: unknown) => x)) as ReputationAuthorizationError
    expect(err.blocker).toBe('agent-not-registered')
  })

  it('empêche publishVerdict d’émettre la transaction', async () => {
    const wallet = walletMock()
    const identity = identityMock({ authorized: true, owner: SETTLER })

    await expect(
      publishVerdict(verdictDocument({ verdict: 'slashed' }), {
        ...buildOpts,
        reputationRegistry: REPUTATION,
        walletClient: wallet,
        publicClient: identity,
      }),
    ).rejects.toBeInstanceOf(ReputationAuthorizationError)

    // Le point du test : découvrir le problème AVANT 150 mandats réglés.
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le lot
// ─────────────────────────────────────────────────────────────────────────────

describe('VerdictBatcher', () => {
  it('n’accepte que des mandats honorés', () => {
    const b = new VerdictBatcher()
    expect(() => b.enqueue(AGENT_ID, verdictDocument({ verdict: 'slashed' }))).toThrow(
      ReputationError,
    )
    expect(() => b.enqueue(AGENT_ID, verdictDocument({ verdict: 'reclaimed' }))).toThrow(
      ReputationError,
    )
    expect(b.size(AGENT_ID)).toBe(0)
  })

  it('déclenche à la taille de lot', () => {
    const b = new VerdictBatcher({ maxBatchSize: 3 })
    b.enqueue(AGENT_ID, verdictDocument())
    b.enqueue(AGENT_ID, verdictDocument())
    expect(b.due()).toEqual([])
    b.enqueue(AGENT_ID, verdictDocument())
    expect(b.due()).toEqual([AGENT_ID])
    expect(b.drain(AGENT_ID)).toHaveLength(3)
    expect(b.size(AGENT_ID)).toBe(0)
  })

  it('déclenche à l’âge, sans attendre la taille', () => {
    let now = 1_000_000
    const b = new VerdictBatcher({ maxBatchSize: 100, maxAgeMs: 1000 }, () => now)
    b.enqueue(AGENT_ID, verdictDocument())
    expect(b.due()).toEqual([])
    now += 1001
    expect(b.due()).toEqual([AGENT_ID])
  })

  it('a une politique par défaut « N exécutions ou 24 h »', () => {
    expect(DEFAULT_BATCH_POLICY.maxAgeMs).toBe(24 * 60 * 60 * 1000)
    expect(DEFAULT_BATCH_POLICY.maxBatchSize).toBeGreaterThan(1)
  })

  it('sépare les files par agentId', () => {
    const b = new VerdictBatcher()
    b.enqueue(1n, verdictDocument())
    b.enqueue(2n, verdictDocument())
    b.enqueue(2n, verdictDocument())
    expect(b.size(1n)).toBe(1)
    expect(b.size(2n)).toBe(2)
    expect(b.agents().sort()).toEqual([1n, 2n])
  })
})

describe('publishBatch', () => {
  const docs = [
    verdictDocument({ warrantId: `0x${'a1'.repeat(32)}` as Hex }),
    verdictDocument({ warrantId: `0x${'a2'.repeat(32)}` as Hex }),
  ]

  it('agrège N mandats honorés en un seul feedback', async () => {
    const wallet = walletMock()
    const res = await publishBatch(docs, {
      ...buildOpts,
      reputationRegistry: REPUTATION,
      walletClient: wallet,
      publicClient: identityMock({ authorized: false }),
    })

    expect(res.written).toBe(true)
    if (!res.written) throw new Error('unreachable')
    expect(wallet.calls).toHaveLength(1)
    expect(wallet.calls[0]!.args).toHaveLength(8)
    expect(wallet.calls[0]!.args[4]).toBe('honored')
    expect(wallet.calls[0]!.args[5]).toBe('')

    const doc = res.document as { warrantCount: number; warrants: unknown[] }
    expect(doc.warrantCount).toBe(2)
    expect(doc.warrants).toHaveLength(2)
    expect(verifyFeedbackHash(res.document, res.feedbackHash)).toBe(true)
  })

  it('refuse un lot contenant autre chose qu’un honoré', () => {
    expect(() =>
      buildBatchFeedbackDocument([...docs, verdictDocument({ verdict: 'slashed' })], buildOpts),
    ).toThrow(ReputationError)
  })

  it('refuse un lot vide', () => {
    expect(() => buildBatchFeedbackDocument([], buildOpts)).toThrow(ReputationError)
  })

  it('place proofOfPayment par mandat, pas au niveau du lot', () => {
    const doc = buildBatchFeedbackDocument(docs, {
      ...buildOpts,
      proofsByWarrantId: { [docs[0]!.warrantId.toLowerCase()]: PROOF },
    })
    expect(doc.warrants[0]!.proofOfPayment).toEqual({ ...PROOF, chainId: '8453' })
    expect(doc.warrants[1]!.proofOfPayment).toBeUndefined()
    expect('proofOfPayment' in doc).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Identité — optionnelle, jamais bloquante
// ─────────────────────────────────────────────────────────────────────────────

describe('enregistrement d’agent', () => {
  it('prépare une transaction que l’AGENT enverra, pas Warrant', () => {
    const tx = buildAgentRegistration({
      identityRegistry: IDENTITY,
      agentURI: 'https://agent.example/card.json',
      escrow: ESCROW,
      since: 1_785_000_000,
    })
    expect(tx.to).toBe(IDENTITY)
    expect(tx.value).toBe(0n)
    expect(tx.note).toContain('msg.sender')

    const decoded = decodeFunctionData({ abi: identityRegistryAbi, data: tx.data })
    expect(decoded.functionName).toBe('register')
    const args = decoded.args as readonly unknown[]
    expect(args[0]).toBe('https://agent.example/card.json')
    const metadata = args[1] as readonly { metadataKey: string }[]
    expect(metadata.map((m) => m.metadataKey)).toEqual(['warrant.escrow', 'warrant.since'])
  })

  it('écrit les métadonnées warrant.escrow et warrant.since', () => {
    const calls = buildWarrantMetadataCalls({
      identityRegistry: IDENTITY,
      agentId: AGENT_ID,
      escrow: ESCROW,
      since: 1_785_000_000,
    })
    expect(calls.map((c) => c.key)).toEqual(['warrant.escrow', 'warrant.since'])
    for (const c of calls) {
      expect(c.to).toBe(IDENTITY)
      expect(decodeFunctionData({ abi: identityRegistryAbi, data: c.data }).functionName).toBe(
        'setMetadata',
      )
    }
  })

  it('inspectAgentIdentity ne lève jamais', async () => {
    const absent = await inspectAgentIdentity(undefined, SETTLER, {
      publicClient: identityMock({}),
      identityRegistry: IDENTITY,
    })
    expect(absent.status).toBe('absent')

    const usable = await inspectAgentIdentity(AGENT_ID, SETTLER, {
      publicClient: identityMock({ authorized: false }),
      identityRegistry: IDENTITY,
    })
    expect(usable.status).toBe('usable')

    const unnotable = await inspectAgentIdentity(AGENT_ID, SETTLER, {
      publicClient: identityMock({ authorized: true, owner: SETTLER }),
      identityRegistry: IDENTITY,
    })
    expect(unnotable.status).toBe('unnotable')

    const down = await inspectAgentIdentity(AGENT_ID, SETTLER, {
      publicClient: {
        readContract: async () => {
          throw new Error('RPC injoignable')
        },
      },
      identityRegistry: IDENTITY,
    })
    expect(down.status).toBe('unavailable')
  })
})
