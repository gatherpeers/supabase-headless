# Roadmap

This roadmap tracks production-hardening work and architecture ideas. It is not a committed release schedule.

The product focus stays fixed: a lean, SDK-compatible Supabase data plane that operators can vendor, pin, and upgrade. Items below deepen that story — they do not expand into a hosted-platform clone.

## Production Readiness

- Document a backup and restore procedure for `db_data`, `rustfs_data`, and `caddy_data`.
- Add a CI workflow that validates compose config, builds `db` and `gateway`, and runs syntax checks.
- Publish prebuilt `db` and `gateway` images for deployments that should not build on the target host.
- Add a minimal monitoring guide for healthchecks, Caddy access logs, Postgres slow queries, and disk usage.
- Provide separate example overlays for local development and production deployment.

## Compatibility

- Keep [scripts/supabase-js](./scripts/supabase-js/) coverage aligned with the current [@supabase/supabase-js](https://supabase.com/docs/reference/javascript/introduction) surface.
- Add focused tests for Caddy API-key translation, Realtime blocked endpoints, Storage signed URLs, and Functions auth forwarding.
- Track upstream Supabase breaking changes that affect self-hosted environment variables, database migrations, or gateway behavior.
- Expand stack migrations when new Supabase-compatible SQL helpers or grants are required.

## Architecture To Evaluate

- Connection pooling with PgBouncer, Supavisor, or another lightweight pooler. Each service now has an explicit pool cap that fits the documented `max_connections` budget (see [db/README.md](./db/README.md#connection-budget)); a pooler is the next step once traffic risks exhausting that budget.
- External Postgres and/or S3-compatible storage for deployments that need independent scaling, managed backups, or cloud-native durability.
- Rootless Podman as an alternative runtime for hosts that prefer daemonless containers and stronger process isolation.
- `@supabase/server` in Edge Functions when its self-hosted story is stable enough.

## Non-Goals (On Purpose)

These are not missing features waiting to land — they are the boundary that keeps the stack small and upgradeable:

- Supabase Studio as a default service.
- Dashboard-driven schema editing.
- Analytics, Logflare, Vector, or hosted-platform observability parity.
- A general multi-tenant platform distribution.
- Shipping the full `supabase/postgres` extension suite by default (add what you need; do not inherit Cloud parity by accident).

[postgres-meta](https://github.com/supabase/postgres-meta) remains available under the `meta` compose profile for TypeScript type generation. The commented `/pg/*` route in [caddy/Caddyfile](./caddy/Caddyfile) can be enabled intentionally if a deployment needs a protected Postgres Meta API.