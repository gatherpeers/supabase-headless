/** Thin `docker compose` wrappers used for stack health and SQL fixtures. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { root } from './config.mjs'

function docker(args, input) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', input })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`docker ${args.join(' ')} failed: ${detail || 'unknown error'}`)
  }
  return result.stdout || ''
}

/** Every service declared in compose.yml, including one-shots. */
export function composeServices() {
  return docker(['compose', 'config', '--services'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Container rows including exited one-shots, so a missing service is detectable. */
export function composePs() {
  const raw = docker(['compose', 'ps', '--all', '--format', 'json']).trim()
  if (!raw) return []
  // Compose emits either a JSON array or one object per line depending on version.
  if (raw.startsWith('[')) return JSON.parse(raw)
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function psql(file) {
  const sql = readFileSync(resolve(import.meta.dirname, '../sql', file), 'utf8')
  docker(
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    sql,
  )
}
