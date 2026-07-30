import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalize, hashCanonical, type Hex } from '@warrant/core'
import {
  DEFAULT_VERDICT_BASE_URI,
  GIT_RAW_HOST,
  buildVerdictIndex,
  createVerdictServer,
  fileVerdictPublisher,
  gitRawBaseUri,
  verdictPathPrefix,
  type VerdictIndex,
} from './verdicts.js'

const WARRANT_ID = `0x${'ab'.repeat(32)}` as Hex
const BASE = 'https://verdicts.example/v/'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'warrant-verdicts-'))
}

/** An arbitrary document: this module knows nothing of the shape, only the bytes. */
function document(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    warrantId: WARRANT_ID,
    verdict: 'honored',
    evaluatedAtBlock: '11368824',
    rpcUrl: 'https://sepolia.drpc.org',
    checks: [{ kind: 'erc20_balance', expected: 'gte 1', observed: '2', pass: true }],
    ...over,
  }
}

describe('publication — what is served is exactly what is hashed', () => {
  it('the written file is the canonical JCS form, with no reformatting', () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())

    const onDisk = readFileSync(published.path, 'utf8')
    expect(onDisk).toBe(canonicalize(document()))
    expect(onDisk).toBe(published.bytes)
    // This is the commitment inscribed onchain in `NewFeedback`.
    expect(hashCanonical(onDisk)).toBe(published.hash)
  })

  it('the URI is stable and derives from the warrant identifier', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    expect(publisher.publish(WARRANT_ID, document()).uri).toBe(`${BASE}${WARRANT_ID}`)
    // Republishing moves nothing: the URI is a function of the warrant, not of the clock.
    expect(publisher.publish(WARRANT_ID, document({ verdict: 'slashed' })).uri).toBe(
      `${BASE}${WARRANT_ID}`,
    )
  })

  it('a batch is indexed by its own hash', () => {
    const dir = tempDir()
    const doc = { warrantCount: 2, warrants: [] }
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publishBatch(doc)
    expect(published.uri).toBe(`${BASE}batch/${published.hash}`)
    expect(readFileSync(published.path, 'utf8')).toBe(canonicalize(doc))
  })

  it('adds the missing trailing slash rather than gluing the hash to the path', () => {
    const publisher = fileVerdictPublisher({ dir: tempDir(), baseUri: 'https://x.example/v' })
    expect(publisher.publish(WARRANT_ID, document()).uri).toBe(`https://x.example/v/${WARRANT_ID}`)
  })
})

describe('verdict server', () => {
  it('returns the published bytes byte-for-byte, with the hash as the ETag', async () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: BASE })

    const res = await app.request(`/v/${WARRANT_ID}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe(published.bytes)
    // A third party recomputes the hash over what it received and finds the commitment.
    expect(hashCanonical(body)).toBe(published.hash)
    expect(res.headers.get('etag')).toBe(`"${published.hash}"`)
  })

  it('serves a batch document', async () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publishBatch({ warrantCount: 0 })
    const app = createVerdictServer({ dir, baseUri: BASE })
    const res = await app.request(`/v/batch/${published.hash}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(published.bytes)
  })

  it('serves the same index under all three forms of the path', async () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: BASE })

    // `/v/index.json` is the form git-raw serves; `/v` and `/v/` are the ones you
    // get by pasting the base. All three must return the same bytes, otherwise
    // the documentation would have to describe three of them.
    const bodies: string[] = []
    for (const path of ['/v', '/v/', '/v/index.json']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)

    const index = JSON.parse(bodies[0]!) as VerdictIndex
    expect(index.warrants).toEqual([
      { warrantId: WARRANT_ID, feedbackHash: published.hash, uri: published.uri },
    ])
  })

  it('404 on a warrant never published, 400 on a malformed identifier', async () => {
    const app = createVerdictServer({ dir: tempDir(), baseUri: BASE })
    expect((await app.request(`/v/${WARRANT_ID}`)).status).toBe(404)
    expect((await app.request('/v/not-an-id')).status).toBe(400)
  })

  it('serves under the path VERDICT_BASE_URI announces, not under a frozen one', async () => {
    const dir = tempDir()
    const base = 'https://warrant.example/verdicts/'
    fileVerdictPublisher({ dir, baseUri: base }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: base })

    expect((await app.request(`/verdicts/${WARRANT_ID}`)).status).toBe(200)
    // The old path does not answer: a URI inscribed onchain that does not resolve
    // would be an unverifiable verdict.
    expect((await app.request(`/v/${WARRANT_ID}`)).status).toBe(404)
  })
})

describe('verdictPathPrefix', () => {
  it('derives the path from the public base', () => {
    expect(verdictPathPrefix('https://warrant.sh/v/')).toBe('/v')
    expect(verdictPathPrefix('http://localhost:8403/v/')).toBe('/v')
    expect(verdictPathPrefix('https://warrant.sh/')).toBe('')
  })

  it('strips owner/repo/ref from a git-raw base and keeps the repository path', () => {
    expect(verdictPathPrefix(DEFAULT_VERDICT_BASE_URI)).toBe('/verdicts')
    // A nested directory stays whole: only the first three segments belong to
    // GitHub's addressing.
    expect(
      verdictPathPrefix(gitRawBaseUri({ owner: 'o', repo: 'r', ref: 'main', dir: 'v/base-sepolia' })),
    ).toBe('/v/base-sepolia')
  })
})

describe('publication into the git repository', () => {
  it('the default base is a resolvable git-raw URL, not an invented domain', () => {
    expect(DEFAULT_VERDICT_BASE_URI).toBe(
      `https://${GIT_RAW_HOST}/4n0nn43x/warrant/master/verdicts/`,
    )
    // A warrant's document is a file in the repository, at a path guessable from
    // the warrantId alone — the condition for a third party to find it.
    const uri = fileVerdictPublisher({ dir: tempDir() }).publish(WARRANT_ID, document()).uri
    expect(uri).toBe(`${DEFAULT_VERDICT_BASE_URI}${WARRANT_ID}`)
  })

  it('the file name is the last segment of the URI inscribed onchain', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    const verdict = publisher.publish(WARRANT_ID, document())
    const batch = publisher.publishBatch({ warrantCount: 0 })

    // The invariant that decides whether a verdict is readable by a third party:
    // git-raw serves paths, not identifiers. A `.json` on disk but not in the
    // URI means a 404 on every published verdict.
    for (const published of [verdict, batch]) {
      const lastUriSegment = new URL(published.uri).pathname.split('/').pop()
      expect(published.path.split('/').pop()).toBe(lastUriSegment)
    }
    // And the full relative path matches, `batch/` included.
    expect(batch.path).toBe(join(dir, 'batch', batch.hash))
  })

  it('the index lists warrants and batches, with the hash re-read from disk', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    const verdict = publisher.publish(WARRANT_ID, document())
    const batch = publisher.publishBatch({ warrantCount: 1, warrants: [] })

    const index = JSON.parse(readFileSync(publisher.indexPath, 'utf8')) as VerdictIndex
    expect(index).toEqual({
      base: BASE,
      count: 1,
      warrants: [{ warrantId: WARRANT_ID, feedbackHash: verdict.hash, uri: verdict.uri }],
      batches: [{ feedbackHash: batch.hash, uri: batch.uri }],
    })
  })

  it('the index is canonical: republishing identically produces no diff', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    publisher.publish(WARRANT_ID, document())
    const first = readFileSync(publisher.indexPath, 'utf8')
    publisher.publish(WARRANT_ID, document())
    expect(readFileSync(publisher.indexPath, 'utf8')).toBe(first)
    expect(first).toBe(canonicalize(buildVerdictIndex(dir, BASE)))
  })

  it('the index exposes a document reformatted after publication', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    const published = publisher.publish(WARRANT_ID, document())

    // The real scenario: a formatter sweeps the repository and reindents the
    // JSON. The bytes are no longer the ones that were hashed; the index shows it.
    writeFileSync(published.path, JSON.stringify(document(), null, 2), 'utf8')
    const index = buildVerdictIndex(dir, BASE)
    expect(index.warrants[0]!.feedbackHash).not.toBe(published.hash)
  })

  it('the index is never served as a verdict document', async () => {
    const dir = tempDir()
    fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: BASE })

    // `index.json` lives in the same directory as the documents: it must appear
    // neither as a warrant of the index, nor as an identifier.
    const index = (await app.request('/v/index.json').then((r) => r.json())) as VerdictIndex
    expect(index.warrants.map((w) => w.warrantId)).toEqual([WARRANT_ID])
    expect((await app.request('/v/index')).status).toBe(400)
  })
})
