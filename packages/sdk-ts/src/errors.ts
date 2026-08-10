/**
 * Actionable errors.
 *
 * Rule from the DX checklist (docs/09 § 8): *every error carries a `hint` and a
 * documentation link*. An agent that receives "invalid input" cannot fix
 * anything; an agent that receives "`$.checks[0].token`: invalid address — use a
 * lowercase 20-byte address" fixes itself on the next turn.
 *
 * `hint` is therefore not decorative: it is the part of the error the model
 * actually reads.
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
  | 'invalid_base_url'

const DOCS_BASE = 'https://github.com/4n0nn43x/warrant'

/** One link per code: the agent — or the builder — knows where to read on. */
const DOCS: Record<WarrantErrorCode, string> = {
  invalid_input: `${DOCS_BASE}/tools`,
  invalid_action_spec: `${DOCS_BASE}/action-spec`,
  invalid_condition_spec: `${DOCS_BASE}/post-conditions`,
  classification_failed: `${DOCS_BASE}/classification`,
  payment_invalid: `${DOCS_BASE}/payments#x402`,
  warrant_not_found: `${DOCS_BASE}/warrants#lookup`,
  gateway_unreachable: `${DOCS_BASE}/troubleshooting#gateway`,
  gateway_error: `${DOCS_BASE}/troubleshooting#gateway`,
  invalid_base_url: `${DOCS_BASE}/troubleshooting#gateway`,
}

/** Fallback: a generic hint is better than a missing field. */
const DEFAULT_HINTS: Record<WarrantErrorCode, string> = {
  invalid_input:
    "Check the tool's fields against its inputSchema, then call it again.",
  invalid_action_spec:
    'The actionSpec must carry version, chainId, target, value, calldata and registryRef. No category and no notional: both are derived from the calldata.',
  invalid_condition_spec:
    'Fix the field named in `field` then open the warrant again: a post-condition is immutable once committed.',
  classification_failed:
    'The (target, selector) pair is absent from the registry. Call quote_risk first: an unknown action remains fundable, at the strictest rate.',
  payment_invalid:
    'Rebuild the PaymentPayload from the PaymentRequired that was returned, without modifying `accepted`, and replay with _meta["x402/payment"].',
  warrant_not_found:
    'Check the warrantId (bytes32, 0x + 64 hex). list_warrants({ agent }) lists the known warrants.',
  gateway_unreachable:
    'The Warrant Gateway is unreachable. Retry; no warrant and no payment were committed.',
  gateway_error: 'Retry; if it persists, the detail is in `details`.',
  // Shared by both SDKs, so it names no language's HTTP call: the Python client
  // is the one that would open a `file:` URL and return its bytes as a response,
  // but the advice — check the variable — is the same on either side.
  invalid_base_url:
    'The Gateway URL must be http(s). A file:, ftp: or data: URL is not a Gateway, and a client that opens one would return its bytes as though the Gateway had sent them. Check WARRANT_BASE_URL.',
}

export interface WarrantErrorJSON {
  error: {
    code: WarrantErrorCode
    message: string
    /** What to do next. Written to be read by an agent. */
    hint: string
    docs: string
    /** Path of the offending field, when there is one — docs/09 § 8. */
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
 * Normalises anything into a `WarrantError`.
 *
 * No boundary of the product may let a bare error escape: an exception without a
 * `hint` is a dead end for the agent that receives it.
 */
export function toWarrantError(err: unknown): WarrantError {
  if (err instanceof WarrantError) return err

  // DslError from warrant-core: it already carries the path of the offending
  // field, which is exactly what the DX checklist asks us to surface.
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
