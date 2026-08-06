#!/usr/bin/env node
/**
 * Entry point of the MCP server.
 *
 * ```bash
 * WARRANT_GATEWAY_URL=https://gateway.example pnpm --filter @warrant/mcp start
 * claude mcp add --transport http warrant http://localhost:8787/mcp
 * ```
 *
 * A single execution path, and a single Gateway: the real one. There used to be a
 * `WARRANT_MOCK` flag here that wired in an in-memory Gateway taking payments on
 * trust; it has been removed. A binary that can start in a mode where "everything
 * works" without anything being verified is a binary whose output proves nothing —
 * and an environment variable is exactly the kind of switch that one day gets left
 * in the wrong position. The in-memory double still exists
 * (`src/mock-gateway.ts`) and remains useful, but for the tests only: it is no
 * longer reachable from a binary.
 */

import { WarrantClient, type GatewayClient } from '@warrant/sdk'

import { createWarrantHttpServer } from '../http.js'

const port = Number(process.env['WARRANT_MCP_PORT'] ?? 8787)
const host = process.env['WARRANT_MCP_HOST'] ?? '127.0.0.1'
const baseUrl = process.env['WARRANT_GATEWAY_URL'] ?? 'http://localhost:8080'
const path = process.env['WARRANT_MCP_PATH'] ?? '/mcp'

const client: GatewayClient = new WarrantClient({ baseUrl })

// Listens on the loopback interface by default, not on 0.0.0.0: a server that
// opens paid warrants has no business being on every interface until the operator
// has explicitly asked for it.
createWarrantHttpServer({ client, path }).listen(port, host, () => {
  process.stderr.write(
    `warrant mcp — listening on http://${host}:${port}${path} (gateway ${baseUrl})\n` +
      `MCP protocol 2026-07-28; clients still on 2025 are served by fallback\n` +
      `claude mcp add --transport http warrant http://${host}:${port}${path}\n`,
  )
})
