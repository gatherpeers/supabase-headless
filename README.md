# Supabase Headless

Self-hosted [Supabase](https://supabase.com/) API stack without Studio, Supavisor, Analytics, or Logflare. Based on the [official Supabase Docker layout](https://github.com/supabase/supabase/tree/master/docker), with these project-specific choices:

- **Caddy** as the only public entry (TLS, routing, rate limits, API-key translation).
- **Plain SQL migrations** via a `db-migrate` sidecar with checksum tracking.
- **Custom Edge Functions loader** (`functions/index.ts`) on `supabase/edge-runtime`.
- **Postgres 18** custom image (PostGIS + wal2json).

## Component docs

| Doc | Scope |
| --- | --- |
| [caddy/README.md](./caddy/README.md) | Gateway build, routes, API keys, CDN |
| [db/README.md](./db/README.md) | Bootstrap, migrations, types, telemetry |
| [functions/README.md](./functions/README.md) | Edge Functions loader and shared helpers |
| [MAINTENANCE.md](./MAINTENANCE.md) | Pinning and upgrading dependencies |
| [ROADMAP.md](./ROADMAP.md) | Planned operational work |

## Services

| Service | Image / build | Role |
| --- | --- | --- |
| `gateway` | Caddy + caddy-ratelimit | Public HTTP(S), API-key translation |
| `db` | PostGIS 18 + wal2json (custom) | PostgreSQL |
| `db-migrate` | `postgres:18-alpine` | One-shot SQL migrations |
| `auth` | `supabase/auth` | GoTrue |
| `rest` | `postgrest/postgrest` | PostgREST |
| `realtime` | `supabase/realtime` | WebSockets / Postgres Changes |
| `storage` | `supabase/storage-api` | Storage API (S3-backed) |
| `rustfs` | `rustfs/rustfs` | S3-compatible object store |
| `rustfs-createbucket` | `rustfs/rc` | Creates the global bucket once |
| `imgproxy` | `darthsim/imgproxy` | Image transforms for Storage |
| `functions` | `supabase/edge-runtime` | Edge Functions |
| `postgres-meta` | `supabase/postgres-meta` | Optional (`--profile dashboard`), type generation only |

Only `gateway` publishes host ports (`80`, `443`).

## Networks

- **`private_net`** (`internal: true`) — database, APIs, object store, imgproxy. No internet egress.
- **`public_net`** — `auth` (SMTP/OAuth), `functions` (outbound `fetch`), `gateway` (ACME).

All API traffic enters through `gateway`. Internal services are not exposed on the host.

## First-time setup

### 1. Create `.env`

```bash
cp .env.example .env
```

Variables wired in `compose.yml` are documented in `.env.example`. Optional GoTrue settings (SMTP, OAuth, mailer templates) are listed in the [upstream Supabase `.env.example`](https://github.com/supabase/supabase/blob/master/docker/.env.example) — add them to `auth.environment` in `compose.yml` when needed.

### 2. Generate secrets

```bash
node generate-keys.mjs --update-env
```

Without Node:

```bash
docker run --rm -v "${PWD}:/work" -w /work node:24.16.0-alpine node generate-keys.mjs --update-env
```

The script writes JWT/API keys and fills any empty infrastructure secrets (`POSTGRES_PASSWORD`, role passwords, `SECRET_KEY_BASE`, RustFS keys, etc.). Re-running rotates JWT/API material except `JWT_SECRET` (kept stable when already set). Infrastructure secrets are only generated when missing or empty.

### 3. Start

```bash
docker compose up -d
```

Startup order: `db` and upstreams become healthy → `db-migrate` runs stack then app SQL → `gateway` starts after migrations succeed.

Add application schema under `db/app/migrations/` (see [db/README.md](./db/README.md)).

## Local HTTPS

With `PUBLIC_API_DOMAIN=localhost`, Caddy uses a local CA. From the repo root:

```bash
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt "$(pwd)/caddy-local-root.crt"
```

Re-export after wiping `caddy_data`.

- **Browsers** — import into the OS trust store (e.g. `certutil -user -addstore -f Root caddy-local-root.crt` on Windows), then restart the browser. `NODE_EXTRA_CA_CERTS` does not affect browsers.
- **Node** — per session: `export NODE_EXTRA_CA_CERTS="$(pwd)/caddy-local-root.crt"`. Override any stale `setx` value if Node warns about a missing cert path.

## Realtime admin UI

`https://<domain>/admin/dashboard` — credentials from `REALTIME_DASHBOARD_USER` and `REALTIME_DASHBOARD_PASSWORD`.

## SDK integration tests

With the stack running, from the repo root:

```bash
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt "$(pwd)/caddy-local-root.crt"
export NODE_EXTRA_CA_CERTS="$(pwd)/caddy-local-root.crt"
cd scripts/supabase-js && npm install && npm test
```

Uses repo-root `.env`.

## Production notes

- Turn off `GOTRUE_MAILER_AUTOCONFIRM` when using real email verification.
- On Linux, set `userland-proxy: false` in `/etc/docker/daemon.json` if Caddy binds host ports 80/443 directly (preserves client IPs).
- Open only 80/443 (and SSH) on the firewall.
- Behind a CDN, configure `trusted_proxies` in the Caddyfile ([caddy/README.md](./caddy/README.md)).
- Never edit an applied migration file — checksums are enforced ([db/README.md](./db/README.md#production-rules)).

## Useful commands

```bash
docker compose logs -f --tail=100
docker compose down
docker compose --profile dashboard up -d postgres-meta   # only when generating types
docker compose --profile "*" pull && docker compose build
```

See [MAINTENANCE.md](./MAINTENANCE.md) for upgrade workflow and [Docker's CLI reference](https://docs.docker.com/reference/cli/docker/) for pruning and diagnostics.
