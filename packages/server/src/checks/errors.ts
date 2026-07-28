/**
 * Erreurs de l'évaluateur.
 *
 * Invariant central (docs/07 § 5) : **échec de lecture ≠ échec de
 * post-condition**. `evaluate()` rend soit un verdict complet, soit une
 * exception. Aucune erreur ne doit jamais être convertie en `slashed` : le
 * doute bénéficie à l'agent, jamais au protocole.
 *
 * L'appelant traduit `RpcReadError` en retry, puis en expiration du mandat vers
 * `reclaim`. `InvalidSpecError` n'est pas justiciable d'un retry : la spec est
 * malformée et aurait dû être rejetée à l'ouverture.
 */

/** Une lecture onchain a échoué. Retryable. Ne produit jamais de `slashed`. */
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
 * Le contexte fourni ne correspond pas à la chaîne lue — typiquement une
 * transaction réorganisée dans un autre bloc que celui annoncé. Traité comme
 * une lecture non concluante : jamais un slash.
 */
export class ContextMismatchError extends RpcReadError {
  constructor(operation: string, cause?: unknown) {
    super(operation, cause)
    this.name = 'ContextMismatchError'
  }
}

/**
 * Le vérificateur ne peut pas être décidé de façon sûre sur ce chemin de
 * lecture (cas typique : `native_balance_delta` sur une transaction qui peut
 * contenir des transferts internes, sans tracer disponible). On refuse de
 * deviner : pas de verdict plutôt qu'un verdict faux.
 */
export class UnsupportedCheckError extends RpcReadError {
  constructor(operation: string, cause?: unknown) {
    super(operation, cause)
    this.name = 'UnsupportedCheckError'
  }
}

/** La `ConditionSpec` est malformée. Non retryable. */
export class InvalidSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSpecError'
  }
}

/** `kind` hors du catalogue fermé (docs/07 § 2). */
export class UnknownCheckKindError extends InvalidSpecError {
  constructor(kind: string) {
    super(`unknown check kind: ${JSON.stringify(kind)}`)
    this.name = 'UnknownCheckKindError'
  }
}

/**
 * Enveloppe une lecture RPC. Toute exception levée par le transport ressort en
 * `RpcReadError`, jamais en `false`.
 */
export async function read<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    if (cause instanceof RpcReadError) throw cause
    throw new RpcReadError(operation, cause)
  }
}
