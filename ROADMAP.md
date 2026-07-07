# Roadmap

This roadmap tracks production-hardening work and architecture ideas. It is not a committed release schedule.

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

- Connection pooling with PgBouncer, Supavisor, or another lightweight pooler when app traffic risks exhausting `max_connections`.
- External Postgres and/or S3-compatible storage for deployments that need independent scaling, managed backups, or cloud-native durability.
- Rootless Podman as an alternative runtime for hosts that prefer daemonless containers and stronger process isolation.
- `@supabase/server` in Edge Functions when its self-hosted story is stable enough.

## Non-Goals

- Supabase Studio as a default service.
- Dashboard-driven schema editing.
- Analytics, Logflare, Vector, or hosted-platform observability parity.
- A general multi-tenant platform distribution.

[postgres-meta](https://github.com/supabase/postgres-meta) remains available under the `meta` compose profile for TypeScript type generation. The commented `/pg/*` route in [caddy/Caddyfile](./caddy/Caddyfile) can be enabled intentionally if a deployment needs a protected Postgres Meta API.