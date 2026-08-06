/**
 * Entry point of the 402 Gateway.
 *
 * All configuration comes from the environment, and nothing has a permissive
 * default value: a missing variable fails startup with the name of the variable.
 * A server that starts half-configured would open warrants it would not know how
 * to settle.
 *
 * **Variable naming convention** (identical in `.env`, `.env.example` and here —
 * no alias is accepted, one name and one only):
 *
 * - the **prefix** is the name the subsystem gives itself: `KH_` for KeeperHub
 *   (its CLI is `kh`, its keys start with `kh_`), `X402_`, `MPP_`, `ERC8004_`,
 *   and `WARRANT_` for what belongs to this repository;
 * - the **suffix** names the type of the value when it is ambiguous: `_RPC` for a
 *   JSON-RPC endpoint, `_URL` for an HTTP service URL, `_KEY` for a secret,
 *   `_FILE` for a path, `_CHAIN_ID`, `_BPS`;
 * - a variable that designates an **EVM address** carries the name of the *role*
 *   and not that of the type (`WARRANT_BENEFICIARY`, `WARRANT_TREASURY`,
 *   `WARRANT_ASSET`, `WARRANT_PAY_TO`): the role is what gets verified, the
 *   address merely embodies it.
 *
 * `MPP_SECRET_KEY`, `OPENER_PRIVATE_KEY` and `KH_API_KEY` are never logged, never
 * included in a response, and do not appear in the startup summary — only a
 * truncated fingerprint of the MPP secret figures there.
 *
 * Usage:
 *   pnpm --filter @warrant/server gateway
 */

import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { loadRegistry, parseRegistry, type Address, type Policy } from '@warrant/core'
import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../escrow-abi.js'
import {
  createGateway,
  keeperHubEscrow,
  keeperHubExecutor,
  viemEscrow,
  type EscrowPort,
} from '../gateway.js'
import { DEFAULT_MPP_METHOD } from '../openapi.js'
import { fileWarrantStore } from '../journal.js'
import { KeeperHubClient } from '../keeperhub.js'
import { FacilitatorClient } from '../x402.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `missing environment variable: ${name} — ` +
        'see packages/server/src/bin/gateway.ts for the full list',
    )
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

/**
 * The capital owner's policy.
 *
 * A JSON file for preference (`WARRANT_POLICY_FILE`): a policy is a document you
 * re-read and version, not a handful of environment variables. The fallback via
 * variables exists for the demo.
 */
/**
 * A comma-separated list of addresses.
 *
 * It is declared `required` and not `optional`, and that is the point: an
 * outbound category with no allowed destination used to produce a post-condition
 * from which both destination checks had disappeared **silently**. A transfer to
 * any address whatsoever then passed the remaining checks and the bond was given
 * back. `buildConditionSpec` now refuses that case, but a refusal at the moment
 * of opening a warrant is bad news that arrives late: better that the server not
 * start at all, naming the variable that is missing.
 */
function addressList(name: string, raw: string): Address[] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (items.length === 0) {
    throw new Error(`${name}: at least one address is required, the list is empty`)
  }
  return items.map((value) => address(name, value))
}

function loadPolicy(): Policy {
  const file = process.env['WARRANT_POLICY_FILE']
  if (file && file.trim() !== '') {
    return JSON.parse(readFileSync(file.trim(), 'utf8')) as Policy
  }
  const allowedDest = addressList('WARRANT_ALLOWED_DEST', required('WARRANT_ALLOWED_DEST'))
  const watchedTokens = process.env['WARRANT_WATCHED_TOKENS']
    ? addressList('WARRANT_WATCHED_TOKENS', process.env['WARRANT_WATCHED_TOKENS'])
    : undefined

  return {
    beneficiary: address('WARRANT_BENEFICIARY', required('WARRANT_BENEFICIARY')),
    treasury: address('WARRANT_TREASURY', required('WARRANT_TREASURY')),
    minBond: optional('WARRANT_MIN_BOND', '5000000'),
    maxBond: optional('WARRANT_MAX_BOND', '250000000'),
    duration: Number(optional('WARRANT_DURATION', '3600')),
    ...(watchedTokens ? { watchedTokens } : {}),
    categories: {
      'erc20.transfer': {
        riskBps: 100,
        maxOutflow: optional('WARRANT_MAX_OUTFLOW', '0'),
        allowedDest,
      },
      'erc20.approve': { riskBps: 50, maxOutflow: '0', allowedDest },
      'aavev3.repay': { riskBps: 25 },
      'aavev3.supply': { riskBps: 25 },
      'aavev3.withdraw': { riskBps: 150, allowedDest },
      'aavev3.borrow': { riskBps: 200, allowedDest },
    },
  }
}

/**
 * Chains where an escrow can be deployed.
 *
 * Sepolia figures here because that is where `WarrantEscrow` actually runs today
 * (deployments/ethereum-sepolia.json); the mainnets figure here because they are
 * the target of the submission. A chain absent from this table fails startup
 * rather than letting viem guess an RPC — opening a warrant on the wrong chain is
 * irreversible.
 */
const CHAINS = {
  1: mainnet,
  8453: base,
  11155111: sepolia,
  84532: baseSepolia,
} as const

/**
 * Does the configured x402 facilitator actually serve our scheme and our chain?
 *
 * We do not delegate signature verification to it — the escrow consumes
 * `receiveWithAuthorization`, outside the `exact` scheme, and the token is
 * authoritative inside `open()`. But we announce this facilitator in every 402
 * challenge: if it does not cover our network, we are issuing challenges nobody
 * can honor, and the failure only shows up at the first payment.
 *
 * Non-fatal by design. A momentarily unreachable facilitator invalidates no
 * warrant already open, and refusing to start over it would immobilize
 * settlement — and settlement is what protects the bonds.
 */
async function facilitatorPreflight(
  facilitator: FacilitatorClient,
  network: string,
): Promise<void> {
  try {
    const { kinds } = await facilitator.supported()
    const served = kinds.some((k) => k.scheme === 'exact' && k.network === network)
    console.log(
      JSON.stringify({
        msg: 'facilitator preflight',
        network,
        servesExactOnOurNetwork: served,
        schemes: [...new Set(kinds.map((k) => k.scheme))],
        note: served
          ? undefined
          : `the facilitator does not declare serving exact on ${network}: the 402 challenges will be unhonorable`,
      }),
    )
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'facilitator preflight unreachable — startup continued',
        detail: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/** Builds the opening port, and returns the address that will actually sign. */
async function buildEscrow(opts: {
  mode: string
  escrowAddress: Address
  chainId: number
  chain: (typeof CHAINS)[keyof typeof CHAINS]
  rpcUrl: string
  keeperHubApiKey: string
  keeperHubBaseUrl: string
}): Promise<{ escrow: EscrowPort; opener: Address; via: string }> {
  if (opts.mode === 'viem') {
    // Path kept for a deployment where the `opener` is a local key. It is no
    // longer the default path: the onchain `opener` is today the KeeperHub
    // organization's wallet, and this key would be answered `NotOpener()`. The
    // consistency check further down says so unambiguously.
    const account = privateKeyToAccount(required('OPENER_PRIVATE_KEY') as `0x${string}`)
    const walletClient = createWalletClient({
      account,
      chain: opts.chain,
      transport: http(opts.rpcUrl),
    })
    return {
      escrow: viemEscrow(
        {
          address: opts.escrowAddress,
          account: account.address.toLowerCase() as Address,
          chain: opts.chain,
          walletClient: walletClient as unknown as {
            writeContract(args: Record<string, unknown>): Promise<`0x${string}`>
          },
        },
        warrantEscrowAbi,
      ),
      opener: account.address.toLowerCase() as Address,
      via: `local key ${account.address}`,
    }
  }

  if (opts.mode !== 'keeperhub') {
    throw new Error(
      `unknown WARRANT_ESCROW_PORT: "${opts.mode}" — accepted values: keeperhub, viem`,
    )
  }

  const client = new KeeperHubClient({
    apiKey: opts.keeperHubApiKey,
    baseUrl: opts.keeperHubBaseUrl,
  })
  // The wallet is *organization-scoped*: an organization has exactly one, and it
  // is the one that will sign. We read it rather than configure it — an address
  // copied by hand into a `.env` is one more opportunity to diverge from onchain
  // reality.
  const wallet = await client.getWallet()
  if (!wallet.hasWallet || !wallet.walletAddress) {
    throw new Error(
      'KeeperHub reports no execution wallet for this organization: ' +
        'impossible to open a warrant (GET /api/user/wallet)',
    )
  }
  return {
    escrow: keeperHubEscrow({
      address: opts.escrowAddress,
      chainId: opts.chainId,
      client,
      abi: warrantEscrowAbi,
    }),
    opener: wallet.walletAddress.toLowerCase() as Address,
    via: `KeeperHub wallet ${wallet.walletAddress}`,
  }
}

/**
 * Consistency check at startup: is the address that will open really the
 * contract's `opener`?
 *
 * This is not zeal. The divergence has happened — the `opener` role was
 * transferred to the KeeperHub wallet without the local configuration knowing it
 * — and it only shows up at the first **paying** warrant: the bond is settled,
 * then `open()` reverts with `NotOpener()`. The cost of a refused startup is
 * zero, the cost of a discovery in production is a bond taken for nothing.
 *
 * We also read the `settler`, solely to verify invariant I10: if the contract had
 * ended up with `opener == settler`, the component that opens could slash, and
 * the whole security argument would be false.
 *
 * A **network** failure does not block startup: we cannot tell an unavailable RPC
 * from a real divergence, and refusing to start over a hiccuping RPC would be a
 * denial of service we inflicted on ourselves. An *observed* divergence, on the
 * other hand, is fatal.
 */
async function preflight(opts: {
  escrowAddress: Address
  chain: (typeof CHAINS)[keyof typeof CHAINS]
  rpcUrl: string
  opener: Address
  beneficiary: Address
  asset: Address
}): Promise<
  | { opener: Address; settler: Address; feeBps: number; treasury: Address; token: Address }
  | undefined
> {
  const publicClient = createPublicClient({
    chain: opts.chain,
    transport: http(opts.rpcUrl),
  })
  let onchain: {
    opener: Address
    settler: Address
    feeBps: number
    treasury: Address
    token: Address
  }
  try {
    const [opener, settler, feeBps, treasury, token] = await Promise.all([
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'opener',
      }),
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'settler',
      }),
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'feeBps',
      }),
      // `treasury` and `token` are `immutable`: these two reads hold for the
      // lifetime of the contract, and let us refuse at startup two configurations
      // that would only revert at the first paying warrant.
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'treasury',
      }),
      publicClient.readContract({
        address: opts.escrowAddress,
        abi: warrantEscrowAbi,
        functionName: 'token',
      }),
    ])
    onchain = {
      opener: (opener as string).toLowerCase() as Address,
      settler: (settler as string).toLowerCase() as Address,
      feeBps: Number(feeBps),
      treasury: (treasury as string).toLowerCase() as Address,
      token: (token as string).toLowerCase() as Address,
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'escrow preflight unreachable — startup continued',
        detail: err instanceof Error ? err.message : String(err),
        rpc: opts.rpcUrl,
      }),
    )
    return undefined
  }

  if (onchain.opener !== opts.opener) {
    throw new Error(
      `inconsistent opener: contract ${opts.escrowAddress} has opener ` +
        `${onchain.opener}, but the Gateway would open with ${opts.opener}. ` +
        'Every `open()` would revert with NotOpener() *after* the bond had been ' +
        'settled. Fix WARRANT_ESCROW_PORT, or transfer the role onchain.',
    )
  }
  if (onchain.opener === onchain.settler) {
    throw new Error(
      `invariant I10 violated onchain: opener == settler == ${onchain.opener}. ` +
        'The component that opens could slash.',
    )
  }

  // The policy's beneficiary is refused by `open()` if it is the contract's
  // treasury (`BeneficiaryIsTreasury`, invariant I6: a slash must not enrich the
  // protocol). The treasury being `immutable`, the divergence is permanent — and
  // would be discovered at the first paying warrant, after the agent has signed
  // its authorization.
  if (onchain.treasury === opts.beneficiary) {
    throw new Error(
      `WARRANT_BENEFICIARY (${opts.beneficiary}) is the treasury of contract ` +
        `${opts.escrowAddress}: every open() would revert with BeneficiaryIsTreasury(). ` +
        'A slash cannot feed the protocol (invariant I6).',
    )
  }

  // The asset announced in the 402 must be the token the escrow will pull. A
  // discrepancy means the agent would sign an EIP-3009 authorization on an
  // EIP-712 domain — hence a token — that the contract will never call.
  if (onchain.token !== opts.asset) {
    throw new Error(
      `WARRANT_ASSET (${opts.asset}) is not the escrow's token ` +
        `(${onchain.token}). The EIP-3009 authorization would be signed for the wrong ` +
        'token and open() would revert.',
    )
  }
  return onchain
}

async function main(): Promise<void> {
  const port = Number(optional('PORT', '8402'))
  const baseUrl = optional('WARRANT_BASE_URL', `http://localhost:${port}`)
  const escrowChainId = Number(optional('WARRANT_ESCROW_CHAIN_ID', '8453'))
  const chain = CHAINS[escrowChainId as keyof typeof CHAINS]
  if (!chain) {
    throw new Error(
      `unsupported WARRANT_ESCROW_CHAIN_ID: ${escrowChainId} — ` +
        `known chains: ${Object.keys(CHAINS).join(', ')}`,
    )
  }
  const rpcUrl = optional('WARRANT_ESCROW_RPC', chain.rpcUrls.default.http[0])

  const registryFile = process.env['WARRANT_REGISTRY_FILE']
  const registry =
    registryFile && registryFile.trim() !== ''
      ? parseRegistry(readFileSync(registryFile.trim(), 'utf8'))
      : loadRegistry()

  const policy = loadPolicy()
  const escrowAddress = address(
    'WARRANT_ESCROW_ADDRESS',
    required('WARRANT_ESCROW_ADDRESS'),
  )

  // An organization key `kh_`. A `wfb_` key is a user webhook key and will be
  // rejected with a 401 on the execution routes.
  const keeperHubApiKey = required('KH_API_KEY')
  const keeperHubBaseUrl = optional('KH_BASE_URL', 'https://app.keeperhub.com')
  if (keeperHubApiKey.startsWith('wfb_')) {
    console.warn(
      'warning: KH_API_KEY starts with `wfb_`, a user webhook key. ' +
        'The execution routes require an organization key `kh_`.',
    )
  }

  // KeeperHub by default, because that is the real state of the deployment and
  // not a preference: `opener()` is the organization's wallet (docs/transactions
  // § 3). The default must be what works, not what used to work.
  const escrowMode = optional('WARRANT_ESCROW_PORT', 'keeperhub')
  const { escrow, opener, via } = await buildEscrow({
    mode: escrowMode,
    escrowAddress,
    chainId: escrowChainId,
    chain,
    rpcUrl,
    keeperHubApiKey,
    keeperHubBaseUrl,
  })

  const asset = address('WARRANT_ASSET', required('WARRANT_ASSET'))

  /**
   * `payTo` **is** the escrow, and that is no longer a configuration choice.
   *
   * `open()` calls `receiveWithAuthorization`, whose `receive` variant requires
   * `to == msg.sender` — hence `to == address(escrow)`. But `to` is in the EIP-712
   * digest the agent signs, and it equals `payTo` by construction of the `exact`
   * scheme. A `WARRANT_PAY_TO` distinct from the escrow would therefore produce a
   * signature the token refuses with `CallerMustBePayee()`, at payment time, with
   * nothing pointing at the offending variable.
   *
   * It was a free vault address back when the facilitator settled the payment and
   * then transferred the funds; now that the opening collects the payment itself,
   * the two roles have merged.
   */
  const payTo = address('WARRANT_PAY_TO', required('WARRANT_PAY_TO'))
  if (payTo !== escrowAddress) {
    throw new Error(
      `WARRANT_PAY_TO (${payTo}) must be the escrow's address ` +
        `(WARRANT_ESCROW_ADDRESS = ${escrowAddress}): open() calls ` +
        'receiveWithAuthorization, whose `receive` variant requires to == msg.sender. ' +
        'Any authorization signed for another address would be refused by the token ' +
        'with CallerMustBePayee().',
    )
  }

  const onchain =
    optional('WARRANT_SKIP_PREFLIGHT', '0') === '1'
      ? undefined
      : await preflight({
          escrowAddress,
          chain,
          rpcUrl,
          opener,
          beneficiary: policy.beneficiary,
          asset,
        })

  const mppSecret = required('MPP_SECRET_KEY')

  // Pulled out into a variable so it can be probed at startup: we announce this
  // facilitator in every 402 challenge, so we may as well check that it serves
  // our network before issuing one.
  const facilitator = new FacilitatorClient({
    url: optional('X402_FACILITATOR', 'https://x402.org/facilitator'),
    ...(process.env['X402_FACILITATOR_API_KEY']
      ? { apiKey: process.env['X402_FACILITATOR_API_KEY'] }
      : {}),
  })
  const network = optional('WARRANT_NETWORK', `eip155:${escrowChainId}`)
  await facilitatorPreflight(facilitator, network)

  const app = createGateway({
    registry,
    policy,
    baseUrl,
    /**
     * The ledger, and not the in-memory store.
     *
     * The onchain events carry nothing but *hashes*: `conditionHash` is not
     * invertible, so the chain alone does not suffice to re-evaluate a warrant.
     * The Settler needs the `ConditionSpec` and `ActionSpec` in the clear, and it
     * is the Gateway — the only party to have seen them — that must write them.
     *
     * With `memoryWarrantStore()`, a Gateway restart made every already-open
     * warrant permanently unevaluable: the bond stayed locked until `reclaim`.
     * That happened for real, on two warrants.
     *
     * The ledger remains without authority: the Settler recomputes
     * `conditionHash` and `actionHash` from the specs read here and compares them
     * to the onchain commitment. A falsified line therefore leads to abstention,
     * never to a slash.
     */
    store: fileWarrantStore(optional('WARRANT_JOURNAL_FILE', '.warrant/warrants.jsonl')),
    realm: optional('WARRANT_REALM', 'warrant'),
    network,
    asset,
    payTo,
    assetExtra: {
      name: optional('WARRANT_ASSET_NAME', 'USDC'),
      // ⚠ The token's real EIP-712 domain. To be read onchain rather than taken
      // on trust: a wrong `version` makes every signature fail.
      version: optional('WARRANT_ASSET_VERSION', '2'),
    },
    facilitator,
    executor: keeperHubExecutor({
      apiKey: keeperHubApiKey,
      baseUrl: keeperHubBaseUrl,
    }),
    escrow,
    mppSecret,
    mppMethod: optional('MPP_METHOD', DEFAULT_MPP_METHOD),
    mppCurrency: optional('MPP_CURRENCY', 'USDC'),
    challengeTtlSeconds: Number(optional('MPP_CHALLENGE_TTL', '300')),
  })

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      JSON.stringify({
        msg: 'warrant gateway',
        port: info.port,
        baseUrl,
        escrowChainId,
        escrow: escrowAddress,
        escrowPort: escrowMode,
        opener,
        openerVia: via,
        // Confirmation that what was read onchain matches what we believe.
        // Absent if the RPC did not answer — the absence is then the information.
        ...(onchain
          ? { onchainSettler: onchain.settler, onchainFeeBps: onchain.feeBps }
          : { preflight: 'skipped' }),
        beneficiary: policy.beneficiary,
        treasury: policy.treasury,
        bondRange: [policy.minBond, policy.maxBond],
        // A fingerprint of the secret, never the secret. Lets us check that we
        // deployed the same key as the client without ever exposing it.
        mppSecretFingerprint: createHash('sha256')
          .update(mppSecret)
          .digest('hex')
          .slice(0, 8),
      }),
    )
  })
}

main().catch((err: unknown) => {
  // A refused startup must say *what* to fix, on a single line, and exit in
  // failure: a supervisor restarting in a loop on a clear message costs less than
  // a server running misconfigured.
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
