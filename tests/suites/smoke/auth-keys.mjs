/**
 * API key translation + asymmetric auth matrix (upstream docker/tests/test-auth-keys.sh).
 */

import { getConfig, requireEnv } from '../../lib/config.mjs'
import { assertEqual, assertNot, assertTrue, runChecks, skip } from '../../lib/runner.mjs'
import { curlHttpStatus, http, httpStatus, keyHeaders } from '../../lib/http.mjs'
import { adminDeleteUser, createSessionUser, decodeJwtHeader, legacyRoleToken } from '../../lib/auth.mjs'

const WS_UPGRADE_HEADERS = {
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
}

export async function runAuthKeysSuite() {
  const cfg = getConfig()
  requireEnv(cfg, 'publishableKey', 'secretKey', 'anonKey', 'serviceRoleKey', 'jwtSecret')

  const { api, publishableKey, secretKey, anonKey, serviceRoleKey, jwtSecret, jwtKeys } = cfg
  let user

  /** `[name, url, headers, expected]` → a check asserting the exact status. */
  const status = ([name, url, headers, expected]) => [
    name,
    async () => assertEqual(await httpStatus(url, { headers }), expected, url),
  ]

  /** Same, but the Authorization bearer is the live user session (skips if sign-in failed). */
  const session = ([name, url, apikey, expected]) => [
    name,
    async () => {
      if (!user) return skip('no session — sign-in failed')
      const headers = { apikey, Authorization: `Bearer ${user.accessToken}` }
      assertEqual(await httpStatus(url, { headers }), expected, url)
    },
  ]

  /** Upstream asserts "not 401" here: both 101 and a 000 timeout mean the upgrade was allowed. */
  const wsUpgrade = (label, key) => [
    `WebSocket upgrade with ${label} is not 401`,
    async () => {
      const url = `${api.realtime}/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`
      assertNot(curlHttpStatus(url, WS_UPGRADE_HEADERS), 401)
    },
  ]

  const checks = [
    ...[
      ['rest: legacy ANON_KEY -> 403 (OpenAPI root)', `${api.rest}/`, { apikey: anonKey }, 403],
      ['rest: legacy SERVICE_ROLE_KEY -> 200', `${api.rest}/`, { apikey: serviceRoleKey }, 200],
      ['rest: publishable -> 403', `${api.rest}/`, { apikey: publishableKey }, 403],
      ['rest: secret -> 200', `${api.rest}/`, { apikey: secretKey }, 200],
      ['rest: no key -> 401', `${api.rest}/`, {}, 401],
      ['rest: invalid key -> 401', `${api.rest}/`, { apikey: 'invalid-key' }, 401],

      ['auth/settings: legacy ANON_KEY -> 200', `${api.auth}/settings`, { apikey: anonKey }, 200],
      ['auth/settings: publishable -> 200', `${api.auth}/settings`, { apikey: publishableKey }, 200],
      ['auth/settings: no key -> 401', `${api.auth}/settings`, {}, 401],
    ].map(status),

    ['storage/bucket: no key is not gateway 401', async () => {
      assertNot(await httpStatus(`${api.storage}/bucket`), 401)
    }],
    ...[
      ['storage/bucket: legacy ANON_KEY -> 200', `${api.storage}/bucket`, keyHeaders(anonKey), 200],
      ['storage/bucket: publishable (translated) -> 200', `${api.storage}/bucket`, { apikey: publishableKey }, 200],
    ].map(status),

    ['storage/s3: route not 502', async () => {
      assertNot(await httpStatus(`${api.storage}/s3/`), 502)
    }],

    ...[
      ['realtime/api/ping: legacy ANON_KEY -> 200', `${api.realtime}/api/ping`, { apikey: anonKey }, 200],
      ['realtime/api/ping: publishable -> 200', `${api.realtime}/api/ping`, { apikey: publishableKey }, 200],
      ['realtime/api/ping: no key -> 401', `${api.realtime}/api/ping`, {}, 401],
      ['realtime/api/tenants blocked -> 403', `${api.realtime}/api/tenants`, { apikey: anonKey }, 403],
      ['realtime/api/openapi blocked -> 403', `${api.realtime}/api/openapi`, { apikey: anonKey }, 403],

      // supabase-js sends apikey and Authorization together.
      ['rest: publishable apikey + Authorization Bearer sb_ -> 403', `${api.rest}/`, keyHeaders(publishableKey), 403],
      ['rest: secret apikey + Authorization Bearer sb_secret -> 200', `${api.rest}/`, keyHeaders(secretKey), 200],
      ['rest: legacy apikey + Authorization Bearer anon JWT -> 403', `${api.rest}/`, keyHeaders(anonKey), 403],
      ['rest: service role apikey + Authorization Bearer -> 200', `${api.rest}/`, keyHeaders(serviceRoleKey), 200],
      ['rest: sb_ in Authorization only (no apikey) -> 401', `${api.rest}/`, { Authorization: `Bearer ${publishableKey}` }, 401],

      ['JWKS public endpoint -> 200', `${api.auth}/.well-known/jwks.json`, {}, 200],
    ].map(status),

    ['JWKS contains EC key, not symmetric oct', async () => {
      const { json } = await http(`${api.auth}/.well-known/jwks.json`)
      const types = (json?.keys || []).map((k) => k.kty)
      assertTrue(types.includes('EC'), `kty=${types.join(',')}`)
      assertTrue(!types.includes('oct'), 'JWKS must not expose symmetric key')
    }],

    wsUpgrade('legacy key', anonKey),
    wsUpgrade('opaque key', publishableKey),

    ['create user + sign-in session JWT', async () => {
      user = await createSessionUser(cfg, 'keys')
      const { alg } = decodeJwtHeader(user.accessToken)
      assertTrue(alg === 'ES256' || alg === 'HS256', `unexpected alg ${alg}`)
    }],

    ...[
      ['session JWT + ANON_KEY OpenAPI root -> 403', `${api.rest}/`, anonKey, 403],
      ['session JWT + SERVICE_ROLE_KEY OpenAPI root -> 200', `${api.rest}/`, serviceRoleKey, 200],
      ['session JWT + ANON_KEY storage buckets -> 200', `${api.storage}/bucket`, anonKey, 200],

      // CRITICAL upstream: the gateway must keep the user JWT rather than overwrite it
      // with the anon asymmetric JWT it would otherwise synthesize for an opaque key.
      ['opaque apikey + user JWT -> rest OpenAPI 403 (user JWT kept)', `${api.rest}/`, publishableKey, 403],
      ['secret apikey + user JWT -> rest OpenAPI 200', `${api.rest}/`, secretKey, 200],
      ['opaque apikey + user JWT -> storage 200', `${api.storage}/bucket`, publishableKey, 200],
      ['opaque apikey + user JWT -> auth/user 200', `${api.auth}/user`, publishableKey, 200],
    ].map(session),

    ...[
      ['HS256 legacy token + ANON_KEY OpenAPI -> 403', `${api.rest}/`, { apikey: anonKey, Authorization: `Bearer ${legacyRoleToken(jwtSecret, 'anon')}` }, 403],
      ['HS256 legacy token + SERVICE_ROLE_KEY OpenAPI -> 200', `${api.rest}/`, { apikey: serviceRoleKey, Authorization: `Bearer ${legacyRoleToken(jwtSecret, 'service_role')}` }, 200],
    ].map(status),

    ['JWT_KEYS is JSON array with sign key', async () => {
      if (!jwtKeys) return skip('JWT_KEYS not set')
      const parsed = JSON.parse(jwtKeys)
      assertTrue(Array.isArray(parsed), 'JWT_KEYS must be a JSON array')
      assertTrue(
        parsed.some((k) => Array.isArray(k.key_ops) && k.key_ops.includes('sign')),
        'JWT_KEYS missing key_ops: sign',
      )
    }],
  ]

  try {
    return await runChecks('smoke:auth-keys', checks)
  } finally {
    await adminDeleteUser(cfg, user?.userId)
  }
}
