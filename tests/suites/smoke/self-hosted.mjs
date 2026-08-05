/**
 * End-to-end self-hosted smoke (upstream docker/tests/test-self-hosted.sh, headless-adapted).
 * Skips Studio, GraphQL, pg-meta and MCP (non-goals / not enabled here).
 */

import { getConfig, requireEnv } from '../../lib/config.mjs'
import { assertEqual, assertTrue, runChecks, skip } from '../../lib/runner.mjs'
import { composePs, composeServices } from '../../lib/docker.mjs'
import { http, httpStatus, uniqueId } from '../../lib/http.mjs'
import { adminDeleteUser, createSessionUser } from '../../lib/auth.mjs'

/** Report every declared service that is not running-and-healthy or a cleanly exited one-shot. */
function unhealthyServices() {
  const rows = composePs()
  const byService = new Map(rows.map((row) => [row.Service, row]))

  return composeServices().flatMap((service) => {
    const row = byService.get(service)
    if (!row) return [`${service}: no container`]

    const state = String(row.State || '').toLowerCase()
    const health = String(row.Health || '').toLowerCase()

    // One-shots (db-migrate, rustfs-createbucket) exit 0 and stay exited.
    if (state === 'exited') {
      return row.ExitCode === 0 ? [] : [`${service}: exited ${row.ExitCode}`]
    }
    if (state !== 'running') return [`${service}: ${state || 'unknown state'}`]
    if (health && health !== 'healthy') return [`${service}: ${health}`]
    return []
  })
}

export async function runSelfHostedSuite() {
  const cfg = getConfig()
  requireEnv(cfg, 'publishableKey', 'secretKey', 'anonKey', 'serviceRoleKey')
  const { api, publishableKey, secretKey, anonKey, serviceRoleKey } = cfg
  let user

  const checks = [
    ['all compose services healthy', async () => {
      // Compared against `docker compose config --services` so a service that failed to
      // start at all (and is therefore absent from `ps`) is caught rather than ignored.
      const bad = unhealthyServices()
      assertEqual(bad.length, 0, bad.join(', '))
    }],

    ['auth: admin create user + sign in', async () => {
      user = await createSessionUser(cfg)
      assertEqual(
        await httpStatus(`${api.auth}/user`, {
          headers: { apikey: anonKey, Authorization: `Bearer ${user.accessToken}` },
        }),
        200,
      )
    }],
    ['auth: public signup responds', async () => {
      const email = `${uniqueId('signup')}@example.com`
      const signup = await http(`${api.auth}/signup`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'smoke-test-password-123456' }),
      })
      const id = signup.json?.id || signup.json?.user?.id
      if (id) await adminDeleteUser(cfg, id)

      if (signup.status === 422) return skip('public signup disabled')
      assertEqual(signup.status, 200, signup.text)
      // Without autoconfirm gotrue returns the user but no session; upstream skips here too.
      if (!signup.json?.access_token) return skip('no session — autoconfirm is off')
    }],

    ['rest OpenAPI: anon/publishable -> 403', async () => {
      assertEqual(await httpStatus(`${api.rest}/`, { headers: { apikey: publishableKey } }), 403)
    }],
    ['rest OpenAPI: secret -> 200', async () => {
      assertEqual(await httpStatus(`${api.rest}/`, { headers: { apikey: secretKey } }), 200)
    }],

    ['storage status -> 200', async () => {
      assertEqual(await httpStatus(`${api.storage}/status`), 200)
    }],

    ['functions: example1 invoke', async () => {
      const res = await http(`${api.functions}/example1?name=smoke`, {
        headers: { Authorization: `Bearer ${anonKey}` },
      })
      assertEqual(res.status, 200, res.text)
      assertTrue(String(res.json?.message || '').includes('smoke'), res.text)
    }],
    ['functions: /_internal blocked -> 404', async () => {
      assertEqual(await httpStatus(`${api.functions}/_internal`), 404)
    }],

    ['realtime: api/ping -> 200', async () => {
      assertEqual(await httpStatus(`${api.realtime}/api/ping`, { headers: { apikey: anonKey } }), 200)
    }],
    ['realtime: api/tenants blocked -> 403', async () => {
      assertEqual(await httpStatus(`${api.realtime}/api/tenants`, { headers: { apikey: anonKey } }), 403)
    }],
    ['realtime: api/openapi blocked -> 403', async () => {
      assertEqual(await httpStatus(`${api.realtime}/api/openapi`, { headers: { apikey: anonKey } }), 403)
    }],

    ['JWKS open without apikey', async () => {
      assertEqual(await httpStatus(`${api.auth}/.well-known/jwks.json`), 200)
    }],
  ]

  try {
    return await runChecks('smoke:self-hosted', checks)
  } finally {
    await adminDeleteUser(cfg, user?.userId)
  }
}
