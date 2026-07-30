/**
 * Generator for the Python SDK and the OpenClaw skill.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Generation, not runtime reading: the reasoning
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The four tools' schemas live in TypeScript. Three routes were available to get
 * them into Python without retyping them.
 *
 * 1. **Read `/openapi.json` at runtime.** Ruled out for two reasons, the first of
 *    which is decisive: that document describes the **HTTP** surface, not the
 *    **tool** surface. It contains neither tool names nor tool descriptions, and
 *    its `WarrantRequest` does not even carry `beneficiary`. We would therefore
 *    have to rewrite the descriptions in Python — precisely the bug we refuse.
 *    The second reason is operational: building a LangChain agent would become a
 *    network call. A momentarily silent Gateway would not yield an error, it
 *    would yield an agent **with no tools**, which is very hard to diagnose from
 *    a model trace.
 *
 * 2. **Generate from `/openapi.json`.** The same information deficit, with one
 *    more defect: we would be deriving from a sibling projection instead of from
 *    the source. Any error in the OpenAPI would propagate into the Python while
 *    looking like a truth.
 *
 * 3. **Generate from the source, and verify the output in CI.** Chosen. The
 *    manifest (`packages/sdk-ts/src/manifest.ts`) serialises `WARRANT_TOOLS`
 *    without rephrasing anything; this file translates it into Python. No string
 *    destined for an agent is written here: they pass through, verbatim.
 *
 * What generation costs, and how we pay for it: a generated artifact can sleep
 * while the source is being modified. Hence `--check`, which regenerates in
 * memory and compares byte for byte — `tests/test_codegen_drift.py` fails if
 * anything has moved. Drift therefore becomes a red CI, not a surprise in
 * production.
 *
 * The OpenAPI is not ignored for all that: we freeze a snapshot of it
 * (`tests/fixtures/openapi.json`) and `test_openapi_conformance.py` verifies that
 * both projections describe the same `ActionSpec`. That is the only honest use of
 * a sibling projection: a cross-check, not a source.
 *
 * Usage:
 *   pnpm tsx packages/sdk-py/codegen/emit.ts           # writes
 *   pnpm tsx packages/sdk-py/codegen/emit.ts --check   # verifies, exits 1 on drift
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openapiDocument } from '../../server/src/openapi.js'
import { warrantToolManifest } from '../../sdk-ts/src/manifest.js'
import type { WarrantToolManifest } from '../../sdk-ts/src/manifest.js'
import { ModelRegistry, emitInputModel } from './pydantic.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const REPO = join(PKG, '..', '..')

/**
 * The deployment frozen into the OpenAPI snapshot.
 *
 * These are the real Base Sepolia values — the only EVM chain the public x402
 * facilitator serves (see the root README). Writing them here rather than
 * inventing test addresses means the snapshot documents the deployment at the
 * same time as it serves as the cross-check's reference.
 */
const SNAPSHOT_DEPLOYMENT = {
  baseUrl: 'http://127.0.0.1:8402',
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  minBond: '5000000',
  maxBond: '250000000',
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Python literals
// ─────────────────────────────────────────────────────────────────────────────

/** JSON → Python literal. `true`/`false`/`null` are the only divergences. */
function pyLiteral(value: unknown, indent: string): string {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  const inner = `${indent}    `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((v) => `${inner}${pyLiteral(v, inner)},`).join('\n')
    return `[\n${items}\n${indent}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  const body = entries
    .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pyLiteral(v, inner)},`)
    .join('\n')
  return `{\n${body}\n${indent}}`
}

// ─────────────────────────────────────────────────────────────────────────────
// `warrant_sdk/_generated.py`
// ─────────────────────────────────────────────────────────────────────────────

function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}

function emitPython(manifest: WarrantToolManifest, digest: string): string {
  const registry = new ModelRegistry()
  const rootModels = manifest.tools.map((tool) => ({
    tool,
    model: emitInputModel(tool.name, tool.inputSchema, registry),
  }))

  const head = `# ═══════════════════════════════════════════════════════════════════════════
# GENERATED FILE — DO NOT EDIT BY HAND.
#
# Source:     packages/sdk-ts/src/tools.ts and schemas.ts, serialised by
#             packages/sdk-ts/src/manifest.ts.
# Regenerate: pnpm tsx packages/sdk-py/codegen/emit.ts
# Verify:     pnpm tsx packages/sdk-py/codegen/emit.ts --check
#
# Any manual edit will be overwritten, and \`tests/test_codegen_drift.py\` will
# fail before that happens: this is what guarantees the Python cannot diverge
# from the TypeScript. The descriptions below are copied verbatim from the single
# source of truth — correcting them here would make them lie, not improve them.
# ═══════════════════════════════════════════════════════════════════════════
"""Models and manifest generated from the TypeScript single source of truth.

Nothing here is written by hand. The Pydantic models carry \`extra="ignore"\`,
which reproduces the unknown-key stripping that Zod performs: a \`category\` or
\`notional\` field slipped into the arguments is **removed** before the call, so
it reaches neither the Classifier nor the \`actionHash\`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

MANIFEST_VERSION = ${manifest.manifestVersion}
JSON_SCHEMA_DIALECT = ${JSON.stringify(manifest.jsonSchemaDialect)}

#: sha256 of the manifest's canonical form. Identifies the revision of the single
#: source of truth this file came from; published by \`warrant tools\` and by the
#: OpenClaw skill so that a stale artifact can be spotted without reading code.
MANIFEST_SHA256 = ${JSON.stringify(digest)}
`

  const models = registry.models.map((m) => m.source).join('\n\n\n')

  const specs = rootModels
    .map(({ tool, model }) => {
      const entry = {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        paid: tool.paid,
        read_only: tool.readOnly,
        input_schema: tool.inputSchema,
        output_schema: tool.outputSchema,
      }
      const lines = Object.entries(entry).map(
        ([k, v]) => `        ${JSON.stringify(k)}: ${pyLiteral(v, '        ')},`,
      )
      lines.push(`        "input_model": ${model},`)
      return `    {\n${lines.join('\n')}\n    },`
    })
    .join('\n')

  const errors = manifest.errors
    .map(
      (e) =>
        `    ${JSON.stringify(e.code)}: {\n        "hint": ${JSON.stringify(e.hint)},\n        "docs": ${JSON.stringify(e.docs)},\n    },`,
    )
    .join('\n')

  const tail = `#: The error catalogue, exactly as \`errors.ts\` lays it out. A \`hint\` is read by
#: an agent: rewriting it in Python would make the same code say two different
#: things depending on the adapter's language.
ERROR_CATALOG: dict[str, dict[str, str]] = {
${errors}
}


#: The four tools, in source order: quote, warrant, read, history. \`input_model\`
#: is the Pydantic model above; \`input_schema\` is the draft-7 JSON Schema
#: published as-is by \`tools/list\` on the MCP side.
TOOL_MANIFEST: tuple[dict[str, Any], ...] = (
${specs}
)

TOOL_NAMES: tuple[str, ...] = tuple(spec["name"] for spec in TOOL_MANIFEST)

__all__ = [
    "ERROR_CATALOG",
    "JSON_SCHEMA_DIALECT",
    "MANIFEST_SHA256",
    "MANIFEST_VERSION",
    "TOOL_MANIFEST",
    "TOOL_NAMES",
${registry.models.map((m) => `    ${JSON.stringify(m.name)},`).join('\n')}
]
`

  return `${head}\n\n${models}\n\n\n${tail}`
}

// ─────────────────────────────────────────────────────────────────────────────
// `skills/warrant/SKILL.md`
// ─────────────────────────────────────────────────────────────────────────────

const BEGIN = '<!-- BEGIN GENERATED: tools -->'
const END = '<!-- END GENERATED: tools -->'

/**
 * The skill's tool block, derived from the manifest.
 *
 * The runbook prose is written by hand (`codegen/skill-template.md`): it says
 * *when* to call and *how* to fail, which no schema contains. But the list of
 * tools, their descriptions and their arguments are generated — a SKILL.md that
 * rephrases a tool description is a SKILL.md that will lie at the first change
 * to the source.
 */
function emitSkillTools(manifest: WarrantToolManifest): string {
  const blocks = manifest.tools.map((tool) => {
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
    const required = new Set(schema.required ?? [])
    const args = Object.entries(schema.properties ?? {}).map(([name, prop]) => {
      const kind = prop.type ?? 'any'
      return `| \`${name}\` | ${kind} | ${required.has(name) ? 'yes' : 'no'} | ${
        (prop.description ?? '').replace(/\|/g, '\\|')
      } |`
    })
    return [
      `### \`${tool.name}\` — ${tool.paid ? '**paid** (bond must be funded)' : 'free'}`,
      '',
      `_${tool.title}_`,
      '',
      tool.description,
      '',
      '| argument | type | required | meaning |',
      '| --- | --- | --- | --- |',
      ...args,
      '',
    ].join('\n')
  })
  return blocks.join('\n')
}

function emitSkill(manifest: WarrantToolManifest, digest: string): string {
  const template = readFileSync(join(HERE, 'skill-template.md'), 'utf8')
  const start = template.indexOf(BEGIN)
  const end = template.indexOf(END)
  if (start === -1 || end === -1) {
    throw new Error(`skill-template.md: markers ${BEGIN} / ${END} not found`)
  }
  const generated = `${BEGIN}\n<!-- Generated from the manifest. Edit codegen/skill-template.md, not this block. -->\n\n${emitSkillTools(manifest)}${END}`
  return (
    template.slice(0, start) +
    generated +
    template.slice(end + END.length)
  ).replace(/\{\{MANIFEST_SHA256\}\}/g, digest)
}

// ─────────────────────────────────────────────────────────────────────────────

interface Artifact {
  path: string
  content: string
}

function artifacts(): Artifact[] {
  const manifest = warrantToolManifest()
  // Canonical form: keys in the manifest's insertion order, fixed indentation.
  // This is the hash the skill and the CLI publish.
  const canonical = JSON.stringify(manifest)
  const digest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`

  return [
    {
      path: join(PKG, 'src', 'warrant_sdk', '_generated.py'),
      content: emitPython(manifest, digest),
    },
    {
      path: join(PKG, 'tests', 'fixtures', 'manifest.json'),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      path: join(PKG, 'tests', 'fixtures', 'openapi.json'),
      content: `${JSON.stringify(openapiDocument(SNAPSHOT_DEPLOYMENT), null, 2)}\n`,
    },
    {
      path: join(REPO, 'skills', 'warrant', 'SKILL.md'),
      content: emitSkill(manifest, digest),
    },
  ]
}

function main(): void {
  const check = process.argv.includes('--check')
  const built = artifacts()
  const drifted: string[] = []

  for (const artifact of built) {
    const rel = relative(REPO, artifact.path)
    if (check) {
      let current: string | undefined
      try {
        current = readFileSync(artifact.path, 'utf8')
      } catch {
        current = undefined
      }
      if (current === undefined) {
        drifted.push(`${rel}: missing`)
        continue
      }
      if (current !== artifact.content) {
        drifted.push(`${rel}: ${firstDifference(current, artifact.content)}`)
      }
      continue
    }
    mkdirSync(dirname(artifact.path), { recursive: true })
    writeFileSync(artifact.path, artifact.content, 'utf8')
    console.log(`wrote ${rel} (${artifact.content.length} bytes)`)
  }

  if (!check) return

  if (drifted.length > 0) {
    console.error(
      'The generated artifacts no longer match the single source of truth:\n' +
        drifted.map((d) => `  • ${d}`).join('\n') +
        '\n\nRegenerate: pnpm tsx packages/sdk-py/codegen/emit.ts',
    )
    process.exit(1)
  }
  console.log(`${built.length} artifacts match the single source of truth.`)
}

/** Locates the first diverging line — a full diff would drown the signal. */
function firstDifference(current: string, expected: string): string {
  const a = current.split('\n')
  const b = expected.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n      on disk:  ${JSON.stringify(a[i] ?? '<end of file>')}\n      expected: ${JSON.stringify(b[i] ?? '<end of file>')}`
    }
  }
  return 'differing lengths with no diverging line'
}

main()
