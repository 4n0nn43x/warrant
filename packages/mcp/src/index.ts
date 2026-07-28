/**
 * `@warrant/mcp` — le serveur MCP de Warrant.
 *
 * ```bash
 * claude mcp add --transport http warrant https://mcp.warrant.sh
 * ```
 *
 * Rappel du terrain qui justifie de mettre l'effort ici plutôt qu'ailleurs : au
 * hackathon ETHGlobal précédent de KeeperHub, 52 équipes ont utilisé MCP contre
 * 40 x402, et l'équipe a conclu que les builders « ne voulaient pas gérer
 * d'appels HTTP et de rotation de clés » (docs/09 § 3).
 */

export { createWarrantMcpServer, describeTool } from './server.js'
export type { WarrantMcpOptions } from './server.js'
export { createWarrantHttpServer, handleMcpRequest } from './http.js'
export type { WarrantHttpOptions } from './http.js'
export { createMockGateway } from './mock-gateway.js'
export type { MockGateway, MockGatewayOptions } from './mock-gateway.js'
export {
  X402_PAYMENT_META_KEY,
  X402_PAYMENT_RESPONSE_META_KEY,
  dualFormat,
  extractPayment,
  paymentRequiredResult,
  withSettlement,
} from './x402-mcp.js'
