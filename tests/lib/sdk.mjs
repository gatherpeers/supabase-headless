/** @supabase/supabase-js client helpers for the SDK suites. */

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { getConfig } from './config.mjs'
import { formatError } from './runner.mjs'

export const clientOpts = { auth: { persistSession: false, autoRefreshToken: false } }

export function testPassword(config) {
  const min = Math.max(config.passwordMinLength, 10)
  return `Test-${'x'.repeat(min)}1A`
}

export function uniqueEmail(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}@compat.local`
}

export function createSdkClients(config = getConfig()) {
  return {
    config,
    anon: createClient(config.url, config.publishableKey, clientOpts),
    service: createClient(config.url, config.secretKey, clientOpts),
  }
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
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  const session = await signInExistingUser(anon, service, { email, password }, config)
  return { email, password, userId: created.data.user.id, session }
}

export async function reseed(service) {
  const { error } = await service.rpc('sdk_test_seed')
  if (error) throw new Error(formatError(error))
}
