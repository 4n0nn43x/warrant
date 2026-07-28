/**
 * Adaptateur Vercel AI SDK.
 *
 * Contrainte de conception explicite (docs/09 § 5) : **moins de 100 lignes**.
 * Tout ce qui pourrait grossir ici appartient à `tools.ts`, qui est la source
 * unique. Un adaptateur qui contient de la logique métier est un adaptateur qui
 * divergera de ses quatre frères.
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
 * Aucun import depuis `ai` : un outil du Vercel AI SDK est un objet nu
 * `{ description, inputSchema, execute }`, et `tool()` n'est qu'une fonction
 * d'identité pour l'inférence de types. Ne pas dépendre du paquet évite d'en
 * suivre les versions majeures pour rien.
 */

import type { z } from 'zod'

import { WarrantClient } from './client.js'
import type { WarrantClientOptions } from './client.js'
import type { GatewayClient } from './gateway.js'
import type { AnyWarrantTool } from './tools.js'
import { WARRANT_TOOLS, runTool } from './tools.js'
import type { PaymentSigner } from './x402.js'

/** Forme structurelle d'un outil Vercel AI SDK. */
export interface AiTool {
  description: string
  inputSchema: z.ZodTypeAny
  execute: (args: unknown) => Promise<unknown>
}

export interface WarrantToolsOptions {
  /** Signataire de la caution. Sans lui, `request_warrant` s'arrête au 402. */
  wallet?: PaymentSigner
  /** Client déjà construit — n'importe quelle implémentation de `GatewayClient`. */
  client?: GatewayClient
  baseUrl?: string
  fetch?: WarrantClientOptions['fetch']
  /** Restreint le jeu exposé au modèle, ex. `['quote_risk']` en lecture seule. */
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
          // Rendu, pas levé : le modèle doit pouvoir lire l'exigence de paiement
          // et décider. C'est le pendant du choix de rendre quote_risk gratuit.
          return {
            paymentRequired: outcome.paymentRequired,
            hint: "La caution doit être financée. Passe un wallet à warrantTools({ wallet }), puis rappelle request_warrant.",
          }
        },
      } satisfies AiTool,
    ]),
  )
}
