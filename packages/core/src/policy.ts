/**
 * Generation of the post-condition from the capital owner's policy.
 *
 * > "The policy generates the post-condition; the agent does not propose it."
 * > (docs/13-risques.md § 5)
 *
 * Once the category has been **derived** from the calldata, the policy produces
 * the `conditionSpec` by injecting **its own** parameters into it. The point
 * that closes the attack vector: `allowedDest` comes from the policy's
 * allowlist, not from the calldata. A diverted transfer therefore commits to a
 * destination that is not the attacker's — the commitment fails, the bond is
 * slashed, and the capital owner is made whole.
 *
 * ## Three construction rules, learned at audit
 *
 * 1. **A hole in the policy is a refusal to open, never a permissive
 *    post-condition.** A missing parameter throws `PolicyError`; it does not
 *    silently make the check that depends on it disappear. A warrant opened on
 *    an amputated post-condition would be worse than no warrant at all: it
 *    returns the bond, improves the reputation, and certifies a diversion as
 *    compliant.
 * 2. **Commit only to checks ATTRIBUTABLE to the transaction** — the logs and
 *    receipt of the committed action. Never a shared absolute state (a balance
 *    read at end of block) that a third party can move after the fact: it would
 *    make the verdict depend on something other than the agent's work, in both
 *    directions (a slash manufactured by the beneficiary, or compliance
 *    manufactured by an outside deposit). The one exception we accept:
 *    `aave_health_factor`, the normative protection invariant of docs/07 § 2.5,
 *    which a position post-condition cannot express any other way.
 * 3. **A default post-condition contains only checks that are decidable in the
 *    project's real execution mode** — sponsored execution by KeeperHub. A check
 *    that throws `UnsupportedCheckError` does not return `false`: it lets the
 *    warrant expire into `reclaim`. So it is not a guarantee, it is an automatic
 *    refund in disguise. See the docstrings of
 *    `packages/server/src/checks/nonce.ts` and `.../native.ts`.
 */

import {
  DEFAULT_CONFIRMATIONS,
  MAX_CHECKS,
  type Address,
  type Check,
  type Classification,
  type ConditionSpec,
  type EvaluateAt,
  type Hex,
  type Policy,
} from './types.js'

/**
 * Policy fields that `types.ts` does not model yet. Read defensively: their
 * absence yields the strictest value, never the most permissive one.
 */
export interface CategoryPolicyExtras {
  /** Aave health factor threshold, in 1e18. Default: `DEFAULT_MIN_HEALTH_FACTOR`. */
  minHealthFactor?: string
}

export interface PolicyExtras {
  /** Tokens watched by `no_new_approvals` on unclassified actions. */
  watchedTokens?: Address[]
  /**
   * Declares that the action originates from the execution wallet itself, with
   * no relayer and no forwarder. **False by default**, and that is deliberate.
   *
   * Under sponsored execution — the project's real mode — the transaction is
   * submitted by the KeeperHub relayer: the nonce of the watched account does
   * not advance, and `checks/nonce.ts` throws `UnsupportedCheckError` (see its
   * docstring, which concludes: "this check must not appear in default
   * post-conditions as long as sponsoring is active"). A check that always
   * throws lets the warrant expire into `reclaim`: the bond can never be
   * slashed, and the post-condition is no longer a commitment.
   *
   * This flag is therefore only to be turned on by a capital owner who knows
   * that their executions are not sponsored.
   */
  unsponsoredExecution?: boolean
}

export interface BuildConditionOptions {
  /** Evaluation chain. Default: `classification.params.chainId`. */
  chainId?: number
  evaluateAt?: EvaluateAt
  confirmations?: number
  /**
   * Account whose nonce must advance. Default: the treasury. The Gateway passes
   * the address of the KeeperHub execution wallet here when it knows it.
   */
  executor?: Address
  /**
   * `actionHash` of the committed `ActionSpec`. When supplied, it unconditionally
   * adds the `calldata_matches_commitment` check (out of the `MAX_CHECKS` quota).
   */
  actionHash?: Hex
}

/** Default minimum health factor: 1.5 in 1e18 (docs/07 § 2.5). */
export const DEFAULT_MIN_HEALTH_FACTOR = '1500000000000000000'

export class PolicyError extends Error {
  override readonly name = 'PolicyError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * Builds the committed `conditionSpec` for a given classification.
 *
 * @throws {PolicyError} if the policy is incomplete for this category — an
 * incomplete policy is a refusal, not an empty post-condition.
 */
export function buildConditionSpec(
  classification: Classification,
  policy: Policy,
  opts: BuildConditionOptions = {},
): ConditionSpec {
  const chainId = opts.chainId ?? Number(classification.params['chainId'])
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new PolicyError(
      'undetermined chainId: neither supplied as an option nor present in the classification',
    )
  }

  const treasury = requireAddress(policy.treasury, 'policy.treasury')
  const category = classification.category
  const executor = opts.executor
    ? requireAddress(opts.executor, 'opts.executor')
    : treasury

  // Account whose nonce is committed, or `undefined` — the default case, which
  // removes `nonce_advanced` from the post-condition. See
  // `PolicyExtras.unsponsoredExecution`: under sponsoring this check is
  // undecidable and turns the post-condition into an automatic refund.
  const nonceAccount = (policy as PolicyExtras).unsponsoredExecution
    ? executor
    : undefined

  let checks: Check[]
  switch (category) {
    case 'erc20.transfer':
      checks = transferChecks(classification, policy, treasury)
      break
    case 'erc20.approve':
      checks = approveChecks(classification, policy, treasury)
      break
    case 'aavev3.repay':
    case 'aavev3.supply':
    case 'aavev3.withdraw':
    case 'aavev3.borrow':
      checks = aaveChecks(classification, policy, treasury, nonceAccount)
      break
    case 'unknown':
      checks = unknownChecks(classification, policy, treasury, nonceAccount)
      break
    default: {
      // Exhaustiveness: a category added without an associated policy must break
      // at compile time, not produce an empty post-condition.
      const never: never = category
      throw new PolicyError(`category without a policy: ${String(never)}`)
    }
  }

  if (checks.length === 0) {
    throw new PolicyError(
      `empty policy for ${category}: a post-condition with no check would not ` +
        'be a commitment',
    )
  }
  if (checks.length > MAX_CHECKS) {
    throw new PolicyError(
      `${checks.length} checks for ${category}, maximum ${MAX_CHECKS}`,
    )
  }

  // Out of quota, not removable (docs/07 § 2.10): what is committed to must be
  // what is executed.
  if (opts.actionHash) {
    checks = [
      ...checks,
      { kind: 'calldata_matches_commitment', actionHash: opts.actionHash },
    ]
  }

  return {
    version: 1,
    chainId,
    evaluateAt: opts.evaluateAt ?? 'tx',
    confirmations: opts.confirmations ?? defaultConfirmations(chainId),
    checks,
  }
}

/**
 * Default confirmations. Not exported: `hash.ts` already exposes the public
 * function of the same name, and two same-named exports in the `index.ts` barrel
 * would collide.
 */
function defaultConfirmations(chainId: number): number {
  return chainId === 1 ? DEFAULT_CONFIRMATIONS.l1 : DEFAULT_CONFIRMATIONS.l2
}

// ─────────────────────────────────────────────────────────────────────────────
// erc20.transfer — the normative example of docs/13 § 5
// ─────────────────────────────────────────────────────────────────────────────

function transferChecks(
  classification: Classification,
  policy: Policy,
  treasury: Address,
): Check[] {
  const cat = policy.categories['erc20.transfer']
  if (!cat) {
    throw new PolicyError('no policy for erc20.transfer')
  }
  const token = requireAddress(
    classification.params['token'],
    'classification.params.token',
  )
  const amount = requireUint(classification.params['amount'], 'amount')

  if (cat.maxOutflow === undefined) {
    throw new PolicyError(
      'erc20.transfer without maxOutflow: the outflow bound must come from the ' +
        'policy, it cannot be inferred from the calldata',
    )
  }
  const maxOutflow = requireUint(cat.maxOutflow, 'maxOutflow')
  // The counterpart of `maxOutflow`: with no allowlist there is no destination to
  // commit to, hence nothing left to tell a payroll transfer from a diverted one
  // (docs/13 § 6, Adversary 1). We refuse to open.
  const allowedDest = requireAllowedDest(cat.allowedDest, 'erc20.transfer')

  const checks: Check[] = [
    // The POLICY's bound, not the calldata's.
    {
      kind: 'erc20_balance_delta',
      token,
      account: treasury,
      op: 'gte',
      // `maxOutflow: '0'` — "no outflow tolerated", the strictest policy and the
      // Gateway's default — would yield `-0`, which is not a canonical decimal:
      // the ConditionSpec produced is then refused by its own validation, and
      // *every* quotation of a classified `erc20.transfer` fails with a 400.
      // RFC 8785 mandates the same serialization for `0` and `-0` anyway (see
      // canonical.ts); `-0` would therefore not have survived the hashing of the
      // condition either.
      value: maxOutflow === 0n ? '0' : `-${maxOutflow.toString(10)}`,
    },
  ]

  // The destination comes from the ALLOWLIST. If the calldata names an allowed
  // destination, that is the one committed to; otherwise we commit to the
  // policy's canonical destination — and the diverted transfer fails by
  // construction, since the funds will never arrive there.
  const dest = resolveDest(allowedDest, classification.params['to'])

  // Only the DELTA is committed to, never `erc20_balance(dest)`.
  //
  // An absolute balance read at `evaluateAt` is the one post-condition outcome
  // that depends on something other than the agent's transaction: it is enough
  // for `dest` — an allowlist address, hence controlled by the capital owner, or
  // a hot wallet sweeping into cold storage — to spend its funds later in the
  // same block for `balanceOf(dest) >= amount` to fail and manufacture the
  // slash, while the twin delta proves, in the very same verdict, that the agent
  // did exactly what was committed. The delta strictly dominates the absolute:
  // it only passes if the funds really did arrive, and it is derived from the
  // transaction's `Transfer` logs alone.
  checks.push({
    kind: 'erc20_balance_delta',
    token,
    account: dest,
    // Self-transfer: when the committed destination is the treasury itself, the
    // funds do not move (`from === to`, the delta cancels out in the logs).
    // Requiring `>= amount` would slash a legitimate transfer; `>= 0` remains
    // binding, since a diverted transfer would take `-amount` out of the
    // treasury.
    op: 'gte',
    value: dest === treasury ? '0' : amount.toString(10),
  })

  checks.push({ kind: 'no_new_approvals', owner: treasury, tokens: [token] })
  return checks
}

// ─────────────────────────────────────────────────────────────────────────────
// erc20.approve
// ─────────────────────────────────────────────────────────────────────────────

function approveChecks(
  classification: Classification,
  policy: Policy,
  treasury: Address,
): Check[] {
  const cat = policy.categories['erc20.approve']
  if (!cat) {
    throw new PolicyError('no policy for erc20.approve')
  }
  const token = requireAddress(
    classification.params['token'],
    'classification.params.token',
  )
  const spender = requireAddress(
    classification.params['spender'],
    'classification.params.spender',
  )

  // An approval is a deferred outflow: with no spender allowlist there is nobody
  // to deny an allowance to, and `allowlisted` would be true for any address —
  // the attacker's included. Refused.
  const allowedDest = requireAllowedDest(cat.allowedDest, 'erc20.approve')

  // The policy's allowance cap. A spender outside the allowlist is capped at
  // zero: the only compliant approval is then a revocation.
  const allowlisted = allowedDest.some(
    (a) => a.toLowerCase() === spender.toLowerCase(),
  )
  const cap = allowlisted ? (cat.maxOutflow ?? '0') : '0'

  return [
    {
      kind: 'erc20_allowance',
      token,
      owner: treasury,
      spender,
      op: 'lte',
      value: requireUint(cap, 'maxOutflow').toString(10),
    },
    // An approval does not move funds. If it does, it was not an approval.
    {
      kind: 'erc20_balance_delta',
      token,
      account: treasury,
      op: 'gte',
      value: '0',
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// aavev3.*
// ─────────────────────────────────────────────────────────────────────────────

function aaveChecks(
  classification: Classification,
  policy: Policy,
  treasury: Address,
  nonceAccount: Address | undefined,
): Check[] {
  const category = classification.category
  const cat = policy.categories[category]
  if (!cat) {
    throw new PolicyError(`no policy for ${category}`)
  }
  const pool = requireAddress(
    classification.params['pool'],
    'classification.params.pool',
  )
  const minHealthFactor = requireUint(
    (cat as CategoryPolicyExtras).minHealthFactor ?? DEFAULT_MIN_HEALTH_FACTOR,
    'minHealthFactor',
  )

  const checks: Check[] = [
    // The committed user is the POLICY's treasury, not the calldata's
    // `onBehalfOf`: an agent cannot shift the guarantee onto a third party.
    {
      kind: 'aave_health_factor',
      pool,
      user: treasury,
      op: 'gte',
      value: minHealthFactor.toString(10),
    },
    ...nonceChecks(nonceAccount),
  ]

  // Withdrawal and borrow move funds out: the committed destination comes from
  // the allowlist, as for a transfer — and its absence is the same refusal.
  if (category === 'aavev3.withdraw' || category === 'aavev3.borrow') {
    const asset = requireAddress(
      classification.params['asset'],
      'classification.params.asset',
    )
    const amount = requireUint(classification.params['amount'], 'amount')
    const allowedDest = requireAllowedDest(cat.allowedDest, category)
    const dest = resolveDest(
      allowedDest,
      classification.params['to'] ?? classification.params['onBehalfOf'],
    )
    // Here the funds come *in* to `dest` (they come from the pool), including
    // when `dest` is the treasury: unlike the transfer case, `>= amount` is the
    // right bound even on the treasury itself.
    checks.push({
      kind: 'erc20_balance_delta',
      token: asset,
      account: dest,
      op: 'gte',
      value: amount.toString(10),
    })
  }

  return checks
}

/**
 * `nonce_advanced`, or nothing at all.
 *
 * `op: 'eq'` and not `'gte'`: the check computes
 * `count(evalBlock) − count(txBlock − 1)`, which is mechanically ≥ 1 as soon as
 * the account has submitted the evaluated transaction. `gte 1` is therefore a
 * tautology — a check that cannot return `false` constrains nothing. The
 * normative form of docs/07 § 2.8 is "exactly one transaction, no stray
 * action".
 */
function nonceChecks(account: Address | undefined): Check[] {
  if (!account) return []
  return [{ kind: 'nonce_advanced', account, op: 'eq', value: '1' }]
}

// ─────────────────────────────────────────────────────────────────────────────
// unknown — the strictest fallback
// ─────────────────────────────────────────────────────────────────────────────

function unknownChecks(
  classification: Classification,
  policy: Policy,
  treasury: Address,
  nonceAccount: Address | undefined,
): Check[] {
  // The strictest fallback was in fact the most permissive one: neither
  // `native_balance_delta` nor `nonce_advanced` is decidable in the project's
  // execution mode. The former requires a tracer — none is wired up, and
  // `checks/native.ts` explicitly refuses to guess; the latter is undecidable
  // under sponsoring. Both threw `UnsupportedCheckError`, so much so that the
  // category charged at `maxBond` was the only one whose bond could never be
  // slashed: it always expired into `reclaim`.
  //
  // We replace them with checks derived from the receipt, hence always
  // decidable: the transaction's logs are enough to settle them.
  const watched = new Set<Address>()
  // The target is the only known fact about an unclassified action, and it is the
  // contract the agent calls: it is the minimal surveillance.
  const target = classification.params['target']
  if (target !== undefined) watched.add(requireAddress(target, 'params.target'))
  for (const token of (policy as PolicyExtras).watchedTokens ?? []) {
    watched.add(requireAddress(token, 'watchedTokens'))
  }
  const tokens = [...watched]
  if (tokens.length === 0) {
    throw new PolicyError(
      'unknown with neither a target nor watchedTokens: no decidable ' +
        'surveillance to commit to. Declare policy.watchedTokens rather than ' +
        'opening a warrant whose post-condition can settle nothing',
    )
  }
  // 1 `no_new_approvals` + 1 delta per token (+ 1 optional nonce).
  const total = tokens.length + 1 + (nonceAccount ? 1 : 0)
  if (total > MAX_CHECKS) {
    throw new PolicyError(
      `unknown: ${tokens.length} watched tokens produce ${total} ` +
        `checks, maximum ${MAX_CHECKS} — reduce watchedTokens`,
    )
  }

  return [
    // The Bankr vector: an opaque call that unlocks permissions along the way. An
    // `Approval` resetting to zero remains allowed (checks/logs.ts).
    { kind: 'no_new_approvals', owner: treasury, tokens },
    // And nothing must leave the treasury on those tokens. `0` and not `-x`: an
    // action we cannot classify is entitled to no outflow tolerance at all. On a
    // target that is not an ERC-20, no `Transfer` log matches, the delta is 0 and
    // the check passes: decidable in every case.
    ...tokens.map(
      (token): Check => ({
        kind: 'erc20_balance_delta',
        token,
        account: treasury,
        op: 'gte',
        value: '0',
      }),
    ),
    ...nonceChecks(nonceAccount),
  ]
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The category's allowlist, mandatory for every **outbound** category.
 *
 * Its absence was the gravest defect of this file: `resolveDest` returned
 * `undefined`, the caller *silently* omitted the destination checks, and all
 * that was left was "the treasury did not lose more than `maxOutflow`". A
 * 500 USDC transfer to the attacker's address then passed the three remaining
 * checks: verdict `honored`, bond returned, reputation improved. That is word for
 * word Adversary 1 of docs/13 § 6, the one the post-condition is supposed to
 * stop.
 *
 * A missing `maxOutflow` already throws. There is no reason for the neighbouring
 * field, which carries exactly the same security function, to degrade silently.
 */
function requireAllowedDest(
  allowedDest: Address[] | undefined,
  category: string,
): Address[] {
  if (!allowedDest || allowedDest.length === 0) {
    throw new PolicyError(
      `${category} without allowedDest: the committed destination must come ` +
        "from the policy's allowlist, it cannot be inferred from the " +
        'calldata — without it the post-condition no longer tells an authorized ' +
        'payment from a diverted transfer',
    )
  }
  return allowedDest.map((a) => requireAddress(a, 'allowedDest'))
}

/**
 * The committed destination. It comes out of the policy's allowlist — the
 * calldata merely *selects* among the addresses already authorized, it adds
 * none. A destination outside the allowlist falls back to the first entry of the
 * allowlist, which is what makes the diverted transfer fail.
 */
function resolveDest(
  allowedDest: Address[],
  fromCalldata: string | undefined,
): Address {
  const wanted = fromCalldata?.toLowerCase()
  const matched = allowedDest.find((a) => a.toLowerCase() === wanted)
  return requireAddress(matched ?? allowedDest[0], 'allowedDest')
}

function requireAddress(value: string | undefined, what: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new PolicyError(`${what}: address missing or invalid (${String(value)})`)
  }
  return value.toLowerCase() as Address
}

function requireUint(value: string | undefined, what: string): bigint {
  if (typeof value !== 'string') {
    throw new PolicyError(`${what}: value missing`)
  }
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    throw new PolicyError(`${what}: integer expected, got "${value}"`)
  }
  if (parsed < 0n) throw new PolicyError(`${what}: non-negative integer expected`)
  return parsed
}
