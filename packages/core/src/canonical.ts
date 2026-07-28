/**
 * Canonicalisation JSON — RFC 8785 (JCS).
 *
 * Ce module est la piece la plus critique du projet : le `conditionHash` depose
 * onchain doit etre recalculable a l'octet pres par n'importe qui, en
 * TypeScript, en Python ou en Go. Une divergence de serialisation entre le
 * client et le serveur rendrait tout mandat inevaluable (docs/07 § 4).
 *
 * Regles implementees, dans l'ordre du RFC :
 *
 *  - §3.2.1 — pas d'espace de mise en forme, separateurs `,` et `:` nus.
 *  - §3.2.2.2 — echappement minimal : \b \t \n \f \r \" et l'antislash ; les
 *    autres caracteres de controle U+0000..U+001F en `\u00xx` (hexadecimal
 *    minuscule), tout le reste litteral en UTF-8. Les surrogates isoles — non
 *    representables en UTF-8 — sont echappes en `\udxxx`, comme le fait le
 *    `JSON.stringify` « well-formed » d'ECMAScript.
 *  - §3.2.2.3 — nombres serialises par `Number::toString` d'ECMAScript, avec
 *    `-0` serialise `0`.
 *  - §3.2.3 — cles d'objet triees par ordre lexicographique des **unites de
 *    code UTF-16**. C'est exactement l'ordre du comparateur `<` de JavaScript
 *    sur les chaines ; il differe de l'ordre par points de code pour les
 *    caracteres hors BMP, et c'est voulu par le RFC.
 *
 * Ce qui est refuse explicitement, plutot que silencieusement transforme comme
 * le ferait `JSON.stringify` : `undefined`, les fonctions, les symboles, `NaN`,
 * `±Infinity`, `bigint`, les objets non simples (Date, Map, Set, wrappers…) et
 * les cycles.
 */

/** Erreur de canonicalisation. Porte toujours le chemin du champ fautif. */
export class CanonicalizationError extends Error {
  /** Chemin JSONPath-like du noeud fautif, p. ex. `$.checks[0].value`. */
  readonly path: string

  constructor(message: string, path: string) {
    super(`${message} (at ${path})`)
    this.name = 'CanonicalizationError'
    this.path = path
  }
}

/**
 * Echappements courts imposes par RFC 8785 § 3.2.2.2, indexes par unite de
 * code. On indexe par code plutot que par caractere pour que la table reste
 * lisible dans le source.
 */
const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
}

function unicodeEscape(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).padStart(4, '0')}`
}

/**
 * Serialise une chaine JSON selon RFC 8785 § 3.2.2.2.
 *
 * Exporte pour les tests : c'est le point ou une divergence inter-langages est
 * la plus probable.
 */
export function serializeString(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i += 1) {
    const cu = value.charCodeAt(i)
    const short = SHORT_ESCAPES[cu]
    if (short !== undefined) {
      out += short
      continue
    }
    if (cu < 0x20) {
      out += unicodeEscape(cu)
      continue
    }
    if (cu >= 0xd800 && cu <= 0xdbff) {
      // Surrogate haut : valide seulement s'il est suivi d'un surrogate bas.
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.charAt(i) + value.charAt(i + 1)
        i += 1
        continue
      }
      out += unicodeEscape(cu)
      continue
    }
    if (cu >= 0xdc00 && cu <= 0xdfff) {
      // Surrogate bas orphelin.
      out += unicodeEscape(cu)
      continue
    }
    out += value.charAt(i)
  }
  return `${out}"`
}

/**
 * Serialise un nombre selon RFC 8785 § 3.2.2.3 : `Number::toString`
 * d'ECMAScript, a l'exception de `-0` qui doit sortir `0`.
 *
 * `String(n)` en JavaScript *est* `Number::toString` ; on ne reimplemente donc
 * pas l'algorithme de conversion, on se contente de traiter le zero negatif.
 */
export function serializeNumber(value: number, path = '$'): string {
  if (Number.isNaN(value)) {
    throw new CanonicalizationError('NaN is not representable in JSON', path)
  }
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(
      'Infinity is not representable in JSON',
      path,
    )
  }
  // Couvre 0 et -0 : RFC 8785 impose la meme serialisation pour les deux.
  if (value === 0) return '0'
  return String(value)
}

function describe(value: object): string {
  const ctor = value.constructor
  return ctor && typeof ctor.name === 'string' && ctor.name.length > 0
    ? ctor.name
    : 'object'
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function encode(value: unknown, path: string, stack: object[]): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'

    case 'number':
      return serializeNumber(value, path)

    case 'string':
      return serializeString(value)

    case 'undefined':
      throw new CanonicalizationError(
        'undefined is not a JSON value; omit the key or use null',
        path,
      )

    case 'function':
      throw new CanonicalizationError('functions are not JSON values', path)

    case 'symbol':
      throw new CanonicalizationError('symbols are not JSON values', path)

    case 'bigint':
      throw new CanonicalizationError(
        'bigint is not a JSON value; serialize large integers as decimal strings',
        path,
      )

    default:
      break
  }

  const obj = value as object
  if (stack.includes(obj)) {
    throw new CanonicalizationError('circular reference detected', path)
  }
  stack.push(obj)
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = []
      for (let i = 0; i < obj.length; i += 1) {
        parts.push(encode(obj[i], `${path}[${i}]`, stack))
      }
      return `[${parts.join(',')}]`
    }

    if (!isPlainObject(obj)) {
      throw new CanonicalizationError(
        `unsupported value of type ${describe(obj)}; only plain objects, arrays, strings, numbers, booleans and null are canonicalizable`,
        path,
      )
    }

    // RFC 8785 § 3.2.3 : tri par unites de code UTF-16. Le comparateur `<` de
    // JavaScript sur les chaines fait exactement cela.
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    const parts: string[] = []
    for (const key of keys) {
      const child = (obj as Record<string, unknown>)[key]
      parts.push(
        `${serializeString(key)}:${encode(child, `${path}.${key}`, stack)}`,
      )
    }
    return `{${parts.join(',')}}`
  } finally {
    stack.pop()
  }
}

/**
 * Canonicalise une valeur JSON selon RFC 8785 et retourne la chaine UTF-8
 * correspondante.
 *
 * @throws {CanonicalizationError} sur toute valeur non representable.
 */
export function canonicalize(value: unknown): string {
  return encode(value, '$', [])
}
