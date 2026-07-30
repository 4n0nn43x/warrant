/**
 * Opening a warrant end to end — an operations tool, not a service.
 *
 * What it is for: putting the settlement daemon to the test against the real
 * chain. With no warrant open, a Settler that runs proves nothing. This script
 * opens one **by the real path** — `open()` signed by the KeeperHub wallet,
 * action executed by KeeperHub, ledger fed — then hands back. The daemon does
 * the rest, without knowing this warrant came from here.
 *
 * It is **not** an alternative to the Gateway: there is no 402, no x402, no MPP,
 * and the agent's USDC is minted on the development MockUSDC instead of being
 * held. What is identical to the production path, on the other hand — and this
 * is what makes the test worth anything:
 *
 *   • classification, pricing and the `ConditionSpec` come out of
 *     `classify` / `priceRisk`, exactly as in `priceAction`;
 *   • `conditionHash` and `actionHash` are computed by `@warrant/core`;
 *   • the opening goes through `keeperHubEscrow`, the port actually deployed;
 *   • **the bond is pulled by `open()` against an EIP-3009 authorization the
 *     agent signs**, exactly as the Gateway does with the authorization the x402
 *     rail carries to it. Only the origin of the signature differs: a local key
 *     here, a third-party agent there. The contract itself sees no difference —
 *     it derives the agent from the signature in both cases;
 *   • the record is written to the same ledger, in the same format.
 *
 * Two scenarios, and the second is the one that counts:
 *
 *   --scenario honored   the executed action is the one committed to;
 *   --scenario diverted  the **executed** action transfers to a destination
 *                        other than the one **committed to**. This is the
 *                        diversion of docs/13 § 5: the post-condition, written by
 *                        the policy and not by the agent, names the allowlist
 *                        destination. A diverted transfer therefore fails by
 *                        construction, and the bond goes to the beneficiary.
 *
 * Usage:
 *   pnpm --filter @warrant/server open-warrant -- --scenario honored
 *   pnpm --filter @warrant/server open-warrant -- --scenario diverted --amount 1000000
 */

import { readFileSync } from 'node:fs'
import {
  WarrantStatus,
  actionHash as hashAction,
  classify,
  conditionHash as hashCondition,
  parseRegistry,
  priceRisk,
  registryRefOf,
  type ActionSpec,
  type Address,
  type Hex,
  type Policy,
} from '@warrant/core'
import { createPublicClient, createWalletClient, encodeFunctionData, http, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import { keeperHubEscrow, termsHashOf, viemEscrow, warrantIdOf } from '../gateway.js'
import { KeeperHubClient } from '../keeperhub.js'
import { fileWarrantStore } from '../journal.js'
import {
  RECEIVE_WITH_AUTHORIZATION_TYPE,
  escrowAuthorizationOf,
} from '../x402.js'

/** ABI of the development MockUSDC. `mint` is public there, by design. */
const mockUsdcAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // The EIP-712 domain `name`: read onchain, never assumed. A divergence of one
  // single character changes the `DOMAIN_SEPARATOR`, hence the digest, hence the
  // recovered address — and `receiveWithAuthorization` reverts with
  // `InvalidSignature` without saying why.
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/** One canonical name per variable, no alias — the `.env.example` convention. */
function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`missing environment variable: ${name}`)
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

function address(name: string, value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name}: EVM address expected, got "${value}"`)
  }
  return value.toLowerCase() as Address
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)))
}

async function main(): Promise<void> {
  for (const candidate of ['.env', '../../.env']) {
    try {
      process.loadEnvFile(candidate)
      break
    } catch {
      /* next one */
    }
  }

  const scenario = arg('scenario', 'honored')
  if (scenario !== 'honored' && scenario !== 'diverted') {
    throw new Error(`--scenario must be honored or diverted, got "${scenario}"`)
  }

  // Chain table, aligned with the one in `bin/gateway.ts`. The tool used to be
  // locked onto Ethereum Sepolia: hard-coding a chain into an operations tool
  // makes it unusable the moment you redeploy elsewhere, which is exactly what
  // happens when the payment facilitator only exists on another chain. A chain
  // absent from the table fails startup rather than letting viem guess an RPC —
  // opening on the wrong chain is irreversible.
  const CHAINS = { 1: mainnet, 8453: base, 11155111: sepolia, 84532: baseSepolia } as const
  const chainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', String(baseSepolia.id)))
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) {
    throw new Error(
      `unsupported WARRANT_ESCROW_CHAIN_ID: ${chainId} — ` +
        `accepted values: ${Object.keys(CHAINS).join(', ')}`,
    )
  }

  const rpc = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])
  const escrow = required('WARRANT_ESCROW_ADDRESS').toLowerCase() as Address
  const token = required('WARRANT_ASSET').toLowerCase() as Address

  // The agent: the one who pays the bond and to whom it returns if the warrant
  // is honored. Its key has **no** onchain role on the escrow — `opener` is the
  // KeeperHub wallet, `settler` is a third key (invariant I10). Here it serves to
  // **sign the EIP-3009 authorization**, which is now its only role in the
  // opening: the contract derives the agent from that signature.
  const agentAccount = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as Hex)
  const agent = agentAccount.address.toLowerCase() as Address

  /**
   * The beneficiary of a slash — `WARRANT_BENEFICIARY`, and required.
   *
   * This parameter used to be `optional('WARRANT_TREASURY', agent)`, which the
   * audit flagged: both branches are now reverts. The treasury is refused by
   * `BeneficiaryIsTreasury` (a slash must not enrich the protocol, invariant I6);
   * the agent itself is refused by `BadBeneficiary` (a slash would reimburse the
   * party at fault, and the bond would no longer mean anything). No fallback can
   * therefore be correct — and a fallback that reverts for certain is worse than
   * a missing variable, because it is only discovered onchain.
   */
  const beneficiary = address('WARRANT_BENEFICIARY', required('WARRANT_BENEFICIARY'))
  if (beneficiary === agent) {
    throw new Error(
      `WARRANT_BENEFICIARY (${beneficiary}) is the agent itself: open() would revert ` +
        'with BadBeneficiary(). A slash would reimburse the party at fault.',
    )
  }
  if (beneficiary === escrow) {
    throw new Error(
      `WARRANT_BENEFICIARY (${beneficiary}) is the escrow: open() would revert with ` +
        'BadBeneficiary(). The bond would leave the liabilities without leaving the contract.',
    )
  }

  const publicClient = createPublicClient({ chain, transport: http(rpc) })
  const wallet = createWalletClient({ account: agentAccount, chain, transport: http(rpc) })

  // The treasury **of the contract**, not that of the local policy: this is what
  // `open()` compares the beneficiary against. `treasury` is `immutable`, so this
  // read is final for this deployment.
  const onchainTreasury = (
    (await publicClient.readContract({
      address: escrow,
      abi: warrantEscrowAbi,
      functionName: 'treasury',
    })) as string
  ).toLowerCase() as Address
  if (beneficiary === onchainTreasury) {
    throw new Error(
      `WARRANT_BENEFICIARY (${beneficiary}) is the escrow's treasury: open() would ` +
        'revert with BeneficiaryIsTreasury(). A slash cannot feed the protocol ' +
        '(invariant I6).',
    )
  }

  const kh = new KeeperHubClient({
    apiKey: required('KH_API_KEY'),
    baseUrl: optional('KH_BASE_URL', 'https://app.keeperhub.com'),
  })
  const executor = ((await kh.getWallet()).walletAddress ?? '').toLowerCase() as Address
  if (!executor) throw new Error('KeeperHub reports no organization wallet')

  const registryFile = optional(
    'WARRANT_REGISTRY_FILE',
    // The registry follows the chain: a `registryRef` is specific to a network.
    optional(
      'WARRANT_REGISTRY_FILE',
      new URL('../../../../deployments/registry-ethereum-sepolia.json', import.meta.url).pathname,
    ),
  )
  const registry = parseRegistry(readFileSync(registryFile, 'utf8'))
  const registryRef = registryRefOf(registry)

  const amount = BigInt(arg('amount', '1000000'))
  // The policy's floor, and not a constant: on a chain whose capital comes from a
  // capped faucet, a hard-coded bond makes the tool unusable — which is what
  // happened on Base Sepolia, where the CDP faucet hands out 1 USDC per address
  // per 24 h.
  const bond = BigInt(arg('bond', optional('WARRANT_MIN_BOND', '5000000')))
  const duration = Number(arg('duration', '1800'))

  // The **committed** destination, the one on the policy's allowlist.
  const allowedDest = optional('DEMO_ALLOWED_DEST', '0x000000000000000000000000000000000000dEaD')
    .toLowerCase() as Address
  // The destination actually served. It differs only in the diverted scenario.
  const executedDest =
    scenario === 'diverted'
      ? (optional('DEMO_DIVERTED_DEST', '0x00000000000000000000000000000000DeaDBeef').toLowerCase() as Address)
      : allowedDest

  /**
   * The capital owner's policy.
   *
   * `treasury` is the **protected** account: here the KeeperHub execution wallet,
   * since that is what holds and moves the funds. `allowedDest` is the allowlist
   * — it is the allowlist, and not the calldata, that decides the destination
   * committed to in the post-condition.
   */
  const policy: Policy = {
    beneficiary,
    treasury: executor,
    minBond: optional('WARRANT_MIN_BOND', '5000000'),
    maxBond: optional('WARRANT_MAX_BOND', '250000000'),
    duration,
    categories: {
      'erc20.transfer': {
        riskBps: 100,
        maxOutflow: amount.toString(10),
        allowedDest: [allowedDest],
      },
    },
  }

  // 1. The committed action. The only input to classification and pricing.
  const actionSpec: ActionSpec = {
    version: 1,
    chainId,
    target: token,
    value: '0',
    calldata: encodeFunctionData({
      abi: mockUsdcAbi,
      functionName: 'transfer',
      args: [allowedDest, amount],
    }),
    registryRef,
  }

  const classification = classify(actionSpec, registry)
  const actionHash = hashAction(actionSpec)
  const quote = priceRisk(classification, policy, { chainId, actionHash, executor })
  const conditionSpec = quote.conditionSpec
  const conditionHash = hashCondition(conditionSpec)

  const nonce = BigInt(toHex(crypto.getRandomValues(new Uint8Array(32))))
  const warrantId = warrantIdOf(agent, nonce, actionHash)

  log({
    msg: 'warrant prepared',
    scenario,
    warrantId,
    agent,
    beneficiary,
    executor,
    bond: bond.toString(10),
    category: quote.category,
    conditionHash,
    actionHash,
    registryRef,
    checks: conditionSpec.checks.map((c) => c.kind),
  })

  // 2. Fund **the agent**, and not the escrow.
  //
  //    This is the substantive change in this step. `open()` no longer expects to
  //    find the funds on the contract — it *pulls* them from the agent, against
  //    the agent's signature, in its own transaction. Paying the escrow in
  //    advance would reconstitute exactly the flaw that was fixed: a free balance
  //    the `opener` can assign to itself, and that no function knows how to sweep
  //    if the opening never happens.
  const agentBalance = (await publicClient.readContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [agent],
  })) as bigint
  if (agentBalance < bond) {
    const funded = await wallet.writeContract({
      address: token,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [agent, bond * 10n],
    })
    await publicClient.waitForTransactionReceipt({ hash: funded })
    log({ msg: 'agent funded', tx: funded, bond: bond.toString(10) })
  }

  // 3. The EIP-3009 authorization, signed by the agent.
  //
  //    ⚠ `ReceiveWithAuthorization`, **not** `TransferWithAuthorization`. The two
  //    types carry the same fields and produce two different typehashes, hence
  //    two different digests. The contract calls the `receive` variant because it
  //    enforces `to == msg.sender`: without it, a third party could submit the
  //    authorization to the token directly, consume the nonce, and make the
  //    legitimate `open` revert. Signing the wrong type produces no error here —
  //    only an `InvalidSignature()` onchain.
  const assetName = (await publicClient.readContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'name',
  })) as string
  const assetVersion = optional('WARRANT_ASSET_VERSION', '2')

  /**
   * The authorization's nonce **is not random**: it equals the hash of the
   * warrant's terms, and the contract checks it (`TermsMismatch`).
   *
   * This is the defence against authorization diversion. EIP-3009 signs only six
   * fields, none of which says *for which warrant*: an `opener` could therefore
   * take an authorization and open terms of its own choosing — another
   * beneficiary, another post-condition, `duration` at maximum. Since the nonce
   * is inside the signed digest, constraining it to equal `termsHash(...)` makes
   * signing the payment amount to signing the terms. One single signature.
   *
   * The uniqueness EIP-3009 demands of the nonce still holds: `warrantId`
   * contains `nonce`, which is itself random, and goes into the hash.
   */
  const authNonce = termsHashOf({
    id: warrantId,
    beneficiary,
    bond: bond.toString(10),
    conditionHash,
    actionHash,
    duration,
  })
  const validAfter = 0n
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600)

  const signature = await agentAccount.signTypedData({
    domain: {
      name: assetName,
      version: assetVersion,
      chainId,
      verifyingContract: token,
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPE,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: agent,
      // `to` is the escrow, and the contract will pass `address(this)` to the
      // token: the two must coincide, otherwise `CallerMustBePayee()`.
      to: escrow,
      value: bond,
      validAfter,
      validBefore,
      nonce: authNonce,
    },
  })

  const authorization = escrowAuthorizationOf({
    signature,
    authorization: {
      from: agent,
      to: escrow,
      value: bond.toString(10),
      validAfter: validAfter.toString(10),
      validBefore: validBefore.toString(10),
      nonce: authNonce,
    },
  })
  const fundingRef = authorization.nonce
  log({
    msg: 'EIP-3009 authorization signed',
    primaryType: 'ReceiveWithAuthorization',
    // The nonce IS the terms hash: the signature binds the payment to the warrant.
    nonceIsTermsHash: true,
    from: agent,
    to: escrow,
    value: bond.toString(10),
    fundingRef,
  })

  // 4. The execution wallet must hold enough to transfer.
  const executorBalance = (await publicClient.readContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [executor],
  })) as bigint
  if (executorBalance < amount) {
    const topUp = await wallet.writeContract({
      address: token,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [executor, amount * 10n],
    })
    await publicClient.waitForTransactionReceipt({ hash: topUp })
    log({ msg: 'execution wallet funded', tx: topUp })
  }

  // 5. Opening. This transaction collects the bond **and** opens the warrant: if
  //    it reverts, the nonce is not consumed and nothing has moved.
  //
  //    The port follows `WARRANT_ESCROW_PORT`, like the Gateway, because the
  //    contract supports both topologies: `keeperhub` when the `opener` is the
  //    organization's wallet (gas-sponsored opening, the volume case), `viem` when
  //    it is a local key. Hard-coding either one made the tool unusable on half
  //    the deployments.
  const escrowPort =
    optional('WARRANT_ESCROW_PORT', 'keeperhub') === 'viem'
      ? viemEscrow(
          {
            address: escrow,
            account: agentAccount.address.toLowerCase() as Address,
            chain: publicClient.chain!,
            walletClient: wallet as unknown as {
              writeContract(args: Record<string, unknown>): Promise<Hex>
            },
          },
          warrantEscrowAbi,
        )
      : keeperHubEscrow({ address: escrow, chainId, client: kh, abi: warrantEscrowAbi })

  const openTx = await escrowPort.open({
    id: warrantId,
    beneficiary,
    bond: bond.toString(10),
    conditionHash,
    actionHash,
    duration,
    authorization,
  })
  // `waitForTransactionReceipt` and not `getTransactionReceipt`: the latter does
  // not wait, and on a public RPC the receipt is not yet indexed when the
  // transaction has just gone out. The tool therefore failed AFTER having opened
  // the warrant onchain — and without writing the ledger, which left the bond
  // unevaluable by the Settler until expiry.
  const openReceipt = await publicClient.waitForTransactionReceipt({
    hash: openTx,
    confirmations: 1,
  })
  const openedAt = Number(
    (await publicClient.getBlock({ blockNumber: openReceipt.blockNumber })).timestamp,
  )
  log({ msg: 'warrant opened', warrantId, openTx, openedAt, expiry: openedAt + duration })

  // 6. The action. In the diverted scenario, what goes out on the chain is
  //    **not** what was committed to — that is the whole point.
  const execution = await kh.executeContractCall(
    {
      chainId,
      contractAddress: token,
      functionName: 'transfer',
      functionArgs: [executedDest, amount.toString(10)],
      abi: mockUsdcAbi,
    },
    warrantId,
  )
  log({
    msg: 'action executed',
    executionId: execution.executionId,
    status: execution.status,
    txHash: execution.txHash,
    executedDest,
    engagedDest: allowedDest,
    diverted: executedDest !== allowedDest,
  })

  // 7. The ledger. It is the only thing the Settler cannot recover on its own:
  //    the chain carries nothing but hashes. `openTx` is indispensable there: it
  //    is the transaction that collected the bond, hence the only resolvable
  //    proof of payment — `fundingRef` is now no more than a nonce.
  const journal = fileWarrantStore({ path: optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl') })
  journal.put({
    id: warrantId,
    agent,
    beneficiary,
    bond: bond.toString(10),
    conditionHash,
    actionHash,
    fundingRef,
    expiry: openedAt + duration,
    openedAt,
    status: WarrantStatus.Open,
    rail: 'x402',
    executionId: execution.executionId,
    openTx,
    actionSpec,
    conditionSpec,
    classification,
    quote,
    simulation: { success: true },
    settlement: {
      success: true,
      // The settlement transaction **is** the opening, ever since `open()` pulls
      // the EIP-3009 payment itself.
      transaction: openTx,
      network: `eip155:${chainId}`,
      payer: agent,
      amount: bond.toString(10),
    },
  })
  log({ msg: 'ledger line written', path: journal.path, warrantId })
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: 'opening failed', error: String(e) }))
  process.exit(1)
})
