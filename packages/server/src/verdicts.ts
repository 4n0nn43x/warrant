/**
 * Publication des documents de verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce qui est publié, et pourquoi ça doit être à l'octet près
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Un feedback ERC-8004 engage `feedbackHash = keccak256(canonicalize(doc))` sans
 * jamais stocker le document. La vérifiabilité repose donc entièrement sur le
 * fait que l'URI serve **exactement les octets qui ont été hachés** : une
 * réindentation, un champ ajouté, un `Content-Type` qui déclenche une
 * transformation, et le hash ne correspond plus — le verdict devient
 * invérifiable sans que personne n'ait menti.
 *
 * D'où la règle unique de ce module : **le fichier écrit est la forme canonique
 * JCS, et il est servi tel quel**. On ne re-sérialise jamais à la lecture, on ne
 * passe jamais par `c.json()` — on renvoie la chaîne d'octets lue sur disque.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Où les documents sont publiés : le dépôt git lui-même
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `https://warrant.sh/v/` n'existe pas. Un `feedbackHash` vrai dont l'URI ne
 * résout pas est pire qu'une absence de publication : il se présente comme
 * vérifiable. La promesse « on rend le verdict reproductible » exigeait donc un
 * hôte réel, et la contrainte du projet est de n'en provisionner aucun.
 *
 * Le dépôt git public en est déjà un. Un document écrit dans `verdicts/` et
 * poussé est servi tel quel par
 *
 *     https://raw.githubusercontent.com/<owner>/<repo>/<ref>/verdicts/<warrantId>
 *
 * — soit exactement `<VERDICT_BASE_URI><warrantId>`, l'URI qui part onchain dans
 * `feedbackURI`. Le nom de fichier est l'identifiant nu, sans extension : voir
 * `fileNameOf`, c'est ce qui fait que le lien inscrit résout vraiment.
 *
 * Ce choix vaut mieux qu'un serveur, et pas seulement parce qu'il ne coûte
 * rien :
 *
 *   - **Octets intacts.** `raw.githubusercontent.com` renvoie le contenu du
 *     blob sans le reformater. Aucun middleware de re-sérialisation entre le
 *     fichier haché et l'octet servi — le risque n°1 de ce module disparaît.
 *   - **Horodatage partiellement indépendant.** La date d'auteur d'un commit est
 *     falsifiable — c'est nous qui l'écrivons — mais la date de *poussée* est
 *     celle du serveur GitHub, exposée par l'API des events du dépôt, et elle ne
 *     l'est pas. Un serveur maison ne fournit ni l'une ni l'autre.
 *   - **Immuabilité par commit.** Le `ref` mobile (`master`) rend l'URI
 *     prédictible *avant* le commit — indispensable, puisque `feedbackURI` part
 *     onchain au moment du règlement, donc avant la poussée. L'immuabilité
 *     réelle vient d'en dessous : le blob d'un commit donné ne change jamais, et
 *     toute divergence entre les octets servis et le `feedbackHash` inscrit est
 *     détectable par n'importe qui, sans nous demander notre avis.
 *   - **Réplication gratuite.** Un clone du dépôt est une copie complète des
 *     verdicts. Un serveur unique est un point de défaillance ; un dépôt cloné
 *     n'en est pas un.
 *
 * Les limites, énoncées plutôt que masquées :
 *
 *   1. La publication est en **deux temps** — le Settler écrit le fichier au
 *      règlement, un humain (ou la CI) le commite et le pousse. Entre les deux,
 *      l'URI inscrite onchain répond 404. Le hash, lui, est déjà vrai : rien de
 *      ce qui est engagé ne dépend de la poussée, seule la disponibilité en
 *      dépend. Le script `scripts/replay-verdict.sh` retombe pour cette raison
 *      sur la copie locale quand le distant ne répond pas encore, et le dit.
 *   2. GitHub peut réécrire l'histoire si on le lui demande (force-push). Ça ne
 *      permet pas de falsifier un verdict — il faudrait trouver une préimage de
 *      keccak256 — seulement de le faire disparaître. La parade est un tiers qui
 *      clone, ce que le format encourage.
 *   3. Aucune écriture git n'est faite ici. Ce module écrit des fichiers ; il ne
 *      commite pas. Un `git commit` déclenché par le daemon de règlement
 *      mélangerait deux autorités — celle qui saisit une caution et celle qui
 *      écrit dans l'historique du dépôt — pour un gain nul.
 *
 * Le serveur HTTP en lecture seule est **conservé** : il sert la même arborescence
 * en local, avant la poussée, pour le développement et pour l'explorateur.
 * Configuré avec la base git-raw, il sert sous le même chemin relatif
 * (`/verdicts/<warrantId>`), de sorte qu'un client n'a qu'un préfixe à changer.
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
 * Répertoire de publication par défaut : **versionné**, à la racine du dépôt.
 *
 * ⚠ `bin/settler.ts` ne l'utilise pas encore : sa valeur de repli est restée
 * `.warrant/verdicts`, un chemin ignoré par git. Un Settler lancé sans
 * `VERDICT_DIR` écrit donc des documents qu'aucun tiers ne verra jamais. Ça
 * s'est produit : les deux premiers feedbacks ERC-8004 de Base Sepolia
 * (`0x4e1bb4f1…`, `0xc113e15c…`) ont été écrits dans
 * `packages/server/.warrant/verdicts/`, et il a fallu les y retrouver pour les
 * publier.
 *
 * Deuxième piège, du même endroit : le chemin est relatif au **cwd**, pas à la
 * racine du dépôt. Le Settler se lance depuis `packages/server`, donc
 * `verdicts` y désignerait `packages/server/verdicts`. Tant que la résolution
 * n'est pas ancrée à la racine, `VERDICT_DIR` doit être **absolu**.
 */
export const DEFAULT_VERDICT_DIR = 'verdicts'

/** Hôte de contenu brut de GitHub. Ne réécrit pas les octets qu'il sert. */
export const GIT_RAW_HOST = 'raw.githubusercontent.com'

/**
 * Nombre de segments d'un chemin `raw.githubusercontent.com` qui appartiennent à
 * l'adressage GitHub et non à l'arborescence du dépôt : `<owner>/<repo>/<ref>`.
 */
const GIT_RAW_PREFIX_SEGMENTS = 3

export interface GitRawSource {
  /** Propriétaire du dépôt, `4n0nn43x`. */
  owner: string
  /** Nom du dépôt, `warrant`. */
  repo: string
  /**
   * Référence git servie. Une **branche**, pas un SHA : `feedbackURI` part
   * onchain avant le commit qui publie le fichier, donc l'URI doit être
   * prédictible sans connaître le commit.
   */
  ref: string
  /** Répertoire versionné, relatif à la racine du dépôt. */
  dir?: string
}

/** Base publique servie par git, terminée par `/`. */
export function gitRawBaseUri(src: GitRawSource): string {
  const dir = (src.dir ?? DEFAULT_VERDICT_DIR).replace(/^\/+|\/+$/g, '')
  return `https://${GIT_RAW_HOST}/${src.owner}/${src.repo}/${src.ref}/${dir}/`
}

/**
 * Base publique par défaut : le dépôt du projet, branche `master`.
 *
 * Elle remplace `DEFAULT_FEEDBACK_URI_BASE` (`https://warrant.sh/v/`) sur tout
 * le chemin de publication. Cette constante-là reste dans `reputation.ts` comme
 * repli des helpers d'URI, mais aucun document n'est plus publié sous un domaine
 * qui n'existe pas.
 */
export const DEFAULT_VERDICT_BASE_URI = gitRawBaseUri({
  owner: '4n0nn43x',
  repo: 'warrant',
  ref: 'master',
  dir: DEFAULT_VERDICT_DIR,
})

/**
 * Index statique du répertoire.
 *
 * Sans serveur, un tiers n'a aucun moyen d'énumérer ce qui est publié : les
 * identifiants de mandat ne se devinent pas. Ce fichier est donc servi par
 * git-raw à `<base>index.json`, et le serveur HTTP local rend exactement le même
 * document — une seule forme à documenter.
 */
export const VERDICT_INDEX_FILE = 'index.json'

/** Un document publié, avec tout ce qu'il faut pour le retrouver et le vérifier. */
export interface PublishedVerdict {
  /** URI stable, celle qui part dans `feedbackURI` de `giveFeedback`. */
  uri: string
  /** `keccak256(utf8(canonicalize(doc)))` — l'engagement onchain. */
  hash: Hex
  /** Chemin du fichier servi. */
  path: string
  /** Les octets exacts servis à cette URI. */
  bytes: string
}

export interface VerdictPublisherOptions {
  /** Répertoire racine des documents. Créé si absent. */
  dir: string
  /**
   * Base publique des URI, terminée par `/`. Doit être la même que celle
   * qu'annonce le serveur : c'est elle qui est inscrite onchain.
   */
  baseUri?: string
}

export interface VerdictPublisher {
  /** Publie le document d'un mandat à `<base><warrantId>`. */
  publish(warrantId: Hex, document: unknown): PublishedVerdict
  /** Publie un document de lot à `<base>batch/<feedbackHash>`. */
  publishBatch(document: unknown): PublishedVerdict
  /** Relit les octets publiés pour un mandat, ou `undefined`. */
  read(warrantId: Hex): string | undefined
  readonly dir: string
  readonly baseUri: string
  /** Chemin de l'index statique, à commiter avec les documents. */
  readonly indexPath: string
}

/**
 * Nom de fichier d'un mandat : **l'identifiant nu, sans extension**.
 *
 * Ce n'est pas une coquetterie. L'URI inscrite onchain est construite par
 * `feedbackUriFor`, partagée avec `publishVerdict` : c'est `<base><warrantId>`,
 * sans suffixe. Le nom de fichier doit donc être exactement le dernier segment
 * de cette URI, sinon git-raw répond 404 sur chaque verdict publié — précisément
 * la panne que ce module vient supprimer. Renommer en `.json` exigerait de
 * changer la construction d'URI côté ERC-8004, où elle est déjà engagée.
 *
 * Effet de bord heureux : un fichier sans extension `.json` échappe aux
 * formateurs et aux linters qui ciblent `*.json`. Les octets hachés ne peuvent
 * pas être réindentés par un outil de dépôt qui ne les voit pas.
 *
 * Minuscules, comme l'URI.
 */
function fileNameOf(warrantId: Hex): string {
  return warrantId.toLowerCase()
}

/** Un mandat publié, tel que l'index le référence. */
export interface VerdictIndexEntry {
  warrantId: Hex
  /**
   * `keccak256` des octets du fichier, recalculé à la lecture du disque.
   *
   * Le nom dit ce que cette valeur devient quand elle est engagée, pas ce
   * qu'elle prouve : un document n'est inscrit dans `NewFeedback` que si le
   * mandat avait une identité ERC-8004 au règlement. Sans identité, le Settler
   * publie le `VerdictDocument` brut (voir `daemon.ts`), et ce hash n'apparaît
   * dans aucun event — le mandat reste vérifiable contre l'escrow, il n'a
   * simplement pas de trace de réputation.
   */
  feedbackHash: Hex
  uri: string
}

/** Un document de lot publié. Indexé par son hash, il n'a pas d'identifiant. */
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
 * Nom de fichier d'un document : `0x` suivi de 64 chiffres hexadécimaux
 * minuscules, sans extension. Ce motif exclut `index.json` sans avoir à le
 * nommer, et exclut aussi les `.tmp` laissés par une écriture interrompue.
 */
const DOCUMENT_FILE_RE = /^0x[0-9a-f]{64}$/

function listDocuments(dir: string): string[] {
  if (!existsSync(dir)) return []
  // Tri explicite : l'ordre de `readdir` dépend du système de fichiers, et un
  // index qui se réordonne à chaque exécution produirait un diff git à chaque
  // publication, y compris quand rien n'a changé.
  return readdirSync(dir)
    .filter((name) => DOCUMENT_FILE_RE.test(name))
    .sort()
}

/**
 * Construit l'index en **relisant les octets sur disque** plutôt qu'en réutilisant
 * les hashs retournés par `publish`.
 *
 * C'est volontairement redondant : si un fichier a été reformaté après coup — un
 * `prettier` lâché sur le dépôt, un éditeur qui ajoute un saut de ligne final —
 * l'index affiche le hash réel, celui qui ne correspond plus à l'engagement
 * onchain. La divergence devient visible dans un diff git au lieu d'attendre
 * qu'un tiers essaie de vérifier.
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
 * Écriture atomique : fichier temporaire puis `rename`, qui est atomique sur le
 * même système de fichiers. Un lecteur ne peut donc jamais tomber sur un
 * document à moitié écrit — et un document à moitié écrit ne vérifierait pas son
 * propre hash, ce qui ressemblerait à une falsification.
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
    // Une seule canonicalisation, celle de `@warrant/core` — la même que celle
    // du `conditionHash` onchain. Deux implémentations produiraient deux hashs
    // pour un même document (risque R1 de docs/13).
    const bytes = canonicalize(document)
    const hash = hashCanonical(bytes)
    writeAtomic(path, bytes)
    // L'index suit immédiatement l'écriture : publier un document sans le
    // référencer le rendrait introuvable pour qui ne connaît pas déjà son
    // identifiant. Il est canonicalisé lui aussi — non pas parce qu'il est
    // engagé onchain (il ne l'est pas), mais pour qu'une republication à
    // l'identique produise un diff git vide.
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
      // L'URI d'un lot est indexée par son propre hash : il faut donc hacher
      // avant de savoir où écrire. On canonicalise deux fois plutôt que de
      // dupliquer la logique d'écriture — le coût est nul devant une
      // transaction onchain.
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
 * Chemin d'URL sous lequel les documents sont servis, déduit de la base
 * publique. `https://warrant.sh/v/` → `/v`.
 *
 * Le déduire plutôt que de le figer évite le désaccord silencieux le plus
 * probable : un `VERDICT_BASE_URI` qui pointe vers un chemin que le serveur ne
 * sert pas, découvert le jour où quelqu'un essaie de vérifier un feedback.
 *
 * Cas particulier de git-raw : les trois premiers segments
 * (`<owner>/<repo>/<ref>`) sont l'adressage de GitHub, pas l'arborescence du
 * dépôt. Les servir en local n'aurait aucun sens — le serveur local ne connaît
 * ni propriétaire ni branche — alors qu'ils sont exactement ce qu'il faut
 * retirer pour retrouver le chemin *dans* le dépôt. `…/4n0nn43x/warrant/master/
 * verdicts/` devient donc `/verdicts` : la même URL relative des deux côtés, à
 * l'origine près.
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
  /** Injectable pour les tests. Défaut : la lecture disque. */
  readFile?: (path: string) => string | undefined
}

const WARRANT_ID_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Serveur HTTP en lecture seule des documents de verdict.
 *
 * Trois routes, aucune écriture, aucune authentification : ce qui est ici est
 * public par construction — c'est tout l'intérêt d'un verdict rejouable.
 */
export function createVerdictServer(opts: VerdictServerOptions) {
  const dir = opts.dir
  const baseUri = normalizeBase(opts.baseUri ?? DEFAULT_VERDICT_BASE_URI)
  const prefix = verdictPathPrefix(baseUri)
  const read =
    opts.readFile ?? ((path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))

  const app = new Hono()

  /**
   * Réponse brute. `c.body`, jamais `c.json` : re-sérialiser romprait
   * l'égalité octet à octet avec ce qui a été haché, et donc la vérifiabilité.
   * L'`ETag` porte le hash — un client peut vérifier l'engagement sans même
   * relire le corps.
   */
  function serve(c: Context, bytes: string) {
    return c.body(bytes, 200, {
      'content-type': 'application/json; charset=utf-8',
      etag: `"${hashCanonical(bytes)}"`,
      'cache-control': 'public, max-age=31536000, immutable',
      // Un verdict n'a d'intérêt que si un tiers peut le lire depuis ailleurs.
      'access-control-allow-origin': '*',
    })
  }

  // Index statique. Déclaré avant `:id` — `index.json` ne doit pas être pris
  // pour un identifiant de mandat malformé. On sert le fichier écrit par le
  // publieur quand il existe, exactement comme git-raw le ferait ; sinon on le
  // reconstruit, pour qu'un répertoire hérité d'une version antérieure réponde
  // quand même.
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

  // Les deux formes nues du chemin rendent le même index que `index.json` : un
  // 404 sur la forme que l'on obtient en copiant `VERDICT_BASE_URI` serait un
  // piège gratuit. Hono ne confond pas `/v` et `/v/`, d'où les deux routes.
  const index = (c: Context) => serve(c, indexBytes())
  app.get(`${prefix}`, index)
  app.get(`${prefix}/`, index)

  app.get('/healthz', (c) => c.json({ ok: true, dir, baseUri }))

  return app
}
