#!/usr/bin/env node
/**
 * Generate JWT/API-key material and infrastructure secrets for this stack.
 *
 * Two modes:
 *   - default (no flag): print KEY='value' lines to stdout. Single-quoted so a terminal that wraps long lines on copy still produces a parseable .env entry (godotenv / Compose / Node accept multi-line single-quoted values).
 *   - `--update-env`: surgically rewrite variables in `.env` in place, replacing any existing definition (including ones that span multiple lines from a previous bad paste) and appending the rest.
 *
 * Idempotency (safe to re-run — nothing is silently rotated):
 *   - JWT/API keys: every variable in this group is generated only when missing or empty.
 *     Existing values are preserved. When some (but not all) are missing, the existing EC
 *     signing key from `JWT_KEYS` is reused so newly-filled asymmetric values stay coherent
 *     with the already-shipped ones.
 *   - Infrastructure secrets: generated only when missing or empty (never rotates DB/S3 passwords).
 *
 * Rotation (opt-in): pass `--rotate` to force-regenerate the ENTIRE JWT/API group — a fresh EC
 *     keypair, asymmetric JWTs, sb_* keys, and legacy HS256 keys. `JWT_SECRET` is still reused
 *     when already set. This invalidates every distributed client key and every asymmetric-signed
 *     session, so only use it when you intend to rotate credentials.
 *
 * Run locally:                  `node generate-keys.mjs --update-env`
 * Force rotation:               `node generate-keys.mjs --update-env --rotate`
 * Print only (no .env touch):   `node generate-keys.mjs`
 * Host without Node (e.g. VPS): `docker run --rm -v "${PWD}:/work" -w /work node:24.18.0-alpine node generate-keys.mjs --update-env`
 */

import crypto from 'node:crypto'
import fs from 'node:fs'

const ENV_FILE = '.env'
const updateEnv = process.argv.includes('--update-env')
const rotate = process.argv.includes('--rotate')

if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
const { JWT_SECRET } = process.env

/** Whether a variable is already set to a non-blank value in the loaded environment. */
function present(key) {
	return typeof process.env[key] === 'string' && process.env[key].trim() !== ''
}

/** @param {number} bytes */
function randomHex(bytes) {
	return crypto.randomBytes(bytes).toString('hex')
}

/**
 * Phoenix `secret_key_base` for Realtime. Phoenix requires >= 64 bytes and uses the
 * value as raw bytes (KDF seed), so 64 random bytes give full entropy with margin above
 * the floor. base64url output is .env/Compose-safe: only [A-Za-z0-9_-], no spaces, no
 * +/= that could need quoting or break on copy/paste.
 */
function randomSecretKeyBase() {
	return crypto.randomBytes(64).toString('base64url')
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
	{ key: 'REALTIME_SECRET_KEY_BASE', generate: () => randomSecretKeyBase() },
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

const SELF_HOSTED_PROJECT_REF = 'supabase-self-hosted'

function generateOpaqueKey(prefix) {
	const random = crypto.randomBytes(17).toString('base64url').slice(0, 22)
	const intermediate = prefix + random
	const checksum = crypto
		.createHash('sha256')
		.update(`${SELF_HOSTED_PROJECT_REF}|${intermediate}`)
		.digest('base64url')
		.slice(0, 8)
	return `${intermediate}_${checksum}`
}

/**
 * Reconstruct the EC signing key + kid from an existing `JWT_KEYS` value so that
 * only-if-missing fills can sign new asymmetric tokens that verify against the
 * already-published JWKS. Returns null when unavailable or unparseable.
 */
function loadExistingEcKey() {
	const raw = process.env.JWT_KEYS?.trim()
	if (!raw) return null
	try {
		const keys = JSON.parse(raw)
		const ec = Array.isArray(keys) ? keys.find((k) => k?.kty === 'EC' && k?.d) : null
		if (!ec) return null
		const privateKey = crypto.createPrivateKey({
			key: { kty: 'EC', crv: ec.crv, x: ec.x, y: ec.y, d: ec.d },
			format: 'jwk',
		})
		return { privateKey, kid: ec.kid || crypto.randomUUID() }
	} catch {
		return null
	}
}

/** @param {boolean} forceRotate when true, always mint a fresh EC keypair (ignores existing) */
function buildJwtMaterial(forceRotate) {
	const jwtSecret = JWT_SECRET?.trim() || crypto.randomBytes(30).toString('base64')
	const jwtSecretOrigin = JWT_SECRET?.trim() ? 'reused from .env' : 'newly generated'

	const existing = forceRotate ? null : loadExistingEcKey()
	const ecKeyOrigin = existing ? 'reused from .env' : 'newly generated'
	let privateKey
	let kid
	if (existing) {
		privateKey = existing.privateKey
		kid = existing.kid
	} else {
		;({ privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }))
		kid = crypto.randomUUID()
	}
	const jwk = privateKey.export({ format: 'jwk' })

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
		ecKeyOrigin,
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
			SUPABASE_PUBLISHABLE_KEY: generateOpaqueKey('sb_publishable_'),
			SUPABASE_SECRET_KEY: generateOpaqueKey('sb_secret_'),
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

/**
 * Decide which freshly-built JWT/API values to actually write.
 *   - `--rotate`: write the whole group (full rotation).
 *   - default: only write variables that are currently missing or blank; keep existing values.
 * Also surfaces coherence warnings for partially-present groups that cannot be reconciled
 * without a rotation.
 */
function selectJwtMaterial(fullMaterial, forceRotate) {
	if (forceRotate) {
		return { material: { ...fullMaterial }, filledKeys: Object.keys(fullMaterial), keptKeys: [], warnings: [] }
	}

	/** @type {Record<string, string>} */
	const material = {}
	/** @type {string[]} */
	const filledKeys = []
	/** @type {string[]} */
	const keptKeys = []
	for (const [key, value] of Object.entries(fullMaterial)) {
		if (present(key)) {
			keptKeys.push(key)
			continue
		}
		material[key] = value
		filledKeys.push(key)
	}

	/** @type {string[]} */
	const warnings = []
	const asymDerived = ['JWT_JWKS', 'ANON_KEY_ASYMMETRIC', 'SERVICE_ROLE_KEY_ASYMMETRIC']
	if (!present('JWT_KEYS') && asymDerived.some(present)) {
		warnings.push(
			'JWT_KEYS is missing while other asymmetric values exist. A NEW signing key was generated to fill it, so it will NOT match the existing asymmetric tokens/JWKS. Re-run with --rotate to regenerate the whole group coherently.'
		)
	}
	if (!present('JWT_SECRET') && (present('ANON_KEY') || present('SERVICE_ROLE_KEY'))) {
		warnings.push(
			'JWT_SECRET is missing while legacy HS256 keys (ANON_KEY/SERVICE_ROLE_KEY) exist. A NEW JWT_SECRET was generated, so those existing keys will no longer verify. Re-run with --rotate to regenerate them.'
		)
	}
	return { material, filledKeys, keptKeys, warnings }
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

const { jwtSecretOrigin, ecKeyOrigin, material: fullJwtMaterial } = buildJwtMaterial(rotate)
const {
	material: jwtMaterial,
	filledKeys: jwtFilledKeys,
	warnings: jwtWarnings,
} = selectJwtMaterial(fullJwtMaterial, rotate)
const { material: fillMaterial, filledKeys } = buildFillSecrets()
const generated = { ...jwtMaterial, ...fillMaterial }

for (const warning of jwtWarnings) console.warn(`WARNING: ${warning}`)

const jwtMsg = rotate
	? `rotated ${jwtFilledKeys.length} JWT/API variable(s) (JWT_SECRET ${jwtSecretOrigin}, EC key ${ecKeyOrigin})`
	: jwtFilledKeys.length > 0
		? `filled ${jwtFilledKeys.length} missing JWT/API variable(s): ${jwtFilledKeys.join(', ')} (JWT_SECRET ${jwtSecretOrigin}, EC key ${ecKeyOrigin})`
		: 'all JWT/API variables already set (skipped)'
const fillMsg =
	filledKeys.length > 0
		? `filled ${filledKeys.length} infrastructure secret(s): ${filledKeys.join(', ')}`
		: 'all infrastructure secrets already set (skipped)'

if (updateEnv) {
	let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
	for (const [key, value] of Object.entries(generated)) {
		content = replaceOrAppend(content, key, value)
	}
	fs.writeFileSync(ENV_FILE, content)
	const restartNote =
		Object.keys(generated).length > 0
			? ' Restart the stack with: docker compose down && docker compose up -d'
			: ' No values changed.'
	console.log(`Updated ${ENV_FILE}: ${jwtMsg}, ${fillMsg}.${restartNote}`)
} else {
	const lines = Object.entries(generated).map(([key, value]) => `${key}='${value}'`)
	const jwtNote = rotate
		? 'JWT/API material was fully rotated on this run (--rotate).'
		: jwtFilledKeys.length > 0
			? `Generated ${jwtFilledKeys.length} JWT/API variable(s) that were missing or empty. Pass --rotate to regenerate the whole group.`
			: 'All JWT/API variables were already set in .env (not regenerated). Pass --rotate to force rotation.'
	const fillNote =
		filledKeys.length > 0
			? `Generated ${filledKeys.length} infrastructure secret(s) that were missing or empty.`
			: 'All infrastructure secrets were already set in .env (not regenerated).'
	const body =
		lines.length > 0
			? `Copy the values below into your .env file.\n`
			: 'Nothing to copy — all values are already present.\n'
	console.log(`
# ----------------------
${body}
JWT_SECRET was ${jwtSecretOrigin}.
${jwtNote}
${fillNote}
# ----------------------

${lines.join('\n')}
`)
}