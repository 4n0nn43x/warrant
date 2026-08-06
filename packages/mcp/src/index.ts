/**
 * `@warrant/mcp` — Warrant's MCP server.
 *
 * ```bash
 * claude mcp add --transport http warrant https://mcp.example
 * ```
 *
 * Protocol revision **2026-07-28**, with automatic fallback for clients that
 * stayed on 2025 (see `http.ts`).
 *
 * A reminder of the field evidence that justifies putting the effort here rather
 * than elsewhere: at KeeperHub's previous ETHGlobal hackathon, 52 teams used MCP
 * against 40 for x402, and the team concluded that builders "did not want to deal
 * with HTTP calls and key rotation" (docs/09 § 3).
 *
 * `createMockGateway` is deliberately **not** re-exported: it is a test double, it
 * lives in `./mock-gateway.js` and the tests import it from there. Not offering it
 * on the public surface is what guarantees that no execution path can reach it by
 * accident.
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
