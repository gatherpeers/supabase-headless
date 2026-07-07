# Roadmap

Operational and architectural items under consideration. Not committed timelines.

## Operations

- CI: build and publish `db` and `gateway` images (GitHub Actions)
- Database backups and restore procedure
- Centralised logging and basic uptime monitoring
- Separate dev/prod compose profiles or env overlays

## Architecture (evaluate)

- Connection pooler (Supavisor, PgBouncer, or Multigres) so app traffic does not exhaust `max_connections`
- Run Postgres and/or S3 outside the compose stack for independent scaling
- Podman as an alternative runtime (non-root low ports, rootless networking)
- `@supabase/server` SDK in Edge Functions (when stable for self-hosted)

## Developer experience

- `postgres-meta` is already isolated behind `--profile dashboard` for type generation; Studio UI is out of scope for this repo
- Optional `/pg/*` route to postgres-meta (commented in Caddyfile) if an admin API is needed