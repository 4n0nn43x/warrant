/**
 * La source unique des quatre outils.
 *
 * Quatre, pas cinq : `execute_metered` a disparu avec le régime routine
 * (docs/09 § 2, docs/03 § « Un seul régime, deux rails »). Quatre, pas quinze :
 * le catalogue est volontairement petit, parce qu'un agent choisit mal parmi
 * quinze outils.
 *
 * Tout ce qui suit est agnostique du framework. Le serveur MCP et l'adaptateur
 * Vercel AI ne font que projeter ces descripteurs — c'est la structure « une
 * source unique, des adaptateurs de moins de 100 lignes » qui a gagné le
 * hackathon précédent (docs/09 § intro).
 */

import { validateActionSpec } from '@warrant/core'
import type { ActionSpec, Address, Hex } from '@warrant/core'
import { z } from 'zod'

import { WarrantError, toWarrantError } from './errors.js'
import type {
  GatewayClient,
  ListWarrantsResult,
  QuoteResult,
  WarrantOpened,
  WarrantView,
} from './gateway.js'
import {
  getWarrantInputSchema,
  getWarrantOutputSchema,
  listWarrantsInputSchema,
  listWarrantsOutputSchema,
  quoteRiskInputSchema,
  quoteRiskOutputSchema,
  requestWarrantInputSchema,
  requestWarrantOutputSchema,
} from './schemas.js'
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentSigner,
  SettlementResponse,
} from './x402.js'

export interface ToolContext {
  /** Paiement fourni par le client — sur MCP, `_meta["x402/payment"]`. */
  payment?: PaymentPayload | undefined
}

/**
 * Issue d'un appel d'outil.
 *
 * `payment-required` n'est pas une erreur du point de vue du domaine : c'est
 * l'étape 2 du transport x402 (docs/05 § 1.7). Les adaptateurs sont libres de
 * la représenter comme une erreur — MCP l'exige — mais le noyau ne le fait pas.
 */
export type ToolOutcome<T> =
  | { kind: 'ok'; data: T; settlement?: SettlementResponse | undefined }
  | { kind: 'payment-required'; paymentRequired: PaymentRequired }

export interface WarrantTool<TInput extends z.ZodObject<z.ZodRawShape>, TOutput> {
  name: string
  title: string
  description: string
  input: TInput
  /** Contrat minimal de sortie, publié en `outputSchema` par `tools/list`. */
  output: z.ZodObject<z.ZodRawShape>
  /** `true` pour le seul `request_warrant` : la caution doit être financée. */
  paid: boolean
  /** Aucun de ces outils ne mute d'état onchain hors du paiement lui-même. */
  readOnly: boolean
  run(client: GatewayClient, args: unknown, ctx?: ToolContext): Promise<ToolOutcome<TOutput>>
}

/**
 * Parse et **nettoie** les arguments.
 *
 * Le nettoyage est le point de sécurité : la valeur rendue ne contient que les
 * clés du schéma, si bien qu'un champ `category` glissé dans l'`actionSpec` ne
 * peut atteindre ni le Classifieur, ni l'`actionHash`.
 */
function parseArgs<S extends z.ZodObject<z.ZodRawShape>>(schema: S, args: unknown): z.output<S> {
  const parsed = schema.safeParse(args)
  if (parsed.success) return parsed.data

  const first = parsed.error.issues[0]
  const field = first ? `$.${first.path.join('.')}` : '$'
  const message = parsed.error.issues
    .map((i) => `$.${i.path.join('.')}: ${i.message}`)
    .join('; ')
  throw new WarrantError('invalid_input', message, {
    field,
    hint: `Corrige ${field} puis rappelle l'outil. Rappel : ni category ni notional ne sont acceptés — ils sont dérivés du calldata.`,
    details: parsed.error.issues,
  })
}

/**
 * Double validation de l'`actionSpec` : Zod pour la forme, `@warrant/core` pour
 * les invariants du domaine.
 *
 * Redondant en apparence, utile en pratique : le noyau est l'autorité sur ce
 * qui est hachable, et c'est lui qui nomme le champ fautif exactement comme le
 * fera le Gateway. Faire diverger les deux validations, c'est accepter qu'un
 * mandat soit accepté ici et rejeté trois millisecondes plus tard.
 */
function toActionSpec(spec: unknown): ActionSpec {
  try {
    return validateActionSpec(spec)
  } catch (err) {
    throw toWarrantError(err)
  }
}

async function callGateway<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toWarrantError(err)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export const quoteRiskTool: WarrantTool<typeof quoteRiskInputSchema, QuoteResult> = {
  name: 'quote_risk',
  title: 'Quote the bond for an action',
  description:
    "Estime la caution exigée pour une action, sans rien engager et sans paiement. Classe le calldata, en dérive le notionnel, puis rend la caution, le taux de risque et la post-condition qui sera engagée. Appelle-le avant request_warrant : c'est gratuit, et c'est le seul moyen de connaître le coût avant de s'engager. La catégorie et le notionnel sont dérivés du calldata ; ils ne peuvent pas être déclarés.",
  input: quoteRiskInputSchema,
  output: quoteRiskOutputSchema,
  paid: false,
  readOnly: true,
  async run(client, args) {
    const parsed = parseArgs(quoteRiskInputSchema, args)
    const actionSpec = toActionSpec(parsed.actionSpec)
    const beneficiary = parsed.beneficiary as Address | undefined
    const data = await callGateway(() =>
      client.quote(beneficiary === undefined ? { actionSpec } : { actionSpec, beneficiary }),
    )
    return { kind: 'ok', data }
  },
}

export const requestWarrantTool: WarrantTool<typeof requestWarrantInputSchema, WarrantOpened> = {
  name: 'request_warrant',
  title: 'Open a bonded warrant',
  description:
    "Ouvre un mandat cautionné pour l'action donnée et la fait exécuter par KeeperHub. Payant : la caution doit être financée via x402 avant l'ouverture. Rend le warrantId, l'executionId et les engagements conditionHash / actionHash. Si la post-condition est tenue, la caution revient ; sinon elle va au beneficiary. La caution est dérivée du calldata — elle ne se négocie pas.",
  input: requestWarrantInputSchema,
  output: requestWarrantOutputSchema,
  paid: true,
  readOnly: false,
  async run(client, args, ctx) {
    const parsed = parseArgs(requestWarrantInputSchema, args)
    const actionSpec = toActionSpec(parsed.actionSpec)
    const beneficiary = parsed.beneficiary as Address
    const result = await callGateway(() =>
      client.requestWarrant({ actionSpec, beneficiary }, ctx?.payment),
    )
    if (result.status === 'payment-required') {
      return { kind: 'payment-required', paymentRequired: result.paymentRequired }
    }
    return { kind: 'ok', data: result.warrant, settlement: result.settlement }
  },
}

export const getWarrantTool: WarrantTool<typeof getWarrantInputSchema, WarrantView> = {
  name: 'get_warrant',
  title: 'Read a warrant and its verdict',
  description:
    "Rend un mandat, son état et — s'il est réglé — le verdict complet avec le détail checks[] : une ligne par vérification, y compris celles qui passent, plus le bloc exact d'évaluation. C'est ce qui rend un verdict rejouable par un tiers plutôt que cru sur parole.",
  input: getWarrantInputSchema,
  output: getWarrantOutputSchema,
  paid: false,
  readOnly: true,
  async run(client, args) {
    const { warrantId } = parseArgs(getWarrantInputSchema, args)
    const view = await callGateway(() => client.getWarrant(warrantId as Hex))
    if (view === null) {
      throw new WarrantError('warrant_not_found', `Aucun mandat sous l'id ${warrantId}.`, {
        field: '$.warrantId',
      })
    }
    return { kind: 'ok', data: view }
  },
}

export const listWarrantsTool: WarrantTool<typeof listWarrantsInputSchema, ListWarrantsResult> = {
  name: 'list_warrants',
  title: 'List an agent warrants and statistics',
  description:
    "Énumère les mandats d'un agent avec leurs statistiques agrégées : nombre honoré, saisi, total cautionné, taux d'honneur. Filtrable par état, catégorie et fenêtre temporelle. Sert à répondre à « quel est le bilan de cet agent ? » sans lire la chaîne.",
  input: listWarrantsInputSchema,
  output: listWarrantsOutputSchema,
  paid: false,
  readOnly: true,
  async run(client, args) {
    const query = parseArgs(listWarrantsInputSchema, args)
    const data = await callGateway(() =>
      client.listWarrants({ ...query, agent: query.agent as Address }),
    )
    return { kind: 'ok', data }
  },
}

/** L'ordre est celui de docs/09 § 2 — devis, mandat, lecture, historique. */
export const WARRANT_TOOLS = [
  quoteRiskTool,
  requestWarrantTool,
  getWarrantTool,
  listWarrantsTool,
] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWarrantTool = WarrantTool<z.ZodObject<z.ZodRawShape>, any>

export const WARRANT_TOOL_NAMES = WARRANT_TOOLS.map((t) => t.name) as readonly string[]

export function warrantToolByName(name: string): AnyWarrantTool | undefined {
  return (WARRANT_TOOLS as readonly AnyWarrantTool[]).find((t) => t.name === name)
}

export interface RunToolOptions {
  wallet?: PaymentSigner | undefined
  /** Rejeux de paiement autorisés. Borné : un wallet agentique n'a pas d'humain qui regarde. */
  maxPaymentAttempts?: number
}

/**
 * Exécute un outil en réglant la caution si un wallet est fourni.
 *
 * La boucle de paiement vit ici, une seule fois, pour que ni le client HTTP ni
 * les adaptateurs de framework n'aient à la réimplémenter — c'est précisément
 * le genre de duplication qui fait diverger cinq surfaces.
 */
export async function runTool<T = unknown>(
  client: GatewayClient,
  tool: AnyWarrantTool,
  args: unknown,
  options: RunToolOptions = {},
): Promise<ToolOutcome<T>> {
  const max = options.maxPaymentAttempts ?? 1
  let outcome = (await tool.run(client, args)) as ToolOutcome<T>
  let attempts = 0

  while (outcome.kind === 'payment-required' && options.wallet && attempts < max) {
    attempts += 1
    let payment: PaymentPayload
    try {
      payment = await options.wallet.createPayment(outcome.paymentRequired)
    } catch (err) {
      throw new WarrantError('payment_invalid', `Le wallet a refusé de signer : ${String(err)}`, {
        details: outcome.paymentRequired,
        cause: err,
      })
    }
    outcome = (await tool.run(client, args, { payment })) as ToolOutcome<T>
  }
  return outcome
}

/** Même chose, par nom d'outil. */
export async function runToolByName<T = unknown>(
  client: GatewayClient,
  name: string,
  args: unknown,
  options: RunToolOptions = {},
): Promise<ToolOutcome<T>> {
  const tool = warrantToolByName(name)
  if (!tool) {
    throw new WarrantError('invalid_input', `Outil inconnu : ${name}.`, {
      hint: `Les outils disponibles sont ${WARRANT_TOOL_NAMES.join(', ')}.`,
    })
  }
  return runTool<T>(client, tool, args, options)
}
