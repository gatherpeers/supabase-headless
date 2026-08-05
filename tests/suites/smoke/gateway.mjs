/**
 * Caddy gateway behaviour that has no upstream equivalent: CORS, security headers,
 * blank-key sentinels, open auth routes, the dashboard redirects and the fallback 404.
 * These are all defined in caddy/Caddyfile and fail silently if a route is reordered.
 */

import { getConfig, requireEnv } from '../../lib/config.mjs'
import { assertEqual, assertNot, assertTrue, runChecks } from '../../lib/runner.mjs'
import { http, httpStatus } from '../../lib/http.mjs'

// compose substitutes these when a key is left blank, so the gateway can stay valid
// in legacy-only mode. They must never be usable as credentials.
const BLANK_KEY_SENTINELS = [
  '__unset_publishable_key__',
  '__unset_secret_key__',
  '__unset_legacy_anon_key__',
  '__unset_legacy_service_role_key__',
]

export async function runGatewaySuite() {
  const cfg = getConfig()
  requireEnv(cfg, 'anonKey', 'serviceRoleKey')
  const { api, url, anonKey, serviceRoleKey, dashboardPrefix } = cfg

  const checks = [
    ['CORS preflight -> 204 with methods and echoed headers', async () => {
      const res = await http(`${api.rest}/`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'apikey,authorization',
        },
      })
      assertEqual(res.status, 204)
      assertTrue(res.headers.get('access-control-allow-methods')?.includes('POST'), 'missing POST in allow-methods')
      // Kong-compatible: the browser's requested header names are echoed back verbatim.
      assertEqual(res.headers.get('access-control-allow-headers'), 'apikey,authorization')
      assertEqual(res.headers.get('access-control-max-age'), '3600')
    }],

    ['security headers on API responses', async () => {
      const res = await http(`${api.rest}/`, { headers: { apikey: serviceRoleKey } })
      assertEqual(res.status, 200)
      assertTrue(res.headers.get('strict-transport-security')?.includes('max-age='), 'missing HSTS')
      assertEqual(res.headers.get('x-content-type-options'), 'nosniff')
      assertEqual(res.headers.get('x-frame-options'), 'DENY')
      assertEqual(res.headers.get('access-control-allow-origin'), '*')
      assertEqual(res.headers.get('server'), null, 'Server header should be stripped')
    }],

    ['unknown path -> fallback 404 JSON', async () => {
      const res = await http(`${url}/definitely/not/a/route`)
      assertEqual(res.status, 404)
      assertEqual(res.json?.error, 'not_found', res.text)
      // The security header block is deferred, so it must apply to synthesized responses too.
      assertEqual(res.headers.get('x-frame-options'), 'DENY')
    }],

    ['apikey accepted from query string', async () => {
      // Realtime's browser WebSocket client cannot set headers, so the gateway copies
      // ?apikey into the Apikey header on every route. 400 here is PostgREST rejecting
      // an unknown query param — what matters is that the gateway did not reject the key.
      assertNot(await httpStatus(`${api.rest}/?apikey=${encodeURIComponent(serviceRoleKey)}`), 401)
      assertEqual(await httpStatus(`${api.rest}/?apikey=bogus-key`), 401, 'invalid query key must still 401')
    }],

    ['blank-key sentinels are rejected', async () => {
      // Checked on Storage, which has no reject_invalid_apikey: an unknown key reaches
      // Storage (non-401), so a 401 here proves the sentinel guard ran at the gateway.
      assertNot(await httpStatus(`${api.storage}/bucket`, { headers: { apikey: 'unknown-key' } }), 401)
      for (const sentinel of BLANK_KEY_SENTINELS) {
        assertEqual(
          await httpStatus(`${api.storage}/bucket`, { headers: { apikey: sentinel } }),
          401,
          sentinel,
        )
      }
    }],

    ['open auth routes need no apikey', async () => {
      // These are hit by email links and IdPs that have no Supabase key; they may 400 on
      // missing params but must never be turned away by the gateway's key check.
      for (const path of ['/verify', '/authorize?provider=github']) {
        assertNot(await httpStatus(`${api.auth}${path}`), 401, path)
      }
    }],

    ['graphql route: no key -> 401, valid key -> passes to PostgREST', async () => {
      const body = JSON.stringify({ query: '{ __typename }' })
      const post = (headers) =>
        httpStatus(`${url}/graphql/v1`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body,
        })

      assertEqual(await post({}), 401)
      // pg_graphql is not installed in the headless image, so PostgREST answers 404/406
      // rather than 200. Only the gateway half of the route is asserted here.
      assertNot(await post({ apikey: anonKey }), 401)
      assertNot(await post({ apikey: cfg.publishableKey || anonKey }), 401)
    }],

    ['realtime dashboard redirects to /admin', async () => {
      const legacy = await http(`${api.realtime}${dashboardPrefix}/dashboard/`)
      assertEqual(legacy.status, 301)
      assertTrue(
        legacy.headers.get('location')?.endsWith(`${dashboardPrefix}/dashboard/`),
        `location=${legacy.headers.get('location')}`,
      )

      const root = await http(`${url}${dashboardPrefix}`)
      assertEqual(root.status, 308)
      assertEqual(root.headers.get('location'), `${dashboardPrefix}/dashboard/`)
    }],

    ['functions are reachable without any key', async () => {
      // Edge Runtime does its own auth and functions/index.ts verifies no JWT, matching
      // upstream's --no-verify-jwt default. Pinned so a gateway change cannot silently
      // start (or stop) gating Functions.
      const res = await http(`${api.functions}/example1?name=nokey`)
      assertEqual(res.status, 200, res.text)
      assertTrue(String(res.json?.message || '').includes('nokey'), res.text)
    }],
  ]

  return runChecks('smoke:gateway', checks)
}
