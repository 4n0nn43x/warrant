/**
 * JSON Schema draft-7 → Pydantic v2 model, as Python source.
 *
 * A **deliberately incomplete** emitter. It covers only the constructs that
 * `z.toJSONSchema` actually produces for the four tools, and it **throws** on
 * everything else: a `oneOf`, a `$ref`, an `allOf` appearing in `schemas.ts`
 * makes generation fail, naming the path of the offending field.
 *
 * That is the choice that matters in this file. A generic, tolerant emitter would
 * translate a constraint it does not understand into `Any`, silently: the Python
 * would keep compiling, the tests would keep passing, and a Python agent would
 * accept an argument the TypeScript agent refuses. The divergence would be
 * invisible. Here it is loud and immediate.
 */

/** What a field becomes in Python. */
interface PyType {
  /** Annotation, e.g. `str`, `Literal[1]`, `list[CheckResult]`. */
  annotation: string
  /** Arguments to `Field(...)`, excluding `description` and `default`. */
  constraints: string[]
}

export interface EmittedModel {
  /** Class name, e.g. `ActionSpec`. */
  name: string
  /** The class's complete Python source. */
  source: string
}

export class SchemaNotSupported extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`)
    this.name = 'SchemaNotSupported'
  }
}

type Schema = Record<string, unknown>

/** Python literal for a string. `JSON.stringify`'s output happens to be one. */
function pyStr(value: string): string {
  return JSON.stringify(value)
}

/** Class docstring. `"""` and `\` are neutralised out of caution. */
function pyDocstring(text: string, indent: string): string {
  const safe = text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
  return `${indent}"""${safe}"""`
}

function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Collector for nested models, with **structural** deduplication.
 *
 * `actionSpec` appears in two tools with a bit-for-bit identical schema. Emitting
 * both `QuoteRiskActionSpec` and `RequestWarrantActionSpec` would produce two
 * classes nothing distinguishes, and an integrator importing one of them could
 * not pass it to the other tool. So we deduplicate on the schema's canonical
 * form, and two different shapes laying claim to the same name get suffixed
 * rather than merged.
 */
export class ModelRegistry {
  private readonly byShape = new Map<string, string>()
  private readonly byName = new Map<string, string>()
  readonly models: EmittedModel[] = []

  /** Emits (or looks up) an object's class and returns its name. */
  intern(preferredName: string, schema: Schema, path: string): string {
    const shape = JSON.stringify(schema)
    const existing = this.byShape.get(shape)
    if (existing) return existing

    let name = pascalCase(preferredName)
    let suffix = 2
    while (this.byName.has(name)) name = `${pascalCase(preferredName)}${suffix++}`

    // Reserved before emission: otherwise a recursive object loops forever.
    this.byShape.set(shape, name)
    this.byName.set(name, shape)
    this.models.push({ name, source: emitModel(name, schema, path, this) })
    return name
  }
}

/** Translates a field schema. */
function pyTypeOf(schema: Schema, path: string, registry: ModelRegistry, fieldName: string): PyType {
  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'] as unknown[]
    if (!values.every((v) => typeof v === 'string')) {
      throw new SchemaNotSupported(path, 'enum of non-string values')
    }
    return { annotation: `Literal[${values.map((v) => pyStr(v as string)).join(', ')}]`, constraints: [] }
  }

  if (schema['const'] !== undefined) {
    const value = schema['const']
    if (typeof value === 'number') return { annotation: `Literal[${value}]`, constraints: [] }
    if (typeof value === 'string') return { annotation: `Literal[${pyStr(value)}]`, constraints: [] }
    throw new SchemaNotSupported(path, `const of type ${typeof value}`)
  }

  const type = schema['type']
  if (typeof type !== 'string') {
    throw new SchemaNotSupported(
      path,
      `schema with no scalar \`type\` (received ${JSON.stringify(type)}) — ` +
        'oneOf/anyOf/allOf/$ref are not translated',
    )
  }

  switch (type) {
    case 'string': {
      const constraints: string[] = []
      if (typeof schema['pattern'] === 'string') {
        constraints.push(`pattern=${pyStr(schema['pattern'])}`)
      }
      if (typeof schema['minLength'] === 'number') constraints.push(`min_length=${schema['minLength']}`)
      if (typeof schema['maxLength'] === 'number') constraints.push(`max_length=${schema['maxLength']}`)
      return { annotation: 'str', constraints }
    }

    case 'integer':
    case 'number': {
      const constraints: string[] = []
      if (typeof schema['exclusiveMinimum'] === 'number') constraints.push(`gt=${schema['exclusiveMinimum']}`)
      if (typeof schema['minimum'] === 'number') constraints.push(`ge=${schema['minimum']}`)
      if (typeof schema['exclusiveMaximum'] === 'number') constraints.push(`lt=${schema['exclusiveMaximum']}`)
      if (typeof schema['maximum'] === 'number') constraints.push(`le=${schema['maximum']}`)
      // `integer` → `int`. `number` → `float` would be wrong for our
      // second-valued integers; no input schema uses `number` without `const`.
      if (type === 'number') {
        throw new SchemaNotSupported(
          path,
          'type `number` without `const` — specify `.int()` on the Zod side rather ' +
            'than letting a float through (a fractional timestamp means nothing)',
        )
      }
      return { annotation: 'int', constraints }
    }

    case 'boolean':
      return { annotation: 'bool', constraints: [] }

    case 'array': {
      const items = schema['items']
      if (typeof items !== 'object' || items === null) {
        throw new SchemaNotSupported(path, 'array with no `items`')
      }
      const inner = pyTypeOf(items as Schema, `${path}[]`, registry, `${fieldName}Item`)
      if (inner.constraints.length > 0) {
        throw new SchemaNotSupported(path, 'constraints on array elements are not translated')
      }
      return { annotation: `list[${inner.annotation}]`, constraints: [] }
    }

    case 'object': {
      // Free-form record (`z.record`): `propertyNames` without `properties`.
      if (schema['properties'] === undefined) {
        if (schema['additionalProperties'] === undefined && schema['propertyNames'] === undefined) {
          throw new SchemaNotSupported(path, 'object with neither `properties` nor `additionalProperties`')
        }
        return { annotation: 'dict[str, Any]', constraints: [] }
      }
      const model = registry.intern(fieldName, schema, path)
      return { annotation: model, constraints: [] }
    }

    default:
      throw new SchemaNotSupported(path, `unsupported JSON Schema type: ${type}`)
  }
}

/**
 * Emits a Pydantic class for an object schema.
 *
 * `extra="ignore"` reproduces Zod's behaviour on unknown keys exactly: they are
 * **stripped**, not rejected. That is guarantee #2 of `schemas.ts`, and it is the
 * only one that holds against a hostile client — a `category` slipped into the
 * `actionSpec` reaches neither the Classifier nor the `actionHash`, because the
 * value forwarded to the Gateway is the cleaned object. Switching it to
 * `extra="forbid"` would, on the contrary, teach the agent that the field exists
 * somewhere.
 */
export function emitModel(
  className: string,
  schema: Schema,
  path: string,
  registry: ModelRegistry,
): string {
  const properties = (schema['properties'] ?? {}) as Record<string, Schema>
  const required = new Set((schema['required'] as string[] | undefined) ?? [])
  const lines: string[] = []

  lines.push(`class ${className}(BaseModel):`)
  const description = schema['description']
  if (typeof description === 'string') lines.push(pyDocstring(description, '    '))
  else lines.push(pyDocstring(`Generated from the Warrant tool manifest.`, '    '))
  lines.push('')
  lines.push('    model_config = ConfigDict(extra="ignore")')
  lines.push('')

  // Required first: Python forbids a field without a default after a field with
  // one, and the producer does not guarantee the order of `required`.
  const names = Object.keys(properties).sort((a, b) => {
    const ra = required.has(a) ? 0 : 1
    const rb = required.has(b) ? 0 : 1
    if (ra !== rb) return ra - rb
    return 0
  })

  for (const name of names) {
    const propSchema = properties[name] as Schema
    const propPath = `${path}.${name}`
    const py = pyTypeOf(propSchema, propPath, registry, name)
    const args = [...py.constraints]
    const desc = propSchema['description']
    if (typeof desc === 'string') args.push(`description=${pyStr(desc)}`)

    if (required.has(name)) {
      const field = args.length > 0 ? ` = Field(${args.join(', ')})` : ''
      lines.push(`    ${name}: ${py.annotation}${field}`)
    } else {
      // `default=None` first: positional `Field(None, …)` is deprecated.
      const field = `Field(default=None${args.length > 0 ? `, ${args.join(', ')}` : ''})`
      lines.push(`    ${name}: ${py.annotation} | None = ${field}`)
    }
  }

  if (names.length === 0) lines.push('    pass')
  return lines.join('\n')
}

/**
 * Entry point: emits the root model for a tool's input schema.
 *
 * The root schema has no `description` — in the source it is the tool that
 * carries one, not its argument object. So we supply a neutral one, naming the
 * tool and nothing more: copying the tool's description here would make it appear
 * twice in what the model sees, once as a tool description and once as a schema
 * description.
 */
export function emitInputModel(
  toolName: string,
  inputSchema: Schema,
  registry: ModelRegistry,
): string {
  const described: Schema =
    inputSchema['description'] === undefined
      ? { ...inputSchema, description: `Arguments of the \`${toolName}\` tool.` }
      : inputSchema
  return registry.intern(`${toolName}_input`, described, `$.${toolName}`)
}
