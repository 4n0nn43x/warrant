/**
 * Action classification registry.
 *
 * The registry is a **version-controlled file in the repo**, not a mutable
 * database (docs/13-risques.md § 5). Three properties define it:
 *
 * 1. The key is the **tuple `(chainId, target, selector)`**, never the selector
 *    alone. `transfer(address,uint256)` on the treasury's USDC and the same
 *    selector on a worthless token are not the same action, and an attacker
 *    cannot borrow the policy of one for the other.
 * 2. Its canonical `keccak256` — the `registryRef` — is committed under
 *    `actionHash`. A third party takes the exact registry version that was
 *    used, replays `classify` on the onchain calldata and checks the category
 *    that was retained.
 * 3. Adding an entry is a policy change visible in the git history, not a
 *    runtime operation.
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
// File shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An entry as it is written in the file. `RegistryEntry` (types.ts) is its
 * foundation; the fields added here describe *how* to derive the notional and
 * the post-condition, without which the registry would be nothing but a table
 * of names.
 */
export interface RegistryFileEntry extends RegistryEntry {
  /**
   * Name under which the `target` itself is exposed in `params` — `token` for
   * an ERC-20, `pool` for Aave. The `target` is an implicit argument of the
   * action: the policy needs it to write its checks, and the normative example
   * of docs/13 § 5 already lists it in `params`.
   */
  targetAs?: string
  /** Name of the argument carrying the amount. Default: `amount`, then `value`. */
  amountArg?: string
  /**
   * Name of the argument carrying the asset, when it is not the `target`
   * (the Aave case: the asset is a parameter, not the target).
   */
  assetArg?: string
  /**
   * Does this action accept native value? Absent = no. A `value > 0` on an
   * entry that does not expect it is a refusal, not a warning.
   */
  allowsValue?: boolean
  label?: string
}

export interface RegistryAsset {
  symbol: string
  decimals: number
  /** Frozen reference price, in 1e6 fixed point (USDC atomic unit). */
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
 * The complete file. It widens `ClassificationRegistry` without contradicting
 * it: a `RegistryFile` stays assignable to the shared type of `types.ts`.
 */
export interface RegistryFile extends ClassificationRegistry {
  entries: RegistryFileEntry[]
  name?: string
  /** Price table, keyed by `${chainId}:${address}` in lowercase. */
  assets?: Record<string, RegistryAsset>
  /** Targets refused outright: generic routers, opaque proxies. */
  routers?: RegistryRouter[]
  /** Wrapping selectors refused outright, whatever the target. */
  routerSelectors?: RegistryRouterSelector[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization and fingerprint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical form of the registry: JCS RFC 8785, the **same** canonicalization
 * as `conditionHash` and `actionHash` (docs/07 § 4). A second implementation
 * would be a second opportunity to diverge — that is exactly risk R1 of
 * docs/13 § 3.
 *
 * The `registryRef` therefore bears on the *content* of the registry, not on
 * the bytes of the file: neither the indentation nor the order in which the
 * keys are written changes it, and a third party can recompute it without
 * reproducing our formatting.
 */
export function canonicalizeRegistry(registry: ClassificationRegistry): string {
  return canonicalize(registry)
}

/** `keccak256` of the canonical form — the fingerprint committed under `actionHash`. */
export function registryRefOf(registry: ClassificationRegistry): Hex {
  return hashCanonical(canonicalizeRegistry(registry))
}

// ─────────────────────────────────────────────────────────────────────────────
// Indexing
// ─────────────────────────────────────────────────────────────────────────────

/** Index key. The whole tuple, never the selector alone. */
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
 * Checks the internal consistency of the registry. Called at load time: an
 * inconsistent registry must fail loudly at startup, never silently when a
 * warrant is opened.
 *
 * In particular, every `selector` is **recomputed** from the ABI signature. A
 * selector copied by hand and wrong would classify one action as another: that
 * is exactly the vector the registry is meant to close.
 */
export function assertRegistryConsistent(registry: RegistryFile): void {
  if (registry.version !== 1) {
    throw new RegistryError(`unsupported registry version: ${registry.version}`)
  }
  if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
    throw new RegistryError('empty registry')
  }

  const seen = new Set<string>()
  for (const entry of registry.entries) {
    const key = entryKey(entry.chainId, entry.target, entry.selector)
    if (seen.has(key)) {
      throw new RegistryError(`duplicate entry for ${key}`)
    }
    seen.add(key)

    if (entry.target !== entry.target.toLowerCase()) {
      throw new RegistryError(`address is not normalized: ${entry.target}`)
    }
    if (!/^0x[0-9a-f]{40}$/.test(entry.target)) {
      throw new RegistryError(`invalid address: ${entry.target}`)
    }
    if (!/^0x[0-9a-f]{8}$/.test(entry.selector)) {
      throw new RegistryError(`invalid selector: ${entry.selector}`)
    }

    const computed = toFunctionSelector(`function ${entry.signature}`)
    if (computed.toLowerCase() !== entry.selector.toLowerCase()) {
      throw new RegistryError(
        `inconsistent selector for "${entry.signature}": ` +
          `declared ${entry.selector}, computed ${computed}`,
      )
    }

    const arity = entry.signature.slice(
      entry.signature.indexOf('(') + 1,
      entry.signature.lastIndexOf(')'),
    )
    const argCount = arity.trim() === '' ? 0 : splitTopLevel(arity).length
    if (entry.argNames.length !== argCount) {
      throw new RegistryError(
        `inconsistent argNames for "${entry.signature}": ` +
          `${entry.argNames.length} names for ${argCount} arguments`,
      )
    }
  }

  for (const key of Object.keys(registry.assets ?? {})) {
    if (!/^[0-9]+:0x[0-9a-f]{40}$/.test(key)) {
      throw new RegistryError(`invalid asset key: ${key}`)
    }
  }
  for (const router of registry.routers ?? []) {
    if (!/^0x[0-9a-f]{40}$/.test(router.target)) {
      throw new RegistryError(`invalid router address: ${router.target}`)
    }
  }
  for (const rs of registry.routerSelectors ?? []) {
    const computed = toFunctionSelector(`function ${rs.signature}`)
    if (computed.toLowerCase() !== rs.selector.toLowerCase()) {
      throw new RegistryError(
        `inconsistent router selector for "${rs.signature}": ` +
          `declared ${rs.selector}, computed ${computed}`,
      )
    }
  }
}

/** Splits a list of ABI types, honouring nested tuples. */
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
// Loading
// ─────────────────────────────────────────────────────────────────────────────

export function parseRegistry(json: string): RegistryFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new RegistryError(`unreadable registry: ${(err as Error).message}`)
  }
  const registry = parsed as RegistryFile
  assertRegistryConsistent(registry)
  return registry
}

const REGISTRY_PATH = new URL('../registry/mainnet.json', import.meta.url)

let cached: RegistryFile | undefined

/**
 * Loads the version-controlled registry of the repo. Cached: the file is
 * immutable at runtime by construction.
 */
export function loadRegistry(): RegistryFile {
  if (!cached) {
    cached = parseRegistry(readFileSync(REGISTRY_PATH, 'utf8'))
  }
  return cached
}

/** Fingerprint of the repo's registry. */
export function mainnetRegistryRef(): Hex {
  return registryRefOf(loadRegistry())
}

// ─────────────────────────────────────────────────────────────────────────────
// Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolution by the `(chainId, target, selector)` tuple.
 * Returns `undefined` — never a fallback on the selector alone.
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

/** Is the target a generic router that is explicitly refused? */
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
 * Is the selector a wrapping selector? True whatever the target:
 * classification would only see a wrapper and could assert nothing about the
 * real effect.
 */
export function isRouterSelector(
  registry: ClassificationRegistry,
  selector: string,
): RegistryRouterSelector | undefined {
  const selectors = (registry as RegistryFile).routerSelectors ?? []
  const wanted = selector.toLowerCase()
  return selectors.find((s) => s.selector.toLowerCase() === wanted)
}
