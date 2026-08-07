#!/usr/bin/env node
/**
 * Collects every verdict document written by a Settler and moves it into the
 * version-controlled `verdicts/` tree, which is what actually serves the URI
 * inscribed onchain.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this script has to exist
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Publication is deliberately a two-step operation: the Settler writes a
 * document at settlement, a human commits it afterwards. That is the right
 * split — a daemon that both slashes a bond and writes the repository's history
 * would hold two authorities for no gain (`packages/server/src/verdicts.ts`).
 *
 * But the second step was never automated, and `bin/settler.ts` defaults
 * `VERDICT_DIR` to `.warrant/verdicts`, a path git ignores. The result, measured
 * on 2026-08-06: **62 documents whose `feedbackHash` is already onchain and
 * whose `feedbackURI` answered 404**, spread over three directories, one of them
 * using a legacy `.json` suffix. A commitment that presents itself as verifiable
 * and resolves to nothing is worse than no publication at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The rule this script never breaks
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **Bytes are copied, never re-serialised.** `feedbackHash = keccak256(bytes)`,
 * so a reindentation or an added trailing newline silently invalidates a verdict
 * that nobody lied about. Every file is therefore checked against the project's
 * own `canonicalize` before being copied, and refused if it is not already the
 * canonical form. The index, by contrast, IS rebuilt — `buildVerdictIndex`
 * re-reads the bytes from disk and recomputes each hash, so a document that was
 * reformatted after the fact shows up as a diff instead of waiting for a third
 * party to fail to verify it.
 *
 * Two file naming conventions are reconciled here. The URI inscribed onchain is
 * `<base><warrantId>` with **no extension**; an older Settler wrote
 * `<warrantId>.json`. The suffix is stripped on copy — otherwise the document
 * exists but the inscribed link still 404s.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * One tree, one chain
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `verdicts/` is the corpus of the **live** deployment, and only that. Settlers
 * were run against earlier deployments too — Ethereum Sepolia, including the
 * pre-audit contract the README tells readers not to use — and their documents
 * are still lying around in the same directories. Publishing them here would put
 * verdicts from a vulnerable contract in the same undifferentiated list as the
 * ones being offered for verification, and `replay-verdict.sh`, which resolves a
 * single escrow, would answer "no warrant under that id" on them: an error that
 * reads as a broken verdict rather than as a document about another chain.
 *
 * So documents are filtered on `actionSpec.chainId`, and what is left out is
 * printed rather than silently dropped. A batch is kept only if **all** its
 * members are on the target chain — a batch straddling two chains has no single
 * escrow to replay against.
 *
 * Usage:
 *   pnpm verdicts:publish            # report what would change, write nothing
 *   pnpm verdicts:publish --write    # copy the documents and rebuild the index
 *   pnpm verdicts:publish --chain 1  # target another deployment's corpus
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { canonicalize, hashCanonical } from 'warrant-core'
import { buildVerdictIndex } from '../packages/server/src/verdicts.js'

/** Where a Settler may have left documents, in order of increasing staleness. */
const SOURCES = ['.warrant/verdicts', 'packages/server/.warrant/verdicts']

/** The version-controlled tree — the one `raw.githubusercontent.com` serves. */
const TARGET = 'verdicts'

const DOCUMENT_RE = /^0x[0-9a-f]{64}(\.json)?$/

interface Found {
  /** Identifier with no extension: the file name the URI resolves to. */
  id: string
  source: string
  bytes: string
  isBatch: boolean
}

function scan(dir: string, isBatch: boolean): Found[] {
  const path = isBatch ? join(dir, 'batch') : dir
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((name) => DOCUMENT_RE.test(name))
    .sort()
    .map((name) => ({
      id: basename(name, '.json'),
      source: join(path, name),
      bytes: readFileSync(join(path, name), 'utf8'),
      isBatch,
    }))
}

const write = process.argv.includes('--write')

/** Base Sepolia — the post-audit deployment `verdicts/` exists to serve. */
const DEFAULT_CHAIN = 84532
const chainArg = process.argv.indexOf('--chain')
const TARGET_CHAIN = chainArg === -1 ? DEFAULT_CHAIN : Number(process.argv[chainArg + 1])
if (!Number.isInteger(TARGET_CHAIN) || TARGET_CHAIN <= 0) {
  console.error(`--chain expects a positive integer chain id, got ${process.argv[chainArg + 1]}`)
  process.exit(1)
}

/**
 * The chains a document is about. A warrant document yields one; a batch yields
 * one per member, so that a batch straddling two deployments is visible as such
 * instead of being attributed to whichever member came first.
 */
function chainsOf(bytes: string): number[] {
  try {
    const doc: Record<string, unknown> = JSON.parse(bytes)
    const members = doc['warrants']
    const records = Array.isArray(members) ? members : [doc['warrant'] ?? doc]
    return records.map((r) => {
      const action = (r as { actionSpec?: { chainId?: unknown } } | undefined)?.actionSpec
      return typeof action?.chainId === 'number' ? action.chainId : Number.NaN
    })
  } catch {
    return [Number.NaN]
  }
}

const found: Found[] = []
for (const dir of SOURCES) {
  found.push(...scan(dir, false), ...scan(dir, true))
}

// Refuse to copy anything that is not already the canonical form: its own hash
// would not be the one onchain.
const corrupt = found.filter((f) => {
  try {
    return canonicalize(JSON.parse(f.bytes)) !== f.bytes
  } catch {
    return true
  }
})
if (corrupt.length > 0) {
  console.error(`REFUSED — ${corrupt.length} document(s) are not in canonical form:`)
  for (const c of corrupt) console.error(`  ${c.source}`)
  console.error('Publishing these would serve bytes that do not hash to the onchain commitment.')
  process.exit(1)
}

// The same document can sit in two directories. Keep one copy and verify the
// duplicates agree byte for byte — if they do not, only one of them can be the
// document that was committed to, and picking silently would be a coin flip.
const byId = new Map<string, Found>()
const divergent: string[] = []
for (const f of found) {
  const key = `${f.isBatch ? 'batch:' : 'doc:'}${f.id}`
  const seen = byId.get(key)
  if (!seen) byId.set(key, f)
  else if (seen.bytes !== f.bytes) divergent.push(`${key}\n    ${seen.source}\n    ${f.source}`)
}
if (divergent.length > 0) {
  console.error(`REFUSED — ${divergent.length} identifier(s) carry different bytes in two places:`)
  for (const d of divergent) console.error(`  ${d}`)
  process.exit(1)
}

// A batch document is addressed by its own hash. Trust the content, not the
// file name a previous run happened to give it.
for (const [key, f] of byId) {
  if (!f.isBatch) continue
  const hash = hashCanonical(f.bytes).toLowerCase()
  if (hash !== f.id) {
    console.error(`REFUSED — batch ${f.source} is named ${f.id} but hashes to ${hash}`)
    process.exit(1)
  }
  void key
}

const batchTarget = join(TARGET, 'batch')

const offChain: { f: Found; chains: number[] }[] = []
const onChain: Found[] = []
for (const f of byId.values()) {
  const chains = chainsOf(f.bytes)
  if (chains.every((c) => c === TARGET_CHAIN)) onChain.push(f)
  else offChain.push({ f, chains })
}

const toCopy = onChain.filter((f) => !existsSync(join(f.isBatch ? batchTarget : TARGET, f.id)))

// Anything already sitting in the tree that does not belong to the target chain
// got there before this filter existed. Name it: leaving it in place would put a
// pre-audit deployment's verdicts in the corpus offered for verification.
const strays = offChain.filter(({ f }) => existsSync(join(f.isBatch ? batchTarget : TARGET, f.id)))

const docs = toCopy.filter((f) => !f.isBatch)
const batches = toCopy.filter((f) => f.isBatch)

console.log(`sources scanned      : ${SOURCES.join(', ')}`)
console.log(`target chain         : ${TARGET_CHAIN}`)
console.log(`files found          : ${found.length}`)
console.log(`distinct identities  : ${byId.size}`)
console.log(`other chains, skipped: ${offChain.length}`)
for (const { f, chains } of offChain) {
  console.log(`  - ${f.isBatch ? 'batch/' : ''}${f.id}  chainId ${[...new Set(chains)].join(',')}`)
}
console.log(`already published    : ${onChain.length - toCopy.length}`)
console.log(`to publish           : ${docs.length} document(s), ${batches.length} batch(es)`)

if (strays.length > 0) {
  console.log(`\n⚠ ${strays.length} file(s) already in ${TARGET}/ belong to another chain:`)
  for (const { f, chains } of strays) {
    console.log(`  ${f.isBatch ? 'batch/' : ''}${f.id}  chainId ${[...new Set(chains)].join(',')}`)
  }
  console.log('  Remove them and re-run: this tree serves one deployment.')
}

if (!write) {
  for (const f of toCopy) console.log(`  + ${f.isBatch ? 'batch/' : ''}${f.id}  ← ${f.source}`)
  console.log('\nnothing written — pass --write to publish')
  process.exit(0)
}

mkdirSync(batchTarget, { recursive: true })
for (const f of toCopy) {
  copyFileSync(f.source, join(f.isBatch ? batchTarget : TARGET, f.id))
}

// Same index the Settler writes: rebuilt from the bytes on disk, canonicalised
// so that republishing an unchanged tree produces an empty diff.
const base = JSON.parse(readFileSync(join(TARGET, 'index.json'), 'utf8')).base as string
writeFileSync(join(TARGET, 'index.json'), canonicalize(buildVerdictIndex(TARGET, base)), 'utf8')

console.log(`\npublished ${toCopy.length} document(s) into ${TARGET}/`)
console.log(`index.json rebuilt against base ${base}`)
