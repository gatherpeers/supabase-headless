import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { loadEnvFile } from 'node:process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const dir = import.meta.dirname
const root = resolve(dir, '../..')
const sqlDir = resolve(dir, 'sql')
const envFile = resolve(root, '.env')

let envLoaded = false

/** Node's built-in .env parser + ${VAR} expansion (not supported natively). */
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
    loadEnvFile(envFile)
  } catch (err) {
    throw new Error('Missing .env in repo root', { cause: err })
  }
  expandEnvRefs()
  envLoaded = true
}

export function getConfig() {
  loadEnv()
  const url = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '')
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY
  const secretKey = process.env.SUPABASE_SECRET_KEY
  const legacyAnonKey = process.env.ANON_KEY
  const passwordMinLength = Number(process.env.GOTRUE_PASSWORD_MIN_LENGTH || 10)
  const captchaEnabled = (process.env.GOTRUE_SECURITY_CAPTCHA_ENABLED || 'false') === 'true'
  const anonymousEnabled = (process.env.GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED || 'false') === 'true'
  const mailerAutoconfirm = (process.env.GOTRUE_MAILER_AUTOCONFIRM || 'false') === 'true'

  if (!url) throw new Error('PUBLIC_API_URL is not set')
  if (!publishableKey) throw new Error('SUPABASE_PUBLISHABLE_KEY is not set')
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY is not set')

  return {
    url,
    publishableKey,
    secretKey,
    legacyAnonKey,
    passwordMinLength,
    captchaEnabled,
    anonymousEnabled,
    mailerAutoconfirm,
  }
}

export function testPassword(config) {
  const min = Math.max(config.passwordMinLength, 10)
  return `Test-${'x'.repeat(min)}1A`
}

export function uniqueEmail(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}@compat.local`
}

export const clientOpts = { auth: { persistSession: false, autoRefreshToken: false } }

/** @type {Map<string, { status: 'pass'|'fail'|'skip', note?: string }>} */
export const sdkCoverage = new Map()

export function mark(method, status, note) {
  sdkCoverage.set(method, { status, note })
}

export function skip(method, note) {
  mark(method, 'skip', note)
}

export function pass(method) {
  mark(method, 'pass')
}

export function fail(method, note) {
  mark(method, 'fail', note)
}

export function createSdkClients(config = getConfig()) {
  return {
    config,
    anon: createClient(config.url, config.publishableKey, clientOpts),
    service: createClient(config.url, config.secretKey, clientOpts),
  }
}

function runPsql(file) {
  const sql = readFileSync(resolve(sqlDir, file), 'utf8')
  const result = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { cwd: root, input: sql, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`psql ${file} failed: ${detail || 'unknown error'}`)
  }
}

export async function provisionTestObjects() {
  runPsql('setup.sql')
}

export async function teardownTestObjects() {
  runPsql('teardown.sql')
}

export function formatError(err) {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const parts = [err.message, err.code, err.details, err.hint].filter(Boolean)
    if (parts.length) return parts.join(' | ')
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

export async function signInExistingUser(anon, service, { email, password }, config = getConfig()) {
  const captchaToken = process.env.SDK_TEST_CAPTCHA_TOKEN?.trim()

  if (!config.captchaEnabled || captchaToken) {
    const { data, error } = await anon.auth.signInWithPassword({
      email,
      password,
      options: captchaToken ? { captchaToken } : undefined,
    })
    if (!error) return data.session
    if (!config.captchaEnabled) throw error
  }

  const link = await service.auth.admin.generateLink({ type: 'magiclink', email })
  if (link.error) throw link.error

  const otp = await anon.auth.verifyOtp({
    email,
    token: link.data.properties.email_otp,
    type: 'email',
  })
  if (otp.error) throw otp.error
  return otp.data.session
}

/** Create a confirmed user and establish a session on `anon` (captcha-safe). */
export async function signInTestUser(anon, service, config = getConfig()) {
  const email = uniqueEmail('sdk')
  const password = testPassword(config)
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (created.error) throw created.error
  const session = await signInExistingUser(anon, service, { email, password }, config)
  return { email, password, userId: created.data.user.id, session }
}

export async function reseed(service) {
  const { error } = await service.rpc('sdk_test_seed')
  if (error) throw new Error(formatError(error))
}

export async function runMethod(name, fn) {
  try {
    const result = await fn()
    if (result === 'skip') return ['skip', null]
    pass(name)
    return ['pass', null]
  } catch (err) {
    const msg = formatError(err)
    fail(name, msg)
    return ['fail', msg]
  }
}

/** Run SDK method checks: [methodName, fn] or [methodName, fn, { skip: reason }] */
export async function runSdkSuite(section, tests) {
  console.log(`\n▸ ${section}`)
  let passed = 0
  let failed = 0
  let skipped = 0
  const failures = []

  for (const entry of tests) {
    const [method, fn, opts] = entry
    if (opts?.skip) {
      skip(method, opts.skip)
      console.log(`  ○ ${method} — ${opts.skip}`)
      skipped++
      continue
    }
    if (typeof fn !== 'function') {
      throw new Error(`No handler for ${method}`)
    }
    const [status, msg] = await runMethod(method, fn)
    if (status === 'pass') {
      console.log(`  ✓ ${method}`)
      passed++
    } else if (status === 'skip') {
      console.log(`  ○ ${method}`)
      skipped++
    } else {
      console.log(`  ✗ ${method}`)
      console.log(`    ${msg}`)
      failures.push({ label: method, msg })
      failed++
    }
  }

  return { passed, failed, skipped, failures }
}

export function printCoverageReport() {
  const groups = new Map()
  for (const [method, info] of sdkCoverage) {
    const [ns] = method.split('.')
    const list = groups.get(ns) ?? []
    list.push({ method, ...info })
    groups.set(ns, list)
  }

  console.log('\n' + '═'.repeat(60))
  console.log('  @supabase/supabase-js method coverage')
  console.log('═'.repeat(60))

  let pass = 0
  let fail = 0
  let skip = 0

  for (const [ns, items] of [...groups.entries()].sort()) {
    console.log(`\n  ${ns}`)
    for (const { method, status, note } of items.sort((a, b) => a.method.localeCompare(b.method))) {
      const icon = status === 'pass' ? '✓' : status === 'skip' ? '○' : '✗'
      const suffix = note ? ` — ${note}` : ''
      console.log(`    ${icon} ${method}${suffix}`)
      if (status === 'pass') pass++
      else if (status === 'skip') skip++
      else fail++
    }
  }

  const total = pass + fail + skip
  console.log(`\n  ${pass} passed · ${skip} skipped · ${fail} failed · ${total} tracked`)
  console.log('═'.repeat(60))
}

