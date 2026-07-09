# Database

PostgreSQL is the source of truth for this stack — not a dashboard. The database image is [postgres:18.4-trixie](https://hub.docker.com/_/postgres) with pinned PGDG packages for [PostGIS](https://postgis.net/), `wal2json`, and `pg_stat_statements`. See [Dockerfile](./Dockerfile).

Unlike the official self-hosted bundle's `supabase/postgres` image, this is a lean Postgres 18 build sized for the Headless data plane: the roles, schemas, and extensions Auth / PostgREST / Realtime / Storage need, without shipping the full Cloud extension suite (`pg_graphql`, `pg_cron`, Vault, and similar are not assumed). That keeps the image inspectable and upgradeable on a current major, at the cost of not mirroring every hosted Postgres feature out of the box.

Schema ownership stays in SQL. Bootstrap creates the platform roles and schemas; checksum-tracked migrations carry everything that must apply to existing volumes. Edit an applied migration and startup fails — by design.

## Layout

```text
db/
├── init.sql           # Fresh-volume bootstrap only
├── migrate.sh         # db-migrate sidecar entrypoint
├── types-gen-ts.sh    # TypeScript types via postgres-meta
├── stack/
│   ├── schema.sql     # stack_meta.migration_history
│   └── migrations/    # Platform compatibility SQL
└── app/
    ├── schema.sql     # app_meta.migration_history
    └── migrations/    # Application SQL
```

Files prefixed with `-` are treated as drafts and skipped by [migrate.sh](./migrate.sh).

## Bootstrap

[init.sql](./init.sql) runs once on a fresh `db_data` volume through `docker-entrypoint-initdb.d`.

It creates:

- Schemas: `auth`, `extensions`, `_realtime`, `realtime`, `storage`
- API roles: `anon`, `authenticated`, `service_role`
- Service roles: `supabase_auth_admin`, `supabase_storage_admin`, and PostgREST's `authenticator`
- Ownership-only: `supabase_realtime_admin`, `dashboard_user` (stub for Realtime migrations)
- Extensions: `pg_stat_statements`, `postgis`, `pgcrypto`
- Publication: `supabase_realtime`
- Default privileges for API roles on `public` and `storage`

Do not put upgrade logic in `init.sql`. Existing deployments will not receive it. Use `stack/migrations/` for platform compatibility changes and `app/migrations/` for application schema.

## Roles And RLS

PostgREST connects as `authenticator` and switches role per request based on the verified JWT `role` claim.

- `anon`: unauthenticated or publishable-key requests.
- `authenticated`: logged-in users.
- `service_role`: server-side/admin requests; bypasses RLS.

Default grants allow common operations to be attempted, but row access still depends on RLS policies. Application migrations should enable RLS and define policies explicitly for user-owned data.

## Auth Helper Functions

Supabase applications commonly use these helpers in RLS policies:

- `auth.uid()`
- `auth.jwt()`
- `auth.role()`
- `auth.email()`

They are provided by the Supabase Auth/GoTrue database migrations during normal service startup. They read verified JWT claims exposed by PostgREST and are safe to call from RLS policies, returning `NULL` when the request has no matching claim.

Example policy:

```sql
CREATE POLICY profiles_owner ON public.profiles
  FOR ALL TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
```

## Migrations

Migrations are the product surface for schema change. There is no Studio schema editor in this stack — your Git history is the change log.

After `db`, `auth`, `rest`, `storage`, and `realtime` are healthy, `db-migrate` runs [migrate.sh](./migrate.sh):

1. Apply `stack/schema.sql`.
2. Apply sorted `stack/migrations/*.sql`.
3. Apply `app/schema.sql`.
4. Apply sorted `app/migrations/*.sql`.
5. Record SHA-256 checksums in `stack_meta.migration_history` or `app_meta.migration_history`.
6. Notify PostgREST to reload its schema cache.

Each migration file runs in a single transaction together with its history row. A checksum mismatch on an already-applied file blocks startup by design. Stack migrations stay reviewable when you bump the submodule; app migrations stay owned by the application repo.

### Migration Layers

- `init.sql`: fresh-volume bootstrap only, not checksum-tracked.
- `stack/schema.sql` and `app/schema.sql`: idempotent history table setup.
- `stack/migrations/`: platform compatibility SQL owned by this stack.
- `app/migrations/`: application schema, buckets, policies, functions, and seed-safe reference data.

For vendored usage, mount project migrations into `db/app/migrations` and leave `db/stack/migrations` for upstream stack updates.

### Authoring Rules

- Use numeric prefixes for deterministic order, for example `001_create_profiles.sql`.
- Prefer idempotent DDL where practical (`IF NOT EXISTS`, named constraints, guarded `DO` blocks).
- Do not edit applied migration files; add a new migration.
- Do not use non-transactional statements such as `CREATE INDEX CONCURRENTLY`, `VACUUM`, or explicit `BEGIN`/`COMMIT`.
- Grant privileges explicitly for objects created by application roles or restored from dumps; `ALTER DEFAULT PRIVILEGES` only affects future objects created by the role it targets.
- Create Storage buckets in app migrations when they are part of the application contract.
- Reload PostgREST after manual DDL.

## Manual SQL

Run SQL against the database:

```bash
docker compose exec -T db psql -U postgres -d postgres -c "SELECT version();"
```

Reload PostgREST after manual DDL:

```bash
docker compose exec db sh -lc 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "NOTIFY pgrst, '\''reload schema'\'';"'
```

## TypeScript Types

```bash
./db/types-gen-ts.sh
./db/types-gen-ts.sh public,storage,auth ./database.types.ts
```

The script starts [postgres-meta](https://github.com/supabase/postgres-meta) under the `meta` profile, calls `/generators/typescript`, writes the output file, and stops the service. `db-migrate` must have completed successfully first.

Keep `POSTGREST_VERSION` in [types-gen-ts.sh](./types-gen-ts.sh) aligned with the `rest` image tag in [compose.yml](../compose.yml).

## Connection Budget

Postgres runs with `max_connections=100` (`POSTGRES_MAX_CONNECTIONS`) and no external pooler. After the 3 connections reserved for superusers (`superuser_reserved_connections`), about **97** are usable. Each database-backed service keeps its own connection pool, so the sum of those pools must stay comfortably under that limit.

Every pool is bounded by an environment variable with a conservative default:

| Service    | Env var                 | Default | Notes                                                    |
| ---------- | ----------------------- | ------- | -------------------------------------------------------- |
| `rest`     | `PGRST_DB_POOL`         | 20      | PostgREST, connects as `authenticator`.                  |
| `auth`     | `AUTH_DB_POOL_SIZE`     | 10      | GoTrue. Upstream default is `0` (unlimited) — capped here. |
| `storage`  | `STORAGE_DB_POOL_SIZE`  | 15      | storage-api. Upstream default is `20`.                   |
| `realtime` | `REALTIME_DB_POOL_SIZE` | 5       | RLS authorization pool; add ~1 for broadcast replication. |

Steady-state usage is therefore roughly **51** connections. The remaining headroom absorbs transient and optional users that are not part of the pools above:

- `db-migrate`: short-lived `psql` at startup (postgres user), then exits.
- `postgres-meta`: only runs under the `meta` compose profile.
- `functions`: reaches the database through the gateway/PostgREST, so it holds no direct pool.
- Manual `psql`, monitoring, and admin sessions.

If you raise any pool size, raise `POSTGRES_MAX_CONNECTIONS` to match (and give the `db` container more memory), or introduce a connection pooler such as PgBouncer or Supavisor (see [ROADMAP.md](../ROADMAP.md)).

## Memory And Resource Tuning

Defaults target a **4 CPU / 4G** `db` container — enough headroom for PostGIS workloads while staying reasonable on a single host. All values are set in [compose.yml](../compose.yml) and overridable via `.env` (see [.env.example](../.env.example)).

### Container limits

| Env var            | Default | Purpose                                                          |
| ------------------ | ------- | ---------------------------------------------------------------- |
| `DB_CPU_LIMIT`     | `4.0`   | Docker CPU cap for the `db` service.                             |
| `DB_MEMORY_LIMIT`  | `4G`    | Docker memory cap for the `db` service.                          |
| `DB_SHM_SIZE`      | `2GB`   | Container `/dev/shm`; should be ≥ `POSTGRES_SHARED_BUFFERS`.     |

Changing CPU or memory limits requires recreating the container (`docker compose up -d --force-recreate db`). Postgres GUC changes take effect on the next DB restart.

### PostgreSQL settings

| Env var                             | Default | Purpose                                                                 |
| ----------------------------------- | ------- | ----------------------------------------------------------------------- |
| `POSTGRES_SHARED_BUFFERS`           | `1GB`   | Dedicated buffer cache (~25% of the 4G limit).                          |
| `POSTGRES_EFFECTIVE_CACHE_SIZE`     | `3GB`   | Planner hint for total cache (~75% of the limit); not an allocation.    |
| `POSTGRES_MAINTENANCE_WORK_MEM`     | `512MB` | Memory for `VACUUM`, `CREATE INDEX`, and similar maintenance.           |
| `POSTGRES_WORK_MEM`                 | `32MB`  | Per-sort/hash operation memory; multiplied across concurrent operations. |

`POSTGRES_WORK_MEM` applies **per operation per connection**, not once globally. With the default connection budget (~51 pooled connections), a burst of concurrent sorts could theoretically request more than the container limit. The `32MB` default trades some safety margin for better PostGIS query performance; lower it (for example to `16MB`) if you see memory pressure under heavy parallel load.

### Scaling down or up

For a smaller host, lower `DB_CPU_LIMIT` and `DB_MEMORY_LIMIT` together and scale the Postgres settings in proportion:

- `POSTGRES_SHARED_BUFFERS` → ~25% of `DB_MEMORY_LIMIT` (for example `256MB` on a 2G container).
- `POSTGRES_EFFECTIVE_CACHE_SIZE` → ~75% of `DB_MEMORY_LIMIT`.
- `POSTGRES_MAINTENANCE_WORK_MEM` → `128MB`–`256MB` on 2G; raise on larger containers.
- `POSTGRES_WORK_MEM` → `6MB`–`16MB` on memory-constrained hosts.
- `DB_SHM_SIZE` → at least `POSTGRES_SHARED_BUFFERS`, with headroom for parallel workers.

If you raise any service pool size or `POSTGRES_MAX_CONNECTIONS`, revisit `POSTGRES_WORK_MEM` against the new connection budget.

## Telemetry

Slow query logging is controlled by `POSTGRES_LOG_MIN_DURATION_STATEMENT` and defaults to `200` ms. Query statistics are available through `extensions.pg_stat_statements`.

```sql
SELECT query, calls, total_exec_time, mean_exec_time
FROM extensions.pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 5;
```

## Production Rules

- Back up `db_data` before dependency upgrades or destructive schema changes.
- Keep migration files immutable after they have been applied anywhere important.
- Review checksum failures as deployment blockers, not warnings.
- Keep app schema changes in app migrations so the base stack can be updated independently.

