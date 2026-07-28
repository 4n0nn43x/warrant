/**
 * Registre de classification d'action.
 *
 * Le registre est un **fichier versionné du dépôt**, pas une base mutable
 * (docs/13-risques.md § 5). Trois propriétés le définissent :
 *
 * 1. La clé est le **couple `(chainId, target, selector)`**, jamais le seul
 *    sélecteur. `transfer(address,uint256)` sur l'USDC du trésor et le même
 *    sélecteur sur un token sans valeur ne sont pas la même action, et un
 *    attaquant ne peut pas emprunter la politique de l'un pour l'autre.
 * 2. Son `keccak256` canonique — le `registryRef` — est engagé sous
 *    `actionHash`. Un tiers reprend la version exacte du registre qui a servi,
 *    rejoue `classify` sur le calldata onchain et vérifie la catégorie retenue.
 * 3. Ajouter une entrée est un changement de politique visible dans
 *    l'historique git, pas une opération runtime.
 */

import { readFileSync } from 'node:fs'
import { toFunctionSelector } from 'viem'
import { canonicalize } from './canonical.js'
import { hashCanonical } from './hash.js'
import type {
  Address,
  ClassificationRegistry,
  Hex,
  RegistryEntry,
} from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Forme du fichier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Une entrée telle qu'elle est écrite dans le fichier. `RegistryEntry`
 * (types.ts) en est le socle ; les champs ajoutés ici décrivent *comment*
 * dériver le notionnel et la post-condition, sans quoi le registre ne serait
 * qu'une table de noms.
 */
export interface RegistryFileEntry extends RegistryEntry {
  /**
   * Nom sous lequel le `target` lui-même est exposé dans `params` — `token`
   * pour un ERC-20, `pool` pour Aave. Le `target` est un argument implicite de
   * l'action : la politique en a besoin pour écrire ses checks, et l'exemple
   * normatif de docs/13 § 5 le fait déjà figurer dans `params`.
   */
  targetAs?: string
  /** Nom de l'argument portant le montant. Défaut : `amount`, puis `value`. */
  amountArg?: string
  /**
   * Nom de l'argument portant l'actif, quand il n'est pas le `target`
   * (cas Aave : l'actif est un paramètre, pas la cible).
   */
  assetArg?: string
  /**
   * Cette action accepte-t-elle de la valeur native ? Absent = non. Un
   * `value > 0` sur une entrée qui ne l'attend pas est un refus, pas un
   * avertissement.
   */
  allowsValue?: boolean
  label?: string
}

export interface RegistryAsset {
  symbol: string
  decimals: number
  /** Prix de référence figé, en virgule fixe 1e6 (unité atomique USDC). */
  priceUSD: string
}

export interface RegistryRouter {
  chainId: number
  target: Address
  reason: string
}

export interface RegistryRouterSelector {
  selector: Hex
  signature: string
}

/**
 * Le fichier complet. Il élargit `ClassificationRegistry` sans le contredire :
 * une `RegistryFile` reste assignable au type partagé de `types.ts`.
 */
export interface RegistryFile extends ClassificationRegistry {
  entries: RegistryFileEntry[]
  name?: string
  /** Table de prix, clé `${chainId}:${address}` en minuscules. */
  assets?: Record<string, RegistryAsset>
  /** Cibles refusées d'office : routeurs génériques, proxies opaques. */
  routers?: RegistryRouter[]
  /** Sélecteurs enveloppants refusés d'office, quelle que soit la cible. */
  routerSelectors?: RegistryRouterSelector[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalisation et empreinte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme canonique du registre : JCS RFC 8785, la **même** canonicalisation que
 * `conditionHash` et `actionHash` (docs/07 § 4). Une seconde implémentation
 * serait une seconde occasion de diverger — c'est exactement le risque R1 de
 * docs/13 § 3.
 *
 * Le `registryRef` porte donc sur le *contenu* du registre, pas sur les octets
 * du fichier : ni l'indentation ni l'ordre d'écriture des clés ne le changent,
 * et un tiers peut le recalculer sans reproduire notre formatage.
 */
export function canonicalizeRegistry(registry: ClassificationRegistry): string {
  return canonicalize(registry)
}

/** `keccak256` de la forme canonique — l'empreinte engagée sous `actionHash`. */
export function registryRefOf(registry: ClassificationRegistry): Hex {
  return hashCanonical(canonicalizeRegistry(registry))
}

// ─────────────────────────────────────────────────────────────────────────────
// Indexation
// ─────────────────────────────────────────────────────────────────────────────

/** Clé d'indexation. Le couple entier, jamais le seul sélecteur. */
export function entryKey(
  chainId: number,
  target: string,
  selector: string,
): string {
  return `${chainId}:${target.toLowerCase()}:${selector.toLowerCase()}`
}

export function assetKey(chainId: number, asset: string): string {
  return `${chainId}:${asset.toLowerCase()}`
}

export class RegistryError extends Error {
  override readonly name = 'RegistryError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * Vérifie la cohérence interne du registre. Appelée au chargement : un registre
 * incohérent doit échouer bruyamment au démarrage, jamais silencieusement à
 * l'ouverture d'un mandat.
 *
 * En particulier, chaque `selector` est **recalculé** depuis la signature ABI.
 * Un sélecteur recopié à la main et faux ferait classer une action pour une
 * autre : c'est exactement le vecteur que le registre est censé fermer.
 */
export function assertRegistryConsistent(registry: RegistryFile): void {
  if (registry.version !== 1) {
    throw new RegistryError(`version de registre non supportée: ${registry.version}`)
  }
  if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
    throw new RegistryError('registre vide')
  }

  const seen = new Set<string>()
  for (const entry of registry.entries) {
    const key = entryKey(entry.chainId, entry.target, entry.selector)
    if (seen.has(key)) {
      throw new RegistryError(`entrée dupliquée pour ${key}`)
    }
    seen.add(key)

    if (entry.target !== entry.target.toLowerCase()) {
      throw new RegistryError(`adresse non normalisée: ${entry.target}`)
    }
    if (!/^0x[0-9a-f]{40}$/.test(entry.target)) {
      throw new RegistryError(`adresse invalide: ${entry.target}`)
    }
    if (!/^0x[0-9a-f]{8}$/.test(entry.selector)) {
      throw new RegistryError(`sélecteur invalide: ${entry.selector}`)
    }

    const computed = toFunctionSelector(`function ${entry.signature}`)
    if (computed.toLowerCase() !== entry.selector.toLowerCase()) {
      throw new RegistryError(
        `sélecteur incohérent pour "${entry.signature}": ` +
          `déclaré ${entry.selector}, calculé ${computed}`,
      )
    }

    const arity = entry.signature.slice(
      entry.signature.indexOf('(') + 1,
      entry.signature.lastIndexOf(')'),
    )
    const argCount = arity.trim() === '' ? 0 : splitTopLevel(arity).length
    if (entry.argNames.length !== argCount) {
      throw new RegistryError(
        `argNames incohérents pour "${entry.signature}": ` +
          `${entry.argNames.length} noms pour ${argCount} arguments`,
      )
    }
  }

  for (const key of Object.keys(registry.assets ?? {})) {
    if (!/^[0-9]+:0x[0-9a-f]{40}$/.test(key)) {
      throw new RegistryError(`clé d'actif invalide: ${key}`)
    }
  }
  for (const router of registry.routers ?? []) {
    if (!/^0x[0-9a-f]{40}$/.test(router.target)) {
      throw new RegistryError(`adresse de routeur invalide: ${router.target}`)
    }
  }
  for (const rs of registry.routerSelectors ?? []) {
    const computed = toFunctionSelector(`function ${rs.signature}`)
    if (computed.toLowerCase() !== rs.selector.toLowerCase()) {
      throw new RegistryError(
        `sélecteur de routeur incohérent pour "${rs.signature}": ` +
          `déclaré ${rs.selector}, calculé ${computed}`,
      )
    }
  }
}

/** Découpe une liste de types ABI en respectant les tuples imbriqués. */
function splitTopLevel(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Chargement
// ─────────────────────────────────────────────────────────────────────────────

export function parseRegistry(json: string): RegistryFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new RegistryError(`registre illisible: ${(err as Error).message}`)
  }
  const registry = parsed as RegistryFile
  assertRegistryConsistent(registry)
  return registry
}

const REGISTRY_PATH = new URL('../registry/mainnet.json', import.meta.url)

let cached: RegistryFile | undefined

/**
 * Charge le registre versionné du dépôt. Mis en cache : le fichier est immuable
 * à l'exécution par construction.
 */
export function loadRegistry(): RegistryFile {
  if (!cached) {
    cached = parseRegistry(readFileSync(REGISTRY_PATH, 'utf8'))
  }
  return cached
}

/** Empreinte du registre du dépôt. */
export function mainnetRegistryRef(): Hex {
  return registryRefOf(loadRegistry())
}

// ─────────────────────────────────────────────────────────────────────────────
// Accès
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résolution par le couple `(chainId, target, selector)`.
 * Retourne `undefined` — jamais un repli par sélecteur seul.
 */
export function lookupEntry(
  registry: ClassificationRegistry,
  chainId: number,
  target: string,
  selector: string,
): RegistryFileEntry | undefined {
  const key = entryKey(chainId, target, selector)
  for (const entry of registry.entries as RegistryFileEntry[]) {
    if (entryKey(entry.chainId, entry.target, entry.selector) === key) {
      return entry
    }
  }
  return undefined
}

export function lookupAsset(
  registry: ClassificationRegistry,
  chainId: number,
  asset: string,
): RegistryAsset | undefined {
  const assets = (registry as RegistryFile).assets
  return assets?.[assetKey(chainId, asset)]
}

/** La cible est-elle un routeur générique explicitement refusé ? */
export function isRouterTarget(
  registry: ClassificationRegistry,
  chainId: number,
  target: string,
): RegistryRouter | undefined {
  const routers = (registry as RegistryFile).routers ?? []
  const wanted = target.toLowerCase()
  return routers.find(
    (r) => r.chainId === chainId && r.target.toLowerCase() === wanted,
  )
}

/**
 * Le sélecteur est-il un sélecteur enveloppant ? Vrai quelle que soit la
 * cible : la classification ne verrait qu'une enveloppe et ne pourrait rien
 * affirmer de l'effet réel.
 */
export function isRouterSelector(
  registry: ClassificationRegistry,
  selector: string,
): RegistryRouterSelector | undefined {
  const selectors = (registry as RegistryFile).routerSelectors ?? []
  const wanted = selector.toLowerCase()
  return selectors.find((s) => s.selector.toLowerCase() === wanted)
}
