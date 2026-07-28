/**
 * Schémas d'entrée des outils.
 *
 * Le point de conception qui compte tient en une phrase : **aucun schéma
 * n'accepte de `category` ni de `notional`**. Les deux sont dérivés du calldata
 * par le Classifieur (docs/13 § 5). Un agent qui pourrait déclarer sa propre
 * catégorie pourrait choisir son propre tarif de risque, et le modèle de menace
 * s'effondrerait.
 *
 * Cela se traduit en deux garanties complémentaires :
 *
 * 1. le champ n'existe pas dans le JSON Schema publié par `tools/list` — un
 *    agent bien élevé ne l'envoie donc jamais ;
 * 2. Zod **retire** silencieusement toute clé inconnue au parsing — un agent
 *    mal élevé qui l'envoie quand même se la voit ignorée, et surtout : la
 *    valeur transmise au Gateway est l'objet nettoyé, si bien que l'`actionHash`
 *    engagé ne peut pas dépendre d'un champ parasite.
 *
 * Le point 2 est le seul qui tienne face à un client hostile.
 */

import { z } from 'zod'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/

export const addressSchema = z
  .string()
  .regex(ADDRESS_RE, 'adresse EVM attendue : 0x suivi de 40 caractères hexadécimaux')

export const bytes32Schema = z
  .string()
  .regex(BYTES32_RE, 'bytes32 attendu : 0x suivi de 64 caractères hexadécimaux')

export const hexDataSchema = z
  .string()
  .regex(HEX_DATA_RE, 'calldata hexadécimal attendu, longueur entière en octets')

export const decimalSchema = z
  .string()
  .regex(DECIMAL_RE, 'entier décimal canonique attendu : pas de signe, pas de zéro de tête')

/**
 * La transaction engagée. Seul intrant de la classification et de la
 * tarification : tout le reste en découle.
 */
export const actionSpecSchema = z
  .object({
    version: z.literal(1),
    chainId: z.number().int().positive().describe('Chain ID EVM de la transaction exécutée.'),
    target: addressSchema.describe('Contrat appelé.'),
    value: decimalSchema.describe('Valeur native envoyée, en wei, en chaîne décimale.'),
    calldata: hexDataSchema.describe(
      "Calldata exact de la transaction. C'est de lui — et de lui seul — que sont dérivés la catégorie, le notionnel et donc la caution.",
    ),
    registryRef: bytes32Schema.describe(
      'Hash de la version du registre de classification utilisée.',
    ),
  })
  .describe(
    "La transaction à exécuter. N'accepte ni catégorie ni notionnel : les deux sont dérivés du calldata, jamais déclarés.",
  )

export type ActionSpecInput = z.output<typeof actionSpecSchema>

export const quoteRiskInputSchema = z.object({
  actionSpec: actionSpecSchema,
  beneficiary: addressSchema
    .optional()
    .describe(
      "Bénéficiaire d'une éventuelle saisie. N'influe pas sur le prix ; sert à construire la post-condition.",
    ),
})

export const requestWarrantInputSchema = z.object({
  actionSpec: actionSpecSchema,
  beneficiary: addressSchema.describe(
    "Adresse qui reçoit la caution si la post-condition est violée — le propriétaire du capital, jamais l'agent.",
  ),
})

export const getWarrantInputSchema = z.object({
  warrantId: bytes32Schema.describe('Identifiant du mandat, tel que rendu par request_warrant.'),
})

export const listWarrantsInputSchema = z.object({
  agent: addressSchema.describe('Wallet agentique dont on énumère les mandats.'),
  status: z
    .enum(['open', 'honored', 'slashed', 'reclaimed'])
    .optional()
    .describe('Ne garder que les mandats dans cet état.'),
  category: z
    .enum([
      'erc20.transfer',
      'erc20.approve',
      'aavev3.repay',
      'aavev3.supply',
      'aavev3.withdraw',
      'aavev3.borrow',
      'unknown',
    ])
    .optional()
    .describe('Filtre a posteriori sur la catégorie dérivée. Ne peut pas être déclarée à l\'ouverture.'),
  since: z.number().int().nonnegative().optional().describe('Borne basse sur openedAt, en secondes Unix.'),
  until: z.number().int().nonnegative().optional().describe('Borne haute sur openedAt, en secondes Unix.'),
  limit: z.number().int().min(1).max(100).optional().describe('Nombre maximal de mandats rendus (défaut 20).'),
  cursor: z.string().optional().describe('Curseur de pagination rendu par un appel précédent.'),
})

export type QuoteRiskInput = z.output<typeof quoteRiskInputSchema>
export type RequestWarrantInput = z.output<typeof requestWarrantInputSchema>
export type GetWarrantInput = z.output<typeof getWarrantInputSchema>
export type ListWarrantsInput = z.output<typeof listWarrantsInputSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Schémas de sortie
//
// Publiés (`tools/list` les expose en `outputSchema`) mais délibérément
// permissifs : ils décrivent le contrat minimal que le Gateway doit tenir, pas
// la totalité de ce qu'il peut rendre. Un schéma de sortie fermé transformerait
// tout enrichissement du Gateway en panne du serveur MCP.
// ─────────────────────────────────────────────────────────────────────────────

const jsonObject = z.record(z.string(), z.unknown())

export const quoteRiskOutputSchema = z.object({
  category: z.string().describe('Catégorie dérivée du calldata.'),
  bond: z.string().describe('Caution exigée, en unités atomiques (USDC, 6 décimales).'),
  riskBps: z.number().describe('Taux de risque appliqué, en points de base.'),
  notionalUSD: z.string().describe('Notionnel dérivé des arguments décodés.'),
  conditionSpec: jsonObject.describe('Post-condition qui sera engagée sous conditionHash.'),
  rationale: z.string().describe('Justification du prix, en une phrase.'),
})

export const requestWarrantOutputSchema = z.object({
  warrantId: bytes32Schema,
  executionId: z.string().describe('Identifiant KeeperHub de l\'exécution.'),
  conditionHash: bytes32Schema.describe('keccak256(JCS(conditionSpec)) — engagement immuable.'),
  actionHash: bytes32Schema.describe('keccak256(JCS(actionSpec)) — engagement sur ce qui est demandé.'),
  expiry: z.number().describe('Au-delà, honor/slash sont fermés et reclaim() est ouvert.'),
})

export const checkResultSchema = z.object({
  kind: z.string(),
  expected: z.string(),
  observed: z.string(),
  pass: z.boolean(),
})

export const getWarrantOutputSchema = z.object({
  warrantId: bytes32Schema,
  agent: addressSchema,
  beneficiary: addressSchema,
  bond: z.string(),
  conditionHash: bytes32Schema,
  actionHash: bytes32Schema,
  expiry: z.number(),
  openedAt: z.number(),
  status: z.number().describe('0 None, 1 Open, 2 Honored, 3 Slashed, 4 Reclaimed.'),
  verdict: jsonObject.optional().describe('Présent une fois le mandat réglé.'),
  checks: z
    .array(checkResultSchema)
    .describe(
      'Une ligne par vérification, y compris celles qui passent — un verdict partiel ne serait pas auditable.',
    ),
})

export const listWarrantsOutputSchema = z.object({
  warrants: z.array(jsonObject),
  stats: z.object({
    total: z.number(),
    open: z.number(),
    honored: z.number(),
    slashed: z.number(),
    reclaimed: z.number(),
    totalBonded: z.string(),
    totalSlashed: z.string(),
    honorRateBps: z.number(),
  }),
  nextCursor: z.string().optional(),
})
