# Supabase Headless

Supabase Headless is a small-footprint, self-hosted [Supabase](https://supabase.com/)-compatible API stack for teams that want the Supabase data plane without Studio, Analytics, Logflare, Vector, Supavisor, Kong, or Envoy.

It keeps the core services that official [Supabase SDKs](https://supabase.com/docs/reference) talk to: Auth, PostgREST, Realtime, Storage, Image Transformation, and Edge Functions. The stack is intentionally operated as infrastructure-as-code: schema changes are plain SQL migrations, the gateway is a single [Caddy](https://caddyserver.com/) configuration, and application projects can vendor this repository as a Git submodule and mount their own migration/function overrides.

This is not an official Supabase distribution. It is a production-oriented custom compose stack based on the ideas in the [official Supabase Docker layout](https://github.com/supabase/supabase/tree/master/docker), while making different operational tradeoffs for single-tenant self-hosting.

## Why This Exists

The official self-hosted stack is designed to mirror the hosted platform and include a broad admin/dashboard experience. That is valuable, but it also brings services and configuration surface that some deployments do not need.

This repository takes the opposite position:

- Keep the Supabase-compatible API surface that applications use.
- Remove dashboard and analytics services from the runtime path.
- Replace Kong/Envoy with Caddy for TLS, routing, rate limits, access logs, and API-key translation.
- Use direct SQL migrations instead of dashboard-driven schema changes.
- Keep private services on an internal Docker network with no host exposure.
- Treat upstream Supabase services as modular building blocks that can be upgraded deliberately.

The result is a smaller stack that is easier to inspect, cheaper to run, faster to update, and better suited to projects where database design lives in SQL and application repositories own their migrations.

Read a little bit more about why I built this here: [Self-hosting: What's working (and what's not)?](https://github.com/orgs/supabase/discussions/39820#discussioncomment-16959184)

## Current-First Stack

One of the goals is to keep the self-hosted stack close to current upstream releases. The official self-hosted bundle has a large surface area and can move slowly because many services, dashboard features, gateway layers, and analytics components must stay coordinated. This repository keeps the runtime smaller, so PostgreSQL and the Supabase service images can be reviewed, bumped, rebuilt, and tested more directly.

The stack currently targets PostgreSQL 18 and recent Supabase service releases across Auth, Realtime, Storage, Edge Runtime, and Postgres Meta. Versions are still pinned in source and upgraded deliberately, not pulled from floating `latest` tags. See [MAINTENANCE.md](./MAINTENANCE.md) for the upgrade workflow.

## Compatibility Target

The goal is compatibility with the official Supabase client SDKs for the enabled API services:

- [@supabase/supabase-js](https://supabase.com/docs/reference/javascript/introduction) / [supabase-ssr](https://supabase.com/docs/guides/auth/server-side)
- Auth user and admin APIs
- PostgREST table, RPC, relationship, filter, and RLS behavior
- Realtime channels, broadcast, presence, and Postgres changes
- Storage buckets, object operations, signed URLs, public URLs, and image transforms
- Edge Functions invoked through `/functions/v1/*`

Compatibility does not mean feature parity with Supabase Cloud or Studio. This stack deliberately excludes Studio, dashboard-managed schema editing, Supavisor, Logflare, Vector, Analytics, and platform-specific operations.

SDK coverage lives in `scripts/supabase-js` and should be run after dependency upgrades or gateway/auth changes.

---

## Architecture

Only `gateway` publishes host ports (`80`, `443`). Every public API request enters through Caddy.

- `gateway`: [Caddy 2](https://caddyserver.com/) with [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit); TLS, routing, CORS, rate limits, logs, API-key translation.
- `db`: custom PostgreSQL 18 image with PostGIS, `wal2json`, and `pg_stat_statements`.
- `db-migrate`: one-shot migration sidecar that applies stack SQL and app SQL with checksum tracking.
- `auth`: [Supabase Auth / GoTrue](https://github.com/supabase/auth).
- `rest`: [PostgREST](https://postgrest.org/).
- `realtime`: Supabase Realtime.
- `storage`: Supabase Storage API backed by S3-compatible RustFS.
- `rustfs`: S3-compatible object storage.
- `imgproxy`: image transformation backend for Storage.
- `functions`: [Supabase Edge Runtime](https://github.com/supabase/edge-runtime) with a small custom function loader.
- `postgres-meta`: optional [postgres-meta](https://github.com/supabase/postgres-meta) profile service used for TypeScript type generation only.

## Network Model

- `private_net` is `internal: true` and contains the database, REST API, Realtime, Storage, RustFS, imgproxy, and internal gateway reachability.
- `public_net` is limited to services that need outbound internet: `gateway` for ACME, `auth` for SMTP/OAuth, and `functions` for user-code `fetch()`.

Internal services are not published on the host. In production, the firewall should expose only `80`, `443`, and administrative access such as SSH.

## Repository Docs

- [caddy/README.md](./caddy/README.md): gateway behavior, routes, API-key translation, CORS, CDN notes.
- [db/README.md](./db/README.md): bootstrap SQL, stack/app migrations, auth helpers, type generation, production migration rules.
- [functions/README.md](./functions/README.md): Edge Runtime loader, function layout, shared Supabase clients.
- [MAINTENANCE.md](./MAINTENANCE.md): dependency pinning and upgrade workflow.
- [ROADMAP.md](./ROADMAP.md): planned operational work and non-goals.

---

## First-Time Setup

### Environment

Create `.env` from [.env.example](.env.example). See [CONFIG.md](https://github.com/supabase/supabase/blob/master/docker/CONFIG.md) for the official environment variables list.

```bash
cp .env.example .env
```

### Secrets

```bash
node generate-keys.mjs --update-env
```

Without Node on the host:

```bash
docker run --rm -v "${PWD}:/work" -w /work node:24.16.0-alpine node generate-keys.mjs --update-env
```

The script writes JWT/API keys and fills empty infrastructure secrets such as `POSTGRES_PASSWORD`, role passwords, `SECRET_KEY_BASE`, Realtime encryption keys, and RustFS credentials. Re-running rotates JWT/API material except `JWT_SECRET`, which is kept stable when already set. Infrastructure secrets are only generated when missing or empty.

### Start

```bash
docker compose up -d
```

Startup order is intentionally strict: `db` and upstream APIs become healthy, `db-migrate` applies stack then app SQL, and `gateway` starts only after migrations succeed.

## Vendoring In An App

This repository is designed to be vendored into an application repository, for example as a Git submodule. The base stack owns platform wiring; the application owns project SQL and functions.

Typical application-specific overrides:

- Mount app migrations into `db/app/migrations`.
- Mount app Edge Functions into `functions/`.
- Override domains, SMTP/OAuth settings, CORS, resource limits, and storage policy through `.env` or compose overrides.
- Keep stack migrations separate from app migrations so upstream compatibility fixes remain reviewable.

Application schema belongs in numbered SQL files such as `db/app/migrations/001_create_profiles.sql`. Do not edit an applied migration file; add a new migration instead.

## Local HTTPS

With `PUBLIC_API_DOMAIN=localhost`, Caddy uses a local CA. Export the root certificate from the repo root:

```bash
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt "$(pwd)/caddy-local-root.crt"
```

Re-export the certificate after wiping `caddy_data`.

### Browsers

Import `caddy-local-root.crt` into the OS trust store, then restart the browser. `NODE_EXTRA_CA_CERTS` does not affect browsers.

On Windows:

```bash
certutil -user -addstore -f Root caddy-local-root.crt
```

### Node (current session)

Bash, Git Bash, WSL, macOS, or Linux:

```bash
export NODE_EXTRA_CA_CERTS="$(pwd)/caddy-local-root.crt"
```

PowerShell (current session only):

```powershell
$env:NODE_EXTRA_CA_CERTS = "$PWD\caddy-local-root.crt"
```

### Node (persistent on Windows)

`setx` does not expand `$(pwd)`. Replace the path with your repo location:

```bat
setx NODE_EXTRA_CA_CERTS "D:\path\to\supabase-headless\caddy-local-root.crt"
```

Open a new terminal after `setx`. Remove or update the variable if you move the repo or wipe `caddy_data` and re-export the cert.

## Realtime Admin UI

Realtime exposes its own dashboard at:

```text
https://<domain>/admin/dashboard
```

Credentials come from `REALTIME_DASHBOARD_USER` and `REALTIME_DASHBOARD_PASSWORD`. This is not Supabase Studio.

For internet-facing deployments, use a strong generated password and prefer an additional control such as VPN, IP allowlisting, or a private admin hostname. The route is convenient for operations but should be treated as an admin surface.

## SDK Integration Tests

With the stack running. When `PUBLIC_API_DOMAIN=localhost`, complete [Local HTTPS](#local-https) first.

```bash
cd scripts/supabase-js
npm install
npm test
```

The runner uses the repo-root `.env`, creates temporary `sdk_test_*` database objects and buckets, exercises SDK methods, then tears them down.

---

## Production Checklist

- Use real SMTP/OAuth settings and turn off auto-confirm flows when email verification matters.
- Configure `trusted_proxies` in [caddy/Caddyfile](./caddy/Caddyfile) when running behind a CDN or load balancer.
- On Linux, consider Docker `userland-proxy: false` so Caddy can preserve real client IPs on host ports.
- Back up Postgres and RustFS volumes before dependency or schema upgrades.
- Keep `JWT_SECRET`, `JWT_KEYS`, `JWT_JWKS`, and API keys stable unless intentionally rotating credentials. `SUPABASE_SECRET_KEY` is server-only and maps to `service_role`.
- Run `scripts/supabase-js` after gateway, auth, PostgREST, storage, realtime, or SDK upgrades.
- Never edit an applied migration file; checksum mismatches intentionally block startup.
- Review upstream Supabase release notes before bumping service images.

## Useful Commands

```bash
docker compose logs -f --tail=100
docker compose down
docker compose --profile meta up -d postgres-meta
docker compose --profile "*" pull && docker compose build
```

See [MAINTENANCE.md](./MAINTENANCE.md) for the upgrade workflow and [db/README.md](./db/README.md) for migration rules.