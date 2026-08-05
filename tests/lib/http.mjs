/** HTTP + hashing helpers for the gateway-level smoke suites. */

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
export const uniqueId = (prefix) => `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}`

/** The apikey + matching Bearer pair that supabase-js sends. */
export const keyHeaders = (key) => ({ apikey: key, Authorization: `Bearer ${key}` })

// Redirects stay unfollowed by default so a check sees the status the gateway returned.
const withDefaults = (init) => ({ redirect: 'manual', ...init })

export async function httpStatus(url, init = {}) {
  const res = await fetch(url, withDefaults(init))
  return res.status
}

export async function http(url, init = {}) {
  const res = await fetch(url, withDefaults(init))
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, text, json }
}

export async function httpBytes(url, init = {}) {
  const res = await fetch(url, withDefaults(init))
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) }
}

/** WebSocket upgrade probe: Node's fetch cannot complete the handshake. */
export function curlHttpStatus(url, headers = {}, { maxTimeSec = 2 } = {}) {
  const args = ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(maxTimeSec), url]
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)

  const result = spawnSync('curl', args, { encoding: 'utf8' })
  const code = (result.stdout || '').trim()
  // curl exits non-zero on 101 / timeout while still printing the status ("000" on timeout).
  if (!/^\d{3}$/.test(code)) {
    throw new Error(`curl failed: ${result.stderr || result.stdout || result.error || 'unknown'}`)
  }
  return Number(code)
}
