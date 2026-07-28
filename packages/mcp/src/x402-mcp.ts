/**
 * Le transport MCP de x402 v2.
 *
 * Spécification : docs/05-specs-protocoles.md § 1.7, docs/09 § 3. Le flux tient
 * en quatre temps :
 *
 * 1. outil payant appelé sans paiement → résultat avec `isError: true` portant
 *    le `PaymentRequired` ;
 * 2. le client en extrait les exigences et construit un `PaymentPayload` ;
 * 3. il rejoue avec le paiement dans `_meta["x402/payment"]` ;
 * 4. le serveur règle et retourne le règlement dans
 *    `_meta["x402/payment-response"]`.
 *
 * L'exigence à ne pas manquer est celle du **double format**. La spec impose de
 * fournir le `PaymentRequired` à la fois en `structuredContent` et en
 * `content[0].text`, ce dernier étant exactement `JSON.stringify` du premier —
 * les clients qui ne savent pas lire le contenu structuré doivent pouvoir
 * parser le texte et obtenir le même objet.
 *
 * `dualFormat()` ci-dessous est la seule fabrique de résultats du serveur. Elle
 * sérialise **l'objet même** qu'elle place dans `structuredContent`, si bien
 * qu'une divergence entre les deux formats n'est pas seulement improbable :
 * elle est inexprimable.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  X402_PAYMENT_META_KEY,
  X402_PAYMENT_RESPONSE_META_KEY,
  isPaymentPayload,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from '@warrant/sdk'

export { X402_PAYMENT_META_KEY, X402_PAYMENT_RESPONSE_META_KEY }

/** Objet JSON quelconque — tout ce que `structuredContent` accepte. */
type JsonObject = Record<string, unknown>

/**
 * Construit un résultat d'outil dans les deux formats exigés.
 *
 * Ne jamais construire un `CallToolResult` autrement dans ce paquet : c'est
 * l'unique garantie que `content[0].text` et `structuredContent` ne peuvent pas
 * diverger.
 */
export function dualFormat(payload: JsonObject, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
  if (isError) result.isError = true
  return result
}

/**
 * Le résultat d'un outil payant appelé sans paiement.
 *
 * `isError: true` est contre-intuitif — rien n'a échoué — mais c'est ce que la
 * spec impose : MCP n'a pas de canal « 402 », et le résultat en erreur est le
 * seul par lequel un client peut recevoir des données exploitables plutôt
 * qu'une erreur de protocole.
 */
export function paymentRequiredResult(paymentRequired: PaymentRequired): CallToolResult {
  return dualFormat(paymentRequired as unknown as JsonObject, true)
}

/** Attache le règlement au résultat — étape 6 du flux. */
export function withSettlement(
  result: CallToolResult,
  settlement: SettlementResponse | undefined,
): CallToolResult {
  if (!settlement) return result
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [X402_PAYMENT_RESPONSE_META_KEY]: settlement },
  }
}

/**
 * Extrait le paiement de `_meta` — étape 4 du flux.
 *
 * Un `_meta["x402/payment"]` présent mais malformé est traité comme absent : on
 * répond alors par un nouveau `PaymentRequired`, ce qui donne au client une
 * chance de se corriger. Lever une erreur de protocole le laisserait sans
 * information sur ce qu'il faut payer.
 */
export function extractPayment(meta: unknown): PaymentPayload | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const candidate = (meta as Record<string, unknown>)[X402_PAYMENT_META_KEY]
  return isPaymentPayload(candidate) ? candidate : undefined
}
