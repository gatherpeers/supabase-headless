# Dependency Maintenance

This project is intentionally biased toward current upstream releases. The stack stays smaller than the official self-hosted bundle, so PostgreSQL and Supabase service images can usually be reviewed and upgraded faster. It still does not blindly track `latest`: version numbers live in source files and every bump should be tested before deployment.

## Pin Locations

- Compose images: [compose.yml](./compose.yml)
- PostgreSQL, PostGIS, and `wal2json`: [db/Dockerfile](./db/Dockerfile)
- Caddy and `caddy-ratelimit`: [caddy/Dockerfile](./caddy/Dockerfile)
- Deno/npm/jsr imports: [functions/](./functions/)
- PostgREST type-generation compatibility: [db/types-gen-ts.sh](./db/types-gen-ts.sh)
- Node image used for key generation examples: [README.md](./README.md) and [generate-keys.mjs](./generate-keys.mjs)

## Tags And Digests

Explicit version tags such as `supabase/auth:v2.192.0` are usually enough for a self-hosted stack when upgrades are tested before deployment.

Use image digests when you need bit-identical pulls across hosts or compliance requires immutable artifacts:

```bash
docker pull supabase/auth:v2.192.0
docker inspect --format='{{index .RepoDigests 0}}' supabase/auth:v2.192.0
```

## Upgrade Workflow

1. List current pins:
  ```bash
   rg 'image:|^FROM |npm:|jsr:|ENV .*VERSION' compose.yml */Dockerfile functions/
  ```
2. Read upstream release notes and breaking-change notes.
3. Cross-check the [official Supabase Docker compose files](https://github.com/supabase/supabase/tree/master/docker) for compatible service sets.
4. Update source files.
5. Add stack migrations for database compatibility changes that existing volumes must receive.
6. Rebuild custom images with `docker compose build db gateway`.
7. Start the stack with `docker compose up -d`.
8. Run the SDK compatibility suite from `scripts/supabase-js`.

Keep each dependency bump focused when possible. Related Supabase services may need to move together when release notes say so.

## Upstream Sources

Check releases for:

- [supabase/auth](https://github.com/supabase/auth/releases)
- [supabase/realtime](https://github.com/supabase/realtime/releases)
- [supabase/storage](https://github.com/supabase/storage/releases)
- [supabase/edge-runtime](https://github.com/supabase/edge-runtime/releases)
- [supabase/postgres-meta](https://github.com/supabase/postgres-meta/releases)
- [PostgREST/postgrest](https://github.com/PostgREST/postgrest/releases)
- [darthsim/imgproxy](https://github.com/imgproxy/imgproxy/releases)
- [rustfs/rustfs](https://github.com/rustfs/rustfs/releases)

For the database image:

```bash
docker run --rm postgres:18.4-trixie bash -c \
  "apt-get update -qq && apt-cache madison postgresql-18 postgresql-18-postgis-3 postgresql-18-wal2json"
```

Update `PG_VERSION`, `POSTGIS_VERSION`, and `WAL2JSON_VERSION` together. Keep `db-migrate` on the same PostgreSQL major/minor tag as the main database image.

For Caddy:

- [Caddy releases](https://github.com/caddyserver/caddy/releases)
- [caddy-ratelimit tags](https://github.com/mholt/caddy-ratelimit/tags)

For Edge Functions, check npm/JSR package releases and remember that Deno itself is bundled in the `supabase/edge-runtime` image:

```bash
docker run --rm --entrypoint sh supabase/edge-runtime:v1.74.2 -c 'deno --version'
```

## Apply Updates

```bash
# Single upstream image
docker compose pull auth
docker compose up -d auth

# Custom images
docker compose build db gateway
docker compose up -d

# Function import changes
docker compose restart functions
```

## Release Checklist

- [ ] Every `image:` in [compose.yml](./compose.yml) has an explicit tag.
- [ ] PGDG packages in [db/Dockerfile](./db/Dockerfile) are version-pinned.
- [ ] Function imports use exact versions, not floating ranges.
- [ ] `POSTGREST_VERSION` in [db/types-gen-ts.sh](./db/types-gen-ts.sh) matches the `rest` image tag.
- [ ] Stack database changes are delivered as numbered migrations.
- [ ] `docker compose config` succeeds.
- [ ] SDK compatibility tests pass, or failures are documented.

## When To Wait

Wait rather than forcing an upgrade when:

- PostGIS or `wal2json` packages are not available yet for the PostgreSQL tag.
- A RustFS beta release has unreviewed storage-format or API changes.
- A Supabase component release changes required environment variables or database migrations.
- Applying the update would require editing already-applied migration files.

