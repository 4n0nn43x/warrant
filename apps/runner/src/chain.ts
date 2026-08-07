/**
 * The runner's onchain reads — and reads only.
 *
 * The runner never writes to the chain: the opening goes out from the KeeperHub
 * wallet (sponsored, invariant I10), the settlement from the Settler's key. This
 * file therefore exists only to **count**, and to refuse to start when the
 * configuration would make it spend for nothing.
 *
 * Why the chain and not the ledger for the counters: the ledger says what was
 * *opened*, never what was *settled* — the Settler settles, in another process,
 * and it does not rewrite the ledger. A counter reading the ledger alone would
 * therefore announce 150 "open" warrants and zero honored, indefinitely.
 * `getWarrant(id)` is the only source that knows `status`, and it is the one the
 * jury can replay.
 *
 * ⚠ The ABI is imported from `@warrant/server`'s **sources**, not from its
 * `dist/`: the `dist/` checked into the tree predates the addition of
 * `getWarrant`, and a runner reading a flat `warrants()` off a stale ABI would
 * shift `status` by one slot — `feeBpsAtOpen` is 250, which is no known status
 * and which `WarrantStatus[250]` turns into `undefined` without throwing. The
 * price we accept: `tsx`/`tsc` resolve the relative path, so the runner only
 * runs from inside the monorepo. It is an operations tool, not a published
 * package.
 */

import { WarrantStatus, type Address, type Hex } from 'warrant-core'
import { createPublicClient, http, type PublicClient } from 'viem'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../../../packages/server/src/escrow-abi.js'

/**
 * Known chains, aligned with `bin/settler.ts` and `bin/open-warrant.ts`.
 * A missing chain fails startup rather than letting viem guess an RPC: opening
 * 150 warrants on the wrong chain is irreversible.
 */
export const CHAINS = { 1: mainnet, 8453: base, 11155111: sepolia, 84532: baseSepolia } as const

/**
 * Chains a volume runner is allowed to run on.
 *
 * Deny by default, and the list is the one of testnets rather than the one of
 * mainnets — because the latter is open-ended. The runner opens hundreds of
 * warrants with no human confirmation: it is exactly the kind of program that
 * must never be launchable on a mainnet by merely inheriting a `.env`.
 */
export const VOLUME_ALLOWED_CHAIN_IDS = new Set([11155111, 84532, 421614, 11155420])

export function chainOf(chainId: number) {
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) {
    throw new Error(
      `unsupported WARRANT_ESCROW_CHAIN_ID: ${chainId} — ` +
        `accepted values: ${Object.keys(CHAINS).join(', ')}`,
    )
  }
  return chain
}

export function publicClientFor(chainId: number, rpc: string): PublicClient {
  return createPublicClient({ chain: chainOf(chainId), transport: http(rpc) }) as PublicClient
}

/** A warrant exactly as the chain returns it. No interpretation. */
export interface OnchainWarrant {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  expiry: number
  openedAt: number
  feeBpsAtOpen: number
  status: WarrantStatus
}

export const ERC20_READ_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/**
 * Status of several warrants, in **one** round trip per batch.
 *
 * `multicall` rather than N `readContract`: the counters are recomputed on every
 * opening, and over 150 warrants a naive loop would make 150 requests per pass,
 * an order of magnitude above what a public RPC tolerates. The batch size stays
 * modest — an aggregate `eth_call` that grows too big gets refused on the call's
 * gas limit, not on a size limit, and the message does not say so.
 */
export async function readWarrants(
  client: PublicClient,
  escrow: Address,
  ids: readonly Hex[],
  batchSize = 50,
): Promise<Map<string, OnchainWarrant>> {
  const out = new Map<string, OnchainWarrant>()
  for (let i = 0; i < ids.length; i += batchSize) {
    const slice = ids.slice(i, i + batchSize)
    const results = (await client.multicall({
      allowFailure: true,
      contracts: slice.map((id) => ({
        address: escrow,
        abi: warrantEscrowAbi,
        functionName: 'getWarrant',
        args: [id],
      })),
    })) as unknown as { status: 'success' | 'failure'; result?: unknown }[]
    for (const [k, result] of results.entries()) {
      const id = slice[k]!
      // A failed read is not an absent warrant: the distinction matters, because
      // a warrant we cannot read must not be counted as `None` — it would drop
      // out of the counters without anyone noticing.
      if (result.status !== 'success') continue
      const w = result.result as unknown as {
        agent: Address
        beneficiary: Address
        bond: bigint
        expiry: bigint
        openedAt: bigint
        feeBpsAtOpen: number
        status: number
      }
      out.set(id.toLowerCase(), {
        id: id.toLowerCase() as Hex,
        agent: w.agent.toLowerCase() as Address,
        beneficiary: w.beneficiary.toLowerCase() as Address,
        bond: w.bond,
        expiry: Number(w.expiry),
        openedAt: Number(w.openedAt),
        feeBpsAtOpen: Number(w.feeBpsAtOpen),
        status: Number(w.status) as WarrantStatus,
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Event scan — the second source, independent of the ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The escrow's deployment block, by bisection on `eth_getCode`.
 *
 * Why not read it from `deployments/base-sepolia.json`: that file is *our* claim.
 * A verification that bounds its scan with a number we wrote ourselves can miss
 * exactly what it is looking for — a warrant opened before the announced block.
 * Bisection trusts nothing but the node: ≈ 25 `eth_getCode` for a starting point
 * nobody has to take on faith.
 *
 * `low` is not 0: on a chain 44 million blocks long, starting from genesis adds
 * 26 requests for nothing. We start at the head minus `maxLookback` and check
 * that the contract did **not** exist at that block — otherwise we say so, and
 * the caller is free to go lower rather than scan a window that silently
 * truncates the history.
 */
export async function deploymentBlock(
  client: PublicClient,
  address: Address,
  maxLookback = 2_000_000n,
): Promise<{ block: bigint; head: bigint; complete: boolean }> {
  const head = await client.getBlockNumber()
  let low = head > maxLookback ? head - maxLookback : 0n
  const codeAtLow = await client.getCode({ address, blockNumber: low })
  if (codeAtLow && codeAtLow !== '0x') {
    return { block: low, head, complete: false }
  }
  let high = head
  while (low < high) {
    const mid = (low + high) / 2n
    const code = await client.getCode({ address, blockNumber: mid })
    if (code && code !== '0x') high = mid
    else low = mid + 1n
  }
  return { block: low, head, complete: true }
}

/** What the events say about a warrant. No state read at all. */
export interface EventWarrant {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  openedAtBlock: bigint
  openTx: Hex
  /** Filled in by `WarrantHonored`. `fee` and `refunded` are **read**, not derived. */
  honored?: { refunded: bigint; fee: bigint; tx: Hex; block: bigint }
  slashed?: { amount: bigint; reason: string; tx: Hex; block: bigint }
  reclaimed?: { refunded: bigint; tx: Hex; block: bigint }
}

export interface EventScan {
  warrants: Map<string, EventWarrant>
  fromBlock: bigint
  toBlock: bigint
  /** Number of `eth_getLogs` requests issued. The cost of the proof, quantified. */
  requests: number
  /** Settlement events bearing an `id` never seen opened. Must stay empty. */
  orphanSettlements: string[]
}

/**
 * Rebuilds the escrow's complete history from its events alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this function exists when `readWarrants` already suffices to count
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `readWarrants` reads `status` from the current state. That is correct, but it
 * is only **one** source, and it starts from a list of `id`s we supply — the
 * ledger's. A counter built that way structurally cannot detect the two errors
 * that matter in front of a jury: a warrant opened onchain and **missing from the
 * ledger** (it is in no list, hence in no total), and a *derived* amount that
 * diverges from the amount *actually transferred* (`fee` computed as
 * `bond × feeBpsAtOpen / 10000` instead of being read from `WarrantHonored`).
 *
 * The event scan has neither blind spot: it enumerates the `id`s instead of
 * receiving them, and it carries the amounts exactly as the contract emitted
 * them. Cross-checking the two is the difference between "our counter is
 * consistent with itself" and "our counter is consistent with the chain".
 *
 * `chunkBlocks` defaults to 2001: `sepolia.base.org` refuses any `eth_getLogs`
 * whose `toBlock − fromBlock` exceeds 2000, and the bound really is on the gap —
 * measured, a 2001-block range goes through. The four events are asked for in a
 * **single** request per window (`events: [...]`), not four: on a public RPC that
 * factor of 4 is what separates a verification one happily re-runs from one one
 * avoids.
 */
export async function scanWarrantEvents(
  client: PublicClient,
  escrow: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks = 2001n,
): Promise<EventScan> {
  const warrants = new Map<string, EventWarrant>()
  const orphanSettlements: string[] = []
  const pendingSettlements: { id: string; apply: (w: EventWarrant) => void }[] = []
  let requests = 0

  const events = warrantEscrowAbi.filter(
    (entry): entry is Extract<(typeof warrantEscrowAbi)[number], { type: 'event' }> =>
      entry.type === 'event',
  )

  for (let cursor = fromBlock; cursor <= toBlock; cursor = cursor + chunkBlocks) {
    const to = cursor + chunkBlocks - 1n > toBlock ? toBlock : cursor + chunkBlocks - 1n
    const logs = await client.getLogs({ address: escrow, events, fromBlock: cursor, toBlock: to })
    requests += 1
    for (const log of logs) {
      const decoded = log as unknown as {
        eventName: string
        args: Record<string, unknown>
        transactionHash: Hex
        blockNumber: bigint
      }
      const id = String(decoded.args['id'] ?? '').toLowerCase()
      if (!id) continue
      switch (decoded.eventName) {
        case 'WarrantOpened':
          warrants.set(id, {
            id: id as Hex,
            agent: String(decoded.args['agent']).toLowerCase() as Address,
            beneficiary: String(decoded.args['beneficiary']).toLowerCase() as Address,
            bond: decoded.args['bond'] as bigint,
            openedAtBlock: decoded.blockNumber,
            openTx: decoded.transactionHash,
          })
          break
        case 'WarrantHonored':
          pendingSettlements.push({
            id,
            apply: (w) => {
              w.honored = {
                refunded: decoded.args['refunded'] as bigint,
                fee: decoded.args['fee'] as bigint,
                tx: decoded.transactionHash,
                block: decoded.blockNumber,
              }
            },
          })
          break
        case 'WarrantSlashed':
          pendingSettlements.push({
            id,
            apply: (w) => {
              w.slashed = {
                amount: decoded.args['amount'] as bigint,
                reason: String(decoded.args['reason'] ?? ''),
                tx: decoded.transactionHash,
                block: decoded.blockNumber,
              }
            },
          })
          break
        case 'WarrantReclaimed':
          pendingSettlements.push({
            id,
            apply: (w) => {
              w.reclaimed = {
                refunded: decoded.args['refunded'] as bigint,
                tx: decoded.transactionHash,
                block: decoded.blockNumber,
              }
            },
          })
          break
      }
    }
  }

  // Settlements are attached **after** the full scan rather than on the fly:
  // nothing guarantees that a window carries the opening before the settlement
  // when that window is the scan's first. Attaching on the fly would produce
  // "orphan settlements" that are not orphans at all.
  for (const s of pendingSettlements) {
    const w = warrants.get(s.id)
    if (!w) {
      orphanSettlements.push(s.id)
      continue
    }
    s.apply(w)
  }

  return { warrants, fromBlock, toBlock, requests, orphanSettlements }
}

/** The escrow's roles and immutable parameters. Read, never assumed. */
export async function readEscrowRoles(
  client: PublicClient,
  escrow: Address,
): Promise<{
  opener: Address
  settler: Address
  treasury: Address
  token: Address
  feeBps: number
  totalLocked: bigint
}> {
  const [opener, settler, treasury, token, feeBps, totalLocked] = await Promise.all([
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'opener' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'settler' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'treasury' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'token' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'feeBps' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'totalLocked' }),
  ])
  return {
    opener: (opener as string).toLowerCase() as Address,
    settler: (settler as string).toLowerCase() as Address,
    treasury: (treasury as string).toLowerCase() as Address,
    token: (token as string).toLowerCase() as Address,
    feeBps: Number(feeBps),
    totalLocked: totalLocked as bigint,
  }
}

/**
 * `reclaim(id)` — the runner's only onchain write, and it is
 * **permissioned by nobody**.
 *
 * `WarrantEscrow.reclaim` is deliberately permissionless ("prevents any
 * sequestration by a failing settler") and refunds `bond` **in full, with no
 * fee**. So the runner calls it on expired warrants, and that is not a nicety:
 * when the KeeperHub action failed, the Settler abstains from judging and lets
 * the warrant expire. Without a sweep, those 0.2 USDC stay locked up
 * indefinitely — nobody claims them — while they are worth 40 honored cycles.
 * It is the system's only mechanism that turns an execution failure back into
 * available capital.
 *
 * The gas comes out of the agent's key (≈ 0.0000005 ETH), not the Settler's:
 * mixing the two would make a refund look like a settlement in the gas
 * accounting.
 */
export const RECLAIM_ABI = warrantEscrowAbi

export async function usdcBalance(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint
}
