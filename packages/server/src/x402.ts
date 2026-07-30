/**
 * Les deux protocoles de paiement du Gateway : **x402 v2** et **MPP**.
 *
 * Ce fichier ne contient que le protocole — formats de fil, encodages,
 * validation, client facilitateur, magasin de Challenges. Il ne sait rien des
 * mandats, de la classification ni de KeeperHub : c'est `gateway.ts` qui
 * enchaîne. Source normative : docs/05-specs-protocoles.md.
 *
 * Trois pièges de la spec sont traités explicitement ici, parce qu'ils sont
 * silencieux si on se trompe :
 *
 * 1. **Les en-têtes ont changé entre x402 v1 et v2.** `X-PAYMENT` n'existe plus.
 *    On émet `PAYMENT-REQUIRED`, on lit `PAYMENT-SIGNATURE`, on rend
 *    `PAYMENT-RESPONSE`. Aucun repli sur les noms v1 : accepter les deux
 *    reviendrait à accepter deux formats de payload sous un seul nom.
 * 2. **`/verify` et `/settle` ne sont pas symétriques.** `/verify` répond
 *    `{ isValid }`, `/settle` répond `{ success }`. Une lecture croisée
 *    (`res.success` sur `/verify`) vaut `undefined`, donc falsy, donc un refus
 *    silencieux — ou pire, l'inverse selon le sens du test. On vérifie donc la
 *    **présence** du booléen attendu et on refuse une réponse qui ne le porte
 *    pas, plutôt que de la coercer.
 * 3. **Un Credential MPP vaut pour exactement une requête.** Le rejeu est
 *    rejeté strictement, par `challenge.id`, et l'`id` est lié
 *    cryptographiquement aux paramètres du Challenge : un Challenge réécho avec
 *    un montant modifié ne recalcule pas le même `id`.
 */

import { canonicalize, type Address, type Hex } from '@warrant/core'
import { keccak256, parseSignature, stringToBytes, toHex } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Encodages
// ─────────────────────────────────────────────────────────────────────────────

/** base64 standard — l'encodage des en-têtes x402 v2. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** base64url sans remplissage — l'encodage des champs MPP (RFC 4648 § 5). */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * Décodage tolérant aux deux alphabets. Node accepte les caractères `-`/`_`
 * comme `+`/`/`, ce qui rend un décodeur unique sûr : les deux alphabets sont
 * disjoints sur les caractères qui les distinguent.
 */
export function b64decode(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8')
}

export class WireFormatError extends Error {
  override readonly name = 'WireFormatError'
  constructor(message: string) {
    super(message)
  }
}

/** Objet → base64 d'un JSON. Utilisé pour les trois en-têtes x402. */
export function encodeHeaderObject(value: unknown): string {
  return b64encode(JSON.stringify(value))
}

/** base64 → objet. Une erreur ici est un refus, jamais un repli sur `{}`. */
export function decodeHeaderObject<T>(header: string): T {
  let text: string
  try {
    text = b64decode(header.trim())
  } catch {
    throw new WireFormatError('en-tête non décodable en base64')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new WireFormatError(`en-tête décodé mais illisible en JSON: ${text.slice(0, 120)}`)
  }
}

/**
 * Objet → base64url de sa forme **JCS (RFC 8785)**.
 *
 * MPP exige JCS pour `request` et `opaque`. On réutilise la canonicalisation de
 * `@warrant/core` — celle de `conditionHash` — plutôt que d'en écrire une
 * seconde : une divergence entre deux canonicalisations serait exactement le
 * risque R1 de docs/13.
 */
export function encodeJcs(value: unknown): string {
  return b64urlEncode(canonicalize(value))
}

export function decodeJcs<T>(encoded: string): T {
  return decodeHeaderObject<T>(encoded)
}

// ─────────────────────────────────────────────────────────────────────────────
// x402 v2 — types de fil
// ─────────────────────────────────────────────────────────────────────────────

export const X402_VERSION = 2 as const

/** Serveur → client, avec HTTP 402 et un corps `{}`. */
export const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED'
/** Client → serveur. Remplace le `X-PAYMENT` de la v1. */
export const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE'
/** Serveur → client, sur la réponse 200. */
export const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE'

export interface ResourceInfo {
  url: string
  description?: string
  mimeType?: string
}

/** Méthodes de transfert du scheme `exact` sur EVM, par ordre de préférence. */
/**
 * Methode de transfert de l'actif, au sens du schema `exact` de x402 v2.
 *
 * Les trois premieres valeurs sont celles de la spec. `eip3009-receive` est une
 * **extension assumee**, et il faut dire exactement pourquoi elle existe.
 *
 * La spec est normative sur ce champ : « if present, MUST be "eip3009" », et
 * `eip3009` y designe sans ambiguite `transferWithAuthorization`. Or l'escrow
 * consomme `receiveWithAuthorization`, dont la contrainte `msg.sender == to`
 * interdit a un tiers d'intercepter l'autorisation pour consommer le nonce.
 * Annoncer `eip3009` serait donc FAUX : un client conforme signerait le mauvais
 * typehash, et `open()` reverterait sur une signature invalide.
 *
 * Mesure, pas suppose : le facilitateur CDP repond `HTTP 400
 * invalid_exact_evm_payload_signature` a une autorisation `receive` sous le
 * schema `exact`, et une valeur inconnue de ce champ ne le fait pas defaillir
 * proprement — il retombe en silence sur `transfer`. Il n'existe donc aucune
 * configuration ou un facilitateur public verifie une autorisation `receive`
 * sous `exact`.
 *
 * Le precedent existe des deux cotes : le facilitateur CDP verifie deja des
 * signatures `receiveWithAuthorization` pour son propre schema
 * `batch-settlement`, avec un motif d'erreur dedie ; et trois PR upstream
 * ajoutent des methodes de transfert par ce meme champ, dont #2886 qui fait
 * elle aussi du nonce EIP-3009 un hash d'engagement.
 *
 * Mieux vaut une non-conformite explicite et sourcee qu'un champ standard qui
 * mentait.
 */
export type AssetTransferMethod = 'eip3009' | 'eip3009-receive' | 'permit2' | 'erc7710'

export interface PaymentRequirements {
  scheme: 'exact'
  /** Identifiant **CAIP-2**, ex. `eip155:8453`. Jamais un chainId nu. */
  network: string
  /** Unités atomiques, en chaîne décimale. `"25000000"` = 25 USDC. */
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  /** EIP-3009 exige `name` et `version` — le domaine EIP-712 réel du token. */
  extra?: {
    name: string
    version: string
    assetTransferMethod?: AssetTransferMethod
    /**
     * Le `primaryType` EIP-712 à signer.
     *
     * Annoncé dans le 402 plutôt que supposé, parce que le défaut du schéma
     * `exact` (`TransferWithAuthorization`) n'est **pas** ce que l'escrow
     * consomme. Un client qui lit ce champ signe le bon typehash du premier
     * coup ; un client qui l'ignore verra `open()` révèrter à la vérification
     * de signature du token, sans qu'aucun fonds n'ait bougé.
     */
    primaryType?: string
  }
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION
  error?: string
  resource: ResourceInfo
  accepts: PaymentRequirements[]
  extensions?: Record<string, unknown>
}

/**
 * Autorisation EIP-3009, telle que le schéma `exact` la transporte.
 *
 * ⚠ **Le typehash n'est pas dans ces champs, et c'est le piège.** EIP-3009
 * définit deux opérations sur exactement la même liste d'arguments :
 *
 *   TransferWithAuthorization(address from,address to,uint256 value,…)
 *   ReceiveWithAuthorization(address from,address to,uint256 value,…)
 *
 * Deux `keccak256` différents, donc deux digests EIP-712 différents, donc deux
 * signatures qui ne sont **pas** interchangeables — alors que les données
 * signées, elles, sont identiques au bit près. Rien dans un
 * `ExactEvmAuthorization` ne dit laquelle des deux a été signée : la seule façon
 * de le savoir est de soumettre la signature au token et de voir s'il révèrte.
 *
 * `WarrantEscrow.open` appelle `receiveWithAuthorization` — délibérément, parce
 * que la variante `receive` impose `to == msg.sender` et empêche donc un tiers
 * d'intercepter l'autorisation pour consommer le nonce avant nous. Les clients
 * doivent signer le typehash `ReceiveWithAuthorization` ; une signature
 * `TransferWithAuthorization`, qui est ce que produisent les implémentations
 * x402 `exact` par défaut, sera rejetée par le token et fera révèrter `open()`.
 * Voir `RECEIVE_WITH_AUTHORIZATION_TYPE`.
 */
export interface ExactEvmAuthorization {
  from: string
  /** Doit être l'adresse de l'escrow : c'est lui qui appellera le token. */
  to: string
  value: string
  validAfter: string
  validBefore: string
  /** 32 octets aléatoires, jamais réutilisés. Devient le `fundingRef`. */
  nonce: Hex
}

export interface ExactEvmPayload {
  /** 65 octets, `r ‖ s ‖ v`. Découpée en `v`/`r`/`s` pour le contrat. */
  signature: Hex
  authorization: ExactEvmAuthorization
}

/**
 * Le type EIP-712 que les clients doivent signer, sous forme `signTypedData`.
 *
 * Publié ici pour qu'un intégrateur n'ait pas à le retranscrire : l'ordre des
 * champs fait partie du typehash, et un champ déplacé produit une signature
 * valide pour un message que personne ne vérifiera jamais.
 *
 * Le domaine EIP-712 est celui du **token** — `{ name, version, chainId,
 * verifyingContract: asset }` — et non celui de l'escrow. `name` et `version`
 * sont annoncés dans `PaymentRequirements.extra`.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPE = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** Nom du typehash attendu, annoncé dans `PaymentRequirements.extra`. */
export const RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE = 'ReceiveWithAuthorization' as const

export interface PaymentPayload {
  x402Version: typeof X402_VERSION
  resource: { url: string }
  accepted: PaymentRequirements
  payload: ExactEvmPayload
  extensions?: Record<string, unknown>
}

/** `POST /verify` — porte `isValid`, **jamais** `success`. */
export interface VerifyResponse {
  isValid: boolean
  invalidReason?: string
  payer?: string
}

/** `POST /settle` — porte `success`, **jamais** `isValid`. */
export interface SettlementResponse {
  success: boolean
  transaction: Hex
  network: string
  payer: string
  amount?: string
  errorReason?: string
}

/**
 * Ce que CE Gateway annonce par defaut.
 *
 * Ce n'est PAS le defaut de la spec (`eip3009`) : c'est ce que l'escrow consomme
 * reellement. Le defaut de la spec resterait juste pour un serveur x402
 * ordinaire ; ici il decrirait une autre implementation que la notre.
 */
export const DEFAULT_TRANSFER_METHOD: AssetTransferMethod = 'eip3009-receive'

/** Fenêtre de validité EIP-3009. Serrée pour limiter la fenêtre de rejeu. */
export const MAX_TIMEOUT_SECONDS = 60

export interface BuildPaymentRequiredOptions {
  resource: ResourceInfo
  network: string
  amount: string
  asset: string
  payTo: string
  extra: {
    name: string
    version: string
    assetTransferMethod?: AssetTransferMethod
    primaryType?: string
  }
  maxTimeoutSeconds?: number
  error?: string
  extensions?: Record<string, unknown>
}

/** Construit le `PaymentRequired` d'une réponse 402. */
export function buildPaymentRequired(opts: BuildPaymentRequiredOptions): PaymentRequired {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: opts.network,
    amount: opts.amount,
    asset: opts.asset,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS,
    extra: {
      name: opts.extra.name,
      version: opts.extra.version,
      assetTransferMethod: opts.extra.assetTransferMethod ?? DEFAULT_TRANSFER_METHOD,
      // Toujours émis : c'est la seule information du 402 qui n'est pas
      // devinable, et l'omettre laisserait le client sur le défaut du schéma.
      primaryType: opts.extra.primaryType ?? RECEIVE_WITH_AUTHORIZATION_PRIMARY_TYPE,
    },
  }
  return {
    x402Version: X402_VERSION,
    error: opts.error ?? `${HEADER_PAYMENT_SIGNATURE} header is required`,
    resource: opts.resource,
    accepts: [requirements],
    extensions: opts.extensions ?? {},
  }
}

export class PaymentRejected extends Error {
  override readonly name = 'PaymentRejected'
  readonly reason: string
  constructor(reason: string, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

/**
 * Contrôle qu'un `PaymentPayload` correspond aux exigences émises.
 *
 * Le facilitateur refait ce contrôle, mais il ne peut le faire que sur les
 * exigences **qu'on lui transmet** : si on lui transmettait celles que le client
 * a recopiées dans `accepted`, un client pourrait baisser le montant et le
 * facilitateur validerait fidèlement un paiement conforme à des exigences
 * fabriquées. La comparaison au montant que *nous* avons calculé est donc le
 * seul point où la caution est réellement contrainte.
 *
 * @throws {PaymentRejected}
 */
export function assertPayloadMatches(
  payload: PaymentPayload,
  required: PaymentRequirements,
): void {
  if (payload?.x402Version !== X402_VERSION) {
    throw new PaymentRejected(
      'unsupported_version',
      `x402Version ${String(payload?.x402Version)} : seul ${X402_VERSION} est supporté`,
    )
  }
  const accepted = payload.accepted
  if (!accepted || typeof accepted !== 'object') {
    throw new PaymentRejected('malformed_payload', 'champ `accepted` absent du PaymentPayload')
  }
  if (accepted.scheme !== required.scheme) {
    throw new PaymentRejected(
      'scheme_mismatch',
      `scheme "${String(accepted.scheme)}" au lieu de "${required.scheme}"`,
    )
  }
  if (accepted.network !== required.network) {
    throw new PaymentRejected(
      'network_mismatch',
      `réseau "${String(accepted.network)}" au lieu de "${required.network}"`,
    )
  }
  if (!sameAddress(accepted.asset, required.asset)) {
    throw new PaymentRejected(
      'asset_mismatch',
      `actif "${String(accepted.asset)}" au lieu de "${required.asset}"`,
    )
  }
  if (!sameAddress(accepted.payTo, required.payTo)) {
    throw new PaymentRejected(
      'recipient_mismatch',
      `destinataire "${String(accepted.payTo)}" au lieu de "${required.payTo}"`,
    )
  }
  // Montant **exactement** égal — étape 3 de la vérification du facilitateur.
  if (!sameAmount(accepted.amount, required.amount)) {
    throw new PaymentRejected(
      'amount_mismatch',
      `montant "${String(accepted.amount)}" au lieu de "${required.amount}"`,
    )
  }
  const auth = payload.payload?.authorization
  if (!auth) {
    throw new PaymentRejected('malformed_payload', 'autorisation EIP-3009 absente')
  }
  if (!sameAmount(auth.value, required.amount)) {
    throw new PaymentRejected(
      'amount_mismatch',
      `autorisation de ${String(auth.value)} pour un montant requis de ${required.amount}`,
    )
  }
  if (!sameAddress(auth.to, required.payTo)) {
    throw new PaymentRejected(
      'recipient_mismatch',
      `autorisation vers ${String(auth.to)} au lieu de ${required.payTo}`,
    )
  }
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

function sameAmount(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Facilitateur
// ─────────────────────────────────────────────────────────────────────────────

export interface FacilitatorConfig {
  url: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

export class FacilitatorError extends Error {
  override readonly name = 'FacilitatorError'
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * Interface minimale dont le Gateway dépend.
 *
 * ⚠ `settle()` n'est **plus appelée sur la route des mandats**. Le règlement est
 * désormais tiré par `WarrantEscrow.open()` lui-même, dans la transaction qui
 * ouvre le mandat : déléguer le transfert au facilitateur, puis ouvrir dans une
 * seconde transaction, était exactement la fenêtre de fonds orphelins que
 * l'audit a fermée. La méthode reste sur l'interface parce que le facilitateur
 * reste un service x402 conforme, et qu'un autre appelant peut légitimement s'en
 * servir ; elle n'est simplement plus sur le chemin d'ouverture.
 *
 * `verify()`, elle, ne déplace rien et reste utilisable — mais voir
 * `RECEIVE_WITH_AUTHORIZATION_TYPE` : un facilitateur qui n'implémente que le
 * typehash `TransferWithAuthorization` invalidera à tort nos autorisations.
 */
export interface Facilitator {
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse>
}

export class FacilitatorClient implements Facilitator {
  private readonly url: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(cfg: FacilitatorConfig) {
    if (!cfg.url) throw new Error('FacilitatorClient: url manquante')
    this.url = cfg.url.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  /**
   * Ce que le facilitateur declare savoir servir.
   *
   * Warrant ne lui delegue PAS la verification de signature : l'escrow consomme
   * `receiveWithAuthorization`, que le schema `exact` ne couvre pas, et le token
   * verifie la signature de facon autoritative dans `open()` — il verifie meme
   * davantage, puisque le contrat controle en plus que le nonce est bien le hash
   * des termes engages.
   *
   * Cet appel a donc un role different, et il n'est pas decoratif : il verifie au
   * demarrage que le facilitateur configure sert bien le schema et le reseau
   * annonces dans nos challenges 402. Un facilitateur qui ne couvre pas notre
   * chaine produirait des challenges que personne ne peut honorer, et l'echec
   * n'apparaitrait qu'au premier paiement.
   */
  async supported(): Promise<{ kinds: { scheme: string; network: string; x402Version?: number }[] }> {
    const res = await this.fetchImpl(`${this.url}/supported`, {
      headers: { accept: 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
    })
    if (!res.ok) throw new Error(`facilitateur /supported : HTTP ${res.status}`)
    const body = (await res.json()) as { kinds?: { scheme: string; network: string; x402Version?: number }[] }
    return { kinds: body.kinds ?? [] }
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const body = await this.post('/verify', payload, requirements)
    // Piège n°2 : `/verify` porte `isValid`. Une réponse qui ne le porte pas
    // n'est pas « invalide », elle est inexploitable — on ne devine pas.
    if (typeof (body as VerifyResponse).isValid !== 'boolean') {
      throw new FacilitatorError(
        200,
        'réponse /verify sans champ booléen `isValid` — ' +
          '/verify rend `isValid`, /settle rend `success`, les deux ne sont pas interchangeables',
        body,
      )
    }
    return body as VerifyResponse
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    const body = await this.post('/settle', payload, requirements)
    if (typeof (body as SettlementResponse).success !== 'boolean') {
      throw new FacilitatorError(
        200,
        'réponse /settle sans champ booléen `success` — ' +
          '/settle rend `success`, /verify rend `isValid`, les deux ne sont pas interchangeables',
        body,
      )
    }
    return body as SettlementResponse
  }

  private async post(
    path: string,
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      }),
    })
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    if (!res.ok) {
      throw new FacilitatorError(
        res.status,
        `facilitateur ${res.status} sur ${path}`,
        body,
      )
    }
    return body
  }
}

/**
 * Hash de la transaction qui a déplacé les fonds.
 *
 * Ce n'est **plus** le `fundingRef` du mandat : depuis que `open()` encaisse la
 * caution lui-même, la transaction qui déplace les fonds est l'ouverture, et le
 * `fundingRef` inscrit onchain est le nonce de l'autorisation
 * (`fundingRefOfAuthorization`). Cette fonction ne sert donc plus qu'à valider
 * la forme d'un hash avant de le rendre dans un reçu — x402 `PAYMENT-RESPONSE`
 * ou MPP `Payment-Receipt`, qui attendent tous deux une référence de règlement.
 */
export function settlementTxOf(settlement: SettlementResponse): Hex {
  const tx = settlement.transaction
  // `0X` majuscule accepté : certains facilitateurs le rendent ainsi, et un
  // refus sur la casse du préfixe perdrait un règlement déjà diffusé.
  if (typeof tx !== 'string' || !/^0[xX][0-9a-fA-F]{64}$/.test(tx)) {
    throw new PaymentRejected(
      'malformed_settlement',
      `transaction de règlement inexploitable: ${String(tx)}`,
    )
  }
  return tx.toLowerCase() as Hex
}

/**
 * `fundingRef` = le **nonce EIP-3009** de l'autorisation.
 *
 * Le contrat inscrit `auth.nonce` et rien d'autre ; recalculer la même valeur
 * ici plutôt que de relire l'onchain garde le journal et la chaîne d'accord sans
 * appel RPC supplémentaire. C'est aussi une meilleure `fundingRef` que l'ancien
 * hash de transaction : le token garantit lui-même que ce nonce ne sert qu'une
 * fois, alors qu'un hash de tx ne garantissait rien de tel.
 *
 * @throws {PaymentRejected} si le nonce n'est pas un `bytes32`. Le contrat
 *   l'accepterait — tout mot de 32 octets en est un — mais un nonce plus court
 *   serait complété à gauche par l'encodeur ABI, donc **différent** de celui que
 *   l'agent a signé, et le token révèrterait après coup. Refuser ici rend le
 *   diagnostic immédiat.
 */
export function fundingRefOfAuthorization(auth: ExactEvmAuthorization): Hex {
  const nonce = auth?.nonce
  if (typeof nonce !== 'string' || !/^0[xX][0-9a-fA-F]{64}$/.test(nonce)) {
    throw new PaymentRejected(
      'malformed_authorization',
      `nonce EIP-3009 inexploitable: ${String(nonce)} — 32 octets exactement attendus`,
    )
  }
  return nonce.toLowerCase() as Hex
}

/**
 * L'autorisation dans la forme que `WarrantEscrow.open` attend : la struct
 * `Authorization`, signature déjà découpée en `v`/`r`/`s`.
 *
 * `to` **disparaît** de la struct, et ce n'est pas une omission : le contrat
 * passe `address(this)` au token, précisément pour que `to` ne soit pas
 * déclarable. C'est `assertPayloadMatches` qui a vérifié en amont que le `to`
 * signé vaut bien `payTo` — lequel doit être l'escrow, sans quoi le digest que
 * l'agent a signé ne sera pas celui que le token recalcule.
 */
export interface EscrowAuthorization {
  from: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
  v: number
  r: Hex
  s: Hex
}

/**
 * `ExactEvmPayload` → struct `Authorization`.
 *
 * @throws {PaymentRejected} sur une signature qui n'est pas 65 octets, ou des
 *   bornes de validité illisibles. Ces refus valent mieux qu'un `open()` qui
 *   révèrte : ils nomment le champ fautif au client, qui peut resigner.
 */
export function escrowAuthorizationOf(payload: ExactEvmPayload): EscrowAuthorization {
  const auth = payload?.authorization
  if (!auth) {
    throw new PaymentRejected('malformed_payload', 'autorisation EIP-3009 absente')
  }
  const signature = payload.signature
  // 65 octets exactement : `r`(32) ‖ `s`(32) ‖ `v`(1). `parseSignature` de viem
  // accepte des formes plus larges — signatures compactes ERC-2098, `yParity`
  // sans `v` — mais le contrat prend trois champs séparés dont un `uint8`, et
  // deviner `v` depuis une signature compacte serait une reconstruction qu'on
  // ne veut pas faire dans le silence.
  if (typeof signature !== 'string' || !/^0[xX][0-9a-fA-F]{130}$/.test(signature)) {
    throw new PaymentRejected(
      'malformed_signature',
      `signature de ${signature ? (signature.length - 2) / 2 : 0} octet(s) : ` +
        '65 attendus (r ‖ s ‖ v)',
    )
  }

  let parsed: { r: Hex; s: Hex; v?: bigint; yParity: number }
  try {
    parsed = parseSignature(signature.toLowerCase() as Hex) as typeof parsed
  } catch (err) {
    throw new PaymentRejected('malformed_signature', `signature illisible: ${errText(err)}`)
  }
  // `v` plutôt que `yParity` : le token fait un `ecrecover`, qui veut 27 ou 28.
  // viem ne remplit `v` que si l'octet lu en valait déjà un ; sur une signature
  // dont le dernier octet est 0 ou 1, on le normalise.
  const v = parsed.v !== undefined ? Number(parsed.v) : parsed.yParity + 27
  if (v !== 27 && v !== 28) {
    throw new PaymentRejected(
      'malformed_signature',
      `v = ${v} : seuls 27 et 28 sont recouvrables par ecrecover`,
    )
  }

  return {
    from: requireAddress(auth.from, 'authorization.from'),
    value: requireUint(auth.value, 'authorization.value'),
    validAfter: requireUint(auth.validAfter, 'authorization.validAfter'),
    validBefore: requireUint(auth.validBefore, 'authorization.validBefore'),
    nonce: fundingRefOfAuthorization(auth),
    v,
    r: parsed.r,
    s: parsed.s,
  }
}

function requireAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !/^0[xX][0-9a-fA-F]{40}$/.test(value)) {
    throw new PaymentRejected(
      'malformed_authorization',
      `${field} : adresse EVM attendue, reçu ${String(value)}`,
    )
  }
  return value.toLowerCase() as Address
}

function requireUint(value: unknown, field: string): bigint {
  let parsed: bigint
  try {
    parsed = BigInt(String(value))
  } catch {
    throw new PaymentRejected(
      'malformed_authorization',
      `${field} : entier attendu, reçu ${String(value)}`,
    )
  }
  if (parsed < 0n) {
    throw new PaymentRejected('malformed_authorization', `${field} : négatif (${parsed})`)
  }
  return parsed
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─────────────────────────────────────────────────────────────────────────────
// MPP — Challenge / Credential / Receipt
// ─────────────────────────────────────────────────────────────────────────────

export const HEADER_WWW_AUTHENTICATE = 'WWW-Authenticate'
export const HEADER_AUTHORIZATION = 'Authorization'
export const HEADER_PAYMENT_RECEIPT = 'Payment-Receipt'
/** Le nom du schéma d'authentification RFC 9110 utilisé par MPP. */
export const MPP_SCHEME = 'Payment'

/** Intents MPP. Seul `charge` est au périmètre v1 (docs/05 § 2.5). */
export type MppIntent = 'charge' | 'session' | 'subscription'

export interface MppChallenge {
  id: string
  realm: string
  /** `tempo`, `stripe`, `evm`, `card`… */
  method: string
  intent: MppIntent
  /** JSON JCS en base64url. */
  request: string
  /** ISO 8601. */
  expires?: string
  /** JSON JCS en base64url. Le client doit le renvoyer **inchangé**. */
  opaque?: string
  description?: string
}

/** Champs communs du `request` décodé. */
export interface MppRequestBody {
  /** Unités de base. */
  amount: string
  /** Code ou adresse de token. */
  currency: string
  /** Format natif de la méthode. */
  recipient: string
  [key: string]: unknown
}

export type MppPayloadType = 'transaction' | 'hash' | 'proof'

export interface MppCredential {
  /** Le Challenge réécho **tel quel**, valeurs de fil comprises. */
  challenge: MppChallenge
  payload: {
    type: MppPayloadType
    signature?: Hex
    /** Autorisation EIP-3009 pour le mode `transaction` sur un rail EVM. */
    authorization?: ExactEvmAuthorization
    [key: string]: unknown
  }
  /** Adresse, DID ou identifiant de compte du payeur. */
  source: string
}

export interface MppReceipt {
  challengeId: string
  method: string
  reference: string
  settlement: { amount: string; currency: string }
  status: 'success' | 'failed'
  timestamp: string
}

const CHALLENGE_PARAM_ORDER = [
  'id',
  'realm',
  'method',
  'intent',
  'expires',
  'opaque',
  'request',
  'description',
] as const

/**
 * Sérialise un Challenge en valeur d'en-tête `WWW-Authenticate`.
 *
 * Format RFC 9110 : `Payment k="v", k="v"`. Les valeurs sont toujours entre
 * guillemets — un `id` base64url peut contenir `-` et `_`, qui ne sont pas des
 * `token` au sens de la grammaire.
 */
export function formatChallengeHeader(challenge: MppChallenge): string {
  const parts: string[] = []
  for (const key of CHALLENGE_PARAM_ORDER) {
    const value = (challenge as unknown as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}="${escapeQuoted(String(value))}"`)
  }
  return `${MPP_SCHEME} ${parts.join(', ')}`
}

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Parse une valeur `WWW-Authenticate: Payment …`. Utilisé par les tests et par
 * un client ; le serveur n'en a pas besoin, il émet.
 *
 * @throws {WireFormatError}
 */
export function parseChallengeHeader(header: string): MppChallenge {
  const trimmed = header.trim()
  const prefix = `${MPP_SCHEME} `
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new WireFormatError(`schéma d'authentification inattendu: ${trimmed.slice(0, 40)}`)
  }
  const params: Record<string, string> = {}
  const re = /([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(trimmed.slice(prefix.length))) !== null) {
    params[match[1] as string] = (match[2] as string).replace(/\\(.)/g, '$1')
  }
  for (const required of ['id', 'realm', 'method', 'intent', 'request'] as const) {
    if (!params[required]) {
      throw new WireFormatError(`paramètre de Challenge requis absent: ${required}`)
    }
  }
  return {
    id: params['id'] as string,
    realm: params['realm'] as string,
    method: params['method'] as string,
    intent: params['intent'] as MppIntent,
    request: params['request'] as string,
    ...(params['expires'] ? { expires: params['expires'] } : {}),
    ...(params['opaque'] ? { opaque: params['opaque'] } : {}),
    ...(params['description'] ? { description: params['description'] } : {}),
  }
}

export function encodeCredential(credential: MppCredential): string {
  return b64urlEncode(JSON.stringify(credential))
}

/** Lit la valeur d'`Authorization: Payment …`. @throws {WireFormatError} */
export function decodeCredentialHeader(header: string): MppCredential {
  const trimmed = header.trim()
  const prefix = `${MPP_SCHEME} `
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new WireFormatError(
      `en-tête Authorization sans le schéma ${MPP_SCHEME}: ${trimmed.slice(0, 40)}`,
    )
  }
  const credential = decodeHeaderObject<MppCredential>(trimmed.slice(prefix.length))
  if (!credential || typeof credential !== 'object' || !credential.challenge) {
    throw new WireFormatError('Credential sans Challenge réécho')
  }
  return credential
}

export function encodeReceipt(receipt: MppReceipt): string {
  return b64urlEncode(JSON.stringify(receipt))
}

export function decodeReceipt(header: string): MppReceipt {
  return decodeHeaderObject<MppReceipt>(header)
}

// ─────────────────────────────────────────────────────────────────────────────
// Magasin de Challenges
// ─────────────────────────────────────────────────────────────────────────────

export type MppErrorCode =
  | 'malformed_credential'
  | 'unknown_challenge'
  | 'challenge_expired'
  | 'challenge_replayed'
  | 'challenge_tampered'
  | 'opaque_mismatch'

export class MppError extends Error {
  override readonly name = 'MppError'
  readonly code: MppErrorCode
  constructor(code: MppErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface IssuedChallenge<T = unknown> {
  challenge: MppChallenge
  /** Contexte serveur associé — jamais transmis au client. */
  context: T
  issuedAt: number
  expiresAt: number
  consumed: boolean
}

export interface ChallengeStoreOptions {
  /** `MPP_SECRET_KEY`. Jamais loggée, jamais exposée côté client. */
  secret: string
  ttlSeconds?: number
  now?: () => number
  /** Sel injectable pour rendre les tests déterministes. */
  salt?: () => string
}

export interface IssueOptions<T> {
  realm: string
  method: string
  intent: MppIntent
  request: MppRequestBody
  opaque?: Record<string, unknown>
  description?: string
  context: T
}

/** TTL par défaut d'un Challenge, en secondes. */
export const DEFAULT_CHALLENGE_TTL = 300

/**
 * Magasin de Challenges en mémoire, avec TTL et rejet strict des rejeux.
 *
 * L'`id` est un MAC des paramètres du Challenge : c'est ce que la spec entend
 * par « identifiant unique, lié cryptographiquement aux paramètres du
 * Challenge ». Deux conséquences utiles :
 *
 * - un Challenge réécho avec un montant modifié ne recalcule pas le même `id`,
 *   donc `consume()` le rejette même si l'`id` d'origine est connu ;
 * - `opaque` est couvert par le MAC, donc son intégrité est vérifiée sans avoir
 *   besoin de lui faire confiance à la lecture.
 *
 * En mémoire, donc perdu au redémarrage : un Challenge non consommé devient
 * inconnu, ce qui est le sens de refus correct. Une v2 le mettrait dans Redis
 * avec le même TTL.
 */
export class ChallengeStore<T = unknown> {
  private readonly secret: string
  private readonly ttlSeconds: number
  private readonly now: () => number
  private readonly salt: () => string
  private readonly entries = new Map<string, IssuedChallenge<T>>()

  constructor(opts: ChallengeStoreOptions) {
    if (!opts.secret) throw new Error('ChallengeStore: secret manquant (MPP_SECRET_KEY)')
    this.secret = opts.secret
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_CHALLENGE_TTL
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.salt =
      opts.salt ??
      (() => toHex(crypto.getRandomValues(new Uint8Array(16))))
  }

  issue(opts: IssueOptions<T>): MppChallenge {
    const issuedAt = this.now()
    const expiresAt = issuedAt + this.ttlSeconds
    const salt = this.salt()

    const partial = {
      realm: opts.realm,
      method: opts.method,
      intent: opts.intent,
      request: encodeJcs(opts.request),
      expires: new Date(expiresAt * 1000).toISOString(),
      ...(opts.opaque ? { opaque: encodeJcs(opts.opaque) } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    }

    const challenge: MppChallenge = { id: this.bind(partial, salt), ...partial }

    this.gc()
    this.entries.set(challenge.id, {
      challenge,
      context: opts.context,
      issuedAt,
      expiresAt,
      consumed: false,
    })
    return challenge
  }

  /** Lecture sans consommation — pour les tests et l'introspection. */
  peek(id: string): IssuedChallenge<T> | undefined {
    return this.entries.get(id)
  }

  /**
   * Valide un Credential et **consomme** le Challenge. Chaque Credential est
   * valide pour exactement une requête (docs/05 § 2.3).
   *
   * @throws {MppError}
   */
  consume(credential: MppCredential): IssuedChallenge<T> {
    const echoed = credential?.challenge
    if (!echoed || typeof echoed.id !== 'string' || echoed.id === '') {
      throw new MppError('malformed_credential', 'Credential sans `challenge.id`')
    }

    const entry = this.entries.get(echoed.id)
    if (!entry) {
      throw new MppError(
        'unknown_challenge',
        `aucun Challenge en attente pour l'id ${echoed.id}`,
      )
    }
    if (entry.consumed) {
      // Rejet strict du rejeu, avant même le contrôle d'expiration : c'est la
      // faute la plus grave et elle doit être nommée telle quelle.
      throw new MppError(
        'challenge_replayed',
        `Challenge ${echoed.id} déjà consommé — un Credential vaut pour une seule requête`,
      )
    }
    if (this.now() > entry.expiresAt) {
      this.entries.delete(echoed.id)
      throw new MppError('challenge_expired', `Challenge ${echoed.id} expiré`)
    }

    // Le Challenge est réécho tel quel : toute divergence est une falsification.
    for (const key of CHALLENGE_PARAM_ORDER) {
      const mine = (entry.challenge as unknown as Record<string, unknown>)[key]
      const theirs = (echoed as unknown as Record<string, unknown>)[key]
      if ((mine ?? undefined) !== (theirs ?? undefined)) {
        throw new MppError(
          key === 'opaque' ? 'opaque_mismatch' : 'challenge_tampered',
          `paramètre "${key}" du Challenge modifié : émis ${JSON.stringify(mine)}, ` +
            `reçu ${JSON.stringify(theirs)}`,
        )
      }
    }

    entry.consumed = true
    return entry
  }

  /** Purge les Challenges expirés. Appelée à chaque émission. */
  gc(): void {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(id)
    }
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * `id = base64url(keccak256(secret ‖ JCS(paramètres) ‖ sel)[0..16])`.
   *
   * Le secret n'apparaît jamais dans la sortie et n'est jamais loggé ; le sel
   * rend deux Challenges pour la même action distincts, sans quoi un agent ne
   * pourrait pas payer deux fois la même action.
   */
  private bind(partial: Omit<MppChallenge, 'id'>, salt: string): string {
    const digest = keccak256(
      stringToBytes(`${this.secret}|${canonicalize(partial)}|${salt}`),
    )
    return Buffer.from(digest.slice(2, 34), 'hex').toString('base64url')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC 9457 — Problem Details, le format d'erreur du chemin MPP
// ─────────────────────────────────────────────────────────────────────────────

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  [key: string]: unknown
}

/** Espace d'URI des types d'erreur du Gateway. */
export const PROBLEM_BASE = 'https://warrant.sh/problems'

export function problem(
  code: string,
  status: number,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/${code}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ponts entre les deux rails
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconstruit un `PaymentPayload` x402 depuis un Credential MPP.
 *
 * C'est ce qui rend les deux rails **strictement équivalents en aval** : la même
 * autorisation EIP-3009 arrive à `open()`, donc le même `fundingRef` — son
 * nonce — et le même agent, `auth.from`. Le rail n'est qu'un moyen de
 * transporter la signature (docs/04).
 *
 * @throws {PaymentRejected} si le Credential ne porte pas d'autorisation
 *   exploitable. Les payloads `hash` et `proof` de Tempo ne sont pas au
 *   périmètre v1 : `charge` non nulle en mode pull, donc `transaction`.
 */
export function paymentPayloadFromCredential(
  credential: MppCredential,
  required: PaymentRequirements,
  resourceUrl: string,
): PaymentPayload {
  const payload = credential.payload
  if (!payload || payload.type !== 'transaction') {
    throw new PaymentRejected(
      'unsupported_payload_type',
      `payload MPP de type "${String(payload?.type)}" : seul "transaction" est supporté en v1`,
    )
  }
  if (!payload.authorization || !payload.signature) {
    throw new PaymentRejected(
      'malformed_payload',
      'payload MPP `transaction` sans `authorization` ni `signature` EIP-3009',
    )
  }
  return {
    x402Version: X402_VERSION,
    resource: { url: resourceUrl },
    accepted: required,
    payload: {
      signature: payload.signature,
      authorization: payload.authorization,
    },
    extensions: {},
  }
}

/**
 * Extrait une adresse EVM d'un `source` MPP, qui peut être une adresse nue ou
 * un DID PKH (`did:pkh:eip155:4217:0x1234…`).
 */
export function addressFromSource(source: string | undefined): Address | undefined {
  if (typeof source !== 'string') return undefined
  const match = /0[xX][0-9a-fA-F]{40}$/.exec(source.trim())
  return match ? (match[0].toLowerCase() as Address) : undefined
}
