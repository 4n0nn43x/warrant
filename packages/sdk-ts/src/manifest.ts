/**
 * The tool manifest — the projection legible **outside of TypeScript**.
 *
 * The four other integration surfaces are written in TypeScript and consume
 * `WARRANT_TOOLS` directly. Two cannot: the Python SDK (LangChain, CrewAI) and
 * the OpenClaw skill, which is text. Both need the same thing — names, titles,
 * descriptions, schemas — in a format any language can read.
 *
 * Hence this file, and nothing more than this file: it **serialises** the single
 * source, it does not restate it. No string destined for an agent is written
 * here; everything comes from `tools.ts` and `schemas.ts`. That is the condition
 * for Python code generation to be safe: what is generated from this manifest
 * cannot diverge from the source, since there is nothing in between.
 *
 * Why not the Gateway's OpenAPI, which already exists and which the Gateway
 * serves at `/openapi.json`? Because it describes the **HTTP** surface, not the
 * **tool** surface: it has neither tool name nor tool description, and its
 * `WarrantRequest` does not even carry `beneficiary`. Generating Python tools
 * from it would force us to retype the descriptions in Python — exactly the bug
 * we want to make impossible. The OpenAPI stays useful as a *cross-check*:
 * `packages/sdk-py/tests/test_openapi_conformance.py` verifies that the two
 * projections describe the same `ActionSpec`.
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
  /** `true` for `request_warrant` alone: the bond must be funded. */
  paid: boolean
  readOnly: boolean
  /** JSON Schema draft-7 of the input, exactly as `tools/list` publishes it. */
  inputSchema: Record<string, unknown>
  /** **Minimal** output contract — deliberately permissive, see `schemas.ts`. */
  outputSchema: Record<string, unknown>
}

/** An error code with its default `hint` and its documentation link. */
export interface WarrantErrorManifestEntry {
  code: WarrantErrorCode
  hint: string
  docs: string
}

export interface WarrantToolManifest {
  /** Version of the manifest format, not of the product. */
  manifestVersion: 1
  /**
   * Schema dialect. draft-7, as for MCP: it is the lowest common denominator of
   * generators, and notably of what a model can read without surprises.
   */
  jsonSchemaDialect: 'draft-7'
  tools: WarrantToolManifestEntry[]
  /**
   * The error catalogue.
   *
   * It is here for the same reason as the tool descriptions: a `hint` is read by
   * an agent, so it is an integration surface too. A Python SDK that rewrote its
   * own hints would make the advice given to the agent differ by adapter
   * language — one and the same `invalid_action_spec` would say two different
   * things.
   */
  errors: WarrantErrorManifestEntry[]
}

/**
 * The codes, enumerated in a way that is **exhaustively checked by the
 * compiler**.
 *
 * A `Record<WarrantErrorCode, true>` and not an array: adding a code to the
 * union without adding it here breaks `tsc`. An array, by contrast, would have
 * accepted being incomplete in silence, and the Python SDK would have ignored
 * the new code.
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
 * Serialises the four tools.
 *
 * The result is pure JSON: no function, no class, no reference to Zod. It is
 * therefore writable to disk and comparable byte for byte, which is what makes
 * the drift check of the Python generator possible.
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
    // `hint` and `docs` are not copied out: they are **read** off an instance,
    // where `errors.ts` puts them. That is the only way to be sure they are
    // worth exactly what a TypeScript caller would receive.
    errors: (Object.keys(ERROR_CODES) as WarrantErrorCode[]).map((code) => {
      const probe = new WarrantError(code, '')
      return { code, hint: probe.hint, docs: probe.docs }
    }),
  }
}
