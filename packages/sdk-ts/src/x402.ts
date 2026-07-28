/**
 * Types de fil x402 v2 et constantes du transport MCP.
 *
 * Source : docs/05-specs-protocoles.md § 1.3 à § 1.7. Rien n'est inventé ici :
 * chaque champ correspond littéralement à un champ de la spécification. Le
 * point délicat — et le seul qui nous appartienne — est le § 1.7 : sur MCP, le
 * `PaymentRequired` doit voyager **dans les deux formats**, `structuredContent`
 * et `content[0].text`, strictement équivalents.
 */

/** Version du protocole. La v1 (`X-PAYMENT`) n'est pas supportée. */
export const X402_VERSION = 2 as const

/** Clé `_meta` par laquelle le client transmet son paiement (docs/05 § 1.7 étape 4). */
export const X402_PAYMENT_META_KEY = 'x402/payment'

/** Clé `_meta` par laquelle le serveur retourne le règlement (docs/05 § 1.7 étape 6). */
export const X402_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response'

/** Ressource pour laquelle le paiement est exigé. */
export interface ResourceInfo {
  url: string
  description?: string
  mimeType?: string
}

/**
 * Une offre de paiement acceptable.
 *
 * `amount` est en unités atomiques et en chaîne : la caution d'un mandat peut
 * dépasser `Number.MAX_SAFE_INTEGER` en unités atomiques, et un arrondi
 * flottant sur un montant est une classe de bug qu'on ne veut pas ouvrir.
 */
export interface PaymentRequirements {
  scheme: string
  /** Identifiant CAIP-2, ex. `eip155:8453`. */
  network: string
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

/** Le corps du 402 — sur MCP, le contenu du résultat d'outil en erreur. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION
  error?: string
  resource: ResourceInfo
  accepts: PaymentRequirements[]
  extensions?: Record<string, unknown>
}

/** La réponse du client : l'offre retenue plus la preuve de paiement. */
export interface PaymentPayload {
  x402Version: typeof X402_VERSION
  resource: Pick<ResourceInfo, 'url'>
  accepted: PaymentRequirements
  payload: unknown
  extensions?: Record<string, unknown>
}

/** Ce que rend le facilitateur après `POST /settle` (docs/05 § 1.6). */
export interface SettlementResponse {
  success: boolean
  /** Le hash que Warrant enregistre dans `fundingRef`. */
  transaction?: string
  network?: string
  payer?: string
  amount?: string
  errorReason?: string
}

/**
 * Reconnaît un `PaymentRequired` sur le fil.
 *
 * Volontairement structurel plutôt que par schéma : le serveur en face peut
 * annoncer des `extensions` que nous ne connaissons pas, et les rejeter
 * casserait la compatibilité ascendante voulue par la spec.
 */
export function isPaymentRequired(value: unknown): value is PaymentRequired {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.x402Version === X402_VERSION &&
    Array.isArray(v.accepts) &&
    typeof v.resource === 'object' &&
    v.resource !== null
  )
}

export function isPaymentPayload(value: unknown): value is PaymentPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.x402Version === X402_VERSION &&
    typeof v.accepted === 'object' &&
    v.accepted !== null &&
    'payload' in v
  )
}

/**
 * Signataire de paiement. C'est tout ce que le SDK demande à un wallet.
 *
 * Le SDK ne signe pas lui-même : il ne détient aucune clé, et n'en veut aucune.
 * L'implémentation concrète (viem, mppx, plugin OpenClaw…) est fournie par
 * l'appelant.
 */
export interface PaymentSigner {
  createPayment(required: PaymentRequired): Promise<PaymentPayload> | PaymentPayload
}
