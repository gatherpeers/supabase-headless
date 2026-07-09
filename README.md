# Supabase Headless

**Self-hosted Supabase for teams that ship SQL and SDKs — not dashboards.**

Supabase Headless is a small-footprint, production-oriented [Supabase](https://supabase.com/)-compatible API stack. It keeps the data plane your apps already talk to — Auth, PostgREST, Realtime, Storage, Image Transformation, and Edge Functions — and drops the platform chrome: Studio, Analytics, Logflare, Vector, Supavisor, Kong, and Envoy.

Operate it like infrastructure, not like a product UI. Schema lives in checksum-locked SQL migrations. The public edge is a single [Caddy](https://caddyserver.com/) config. Your application can vendor this repo as a Git submodule and mount its own migrations and functions. Official [Supabase client SDKs](https://supabase.com/docs/reference) keep working against the same `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, and `/functions/v1` paths.

This is **not** an official Supabase distribution. It is inspired by the [official Docker layout](https://github.com/supabase/supabase/tree/master/docker) and makes different tradeoffs for single-tenant self-hosting.

## Who This Is For

- Teams that already own schema in SQL (or want to) and do not need Studio as a day-to-day tool.
- Apps that only need the SDK-facing APIs: Auth, REST, Realtime, Storage, Edge Functions.
- Operators who want fewer containers, a smaller attack surface, and deliberate version pins.
- Projects that vendor the stack into an application repo and keep platform wiring separate from app migrations.

If you want a full hosted-platform mirror with Studio, analytics, and a connection pooler out of the box, use the [official self-hosted Docker stack](https://github.com/supabase/supabase/tree/master/docker). If you want the Supabase data plane as lean infrastructure, this repo is built for that.

## Why This Exists

The official self-hosted stack mirrors the hosted platform — valuable when you want that experience, heavy when you do not. This repository takes the opposite position:

- Keep the Supabase-compatible API surface that applications use.
- Remove dashboard and analytics services from the runtime path.
- Replace Kong/Envoy with Caddy for TLS, routing, rate limits, access logs, and modern `sb_*` API-key translation.
- Use direct SQL migrations instead of dashboard-driven schema changes.
- Keep private services on an internal Docker network with **no host exposure** — only `80`/`443` on the gateway.
- Treat upstream Supabase services as modular building blocks that can be upgraded deliberately — the smaller surface makes it practical to land newer Auth / Realtime / Storage / PostgREST / Edge Runtime pins between full upstream compose releases.

The result is a stack that is easier to inspect, typically cheaper to run (fewer containers, no Studio/analytics), faster to reason about when upgrading, and better suited to projects where the application repository owns the schema.

Background: [Self-hosting: What's working (and what's not)?](https://github.com/orgs/supabase/discussions/39820#discussioncomment-16959184)

## What You Get

| Capability | Detail |
| --- | --- |
| **SDK-compatible APIs** | Auth, PostgREST, Realtime, Storage (+ transforms), Edge Functions — same paths the official clients expect |
| **One public edge** | Caddy terminates TLS, rate-limits, translates opaque `sb_publishable_*` / `sb_secret_*` keys, and proxies everything |
| **Hardened by default** | Backends on an internal-only Docker network; OpenAPI root locked to `service_role`; Realtime tenant-admin routes blocked; Functions `/_internal` blocked |
| **SQL as source of truth** | Fresh-volume bootstrap + checksum-tracked stack/app migrations; edits to applied files fail startup on purpose |
| **Current-first pins** | PostgreSQL 18 and recent Auth / Realtime / Storage / Edge Runtime / PostgREST images, bumped deliberately (see [MAINTENANCE.md](./MAINTENANCE.md)) |
| **App-owned overrides** | Vendor as a submodule; mount `db/app/migrations` and `functions/app` from your project |
| **SDK regression suite** | [scripts/supabase-js](./scripts/supabase-js/) hits core Auth, database, Storage, Realtime, and Functions paths against a live stack (not every SDK method — OAuth/SMTP/SSO flows are skipped unless configured) |

## Compared To Official Self-Hosted Docker

| | Official `supabase/docker` | Supabase Headless |
| --- | --- | --- |
| Goal | Platform-like self-host (Studio, pooler, optional logs) | Data-plane IaC for single-tenant apps |
| Gateway | Kong (Envoy / Caddy / nginx overlays) | Caddy replaces the gateway entirely |
| Postgres | `supabase/postgres` (PG 17 default) | Custom PostgreSQL **18** + PostGIS / `wal2json` |
| Storage backend | Local file; S3 / RustFS overlays | S3-compatible RustFS by default |
| Studio / analytics | Included or optional overlays | Intentionally absent |
| Connection pooler | Supavisor included | Explicit per-service pool caps; pooler on the [roadmap](./ROADMAP.md) |
| Host exposure | Gateway ports (and more in some setups) | **Only** gateway `80` / `443` |
| Schema workflow | Studio-friendly + SQL | SQL migrations with checksum immutability |

Headless is not trying to win on Cloud or Studio feature parity. It wins on a smaller runtime, a clearer security boundary, and an upgrade path that is not blocked by dashboard coordination.

## Current-First Stack

The official self-hosted bundle moves carefully because Studio, analytics, gateway layers, and many services must stay coordinated. This repository keeps the runtime smaller, so PostgreSQL and the Supabase service images can be reviewed, bumped, rebuilt, and tested more directly. In practice that has meant newer Auth, Realtime, Storage, PostgREST, and Edge Runtime pins than the last full upstream `versions.md` service bump — but pins are chosen deliberately, not by chasing `latest`.

Versions are still pinned in source and upgraded deliberately, not pulled from floating `latest` tags. See [MAINTENANCE.md](./MAINTENANCE.md) for the upgrade workflow.

Track upstream changes through the official [Supabase self-hosted Docker changelog](https://github.com/supabase/supabase/blob/master/docker/CHANGELOG.md). It is the source of truth for breaking changes, security fixes, and configuration updates that this repository mirrors (adapted to the Caddy gateway and the trimmed service set).

## Compatibility Target

The goal is compatibility with the official Supabase client SDKs for the enabled API services:

- [@supabase/supabase-js](https://supabase.com/docs/reference/javascript/introduction) / [supabase-ssr](https://supabase.com/docs/guides/auth/server-side)
- Auth user and admin APIs
- PostgREST table, RPC, relationship, filter, and RLS behavior
- Realtime channels, broadcast, presence, and Postgres changes
- Storage buckets, object operations, signed URLs, public URLs, and image transforms
- Edge Functions invoked through `/functions/v1/*`

Compatibility does **not** mean feature parity with Supabase Cloud or Studio. This stack deliberately excludes Studio, dashboard-managed schema editing, Supavisor, Logflare, Vector, Analytics, and platform-specific operations. It also uses a lean Postgres image (not the full `supabase/postgres` extension suite), so capabilities such as `pg_graphql` / `pg_cron` / Vault are not assumed unless you add them yourself.

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
- `functions`: [Supabase Edge Runtime](https://github.com/supabase/edge-runtime) with a custom loader image and an `app/` bind mount for routable functions.
- `postgres-meta`: optional [postgres-meta](https://github.com/supabase/postgres-meta) profile service used for TypeScript type generation only.

## Network Model

- `private_net` is `internal: true` and contains the database, REST API, Realtime, Storage, RustFS, imgproxy, and internal gateway reachability.
- `public_net` is limited to services that need outbound internet: `gateway` for ACME, `auth` for SMTP/OAuth, and `functions` for user-code `fetch()`.

Internal services are not published on the host. In production, the firewall should expose only `80`, `443`, and administrative access such as SSH. That is the security story in one sentence: **only the gateway publishes host ports; Auth, REST, Realtime, Storage, Postgres, and the rest stay on the internal Docker network.**

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

The [generate-keys.mjs](generate-keys.mjs) script writes JWT/API keys and fills empty infrastructure secrets such as `POSTGRES_PASSWORD`, role passwords, `SECRET_KEY_BASE`, Realtime encryption keys, and RustFS credentials. Every variable — JWT/API keys and infrastructure secrets alike — is only generated when missing or empty, so re-running is safe and never rotates already-set values (existing keys are preserved). To deliberately rotate the entire JWT/API group (fresh EC signing key, asymmetric JWTs, and `sb_*` keys), pass `--rotate`. Rotating invalidates every distributed client key and every asymmetric-signed session, so only use `node generate-keys.mjs --update-env --rotate` when you intend to rotate credentials. `JWT_SECRET` is kept stable when already set, even during a rotation.

### Start

```bash
docker compose up -d
```

Startup order is intentionally strict: `db` and upstream APIs become healthy, `db-migrate` applies stack then app SQL, and `gateway` starts only after migrations succeed.

## Vendoring In An App

This repository is designed to be vendored into an application repository, for example as a Git submodule. The base stack owns platform wiring; the application owns project SQL and functions.

Typical application-specific overrides:

- Mount app migrations into `db/app/migrations`.
- Mount app Edge Functions into `functions/app` (or replace that mount with your own function tree).
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

Headless ships a lean default Auth surface so local bring-up stays simple. Production deployments should treat the checklist below as part of the product — especially SMTP/OAuth, RLS, and secrets — not as optional polish.

- Review the official [Supabase self-hosted `CONFIG.md`](https://github.com/supabase/supabase/blob/master/docker/CONFIG.md) and each service's upstream env reference, then add/remove/adjust variables in your production `.env` and [compose.yml](./compose.yml) to match the version and features you run. In particular, the Auth (GoTrue) container is configured entirely via `GOTRUE_*` env vars ([auth env readme reference](https://github.com/supabase/auth#configuration) and [auth env reference](https://github.com/supabase/auth/blob/master/example.env)); some options may not be in `CONFIG.md`, so check the auth repo for the version you run.
- Read `.env` in depth before deploying; do not trust generated defaults. Many values must be changed to align with each service (domains, URLs, secrets, SMTP/OAuth, log levels, and service-specific settings).
- Enable RLS on every table in API-exposed schemas. `anon`/`authenticated` hold default `SELECT` grants ([db/init.sql](./db/init.sql)), so a table with RLS forgotten is world-readable. See [db/README.md](./db/README.md).
- Use real SMTP/OAuth settings and turn off auto-confirm flows when email verification matters.
- Set `CADDY_CONTACT_EMAIL` to a real address with a public `PUBLIC_API_DOMAIN`; it becomes the Let's Encrypt registration email (used for expiry/revocation notices). The `admin@localhost` default only suits the local CA.
- Configure `trusted_proxies` in [caddy/Caddyfile](./caddy/Caddyfile) when running behind a CDN or load balancer.
- On Linux, consider Docker `userland-proxy: false` so Caddy can preserve real client IPs on host ports.
- Back up Postgres and RustFS volumes before dependency or schema upgrades.
- Keep `JWT_SECRET`, `JWT_KEYS`, `JWT_JWKS`, and API keys stable unless intentionally rotating credentials. `SUPABASE_SECRET_KEY` is server-only and maps to `service_role`.
- Run `scripts/supabase-js` after gateway, auth, PostgREST, storage, realtime, or SDK upgrades.
- Never edit an applied migration file; checksum mismatches intentionally block startup.
- Review the official [Supabase self-hosted Docker changelog](https://github.com/supabase/supabase/blob/master/docker/CHANGELOG.md) and upstream release notes before bumping service images.

## Useful Commands

```bash
docker compose logs -f --tail=100
docker compose down
docker compose --profile meta up -d postgres-meta
docker compose --profile "*" pull && docker compose build
# Run Node commands in a container
docker run --rm node:24-alpine node -v
```

See [MAINTENANCE.md](./MAINTENANCE.md) for the upgrade workflow and [db/README.md](./db/README.md) for migration rules.