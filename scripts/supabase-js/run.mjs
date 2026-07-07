#!/usr/bin/env node
/**
 * @supabase/supabase-js SDK coverage against the self-hosted stack.
 *
 * Creates ephemeral sdk_test_* tables + buckets via docker psql, exercises SDK
 * methods one-by-one, then drops everything. Does not touch your app schema.
 *
 * Prereqs: stack running, repo-root .env, Node 22+.
 *   cd scripts/supabase-js && npm install
 *   npm test
 *   node run.mjs auth database storage
 *
 * Local HTTPS: export NODE_EXTRA_CA_CERTS="$(pwd)/caddy-local-root.crt" (see README)
 * Captcha on: uses auth.admin.generateLink + auth.verifyOtp for sessions.
 * Optional: SDK_TEST_CAPTCHA_TOKEN for auth.signInWithPassword directly.
 */

import { createClient } from '@supabase/supabase-js'
import { parseArgs } from 'node:util'
import { runAuthSuite } from './tests/auth.mjs'
import { runDatabaseSuite } from './tests/database.mjs'
import { runFunctionsSuite } from './tests/functions.mjs'
import { runRealtimeSuite } from './tests/realtime.mjs'
import { runStorageSuite } from './tests/storage.mjs'
import {
  clientOpts,
  createSdkClients,
  loadEnv,
  printCoverageReport,
  provisionTestObjects,
  teardownTestObjects,
} from './lib.mjs'

const suites = {
  auth: runAuthSuite,
  database: runDatabaseSuite,
  storage: runStorageSuite,
  realtime: runRealtimeSuite,
  functions: runFunctionsSuite,
}

const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: false })
const toRun = positionals.length > 0 ? positionals : Object.keys(suites)

loadEnv()

console.log('@supabase/supabase-js SDK coverage')
console.log(`Suites: ${toRun.join(', ')}`)

let totalPassed = 0
let totalFailed = 0
let totalSkipped = 0
let ctx

try {
  console.log('\nProvisioning ephemeral sdk_test_* objects (sql/setup.sql)…')
  await provisionTestObjects()

  const base = createSdkClients()
  ctx = {
    ...base,
    second: createClient(base.config.url, base.config.publishableKey, clientOpts),
  }

  for (const name of toRun) {
    const fn = suites[name]
    if (!fn) throw new Error(`Unknown suite: ${name}`)
    const result = await fn(ctx)
    totalPassed += result.passed
    totalFailed += result.failed
    totalSkipped += result.skipped
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  totalFailed++
} finally {
  console.log('\nTearing down ephemeral sdk_test_* objects…')
  try {
    await teardownTestObjects()
  } catch (err) {
    console.error('Teardown failed:', err instanceof Error ? err.message : err)
    totalFailed++
  }

  ctx?.anon?.realtime?.disconnect()
  ctx?.second?.realtime?.disconnect()
}

printCoverageReport()

console.log('\n' + '─'.repeat(48))
console.log(`Done: ${totalPassed} passed, ${totalSkipped} skipped, ${totalFailed} failed`)

if (totalFailed > 0) process.exit(1)
