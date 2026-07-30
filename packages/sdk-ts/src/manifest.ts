/**
 * Le manifeste des outils — la projection lisible **hors de TypeScript**.
 *
 * Les quatre autres surfaces d'intégration sont écrites en TypeScript et
 * consomment directement `WARRANT_TOOLS`. Deux ne peuvent pas : le SDK Python
 * (LangChain, CrewAI) et la skill OpenClaw, qui est du texte. Elles ont besoin
 * de la même chose — noms, titres, descriptions, schémas — dans un format que
 * n'importe quel langage sait lire.
 *
 * D'où ce fichier, et rien de plus que ce fichier : il **sérialise** la source
 * unique, il ne la reformule pas. Aucune chaîne de caractères destinée à un
 * agent n'est écrite ici ; tout vient de `tools.ts` et de `schemas.ts`. C'est la
 * condition pour que la génération de code Python soit sûre : ce qui est généré
 * depuis ce manifeste ne peut pas diverger de la source, puisqu'il n'y a rien
 * entre les deux.
 *
 * Pourquoi pas l'OpenAPI du Gateway, qui existe déjà et que le Gateway sert à
 * `/openapi.json` ? Parce qu'il décrit la surface **HTTP**, pas la surface
 * **outils** : il n'a ni nom d'outil, ni description d'outil, et son
 * `WarrantRequest` ne porte même pas `beneficiary`. Générer des outils Python
 * depuis lui obligerait à retaper les descriptions en Python — exactement le
 * bug qu'on veut rendre impossible. L'OpenAPI reste utile comme *contrôle
 * croisé* : `packages/sdk-py/tests/test_openapi_conformance.py` vérifie que les
 * deux projections décrivent le même `ActionSpec`.
 */

import { z } from 'zod'

import { WarrantError } from './errors.js'
import type { WarrantErrorCode } from './errors.js'
import type { AnyWarrantTool } from './tools.js'
import { WARRANT_TOOLS } from './tools.js'

export interface WarrantToolManifestEntry {
  name: string
  title: string
  description: string
  /** `true` pour le seul `request_warrant` : la caution doit être financée. */
  paid: boolean
  readOnly: boolean
  /** JSON Schema draft-7 de l'entrée, tel que `tools/list` le publie. */
  inputSchema: Record<string, unknown>
  /** Contrat **minimal** de sortie — délibérément permissif, voir `schemas.ts`. */
  outputSchema: Record<string, unknown>
}

/** Un code d'erreur avec son `hint` par défaut et son lien de doc. */
export interface WarrantErrorManifestEntry {
  code: WarrantErrorCode
  hint: string
  docs: string
}

export interface WarrantToolManifest {
  /** Version du format du manifeste, pas du produit. */
  manifestVersion: 1
  /**
   * Dialecte des schémas. draft-7 comme pour MCP : c'est le plus petit
   * dénominateur commun des générateurs, et notamment de ce qu'un modèle sait
   * lire sans surprise.
   */
  jsonSchemaDialect: 'draft-7'
  tools: WarrantToolManifestEntry[]
  /**
   * Le catalogue d'erreurs.
   *
   * Il est ici pour la même raison que les descriptions d'outils : un `hint` est
   * lu par un agent, donc c'en est une surface d'intégration. Un SDK Python qui
   * réécrirait ses propres hints ferait diverger le conseil donné à l'agent selon
   * le langage de l'adaptateur — un même `invalid_action_spec` dirait deux choses
   * différentes.
   */
  errors: WarrantErrorManifestEntry[]
}

/**
 * Les codes, énumérés de façon **exhaustive vérifiée par le compilateur**.
 *
 * Un `Record<WarrantErrorCode, true>` et non un tableau : ajouter un code à
 * l'union sans l'ajouter ici casse `tsc`. Un tableau, lui, aurait accepté d'être
 * incomplet en silence, et le SDK Python aurait ignoré le nouveau code.
 */
const ERROR_CODES: Record<WarrantErrorCode, true> = {
  invalid_input: true,
  invalid_action_spec: true,
  invalid_condition_spec: true,
  classification_failed: true,
  payment_invalid: true,
  warrant_not_found: true,
  gateway_unreachable: true,
  gateway_error: true,
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io }) as Record<string, unknown>
}

/**
 * Sérialise les quatre outils.
 *
 * Le résultat est du JSON pur : ni fonction, ni classe, ni référence à Zod. Il
 * est donc écrivable sur disque et comparable octet par octet, ce qui est ce qui
 * rend le contrôle de dérive du générateur Python possible.
 */
export function warrantToolManifest(): WarrantToolManifest {
  return {
    manifestVersion: 1,
    jsonSchemaDialect: 'draft-7',
    tools: (WARRANT_TOOLS as readonly AnyWarrantTool[]).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      paid: tool.paid,
      readOnly: tool.readOnly,
      inputSchema: jsonSchema(tool.input, 'input'),
      outputSchema: jsonSchema(tool.output, 'output'),
    })),
    // `hint` et `docs` ne sont pas recopiés : ils sont **lus** sur une instance,
    // là où `errors.ts` les pose. C'est le seul moyen d'être sûr qu'ils valent
    // exactement ce qu'un appelant TypeScript recevrait.
    errors: (Object.keys(ERROR_CODES) as WarrantErrorCode[]).map((code) => {
      const probe = new WarrantError(code, '')
      return { code, hint: probe.hint, docs: probe.docs }
    }),
  }
}
