/**
 * Transport HTTP streamable — révision 2026-07-28.
 *
 * Mode **stateless**, et ce n'est plus un choix : la révision 2026-07-28
 * supprime `initialize` et l'en-tête `Mcp-Session-Id`, il n'y a donc plus de
 * session au niveau du protocole. `createMcpHandler()` reçoit une fabrique et
 * l'appelle **par requête** ; le `Server` construit ne survit pas à la réponse.
 * Le serveur reste horizontalement scalable sans affinité de session, et un
 * redémarrage pendant la démo ne casse aucun client. Le coût est nul : nos
 * quatre outils sont sans état, toute la mémoire du produit est dans le contrat
 * et dans le Gateway.
 *
 * Ce que `createMcpHandler()` prend en charge, et qu'on n'écrit donc pas :
 *
 * - les en-têtes obligatoires `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`
 *   et leur validation contre le corps — une divergence répond `400` avec
 *   l'erreur JSON-RPC `-32020 HeaderMismatch`, comme l'exige
 *   basic/transports/streamable-http § Server Validation ;
 * - le `405 Method Not Allowed` sur GET et DELETE, vestiges des sessions 2025 ;
 * - le champ `resultType` sur chaque résultat, posé par le codec 2026-07-28 ;
 * - le service des clients restés en 2025 (option `legacy`, ci-dessous).
 *
 * Sur la compatibilité descendante : `legacy: 'stateless'` est le défaut du SDK
 * et on le garde. Une requête sans en-tête d'enveloppe — c'est-à-dire tout
 * client antérieur à 2026-07-28 — est routée vers un service 2025 sans session,
 * servi par la même fabrique. Autrement dit, la migration ne coupe personne : un
 * client 2025 et un client 2026 sont servis par le même processus, sur le même
 * chemin, avec les mêmes quatre outils. C'était la condition pour migrer un
 * lendemain de publication de la spec.
 */

import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http'

import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'

import { createWarrantMcpServer, type WarrantMcpOptions } from './server.js'

export interface WarrantHttpOptions extends WarrantMcpOptions {
  /** Chemin de l'endpoint MCP. */
  path?: string
  /**
   * Origines autorisées à parler au serveur depuis un navigateur.
   *
   * La spec impose de valider `Origin` sur toute connexion entrante et de
   * répondre `403` si l'en-tête est présent et invalide — c'est la protection
   * contre le **DNS rebinding** : sans elle, une page web quelconque ouverte
   * dans le navigateur du builder peut appeler son serveur MCP local et ouvrir
   * des mandats en son nom. Le risque n'est pas théorique ici : nos outils
   * dépensent de l'argent.
   *
   * Une requête **sans** `Origin` est acceptée : les clients MCP non-navigateur
   * (Claude Code, `curl`, le SDK) n'en envoient pas, et la spec ne vise que
   * l'en-tête présent et invalide.
   */
  allowedOrigins?: string[]
}

/** Origines acceptées par défaut : le poste du builder, sur n'importe quel port. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function originAllowed(origin: string, allowed: string[] | undefined): boolean {
  if (allowed) return allowed.includes(origin)
  return LOCAL_ORIGIN.test(origin)
}

/** Le handler Node d'un endpoint MCP, et de quoi le refermer. */
export interface WarrantMcpNodeHandler {
  /** `(req, res, parsedBody?)` — à monter sous le chemin de son choix. */
  handle: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
  /** Interrompt les échanges en vol et libère les instances par requête. */
  close: () => Promise<void>
}

/**
 * Construit le handler MCP. Exporté séparément pour pouvoir être monté dans un
 * serveur HTTP existant plutôt que d'en imposer un.
 *
 * Le handler est **durable** — c'est lui qui porte le routage 2025/2026 — alors
 * que le `Server` Warrant, lui, est reconstruit à chaque requête par la
 * fabrique. Là où la v1 demandait de fabriquer serveur *et* transport à chaque
 * appel et de les refermer à la main sur `res.on('close')`, la v2 fait ce
 * ménage pour nous ; il n'y a plus de `Server` à oublier de fermer.
 */
export function createWarrantMcpNodeHandler(options: WarrantMcpOptions): WarrantMcpNodeHandler {
  const handler = createMcpHandler(() => createWarrantMcpServer(options))
  const node = toNodeHandler(handler)

  return {
    handle: async (req, res, parsedBody) => {
      await node(req, res, parsedBody)
    },
    close: () => handler.close(),
  }
}

/** Serveur HTTP autonome — ce que lance `warrant-mcp`. */
export function createWarrantHttpServer(options: WarrantHttpOptions): NodeHttpServer {
  const path = options.path ?? '/mcp'
  const mcp = createWarrantMcpNodeHandler(options)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Avant tout routage : une origine présente et non autorisée ne doit pas
    // même apprendre quels chemins existent.
    const origin = req.headers.origin
    if (typeof origin === 'string' && !originAllowed(origin, options.allowedOrigins)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            code: 'forbidden_origin',
            message: `Origine refusée : ${origin}.`,
            hint:
              "Protection contre le DNS rebinding. Un client MCP hors navigateur n'envoie pas " +
              "d'en-tête Origin et n'est pas concerné ; pour autoriser une origine web, passe-la " +
              'dans `allowedOrigins`.',
            docs: 'https://warrant.sh/docs/mcp#origin',
          },
        }),
      )
      return
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            code: 'not_found',
            message: `Aucune ressource sous ${url.pathname}.`,
            hint: `L'endpoint MCP est ${path}. Ajoute le serveur avec : claude mcp add --transport http warrant <url>${path}`,
            docs: 'https://warrant.sh/docs/mcp',
          },
        }),
      )
      return
    }

    void mcp.handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            code: 'internal_error',
            message: String(err),
            hint: 'Réessaie ; aucun mandat ni paiement n\'a été engagé par une requête ayant échoué ici.',
            docs: 'https://warrant.sh/docs/troubleshooting#mcp',
          },
        }),
      )
    })
  })

  // Fermer le serveur HTTP doit aussi fermer le handler MCP : sans cela, les
  // échanges en vol maintiennent le process en vie après un `close()`.
  server.on('close', () => {
    void mcp.close()
  })

  return server
}
