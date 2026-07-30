/**
 * JSON Schema draft-7 → modèle Pydantic v2, en Python source.
 *
 * Émetteur **délibérément incomplet**. Il ne couvre que les constructions que
 * `z.toJSONSchema` produit réellement pour les quatre outils, et il **lève** sur
 * tout le reste : un `oneOf`, un `$ref`, un `allOf` apparu dans `schemas.ts`
 * fait échouer la génération avec le chemin du champ fautif.
 *
 * C'est le choix qui compte dans ce fichier. Un émetteur générique et tolérant
 * traduirait une contrainte qu'il ne comprend pas en `Any`, silencieusement : le
 * Python continuerait de compiler, les tests continueraient de passer, et un
 * agent Python accepterait un argument que l'agent TypeScript refuse. La
 * divergence serait invisible. Ici elle est bruyante et immédiate.
 */

/** Ce qu'un champ devient en Python. */
interface PyType {
  /** Annotation, ex. `str`, `Literal[1]`, `list[CheckResult]`. */
  annotation: string
  /** Arguments de `Field(...)`, hors `description` et `default`. */
  constraints: string[]
}

export interface EmittedModel {
  /** Nom de classe, ex. `ActionSpec`. */
  name: string
  /** Source Python complète de la classe. */
  source: string
}

export class SchemaNotSupported extends Error {
  constructor(path: string, detail: string) {
    super(`${path} : ${detail}`)
    this.name = 'SchemaNotSupported'
  }
}

type Schema = Record<string, unknown>

/** Littéral Python d'une chaîne. La sortie de `JSON.stringify` en est un. */
function pyStr(value: string): string {
  return JSON.stringify(value)
}

/** Docstring de classe. `"""` et `\` sont neutralisés par prudence. */
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
 * Collecteur de modèles imbriqués, avec déduplication **structurelle**.
 *
 * `actionSpec` apparaît dans deux outils avec un schéma identique au bit près.
 * Émettre `QuoteRiskActionSpec` et `RequestWarrantActionSpec` produirait deux
 * classes que rien ne distingue, et un intégrateur qui en importe une ne
 * pourrait pas la passer à l'autre outil. On déduplique donc sur la forme
 * canonique du schéma, et deux formes différentes qui réclament le même nom se
 * voient suffixer plutôt que fusionner.
 */
export class ModelRegistry {
  private readonly byShape = new Map<string, string>()
  private readonly byName = new Map<string, string>()
  readonly models: EmittedModel[] = []

  /** Émet (ou retrouve) la classe d'un objet et rend son nom. */
  intern(preferredName: string, schema: Schema, path: string): string {
    const shape = JSON.stringify(schema)
    const existing = this.byShape.get(shape)
    if (existing) return existing

    let name = pascalCase(preferredName)
    let suffix = 2
    while (this.byName.has(name)) name = `${pascalCase(preferredName)}${suffix++}`

    // Réservé avant l'émission : un objet récursif boucle sinon indéfiniment.
    this.byShape.set(shape, name)
    this.byName.set(name, shape)
    this.models.push({ name, source: emitModel(name, schema, path, this) })
    return name
  }
}

/** Traduit un schéma de champ. */
function pyTypeOf(schema: Schema, path: string, registry: ModelRegistry, fieldName: string): PyType {
  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'] as unknown[]
    if (!values.every((v) => typeof v === 'string')) {
      throw new SchemaNotSupported(path, 'enum de valeurs non textuelles')
    }
    return { annotation: `Literal[${values.map((v) => pyStr(v as string)).join(', ')}]`, constraints: [] }
  }

  if (schema['const'] !== undefined) {
    const value = schema['const']
    if (typeof value === 'number') return { annotation: `Literal[${value}]`, constraints: [] }
    if (typeof value === 'string') return { annotation: `Literal[${pyStr(value)}]`, constraints: [] }
    throw new SchemaNotSupported(path, `const de type ${typeof value}`)
  }

  const type = schema['type']
  if (typeof type !== 'string') {
    throw new SchemaNotSupported(
      path,
      `schéma sans \`type\` scalaire (reçu ${JSON.stringify(type)}) — ` +
        'oneOf/anyOf/allOf/$ref ne sont pas traduits',
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
      // `integer` → `int`. `number` → `float` serait faux pour nos entiers de
      // secondes ; aucun schéma d'entrée n'utilise `number` sans `const`.
      if (type === 'number') {
        throw new SchemaNotSupported(
          path,
          'type `number` sans `const` — préciser `.int()` côté Zod plutôt que de ' +
            'laisser un flottant traverser (un timestamp fractionnaire ne veut rien dire)',
        )
      }
      return { annotation: 'int', constraints }
    }

    case 'boolean':
      return { annotation: 'bool', constraints: [] }

    case 'array': {
      const items = schema['items']
      if (typeof items !== 'object' || items === null) {
        throw new SchemaNotSupported(path, 'array sans `items`')
      }
      const inner = pyTypeOf(items as Schema, `${path}[]`, registry, `${fieldName}Item`)
      if (inner.constraints.length > 0) {
        throw new SchemaNotSupported(path, 'contraintes sur les éléments d\'un array non traduites')
      }
      return { annotation: `list[${inner.annotation}]`, constraints: [] }
    }

    case 'object': {
      // Enregistrement libre (`z.record`) : `propertyNames` sans `properties`.
      if (schema['properties'] === undefined) {
        if (schema['additionalProperties'] === undefined && schema['propertyNames'] === undefined) {
          throw new SchemaNotSupported(path, 'object sans `properties` ni `additionalProperties`')
        }
        return { annotation: 'dict[str, Any]', constraints: [] }
      }
      const model = registry.intern(fieldName, schema, path)
      return { annotation: model, constraints: [] }
    }

    default:
      throw new SchemaNotSupported(path, `type JSON Schema non supporté : ${type}`)
  }
}

/**
 * Émet une classe Pydantic pour un schéma d'objet.
 *
 * `extra="ignore"` reproduit exactement le comportement de Zod sur les clés
 * inconnues : elles sont **retirées**, pas rejetées. C'est la garantie n°2 de
 * `schemas.ts`, et c'est la seule qui tienne face à un client hostile — un
 * `category` glissé dans l'`actionSpec` n'atteint ni le Classifieur, ni
 * l'`actionHash`, parce que la valeur transmise au Gateway est l'objet nettoyé.
 * Le passer à `extra="forbid"` apprendrait au contraire à l'agent que le champ
 * existe quelque part.
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

  // Requis d'abord : Python interdit un champ sans défaut après un champ avec
  // défaut, et l'ordre de `required` n'est pas garanti par le producteur.
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
      // `default=None` en premier : `Field(None, …)` positionnel est déprécié.
      const field = `Field(default=None${args.length > 0 ? `, ${args.join(', ')}` : ''})`
      lines.push(`    ${name}: ${py.annotation} | None = ${field}`)
    }
  }

  if (names.length === 0) lines.push('    pass')
  return lines.join('\n')
}

/**
 * Point d'entrée : émet le modèle racine d'un schéma d'entrée d'outil.
 *
 * Le schéma racine n'a pas de `description` — dans la source, c'est l'outil qui
 * la porte, pas son objet d'arguments. On en pose donc une neutre, qui nomme
 * l'outil et rien de plus : recopier la description de l'outil ici la ferait
 * apparaître deux fois dans ce que voit le modèle, une fois comme description
 * d'outil et une fois comme description de schéma.
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
