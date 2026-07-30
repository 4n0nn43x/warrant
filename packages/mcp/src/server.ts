/**
 * Warrant's MCP server — protocol revision 2026-07-28.
 *
 * ```bash
 * claude mcp add --transport http warrant https://mcp.warrant.sh
 * ```
 *
 * Four tools, projected from `@warrant/sdk` — the server redefines no schema, no
 * description, no logic. It does only the two things the SDK cannot do: speak
 * JSON-RPC, and implement the x402 v2 transport over MCP (docs/05 § 1.7).
 *
 * One implementation choice to spell out: we use the low-level `Server` rather
 * than `McpServer`. `McpServer` validates the arguments itself and throws a
 * JSON-RPC `McpError` when they are invalid — the error then leaves the product
 * without a `hint` or a documentation link, which the DX checklist forbids
 * (docs/09 § 8). Here, **every** error comes back as a structured, actionable
 * tool result. The agent that receives it can correct itself on the next turn;
 * that is the only criterion that counts.
 *
 * The reasoning survives the move to SDK v2 intact: `registerTool()` there still
 * validates the arguments against the schema before calling the callback, and a
 * violation becomes a protocol error. The low-level `Server`, by contrast, lets
 * us receive the raw arguments and run them through the Warrant SDK's parsing,
 * which produces `WarrantError`s carrying `field`, `hint` and `docs`.
 *
 * What SDK v2 takes care of and we therefore do not write here: the `resultType`
 * field (`"complete"` is set by the 2026-07-28 codec at encoding time — a handler
 * never writes it itself), header↔body validation (`-32020`), the `405` on
 * GET/DELETE, and serving clients that stayed on 2025. See `http.ts`.
 */

import { Server, type CacheHint, type CallToolResult, type Tool } from '@modelcontextprotocol/server'
import {
  WARRANT_TOOLS,
  WarrantError,
  toWarrantError,
  warrantToolByName,
  type AnyWarrantTool,
  type GatewayClient,
} from '@warrant/sdk'
import { z } from 'zod'

import { dualFormat, extractPayment, paymentRequiredResult, withSettlement } from './x402-mcp.js'

export interface WarrantMcpOptions {
  /** The Warrant Gateway. Mocked in the tests, wired to HTTP in production. */
  client: GatewayClient
  name?: string
  version?: string
}

const SERVER_INSTRUCTIONS = `Warrant turns an onchain action into a bonded commitment.

Recommended sequence:
1. quote_risk — free. Gives the bond, the risk rate and the post-condition that will be committed.
2. request_warrant — paid. Opens the warrant, funds the bond via x402, triggers the KeeperHub execution.
3. get_warrant — reads the verdict and the checks[] detail once the warrant is settled.
4. list_warrants — an agent's history and statistics.

Worth knowing before calling: the category of the action and its notional are derived from the calldata,
never declared. No tool accepts a category or notional field; slipping one in changes nothing about the price.

request_warrant called without payment returns an erroring result containing an x402 v2 PaymentRequired
object. Settle it, then call the same tool again with the PaymentPayload in _meta["x402/payment"].`

/**
 * What the server promises about the freshness of `tools/list` (SEP-2549).
 *
 * `cacheScope: 'public'`: the list does not vary by caller. `WARRANT_TOOLS` is a
 * constant of the package, no tool is hidden by authorization — the spec then
 * explicitly permits shared caches (`server/tools`: the tool set "MUST NOT vary
 * per-connection", it may only vary "by the authorization presented on the
 * request", which is not our case).
 *
 * A `ttlMs` of one hour: these four tools are frozen at compile time, and the
 * only thing that changes them is a redeployment — which replaces the process.
 * One hour is therefore a bet on how often we deploy, not on the stability of the
 * product. The bet is cheap because being wrong costs little: an agent that
 * called a tool name that has since vanished receives the `invalid_input` error
 * which **lists the tools actually available** (see below), so it corrects itself
 * on the next turn with no intervention. The SDK default (`ttlMs: 0`) would
 * instead make an agent redo a `tools/list` on every turn, over a list that has
 * not moved since the start of the hackathon.
 */
const TOOLS_LIST_CACHE_HINT: CacheHint = {
  ttlMs: 3_600_000,
  cacheScope: 'public',
}

/** JSON Schema draft-7 — what `tools/list` expects. */
function toJsonSchema(schema: z.ZodType): Tool['inputSchema'] {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Tool['inputSchema']
}

/**
 * Descriptor → `tools/list` entry.
 *
 * `additionalProperties` is deliberately left absent. A stray `category` in the
 * `actionSpec` must be **ignored**, not rejected: rejecting it would teach the
 * agent that the field exists somewhere, when it exists nowhere. The stripping is
 * done at parse time, on the SDK side.
 *
 * No property carries the 2026-07-28 `x-mcp-header` annotation, and that too is
 * deliberate. That annotation asks the client to copy a parameter's value into an
 * `Mcp-Param-{Name}` header so that intermediaries (load balancers, WAFs) can
 * route without reading the body. Our parameters are either objects
 * (`actionSpec`, not eligible — the annotation is reserved for primitive types),
 * or onchain identities (`agent`, `beneficiary`, `warrantId`); and the spec warns
 * precisely against exposing PII or sensitive identifiers in a header, "visible
 * to network intermediaries". An agent's address and a warrant's identifier are
 * exactly what we do not want showing up in the logs of every proxy on the way.
 */
export function describeTool(tool: AnyWarrantTool): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toJsonSchema(tool.input),
    // No `outputSchema`, and that is deliberate.
    //
    // The official MCP client caches the announced `outputSchema` and validates
    // **any** `structuredContent` it receives against it, including on an
    // `isError: true` result. Yet both of our error paths put an object in
    // `structuredContent`: the x402 transport's `PaymentRequired`, which the spec
    // mandates (docs/05 § 1.7), and our actionable errors. Announcing an
    // `outputSchema` would therefore make the client throw an error instead of
    // handling the 402 — the payment flow would be broken with the reference
    // client.
    //
    // The output schemas do exist all the same (`tool.output`, in
    // `@warrant/sdk`): they type the SDK and will feed the OpenAPI. They are
    // simply not announced on this particular transport.
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      idempotentHint: tool.readOnly,
      openWorldHint: true,
    },
    _meta: {
      /**
       * Discovery: a client knows, before calling, which of the four tools will
       * require a payment. This is the MCP equivalent of `x-payment-info` on the
       * OpenAPI (docs/09 § 1).
       */
      'x402/paid': tool.paid,
    },
  }
}

/** Every error leaves through here — structured, with a `hint` and a doc link. */
function errorResult(err: unknown): CallToolResult {
  const warrantError = toWarrantError(err)
  return dualFormat(warrantError.toJSON() as unknown as Record<string, unknown>, true)
}

export function createWarrantMcpServer(options: WarrantMcpOptions): Server {
  const { client } = options

  const server = new Server(
    { name: options.name ?? 'warrant', version: options.version ?? '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
      // The SDK sets `ttlMs`/`cacheScope` on the result at 2026-07-28 encoding
      // time and omits them for a 2025 client, which does not have that
      // vocabulary. Going through this option rather than through the handler's
      // return value spares the handler from having to know which revision it is
      // answering.
      cacheHints: { 'tools/list': TOOLS_LIST_CACHE_HINT },
    },
  )

  server.setRequestHandler('tools/list', async () => ({
    tools: (WARRANT_TOOLS as readonly AnyWarrantTool[]).map(describeTool),
  }))

  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
    const { name, arguments: args, _meta } = request.params

    const tool = warrantToolByName(name)
    if (!tool) {
      return errorResult(
        new WarrantError('invalid_input', `Unknown tool: ${name}.`, {
          hint: `The available tools are ${WARRANT_TOOLS.map((t) => t.name).join(', ')}.`,
        }),
      )
    }

    // Step 3 of the flow: the payment, if it is there, travels in `_meta`.
    //
    // On 2026-07-28 the SDK has already extracted from that `_meta` the reserved
    // `io.modelcontextprotocol/*` keys (protocol version, client identity and
    // capabilities): what we read here is the application-level `_meta`, the
    // client's own.
    const payment = extractPayment(_meta)

    try {
      const outcome = await tool.run(client, args ?? {}, payment ? { payment } : undefined)

      if (outcome.kind === 'payment-required') {
        // Step 2: `isError: true` + the PaymentRequired in both formats.
        // Why not MRTR (`resultType: "input_required"`): see `x402-mcp.ts`.
        return paymentRequiredResult(outcome.paymentRequired)
      }

      // Step 6: the settlement comes back in `_meta["x402/payment-response"]`.
      return withSettlement(
        dualFormat(outcome.data as Record<string, unknown>),
        outcome.settlement,
      )
    } catch (err) {
      return errorResult(err)
    }
  })

  return server
}
