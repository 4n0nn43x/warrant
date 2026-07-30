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
 *
 * ## Pourquoi le challenge ne passe pas par MRTR
 *
 * La révision 2026-07-28 introduit les requêtes multi-aller-retour (MRTR) :
 * un serveur qui a besoin de quelque chose de plus répond
 * `resultType: "input_required"` et le client rejoue la requête. C'est
 * exactement la forme d'un 402, et la tentation est forte — d'autant que les
 * exigences de sécurité que la spec impose au `requestState` (intégrité
 * HMAC/AEAD, TTL court, liaison au principal, empreinte de la requête
 * d'origine) sont mot pour mot ce qu'il faut pour lier un devis à son paiement.
 *
 * On ne le fait pas, et la raison est structurelle plutôt que prudentielle :
 * **`InputRequiredResult` n'a pas de `content` ni de `structuredContent`.** Ses
 * seuls champs sont `resultType`, `inputRequests` et `requestState`
 * (basic/patterns/mrtr § InputRequiredResult, et le type du SDK v2 le confirme).
 * Or il n'existe aucun de ces trois emplacements où loger un `PaymentRequired` :
 *
 * - `inputRequests` est un type fermé — ses valeurs **doivent** être un
 *   `ElicitRequest`, un `CreateMessageRequest` ou un `ListRootsRequest`. Il n'y
 *   a pas de requête « paiement », et détourner une élicitation reviendrait à
 *   demander à un humain de saisir à la main ce que le wallet de l'agent est
 *   censé signer tout seul — c'est la négation du principe de x402.
 * - `requestState` est opaque par contrat : « Clients **MUST NOT** inspect,
 *   parse, modify, or make any assumptions about its contents ». Un client
 *   conforme ne peut donc pas y lire le montant à payer.
 * - resterait `_meta`, seul champ libre hérité de `Result`. Mais y mettre le
 *   `PaymentRequired` détruit précisément l'invariant que ce fichier existe pour
 *   tenir : plus de `content[0].text`, donc plus de double format, donc un
 *   client qui ne lit que le texte n'apprend plus rien du tout.
 *
 * S'ajoute un défaut de comportement observable. La spec dit qu'un client qui
 * reçoit un `input_required` **sans** `inputRequests` « **MAY** retry the
 * original request immediately ». Un agent rejouerait donc immédiatement, sans
 * paiement, recevrait le même `input_required`, et boucherait — sans jamais
 * qu'aucun texte ne lui explique qu'il doit payer. Le chemin `isError`, lui,
 * met l'objet payable sous les yeux du modèle dans les deux formats.
 *
 * Enfin, la compatibilité : un `input_required` servi à un client 2025 est
 * rattrapé par la « legacy shim » du SDK, qui tente de satisfaire les
 * `inputRequests` par de vraies requêtes serveur→client. Sans `inputRequests`,
 * il n'y a rien à satisfaire. Le jour où cette page est écrite, la révision a un
 * jour d'âge et la quasi-totalité des clients x402 sont encore 2025.
 *
 * On garde donc `isError: true`. Ce n'est pas un renoncement à MRTR : c'est le
 * constat que MRTR transporte des *demandes d'entrée typées*, pas des données
 * applicatives, et qu'un challenge de paiement est une donnée applicative. Le
 * jour où la spec définira un `PaymentRequest` dans `inputRequests` — ou
 * autorisera `content` sur un `InputRequiredResult` — la bascule sera de
 * quelques lignes, et `dualFormat()` restera le point de passage obligé.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
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
 * qu'une erreur de protocole. La révision 2026-07-28 ne change pas ce constat ;
 * l'analyse du cas MRTR est en tête de fichier.
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
