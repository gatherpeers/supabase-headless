# Database

Custom image: `postgres:18.4-trixie` + pinned PGDG packages for PostGIS and wal2json ([Dockerfile](./Dockerfile)).

## Layout

```
db/
├── init.sql           # Fresh-volume bootstrap (roles, schemas, extensions)
├── migrate.sh         # Sidecar entrypoint
├── types-gen-ts.sh    # TypeScript types via postgres-meta
├── stack/
│   ├── schema.sql     # stack_meta.migration_history
│   └── migrations/    # Platform SQL (create as needed)
└── app/
    ├── schema.sql     # app_meta.migration_history
    └── migrations/    # Application SQL (create as needed)
```

Draft files prefixed with `-` are skipped by `migrate.sh`. Missing `migrations/` directories are ignored.

## Bootstrap (`init.sql`)

Runs once on a new volume via `docker-entrypoint-initdb.d`:

- Schemas: `auth`, `extensions`, `_realtime`, `realtime`, `storage`
- API roles: `anon`, `authenticated`, `service_role` (`BYPASSRLS`)
- Service roles: `supabase_auth_admin`, `supabase_realtime_admin`, `supabase_storage_admin`, `authenticator` (PostgREST)
- Extensions: `pg_stat_statements`, `postgis`, `pgcrypto`
- Publication `supabase_realtime` for logical replication / wal2json
- Default table privileges on `public` and `storage` for API roles

Changes that must apply to **existing** databases belong in `stack/migrations/`, not `init.sql`.

### Roles

PostgREST connects as `authenticator` and `SET ROLE` to one role per request (from the JWT `role` claim, or `anon` when unauthenticated).

| Role | Typical use | Default table access (public/storage) |
| --- | --- | --- |
| `anon` | No session | `SELECT` |
| `authenticated` | Logged-in user | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `service_role` | Server-side | `ALL` (bypasses RLS) |

Grants allow an operation to be attempted; **row access** is enforced with RLS policies you define in `app/migrations/`. The `auth` schema is for GoTrue only (`service_role` has `USAGE`).

## Migrations (`db-migrate`)

After `db`, `auth`, `rest`, `storage`, and `realtime` are healthy, `db-migrate` runs [migrate.sh](./migrate.sh):

1. Apply `stack/schema.sql`, then sorted `stack/migrations/*.sql`
2. Apply `app/schema.sql`, then sorted `app/migrations/*.sql`
3. Record SHA-256 checksums in `stack_meta.migration_history` / `app_meta.migration_history`
4. `NOTIFY pgrst, 'reload schema'`

A checksum mismatch on an already-applied file blocks startup. Each migration runs in a single transaction with its history row.

Add files as `db/app/migrations/001_<name>.sql` — no `compose.yml` change required. Use numeric prefixes for ordering.

### Layers

| Layer | Location | Checksum-tracked |
| --- | --- | --- |
| Postgres bootstrap | `init.sql` | No |
| History tables | `stack/schema.sql`, `app/schema.sql` | No |
| Schema changes | `stack/migrations/`, `app/migrations/` | Yes |

`schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`, etc.). For changes to meta tables on existing databases, prefer a numbered migration over editing `schema.sql`.

### Authoring rules

- Prefer idempotent DDL where practical (`IF NOT EXISTS`, named constraints).
- Do not use non-transactional statements (`CREATE INDEX CONCURRENTLY`, `VACUUM`, explicit `BEGIN`/`COMMIT`).
- Storage buckets can be created in app migrations (`storage.buckets`).

### Run SQL manually

```bash
docker compose exec -T db psql -U postgres -d postgres -c "SELECT version();"
```

Reload PostgREST after DDL:

```bash
docker compose exec db sh -lc 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "NOTIFY pgrst, '\''reload schema'\'';"'
```

## TypeScript types

```bash
./db/types-gen-ts.sh
./db/types-gen-ts.sh public,storage,auth ./database.types.ts
```

Starts `postgres-meta` under the `dashboard` profile, calls `/generators/typescript`, then stops the container. Requires `db-migrate` to have completed successfully.

Keep `POSTGREST_VERSION` in `types-gen-ts.sh` aligned with the `rest` image tag in `compose.yml`.

## Telemetry

- `POSTGRES_LOG_MIN_DURATION_STATEMENT` (default `200` ms) — slow-query logging
- `pg_stat_statements` enabled via `shared_preload_libraries`

```sql
SELECT query, calls, total_exec_time, mean_exec_time
FROM extensions.pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 5;
```

## Production rules

- **Do not edit applied migration files.** Add a new numbered file instead.
- Keep migrations idempotent where possible for safer recovery.
