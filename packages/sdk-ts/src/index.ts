/**
 * `@warrant/sdk` — la source unique.
 *
 * Ce paquet contient tout ce qui définit les quatre outils de Warrant : leurs
 * schémas, leurs descriptions, leur exécution, la boucle de paiement x402 et
 * l'interface du Gateway. Les surfaces d'intégration — serveur MCP, Vercel AI
 * SDK, LangChain, CrewAI, skill OpenClaw — ne sont que des projections de ce
 * qui est ici (docs/09 § intro et § 5).
 *
 * La règle qui gouverne tout le paquet : **rien n'est déclaré, tout est
 * dérivé**. Aucun outil n'accepte de `category` ni de `notional`.
 */

export * from './x402.js'
export * from './errors.js'
export * from './gateway.js'
export * from './schemas.js'
export * from './tools.js'
export { WarrantClient } from './client.js'
export type { WarrantClientOptions } from './client.js'
export { warrantTools } from './ai.js'
export type { AiTool, WarrantToolsOptions } from './ai.js'
