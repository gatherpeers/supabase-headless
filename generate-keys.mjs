#!/usr/bin/env node
/**
 * Generate JWT/API-key material and infrastructure secrets for this stack.
 *
 * Two modes:
 *   - default (no flag): print KEY='value' lines to stdout. Single-quoted so a terminal that wraps long lines on copy still produces a parseable .env entry (godotenv / Compose / Node accept multi-line single-quoted values).
 *   - `--update-env`: surgically rewrite variables in `.env` in place, replacing any existing definition (including ones that span multiple lines from a previous bad paste) and appending the rest.
 *
 * Idempotency:
 *   - JWT/API keys: `JWT_SECRET` is reused when already set; everything else in that group is regenerated each run (rotates EC keys, asymmetric JWTs, sb_* keys).
 *   - Infrastructure secrets: generated only when missing or empty (safe to re-run without rotating DB/S3 passwords).
 *
 * Optional env (when invoking Node): `PROJECT_REF_FOR_KEYS` — salt for opaque-key checksums (default: supabase-headless).
 *
 * Run locally:                  `node generate-keys.mjs --update-env`
 * Print only (no .env touch):   `node generate-keys.mjs`
 * Host without Node (e.g. VPS): `docker run --rm -v "${PWD}:/work" -w /work node:24.16.0-alpine node generate-keys.mjs --update-env`
 */

import crypto from 'node:crypto'
import fs from 'node:fs'

const ENV_FILE = '.env'
const updateEnv = process.argv.includes('--update-env')

if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
const { JWT_SECRET, PROJECT_REF_FOR_KEYS } = process.env

/** @param {number} bytes */
function randomHex(bytes) {
	return crypto.randomBytes(bytes).toString('hex')
}

/** Same as `openssl rand -base64 48` (48 random bytes, base64-encoded). */
function randomBase6448() {
	return crypto.randomBytes(48).toString('base64')
}

/**
 * Infrastructure secrets — see README.md / .env.example.
 * Filled only when the variable is missing or blank in `.env`.
 */
const FILL_SECRETS = [
	{ key: 'POSTGRES_PASSWORD', generate: () => randomHex(32) },
	{ key: 'AUTH_DB_PASSWORD', generate: () => randomHex(32) },
	{ key: 'STORAGE_DB_PASSWORD', generate: () => randomHex(32) },
	{ key: 'PGRST_AUTH_PASSWORD', generate: () => randomHex(32) },
	{ key: 'SECRET_KEY_BASE', generate: () => randomBase6448() },
	{ key: 'REALTIME_DB_ENC_KEY', generate: () => randomHex(8) },
	{ key: 'REALTIME_DASHBOARD_PASSWORD', generate: () => randomHex(32) },
	{ key: 'RUSTFS_ACCESS_KEY', generate: () => randomHex(20) },
	{ key: 'RUSTFS_SECRET_KEY', generate: () => randomHex(32) },
]

function signES256(privateKey, kid, payload) {
	const header = { alg: 'ES256', typ: 'JWT', kid }
	const b64h = Buffer.from(JSON.stringify(header)).toString('base64url')
	const b64p = Buffer.from(JSON.stringify(payload)).toString('base64url')
	const data = `${b64h}.${b64p}`
	const sig = crypto
		.sign('SHA256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' })
		.toString('base64url')
	return `${data}.${sig}`
}

function signHS256(secret, payload) {
	const header = { alg: 'HS256', typ: 'JWT' }
	const b64h = Buffer.from(JSON.stringify(header)).toString('base64url')
	const b64p = Buffer.from(JSON.stringify(payload)).toString('base64url')
	const data = `${b64h}.${b64p}`
	const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url')
	return `${data}.${sig}`
}

function generateOpaqueKey(prefix, projectRef) {
	const random = crypto.randomBytes(17).toString('base64url').slice(0, 22)
	const intermediate = prefix + random
	const checksum = crypto
		.createHash('sha256')
		.update(`${projectRef}|${intermediate}`)
		.digest('base64url')
		.slice(0, 8)
	return `${intermediate}_${checksum}`
}

function buildJwtMaterial() {
	const jwtSecret = JWT_SECRET?.trim() || crypto.randomBytes(30).toString('base64')
	const jwtSecretOrigin = JWT_SECRET?.trim() ? 'reused from .env' : 'newly generated'
	const projectRef = PROJECT_REF_FOR_KEYS?.trim() || 'supabase-headless'

	const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const jwk = privateKey.export({ format: 'jwk' })
	const kid = crypto.randomUUID()

	const octKey = {
		kty: 'oct',
		k: Buffer.from(jwtSecret).toString('base64url'),
		alg: 'HS256',
	}

	const jwtKeys = [
		{
			kty: 'EC',
			kid,
			use: 'sig',
			alg: 'ES256',
			ext: true,
			key_ops: ['sign', 'verify'],
			crv: jwk.crv,
			x: jwk.x,
			y: jwk.y,
			d: jwk.d,
		},
		octKey,
	]

	const jwtJwks = {
		keys: [
			{
				kty: 'EC',
				kid,
				use: 'sig',
				alg: 'ES256',
				ext: true,
				key_ops: ['verify'],
				crv: jwk.crv,
				x: jwk.x,
				y: jwk.y,
			},
			octKey,
		],
	}

	const iat = Math.floor(Date.now() / 1000)
	const exp = iat + 5 * 365 * 24 * 3600

	return {
		jwtSecretOrigin,
		material: {
			JWT_SECRET: jwtSecret,
			JWT_KEYS: JSON.stringify(jwtKeys),
			JWT_JWKS: JSON.stringify(jwtJwks),
			ANON_KEY_ASYMMETRIC: signES256(privateKey, kid, {
				role: 'anon',
				iss: 'supabase',
				iat,
				exp,
			}),
			SERVICE_ROLE_KEY_ASYMMETRIC: signES256(privateKey, kid, {
				role: 'service_role',
				iss: 'supabase',
				iat,
				exp,
			}),
			SUPABASE_PUBLISHABLE_KEY: generateOpaqueKey('sb_publishable_', projectRef),
			SUPABASE_SECRET_KEY: generateOpaqueKey('sb_secret_', projectRef),
			ANON_KEY: signHS256(jwtSecret, { role: 'anon', iss: 'supabase', iat, exp }),
			SERVICE_ROLE_KEY: signHS256(jwtSecret, { role: 'service_role', iss: 'supabase', iat, exp }),
		},
	}
}

function buildFillSecrets() {
	/** @type {Record<string, string>} */
	const material = {}
	/** @type {string[]} */
	const filledKeys = []
	for (const { key, generate } of FILL_SECRETS) {
		if (process.env[key]?.trim()) continue
		material[key] = generate()
		filledKeys.push(key)
	}
	return { material, filledKeys }
}

// `.env` line classifier: a line that starts a variable assignment (KEY=...) or a comment, or is empty. Anything else is treated as a continuation line of a previous (bad-paste) multi-line value and skipped on replace.
function isAssignmentOrCommentOrBlank(line) {
	return /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) || /^\s*#/.test(line) || line.trim() === ''
}

function replaceOrAppend(content, key, value) {
	const lines = content.length === 0 ? [] : content.split(/\r?\n/)
	const out = []
	let replaced = false
	let i = 0
	while (i < lines.length) {
		if (lines[i].startsWith(`${key}=`)) {
			out.push(`${key}=${value}`)
			replaced = true
			i++
			while (i < lines.length && !isAssignmentOrCommentOrBlank(lines[i])) i++
		} else {
			out.push(lines[i])
			i++
		}
	}
	if (!replaced) {
		if (out.length > 0 && out[out.length - 1] !== '') out.push('')
		out.push(`${key}=${value}`)
	}
	return out.join('\n')
}

const { jwtSecretOrigin, material: jwtMaterial } = buildJwtMaterial()
const { material: fillMaterial, filledKeys } = buildFillSecrets()
const generated = { ...jwtMaterial, ...fillMaterial }

if (updateEnv) {
	let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
	for (const [key, value] of Object.entries(generated)) {
		content = replaceOrAppend(content, key, value)
	}
	fs.writeFileSync(ENV_FILE, content)
	const jwtCount = Object.keys(jwtMaterial).length
	const fillMsg =
		filledKeys.length > 0
			? `filled ${filledKeys.length} infrastructure secret(s): ${filledKeys.join(', ')}`
			: 'all infrastructure secrets already set (skipped)'
	console.log(
		`Updated ${ENV_FILE}: rewrote ${jwtCount} JWT/API variables (JWT_SECRET ${jwtSecretOrigin}), ${fillMsg}. Restart the stack with: docker compose down && docker compose up -d`
	)
} else {
	const lines = Object.entries(generated).map(([key, value]) => `${key}='${value}'`)
	const fillNote =
		filledKeys.length > 0
			? `Generated ${filledKeys.length} infrastructure secret(s) that were missing or empty.`
			: 'All infrastructure secrets were already set in .env (not regenerated).'
	console.log(`
# ----------------------
Copy the values below into your .env file.

JWT_SECRET was ${jwtSecretOrigin}.
JWT/API material was generated freshly on this run.
${fillNote}
# ----------------------

${lines.join('\n')}
`)
}