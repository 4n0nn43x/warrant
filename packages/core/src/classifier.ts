/**
 * Derivation of the action category.
 *
 * > **The category is never declared. It is derived from the calldata that will
 * > actually be executed.** (docs/13-risques.md § 5)
 *
 * No declarative field of the agent's request enters here: the only input is the
 * `ActionSpec`, that is, the transaction itself. `ActionSpec` deliberately holds
 * no category field either — an agent under prompt injection has nothing to lie
 * about.
 *
 * `classify` is pure, deterministic, LLM-free, and its fallback is **never**
 * permissive: a doubt costs the agent the maximum (`unknown` → `maxBond`) or
 * shuts the door on it (refusal at opening). A system where uncertainty drives
 * the price down is a system you attack by manufacturing uncertainty.
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
 * Grounds for refusal. Each one matches a row of the "the fallback is never
 * permissive" table of docs/13 § 5. A refusal is a rejection **at the opening**
 * of the warrant: no bond is taken, no reputation is touched.
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

/** Prices and notionals are expressed in 1e6 fixed point — the USDC atomic unit. */
export const USD_DECIMALS = 6

/**
 * Derives the category, the arguments and the notional of an action.
 *
 * @throws {ClassificationError} refusal at opening. See `ClassificationErrorCode`.
 */
export function classify(
  actionSpec: ActionSpec,
  registry: ClassificationRegistry,
): Classification {
  const registryRef = registryRefOf(registry)
  const chainId = actionSpec.chainId
  const target = actionSpec.target.toLowerCase() as Hex
  const calldata = actionSpec.calldata

  // 1. The calldata must at the very least carry a selector.
  if (typeof calldata !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(calldata)) {
    throw new ClassificationError(
      'MALFORMED_CALLDATA',
      `non-hexadecimal calldata: ${String(calldata)}`,
    )
  }
  if (calldata.length < 10) {
    throw new ClassificationError(
      'CALLDATA_TOO_SHORT',
      `calldata of ${(calldata.length - 2) / 2} byte(s): ` +
        'no selector, hence nothing to classify',
    )
  }

  const selector = calldata.slice(0, 10).toLowerCase() as Hex
  const value = parseValue(actionSpec.value)

  // 2. Generic routers: refused before any attempt at classification.
  //    Classification would only see a wrapping selector; it can assert nothing
  //    about the real effect, so it asserts nothing.
  const router = isRouterTarget(registry, chainId, target)
  if (router) {
    throw new ClassificationError(
      'GENERIC_ROUTER',
      `target ${target} refused (chainId ${chainId}): ${router.reason}`,
    )
  }
  const wrapping = isRouterSelector(registry, selector)
  if (wrapping) {
    throw new ClassificationError(
      'GENERIC_ROUTER',
      `wrapping selector ${selector} (${wrapping.signature}): ` +
        'the real effect is not classifiable',
    )
  }

  // 3. Resolution by the (chainId, target, selector) tuple. Never by the
  //    selector alone: that is what prevents borrowing one token's policy for
  //    another.
  const entry = lookupEntry(registry, chainId, target, selector)

  if (!entry) {
    // Tuple absent → `unknown`. The pricer will charge `maxBond`.
    if (value > 0n) {
      throw new ClassificationError(
        'UNEXPECTED_VALUE',
        `value=${actionSpec.value} on an unclassified action: refused`,
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

  // 4. The registry is a trust surface: we re-verify that it tells the truth
  //    rather than taking its word for it.
  let expectedSelector: Hex
  try {
    expectedSelector = toFunctionSelector(`function ${entry.signature}`)
  } catch (err) {
    throw new ClassificationError(
      'REGISTRY_INCONSISTENT',
      `unreadable signature "${entry.signature}": ${(err as Error).message}`,
    )
  }
  if (expectedSelector.toLowerCase() !== selector) {
    throw new ClassificationError(
      'REGISTRY_INCONSISTENT',
      `inconsistent registry entry for ${selector}: ` +
        `"${entry.signature}" yields ${expectedSelector}`,
    )
  }

  // 5. Unexpected native value → refused.
  if (value > 0n && entry.allowsValue !== true) {
    throw new ClassificationError(
      'UNEXPECTED_VALUE',
      `value=${actionSpec.value} on category ${entry.category}, ` +
        'which does not expect it: refused',
    )
  }

  // 6. ABI decoding. A failure is a refusal, not a fallback.
  const params = decodeParams(entry, calldata)

  // 7. The `target` is an implicit argument of the action: the policy needs it
  //    to write its checks (docs/13 § 5 already lists it in `params` under the
  //    name `token`).
  if (entry.targetAs) params[entry.targetAs] = target
  params['chainId'] = String(chainId)

  // 8. Notional derived from the decoded arguments, never from a request field.
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
    if (parsed < 0n) throw new Error('negative')
    return parsed
  } catch {
    throw new ClassificationError(
      'MALFORMED_CALLDATA',
      `invalid value: ${String(value)}`,
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
    // The signature is only known at runtime: the literal typing of `parseAbi`
    // does not apply, hence the deliberate widening.
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
      `ABI decoding failed for "${entry.signature}": ` +
        `${(err as Error).message}`,
    )
  }

  // The decoder ignores surplus bytes: re-encoding and comparing is the only way
  // to assert that the **whole** calldata is indeed the one the signature
  // describes. A non-canonical calldata — padding, extra arguments — is a
  // refusal: what is not understood in full is not classified.
  if (reencoded.toLowerCase() !== calldata.toLowerCase()) {
    throw new ClassificationError(
      'DECODE_FAILED',
      `non-canonical calldata for "${entry.signature}": ` +
        're-encoding the decoded arguments does not reproduce the calldata',
    )
  }

  if (decoded.length !== entry.argNames.length) {
    throw new ClassificationError(
      'DECODE_FAILED',
      `unexpected arity for "${entry.signature}": ` +
        `${decoded.length} decoded argument(s) for ` +
        `${entry.argNames.length} name(s)`,
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
    `non-representable argument: ${typeof arg}`,
  )
}

/**
 * `notionalUSD = amount × price / 10^decimals`, in `bigint`, in 1e6 fixed
 * point. Never a float: a bond is an amount, not an estimate.
 *
 * The price comes from the **registry** (frozen, versioned, hashed). There is no
 * oracle in v1, and above all: nothing that enters here comes from the agent's
 * request — only the decoded arguments and the registry.
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
      `amount argument "${amountArg}" absent for ${entry.category}`,
    )
  }

  let amount: bigint
  try {
    amount = BigInt(raw)
  } catch {
    throw new ClassificationError(
      'DECODE_FAILED',
      `non-integer amount: ${raw}`,
    )
  }
  if (amount < 0n) {
    throw new ClassificationError('DECODE_FAILED', `negative amount: ${raw}`)
  }

  let decimals: number
  let priceUSD: bigint

  if (entry.assetArg) {
    // The asset is an argument (the Aave case): its price is read from the
    // registry's table. An asset absent from the table is **irrecoverably**
    // unpriceable — and an unpriceable notional cannot be allowed to become
    // zero, which would amount to handing the floor bond to whoever brings an
    // exotic asset. So it is a refusal.
    const asset = params[entry.assetArg]
    if (asset === undefined) {
      throw new ClassificationError(
        'REGISTRY_INCONSISTENT',
        `asset argument "${entry.assetArg}" absent for ${entry.category}`,
      )
    }
    const known = lookupAsset(registry, chainId, asset)
    if (!known) {
      throw new ClassificationError(
        'UNPRICEABLE_ASSET',
        `asset ${asset} (chainId ${chainId}) absent from the registry's price ` +
          'table: notional not derivable, refused at opening',
      )
    }
    decimals = known.decimals
    priceUSD = BigInt(known.priceUSD)
  } else {
    if (entry.assetDecimals === undefined || entry.assetPriceUSD === undefined) {
      throw new ClassificationError(
        'UNPRICEABLE_ASSET',
        `entry ${entry.category} has no reference price: ` +
          'notional not derivable, refused at opening',
      )
    }
    decimals = entry.assetDecimals
    priceUSD = BigInt(entry.assetPriceUSD)
  }

  const notional = (amount * priceUSD) / 10n ** BigInt(decimals)
  return notional.toString(10)
}
