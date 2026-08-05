/**
 * Check runner shared by every suite.
 *
 * A check is `[name, fn]` or `[name, fn, { skip: reason }]`. `fn` throws to fail,
 * returns `skip(reason)` to skip at runtime, or returns anything else to pass.
 */

/** Thrown by a suite to skip itself entirely (missing config, disabled feature). */
export class SuiteSkipped extends Error {}

const SKIP = Symbol('skip')

/** Return this from a check body to skip it at runtime. */
export function skip(reason = '') {
  return { [SKIP]: reason }
}

/** @type {Map<string, { status: 'pass'|'fail'|'skip', note?: string }>} */
const coverage = new Map()

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

/**
 * @param {string} section printed as the suite heading
 * @param {Array} checks
 * @param {{ track?: boolean }} [opts] track=true also records results for the SDK coverage report
 */
export async function runChecks(section, checks, { track = false } = {}) {
  console.log(`\n▸ ${section}`)
  const tally = { passed: 0, failed: 0, skipped: 0 }
  const record = (name, status, note) => track && coverage.set(name, { status, note })

  for (const [name, fn, opts] of checks) {
    if (opts?.skip) {
      record(name, 'skip', opts.skip)
      console.log(`  ○ ${name} — ${opts.skip}`)
      tally.skipped++
      continue
    }
    if (typeof fn !== 'function') throw new Error(`No handler for ${name}`)

    try {
      const result = await fn()
      if (result && typeof result === 'object' && SKIP in result) {
        const reason = result[SKIP]
        record(name, 'skip', reason || undefined)
        console.log(`  ○ ${name}${reason ? ` — ${reason}` : ''}`)
        tally.skipped++
        continue
      }
      record(name, 'pass')
      console.log(`  ✓ ${name}`)
      tally.passed++
    } catch (err) {
      const msg = formatError(err)
      record(name, 'fail', msg)
      console.log(`  ✗ ${name}`)
      console.log(`    ${msg}`)
      tally.failed++
    }
  }

  return tally
}

export function sumTallies(tallies) {
  return tallies.reduce(
    (acc, t) => ({
      passed: acc.passed + t.passed,
      failed: acc.failed + t.failed,
      skipped: acc.skipped + t.skipped,
    }),
    { passed: 0, failed: 0, skipped: 0 },
  )
}

export function assertEqual(actual, expected, detail = '') {
  if (actual !== expected) {
    const suffix = detail ? ` (${detail})` : ''
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${suffix}`)
  }
}

export function assertNot(actual, forbidden, detail = '') {
  if (actual === forbidden) {
    const suffix = detail ? ` (${detail})` : ''
    throw new Error(`expected anything but ${JSON.stringify(forbidden)}${suffix}`)
  }
}

export function assertTrue(cond, detail) {
  if (!cond) throw new Error(detail || 'assertion failed')
}

/** Prints the @supabase/supabase-js method coverage table; no-op for smoke-only runs. */
export function printCoverageReport() {
  if (coverage.size === 0) return

  const groups = new Map()
  for (const [method, info] of coverage) {
    const [ns] = method.split('.')
    groups.set(ns, [...(groups.get(ns) ?? []), { method, ...info }])
  }

  console.log('\n' + '═'.repeat(60))
  console.log('  @supabase/supabase-js method coverage')
  console.log('═'.repeat(60))

  const totals = { pass: 0, fail: 0, skip: 0 }
  for (const [ns, items] of [...groups.entries()].sort()) {
    console.log(`\n  ${ns}`)
    for (const { method, status, note } of items.sort((a, b) => a.method.localeCompare(b.method))) {
      const icon = status === 'pass' ? '✓' : status === 'skip' ? '○' : '✗'
      console.log(`    ${icon} ${method}${note ? ` — ${note}` : ''}`)
      totals[status]++
    }
  }

  const total = totals.pass + totals.fail + totals.skip
  console.log(`\n  ${totals.pass} passed · ${totals.skip} skipped · ${totals.fail} failed · ${total} tracked`)
  console.log('═'.repeat(60))
}
