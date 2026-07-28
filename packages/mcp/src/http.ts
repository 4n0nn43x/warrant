/**
 * Transport HTTP streamable.
 *
 * Mode **stateless** : un `Server` et un transport neufs par requête, aucune
 * session en mémoire. Le serveur devient alors horizontalement scalable sans
 * affinité de session — et surtout, un redémarrage pendant la démo ne casse
 * aucun client connecté. Le coût est nul : nos quatre outils sont sans état,
 * toute la mémoire du produit est dans le contrat et dans le Gateway.
 */

import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createWarrantMcpServer, type WarrantMcpOptions } from './server.js'

export interface WarrantHttpOptions extends WarrantMcpOptions {
  /** Chemin de l'endpoint MCP. */
  path?: string
}

/**
 * Traite une requête MCP. Exportée séparément pour pouvoir être montée dans un
 * serveur HTTP existant plutôt que d'en imposer un.
 */
export async function handleMcpRequest(
  options: WarrantMcpOptions,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const server = createWarrantMcpServer(options)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  // Le transport est jetable : on le ferme dès que la réponse est partie, sinon
  // chaque requête laisserait un `Server` vivant derrière elle.
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(req, res, parsedBody)
}

/** Serveur HTTP autonome — ce que lance `warrant-mcp`. */
export function createWarrantHttpServer(options: WarrantHttpOptions): NodeHttpServer {
  const path = options.path ?? '/mcp'

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

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

    void handleMcpRequest(options, req, res).catch((err: unknown) => {
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
}
