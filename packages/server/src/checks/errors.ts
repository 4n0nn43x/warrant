/**
 * The evaluator's errors.
 *
 * Central invariant (docs/07 § 5): **a failed read is not a failed
 * post-condition**. `evaluate()` returns either a complete verdict or an
 * exception. No error must ever be converted into a `slashed`: doubt benefits
 * the agent, never the protocol.
 *
 * The caller turns `RpcReadError` into a retry, then into letting the warrant
 * expire towards `reclaim`. `InvalidSpecError` does not warrant a retry: the
 * spec is malformed and should have been rejected at opening time.
 */

/** An onchain read failed. Retryable. Never produces a `slashed`. */
export class RpcReadError extends Error {
  readonly operation: string

  constructor(operation: string, cause?: unknown) {
    const detail = cause instanceof Error ? ` — ${cause.message}` : ''
    super(`RPC read failed: ${operation}${detail}`, { cause })
    this.name = 'RpcReadError'
    this.operation = operation
  }
}

/**
 * The supplied context does not match the chain that was read — typically a
 * transaction reorged into a block other than the announced one. Treated as an
 * inconclusive read: never a slash.
 */
export class ContextMismatchError extends RpcReadError {
  constructor(operation: string, cause?: unknown) {
    super(operation, cause)
    this.name = 'ContextMismatchError'
  }
}

/**
 * The check cannot be decided soundly on this read path (typical case:
 * `native_balance_delta` on a transaction that may contain internal transfers,
 * with no tracer available). We refuse to guess: no verdict rather than a wrong
 * verdict.
 */
export class UnsupportedCheckError extends RpcReadError {
  constructor(operation: string, cause?: unknown) {
    super(operation, cause)
    this.name = 'UnsupportedCheckError'
  }
}

/** The `ConditionSpec` is malformed. Not retryable. */
export class InvalidSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSpecError'
  }
}

/** A `kind` outside the closed catalogue (docs/07 § 2). */
export class UnknownCheckKindError extends InvalidSpecError {
  constructor(kind: string) {
    super(`unknown check kind: ${JSON.stringify(kind)}`)
    this.name = 'UnknownCheckKindError'
  }
}

/**
 * Wraps an RPC read. Any exception thrown by the transport comes back out as an
 * `RpcReadError`, never as a `false`.
 */
export async function read<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    if (cause instanceof RpcReadError) throw cause
    throw new RpcReadError(operation, cause)
  }
}
