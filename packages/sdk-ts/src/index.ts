/**
 * `@warrant/sdk` — the single source.
 *
 * This package contains everything that defines Warrant's four tools: their
 * schemas, their descriptions, their execution, the x402 payment loop and the
 * Gateway interface. The integration surfaces — MCP server, Vercel AI SDK,
 * LangChain, CrewAI, OpenClaw skill — are nothing but projections of what lives
 * here (docs/09 § intro and § 5).
 *
 * The rule that governs the whole package: **nothing is declared, everything is
 * derived**. No tool accepts a `category` or a `notional`.
 */

export * from './x402.js'
export * from './mpp.js'
export * from './errors.js'
export * from './gateway.js'
export * from './schemas.js'
export * from './tools.js'
export { WarrantClient, DEFAULT_BASE_URL } from './client.js'
export type { WarrantClientOptions } from './client.js'
export { warrantTools } from './ai.js'
export type { AiTool, WarrantToolsOptions } from './ai.js'
