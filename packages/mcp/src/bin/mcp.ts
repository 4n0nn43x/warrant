#!/usr/bin/env node
/**
 * Point d'entrée du serveur MCP.
 *
 * ```bash
 * WARRANT_GATEWAY_URL=https://api.warrant.sh pnpm --filter @warrant/mcp start
 * claude mcp add --transport http warrant http://localhost:8787/mcp
 * ```
 *
 * Un seul chemin d'exécution, et un seul Gateway : le vrai. Il exista ici un
 * drapeau `WARRANT_MOCK` qui câblait un Gateway en mémoire acceptant les
 * paiements sur parole ; il est retiré. Un binaire capable de démarrer dans un
 * mode où « tout marche » sans que rien ne soit vérifié est un binaire dont la
 * sortie ne prouve rien — et une variable d'environnement est exactement le
 * genre de commutateur qu'on laisse un jour dans la mauvaise position. Le
 * double en mémoire existe toujours (`src/mock-gateway.ts`) et reste utile,
 * mais aux tests seulement : il n'est plus atteignable depuis un binaire.
 */

import { WarrantClient, type GatewayClient } from '@warrant/sdk'

import { createWarrantHttpServer } from '../http.js'

const port = Number(process.env['WARRANT_MCP_PORT'] ?? 8787)
const host = process.env['WARRANT_MCP_HOST'] ?? '127.0.0.1'
const baseUrl = process.env['WARRANT_GATEWAY_URL'] ?? 'http://localhost:8080'
const path = process.env['WARRANT_MCP_PATH'] ?? '/mcp'

const client: GatewayClient = new WarrantClient({ baseUrl })

// Écoute sur la boucle locale par défaut, pas sur 0.0.0.0 : un serveur qui
// ouvre des mandats payants n'a rien à faire sur toutes les interfaces tant que
// l'opérateur ne l'a pas demandé explicitement.
createWarrantHttpServer({ client, path }).listen(port, host, () => {
  process.stderr.write(
    `warrant mcp — écoute sur http://${host}:${port}${path} (gateway ${baseUrl})\n` +
      `protocole MCP 2026-07-28 ; les clients restés en 2025 sont servis en repli\n` +
      `claude mcp add --transport http warrant http://${host}:${port}${path}\n`,
  )
})
