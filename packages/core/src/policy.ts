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
 *
 * ## Trois règles de construction, apprises à l'audit
 *
 * 1. **Un trou de politique est un refus d'ouvrir, jamais une post-condition
 *    permissive.** Un paramètre manquant lève `PolicyError` ; il ne fait pas
 *    disparaître silencieusement le vérificateur qui en dépend. Un mandat
 *    ouvert sur une post-condition amputée serait pire que pas de mandat : il
 *    rend la caution, améliore la réputation, et signe la conformité d'un
 *    détournement.
 * 2. **N'engager que des vérificateurs ATTRIBUABLES à la transaction** — logs
 *    et receipt de l'action engagée. Jamais un état absolu partagé (un solde
 *    lu en fin de bloc) qu'un tiers peut faire varier après coup : il rendrait
 *    le verdict dépendant d'autre chose que du travail de l'agent, dans les
 *    deux sens (saisie fabriquée par le bénéficiaire, ou conformité fabriquée
 *    par un versement extérieur). Seule exception assumée :
 *    `aave_health_factor`, invariant de protection normatif de docs/07 § 2.5,
 *    qu'une post-condition de position ne peut pas exprimer autrement.
 * 3. **Une post-condition par défaut ne contient que des vérificateurs
 *    décidables dans le mode d'exécution réel du projet** — l'exécution
 *    sponsorisée par KeeperHub. Un vérificateur qui lève
 *    `UnsupportedCheckError` ne rend pas `false` : il fait expirer le mandat
 *    vers `reclaim`. Ce n'est donc pas une garantie, c'est un remboursement
 *    automatique déguisé. Voir les docstrings de
 *    `packages/server/src/checks/nonce.ts` et `.../native.ts`.
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
  /**
   * Déclare que l'action part du wallet d'exécution lui-même, sans relayer ni
   * forwarder. **Faux par défaut**, et c'est délibéré.
   *
   * Sous exécution sponsorisée — le mode réel du projet — la transaction est
   * émise par le relayer KeeperHub : le nonce du compte surveillé n'avance pas,
   * et `checks/nonce.ts` lève `UnsupportedCheckError` (voir son docstring, qui
   * conclut : « ce vérificateur ne doit pas figurer dans les post-conditions
   * par défaut tant que le sponsoring est actif »). Un check qui lève toujours
   * fait expirer le mandat vers `reclaim` : la caution ne peut jamais être
   * saisie, et la post-condition n'est plus un engagement.
   *
   * Ce drapeau n'est donc à activer que par un propriétaire de capital qui sait
   * que ses exécutions ne sont pas sponsorisées.
   */
  unsponsoredExecution?: boolean
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

  // Compte dont le nonce est engagé, ou `undefined` — le cas par défaut, qui
  // retire `nonce_advanced` de la post-condition. Voir
  // `PolicyExtras.unsponsoredExecution` : sous sponsoring, ce vérificateur est
  // indécidable et transforme la post-condition en remboursement automatique.
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
  // Symétrique de `maxOutflow` : sans allowlist, il n'y a pas de destination à
  // engager, donc plus rien qui distingue un virement de paie d'un transfert
  // détourné (docs/13 § 6, Adversaire 1). On refuse d'ouvrir.
  const allowedDest = requireAllowedDest(cat.allowedDest, 'erc20.transfer')

  const checks: Check[] = [
    // Borne de la POLITIQUE, pas du calldata.
    {
      kind: 'erc20_balance_delta',
      token,
      account: treasury,
      op: 'gte',
      // `maxOutflow: '0'` — « aucune sortie tolérée », la politique la plus
      // stricte et le défaut du Gateway — donnerait `-0`, qui n'est pas un
      // décimal canonique : la ConditionSpec produite est alors refusée par sa
      // propre validation, et *toute* quotation d'un `erc20.transfer` classifié
      // échoue en 400. RFC 8785 impose d'ailleurs la même sérialisation pour
      // `0` et `-0` (voir canonical.ts) ; `-0` n'aurait donc pas non plus
      // survécu au hachage de la condition.
      value: maxOutflow === 0n ? '0' : `-${maxOutflow.toString(10)}`,
    },
  ]

  // Destination de l'ALLOWLIST. Si le calldata désigne une destination
  // autorisée, c'est elle qui est engagée ; sinon on engage la destination
  // canonique de la politique — et le transfert détourné échoue par
  // construction, puisque les fonds n'y arriveront jamais.
  const dest = resolveDest(allowedDest, classification.params['to'])

  // Seul le DELTA est engagé, jamais `erc20_balance(dest)`.
  //
  // Un solde absolu lu à `evaluateAt` est le seul résultat de la post-condition
  // qui dépende d'autre chose que de la transaction de l'agent : il suffit que
  // `dest` — une adresse de l'allowlist, donc contrôlée par le propriétaire du
  // capital, ou un hot wallet qui balaie vers du cold storage — dépense ses
  // fonds plus tard dans le même bloc pour que `balanceOf(dest) >= amount`
  // échoue et fabrique la saisie, pendant que le delta jumeau prouve, dans le
  // même verdict, que l'agent a fait exactement ce qui était engagé. Le delta
  // domine strictement l'absolu : il ne passe que si les fonds sont réellement
  // arrivés, et il est dérivé des seuls logs `Transfer` de la transaction.
  checks.push({
    kind: 'erc20_balance_delta',
    token,
    account: dest,
    // Auto-transfert : quand la destination engagée est le trésor lui-même, les
    // fonds ne bougent pas (`from === to`, le delta s'annule dans les logs).
    // Exiger `>= amount` saisirait un transfert légitime ; `>= 0` reste
    // contraignant, puisqu'un transfert détourné sortirait `-amount` du trésor.
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

  // Une approbation est une sortie différée : sans allowlist de spenders, il
  // n'y a personne à qui refuser une allowance, et `allowlisted` serait vrai
  // pour n'importe quelle adresse — y compris celle de l'attaquant. Refus.
  const allowedDest = requireAllowedDest(cat.allowedDest, 'erc20.approve')

  // Plafond d'allowance de la politique. Un spender hors allowlist est plafonné
  // à zéro : la seule approbation conforme est alors une révocation.
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
  nonceAccount: Address | undefined,
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
    ...nonceChecks(nonceAccount),
  ]

  // Retrait et emprunt sortent des fonds : la destination engagée vient de
  // l'allowlist, comme pour un transfert — et son absence est le même refus.
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
    // Ici les fonds *entrent* sur `dest` (ils viennent du pool), y compris
    // quand `dest` est le trésor : contrairement au transfert, `>= amount` est
    // la bonne borne même sur le trésor lui-même.
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
 * `nonce_advanced`, ou rien.
 *
 * `op: 'eq'` et non `'gte'` : le vérificateur calcule
 * `count(evalBlock) − count(txBlock − 1)`, qui vaut mécaniquement ≥ 1 dès que
 * le compte a émis la transaction évaluée. `gte 1` est donc une tautologie —
 * un check qui ne peut pas rendre `false` ne contraint rien. La forme
 * normative de docs/07 § 2.8 est « exactement une transaction, aucune action
 * parasite ».
 */
function nonceChecks(account: Address | undefined): Check[] {
  if (!account) return []
  return [{ kind: 'nonce_advanced', account, op: 'eq', value: '1' }]
}

// ─────────────────────────────────────────────────────────────────────────────
// unknown — le repli le plus strict
// ─────────────────────────────────────────────────────────────────────────────

function unknownChecks(
  classification: Classification,
  policy: Policy,
  treasury: Address,
  nonceAccount: Address | undefined,
): Check[] {
  // Le repli le plus strict était en réalité le plus permissif : ni
  // `native_balance_delta` ni `nonce_advanced` ne sont décidables dans le mode
  // d'exécution du projet. Le premier exige un tracer — aucun n'est câblé, et
  // `checks/native.ts` refuse explicitement de deviner ; le second est
  // indécidable sous sponsoring. Les deux levaient `UnsupportedCheckError`, si
  // bien que la catégorie facturée `maxBond` était la seule dont la caution ne
  // pouvait jamais être saisie : elle expirait toujours vers `reclaim`.
  //
  // On les remplace par des vérificateurs dérivés du receipt, donc toujours
  // décidables : les logs de la transaction suffisent à les trancher.
  const watched = new Set<Address>()
  // La cible est le seul fait connu d'une action non classifiée, et c'est le
  // contrat que l'agent appelle : c'est la surveillance minimale.
  const target = classification.params['target']
  if (target !== undefined) watched.add(requireAddress(target, 'params.target'))
  for (const token of (policy as PolicyExtras).watchedTokens ?? []) {
    watched.add(requireAddress(token, 'watchedTokens'))
  }
  const tokens = [...watched]
  if (tokens.length === 0) {
    throw new PolicyError(
      'unknown sans cible ni watchedTokens : aucune surveillance décidable à ' +
        'engager. Déclarer policy.watchedTokens plutôt qu\'ouvrir un mandat ' +
        'dont la post-condition ne peut rien trancher',
    )
  }
  // 1 `no_new_approvals` + 1 delta par token (+ 1 nonce éventuel).
  const total = tokens.length + 1 + (nonceAccount ? 1 : 0)
  if (total > MAX_CHECKS) {
    throw new PolicyError(
      `unknown : ${tokens.length} tokens surveillés produisent ${total} ` +
        `vérificateurs, maximum ${MAX_CHECKS} — réduire watchedTokens`,
    )
  }

  return [
    // Le vecteur Bankr : un appel opaque qui débloque des permissions au
    // passage. Un `Approval` remettant à zéro reste autorisé (checks/logs.ts).
    { kind: 'no_new_approvals', owner: treasury, tokens },
    // Et rien ne doit sortir du trésor sur ces tokens. `0` et non `-x` : une
    // action qu'on ne sait pas classer n'a droit à aucune tolérance de sortie.
    // Sur une cible qui n'est pas un ERC-20, aucun log `Transfer` ne matche,
    // le delta vaut 0 et le check passe : décidable dans tous les cas.
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
 * Allowlist de la catégorie, obligatoire pour toute catégorie **sortante**.
 *
 * Son absence était le défaut le plus grave de ce fichier : `resolveDest`
 * rendait `undefined`, l'appelant omettait *silencieusement* les checks de
 * destination, et il ne restait que « le trésor n'a pas perdu plus de
 * `maxOutflow` ». Un transfert de 500 USDC vers l'adresse de l'attaquant
 * passait alors les trois checks restants : verdict `honored`, caution rendue,
 * réputation améliorée. C'est mot pour mot l'Adversaire 1 de docs/13 § 6, que
 * la post-condition est censée arrêter.
 *
 * `maxOutflow` absent lève déjà. Il n'y a aucune raison que le champ voisin,
 * qui porte exactement la même fonction de sécurité, dégrade en silence.
 */
function requireAllowedDest(
  allowedDest: Address[] | undefined,
  category: string,
): Address[] {
  if (!allowedDest || allowedDest.length === 0) {
    throw new PolicyError(
      `${category} sans allowedDest : la destination engagée doit venir de ` +
        "l'allowlist de la politique, elle ne peut pas être déduite du " +
        'calldata — sans elle la post-condition ne distingue plus un virement ' +
        "autorisé d'un transfert détourné",
    )
  }
  return allowedDest.map((a) => requireAddress(a, 'allowedDest'))
}

/**
 * Destination engagée. Elle sort de l'allowlist de la politique — le calldata
 * ne fait que *sélectionner* parmi les adresses déjà autorisées, il n'en ajoute
 * aucune. Une destination hors allowlist retombe sur la première entrée de
 * l'allowlist, ce qui fait échouer le transfert détourné.
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
