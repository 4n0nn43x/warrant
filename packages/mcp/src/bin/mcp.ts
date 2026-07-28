#!/usr/bin/env node
/**
 * Point d'entrée du serveur MCP.
 *
 * ```bash
 * WARRANT_GATEWAY_URL=https://api.warrant.sh pnpm --filter @warrant/mcp start
 * claude mcp add --transport http warrant http://localhost:8787/mcp
 * ```
 */

import { WarrantClient } from '@warrant/sdk'

import { createWarrantHttpServer } from '../http.js'

const port = Number(process.env['WARRANT_MCP_PORT'] ?? 8787)
const baseUrl = process.env['WARRANT_GATEWAY_URL'] ?? 'http://localhost:8080'
const path = process.env['WARRANT_MCP_PATH'] ?? '/mcp'

const client = new WarrantClient({ baseUrl })

createWarrantHttpServer({ client, path }).listen(port, () => {
  process.stderr.write(
    `warrant mcp — écoute sur http://localhost:${port}${path} (gateway ${baseUrl})\n` +
      `claude mcp add --transport http warrant http://localhost:${port}${path}\n`,
  )
})
