# Database

The database image is [postgres:18.4-trixie](https://hub.docker.com/_/postgres) with pinned PGDG packages for [PostGIS](https://postgis.net/), `wal2json`, and `pg_stat_statements`. See [Dockerfile](./Dockerfile).

The stack intentionally keeps database ownership in SQL. Bootstrap creates the platform roles and schemas; checksum-tracked migrations carry everything that must apply to existing volumes.

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
- Service roles: `supabase_auth_admin`, `supabase_realtime_admin`, `supabase_storage_admin`, and PostgREST's `authenticator`
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

After `db`, `auth`, `rest`, `storage`, and `realtime` are healthy, `db-migrate` runs [migrate.sh](./migrate.sh):

1. Apply `stack/schema.sql`.
2. Apply sorted `stack/migrations/*.sql`.
3. Apply `app/schema.sql`.
4. Apply sorted `app/migrations/*.sql`.
5. Record SHA-256 checksums in `stack_meta.migration_history` or `app_meta.migration_history`.
6. Notify PostgREST to reload its schema cache.

Each migration file runs in a single transaction together with its history row. A checksum mismatch on an already-applied file blocks startup by design.

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

