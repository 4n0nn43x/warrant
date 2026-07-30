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

/** Un document quelconque : ce module ne connaît pas la forme, seulement les octets. */
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

describe('publication — ce qui est servi est exactement ce qui est haché', () => {
  it('le fichier écrit est la forme canonique JCS, sans reformatage', () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())

    const onDisk = readFileSync(published.path, 'utf8')
    expect(onDisk).toBe(canonicalize(document()))
    expect(onDisk).toBe(published.bytes)
    // C'est l'engagement inscrit onchain dans `NewFeedback`.
    expect(hashCanonical(onDisk)).toBe(published.hash)
  })

  it('l’URI est stable et dérive de l’identifiant du mandat', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    expect(publisher.publish(WARRANT_ID, document()).uri).toBe(`${BASE}${WARRANT_ID}`)
    // Republier ne déplace rien : l'URI est fonction du mandat, pas de l'heure.
    expect(publisher.publish(WARRANT_ID, document({ verdict: 'slashed' })).uri).toBe(
      `${BASE}${WARRANT_ID}`,
    )
  })

  it('un lot est indexé par son propre hash', () => {
    const dir = tempDir()
    const doc = { warrantCount: 2, warrants: [] }
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publishBatch(doc)
    expect(published.uri).toBe(`${BASE}batch/${published.hash}`)
    expect(readFileSync(published.path, 'utf8')).toBe(canonicalize(doc))
  })

  it('ajoute la barre finale manquante plutôt que de coller le hash au chemin', () => {
    const publisher = fileVerdictPublisher({ dir: tempDir(), baseUri: 'https://x.example/v' })
    expect(publisher.publish(WARRANT_ID, document()).uri).toBe(`https://x.example/v/${WARRANT_ID}`)
  })
})

describe('serveur de verdicts', () => {
  it('rend les octets publiés à l’octet près, avec le hash en ETag', async () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: BASE })

    const res = await app.request(`/v/${WARRANT_ID}`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe(published.bytes)
    // Un tiers recalcule le hash sur ce qu'il a reçu et retrouve l'engagement.
    expect(hashCanonical(body)).toBe(published.hash)
    expect(res.headers.get('etag')).toBe(`"${published.hash}"`)
  })

  it('sert un document de lot', async () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publishBatch({ warrantCount: 0 })
    const app = createVerdictServer({ dir, baseUri: BASE })
    const res = await app.request(`/v/batch/${published.hash}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(published.bytes)
  })

  it('sert le même index sous les trois formes du chemin', async () => {
    const dir = tempDir()
    const published = fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: BASE })

    // `/v/index.json` est la forme que sert git-raw ; `/v` et `/v/` sont celles
    // qu'on obtient en collant la base. Les trois doivent rendre les mêmes
    // octets, sinon la documentation devrait en décrire trois.
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

  it('404 sur un mandat jamais publié, 400 sur un identifiant malformé', async () => {
    const app = createVerdictServer({ dir: tempDir(), baseUri: BASE })
    expect((await app.request(`/v/${WARRANT_ID}`)).status).toBe(404)
    expect((await app.request('/v/pas-un-id')).status).toBe(400)
  })

  it('sert sous le chemin annoncé par VERDICT_BASE_URI, pas sous un chemin figé', async () => {
    const dir = tempDir()
    const base = 'https://warrant.example/verdicts/'
    fileVerdictPublisher({ dir, baseUri: base }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: base })

    expect((await app.request(`/verdicts/${WARRANT_ID}`)).status).toBe(200)
    // L'ancien chemin ne répond pas : une URI inscrite onchain qui ne résout
    // pas serait un verdict invérifiable.
    expect((await app.request(`/v/${WARRANT_ID}`)).status).toBe(404)
  })
})

describe('verdictPathPrefix', () => {
  it('déduit le chemin de la base publique', () => {
    expect(verdictPathPrefix('https://warrant.sh/v/')).toBe('/v')
    expect(verdictPathPrefix('http://localhost:8403/v/')).toBe('/v')
    expect(verdictPathPrefix('https://warrant.sh/')).toBe('')
  })

  it('retire owner/repo/ref d’une base git-raw et garde le chemin du dépôt', () => {
    expect(verdictPathPrefix(DEFAULT_VERDICT_BASE_URI)).toBe('/verdicts')
    // Un répertoire imbriqué reste entier : seuls les trois premiers segments
    // appartiennent à l'adressage GitHub.
    expect(
      verdictPathPrefix(gitRawBaseUri({ owner: 'o', repo: 'r', ref: 'main', dir: 'v/base-sepolia' })),
    ).toBe('/v/base-sepolia')
  })
})

describe('publication dans le dépôt git', () => {
  it('la base par défaut est une URL git-raw résolvable, pas un domaine inventé', () => {
    expect(DEFAULT_VERDICT_BASE_URI).toBe(
      `https://${GIT_RAW_HOST}/4n0nn43x/warrant/master/verdicts/`,
    )
    // Le document d'un mandat est un fichier du dépôt, à un chemin devinable
    // depuis le seul warrantId — c'est la condition pour qu'un tiers le trouve.
    const uri = fileVerdictPublisher({ dir: tempDir() }).publish(WARRANT_ID, document()).uri
    expect(uri).toBe(`${DEFAULT_VERDICT_BASE_URI}${WARRANT_ID}`)
  })

  it('le nom du fichier est le dernier segment de l’URI inscrite onchain', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    const verdict = publisher.publish(WARRANT_ID, document())
    const batch = publisher.publishBatch({ warrantCount: 0 })

    // L'invariant qui décide si un verdict est lisible par un tiers : git-raw
    // sert des chemins, pas des identifiants. Un `.json` sur le disque et pas
    // dans l'URI, c'est un 404 sur chaque verdict publié.
    for (const published of [verdict, batch]) {
      const lastUriSegment = new URL(published.uri).pathname.split('/').pop()
      expect(published.path.split('/').pop()).toBe(lastUriSegment)
    }
    // Et le chemin relatif complet coïncide, `batch/` compris.
    expect(batch.path).toBe(join(dir, 'batch', batch.hash))
  })

  it('l’index recense mandats et lots, avec le hash relu sur disque', () => {
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

  it('l’index est canonique : republier à l’identique ne produit aucun diff', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    publisher.publish(WARRANT_ID, document())
    const first = readFileSync(publisher.indexPath, 'utf8')
    publisher.publish(WARRANT_ID, document())
    expect(readFileSync(publisher.indexPath, 'utf8')).toBe(first)
    expect(first).toBe(canonicalize(buildVerdictIndex(dir, BASE)))
  })

  it('l’index dénonce un document reformaté après publication', () => {
    const dir = tempDir()
    const publisher = fileVerdictPublisher({ dir, baseUri: BASE })
    const published = publisher.publish(WARRANT_ID, document())

    // Le scénario réel : un formateur passe sur le dépôt et réindente le JSON.
    // Les octets ne sont plus ceux qui ont été hachés ; l'index le montre.
    writeFileSync(published.path, JSON.stringify(document(), null, 2), 'utf8')
    const index = buildVerdictIndex(dir, BASE)
    expect(index.warrants[0]!.feedbackHash).not.toBe(published.hash)
  })

  it('l’index n’est jamais servi comme un document de verdict', async () => {
    const dir = tempDir()
    fileVerdictPublisher({ dir, baseUri: BASE }).publish(WARRANT_ID, document())
    const app = createVerdictServer({ dir, baseUri: BASE })

    // `index.json` est dans le même répertoire que les documents : il ne doit
    // apparaître ni comme un mandat de l'index, ni comme un identifiant.
    const index = (await app.request('/v/index.json').then((r) => r.json())) as VerdictIndex
    expect(index.warrants.map((w) => w.warrantId)).toEqual([WARRANT_ID])
    expect((await app.request('/v/index')).status).toBe(400)
  })
})
