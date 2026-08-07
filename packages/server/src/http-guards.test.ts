import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  bodyLimitGuard,
  corsGuard,
  parseOrigins,
  rateLimitGuard,
  PAYMENT_RESPONSE_HEADERS,
} from './http-guards.js'

const SITE = 'https://warrant.example'
const OTHER = 'https://evil.example'

function appWith(...middleware: Parameters<Hono['use']>[0][]): Hono {
  const app = new Hono()
  for (const mw of middleware) app.use('*', mw)
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.post('/v1/quote', (c) => c.json({ bond: '1000000' }))
  return app
}

describe('parseOrigins', () => {
  it('returns nothing for an unset or blank value', () => {
    expect(parseOrigins(undefined)).toEqual([])
    expect(parseOrigins('')).toEqual([])
    expect(parseOrigins('   ')).toEqual([])
  })

  it('splits, trims and drops empty entries', () => {
    expect(parseOrigins(' https://a.example , https://b.example ,, ')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('normalises the trailing slash, the most common way to get this wrong', () => {
    expect(parseOrigins('https://a.example/')).toEqual(['https://a.example'])
  })
})

describe('corsGuard', () => {
  it('stays silent when the caller sends no Origin — every agent', async () => {
    const app = appWith(corsGuard({ origins: [SITE] }))
    const res = await app.request('/healthz')

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows a listed origin and exposes the payment headers', async () => {
    const app = appWith(corsGuard({ origins: [SITE] }))
    const res = await app.request('/healthz', { headers: { origin: SITE } })

    expect(res.headers.get('access-control-allow-origin')).toBe(SITE)
    expect(res.headers.get('vary')).toBe('Origin')

    // The payment loop lives in these headers: a browser that cannot read them
    // cannot tell a 402 challenge from an opaque failure.
    const exposed = res.headers.get('access-control-expose-headers') ?? ''
    for (const header of PAYMENT_RESPONSE_HEADERS) {
      expect(exposed).toContain(header)
    }
  })

  it('emits nothing for an origin that is not listed', async () => {
    const app = appWith(corsGuard({ origins: [SITE] }))
    const res = await app.request('/healthz', { headers: { origin: OTHER } })

    // The request still runs — CORS is enforced by the browser, not by us —
    // but without the header the browser refuses to hand over the response.
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('emits nothing at all when the origin list is empty', async () => {
    const app = appWith(corsGuard({ origins: [] }))
    const res = await app.request('/healthz', { headers: { origin: SITE } })

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('echoes the caller origin in wildcard mode rather than returning `*`', async () => {
    const app = appWith(corsGuard({ origins: ['*'] }))
    const res = await app.request('/healthz', { headers: { origin: OTHER } })

    // `*` is incompatible with credentialed requests; echoing keeps that door open.
    expect(res.headers.get('access-control-allow-origin')).toBe(OTHER)
  })

  it('answers a permitted preflight with 204 and the allow headers', async () => {
    const app = appWith(corsGuard({ origins: [SITE] }))
    const res = await app.request('/v1/quote', {
      method: 'OPTIONS',
      headers: { origin: SITE, 'access-control-request-method': 'POST' },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('payment-signature')
    expect(res.headers.get('access-control-max-age')).toBe('600')
  })

  it('answers a refused preflight with 204 but no allow headers', async () => {
    const app = appWith(corsGuard({ origins: [SITE] }))
    const res = await app.request('/v1/quote', {
      method: 'OPTIONS',
      headers: { origin: OTHER, 'access-control-request-method': 'POST' },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('matches a listed origin written with a trailing slash', async () => {
    const app = appWith(corsGuard({ origins: parseOrigins('https://warrant.example/') }))
    const res = await app.request('/healthz', { headers: { origin: SITE } })

    expect(res.headers.get('access-control-allow-origin')).toBe(SITE)
  })
})

describe('rateLimitGuard', () => {
  /** A clock the test drives, so no case depends on wall time. */
  function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = start
    return { now: () => t, advance: (ms) => void (t += ms) }
  }

  it('lets requests through up to the limit, then answers 429', async () => {
    const c = clock()
    const app = appWith(
      rateLimitGuard({ limit: 3, windowMs: 60_000, trustProxy: true, now: c.now }),
    )
    const headers = { 'x-forwarded-for': '203.0.113.7' }

    for (let i = 0; i < 3; i += 1) {
      expect((await app.request('/healthz', { headers })).status).toBe(200)
    }

    const blocked = await app.request('/healthz', { headers })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' })
    expect(blocked.headers.get('retry-after')).toBe('60')
  })

  it('publishes the remaining quota on every response', async () => {
    const c = clock()
    const app = appWith(
      rateLimitGuard({ limit: 5, windowMs: 60_000, trustProxy: true, now: c.now }),
    )
    const res = await app.request('/healthz', { headers: { 'x-forwarded-for': '198.51.100.4' } })

    expect(res.headers.get('ratelimit-limit')).toBe('5')
    expect(res.headers.get('ratelimit-remaining')).toBe('4')
  })

  it('counts each client address separately', async () => {
    const c = clock()
    const app = appWith(
      rateLimitGuard({ limit: 1, windowMs: 60_000, trustProxy: true, now: c.now }),
    )

    expect(
      (await app.request('/healthz', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status,
    ).toBe(200)
    // A different client must not inherit the first one's exhausted quota.
    expect(
      (await app.request('/healthz', { headers: { 'x-forwarded-for': '203.0.113.2' } })).status,
    ).toBe(200)
    expect(
      (await app.request('/healthz', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status,
    ).toBe(429)
  })

  it('takes the left-most entry of a proxy chain as the client', async () => {
    const c = clock()
    const app = appWith(
      rateLimitGuard({ limit: 1, windowMs: 60_000, trustProxy: true, now: c.now }),
    )
    const chain = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' }

    expect((await app.request('/healthz', { headers: chain })).status).toBe(200)
    expect((await app.request('/healthz', { headers: chain })).status).toBe(429)
  })

  it('ignores a forged X-Forwarded-For when the proxy is not trusted', async () => {
    const c = clock()
    const app = appWith(rateLimitGuard({ limit: 1, windowMs: 60_000, now: c.now }))

    // Without trustProxy, a fresh forged address must not buy a fresh quota.
    expect(
      (await app.request('/healthz', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status,
    ).toBe(200)
    expect(
      (await app.request('/healthz', { headers: { 'x-forwarded-for': '203.0.113.2' } })).status,
    ).toBe(429)
  })

  it('opens a fresh window once the current one has elapsed', async () => {
    const c = clock()
    const app = appWith(
      rateLimitGuard({ limit: 1, windowMs: 60_000, trustProxy: true, now: c.now }),
    )
    const headers = { 'x-forwarded-for': '203.0.113.20' }

    expect((await app.request('/healthz', { headers })).status).toBe(200)
    expect((await app.request('/healthz', { headers })).status).toBe(429)

    c.advance(60_001)
    expect((await app.request('/healthz', { headers })).status).toBe(200)
  })

  it('exempts the paths the caller declares, so probes never trip the limit', async () => {
    const c = clock()
    const app = appWith(
      rateLimitGuard({
        limit: 1,
        windowMs: 60_000,
        trustProxy: true,
        now: c.now,
        skip: (path) => path === '/healthz',
      }),
    )
    const headers = { 'x-forwarded-for': '203.0.113.30' }

    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/healthz', { headers })).status).toBe(200)
    }
    // The exempt path consumed nothing: the counted route still has its quota.
    expect((await app.request('/v1/quote', { method: 'POST', headers })).status).toBe(200)
  })
})

describe('bodyLimitGuard', () => {
  it('refuses a body that declares more than the ceiling', async () => {
    const app = appWith(bodyLimitGuard(1024))
    const res = await app.request('/v1/quote', {
      method: 'POST',
      headers: { 'content-length': '4096' },
      body: 'x',
    })

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' })
  })

  it('lets a body within the ceiling through', async () => {
    const app = appWith(bodyLimitGuard(1024))
    const res = await app.request('/v1/quote', {
      method: 'POST',
      headers: { 'content-length': '10' },
      body: '{}',
    })

    expect(res.status).toBe(200)
  })
})
