/**
 * Explorer data source.
 *
 * Two sources, in order of richness — never a canned one:
 *
 *   1. the Gateway (`GET /v1/warrants`), which knows the action category, the
 *      KeeperHub `executionId` and the full `checks[]` of each verdict;
 *   2. failing that, the escrow's own events, read straight from an RPC.
 *
 * The second path needs no Gateway, no indexer and no key, so the page keeps
 * working when our infrastructure does not — and it is the claim of the product
 * made literal: the contract is the record, and anyone can rebuild this view.
 *
 * There is deliberately no third path. An earlier version shipped a hardcoded
 * list of warrants; every entry was a real confirmed transaction, but a page
 * whose whole argument is "don't trust us, verify" has no business serving an
 * answer from memory. If both sources fail, this module says so and shows
 * nothing.
 */

import { loadFromChain } from './chain'

export type Verdict = 'honored' | 'slashed'
export type Status = 'Open' | 'Honored' | 'Slashed' | 'Reclaimed'

export interface Check {
  kind: string
  expected: string
  observed: string
  pass: boolean
}

export interface Warrant {
  id: string
  agent: string
  beneficiary: string
  /** USDC atomic units (6 decimals). */
  bond: string
  category: string
  status: Status
  chainId: number
  openedAt: number
  /** Present on the detail route and on the chain path; absent from the list. */
  expiry?: number
  /** Block of the `WarrantOpened` event, when the source is the chain. */
  openedAtBlock?: string
  /** Whether the opening call went through KeeperHub with sponsored gas. */
  sponsored?: boolean
  executionId?: string
  openTx?: string
  settlementTx?: string
  refunded?: string
  fee?: string
  verdict?: Verdict
  evaluatedAtBlock?: string
  rpcUrl?: string
  conditionHash?: string
  actionHash?: string
  fundingRef?: string
  checks?: Check[]
}

export interface Stats {
  total: number
  open: number
  honored: number
  slashed: number
  reclaimed: number
  bondHonoredTotal: string
  bondSlashedTotal: string
  totalAtRisk: string
}

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
  11155111: 'https://sepolia.etherscan.io',
}

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum Mainnet',
  8453: 'Base',
  84532: 'Base Sepolia',
  11155111: 'Ethereum Sepolia',
}

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`
}

export function txUrl(chainId: number, hash: string): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[11155111]}/tx/${hash}`
}

export function addressUrl(chainId: number, address: string): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[11155111]}/address/${address}`
}

/** USDC atomic units to a readable string, without touching floats. */
export function formatUsdc(atomic: string): string {
  const n = BigInt(atomic || '0')
  const whole = n / 1_000_000n
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export function shortHash(hash: string, lead = 10, tail = 8): string {
  return hash.length <= lead + tail ? hash : `${hash.slice(0, lead)}…${hash.slice(-tail)}`
}

export function timeAgo(ts: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - ts))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export const ESCROW = '0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12'
export const SEPOLIA = 11155111

/**
 * Block the escrow was deployed at, found by bisecting `eth_getCode`. Scanning
 * from here rather than from a fixed depth below the head keeps the event scan
 * complete: no warrant ages out of the explorer as the chain grows.
 */
export const ESCROW_FROM_BLOCK = 11368813n

export function computeStats(warrants: Warrant[]): Stats {
  const sum = (pred: (w: Warrant) => boolean) =>
    warrants
      .filter(pred)
      .reduce((acc, w) => acc + BigInt(w.bond), 0n)
      .toString()

  return {
    total: warrants.length,
    open: warrants.filter((w) => w.status === 'Open').length,
    honored: warrants.filter((w) => w.status === 'Honored').length,
    slashed: warrants.filter((w) => w.status === 'Slashed').length,
    reclaimed: warrants.filter((w) => w.status === 'Reclaimed').length,
    bondHonoredTotal: sum((w) => w.status === 'Honored'),
    bondSlashedTotal: sum((w) => w.status === 'Slashed'),
    totalAtRisk: sum((w) => w.status === 'Honored' || w.status === 'Slashed'),
  }
}

/**
 * Score weighted by the capital actually put at risk.
 *
 * Null when nothing has settled: an agent with no history is not a failing
 * agent, and rendering 0 would suggest otherwise.
 */
export function stakeWeightedScore(stats: Stats): number | null {
  const honored = BigInt(stats.bondHonoredTotal)
  const slashed = BigInt(stats.bondSlashedTotal)
  const total = honored + slashed
  if (total === 0n) return null
  return Number((honored * 10000n) / total) / 10000
}

// Port 8402 — celui du Gateway (`PORT` dans packages/server/src/bin/gateway.ts).
// L'ancienne valeur 8787 est le port du serveur MCP : l'explorer interrogeait
// donc un service qui ne sert pas cette route, et retombait systématiquement.
const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8402'
// Doit être un nœud d'ARCHIVE : reconstruire l'historique des mandats se fait
// par `eth_getLogs` sur des plages passées, ce qui est une requête d'archive.
// `ethereum-sepolia-rpc.publicnode.com` — l'ancienne valeur — les refuse toutes
// (`-32602 Archive requests require a personal token`) et rendait donc cette
// source inutilisable, exactement quand elle sert : Gateway indisponible.
const RPC = import.meta.env.VITE_RPC_URL ?? 'https://sepolia.drpc.org'
const ESCROW_ADDRESS = import.meta.env.VITE_ESCROW_ADDRESS ?? ESCROW
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? SEPOLIA)

/** Where the rendered warrants came from. Surfaced to the visitor, always. */
export type Source = 'gateway' | 'chain' | 'unavailable'

export interface LoadResult {
  warrants: Warrant[]
  stats: Stats
  source: Source
  /** Set when both sources failed, so the page can say what went wrong. */
  error?: string
}

async function fromGateway(): Promise<{ warrants: Warrant[]; stats?: Stats }> {
  const res = await fetch(`${GATEWAY}/v1/warrants?limit=200`, {
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
  const body = (await res.json()) as { warrants: Warrant[]; stats?: Stats }
  if (!Array.isArray(body.warrants)) throw new Error('gateway: malformed payload')
  return {
    // `GET /v1/warrants` omits `chainId` — the Gateway serves a single chain and
    // has no reason to repeat it on every row. The explorer does need it, to
    // build block-explorer links, so it is filled in from the configured chain.
    warrants: body.warrants.map((w) => ({ ...w, chainId: w.chainId ?? CHAIN_ID })),
    ...(body.stats ? { stats: body.stats } : {}),
  }
}

export async function loadWarrants(): Promise<LoadResult> {
  try {
    const { warrants, stats } = await fromGateway()
    // An empty Gateway is an answer, not a failure: on a fresh deployment there
    // genuinely are no warrants yet, and falling through to the chain would
    // only produce the same empty list more slowly.
    //
    // The Gateway's own `stats` are preferred over recomputing from the page:
    // they cover the whole filtered set, so they do not shrink when the list is
    // paginated. A counter that changes with the page is not a counter.
    return { warrants, stats: stats ?? computeStats(warrants), source: 'gateway' }
  } catch (gatewayError) {
    try {
      const warrants = await loadFromChain({
        rpcUrl: RPC,
        escrow: ESCROW_ADDRESS,
        chainId: CHAIN_ID,
        fromBlock: BigInt(import.meta.env.VITE_ESCROW_FROM_BLOCK ?? ESCROW_FROM_BLOCK),
      })
      return { warrants, stats: computeStats(warrants), source: 'chain' }
    } catch (chainError) {
      return {
        warrants: [],
        stats: computeStats([]),
        source: 'unavailable',
        error: `gateway: ${String(gatewayError)} · rpc: ${String(chainError)}`,
      }
    }
  }
}
