/**
 * Génération de la post-condition depuis la politique du propriétaire du
 * capital.
 *
 * > « La politique génère la post-condition, l'agent ne la propose pas. »
 * > (docs/13-risques.md § 5)
 *
 * Une fois la catégorie **dérivée** du calldata, la politique produit la
 * `conditionSpec` en y injectant **ses propres** paramètres. Le point qui ferme
 * le vecteur d'attaque : `allowedDest` vient de l'allowlist de la politique,
 * pas du calldata. Un transfert détourné engage donc une destination qui n'est
 * pas celle de l'attaquant — l'engagement échoue, la caution est saisie, et le
 * propriétaire du capital est indemnisé.
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
 * Champs de politique que `types.ts` ne modélise pas encore. Lus de façon
 * défensive : leur absence donne la valeur la plus stricte, jamais la plus
 * permissive.
 */
export interface CategoryPolicyExtras {
  /** Seuil de health factor Aave, en 1e18. Défaut : `DEFAULT_MIN_HEALTH_FACTOR`. */
  minHealthFactor?: string
}

export interface PolicyExtras {
  /** Tokens surveillés pour `no_new_approvals` sur les actions non classifiées. */
  watchedTokens?: Address[]
}

export interface BuildConditionOptions {
  /** Chaîne d'évaluation. Défaut : `classification.params.chainId`. */
  chainId?: number
  evaluateAt?: EvaluateAt
  confirmations?: number
  /**
   * Compte dont le nonce doit progresser. Défaut : le trésor. Le Gateway passe
   * ici l'adresse du wallet d'exécution KeeperHub quand il la connaît.
   */
  executor?: Address
  /**
   * `actionHash` de l'`ActionSpec` engagée. Fourni, il ajoute d'office le
   * vérificateur `calldata_matches_commitment` (hors quota `MAX_CHECKS`).
   */
  actionHash?: Hex
}

/** Health factor minimal par défaut : 1,5 en 1e18 (docs/07 § 2.5). */
export const DEFAULT_MIN_HEALTH_FACTOR = '1500000000000000000'

export class PolicyError extends Error {
  override readonly name = 'PolicyError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * Construit la `conditionSpec` engagée pour une classification donnée.
 *
 * @throws {PolicyError} si la politique est incomplète pour cette catégorie —
 * une politique incomplète est un refus, pas une post-condition vide.
 */
export function buildConditionSpec(
  classification: Classification,
  policy: Policy,
  opts: BuildConditionOptions = {},
): ConditionSpec {
  const chainId = opts.chainId ?? Number(classification.params['chainId'])
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new PolicyError(
      'chainId indéterminé : ni fourni en option ni présent dans la classification',
    )
  }

  const treasury = requireAddress(policy.treasury, 'policy.treasury')
  const category = classification.category
  const executor = opts.executor
    ? requireAddress(opts.executor, 'opts.executor')
    : treasury

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
      checks = aaveChecks(classification, policy, treasury, executor)
      break
    case 'unknown':
      checks = unknownChecks(policy, treasury, executor)
      break
    default: {
      // Exhaustivité : une catégorie ajoutée sans politique associée doit
      // casser à la compilation, pas produire une post-condition vide.
      const never: never = category
      throw new PolicyError(`catégorie sans politique: ${String(never)}`)
    }
  }

  if (checks.length === 0) {
    throw new PolicyError(
      `politique vide pour ${category} : une post-condition sans vérificateur ` +
        'ne serait pas un engagement',
    )
  }
  if (checks.length > MAX_CHECKS) {
    throw new PolicyError(
      `${checks.length} vérificateurs pour ${category}, maximum ${MAX_CHECKS}`,
    )
  }

  // Hors quota, non retirable (docs/07 § 2.10) : ce qui est engagé doit être ce
  // qui est exécuté.
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
 * Confirmations par défaut. Non exporté : `hash.ts` expose déjà la fonction
 * publique de même nom, et deux exports homonymes dans le baril `index.ts`
 * seraient une collision.
 */
function defaultConfirmations(chainId: number): number {
  return chainId === 1 ? DEFAULT_CONFIRMATIONS.l1 : DEFAULT_CONFIRMATIONS.l2
}

// ─────────────────────────────────────────────────────────────────────────────
// erc20.transfer — l'exemple normatif de docs/13 § 5
// ─────────────────────────────────────────────────────────────────────────────

function transferChecks(
  classification: Classification,
  policy: Policy,
  treasury: Address,
): Check[] {
  const cat = policy.categories['erc20.transfer']
  if (!cat) {
    throw new PolicyError('aucune politique pour erc20.transfer')
  }
  const token = requireAddress(
    classification.params['token'],
    'classification.params.token',
  )
  const amount = requireUint(classification.params['amount'], 'amount')

  if (cat.maxOutflow === undefined) {
    throw new PolicyError(
      'erc20.transfer sans maxOutflow : la borne de sortie doit venir de la ' +
        'politique, elle ne peut pas être déduite du calldata',
    )
  }
  const maxOutflow = requireUint(cat.maxOutflow, 'maxOutflow')

  const checks: Check[] = [
    // Borne de la POLITIQUE, pas du calldata.
    {
      kind: 'erc20_balance_delta',
      token,
      account: treasury,
      op: 'gte',
      value: `-${maxOutflow.toString(10)}`,
    },
  ]

  // Destination de l'ALLOWLIST. Si le calldata désigne une destination
  // autorisée, c'est elle qui est engagée ; sinon on engage la destination
  // canonique de la politique — et le transfert détourné échoue par
  // construction, puisque les fonds n'y arriveront jamais.
  const dest = resolveDest(cat.allowedDest, classification.params['to'])
  if (dest) {
    checks.push({
      kind: 'erc20_balance',
      token,
      account: dest,
      op: 'gte',
      value: amount.toString(10),
    })
    // Renforcement : un solde absolu déjà supérieur au montant passerait
    // trivialement. Le delta, lui, ne passe que si les fonds sont réellement
    // arrivés à la destination engagée.
    checks.push({
      kind: 'erc20_balance_delta',
      token,
      account: dest,
      op: 'gte',
      value: amount.toString(10),
    })
  }

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
    throw new PolicyError('aucune politique pour erc20.approve')
  }
  const token = requireAddress(
    classification.params['token'],
    'classification.params.token',
  )
  const spender = requireAddress(
    classification.params['spender'],
    'classification.params.spender',
  )

  // Plafond d'allowance de la politique. Un spender hors allowlist est plafonné
  // à zéro : la seule approbation conforme est alors une révocation.
  const allowlisted =
    !cat.allowedDest ||
    cat.allowedDest.some((a) => a.toLowerCase() === spender.toLowerCase())
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
    // Une approbation ne déplace pas de fonds. Si elle en déplace, ce n'était
    // pas une approbation.
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
  executor: Address,
): Check[] {
  const category = classification.category
  const cat = policy.categories[category]
  if (!cat) {
    throw new PolicyError(`aucune politique pour ${category}`)
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
    // L'utilisateur engagé est le trésor de la POLITIQUE, pas l'`onBehalfOf`
    // du calldata : un agent ne peut pas déplacer la garantie sur un tiers.
    {
      kind: 'aave_health_factor',
      pool,
      user: treasury,
      op: 'gte',
      value: minHealthFactor.toString(10),
    },
    { kind: 'nonce_advanced', account: executor, op: 'gte', value: '1' },
  ]

  // Retrait et emprunt sortent des fonds : la destination engagée vient de
  // l'allowlist, comme pour un transfert.
  if (category === 'aavev3.withdraw' || category === 'aavev3.borrow') {
    const asset = requireAddress(
      classification.params['asset'],
      'classification.params.asset',
    )
    const amount = requireUint(classification.params['amount'], 'amount')
    const dest = resolveDest(
      cat.allowedDest,
      classification.params['to'] ?? classification.params['onBehalfOf'],
    )
    if (dest) {
      checks.push({
        kind: 'erc20_balance_delta',
        token: asset,
        account: dest,
        op: 'gte',
        value: amount.toString(10),
      })
    }
  }

  return checks
}

// ─────────────────────────────────────────────────────────────────────────────
// unknown — le repli le plus strict
// ─────────────────────────────────────────────────────────────────────────────

function unknownChecks(
  policy: Policy,
  treasury: Address,
  executor: Address,
): Check[] {
  const checks: Check[] = [
    // Rien de natif ne doit sortir du trésor.
    {
      kind: 'native_balance_delta',
      account: treasury,
      op: 'gte',
      value: '0',
    },
    { kind: 'nonce_advanced', account: executor, op: 'gte', value: '1' },
  ]

  const watched = (policy as PolicyExtras).watchedTokens ?? []
  if (watched.length > 0) {
    checks.push({
      kind: 'no_new_approvals',
      owner: treasury,
      tokens: watched.map((t) => requireAddress(t, 'watchedTokens')),
    })
  }
  return checks
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Destination engagée. Elle sort de l'allowlist de la politique — le calldata
 * ne fait que *sélectionner* parmi les adresses déjà autorisées, il n'en ajoute
 * aucune. Une destination hors allowlist retombe sur la première entrée de
 * l'allowlist, ce qui fait échouer le transfert détourné.
 */
function resolveDest(
  allowedDest: Address[] | undefined,
  fromCalldata: string | undefined,
): Address | undefined {
  if (!allowedDest || allowedDest.length === 0) return undefined
  const wanted = fromCalldata?.toLowerCase()
  const matched = allowedDest.find((a) => a.toLowerCase() === wanted)
  return requireAddress(matched ?? allowedDest[0], 'allowedDest')
}

function requireAddress(value: string | undefined, what: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new PolicyError(`${what} : adresse absente ou invalide (${String(value)})`)
  }
  return value.toLowerCase() as Address
}

function requireUint(value: string | undefined, what: string): bigint {
  if (typeof value !== 'string') {
    throw new PolicyError(`${what} : valeur absente`)
  }
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    throw new PolicyError(`${what} : entier attendu, reçu "${value}"`)
  }
  if (parsed < 0n) throw new PolicyError(`${what} : entier positif attendu`)
  return parsed
}
