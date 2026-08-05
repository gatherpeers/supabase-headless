/**
 * Repo-root `.env` loading and the config surface shared by both suites.
 *
 * Only PUBLIC_API_URL is mandatory. Everything else is validated per-suite via
 * `requireEnv`, so a stack running without the optional legacy HS256 keys can
 * still run the suites that do not need them.
 */

import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'
import { SuiteSkipped } from './runner.mjs'

export const root = resolve(import.meta.dirname, '../..')

const text = (env, fallback = '') => ({ env, fallback })
const flag = (env) => ({ env, fallback: 'false', map: (v) => v === 'true' })

const SPEC = {
  url: { env: 'PUBLIC_API_URL', map: (v) => v.replace(/\/$/, '') },
  publishableKey: text('SUPABASE_PUBLISHABLE_KEY'),
  secretKey: text('SUPABASE_SECRET_KEY'),
  anonKey: text('ANON_KEY'),
  serviceRoleKey: text('SERVICE_ROLE_KEY'),
  jwtSecret: text('JWT_SECRET'),
  jwtKeys: text('JWT_KEYS'),
  authPrefix: text('AUTH_PREFIX', '/auth/v1'),
  restPrefix: text('REST_PREFIX', '/rest/v1'),
  realtimePrefix: text('REALTIME_PREFIX', '/realtime/v1'),
  storagePrefix: text('STORAGE_PREFIX', '/storage/v1'),
  functionsPrefix: text('FUNCTIONS_PREFIX', '/functions/v1'),
  dashboardPrefix: text('REALTIME_DASHBOARD_PREFIX', '/admin'),
  s3AccessKeyId: text('S3_PROTOCOL_ACCESS_KEY_ID'),
  s3SecretAccessKey: text('S3_PROTOCOL_ACCESS_KEY_SECRET'),
  s3Region: text('S3_REGION', 'local'),
  passwordMinLength: { env: 'GOTRUE_PASSWORD_MIN_LENGTH', fallback: '10', map: Number },
  captchaEnabled: flag('GOTRUE_SECURITY_CAPTCHA_ENABLED'),
  anonymousEnabled: flag('GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED'),
  mailerAutoconfirm: flag('GOTRUE_MAILER_AUTOCONFIRM'),
}

let envLoaded = false
let cached

/** Node's built-in .env parser has no ${VAR} expansion, so do it here. */
function expandEnvRefs() {
  for (let pass = 0; pass < 10; pass++) {
    let changed = false
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== 'string' || !value.includes('${')) continue
      const expanded = value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name.trim()] ?? '')
      if (expanded !== value) {
        process.env[key] = expanded
        changed = true
      }
    }
    if (!changed) break
  }
}

export function loadEnv() {
  if (envLoaded) return
  try {
    loadEnvFile(resolve(root, '.env'))
  } catch (err) {
    throw new Error('Missing .env in repo root', { cause: err })
  }
  expandEnvRefs()
  envLoaded = true
}

export function getConfig() {
  if (cached) return cached
  loadEnv()

  const cfg = {}
  for (const [key, { env, fallback = '', map }] of Object.entries(SPEC)) {
    const raw = process.env[env]?.trim() || fallback
    cfg[key] = map ? map(raw) : raw
  }
  if (!cfg.url) throw new Error('PUBLIC_API_URL is not set')

  cfg.api = {
    auth: cfg.url + cfg.authPrefix,
    rest: cfg.url + cfg.restPrefix,
    realtime: cfg.url + cfg.realtimePrefix,
    storage: cfg.url + cfg.storagePrefix,
    functions: cfg.url + cfg.functionsPrefix,
  }

  cached = cfg
  return cfg
}

/** Skip the calling suite unless every named config key resolved to a value. */
export function requireEnv(cfg, ...keys) {
  const missing = keys.filter((key) => !cfg[key])
  if (missing.length) {
    throw new SuiteSkipped(`needs ${missing.map((key) => SPEC[key].env).join(', ')} in .env`)
  }
}
