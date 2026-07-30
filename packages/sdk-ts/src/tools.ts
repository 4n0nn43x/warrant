/**
 * The single source of the four tools.
 *
 * Four, not five: `execute_metered` disappeared along with the routine regime
 * (docs/09 § 2, docs/03 § "One regime, two rails"). Four, not fifteen: the
 * catalogue is deliberately small, because an agent chooses badly among fifteen
 * tools.
 *
 * Everything below is framework-agnostic. The MCP server and the Vercel AI
 * adapter do nothing but project these descriptors — that is the "one single
 * source, adapters under 100 lines" structure that won the previous hackathon
 * (docs/09 § intro).
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
  /** Payment supplied by the client — on MCP, `_meta["x402/payment"]`. */
  payment?: PaymentPayload | undefined
}

/**
 * Outcome of a tool call.
 *
 * `payment-required` is not an error from the domain's point of view: it is
 * step 2 of the x402 transport (docs/05 § 1.7). Adapters are free to represent
 * it as an error — MCP requires it — but the core does not.
 */
export type ToolOutcome<T> =
  | { kind: 'ok'; data: T; settlement?: SettlementResponse | undefined }
  | { kind: 'payment-required'; paymentRequired: PaymentRequired }

export interface WarrantTool<TInput extends z.ZodObject<z.ZodRawShape>, TOutput> {
  name: string
  title: string
  description: string
  input: TInput
  /** Minimal output contract, published as `outputSchema` by `tools/list`. */
  output: z.ZodObject<z.ZodRawShape>
  /** `true` for `request_warrant` alone: the bond must be funded. */
  paid: boolean
  /** None of these tools mutates onchain state beyond the payment itself. */
  readOnly: boolean
  run(client: GatewayClient, args: unknown, ctx?: ToolContext): Promise<ToolOutcome<TOutput>>
}

/**
 * Parses and **strips** the arguments.
 *
 * The stripping is the security point: the returned value contains only the
 * keys of the schema, so a `category` field slipped into the `actionSpec` can
 * reach neither the Classifier nor the `actionHash`.
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
    hint: `Fix ${field} then call the tool again. Reminder: neither category nor notional is accepted — both are derived from the calldata.`,
    details: parsed.error.issues,
  })
}

/**
 * Double validation of the `actionSpec`: Zod for the shape, `@warrant/core` for
 * the domain invariants.
 *
 * Redundant in appearance, useful in practice: the core is the authority on what
 * is hashable, and it is the core that names the offending field exactly as the
 * Gateway will. Letting the two validations diverge means accepting that a
 * warrant be accepted here and rejected three milliseconds later.
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
    'Estimates the bond required for an action, committing nothing and paying nothing. Classifies the calldata, derives the notional from it, then returns the bond, the risk rate and the post-condition that will be committed. Call this before request_warrant: it is free, and it is the only way to learn the cost before committing. The category and the notional are derived from the calldata; they cannot be declared.',
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
    'Opens a bonded warrant for the given action and has KeeperHub execute it. Paid: the bond must be funded via x402 before the warrant opens. Returns the warrantId, the executionId and the conditionHash / actionHash commitments. If the post-condition holds, the bond comes back; otherwise it goes to the beneficiary. The bond is derived from the calldata — it is not negotiable.',
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
    'Returns a warrant, its status and — once it is settled — the full verdict with the checks[] detail: one row per check, including the ones that pass, plus the exact block of evaluation. That is what makes a verdict replayable by a third party rather than taken on trust.',
  input: getWarrantInputSchema,
  output: getWarrantOutputSchema,
  paid: false,
  readOnly: true,
  async run(client, args) {
    const { warrantId } = parseArgs(getWarrantInputSchema, args)
    const view = await callGateway(() => client.getWarrant(warrantId as Hex))
    if (view === null) {
      throw new WarrantError('warrant_not_found', `No warrant under id ${warrantId}.`, {
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
    "Lists an agent's warrants along with their aggregated statistics: number honored, number slashed, total bonded, honor rate. Filterable by status, category and time window. Use it to answer \"what is this agent's track record?\" without reading the chain.",
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

/** The order is that of docs/09 § 2 — quote, warrant, read, history. */
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
  /** Payment replays allowed. Bounded: an agentic wallet has no human watching. */
  maxPaymentAttempts?: number
}

/**
 * Runs a tool, settling the bond if a wallet is supplied.
 *
 * The payment loop lives here, once, so that neither the HTTP client nor the
 * framework adapters have to reimplement it — that is precisely the kind of
 * duplication that makes five surfaces drift apart.
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
      throw new WarrantError('payment_invalid', `The wallet refused to sign: ${String(err)}`, {
        details: outcome.paymentRequired,
        cause: err,
      })
    }
    outcome = (await tool.run(client, args, { payment })) as ToolOutcome<T>
  }
  return outcome
}

/** Same thing, by tool name. */
export async function runToolByName<T = unknown>(
  client: GatewayClient,
  name: string,
  args: unknown,
  options: RunToolOptions = {},
): Promise<ToolOutcome<T>> {
  const tool = warrantToolByName(name)
  if (!tool) {
    throw new WarrantError('invalid_input', `Unknown tool: ${name}.`, {
      hint: `The available tools are ${WARRANT_TOOL_NAMES.join(', ')}.`,
    })
  }
  return runTool<T>(client, tool, args, options)
}
