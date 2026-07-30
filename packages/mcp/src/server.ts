/**
 * Le serveur MCP de Warrant — révision de protocole 2026-07-28.
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
 *
 * Le raisonnement survit intact au passage au SDK v2 : `registerTool()` y
 * valide toujours les arguments contre le schéma avant d'appeler le callback,
 * et une violation devient une erreur de protocole. Le `Server` bas niveau, lui,
 * nous laisse recevoir les arguments bruts et les faire passer par le parsing
 * du SDK Warrant, qui produit des `WarrantError` porteuses de `field`, `hint` et
 * `docs`.
 *
 * Ce que le SDK v2 prend en charge et qu'on n'écrit donc pas ici : le champ
 * `resultType` (`"complete"` est posé par le codec 2026-07-28 au moment de
 * l'encodage — un handler ne l'écrit jamais lui-même), la validation
 * en-tête↔corps (`-32020`), le `405` sur GET/DELETE, et le service des clients
 * 2025 restés en arrière. Voir `http.ts`.
 */

import { Server, type CacheHint, type CallToolResult, type Tool } from '@modelcontextprotocol/server'
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

/**
 * Ce que le serveur promet sur la fraîcheur de `tools/list` (SEP-2549).
 *
 * `cacheScope: 'public'` : la liste ne varie pas selon l'appelant. `WARRANT_TOOLS`
 * est une constante du paquet, aucun outil n'est masqué par autorisation — la
 * spec autorise alors explicitement les caches partagés (`server/tools` : le
 * jeu d'outils « MUST NOT vary per-connection », il ne peut varier que « by the
 * authorization presented on the request », ce qui n'est pas notre cas).
 *
 * `ttlMs` d'une heure : ces quatre outils sont figés à la compilation, et la
 * seule chose qui les change est un redéploiement — lequel remplace le
 * processus. Une heure est donc un pari sur la fréquence de nos déploiements,
 * pas sur la stabilité du produit. Le pari est bon marché parce que se tromper
 * coûte peu : un agent qui appellerait un nom d'outil disparu reçoit l'erreur
 * `invalid_input` qui **liste les outils réellement disponibles** (voir plus
 * bas), donc il se corrige au tour suivant sans intervention. Le défaut du SDK
 * (`ttlMs: 0`) ferait au contraire refaire un `tools/list` à chaque tour d'un
 * agent, sur une liste qui n'a pas bougé depuis le début du hackathon.
 */
const TOOLS_LIST_CACHE_HINT: CacheHint = {
  ttlMs: 3_600_000,
  cacheScope: 'public',
}

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
 *
 * Aucune propriété ne porte l'annotation `x-mcp-header` de 2026-07-28, et c'est
 * délibéré. Cette annotation demande au client de recopier la valeur d'un
 * paramètre dans un en-tête `Mcp-Param-{Name}` pour que les intermédiaires
 * (load balancers, WAF) puissent router sans lire le corps. Nos paramètres sont
 * soit des objets (`actionSpec`, non éligible — l'annotation est réservée aux
 * types primitifs), soit des identités onchain (`agent`, `beneficiary`,
 * `warrantId`) ; et la spec avertit précisément de ne pas exposer de PII ou
 * d'identifiants sensibles en en-tête, « visible[s] to network intermediaries ».
 * L'adresse d'un agent et l'identifiant d'un mandat sont exactement ce qu'on ne
 * veut pas voir apparaître dans les logs de chaque proxy traversé.
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
    // `isError: true`. Or nos deux chemins d'erreur placent justement un objet
    // dans `structuredContent` : le `PaymentRequired` du transport x402, que la
    // spec impose (docs/05 § 1.7), et nos erreurs actionnables. Annoncer un
    // `outputSchema` ferait donc lever une erreur au client à la place du 402 —
    // le flux de paiement serait cassé avec le client de référence.
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
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
      // Le SDK pose `ttlMs`/`cacheScope` sur le résultat au moment de l'encodage
      // 2026-07-28 et les omet pour un client 2025, qui n'a pas ce vocabulaire.
      // Passer par cette option plutôt que par le retour du handler évite d'avoir
      // à savoir, dans le handler, à quelle révision on répond.
      cacheHints: { 'tools/list': TOOLS_LIST_CACHE_HINT },
    },
  )

  server.setRequestHandler('tools/list', async () => ({
    tools: (WARRANT_TOOLS as readonly AnyWarrantTool[]).map(describeTool),
  }))

  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
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
    //
    // En 2026-07-28 le SDK a déjà extrait de ce `_meta` les clés réservées
    // `io.modelcontextprotocol/*` (version de protocole, identité et capacités
    // du client) : ce qu'on lit ici est le `_meta` applicatif, celui du client.
    const payment = extractPayment(_meta)

    try {
      const outcome = await tool.run(client, args ?? {}, payment ? { payment } : undefined)

      if (outcome.kind === 'payment-required') {
        // Étape 2 : `isError: true` + PaymentRequired dans les deux formats.
        // Pourquoi pas MRTR (`resultType: "input_required"`) : voir `x402-mcp.ts`.
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
