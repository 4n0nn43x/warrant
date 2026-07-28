/**
 * Erreurs actionnables.
 *
 * Règle de la checklist DX (docs/09 § 8) : *chaque erreur porte un `hint` et un
 * lien de doc*. Un agent qui reçoit « invalid input » ne peut rien corriger ;
 * un agent qui reçoit « `$.checks[0].token`: adresse invalide — utilise une
 * adresse 20 octets en minuscules » se corrige tout seul au tour suivant.
 *
 * `hint` n'est donc pas décoratif : c'est la partie de l'erreur que le modèle
 * lit réellement.
 */

export type WarrantErrorCode =
  | 'invalid_input'
  | 'invalid_action_spec'
  | 'invalid_condition_spec'
  | 'classification_failed'
  | 'payment_invalid'
  | 'warrant_not_found'
  | 'gateway_unreachable'
  | 'gateway_error'

const DOCS_BASE = 'https://warrant.sh/docs'

/** Un lien par code : l'agent — ou le builder — sait où lire la suite. */
const DOCS: Record<WarrantErrorCode, string> = {
  invalid_input: `${DOCS_BASE}/tools`,
  invalid_action_spec: `${DOCS_BASE}/action-spec`,
  invalid_condition_spec: `${DOCS_BASE}/post-conditions`,
  classification_failed: `${DOCS_BASE}/classification`,
  payment_invalid: `${DOCS_BASE}/payments#x402`,
  warrant_not_found: `${DOCS_BASE}/warrants#lookup`,
  gateway_unreachable: `${DOCS_BASE}/troubleshooting#gateway`,
  gateway_error: `${DOCS_BASE}/troubleshooting#gateway`,
}

/** Repli : un hint générique vaut mieux qu'un champ absent. */
const DEFAULT_HINTS: Record<WarrantErrorCode, string> = {
  invalid_input:
    "Vérifie les champs de l'outil contre son inputSchema, puis rappelle-le.",
  invalid_action_spec:
    "L'actionSpec doit porter version, chainId, target, value, calldata et registryRef. Aucune catégorie ni notionnel : ils sont dérivés du calldata.",
  invalid_condition_spec:
    'Corrige le champ nommé dans `field` puis rouvre le mandat : une post-condition est immuable une fois engagée.',
  classification_failed:
    "Le couple (target, selector) est absent du registre. Appelle quote_risk d'abord : une action inconnue reste finançable, au tarif le plus strict.",
  payment_invalid:
    'Reconstruis le PaymentPayload à partir du PaymentRequired renvoyé, sans modifier `accepted`, et rejoue avec _meta["x402/payment"].',
  warrant_not_found:
    'Vérifie le warrantId (bytes32, 0x + 64 hex). list_warrants({ agent }) énumère les mandats connus.',
  gateway_unreachable:
    'Le Gateway Warrant est injoignable. Réessaie ; aucun mandat ni paiement n\'a été engagé.',
  gateway_error: 'Réessaie ; si cela persiste, le détail est dans `details`.',
}

export interface WarrantErrorJSON {
  error: {
    code: WarrantErrorCode
    message: string
    /** Ce qu'il faut faire ensuite. Rédigé pour être lu par un agent. */
    hint: string
    docs: string
    /** Chemin du champ fautif, quand il y en a un — docs/09 § 8. */
    field?: string
    details?: unknown
  }
}

export interface WarrantErrorOptions {
  hint?: string
  field?: string
  details?: unknown
  cause?: unknown
}

export class WarrantError extends Error {
  readonly code: WarrantErrorCode
  readonly hint: string
  readonly docs: string
  readonly field?: string
  readonly details?: unknown

  constructor(code: WarrantErrorCode, message: string, options: WarrantErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'WarrantError'
    this.code = code
    this.hint = options.hint ?? DEFAULT_HINTS[code]
    this.docs = DOCS[code]
    if (options.field !== undefined) this.field = options.field
    if (options.details !== undefined) this.details = options.details
  }

  toJSON(): WarrantErrorJSON {
    const error: WarrantErrorJSON['error'] = {
      code: this.code,
      message: this.message,
      hint: this.hint,
      docs: this.docs,
    }
    if (this.field !== undefined) error.field = this.field
    if (this.details !== undefined) error.details = this.details
    return { error }
  }
}

/**
 * Normalise n'importe quoi en `WarrantError`.
 *
 * Aucune frontière du produit ne doit laisser fuir une erreur nue : une
 * exception sans `hint` est une impasse pour l'agent qui la reçoit.
 */
export function toWarrantError(err: unknown): WarrantError {
  if (err instanceof WarrantError) return err

  // DslError de @warrant/core : il porte déjà le chemin du champ fautif,
  // c'est exactement ce que la checklist DX demande de faire remonter.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'DslError'
  ) {
    const dsl = err as { message: string; path?: string; issues?: unknown }
    return new WarrantError('invalid_action_spec', dsl.message, {
      field: dsl.path,
      details: dsl.issues,
      cause: err,
    })
  }

  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'ClassificationError'
  ) {
    const e = err as { message: string; code?: string }
    return new WarrantError('classification_failed', e.message, {
      details: e.code,
      cause: err,
    })
  }

  const message = err instanceof Error ? err.message : String(err)
  return new WarrantError('gateway_error', message, { cause: err })
}
