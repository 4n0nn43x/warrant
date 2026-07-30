/**
 * Streamable HTTP transport — 2026-07-28 revision.
 *
 * **Stateless** mode, and that is no longer a choice: the 2026-07-28 revision
 * removes `initialize` and the `Mcp-Session-Id` header, so there is no longer any
 * session at the protocol level. `createMcpHandler()` receives a factory and
 * calls it **per request**; the `Server` it builds does not outlive the response.
 * The server stays horizontally scalable with no session affinity, and a restart
 * during the demo breaks no client. The cost is nil: our four tools are
 * stateless, all of the product's memory lives in the contract and in the
 * Gateway.
 *
 * What `createMcpHandler()` takes care of, and which we therefore do not write:
 *
 * - the mandatory `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers and
 *   their validation against the body — a divergence answers `400` with the
 *   JSON-RPC error `-32020 HeaderMismatch`, as
 *   basic/transports/streamable-http § Server Validation requires;
 * - the `405 Method Not Allowed` on GET and DELETE, relics of the 2025 sessions;
 * - the `resultType` field on every result, set by the 2026-07-28 codec;
 * - serving clients that stayed on 2025 (the `legacy` option, below).
 *
 * On backward compatibility: `legacy: 'stateless'` is the SDK default and we keep
 * it. A request with no envelope header — that is, any client older than
 * 2026-07-28 — is routed to a sessionless 2025 service, served by the same
 * factory. In other words, the migration cuts nobody off: a 2025 client and a
 * 2026 client are served by the same process, on the same path, with the same
 * four tools. That was the condition for migrating the day after the spec was
 * published.
 */

import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http'

import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'

import { createWarrantMcpServer, type WarrantMcpOptions } from './server.js'

export interface WarrantHttpOptions extends WarrantMcpOptions {
  /** Path of the MCP endpoint. */
  path?: string
  /**
   * Origins allowed to talk to the server from a browser.
   *
   * The spec requires validating `Origin` on every incoming connection and
   * answering `403` if the header is present and invalid — this is the protection
   * against **DNS rebinding**: without it, any web page open in the builder's
   * browser can call their local MCP server and open warrants in their name. The
   * risk is not theoretical here: our tools spend money.
   *
   * A request **without** an `Origin` is accepted: non-browser MCP clients
   * (Claude Code, `curl`, the SDK) do not send one, and the spec only targets the
   * header when it is present and invalid.
   */
  allowedOrigins?: string[]
}

/** Origins accepted by default: the builder's own machine, on any port. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function originAllowed(origin: string, allowed: string[] | undefined): boolean {
  if (allowed) return allowed.includes(origin)
  return LOCAL_ORIGIN.test(origin)
}

/** The Node handler for an MCP endpoint, and the means to shut it down. */
export interface WarrantMcpNodeHandler {
  /** `(req, res, parsedBody?)` — to be mounted under the path of your choice. */
  handle: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
  /** Interrupts in-flight exchanges and releases the per-request instances. */
  close: () => Promise<void>
}

/**
 * Builds the MCP handler. Exported separately so it can be mounted inside an
 * existing HTTP server rather than imposing one.
 *
 * The handler is **durable** — it is what carries the 2025/2026 routing — whereas
 * the Warrant `Server` is rebuilt on every request by the factory. Where v1
 * required manufacturing both server *and* transport on every call and closing
 * them by hand on `res.on('close')`, v2 does that housekeeping for us; there is
 * no longer a `Server` one can forget to close.
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

/** Standalone HTTP server — what `warrant-mcp` launches. */
export function createWarrantHttpServer(options: WarrantHttpOptions): NodeHttpServer {
  const path = options.path ?? '/mcp'
  const mcp = createWarrantMcpNodeHandler(options)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Before any routing: an origin that is present and not allowed must not even
    // get to learn which paths exist.
    const origin = req.headers.origin
    if (typeof origin === 'string' && !originAllowed(origin, options.allowedOrigins)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            code: 'forbidden_origin',
            message: `Origin refused: ${origin}.`,
            hint:
              'Protection against DNS rebinding. A non-browser MCP client sends no ' +
              'Origin header and is unaffected; to allow a web origin, pass it in ' +
              '`allowedOrigins`.',
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
            message: `No resource under ${url.pathname}.`,
            hint: `The MCP endpoint is ${path}. Add the server with: claude mcp add --transport http warrant <url>${path}`,
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
            hint: 'Retry; no warrant and no payment were committed by a request that failed here.',
            docs: 'https://warrant.sh/docs/troubleshooting#mcp',
          },
        }),
      )
    })
  })

  // Closing the HTTP server must also close the MCP handler: without that,
  // in-flight exchanges keep the process alive after a `close()`.
  server.on('close', () => {
    void mcp.close()
  })

  return server
}
