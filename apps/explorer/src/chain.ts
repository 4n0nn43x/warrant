/**
 * Reading warrants straight from the chain.
 *
 * The explorer used to fall back to a hardcoded list when the Gateway was
 * unreachable. Every entry in it was a real, confirmed transaction — but a page
 * whose entire argument is "don't trust us, verify" cannot ship a baked-in
 * answer. If the Gateway is down, the right thing to show is what the chain
 * says, not what we remembered.
 *
 * So this module reconstructs the warrant set from the escrow's own events. It
 * needs nothing but an RPC endpoint: no Gateway, no indexer, no database, no
 * API key. That is also the strongest possible demonstration of the product's
 * claim — the contract is the record, and anyone can rebuild this page.
 *
 * Decoding is done by hand rather than with a library. The four events are
 * small and fixed, ABI encoding of static words is slicing, and the explorer
 * stays dependency-free — which keeps `pnpm --filter @warrant/explorer build`
 * fast and the bundle honest.
 */

import type { Check, Status, Verdict, Warrant } from './data'

/**
 * Event topics, `keccak256` of each signature.
 *
 * Recompute with:
 *   cast sig-event "WarrantOpened(bytes32,address,address,uint256,bytes32,bytes32,bytes32,uint64)"
 */
const TOPIC = {
  opened: '0x28d2d422386fe89e62432f0b87365b35b8bda759dfb1ac7efb5ab50ea1b2883a',
  honored: '0x16305dd8b53580b732bf8b3e9717370fbcc897212dcf53c179452acb20ffa22e',
  slashed: '0x05875da9e49b489b5ce9b7108206c7eeda4f0d98ebc776f23a42fc41dcf24fd9',
  reclaimed: '0x243b9401e235cb830487acb1175d06f632427047cf16f7d07438773409f75aa8',
} as const

interface RpcLog {
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
}

/** One 32-byte word of an ABI payload, `i` counted in words. */
function word(data: string, i: number): string {
  const body = data.startsWith('0x') ? data.slice(2) : data
  return body.slice(i * 64, (i + 1) * 64)
}

const uint = (data: string, i: number): bigint => BigInt(`0x${word(data, i) || '0'}`)
const hex32 = (data: string, i: number): string => `0x${word(data, i)}`

/** Last 20 bytes of an indexed address topic. */
const topicAddress = (topic: string): string => `0x${topic.slice(26)}`

/**
 * A `string` argument in the non-indexed tail: word `i` holds the offset to a
 * (length, bytes…) pair. Used by `WarrantSlashed.reason`, which is the human
 * -readable justification a slashed agent is entitled to read onchain.
 */
function dynamicString(data: string, i: number): string {
  const body = data.startsWith('0x') ? data.slice(2) : data
  const offset = Number(uint(data, i)) * 2
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64) || '0'}`))
  const bytes = body.slice(offset + 64, offset + 64 + length * 2)
  const out = new Uint8Array(length)
  for (let k = 0; k < length; k += 1) out[k] = parseInt(bytes.slice(k * 2, k * 2 + 2), 16)
  return new TextDecoder().decode(out)
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`)
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`)
  if (body.result === undefined) throw new Error(`RPC ${method}: empty result`)
  return body.result
}

/**
 * Public RPCs cap `eth_getLogs` spans, and every provider caps differently:
 * drpc's free tier refuses "ranges over 10000 blocks", 1rpc allows 50, others
 * announce nothing and simply fail. Rather than hardcode one provider's limit,
 * start wide and halve on refusal — the window adapts to whatever endpoint the
 * visitor happens to be pointed at.
 */
const MAX_WINDOW = 10_000n
const MIN_WINDOW = 50n

/**
 * Scanning starts at the escrow's deployment block, not at an arbitrary depth
 * below the head. Two reasons: the scan is then *complete* — no warrant can
 * silently age out of view as the chain grows — and it is bounded, since the
 * contract has a fixed birth date.
 */
async function fetchLogs(url: string, address: string, fromBlock: bigint): Promise<RpcLog[]> {
  const head = BigInt(await rpc<string>(url, 'eth_blockNumber', []))
  const logs: RpcLog[] = []
  let window = MAX_WINDOW
  let cursor = fromBlock

  while (cursor <= head) {
    const to = cursor + window - 1n > head ? head : cursor + window - 1n
    try {
      const batch = await rpc<RpcLog[]>(url, 'eth_getLogs', [
        { address, fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${to.toString(16)}` },
      ])
      logs.push(...batch)
      cursor = to + 1n
    } catch (err) {
      // A refusal on the very smallest window is a real failure, not a range
      // problem: propagate it rather than spin.
      if (window <= MIN_WINDOW) throw err
      window = window / 2n > MIN_WINDOW ? window / 2n : MIN_WINDOW
    }
  }

  return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)))
}

/**
 * Folds the event log into warrants.
 *
 * A settlement event can only follow its own `WarrantOpened`, so an event whose
 * id we have never seen is dropped rather than used to invent a partial
 * warrant: showing a settlement with no opening would misrepresent the record.
 */
export function foldLogs(logs: RpcLog[], chainId: number): Warrant[] {
  const byId = new Map<string, Warrant>()

  for (const log of logs) {
    const [topic0, idTopic] = log.topics
    if (!topic0 || !idTopic) continue
    const id = idTopic

    if (topic0 === TOPIC.opened) {
      byId.set(id, {
        id,
        agent: topicAddress(log.topics[2] ?? ''),
        beneficiary: topicAddress(log.topics[3] ?? ''),
        bond: uint(log.data, 0).toString(),
        // The category lives in the ActionSpec, which is offchain; the chain
        // commits only to its hash. Left unknown here, filled in by the Gateway
        // when it answers.
        category: 'unknown',
        status: 'Open',
        chainId,
        openedAt: 0,
        openedAtBlock: BigInt(log.blockNumber).toString(),
        conditionHash: hex32(log.data, 1),
        actionHash: hex32(log.data, 2),
        fundingRef: hex32(log.data, 3),
        openTx: log.transactionHash,
      })
      continue
    }

    const w = byId.get(id)
    if (!w) continue

    if (topic0 === TOPIC.honored) {
      w.status = 'Honored'
      w.verdict = 'honored'
      w.refunded = uint(log.data, 1).toString()
      w.fee = uint(log.data, 2).toString()
      w.settlementTx = log.transactionHash
      w.evaluatedAtBlock = BigInt(log.blockNumber).toString()
    } else if (topic0 === TOPIC.slashed) {
      w.status = 'Slashed'
      w.verdict = 'slashed'
      w.settlementTx = log.transactionHash
      w.evaluatedAtBlock = BigInt(log.blockNumber).toString()
      // `WarrantSlashed(bytes32 indexed id, bytes32 execRef, uint256 amount,
      // string reason)` — `id` being indexed, the tail holds execRef, amount,
      // then the offset to `reason` in word 2.
      w.checks = reasonToChecks(dynamicString(log.data, 2))
    } else if (topic0 === TOPIC.reclaimed) {
      w.status = 'Reclaimed'
      w.settlementTx = log.transactionHash
    }
  }

  return [...byId.values()].reverse()
}

/**
 * The onchain slash reason is the settler's `checks[]` flattened to one line,
 * in the shape `kind: expected X, observed Y`, joined by ` | `. Unfolding it
 * gives a visitor the failed checks without a Gateway. Anything that does not
 * parse is surfaced verbatim rather than dropped — a reason we fail to read is
 * still evidence, and hiding it would be the one unforgivable bug on this page.
 *
 * The parser accepts English *and* the legacy French spelling, and that is not
 * politeness: the reason is written **onchain, permanently**. Slashes inscribed
 * before the project moved to English still read `attendu … observé …`, and no
 * amount of translation can rewrite a settled transaction. A parser that only
 * spoke the new form would go blind on the protocol's own history — including
 * the very slash the README cites as proof. Accepting both costs one alternation.
 */
export function reasonToChecks(reason: string): Check[] {
  return reason
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.+?):\s*(?:expected|attendu)\s+(.+?),\s*(?:observed|observ(?:e|é))\s+(.+)$/.exec(part)
      if (!m) return { kind: 'reason', expected: '—', observed: part, pass: false }
      return { kind: m[1] ?? 'check', expected: m[2] ?? '', observed: m[3] ?? '', pass: false }
    })
}

export interface ChainSource {
  rpcUrl: string
  escrow: string
  chainId: number
  /** Block the escrow was deployed at — where the scan starts. */
  fromBlock: bigint
}

/**
 * Opening timestamps.
 *
 * Events carry a block number, not a time, and the page shows ages. Resolving
 * them costs one call per *distinct* block rather than per warrant — several
 * warrants opened in the same block are common once a volume runner is at work.
 * A block that fails to resolve leaves the age blank; a wrong date on a page
 * that argues for verifiability would be worse than no date at all.
 */
async function resolveTimestamps(url: string, warrants: Warrant[]): Promise<void> {
  const blocks = new Map<string, Warrant[]>()
  for (const w of warrants) {
    if (!w.openedAtBlock) continue
    const list = blocks.get(w.openedAtBlock)
    if (list) list.push(w)
    else blocks.set(w.openedAtBlock, [w])
  }

  await Promise.all(
    [...blocks].map(async ([block, group]) => {
      try {
        const b = await rpc<{ timestamp: string }>(url, 'eth_getBlockByNumber', [
          `0x${BigInt(block).toString(16)}`,
          false,
        ])
        for (const w of group) w.openedAt = Number(BigInt(b.timestamp))
      } catch {
        /* Unknown age: the view will render it as such. */
      }
    }),
  )
}

/** Rebuilds the warrant list from the escrow's events alone. */
export async function loadFromChain(src: ChainSource): Promise<Warrant[]> {
  const logs = await fetchLogs(src.rpcUrl, src.escrow, src.fromBlock)
  const warrants = foldLogs(logs, src.chainId)
  for (const w of warrants) w.rpcUrl = src.rpcUrl
  await resolveTimestamps(src.rpcUrl, warrants)
  return warrants
}

export type { Status, Verdict }
