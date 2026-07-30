/**
 * Vercel AI SDK adapter.
 *
 * Explicit design constraint (docs/09 § 5): **under 100 lines**. Anything that
 * might grow here belongs in `tools.ts`, which is the single source. An adapter
 * that contains business logic is an adapter that will drift away from its four
 * siblings.
 *
 * ```ts
 * import { warrantTools } from '@warrant/sdk/ai'
 *
 * const result = await generateText({
 *   model: anthropic('claude-opus-5'),
 *   tools: warrantTools({ wallet }),
 *   prompt: 'Rebalance the Aave position, keep health factor above 1.5',
 * })
 * ```
 *
 * No import from `ai`: a Vercel AI SDK tool is a bare object
 * `{ description, inputSchema, execute }`, and `tool()` is nothing but an
 * identity function for type inference. Not depending on the package spares us
 * from tracking its major versions for nothing.
 */

import type { z } from 'zod'

import { WarrantClient } from './client.js'
import type { WarrantClientOptions } from './client.js'
import type { GatewayClient } from './gateway.js'
import type { AnyWarrantTool } from './tools.js'
import { WARRANT_TOOLS, runTool } from './tools.js'
import type { PaymentSigner } from './x402.js'

/** Structural shape of a Vercel AI SDK tool. */
export interface AiTool {
  description: string
  inputSchema: z.ZodTypeAny
  execute: (args: unknown) => Promise<unknown>
}

export interface WarrantToolsOptions {
  /** Signer of the bond. Without it, `request_warrant` stops at the 402. */
  wallet?: PaymentSigner
  /** An already-built client — any implementation of `GatewayClient`. */
  client?: GatewayClient
  baseUrl?: string
  fetch?: WarrantClientOptions['fetch']
  /** Restricts the set exposed to the model, e.g. `['quote_risk']` for read-only. */
  only?: readonly string[]
}

const DEFAULT_BASE_URL = 'https://api.warrant.sh'

export function warrantTools(options: WarrantToolsOptions = {}): Record<string, AiTool> {
  const client: GatewayClient =
    options.client ??
    new WarrantClient({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      ...(options.wallet ? { wallet: options.wallet } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })

  const selected = options.only
    ? (WARRANT_TOOLS as readonly AnyWarrantTool[]).filter((t) => options.only?.includes(t.name))
    : (WARRANT_TOOLS as readonly AnyWarrantTool[])

  return Object.fromEntries(
    selected.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        async execute(args: unknown) {
          const outcome = await runTool(client, tool, args, { wallet: options.wallet })
          if (outcome.kind === 'ok') {
            return outcome.settlement
              ? { ...(outcome.data as object), settlement: outcome.settlement }
              : outcome.data
          }
          // Returned, not thrown: the model must be able to read the payment
          // requirement and decide. This is the counterpart of the choice to
          // make quote_risk free.
          return {
            paymentRequired: outcome.paymentRequired,
            hint: 'The bond must be funded. Pass a wallet to warrantTools({ wallet }), then call request_warrant again.',
          }
        },
      } satisfies AiTool,
    ]),
  )
}
