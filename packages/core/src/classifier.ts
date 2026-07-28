/**
 * Dérivation de la catégorie d'action.
 *
 * > **La catégorie n'est jamais déclarée. Elle est dérivée du calldata qui sera
 * > réellement exécuté.** (docs/13-risques.md § 5)
 *
 * Aucun champ déclaratif de la requête de l'agent n'entre ici : le seul intrant
 * est l'`ActionSpec`, c'est-à-dire la transaction elle-même. `ActionSpec` ne
 * contient d'ailleurs volontairement aucun champ de catégorie — un agent sous
 * prompt injection n'a rien à mentir.
 *
 * `classify` est pure, déterministe, sans LLM, et son repli n'est **jamais**
 * permissif : un doute coûte le maximum à l'agent (`unknown` → `maxBond`) ou
 * lui ferme la porte (refus à l'ouverture). Un système où l'incertitude fait
 * baisser le prix est un système qu'on attaque en créant de l'incertitude.
 */

import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Abi,
} from 'viem'
import {
  isRouterSelector,
  isRouterTarget,
  lookupAsset,
  lookupEntry,
  registryRefOf,
  type RegistryFileEntry,
} from './registry.js'
import type {
  ActionSpec,
  Classification,
  ClassificationRegistry,
  Hex,
} from './types.js'

/**
 * Motifs de refus. Chacun correspond à une ligne du tableau « le repli n'est
 * jamais permissif » de docs/13 § 5. Un refus est un rejet **à l'ouverture** du
 * mandat : aucune caution n'est prise, aucune réputation n'est touchée.
 */
export type ClassificationErrorCode =
  | 'CALLDATA_TOO_SHORT'
  | 'MALFORMED_CALLDATA'
  | 'GENERIC_ROUTER'
  | 'DECODE_FAILED'
  | 'UNEXPECTED_VALUE'
  | 'UNPRICEABLE_ASSET'
  | 'REGISTRY_INCONSISTENT'

export class ClassificationError extends Error {
  override readonly name = 'ClassificationError'
  readonly code: ClassificationErrorCode
  constructor(code: ClassificationErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Prix et notionnel sont exprimés en virgule fixe 1e6 — unité atomique USDC. */
export const USD_DECIMALS = 6

/**
 * Dérive la catégorie, les arguments et le notionnel d'une action.
 *
 * @throws {ClassificationError} refus à l'ouverture. Voir `ClassificationErrorCode`.
 */
export function classify(
  actionSpec: ActionSpec,
  registry: ClassificationRegistry,
): Classification {
  const registryRef = registryRefOf(registry)
  const chainId = actionSpec.chainId
  const target = actionSpec.target.toLowerCase() as Hex
  const calldata = actionSpec.calldata

  // 1. Le calldata doit au minimum porter un sélecteur.
  if (typeof calldata !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(calldata)) {
    throw new ClassificationError(
      'MALFORMED_CALLDATA',
      `calldata non hexadécimal: ${String(calldata)}`,
    )
  }
  if (calldata.length < 10) {
    throw new ClassificationError(
      'CALLDATA_TOO_SHORT',
      `calldata de ${(calldata.length - 2) / 2} octet(s) : ` +
        'pas de sélecteur, donc rien à classifier',
    )
  }

  const selector = calldata.slice(0, 10).toLowerCase() as Hex
  const value = parseValue(actionSpec.value)

  // 2. Routeurs génériques : refus avant toute tentative de classification.
  //    La classification ne verrait qu'un sélecteur enveloppant ; elle ne peut
  //    rien affirmer de l'effet réel, donc elle n'affirme rien.
  const router = isRouterTarget(registry, chainId, target)
  if (router) {
    throw new ClassificationError(
      'GENERIC_ROUTER',
      `cible ${target} refusée (chainId ${chainId}) : ${router.reason}`,
    )
  }
  const wrapping = isRouterSelector(registry, selector)
  if (wrapping) {
    throw new ClassificationError(
      'GENERIC_ROUTER',
      `sélecteur enveloppant ${selector} (${wrapping.signature}) : ` +
        "l'effet réel n'est pas classifiable",
    )
  }

  // 3. Résolution par le couple (chainId, target, selector). Jamais par le
  //    seul sélecteur : c'est ce qui empêche d'emprunter la politique d'un
  //    token pour un autre.
  const entry = lookupEntry(registry, chainId, target, selector)

  if (!entry) {
    // Couple absent → `unknown`. Le pricer facturera `maxBond`.
    if (value > 0n) {
      throw new ClassificationError(
        'UNEXPECTED_VALUE',
        `value=${actionSpec.value} sur une action non classifiée : refus`,
      )
    }
    return {
      category: 'unknown',
      params: {
        chainId: String(chainId),
        target,
        selector,
      },
      notionalUSD: '0',
      registryRef,
    }
  }

  // 4. Le registre est une surface de confiance : on revérifie qu'il dit vrai
  //    plutôt que de le croire sur parole.
  let expectedSelector: Hex
  try {
    expectedSelector = toFunctionSelector(`function ${entry.signature}`)
  } catch (err) {
    throw new ClassificationError(
      'REGISTRY_INCONSISTENT',
      `signature illisible "${entry.signature}": ${(err as Error).message}`,
    )
  }
  if (expectedSelector.toLowerCase() !== selector) {
    throw new ClassificationError(
      'REGISTRY_INCONSISTENT',
      `entrée de registre incohérente pour ${selector} : ` +
        `"${entry.signature}" produit ${expectedSelector}`,
    )
  }

  // 5. Valeur native non attendue → refus.
  if (value > 0n && entry.allowsValue !== true) {
    throw new ClassificationError(
      'UNEXPECTED_VALUE',
      `value=${actionSpec.value} sur la catégorie ${entry.category}, ` +
        'qui ne l\'attend pas : refus',
    )
  }

  // 6. Décodage ABI. Un échec est un refus, pas un repli.
  const params = decodeParams(entry, calldata)

  // 7. Le `target` est un argument implicite de l'action : la politique en a
  //    besoin pour écrire ses checks (docs/13 § 5 le fait déjà figurer dans
  //    `params` sous le nom `token`).
  if (entry.targetAs) params[entry.targetAs] = target
  params['chainId'] = String(chainId)

  // 8. Notionnel dérivé des arguments décodés, jamais d'un champ de la requête.
  const notionalUSD = deriveNotional(entry, params, registry, chainId)

  return {
    category: entry.category,
    params,
    notionalUSD,
    registryRef,
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function parseValue(value: string): bigint {
  try {
    const parsed = BigInt(value)
    if (parsed < 0n) throw new Error('négative')
    return parsed
  } catch {
    throw new ClassificationError(
      'MALFORMED_CALLDATA',
      `value invalide: ${String(value)}`,
    )
  }
}

function decodeParams(
  entry: RegistryFileEntry,
  calldata: Hex,
): Record<string, string> {
  let decoded: readonly unknown[]
  let reencoded: string
  try {
    // La signature n'est connue qu'à l'exécution : le typage littéral de
    // `parseAbi` ne s'applique pas, d'où l'élargissement volontaire.
    const abi = parseAbi([`function ${entry.signature}`] as string[]) as Abi
    const result = decodeFunctionData({ abi, data: calldata })
    decoded = (result.args ?? []) as readonly unknown[]
    reencoded = encodeFunctionData({
      abi,
      functionName: result.functionName,
      args: result.args,
    } as Parameters<typeof encodeFunctionData>[0])
  } catch (err) {
    throw new ClassificationError(
      'DECODE_FAILED',
      `décodage ABI en échec pour "${entry.signature}": ` +
        `${(err as Error).message}`,
    )
  }

  // Le décodeur ignore les octets surnuméraires : ré-encoder et comparer est le
  // seul moyen d'affirmer que le calldata **entier** est bien celui que la
  // signature décrit. Un calldata non canonique — remplissage, arguments en
  // trop — est un refus : ce qui n'est pas intégralement compris n'est pas
  // classifié.
  if (reencoded.toLowerCase() !== calldata.toLowerCase()) {
    throw new ClassificationError(
      'DECODE_FAILED',
      `calldata non canonique pour "${entry.signature}" : ` +
        'le ré-encodage des arguments décodés ne reproduit pas le calldata',
    )
  }

  if (decoded.length !== entry.argNames.length) {
    throw new ClassificationError(
      'DECODE_FAILED',
      `arité inattendue pour "${entry.signature}": ` +
        `${decoded.length} argument(s) décodé(s) pour ` +
        `${entry.argNames.length} nom(s)`,
    )
  }

  const params: Record<string, string> = {}
  entry.argNames.forEach((name, i) => {
    params[name] = stringifyArg(decoded[i])
  })
  return params
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'bigint') return arg.toString(10)
  if (typeof arg === 'number') return String(arg)
  if (typeof arg === 'boolean') return arg ? 'true' : 'false'
  if (typeof arg === 'string') {
    return arg.startsWith('0x') ? arg.toLowerCase() : arg
  }
  if (Array.isArray(arg)) return JSON.stringify(arg.map(stringifyArg))
  throw new ClassificationError(
    'DECODE_FAILED',
    `argument non représentable: ${typeof arg}`,
  )
}

/**
 * `notionalUSD = amount × prix / 10^decimals`, en `bigint`, en virgule fixe
 * 1e6. Jamais de flottant : une caution est un montant, pas une estimation.
 *
 * Le prix vient du **registre** (figé, versionné, hashé). Il n'y a pas d'oracle
 * en v1, et surtout : rien de ce qui entre ici ne vient de la requête de
 * l'agent — seulement des arguments décodés et du registre.
 */
function deriveNotional(
  entry: RegistryFileEntry,
  params: Record<string, string>,
  registry: ClassificationRegistry,
  chainId: number,
): string {
  const amountArg =
    entry.amountArg ??
    (params['amount'] !== undefined ? 'amount' : 'value')
  const raw = params[amountArg]
  if (raw === undefined) {
    throw new ClassificationError(
      'REGISTRY_INCONSISTENT',
      `argument de montant "${amountArg}" absent pour ${entry.category}`,
    )
  }

  let amount: bigint
  try {
    amount = BigInt(raw)
  } catch {
    throw new ClassificationError(
      'DECODE_FAILED',
      `montant non entier: ${raw}`,
    )
  }
  if (amount < 0n) {
    throw new ClassificationError('DECODE_FAILED', `montant négatif: ${raw}`)
  }

  let decimals: number
  let priceUSD: bigint

  if (entry.assetArg) {
    // L'actif est un argument (cas Aave) : son prix se lit dans la table du
    // registre. Un actif absent de la table est **irrécusablement** non
    // tarifable — et un notionnel non tarifable ne peut pas devenir zéro, ce
    // qui reviendrait à offrir la caution plancher à qui apporte un actif
    // exotique. C'est donc un refus.
    const asset = params[entry.assetArg]
    if (asset === undefined) {
      throw new ClassificationError(
        'REGISTRY_INCONSISTENT',
        `argument d'actif "${entry.assetArg}" absent pour ${entry.category}`,
      )
    }
    const known = lookupAsset(registry, chainId, asset)
    if (!known) {
      throw new ClassificationError(
        'UNPRICEABLE_ASSET',
        `actif ${asset} (chainId ${chainId}) absent de la table de prix du ` +
          'registre : notionnel non dérivable, refus à l\'ouverture',
      )
    }
    decimals = known.decimals
    priceUSD = BigInt(known.priceUSD)
  } else {
    if (entry.assetDecimals === undefined || entry.assetPriceUSD === undefined) {
      throw new ClassificationError(
        'UNPRICEABLE_ASSET',
        `entrée ${entry.category} sans prix de référence : ` +
          'notionnel non dérivable, refus à l\'ouverture',
      )
    }
    decimals = entry.assetDecimals
    priceUSD = BigInt(entry.assetPriceUSD)
  }

  const notional = (amount * priceUSD) / 10n ** BigInt(decimals)
  return notional.toString(10)
}
