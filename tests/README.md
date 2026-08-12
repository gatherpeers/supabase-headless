# Integration Tests

Live checks against a running headless stack. One package covers both groups:

| Group | Suites | What it covers |
| --- | --- | --- |
| `sdk` | `auth`, `database`, `storage`, `realtime`, `functions` | [@supabase/supabase-js](https://supabase.com/docs/reference/javascript/introduction) method coverage. Provisions ephemeral `sdk_test_*` database objects and buckets, exercises SDK methods, then tears them down. Ends with a per-method coverage report. |
| `smoke` | `auth-keys`, `gateway`, `self-hosted`, `storage`, `s3` | HTTP-level checks modeled on upstream [`docker/tests`](https://github.com/supabase/supabase/tree/master/docker/tests), adapted for headless (no Studio / pg-meta / MCP), plus Caddy-specific behaviour: CORS, security headers, blank-key sentinels, open auth routes, dashboard redirects, TUS, and the public Storage S3 protocol. |

Not every SDK method is asserted. Flows that need OAuth, SMTP, SSO, or similar external setup are skipped unless configured.

## Prerequisites

- Stack up (`docker compose up -d`) with a repo-root `.env`
- Node 22+ and `docker compose` on `PATH`
- When `PUBLIC_API_DOMAIN=localhost`, trust the gateway CA for Node (see [Local HTTPS](../README.md#local-https)):

```bash
# from repo root, after gateway is healthy
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt "$(pwd)/caddy-local-root.crt"

# then, from tests/
export NODE_EXTRA_CA_CERTS="$(pwd)/../caddy-local-root.crt"
```

Re-export the certificate after wiping `caddy_data`.

## Run

```bash
cd tests
npm install
npm test                          # everything
npm run test:sdk                  # or: node . sdk
npm run test:smoke                # or: node . smoke
node . sdk:storage smoke:s3       # individual suites
```

Both groups read the repo-root `.env`. Suites skip themselves rather than fail when their inputs are absent, so a stack without optional legacy HS256 keys still runs the rest.

## Env notes

- **SDK suites** need `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`.
- **`smoke:s3`** needs `S3_PROTOCOL_ACCESS_KEY_ID` / `S3_PROTOCOL_ACCESS_KEY_SECRET` (filled by `node generate-keys.mjs --update-env` from the repo root). Recreate the `storage` service after those vars change.
- **Captcha on** (`GOTRUE_SECURITY_CAPTCHA_ENABLED=true`): sessions use admin `generate_link` + OTP. Set `SDK_TEST_CAPTCHA_TOKEN` to exercise password sign-in directly.