/**
 * Publication of verdict documents.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What gets published, and why it has to be byte-exact
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An ERC-8004 feedback commits to `feedbackHash = keccak256(canonicalize(doc))`
 * without ever storing the document. Verifiability therefore rests entirely on
 * the URI serving **exactly the bytes that were hashed**: one reindentation, one
 * added field, one `Content-Type` that triggers a transformation, and the hash no
 * longer matches — the verdict becomes unverifiable without anyone having lied.
 *
 * Hence this module's single rule: **the file that is written is the canonical
 * JCS form, and it is served as-is**. We never re-serialise on read, we never go
 * through `c.json()` — we return the byte string read from disk.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Where the documents are published: the git repository itself
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `https://warrant.sh/v/` does not exist. A true `feedbackHash` whose URI does
 * not resolve is worse than no publication at all: it presents itself as
 * verifiable. The promise "we make the verdict reproducible" therefore required a
 * real host, while the project's constraint is to provision none.
 *
 * The public git repository already is one. A document written into `verdicts/`
 * and pushed is served as-is by
 *
 *     https://raw.githubusercontent.com/<owner>/<repo>/<ref>/verdicts/<warrantId>
 *
 * — that is exactly `<VERDICT_BASE_URI><warrantId>`, the URI that goes onchain in
 * `feedbackURI`. The file name is the bare identifier, with no extension: see
 * `fileNameOf`, which is what makes the inscribed link actually resolve.
 *
 * This choice beats a server, and not only because it costs nothing:
 *
 *   - **Bytes untouched.** `raw.githubusercontent.com` returns the blob's content
 *     without reformatting it. No re-serialising middleware between the hashed
 *     file and the served byte — this module's #1 risk disappears.
 *   - **Partially independent timestamping.** A commit's author date is forgeable
 *     — we are the ones who write it — but the *push* date is GitHub's server
 *     date, exposed by the repository events API, and that one is not. A
 *     home-grown server provides neither.
 *   - **Per-commit immutability.** The moving `ref` (`master`) makes the URI
 *     predictable *before* the commit — indispensable, since `feedbackURI` goes
 *     onchain at settlement time, hence before the push. Real immutability comes
 *     from underneath: the blob of a given commit never changes, and any
 *     divergence between the served bytes and the inscribed `feedbackHash` is
 *     detectable by anyone, without asking our opinion.
 *   - **Free replication.** A clone of the repository is a complete copy of the
 *     verdicts. A single server is a point of failure; a cloned repository is
 *     not.
 *
 * The limitations, stated rather than hidden:
 *
 *   1. Publication happens in **two steps** — the Settler writes the file at
 *      settlement, a human (or CI) commits and pushes it. In between, the URI
 *      inscribed onchain answers 404. The hash, however, is already true:
 *      nothing that is committed to depends on the push, only availability does.
 *      That is why `scripts/replay-verdict.sh` falls back to the local copy when
 *      the remote does not answer yet, and says so.
 *   2. GitHub can rewrite history if asked to (force-push). That does not make it
 *      possible to forge a verdict — one would have to find a keccak256 preimage
 *      — only to make it disappear. The counter is a third party who clones,
 *      which this format encourages.
 *   3. No git write happens here. This module writes files; it does not commit. A
 *      `git commit` triggered by the settlement daemon would blend two
 *      authorities — the one that slashes a bond and the one that writes the
 *      repository's history — for no gain at all.
 *
 * The read-only HTTP server is **kept**: it serves the same tree locally, before
 * the push, for development and for the explorer. Configured with the git-raw
 * base, it serves under the same relative path (`/verdicts/<warrantId>`), so a
 * client only has one prefix to change.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalize, hashCanonical, type Hex } from '@warrant/core'
import { batchFeedbackUriFor, feedbackUriFor } from './reputation.js'

/**
 * Default publication directory: **version-controlled**, at the repository root.
 *
 * ⚠ `bin/settler.ts` does not use it yet: its fallback value is still
 * `.warrant/verdicts`, a path git ignores. A Settler started without
 * `VERDICT_DIR` therefore writes documents no third party will ever see. This
 * has happened: Base Sepolia's first two ERC-8004 feedbacks (`0x4e1bb4f1…`,
 * `0xc113e15c…`) were written into `packages/server/.warrant/verdicts/`, and had
 * to be dug back out of there in order to be published.
 *
 * Second trap, from the same place: the path is relative to the **cwd**, not to
 * the repository root. The Settler is started from `packages/server`, so
 * `verdicts` would designate `packages/server/verdicts` there. Until resolution
 * is anchored at the root, `VERDICT_DIR` must be **absolute**.
 */
export const DEFAULT_VERDICT_DIR = 'verdicts'

/** GitHub's raw content host. It does not rewrite the bytes it serves. */
export const GIT_RAW_HOST = 'raw.githubusercontent.com'

/**
 * Number of segments of a `raw.githubusercontent.com` path that belong to
 * GitHub's addressing rather than to the repository tree:
 * `<owner>/<repo>/<ref>`.
 */
const GIT_RAW_PREFIX_SEGMENTS = 3

export interface GitRawSource {
  /** Repository owner, `4n0nn43x`. */
  owner: string
  /** Repository name, `warrant`. */
  repo: string
  /**
   * The git ref that is served. A **branch**, not a SHA: `feedbackURI` goes
   * onchain before the commit that publishes the file, so the URI has to be
   * predictable without knowing that commit.
   */
  ref: string
  /** Version-controlled directory, relative to the repository root. */
  dir?: string
}

/** Public base served by git, terminated by `/`. */
export function gitRawBaseUri(src: GitRawSource): string {
  const dir = (src.dir ?? DEFAULT_VERDICT_DIR).replace(/^\/+|\/+$/g, '')
  return `https://${GIT_RAW_HOST}/${src.owner}/${src.repo}/${src.ref}/${dir}/`
}

/**
 * Default public base: the project's repository, branch `master`.
 *
 * It replaces `DEFAULT_FEEDBACK_URI_BASE` (`https://warrant.sh/v/`) across the
 * whole publication path. That constant stays in `reputation.ts` as the fallback
 * for the URI helpers, but no document is published under a domain that does not
 * exist any more.
 */
export const DEFAULT_VERDICT_BASE_URI = gitRawBaseUri({
  owner: '4n0nn43x',
  repo: 'warrant',
  ref: 'master',
  dir: DEFAULT_VERDICT_DIR,
})

/**
 * Static index of the directory.
 *
 * With no server, a third party has no way to enumerate what is published:
 * warrant identifiers cannot be guessed. This file is therefore served by git-raw
 * at `<base>index.json`, and the local HTTP server returns exactly the same
 * document — a single shape to document.
 */
export const VERDICT_INDEX_FILE = 'index.json'

/** A published document, with everything needed to find and verify it. */
export interface PublishedVerdict {
  /** Stable URI — the one that goes into `giveFeedback`'s `feedbackURI`. */
  uri: string
  /** `keccak256(utf8(canonicalize(doc)))` — the onchain commitment. */
  hash: Hex
  /** Path of the file that is served. */
  path: string
  /** The exact bytes served at that URI. */
  bytes: string
}

export interface VerdictPublisherOptions {
  /** Root directory of the documents. Created if missing. */
  dir: string
  /**
   * Public base of the URIs, terminated by `/`. Must be the same one the server
   * announces: it is the one that gets inscribed onchain.
   */
  baseUri?: string
}

export interface VerdictPublisher {
  /** Publishes a warrant's document at `<base><warrantId>`. */
  publish(warrantId: Hex, document: unknown): PublishedVerdict
  /** Publishes a batch document at `<base>batch/<feedbackHash>`. */
  publishBatch(document: unknown): PublishedVerdict
  /** Reads back the bytes published for a warrant, or `undefined`. */
  read(warrantId: Hex): string | undefined
  readonly dir: string
  readonly baseUri: string
  /** Path of the static index, to be committed alongside the documents. */
  readonly indexPath: string
}

/**
 * A warrant's file name: **the bare identifier, with no extension**.
 *
 * This is not an affectation. The URI inscribed onchain is built by
 * `feedbackUriFor`, shared with `publishVerdict`: it is `<base><warrantId>`, with
 * no suffix. The file name must therefore be exactly the last segment of that
 * URI, otherwise git-raw answers 404 on every published verdict — precisely the
 * breakage this module exists to remove. Renaming to `.json` would require
 * changing the URI construction on the ERC-8004 side, where it is already
 * committed to.
 *
 * A happy side effect: a file with no `.json` extension escapes the formatters
 * and linters that target `*.json`. The hashed bytes cannot be reindented by a
 * repository tool that does not see them.
 *
 * Lowercase, like the URI.
 */
function fileNameOf(warrantId: Hex): string {
  return warrantId.toLowerCase()
}

/** A published warrant, as the index references it. */
export interface VerdictIndexEntry {
  warrantId: Hex
  /**
   * `keccak256` of the file's bytes, recomputed by reading from disk.
   *
   * The name says what this value becomes once it is committed to, not what it
   * proves: a document is inscribed in `NewFeedback` only if the warrant had an
   * ERC-8004 identity at settlement time. Without an identity, the Settler
   * publishes the bare `VerdictDocument` (see `daemon.ts`), and this hash appears
   * in no event — the warrant stays verifiable against the escrow, it simply has
   * no reputation trace.
   */
  feedbackHash: Hex
  uri: string
}

/** A published batch document. Indexed by its hash, it has no identifier. */
export interface VerdictBatchIndexEntry {
  feedbackHash: Hex
  uri: string
}

export interface VerdictIndex {
  base: string
  count: number
  warrants: VerdictIndexEntry[]
  batches: VerdictBatchIndexEntry[]
}

/**
 * A document's file name: `0x` followed by 64 lowercase hexadecimal digits, with
 * no extension. This pattern excludes `index.json` without having to name it,
 * and also excludes the `.tmp` files left behind by an interrupted write.
 */
const DOCUMENT_FILE_RE = /^0x[0-9a-f]{64}$/

function listDocuments(dir: string): string[] {
  if (!existsSync(dir)) return []
  // Explicit sort: `readdir` order depends on the filesystem, and an index that
  // reorders itself on every run would produce a git diff on every publication,
  // including when nothing changed.
  return readdirSync(dir)
    .filter((name) => DOCUMENT_FILE_RE.test(name))
    .sort()
}

/**
 * Builds the index by **re-reading the bytes from disk** rather than reusing the
 * hashes returned by `publish`.
 *
 * The redundancy is deliberate: if a file was reformatted after the fact — a
 * `prettier` let loose on the repository, an editor adding a trailing newline —
 * the index displays the real hash, the one that no longer matches the onchain
 * commitment. The divergence becomes visible in a git diff instead of waiting for
 * a third party to try to verify.
 */
export function buildVerdictIndex(dir: string, baseUri: string): VerdictIndex {
  const base = normalizeBase(baseUri)
  const batchDir = join(dir, 'batch')

  const warrants = listDocuments(dir).map((name) => ({
    warrantId: name as Hex,
    feedbackHash: hashCanonical(readFileSync(join(dir, name), 'utf8')),
    uri: feedbackUriFor(name as Hex, base),
  }))

  const batches = listDocuments(batchDir).map((name) => ({
    feedbackHash: hashCanonical(readFileSync(join(batchDir, name), 'utf8')),
    uri: batchFeedbackUriFor(name as Hex, base),
  }))

  return { base, count: warrants.length, warrants, batches }
}

/**
 * Atomic write: a temporary file then a `rename`, which is atomic on the same
 * filesystem. A reader can therefore never stumble on a half-written document —
 * and a half-written document would not verify against its own hash, which would
 * look like a forgery.
 */
function writeAtomic(path: string, bytes: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, 'utf8')
  renameSync(temp, path)
}

export function fileVerdictPublisher(opts: VerdictPublisherOptions): VerdictPublisher {
  const dir = opts.dir
  const baseUri = normalizeBase(opts.baseUri ?? DEFAULT_VERDICT_BASE_URI)
  const batchDir = join(dir, 'batch')
  const indexPath = join(dir, VERDICT_INDEX_FILE)
  mkdirSync(batchDir, { recursive: true })

  function emit(path: string, uri: string, document: unknown): PublishedVerdict {
    // A single canonicalisation, `@warrant/core`'s — the same one that backs the
    // onchain `conditionHash`. Two implementations would produce two hashes for
    // one document (risk R1 in docs/13).
    const bytes = canonicalize(document)
    const hash = hashCanonical(bytes)
    writeAtomic(path, bytes)
    // The index follows the write immediately: publishing a document without
    // referencing it would make it unfindable for anyone who does not already
    // know its identifier. It is canonicalised too — not because it is committed
    // to onchain (it is not), but so that an identical republication produces an
    // empty git diff.
    writeAtomic(indexPath, canonicalize(buildVerdictIndex(dir, baseUri)))
    return { uri, hash, path, bytes }
  }

  return {
    dir,
    baseUri,
    indexPath,
    publish(warrantId, document) {
      return emit(
        join(dir, fileNameOf(warrantId)),
        feedbackUriFor(warrantId, baseUri),
        document,
      )
    },
    publishBatch(document) {
      // A batch's URI is indexed by its own hash: we therefore have to hash
      // before knowing where to write. We canonicalise twice rather than
      // duplicate the write logic — the cost is nil next to an onchain
      // transaction.
      const hash = hashCanonical(canonicalize(document))
      return emit(
        join(batchDir, hash.toLowerCase()),
        batchFeedbackUriFor(hash, baseUri),
        document,
      )
    },
    read(warrantId) {
      const path = join(dir, fileNameOf(warrantId))
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    },
  }
}

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base : `${base}/`
}

/**
 * URL path under which the documents are served, derived from the public base.
 * `https://warrant.sh/v/` → `/v`.
 *
 * Deriving it rather than freezing it avoids the most likely silent
 * disagreement: a `VERDICT_BASE_URI` pointing at a path the server does not
 * serve, discovered the day someone tries to verify a feedback.
 *
 * The git-raw special case: the first three segments (`<owner>/<repo>/<ref>`) are
 * GitHub's addressing, not the repository tree. Serving them locally would make
 * no sense — the local server knows neither owner nor branch — while they are
 * exactly what has to be stripped to recover the path *inside* the repository.
 * `…/4n0nn43x/warrant/master/verdicts/` therefore becomes `/verdicts`: the same
 * relative URL on both sides, up to the origin.
 */
export function verdictPathPrefix(baseUri: string): string {
  let url: URL
  try {
    url = new URL(baseUri)
  } catch {
    return '/v'
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const kept =
    url.host.toLowerCase() === GIT_RAW_HOST ? segments.slice(GIT_RAW_PREFIX_SEGMENTS) : segments

  return kept.length === 0 ? '' : `/${kept.join('/')}`
}

export interface VerdictServerOptions {
  dir: string
  baseUri?: string
  /** Injectable for tests. Defaults to reading from disk. */
  readFile?: (path: string) => string | undefined
}

const WARRANT_ID_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Read-only HTTP server for the verdict documents.
 *
 * Three routes, no writes, no authentication: what lives here is public by
 * construction — that is the whole point of a replayable verdict.
 */
export function createVerdictServer(opts: VerdictServerOptions) {
  const dir = opts.dir
  const baseUri = normalizeBase(opts.baseUri ?? DEFAULT_VERDICT_BASE_URI)
  const prefix = verdictPathPrefix(baseUri)
  const read =
    opts.readFile ?? ((path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))

  const app = new Hono()

  /**
   * Raw response. `c.body`, never `c.json`: re-serialising would break the
   * byte-for-byte equality with what was hashed, and with it the verifiability.
   * The `ETag` carries the hash — a client can check the commitment without even
   * re-reading the body.
   */
  function serve(c: Context, bytes: string) {
    return c.body(bytes, 200, {
      'content-type': 'application/json; charset=utf-8',
      etag: `"${hashCanonical(bytes)}"`,
      'cache-control': 'public, max-age=31536000, immutable',
      // A verdict is only of interest if a third party can read it from elsewhere.
      'access-control-allow-origin': '*',
    })
  }

  // Static index. Declared before `:id` — `index.json` must not be taken for a
  // malformed warrant identifier. We serve the file the publisher wrote when it
  // exists, exactly as git-raw would; otherwise we rebuild it, so that a
  // directory inherited from an earlier version still answers.
  const indexBytes = () =>
    read(join(dir, VERDICT_INDEX_FILE)) ?? canonicalize(buildVerdictIndex(dir, baseUri))

  app.get(`${prefix}/${VERDICT_INDEX_FILE}`, (c) => serve(c, indexBytes()))

  app.get(`${prefix}/batch/:hash`, (c) => {
    const hash = c.req.param('hash').toLowerCase()
    if (!WARRANT_ID_RE.test(hash)) {
      return c.json({ error: 'bad_hash', detail: hash }, 400)
    }
    const bytes = read(join(dir, 'batch', hash))
    if (!bytes) return c.json({ error: 'not_found', detail: hash }, 404)
    return serve(c, bytes)
  })

  app.get(`${prefix}/:id`, (c) => {
    const id = c.req.param('id').toLowerCase()
    if (!WARRANT_ID_RE.test(id)) {
      return c.json({ error: 'bad_warrant_id', detail: id }, 400)
    }
    const bytes = read(join(dir, id))
    if (!bytes) return c.json({ error: 'not_found', detail: id }, 404)
    return serve(c, bytes)
  })

  // Both bare forms of the path return the same index as `index.json`: a 404 on
  // the form you get by copying `VERDICT_BASE_URI` would be a gratuitous trap.
  // Hono does not conflate `/v` and `/v/`, hence the two routes.
  const index = (c: Context) => serve(c, indexBytes())
  app.get(`${prefix}`, index)
  app.get(`${prefix}/`, index)

  app.get('/healthz', (c) => c.json({ ok: true, dir, baseUri }))

  return app
}
