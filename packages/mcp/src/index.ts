/**
 * `@warrant/mcp` — le serveur MCP de Warrant.
 *
 * ```bash
 * claude mcp add --transport http warrant https://mcp.warrant.sh
 * ```
 *
 * Révision de protocole **2026-07-28**, avec repli automatique pour les clients
 * restés en 2025 (voir `http.ts`).
 *
 * Rappel du terrain qui justifie de mettre l'effort ici plutôt qu'ailleurs : au
 * hackathon ETHGlobal précédent de KeeperHub, 52 équipes ont utilisé MCP contre
 * 40 x402, et l'équipe a conclu que les builders « ne voulaient pas gérer
 * d'appels HTTP et de rotation de clés » (docs/09 § 3).
 *
 * `createMockGateway` n'est volontairement **pas** réexporté : c'est un double
 * de test, il vit dans `./mock-gateway.js` et les tests l'importent de là. Ne
 * pas l'offrir sur la surface publique est ce qui garantit qu'aucun chemin
 * d'exécution ne peut l'atteindre par mégarde.
 */

export { createWarrantMcpServer, describeTool } from './server.js'
export type { WarrantMcpOptions } from './server.js'
export { createWarrantHttpServer, createWarrantMcpNodeHandler } from './http.js'
export type { WarrantHttpOptions, WarrantMcpNodeHandler } from './http.js'
export {
  X402_PAYMENT_META_KEY,
  X402_PAYMENT_RESPONSE_META_KEY,
  dualFormat,
  extractPayment,
  paymentRequiredResult,
  withSettlement,
} from './x402-mcp.js'
