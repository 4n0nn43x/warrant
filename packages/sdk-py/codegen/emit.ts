/**
 * Générateur du SDK Python et de la skill OpenClaw.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Génération, et non lecture à l'exécution : le raisonnement
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Les schémas des quatre outils vivent en TypeScript. Trois voies s'offraient
 * pour les faire arriver en Python sans les retaper.
 *
 * 1. **Lire `/openapi.json` à l'exécution.** Écartée pour deux raisons, dont la
 *    première est décisive : le document décrit la surface **HTTP**, pas la
 *    surface **outils**. Il n'y a dedans ni nom d'outil, ni description d'outil,
 *    et son `WarrantRequest` ne porte même pas `beneficiary`. Il faudrait donc
 *    réécrire les descriptions en Python — précisément le bug qu'on refuse. La
 *    seconde raison est opérationnelle : construire un agent LangChain
 *    deviendrait un appel réseau. Un Gateway momentanément muet ne donnerait pas
 *    une erreur, il donnerait un agent **sans outils**, ce qui se diagnostique
 *    très mal depuis une trace de modèle.
 *
 * 2. **Générer depuis `/openapi.json`.** Même déficit d'information, avec un
 *    défaut de plus : on dériverait d'une projection sœur au lieu de la source.
 *    Toute erreur de l'OpenAPI se propagerait au Python en ayant l'air d'une
 *    vérité.
 *
 * 3. **Générer depuis la source, et vérifier la sortie en CI.** Retenue. Le
 *    manifeste (`packages/sdk-ts/src/manifest.ts`) sérialise `WARRANT_TOOLS`
 *    sans rien reformuler ; ce fichier le traduit en Python. Aucune chaîne
 *    destinée à un agent n'est écrite ici : elles traversent, verbatim.
 *
 * Ce que la génération coûte, et comment on le paie : un artefact généré peut
 * dormir pendant qu'on modifie la source. D'où `--check`, qui régénère en
 * mémoire et compare octet par octet — `tests/test_codegen_drift.py` échoue si
 * quoi que ce soit a bougé. La dérive devient donc une CI rouge, pas une
 * surprise en production.
 *
 * L'OpenAPI n'est pas pour autant ignoré : on en fige un instantané
 * (`tests/fixtures/openapi.json`) et `test_openapi_conformance.py` vérifie que
 * les deux projections décrivent le même `ActionSpec`. C'est le seul usage
 * honnête d'une projection sœur : un contrôle croisé, pas une source.
 *
 * Usage :
 *   pnpm tsx packages/sdk-py/codegen/emit.ts           # écrit
 *   pnpm tsx packages/sdk-py/codegen/emit.ts --check   # vérifie, sort 1 si dérive
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
 * Le déploiement figé dans l'instantané OpenAPI.
 *
 * Ce sont les valeurs réelles de Base Sepolia — la seule chaîne EVM que le
 * facilitateur public x402 sert (voir le README racine). Les inscrire ici plutôt
 * que d'inventer des adresses de test fait que l'instantané documente le
 * déploiement en même temps qu'il sert de référence au contrôle croisé.
 */
const SNAPSHOT_DEPLOYMENT = {
  baseUrl: 'http://127.0.0.1:8402',
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  minBond: '5000000',
  maxBond: '250000000',
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Littéraux Python
// ─────────────────────────────────────────────────────────────────────────────

/** JSON → littéral Python. `true`/`false`/`null` sont les seules divergences. */
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
# FICHIER GÉNÉRÉ — NE PAS ÉDITER À LA MAIN.
#
# Source : packages/sdk-ts/src/tools.ts et schemas.ts, sérialisés par
#          packages/sdk-ts/src/manifest.ts.
# Régénérer : pnpm tsx packages/sdk-py/codegen/emit.ts
# Vérifier   : pnpm tsx packages/sdk-py/codegen/emit.ts --check
#
# Toute modification manuelle sera écrasée, et \`tests/test_codegen_drift.py\`
# échouera avant : c'est ce qui garantit que le Python ne peut pas diverger du
# TypeScript. Les descriptions ci-dessous sont recopiées verbatim depuis la
# source unique — les corriger ici les ferait mentir, pas les améliorer.
# ═══════════════════════════════════════════════════════════════════════════
"""Modèles et manifeste générés depuis la source unique TypeScript.

Rien ici n'est écrit à la main. Les modèles Pydantic portent \`extra="ignore"\`,
ce qui reproduit le nettoyage des clés inconnues fait par Zod : un champ
\`category\` ou \`notional\` glissé dans les arguments est **retiré** avant
l'appel, donc il n'atteint ni le Classifieur, ni l'\`actionHash\`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

MANIFEST_VERSION = ${manifest.manifestVersion}
JSON_SCHEMA_DIALECT = ${JSON.stringify(manifest.jsonSchemaDialect)}

#: sha256 de la forme canonique du manifeste. Identifie la révision de la source
#: unique dont ce fichier est issu ; publié par \`warrant tools\` et par la skill
#: OpenClaw pour qu'un artefact périmé se repère sans lire le code.
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

  const tail = `#: Le catalogue d'erreurs, tel que \`errors.ts\` le pose. Un \`hint\` est lu par un
#: agent : le réécrire en Python ferait dire deux choses différentes au même code
#: selon le langage de l'adaptateur.
ERROR_CATALOG: dict[str, dict[str, str]] = {
${errors}
}


#: Les quatre outils, dans l'ordre de la source : devis, mandat, lecture,
#: historique. \`input_model\` est le modèle Pydantic ci-dessus ; \`input_schema\`
#: est le JSON Schema draft-7 publié tel quel par \`tools/list\` côté MCP.
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
 * Le bloc d'outils de la skill, dérivé du manifeste.
 *
 * La prose du runbook est écrite à la main (`codegen/skill-template.md`) : elle
 * dit *quand* appeler et *comment* échouer, ce qu'aucun schéma ne contient. Mais
 * la liste des outils, leurs descriptions et leurs arguments sont générés — un
 * SKILL.md qui reformule une description d'outil est un SKILL.md qui mentira au
 * premier changement de la source.
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
    throw new Error(`skill-template.md : bornes ${BEGIN} / ${END} introuvables`)
  }
  const generated = `${BEGIN}\n<!-- Généré depuis le manifeste. Éditer codegen/skill-template.md, pas ce bloc. -->\n\n${emitSkillTools(manifest)}${END}`
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
  // Forme canonique : clés dans l'ordre d'insertion du manifeste, indentation
  // fixe. C'est ce hash que la skill et la CLI publient.
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
        drifted.push(`${rel} : absent`)
        continue
      }
      if (current !== artifact.content) {
        drifted.push(`${rel} : ${firstDifference(current, artifact.content)}`)
      }
      continue
    }
    mkdirSync(dirname(artifact.path), { recursive: true })
    writeFileSync(artifact.path, artifact.content, 'utf8')
    console.log(`écrit ${rel} (${artifact.content.length} octets)`)
  }

  if (!check) return

  if (drifted.length > 0) {
    console.error(
      'Les artefacts générés ne correspondent plus à la source unique :\n' +
        drifted.map((d) => `  • ${d}`).join('\n') +
        '\n\nRégénérer : pnpm tsx packages/sdk-py/codegen/emit.ts',
    )
    process.exit(1)
  }
  console.log(`${built.length} artefacts conformes à la source unique.`)
}

/** Localise la première ligne divergente — un diff complet noierait le signal. */
function firstDifference(current: string, expected: string): string {
  const a = current.split('\n')
  const b = expected.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return `ligne ${i + 1}\n      sur disque : ${JSON.stringify(a[i] ?? '<fin de fichier>')}\n      attendu    : ${JSON.stringify(b[i] ?? '<fin de fichier>')}`
    }
  }
  return 'longueurs différentes sans ligne divergente'
}

main()
