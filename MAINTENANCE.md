# Dependency maintenance

How to audit, pin, and upgrade third-party versions. **Version numbers live in the repo** (`compose.yml`, Dockerfiles, function imports) — this file describes the process only.

## Where pins live

| Component | File |
| --- | --- |
| Compose images | `compose.yml` |
| Postgres + PostGIS + wal2json | `db/Dockerfile` |
| Caddy + ratelimit plugin | `caddy/Dockerfile` |
| Edge Function imports | `functions/**/*.ts` (`npm:…@x.y.z`) |
| PostgREST version for typegen | `db/types-gen-ts.sh` → `POSTGREST_VERSION` (match `rest` in compose) |
| Node for key generation | `README.md`, `generate-keys.mjs` → `node:24.x-alpine` |

## Tags vs digests

Explicit version tags (e.g. `supabase/auth:v2.192.0`) are sufficient for most self-hosted deployments when you rebuild and smoke-test after bumps.

Image digests (`image: name@sha256:…`) pin exact layer content. Use them when you need bit-identical pulls across hosts or compliance requires immutable references:

```bash
docker pull supabase/auth:v2.192.0
docker inspect --format='{{index .RepoDigests 0}}' supabase/auth:v2.192.0
```

## Audit workflow

1. List current pins:
   ```bash
   rg 'image:|^FROM |npm:|jsr:|ENV .*VERSION' compose.yml */Dockerfile functions/
   ```
2. Check upstream releases (see below).
3. Edit source files.
4. Rebuild custom images: `docker compose build db gateway`
5. Test: `docker compose up -d`, then `cd scripts/supabase-js && npm test` if applicable.
6. Commit one logical bump per change when possible.

## Checking updates

### Compose images

GitHub releases (Supabase, PostgREST, imgproxy, rustfs):

```bash
curl -sL "https://api.github.com/repos/supabase/auth/releases?per_page=3" | grep tag_name
```

Repos: `supabase/auth`, `supabase/realtime`, `supabase/storage`, `supabase/edge-runtime`, `supabase/postgres-meta`, `PostgREST/postgrest`, `darthsim/imgproxy`, `rustfs/rustfs`.

Cross-check against [official Supabase docker compose](https://github.com/supabase/supabase/tree/master/docker) for compatible sets.

### `db/Dockerfile`

```bash
docker run --rm postgres:18.4-trixie bash -c \
  "apt-get update -qq && apt-cache madison postgresql-18 postgresql-18-postgis-3 postgresql-18-wal2json"
```

Update `ENV PG_VERSION`, `POSTGIS_VERSION`, `WAL2JSON_VERSION`. Keep `db-migrate` on the same Postgres major.minor (`postgres:18.4-alpine`).

### `caddy/Dockerfile`

- [Caddy releases](https://github.com/caddyserver/caddy/releases)
- [caddy-ratelimit tags](https://github.com/mholt/caddy-ratelimit/tags) in `xcaddy build --with …`

### Edge Functions

- npm: `curl -sL https://registry.npmjs.org/@supabase/supabase-js/latest`
- JSR: package `meta.json` on [jsr.io](https://jsr.io)

Deno version is bundled in the `edge-runtime` image:

```bash
docker run --rm --entrypoint sh supabase/edge-runtime:v1.74.2 -c 'deno --version'
```

## Applying updates

```bash
# Single service
docker compose pull auth && docker compose up -d auth

# Custom images
docker compose build db gateway && docker compose up -d

# Functions after import bump
docker compose restart functions
```

Bump related Supabase services together when release notes require it (auth, storage, edge-runtime often move as a set).

## Checklist

- [ ] Every `image:` in `compose.yml` has an explicit tag
- [ ] `db/Dockerfile` PGDG packages are version-pinned
- [ ] Function imports use exact versions (`@2.110.0`), not floating ranges
- [ ] `POSTGREST_VERSION` in `types-gen-ts.sh` matches `rest` image tag

## When to wait

- PostGIS upstream release before PGDG packages exist
- `rustfs` beta tags without reading release notes
- Editing already-applied SQL migrations ([db/README.md](./db/README.md))
