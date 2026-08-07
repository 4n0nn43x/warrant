/**
 * Edge guards for a Gateway exposed to the public internet.
 *
 * `createGateway` builds the protocol; this module builds the perimeter. They
 * are kept apart on purpose: the protocol is the same whether the Gateway runs
 * on a laptop behind `127.0.0.1` or on a host with a public DNS name, whereas
 * the perimeter only makes sense in the second case. Wiring these into
 * `createGateway` would have meant every unit test paying for a rate limiter it
 * has no use for.
 *
 * Three guards, and each one answers a question the deployment poses:
 *
 * - **CORS** — a browser refuses to read a cross-origin response unless the
 *   server says it may. Without this, no web frontend can call the Gateway at
 *   all. Note what CORS is *not*: it is enforced by browsers only, so it stops
 *   no agent, no script and no attacker. It is an interoperability control, not
 *   a security one, and treating it as the latter is a classic mistake.
 * - **Rate limiting** — the Gateway holds `KH_API_KEY`, and `POST /v1/quote` is
 *   free and unauthenticated. An open quote route is a free classification and
 *   pricing oracle; worse, every opening path consumes KeeperHub credits. This
 *   is the guard that actually protects something.
 * - **Body limit** — `POST /v1/warrants` parses attacker-supplied JSON. A
 *   megabyte of nested arrays costs us CPU before a single field is validated.
 *
 * All three are declined by the caller, never assumed here: a guard with a
 * silent default is a guard nobody knows is running.
 */

import type { Context, MiddlewareHandler, Next } from 'hono'

/** Wildcard accepted by `parseOrigins`, and refused by `corsGuard` unless explicit. */
export const ORIGIN_WILDCARD = '*'

/**
 * Parses a comma-separated origin list.
 *
 * Origins are compared byte for byte against the request's `Origin` header, so
 * they must carry the scheme and must not carry a trailing slash — `https://a.b`,
 * never `https://a.b/` nor `a.b`. We normalise the trailing slash rather than
 * reject it: it is the single most common way to write the value, and a silent
 * mismatch surfaces as "CORS is broken" hours later, in someone else's browser.
 */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return []
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o !== '')
}

export interface CorsOptions {
  /** Exact origins allowed to read responses. `['*']` allows any. */
  origins: string[]
  /** Methods advertised on preflight. */
  methods?: string[]
  /** Request headers a browser may send. */
  headers?: string[]
  /** Response headers a browser may read. */
  exposeHeaders?: string[]
  /** Preflight cache lifetime, in seconds. */
  maxAgeSeconds?: number
}

/**
 * The x402 and MPP headers a browser client must be allowed to send and read.
 *
 * These are the reason a stock CORS configuration is not enough. The payment
 * loop lives entirely in non-standard headers: the client reads the challenge
 * from `PAYMENT-REQUIRED`, replays with `PAYMENT-SIGNATURE`, and reads the
 * receipt from `PAYMENT-RESPONSE`. A browser cannot see a response header that
 * is not named in `Access-Control-Expose-Headers`, so omitting these would
 * produce a Gateway that answers 402 correctly and a frontend that cannot tell
 * it apart from an opaque failure.
 */
export const PAYMENT_REQUEST_HEADERS = [
  'content-type',
  'authorization',
  'payment-signature',
] as const

export const PAYMENT_RESPONSE_HEADERS = [
  'payment-required',
  'payment-response',
  'www-authenticate',
] as const

/**
 * CORS middleware.
 *
 * Deliberately not `hono/cors`: we need the response-header exposure above to
 * be impossible to forget, and an empty origin list to mean "emit nothing"
 * rather than "allow everything".
 */
export function corsGuard(opts: CorsOptions): MiddlewareHandler {
  const allowAny = opts.origins.includes(ORIGIN_WILDCARD)
  const allowed = new Set(opts.origins)
  const methods = (opts.methods ?? ['GET', 'POST', 'OPTIONS']).join(', ')
  const headers = (opts.headers ?? [...PAYMENT_REQUEST_HEADERS]).join(', ')
  const expose = (opts.exposeHeaders ?? [...PAYMENT_RESPONSE_HEADERS]).join(', ')
  const maxAge = String(opts.maxAgeSeconds ?? 600)

  return async (c: Context, next: Next) => {
    const origin = c.req.header('origin')

    // No Origin header: a server-to-server caller — every agent, in practice.
    // CORS has nothing to say about it, and adding headers would only mislead.
    if (!origin) return next()

    const permitted = allowAny || allowed.has(origin.replace(/\/+$/, ''))

    if (permitted) {
      // Echo the caller's origin rather than `*` even in wildcard mode: `*` is
      // incompatible with credentialed requests, and echoing keeps the door
      // open for a future cookie or Authorization flow without a silent break.
      c.header('Access-Control-Allow-Origin', allowAny ? origin : origin)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Expose-Headers', expose)
    }

    if (c.req.method === 'OPTIONS') {
      // A rejected preflight still answers 204 without the allow headers. The
      // browser then blocks the call itself, which is the correct division of
      // labour — and it keeps us from leaking the allowlist through status
      // codes.
      if (permitted) {
        c.header('Access-Control-Allow-Methods', methods)
        c.header('Access-Control-Allow-Headers', headers)
        c.header('Access-Control-Max-Age', maxAge)
      }
      return c.body(null, 204)
    }

    return next()
  }
}

export interface RateLimitOptions {
  /** Requests allowed per window, per client. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /**
   * Trust `X-Forwarded-For` for the client address.
   *
   * **Only enable behind a reverse proxy you control.** The header is
   * caller-supplied: trusting it on a directly-exposed server lets anyone forge
   * a fresh identity per request and bypass the limiter entirely. Behind nginx
   * it is the opposite — without it every request is attributed to the proxy,
   * and one visitor exhausts the quota for all of them.
   */
  trustProxy?: boolean
  /** Injectable clock, for tests. */
  now?: () => number
  /** Paths exempt from counting, e.g. the health probe. */
  skip?: (path: string) => boolean
}

interface Bucket {
  count: number
  resetAt: number
}

/**
 * Fixed-window rate limiter, in memory.
 *
 * In memory because this Gateway is a single process: a shared store would add
 * a dependency and a failure mode to protect a deployment that does not yet
 * have a second instance. The day it does, this is the piece to replace — and
 * the boundary is drawn here so that swap is local.
 *
 * Fixed window rather than sliding: at the burst boundary it permits up to 2×
 * `limit`, which is a known and acceptable imprecision for a limiter whose job
 * is to stop scripted abuse, not to meter billing.
 */
export function rateLimitGuard(opts: RateLimitOptions): MiddlewareHandler {
  const now = opts.now ?? (() => Date.now())
  const buckets = new Map<string, Bucket>()

  /** Bounded sweep: an unbounded map is a memory leak with extra steps. */
  function sweep(t: number): void {
    if (buckets.size < 10_000) return
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= t) buckets.delete(key)
    }
  }

  return async (c: Context, next: Next) => {
    if (opts.skip?.(c.req.path)) return next()

    const t = now()
    sweep(t)

    const forwarded = opts.trustProxy ? c.req.header('x-forwarded-for') : undefined
    // Left-most entry is the original client; the rest were appended by proxies.
    const client = forwarded?.split(',')[0]?.trim() || 'unknown'

    let bucket = buckets.get(client)
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + opts.windowMs }
      buckets.set(client, bucket)
    }
    bucket.count += 1

    const remaining = Math.max(0, opts.limit - bucket.count)
    c.header('RateLimit-Limit', String(opts.limit))
    c.header('RateLimit-Remaining', String(remaining))
    c.header('RateLimit-Reset', String(Math.ceil((bucket.resetAt - t) / 1000)))

    if (bucket.count > opts.limit) {
      const retryAfter = Math.ceil((bucket.resetAt - t) / 1000)
      c.header('Retry-After', String(retryAfter))
      // Same error envelope as the rest of the Gateway: a client that already
      // parses our errors should not need a special case for this one.
      return c.json(
        {
          error: 'rate_limited',
          detail: `Too many requests: limit is ${opts.limit} per ${Math.round(
            opts.windowMs / 1000,
          )}s.`,
          hint: `Retry after ${retryAfter}s.`,
        },
        429,
      )
    }

    return next()
  }
}

/**
 * Rejects oversized request bodies before they are parsed.
 *
 * `Content-Length` is advisory — a chunked request omits it — so this is a
 * cheap first cut, not a guarantee. The real ceiling belongs at the reverse
 * proxy (`client_max_body_size` in nginx), which can drop the connection before
 * the bytes reach Node at all. Both, because a Gateway that is later exposed
 * directly must not silently lose its only limit.
 */
export function bodyLimitGuard(maxBytes: number): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const declared = c.req.header('content-length')
    if (declared && Number(declared) > maxBytes) {
      return c.json(
        {
          error: 'payload_too_large',
          detail: `Request body exceeds ${maxBytes} bytes.`,
        },
        413,
      )
    }
    return next()
  }
}
