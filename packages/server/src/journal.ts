/**
 * Journal des mandats — la persistance qui manquait au Gateway.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Le choix, et pourquoi ce n'est pas « la chaîne toute seule »
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Le Settler règle des mandats ouverts avant son propre démarrage : un store en
 * mémoire est donc disqualifié d'office. Deux candidats restaient.
 *
 * **Tout dériver des events onchain.** Séduisant — sans état, robuste, dans
 * l'esprit du projet. Mais `WarrantOpened` ne transporte que `conditionHash` et
 * `actionHash`, c'est-à-dire des *engagements*, pas des *specs*. Or l'évaluateur
 * a besoin de la `ConditionSpec` complète pour savoir quelles lectures faire, et
 * un hash n'est pas inversible. Un Settler purement onchain ne pourrait rien
 * évaluer : il regarderait des mandats dont il ne saurait pas ce qu'ils
 * promettent.
 *
 * **Tout croire d'un fichier.** Symétriquement disqualifié : un journal local
 * qu'on croit sur parole ferait de l'écriture disque une surface de confiance,
 * et un fichier édité à la main pourrait faire saisir une caution.
 *
 * D'où le partage retenu, qui est celui du reste du projet — la chaîne fait
 * autorité, le hors-chaîne est vérifié contre elle :
 *
 *   • **la chaîne** fait autorité sur ce qui *existe* et sur son *statut* :
 *     `WarrantOpened` donne la liste, `warrants(id)` donne `status`, `expiry`,
 *     `bond`, `agent`, et les deux engagements ;
 *   • **le journal** fournit ce que la chaîne ne peut pas rendre : la
 *     `ConditionSpec`, l'`ActionSpec`, la classification, l'`executionId` ;
 *   • et le journal n'est **jamais cru** : `conditionHash(spec)` et
 *     `actionHash(spec)` sont recalculés et comparés aux engagements onchain
 *     avant toute évaluation. Une ligne falsifiée ne produit pas un mauvais
 *     verdict, elle produit un refus d'évaluer — donc une expiration vers
 *     `reclaim`, qui rembourse l'agent. Le doute continue de lui bénéficier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pourquoi JSONL append-only plutôt que SQLite
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Un `append` d'une ligne close par `\n` sur un fichier ouvert en `O_APPEND` est
 * atomique tant qu'il tient sous `PIPE_BUF`, et un lecteur qui ne consomme que
 * jusqu'au dernier `\n` ne voit jamais d'écriture partielle. C'est exactement la
 * discipline de deux processus distincts — le Gateway écrit, le Settler suit —
 * sans verrou, sans schéma, sans dépendance native, et le fichier reste lisible
 * par un humain le jour où il faut comprendre ce qui s'est passé. SQLite
 * apporterait des transactions dont ce cas d'usage n'a pas l'emploi, au prix
 * d'un binaire natif à installer.
 *
 * Le prix assumé : pas de compactage. Un mandat réécrit laisse ses versions
 * précédentes dans le fichier ; la dernière ligne gagne au rechargement.
 * À l'échelle d'un hackathon, et même de plusieurs milliers de mandats, un
 * fichier texte de quelques mégaoctets ne pose aucun problème.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  appendFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { Hex } from '@warrant/core'
import type { WarrantRecord, WarrantStore } from './gateway.js'

/** Une ligne du journal qu'on n'a pas su relire. Jamais silencieuse. */
export interface JournalDefect {
  /** Numéro de ligne dans le fichier, à partir de 1. */
  line: number
  raw: string
  error: string
}

export interface WarrantJournalOptions {
  path: string
  /**
   * Appelé pour chaque ligne illisible. Défaut : un `console.warn`.
   *
   * Une ligne corrompue n'interrompt jamais le chargement — un journal
   * partiellement lisible vaut mieux qu'un daemon qui refuse de démarrer et
   * laisse expirer tous les mandats en cours.
   */
  onDefect?: (defect: JournalDefect) => void
}

export interface WarrantJournal extends WarrantStore {
  put(record: WarrantRecord): void
  get(id: Hex): WarrantRecord | undefined
  list(): WarrantRecord[]
  /**
   * Consomme les lignes ajoutées depuis le dernier appel et rend le nombre de
   * mandats mis à jour.
   *
   * C'est ce qui permet au Settler de *suivre* un journal qu'un autre processus
   * alimente, sans relire le fichier entier à chaque tour de boucle : on ne lit
   * que ce qui a été ajouté, et jamais au-delà du dernier `\n` — une ligne en
   * cours d'écriture n'est donc jamais vue à moitié.
   */
  refresh(): number
  /** Lignes illisibles rencontrées depuis l'ouverture. */
  defects(): JournalDefect[]
  readonly path: string
}

/**
 * Ouvre — et crée si besoin — un journal de mandats sur disque.
 *
 * Satisfait `WarrantStore` : le Gateway peut l'utiliser tel quel à la place de
 * `memoryWarrantStore()`, sans qu'aucune autre ligne ne change. C'est
 * volontaire — la persistance ne doit pas être une variante du Gateway, juste
 * un store différent.
 */
export function fileWarrantStore(opts: WarrantJournalOptions | string): WarrantJournal {
  const options: WarrantJournalOptions = typeof opts === 'string' ? { path: opts } : opts
  const path = options.path
  const onDefect =
    options.onDefect ??
    ((d: JournalDefect) =>
      console.warn(
        JSON.stringify({ msg: 'journal: ligne illisible', path, line: d.line, error: d.error }),
      ))

  mkdirSync(dirname(path), { recursive: true })

  const records = new Map<string, WarrantRecord>()
  const seenDefects: JournalDefect[] = []
  /** Octets déjà consommés. Le suivi incrémental repart d'ici. */
  let consumed = 0
  /** Numéro de la prochaine ligne, pour situer un défaut dans le fichier. */
  let lineNo = 0
  /** Reste d'une ligne non terminée par `\n` — l'écrivain n'a pas fini. */
  let pending = ''

  function consumeAppendedBytes(): number {
    if (!existsSync(path)) return 0
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size < consumed) {
        // Le fichier a rétréci : troncature ou rotation. On repart de zéro
        // plutôt que de lire un décalage qui ne veut plus rien dire.
        consumed = 0
        lineNo = 0
        pending = ''
        records.clear()
      }
      if (size === consumed) return 0

      const length = size - consumed
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(fd, buffer, 0, length, consumed)
      consumed += read

      const text = pending + buffer.subarray(0, read).toString('utf8')
      const lastBreak = text.lastIndexOf('\n')
      if (lastBreak === -1) {
        // Aucune ligne complète : on garde tout pour le prochain tour.
        pending = text
        return 0
      }
      pending = text.slice(lastBreak + 1)

      let updated = 0
      for (const raw of text.slice(0, lastBreak).split('\n')) {
        lineNo += 1
        if (raw.trim() === '') continue
        const parsed = parseLine(raw)
        if (!parsed.ok) {
          const defect: JournalDefect = {
            line: lineNo,
            raw: raw.slice(0, 200),
            error: parsed.error,
          }
          seenDefects.push(defect)
          onDefect(defect)
          continue
        }
        records.set(parsed.record.id.toLowerCase(), parsed.record)
        updated += 1
      }
      return updated
    } finally {
      closeSync(fd)
    }
  }

  consumeAppendedBytes()

  return {
    path,
    put(record: WarrantRecord): void {
      // Écriture d'abord, mémoire ensuite : si le disque refuse, l'appelant
      // reçoit l'exception et le mandat n'est pas cru enregistré.
      appendFileSync(path, `${serializeRecord(record)}\n`, 'utf8')
      records.set(record.id.toLowerCase(), record)
      // La ligne qu'on vient d'écrire sera relue par `refresh()` : la relire est
      // sans effet (même id, même contenu), et la sauter demanderait de suivre
      // un décalage d'octets qu'on ne contrôle pas en cas d'écriture concurrente.
    },
    get(id: Hex): WarrantRecord | undefined {
      return records.get(id.toLowerCase())
    },
    list(): WarrantRecord[] {
      return [...records.values()]
    },
    refresh(): number {
      return consumeAppendedBytes()
    },
    defects(): JournalDefect[] {
      return [...seenDefects]
    },
  }
}

type ParsedLine = { ok: true; record: WarrantRecord } | { ok: false; error: string }

function parseLine(raw: string): ParsedLine {
  let parsed: Partial<WarrantRecord>
  try {
    parsed = JSON.parse(raw) as Partial<WarrantRecord>
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  // Contrôle minimal : sans identifiant ni specs, la ligne ne sert à rien au
  // Settler, et la garder en mémoire masquerait le problème.
  if (typeof parsed.id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(parsed.id)) {
    return { ok: false, error: 'id absent ou malformé' }
  }
  if (!parsed.conditionSpec || !parsed.actionSpec) {
    return { ok: false, error: 'conditionSpec ou actionSpec absente' }
  }
  return { ok: true, record: parsed as WarrantRecord }
}

/**
 * Sérialisation d'un enregistrement.
 *
 * `bigint` converti en chaîne décimale plutôt que de laisser `JSON.stringify`
 * lever : `WarrantRecord` n'en contient pas aujourd'hui, mais une ligne perdue
 * pour une erreur de type serait un mandat que le Settler ne réglerait jamais.
 * On préfère un journal qui accepte que le champ ne soit pas exactement typé.
 */
export function serializeRecord(record: WarrantRecord): string {
  return JSON.stringify(record, (_key, value) =>
    typeof value === 'bigint' ? value.toString(10) : value,
  )
}
