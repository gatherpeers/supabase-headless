# Dependency Maintenance

**Audience:** maintainers of this repository (and forkers who change image or import pins). If you vendor the stack and only bump submodule tags, see [VENDORING.md](./VENDORING.md).

Current-first is a product feature of this stack, not an accident of packaging. Because Headless omits Studio, analytics, and the Kong/Envoy coordination surface, PostgreSQL and the Supabase service images can usually be reviewed and upgraded faster than the full official self-hosted bundle. That makes it practical to adopt newer Auth, Realtime, Storage, PostgREST, and Edge Runtime releases between upstream compose bumps — when you choose to.

It still does not blindly track `latest`: version numbers live in source files and every bump should be tested before deployment.

## Pin Locations

- Compose images: [compose.yml](./compose.yml) (including the prebuilt `db` image tag)
- PostgreSQL, PostGIS, and `wal2json`: [db/Dockerfile](./db/Dockerfile)
- Caddy and `caddy-ratelimit`: [caddy/Dockerfile](./caddy/Dockerfile)
- Deno/npm/jsr imports: [functions/](./functions/) (especially `index.ts` and `_shared/supabase.ts`)
- Test dependencies: [tests/package.json](./tests/package.json) — keep `@supabase/supabase-js` aligned with the functions pin
- PostgREST type-generation compatibility: [db/types-gen-ts.sh](./db/types-gen-ts.sh)
- Node image used for key generation examples: [generate-keys.mjs](./generate-keys.mjs) (and the looser `node:24-alpine` example in [README.md](./README.md))
- GitHub Actions: [`.github/workflows/db-image.yml`](./.github/workflows/db-image.yml)

## Tags And Digests

Explicit version tags such as `supabase/auth:<tag>` are usually enough for a self-hosted stack when upgrades are tested before deployment.

The prebuilt `db` image is the engine only. Pin `ghcr.io/gatherpeers/supabase-headless/db:vX.Y.Z` in [compose.yml](./compose.yml) to the **last git tag that published an image** (when `db/Dockerfile` or the publish workflow changed). Do not bump it on unrelated stack tags, and do not use `latest`.

Use image digests when you need bit-identical pulls across hosts or compliance requires immutable artifacts:

```bash
docker pull supabase/auth:<tag>
docker inspect --format='{{index .RepoDigests 0}}' supabase/auth:<tag>
```

For images that only publish Docker Hub tags (notably `rustfs/rc`), confirm the pinned tag still matches `latest` by comparing digests before bumping:

```bash
curl -sL "https://hub.docker.com/v2/repositories/rustfs/rc/tags/latest" | sed -n 's/.*"digest": *"\([^"]*\)".*/\1/p' | head -1
curl -sL "https://hub.docker.com/v2/repositories/rustfs/rc/tags/<tag>" | sed -n 's/.*"digest": *"\([^"]*\)".*/\1/p' | head -1
```

## Upgrade Workflow

1. List current pins:
  ```bash
   rg 'image:|^FROM |npm:|jsr:|ENV .*VERSION|caddy-ratelimit@|POSTGREST_VERSION|node:[0-9]|uses:' \
     compose.yml */Dockerfile functions/ db/types-gen-ts.sh \
     tests/package.json generate-keys.mjs .github/workflows
  ```
2. Check each pin against upstream (see [Version Check Recipes](#version-check-recipes)).
3. Read upstream release notes and breaking-change notes.
4. Cross-check the [official Supabase Docker versions](https://github.com/supabase/supabase/blob/master/docker/versions.md) for compatible service sets. Headless often runs ahead of that bundle — treat it as a compatibility hint, not a ceiling.
5. Update source files (and `npm install` under `tests` when the SDK pin changes).
6. Add stack migrations for database compatibility changes that existing volumes must receive.
7. Rebuild custom images (`docker compose build gateway`, and `functions` when the loader or imports changed). `db` is pulled from GHCR on `up`; `docker compose build db` only if you changed [db/Dockerfile](./db/Dockerfile) locally.
8. Start the stack with `docker compose up -d`.
9. Run the integration suites from `tests` (`npm test`).

Keep each dependency bump focused when possible. Related Supabase services may need to move together when release notes say so.

## Upstream Sources

Check releases for:

- [supabase/auth](https://github.com/supabase/auth/releases) (image: `supabase/auth`; same tags as gotrue)
- [supabase/realtime](https://github.com/supabase/realtime/releases)
- [supabase/storage](https://github.com/supabase/storage/releases) (image: `supabase/storage-api`)
- [supabase/edge-runtime](https://github.com/supabase/edge-runtime/releases)
- [supabase/postgres-meta](https://github.com/supabase/postgres-meta/releases)
- [PostgREST/postgrest](https://github.com/PostgREST/postgrest/releases)
- [darthsim/imgproxy](https://github.com/imgproxy/imgproxy/releases)
- [rustfs/rustfs](https://github.com/rustfs/rustfs/releases) (include prereleases; `latest` on GitHub may lag beta tags)
- [rustfs/rc Docker tags](https://hub.docker.com/r/rustfs/rc/tags)

For the database image, check both the base tag and PGDG packages:

- [Postgres Docker tags](https://hub.docker.com/_/postgres/tags) (`18.x-trixie` / `18.x-alpine`)
- PGDG package versions (must match the base image’s major):

```bash
docker run --rm postgres:<tag> bash -c \
  "apt-get update -qq && apt-cache madison postgresql-18 postgresql-18-postgis-3 postgresql-18-wal2json"
```

Use the same `postgres:<tag>` as [db/Dockerfile](./db/Dockerfile) (`*-trixie`). Update `PG_VERSION`, `POSTGIS_VERSION`, and `WAL2JSON_VERSION` together. `db-migrate` uses the same GHCR engine image as `db` (psql only; it never starts a server). A `vX.Y.Z` git tag publishes `ghcr.io/gatherpeers/supabase-headless/db:vX.Y.Z` only if the engine or [`.github/workflows/db-image.yml`](./.github/workflows/db-image.yml) changed since the previous tag. After the first push, set the GHCR package visibility to **Public**.

For Caddy:

- [Caddy releases](https://github.com/caddyserver/caddy/releases)
- [caddy-ratelimit tags](https://github.com/mholt/caddy-ratelimit/tags)

For Edge Functions and the SDK suite, check npm/JSR directly (Deno itself is bundled in `supabase/edge-runtime`):

- `@supabase/supabase-js` — bump in both `functions/_shared/supabase.ts` and `tests/package.json`
- `@opentelemetry/api`, `@opentelemetry/core` — `functions/index.ts`
- `@std/http` — `functions/index.ts` (JSR)

```bash
docker run --rm --entrypoint sh supabase/edge-runtime:<tag> -c 'deno --version'
```

For the key-generation example image, use the current Node 24.x Alpine tag from [Docker Hub](https://hub.docker.com/_/node/tags) or [nodejs.org dist index](https://nodejs.org/dist/index.json).

## Version Check Recipes

Use these when you want a fast current-vs-latest pass without opening every release page:

```bash
# GitHub: newest tag (works when /releases/latest is empty or prerelease-only)
curl -sL -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/supabase/auth/tags?per_page=5" \
  | sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' | head -5

# Prefer /releases?per_page=5 for RustFS — include betas; /releases/latest may point at an older tag
curl -sL -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/rustfs/rustfs/releases?per_page=5" \
  | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -5

# npm
npm view @supabase/supabase-js version
npm view @opentelemetry/api version
npm view @opentelemetry/core version

# JSR
curl -sL "https://jsr.io/@std/http/meta.json" | sed -n 's/.*"latest": *"\([^"]*\)".*/\1/p'

# Docker Hub recent tags (Postgres / Node / rustfs/rc)
curl -sL "https://hub.docker.com/v2/repositories/library/postgres/tags?page_size=40&name=18" \
  | tr ',' '\n' | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | grep -E '^18\.[0-9]+(-alpine|-trixie)?$' | sort -V | uniq | tail -20
```

Official self-hosted versions for comparison:

```bash
curl -sL "https://raw.githubusercontent.com/supabase/supabase/master/docker/versions.md" | head -40
```

## Apply Updates

```bash
# Single upstream image
docker compose pull auth
docker compose up -d auth

# Custom images
docker compose build gateway
docker compose up -d

# Function import changes
docker compose build functions
docker compose up -d functions
```

## Release Checklist

- Every `image:` in [compose.yml](./compose.yml) has an explicit tag.
- If `db/Dockerfile` (or the db image workflow) changed, set `db.image` in [compose.yml](./compose.yml) to `ghcr.io/gatherpeers/supabase-headless/db:vX.Y.Z` for the tag you are about to cut. If it did not change, leave the existing pin.
- PGDG packages in [db/Dockerfile](./db/Dockerfile) are version-pinned.
- Function imports use exact versions, not floating ranges.
- `@supabase/supabase-js` matches across [functions/_shared/supabase.ts](./functions/_shared/supabase.ts) and [tests/package.json](./tests/package.json).
- `POSTGREST_VERSION` in [db/types-gen-ts.sh](./db/types-gen-ts.sh) matches the `rest` image tag.
- Stack database changes are delivered as numbered migrations.
- `docker compose config` succeeds.
- Integration tests in [tests](./tests) pass (`npm test` runs both the SDK and smoke suites).

Then review changes since the last tag and publish an annotated tag for consumers ([VENDORING.md](./VENDORING.md)):

```bash
git log $(git describe --tags --abbrev=0)^..HEAD --oneline
git tag -a vX.Y.Z -m "Short description of the release"
git push origin main
git push origin vX.Y.Z
```

If this release publishes a new db image, wait for **Release db image** to finish before expecting that new tag to pull.
