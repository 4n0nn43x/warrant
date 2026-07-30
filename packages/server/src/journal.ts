/**
 * Warrant journal — the persistence the Gateway was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The choice, and why it is not "the chain on its own"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The Settler settles warrants that were opened before it started: an in-memory
 * store is therefore disqualified outright. Two candidates remained.
 *
 * **Derive everything from the onchain events.** Tempting — stateless, robust, in
 * the spirit of the project. But `WarrantOpened` carries only `conditionHash`
 * and `actionHash`, that is to say *commitments*, not *specs*. And the evaluator
 * needs the full `ConditionSpec` to know which reads to perform, while a hash is
 * not invertible. A purely onchain Settler could evaluate nothing: it would be
 * staring at warrants without knowing what they promise.
 *
 * **Believe everything a file says.** Symmetrically disqualified: a local journal
 * taken at its word would turn a disk write into a trust surface, and a
 * hand-edited file could get a bond slashed.
 *
 * Hence the division that was retained, the same as everywhere else in the
 * project — the chain is authoritative, the off-chain side is verified against
 * it:
 *
 *   • **the chain** is authoritative on what *exists* and on its *status*:
 *     `WarrantOpened` gives the list, `warrants(id)` gives `status`, `expiry`,
 *     `bond`, `agent`, and the two commitments;
 *   • **the journal** supplies what the chain cannot return: the
 *     `ConditionSpec`, the `ActionSpec`, the classification, the `executionId`;
 *   • and the journal is **never believed**: `conditionHash(spec)` and
 *     `actionHash(spec)` are recomputed and compared against the onchain
 *     commitments before any evaluation. A forged line does not produce a wrong
 *     verdict, it produces a refusal to evaluate — hence an expiry towards
 *     `reclaim`, which refunds the agent. Doubt keeps benefiting the agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why append-only JSONL rather than SQLite
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An `append` of a line terminated by `\n` to a file opened with `O_APPEND` is
 * atomic as long as it stays under `PIPE_BUF`, and a reader that only consumes up
 * to the last `\n` never sees a partial write. That is exactly the discipline two
 * distinct processes need — the Gateway writes, the Settler follows — with no
 * lock, no schema, no native dependency, and the file stays readable by a human
 * on the day someone has to understand what happened. SQLite would bring
 * transactions this use case has no use for, at the price of a native binary to
 * install.
 *
 * The price we accept: no compaction. A rewritten warrant leaves its earlier
 * versions in the file; the last line wins on reload. At hackathon scale, and
 * even at several thousand warrants, a text file of a few megabytes is a
 * non-issue.
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

/** A journal line we could not read back. Never silent. */
export interface JournalDefect {
  /** Line number in the file, starting at 1. */
  line: number
  raw: string
  error: string
}

export interface WarrantJournalOptions {
  path: string
  /**
   * Called for every unreadable line. Defaults to a `console.warn`.
   *
   * A corrupted line never interrupts loading — a partially readable journal
   * beats a daemon that refuses to start and lets every warrant in flight
   * expire.
   */
  onDefect?: (defect: JournalDefect) => void
}

export interface WarrantJournal extends WarrantStore {
  put(record: WarrantRecord): void
  get(id: Hex): WarrantRecord | undefined
  list(): WarrantRecord[]
  /**
   * Consumes the lines appended since the last call and returns the number of
   * warrants that were updated.
   *
   * This is what lets the Settler *follow* a journal another process is feeding,
   * without re-reading the whole file on every loop iteration: we read only what
   * was appended, and never past the last `\n` — so a line still being written is
   * never seen half-formed.
   */
  refresh(): number
  /** Unreadable lines encountered since the journal was opened. */
  defects(): JournalDefect[]
  readonly path: string
}

/**
 * Opens — and creates if needed — a warrant journal on disk.
 *
 * Satisfies `WarrantStore`: the Gateway can use it as-is in place of
 * `memoryWarrantStore()`, without a single other line changing. That is
 * deliberate — persistence must not be a variant of the Gateway, just a
 * different store.
 */
export function fileWarrantStore(opts: WarrantJournalOptions | string): WarrantJournal {
  const options: WarrantJournalOptions = typeof opts === 'string' ? { path: opts } : opts
  const path = options.path
  const onDefect =
    options.onDefect ??
    ((d: JournalDefect) =>
      console.warn(
        JSON.stringify({ msg: 'journal: unreadable line', path, line: d.line, error: d.error }),
      ))

  mkdirSync(dirname(path), { recursive: true })

  const records = new Map<string, WarrantRecord>()
  const seenDefects: JournalDefect[] = []
  /** Bytes already consumed. Incremental following resumes from here. */
  let consumed = 0
  /** Number of the next line, so a defect can be located in the file. */
  let lineNo = 0
  /** Remainder of a line not terminated by `\n` — the writer has not finished. */
  let pending = ''

  function consumeAppendedBytes(): number {
    if (!existsSync(path)) return 0
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size < consumed) {
        // The file shrank: truncation or rotation. We start over rather than read
        // at an offset that no longer means anything.
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
        // No complete line: we keep everything for the next round.
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
      // Write first, memory second: if the disk refuses, the caller gets the
      // exception and the warrant is not believed to be recorded.
      appendFileSync(path, `${serializeRecord(record)}\n`, 'utf8')
      records.set(record.id.toLowerCase(), record)
      // The line we just wrote will be read back by `refresh()`: re-reading it is
      // a no-op (same id, same content), and skipping it would mean tracking a
      // byte offset we do not control under concurrent writes.
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
  // Minimal check: without an id and specs, the line is useless to the Settler,
  // and keeping it in memory would mask the problem.
  if (typeof parsed.id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(parsed.id)) {
    return { ok: false, error: 'id missing or malformed' }
  }
  if (!parsed.conditionSpec || !parsed.actionSpec) {
    return { ok: false, error: 'conditionSpec or actionSpec missing' }
  }
  return { ok: true, record: parsed as WarrantRecord }
}

/**
 * Serialisation of a record.
 *
 * `bigint` is converted to a decimal string rather than letting `JSON.stringify`
 * throw: `WarrantRecord` contains none today, but a line lost to a type error
 * would be a warrant the Settler never settles. We prefer a journal that
 * tolerates a field not being exactly typed.
 */
export function serializeRecord(record: WarrantRecord): string {
  return JSON.stringify(record, (_key, value) =>
    typeof value === 'bigint' ? value.toString(10) : value,
  )
}
