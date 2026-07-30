/**
 * Tool input schemas.
 *
 * The design point that matters fits in one sentence: **no schema accepts a
 * `category` or a `notional`**. Both are derived from the calldata by the
 * Classifier (docs/13 § 5). An agent able to declare its own category could
 * choose its own risk rate, and the threat model would collapse.
 *
 * That translates into two complementary guarantees:
 *
 * 1. the field does not exist in the JSON Schema published by `tools/list` — so
 *    a well-behaved agent never sends it;
 * 2. Zod silently **strips** every unknown key at parse time — an ill-behaved
 *    agent that sends it anyway sees it ignored, and above all: the value
 *    forwarded to the Gateway is the cleaned object, so the committed
 *    `actionHash` cannot depend on a stray field.
 *
 * Point 2 is the only one that holds up against a hostile client.
 */

import { z } from 'zod'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/

export const addressSchema = z
  .string()
  .regex(ADDRESS_RE, 'EVM address expected: 0x followed by 40 hexadecimal characters')

export const bytes32Schema = z
  .string()
  .regex(BYTES32_RE, 'bytes32 expected: 0x followed by 64 hexadecimal characters')

export const hexDataSchema = z
  .string()
  .regex(HEX_DATA_RE, 'hexadecimal calldata expected, whole number of bytes')

export const decimalSchema = z
  .string()
  .regex(DECIMAL_RE, 'canonical decimal integer expected: no sign, no leading zero')

/**
 * The committed transaction. The sole input to classification and pricing:
 * everything else follows from it.
 */
export const actionSpecSchema = z
  .object({
    version: z.literal(1),
    chainId: z.number().int().positive().describe('EVM chain ID of the executed transaction.'),
    target: addressSchema.describe('Contract being called.'),
    value: decimalSchema.describe('Native value sent, in wei, as a decimal string.'),
    calldata: hexDataSchema.describe(
      'Exact calldata of the transaction. It is from this — and from this alone — that the category, the notional and therefore the bond are derived.',
    ),
    registryRef: bytes32Schema.describe(
      'Hash of the classification registry version in use.',
    ),
  })
  .describe(
    'The transaction to execute. Accepts neither category nor notional: both are derived from the calldata, never declared.',
  )

export type ActionSpecInput = z.output<typeof actionSpecSchema>

export const quoteRiskInputSchema = z.object({
  actionSpec: actionSpecSchema,
  beneficiary: addressSchema
    .optional()
    .describe(
      'Beneficiary of a potential slash. Does not affect the price; used to build the post-condition.',
    ),
})

export const requestWarrantInputSchema = z.object({
  actionSpec: actionSpecSchema,
  beneficiary: addressSchema.describe(
    'Address that receives the bond if the post-condition is violated — the owner of the capital, never the agent.',
  ),
})

export const getWarrantInputSchema = z.object({
  warrantId: bytes32Schema.describe('Warrant identifier, as returned by request_warrant.'),
})

export const listWarrantsInputSchema = z.object({
  agent: addressSchema.describe('Agentic wallet whose warrants are being listed.'),
  status: z
    .enum(['open', 'honored', 'slashed', 'reclaimed'])
    .optional()
    .describe('Keep only the warrants in this status.'),
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
    .describe('After-the-fact filter on the derived category. Cannot be declared at opening time.'),
  since: z.number().int().nonnegative().optional().describe('Lower bound on openedAt, in Unix seconds.'),
  until: z.number().int().nonnegative().optional().describe('Upper bound on openedAt, in Unix seconds.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum number of warrants returned (default 20).'),
  cursor: z.string().optional().describe('Pagination cursor returned by a previous call.'),
})

export type QuoteRiskInput = z.output<typeof quoteRiskInputSchema>
export type RequestWarrantInput = z.output<typeof requestWarrantInputSchema>
export type GetWarrantInput = z.output<typeof getWarrantInputSchema>
export type ListWarrantsInput = z.output<typeof listWarrantsInputSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Output schemas
//
// Published (`tools/list` exposes them as `outputSchema`) but deliberately
// permissive: they describe the minimal contract the Gateway must honour, not
// the totality of what it may return. A closed output schema would turn any
// enrichment of the Gateway into an outage of the MCP server.
// ─────────────────────────────────────────────────────────────────────────────

const jsonObject = z.record(z.string(), z.unknown())

export const quoteRiskOutputSchema = z.object({
  category: z.string().describe('Category derived from the calldata.'),
  bond: z.string().describe('Bond required, in atomic units (USDC, 6 decimals).'),
  riskBps: z.number().describe('Risk rate applied, in basis points.'),
  notionalUSD: z.string().describe('Notional derived from the decoded arguments.'),
  conditionSpec: jsonObject.describe('Post-condition that will be committed under conditionHash.'),
  rationale: z.string().describe('One-sentence justification of the price.'),
})

export const requestWarrantOutputSchema = z.object({
  warrantId: bytes32Schema,
  executionId: z.string().describe('KeeperHub identifier of the execution.'),
  conditionHash: bytes32Schema.describe('keccak256(JCS(conditionSpec)) — immutable commitment.'),
  actionHash: bytes32Schema.describe('keccak256(JCS(actionSpec)) — commitment to what is being asked.'),
  expiry: z.number().describe('Past this point, honor/slash are closed and reclaim() is open.'),
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
  verdict: jsonObject.optional().describe('Present once the warrant is settled.'),
  checks: z
    .array(checkResultSchema)
    .describe(
      'One row per check, including the ones that pass — a partial verdict would not be auditable.',
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
    // These three names are the ones the Gateway actually serves
    // (`GET /v1/warrants`), and the ones the explorer consumes. The schema used
    // to declare `totalBonded` / `totalSlashed` / `honorRateBps`, which existed
    // nowhere else: an adapter generated from this single source therefore
    // promised fields absent from the response.
    //
    // The rule of this package is "nothing is declared, everything is derived".
    // A single source that does not describe the server is not a single source,
    // it is a second truth — exactly what this package exists to prevent.
    bondHonoredTotal: z.string(),
    bondSlashedTotal: z.string(),
    totalAtRisk: z.string(),
  }),
  nextCursor: z.string().optional(),
})
