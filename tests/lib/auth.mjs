/** Raw-HTTP Auth helpers for the smoke suites (no supabase-js involved). */

import { createHmac } from 'node:crypto'
import { http, httpStatus, keyHeaders, uniqueId } from './http.mjs'

const TEST_PASSWORD = 'smoke-test-password-123456'

const jsonHeaders = (headers) => ({ ...headers, 'Content-Type': 'application/json' })

export function mintHs256(secret, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

/** HS256 token for `role`, valid for an hour — mirrors upstream's inline node snippet. */
export function legacyRoleToken(secret, role) {
  const now = Math.floor(Date.now() / 1000)
  return mintHs256(secret, { role, iss: 'supabase', iat: now, exp: now + 3600 })
}

export function decodeJwtHeader(token) {
  const [header] = token.split('.')
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
}

export async function adminCreateUser(cfg, email, password = TEST_PASSWORD) {
  const res = await http(`${cfg.api.auth}/admin/users`, {
    method: 'POST',
    headers: jsonHeaders(keyHeaders(cfg.serviceRoleKey)),
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  if (!res.json?.id) throw new Error(`create user failed: ${res.text}`)
  return res.json.id
}

export function adminDeleteUser(cfg, userId) {
  if (!userId) return Promise.resolve()
  return httpStatus(`${cfg.api.auth}/admin/users/${userId}`, {
    method: 'DELETE',
    headers: keyHeaders(cfg.serviceRoleKey),
  }).catch(() => {})
}

async function passwordToken(cfg, email) {
  const res = await http(`${cfg.api.auth}/token?grant_type=password`, {
    method: 'POST',
    headers: jsonHeaders({ apikey: cfg.anonKey }),
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  })
  if (!res.json?.access_token) throw new Error(`sign-in failed: ${res.text}`)
  return res.json.access_token
}

/** Captcha blocks the password grant, so mint a session through the magiclink OTP instead. */
async function otpToken(cfg, email) {
  const link = await http(`${cfg.api.auth}/admin/generate_link`, {
    method: 'POST',
    headers: jsonHeaders(keyHeaders(cfg.serviceRoleKey)),
    body: JSON.stringify({ type: 'magiclink', email }),
  })
  const token = link.json?.email_otp
  if (!token) throw new Error(`generate_link failed: ${link.text}`)

  const res = await http(`${cfg.api.auth}/verify`, {
    method: 'POST',
    headers: jsonHeaders({ apikey: cfg.anonKey }),
    body: JSON.stringify({ type: 'email', email, token }),
  })
  if (!res.json?.access_token) throw new Error(`verifyOtp failed: ${res.text}`)
  return res.json.access_token
}

/** Confirmed user plus a live access token, whichever grant the stack allows. */
export async function createSessionUser(cfg, prefix = 'smoke') {
  const email = `${uniqueId(prefix)}@example.com`
  const userId = await adminCreateUser(cfg, email)
  const accessToken = cfg.captchaEnabled ? await otpToken(cfg, email) : await passwordToken(cfg, email)
  return { email, userId, accessToken }
}
