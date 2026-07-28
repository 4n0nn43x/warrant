/**
 * Le serveur MCP de Warrant.
 *
 * ```bash
 * claude mcp add --transport http warrant https://mcp.warrant.sh
 * ```
 *
 * Quatre outils, projetés depuis `@warrant/sdk` — le serveur ne redéfinit ni
 * schéma, ni description, ni logique. Il ne fait que deux choses que le SDK ne
 * peut pas faire : parler JSON-RPC, et implémenter le transport x402 v2 sur MCP
 * (docs/05 § 1.7).
 *
 * Choix d'implémentation à expliciter : on utilise le `Server` bas niveau
 * plutôt que `McpServer`. `McpServer` valide les arguments lui-même et lève un
 * `McpError` JSON-RPC quand ils sont invalides — l'erreur sort alors du produit
 * sans `hint` ni lien de doc, ce que la checklist DX interdit (docs/09 § 8).
 * Ici, **toute** erreur revient en résultat d'outil structuré et actionnable.
 * L'agent qui la reçoit peut se corriger au tour suivant ; c'est le seul
 * critère qui compte.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import {
  WARRANT_TOOLS,
  WarrantError,
  toWarrantError,
  warrantToolByName,
  type AnyWarrantTool,
  type GatewayClient,
} from '@warrant/sdk'
import { z } from 'zod'

import { dualFormat, extractPayment, paymentRequiredResult, withSettlement } from './x402-mcp.js'

export interface WarrantMcpOptions {
  /** Le Gateway Warrant. Mocké dans les tests, câblé au HTTP en production. */
  client: GatewayClient
  name?: string
  version?: string
}

const SERVER_INSTRUCTIONS = `Warrant transforme une action onchain en engagement cautionné.

Séquence recommandée :
1. quote_risk — gratuit. Donne la caution, le taux de risque et la post-condition qui sera engagée.
2. request_warrant — payant. Ouvre le mandat, finance la caution via x402, déclenche l'exécution KeeperHub.
3. get_warrant — lit le verdict et le détail checks[] une fois le mandat réglé.
4. list_warrants — historique et statistiques d'un agent.

À savoir avant d'appeler : la catégorie de l'action et son notionnel sont dérivés du calldata, jamais
déclarés. Aucun outil n'accepte de champ category ni notional ; en glisser un ne change rien au prix.

request_warrant appelé sans paiement retourne un résultat en erreur contenant un objet PaymentRequired
x402 v2. Réglez-le, puis rappelez le même outil avec le PaymentPayload dans _meta["x402/payment"].`

/** JSON Schema draft-7 — ce qu'attend `tools/list`. */
function toJsonSchema(schema: z.ZodType): Tool['inputSchema'] {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Tool['inputSchema']
}

/**
 * Descripteur → entrée de `tools/list`.
 *
 * `additionalProperties` est laissé absent volontairement. Un `category`
 * parasite dans l'`actionSpec` doit être **ignoré**, pas rejeté : le rejeter
 * apprendrait à l'agent que le champ existe quelque part, alors qu'il n'existe
 * nulle part. Le nettoyage est fait au parsing, côté SDK.
 */
export function describeTool(tool: AnyWarrantTool): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toJsonSchema(tool.input),
    // Pas d'`outputSchema`, et c'est délibéré.
    //
    // Le client MCP officiel met en cache l'`outputSchema` annoncé et valide
    // **tout** `structuredContent` reçu contre lui, y compris sur un résultat
    // `isError: true` (`client/index.js`, `callTool` : le commentaire du SDK dit
    // le contraire de ce que fait le code). Or nos deux chemins d'erreur
    // placent justement un objet dans `structuredContent` : le `PaymentRequired`
    // du transport x402, que la spec impose (docs/05 § 1.7), et nos erreurs
    // actionnables. Annoncer un `outputSchema` ferait donc lever une `McpError`
    // au client à la place du 402 — le flux de paiement serait cassé avec le
    // client de référence.
    //
    // Les schémas de sortie existent quand même (`tool.output`, dans
    // `@warrant/sdk`) : ils typent le SDK et alimenteront l'OpenAPI. Ils ne
    // sont simplement pas annoncés sur ce transport-ci.
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      idempotentHint: tool.readOnly,
      openWorldHint: true,
    },
    _meta: {
      /**
       * Découverte : un client sait, avant d'appeler, lequel des quatre outils
       * exigera un paiement. C'est l'équivalent MCP de `x-payment-info` sur
       * l'OpenAPI (docs/09 § 1).
       */
      'x402/paid': tool.paid,
    },
  }
}

/** Toute erreur sort par ici — structurée, avec `hint` et lien de doc. */
function errorResult(err: unknown): CallToolResult {
  const warrantError = toWarrantError(err)
  return dualFormat(warrantError.toJSON() as unknown as Record<string, unknown>, true)
}

export function createWarrantMcpServer(options: WarrantMcpOptions): Server {
  const { client } = options

  const server = new Server(
    { name: options.name ?? 'warrant', version: options.version ?? '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (WARRANT_TOOLS as readonly AnyWarrantTool[]).map(describeTool),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args, _meta } = request.params

    const tool = warrantToolByName(name)
    if (!tool) {
      return errorResult(
        new WarrantError('invalid_input', `Outil inconnu : ${name}.`, {
          hint: `Les outils disponibles sont ${WARRANT_TOOLS.map((t) => t.name).join(', ')}.`,
        }),
      )
    }

    // Étape 3 du flux : le paiement, s'il est là, voyage dans `_meta`.
    const payment = extractPayment(_meta)

    try {
      const outcome = await tool.run(client, args ?? {}, payment ? { payment } : undefined)

      if (outcome.kind === 'payment-required') {
        // Étape 2 : `isError: true` + PaymentRequired dans les deux formats.
        return paymentRequiredResult(outcome.paymentRequired)
      }

      // Étape 6 : le règlement revient dans `_meta["x402/payment-response"]`.
      return withSettlement(
        dualFormat(outcome.data as Record<string, unknown>),
        outcome.settlement,
      )
    } catch (err) {
      return errorResult(err)
    }
  })

  return server
}
