#!/usr/bin/env node
/**
 * Integration tests against a live headless stack.
 *
 *   sdk:*    @supabase/supabase-js method coverage (provisions ephemeral sdk_test_* objects)
 *   smoke:*  HTTP-level gateway / storage checks, modeled on supabase/supabase docker/tests
 *
 *   npm install && npm test          # everything
 *   node . smoke                     # a whole group
 *   node . sdk:storage smoke:s3      # individual suites
 *
 * Prereqs: stack running, repo-root .env, Node 22+, docker compose on PATH.
 * Local HTTPS: export NODE_EXTRA_CA_CERTS="$(pwd)/../caddy-local-root.crt"
 * Captcha on: uses admin generate_link + OTP for sessions.
 * Optional: SDK_TEST_CAPTCHA_TOKEN to exercise password sign-in directly.
 */

import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { getConfig } from './lib/config.mjs'
import { psql } from './lib/docker.mjs'
import { formatError, printCoverageReport, SuiteSkipped, sumTallies } from './lib/runner.mjs'
import { clientOpts, createSdkClients } from './lib/sdk.mjs'
import { runAuthSuite } from './suites/sdk/auth.mjs'
import { runDatabaseSuite } from './suites/sdk/database.mjs'
import { runFunctionsSuite } from './suites/sdk/functions.mjs'
import { runRealtimeSuite } from './suites/sdk/realtime.mjs'
import { runStorageSuite } from './suites/sdk/storage.mjs'
import { runAuthKeysSuite } from './suites/smoke/auth-keys.mjs'
import { runGatewaySuite } from './suites/smoke/gateway.mjs'
import { runS3Suite } from './suites/smoke/s3.mjs'
import { runSelfHostedSuite } from './suites/smoke/self-hosted.mjs'
import { runStorageSuite as runSmokeStorageSuite } from './suites/smoke/storage.mjs'

const SUITES = {
  'sdk:auth': { run: runAuthSuite, sdk: true },
  'sdk:database': { run: runDatabaseSuite, sdk: true },
  'sdk:storage': { run: runStorageSuite, sdk: true },
  'sdk:realtime': { run: runRealtimeSuite, sdk: true },
  'sdk:functions': { run: runFunctionsSuite, sdk: true },
  'smoke:auth-keys': { run: runAuthKeysSuite },
  'smoke:gateway': { run: runGatewaySuite },
  'smoke:self-hosted': { run: runSelfHostedSuite },
  'smoke:storage': { run: runSmokeStorageSuite },
  'smoke:s3': { run: runS3Suite },
}

/** Accepts full names ("smoke:s3") and group prefixes ("smoke"). */
function resolveSuites(args) {
  if (args.length === 0) return Object.keys(SUITES)

  const names = args.flatMap((arg) => {
    const matches = Object.keys(SUITES).filter((name) => name === arg || name.startsWith(`${arg}:`))
    if (matches.length === 0) {
      throw new Error(`Unknown suite: ${arg}\nAvailable: ${Object.keys(SUITES).join(', ')}`)
    }
    return matches
  })
  return [...new Set(names)]
}

function reportSkip(name, reason) {
  console.log(`\n▸ ${name}`)
  console.log(`  ○ suite skipped — ${reason}`)
}

const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: false })

let selected
try {
  selected = resolveSuites(positionals)
} catch (err) {
  console.error(err.message)
  process.exit(2)
}

const cfg = getConfig()
const results = []
let ctx
let provisioned = false

console.log('supabase-headless integration tests')
console.log(`Suites: ${selected.join(', ')}`)

// The SDK suites share one provisioning pass and one set of clients.
const sdkSuites = selected.filter((name) => SUITES[name].sdk)
const sdkReady = Boolean(cfg.publishableKey && cfg.secretKey)
if (sdkSuites.length > 0 && !sdkReady) {
  for (const name of sdkSuites) reportSkip(name, 'needs SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY in .env')
  results.push({ passed: 0, failed: 0, skipped: sdkSuites.length })
  selected = selected.filter((name) => !SUITES[name].sdk)
}

try {
  if (selected.some((name) => SUITES[name].sdk)) {
    console.log('\nProvisioning ephemeral sdk_test_* objects (sql/setup.sql)…')
    psql('setup.sql')
    provisioned = true
    ctx = {
      ...createSdkClients(cfg),
      second: createClient(cfg.url, cfg.publishableKey, clientOpts),
    }
  }

  for (const name of selected) {
    try {
      results.push(await SUITES[name].run(ctx))
    } catch (err) {
      if (err instanceof SuiteSkipped) {
        reportSkip(name, err.message)
        results.push({ passed: 0, failed: 0, skipped: 1 })
      } else {
        console.log(`\n▸ ${name}`)
        console.log(`  ✗ suite failed — ${formatError(err)}`)
        results.push({ passed: 0, failed: 1, skipped: 0 })
      }
    }
  }
} catch (err) {
  console.error(formatError(err))
  results.push({ passed: 0, failed: 1, skipped: 0 })
} finally {
  if (provisioned) {
    console.log('\nTearing down ephemeral sdk_test_* objects…')
    try {
      psql('teardown.sql')
    } catch (err) {
      console.error('Teardown failed:', formatError(err))
      results.push({ passed: 0, failed: 1, skipped: 0 })
    }
  }
  ctx?.anon?.realtime?.disconnect()
  ctx?.second?.realtime?.disconnect()
}

printCoverageReport()

const total = sumTallies(results)
console.log('\n' + '─'.repeat(48))
console.log(`Done: ${total.passed} passed, ${total.skipped} skipped, ${total.failed} failed`)

if (total.failed > 0) process.exit(1)
