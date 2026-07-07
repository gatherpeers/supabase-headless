# Gateway (Caddy)

`gateway` is the only public entry point for the stack. It replaces the upstream Kong/Envoy gateway with a single Caddy configuration that handles TLS, route matching, prefix rewrites, CORS, sliding-window rate limits, access logs, and Supabase API-key translation.

Path prefixes are configurable in `.env` (`AUTH_PREFIX`, `REST_PREFIX`, `REALTIME_PREFIX`, `STORAGE_PREFIX`, `FUNCTIONS_PREFIX`). Defaults match the conventional Supabase paths.

## Build

The custom image uses [Caddy 2](https://caddyserver.com/) plus [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit). See [Dockerfile](./Dockerfile).

## API Key Translation

[Supabase](https://supabase.com/docs/guides/getting-started/api-keys)'s newer `sb_publishable_*` and `sb_secret_*` keys are opaque strings. The gateway matches them literally and substitutes internal JWTs before proxying to services that expect JWT-shaped `apikey` and `Authorization` values. `sb_publishable_*` is safe for browser/mobile clients; `sb_secret_*` is server-only because it maps to `service_role`.

Protected routes run this chain:

1. Copy `?apikey=` to the `Apikey` header for clients that cannot set custom WebSocket headers.
2. Map recognized keys to an internal JWT and role (`anon` or `service_role`).
3. Reject missing or unknown keys with `401`.
4. Replace `Apikey` with the internal JWT.
5. Synthesize `Authorization: Bearer <jwt>` when the client did not send a real bearer token.

Accepted keys:

- `SUPABASE_PUBLISHABLE_KEY` -> `ANON_KEY_ASYMMETRIC`
- `SUPABASE_SECRET_KEY` -> `SERVICE_ROLE_KEY_ASYMMETRIC`
- `ANON_KEY_ASYMMETRIC` and `SERVICE_ROLE_KEY_ASYMMETRIC` pass through for internal callers.
- Legacy HS256 `ANON_KEY` and `SERVICE_ROLE_KEY` pass through for migration compatibility.

Storage and Functions intentionally do not require a gateway API-key check. Storage must accept signed URLs and AWS SigV4 requests; Functions perform their own handler-level authorization. When Storage does include a recognized key, Caddy translates it but does not overwrite AWS SigV4 `Authorization` headers.

## Default Routes

- `/auth/v1/verify`, `/auth/v1/callback`, `/auth/v1/authorize`, and `/auth/v1/.well-known/jwks.json` -> `auth:9999`, open.
- `/.well-known/oauth-authorization-server` -> `auth:9999`, open.
- `/sso/saml/*` -> `auth:9999`, open.
- `/auth/v1/*` -> `auth:9999`, API key required.
- `/rest/v1/*` -> `rest:3000`, API key required.
- `/graphql/v1/*` -> `rest:3000/rpc/graphql`, API key required; requires the `graphql` schema to exist.
- `/realtime/v1/api/tenants*` and `/realtime/v1/api/openapi*` -> blocked with `403`.
- `/realtime/v1/api/*` -> `realtime:4000/api/*`, API key required.
- `/realtime/v1/*` -> `realtime:4000/socket/*`, API key required.
- `/storage/v1/*` -> `storage:5000`, gateway auth bypass.
- `/functions/v1/_internal`, `/functions/v1/_internal/*` -> blocked with `404`.
- `/functions/v1/*` -> `functions:9000`, gateway auth bypass.
- `/admin/*` -> `realtime:4000`, protected by Realtime dashboard auth.

`/realtime/v1/admin/*` redirects to `/admin/*`. Realtime tenant-management endpoints are blocked at the gateway to match the upstream hardening in [supabase/supabase#46856](https://github.com/supabase/supabase/pull/46856).

Treat `/admin/*` as an administrative surface. Keep `REALTIME_DASHBOARD_PASSWORD` strong and add network-level protection for production deployments when possible.

Commented optional routes in [Caddyfile](./Caddyfile) include `/pg/*` for `postgres-meta`, `/api/mcp`, and a Studio catch-all. They are documented for parity but are not enabled by [compose.yml](../compose.yml).

## CORS

CORS is controlled by `CORS_ALLOWED_ORIGIN`. The default in `.env.example` points to `APP_URL`.

Use a concrete origin in production. A wildcard origin is convenient for local experiments but is usually the wrong default for authenticated browser apps.

## Auth Email Templates

[Caddyfile](./Caddyfile) can serve GoTrue mailer templates internally on `:8081` under `/mailer/*`. This is not wired by default; [compose.yml](../compose.yml) does not mount an `auth/mailer` directory.

To enable custom templates:

1. Add templates under a host path such as `./auth/mailer/templates/`.
2. Mount that path into `gateway` as `/srv/auth-mailer:ro`.
3. Configure the relevant `GOTRUE_MAILER_TEMPLATES_*` and `GOTRUE_MAILER_EXTERNAL_HOSTS` variables on `auth` (see the upstream [Supabase Docker env example](https://github.com/supabase/supabase/blob/master/docker/.env.example)).

Port `8081` is not published to the host. Only services that can reach the internal Docker network should call it.

## CDN / Reverse Proxy

When Caddy is behind Cloudflare, Fastly, an ALB, or another Layer 7 proxy, configure `trusted_proxies` in the global `servers` block. This makes `{client_ip}`, rate limits, `X-Real-IP`, Auth forwarded-for handling, and access logs use the real visitor IP instead of the Docker peer.

On Linux with Caddy binding host ports `80` and `443`, consider setting Docker `userland-proxy: false` to preserve client IPs more reliably.

## Rate Limiting

The gateway uses a sliding window keyed by `{client_ip}`:

- `GATEWAY_RATE_LIMIT_EVENTS`, default `100`
- `GATEWAY_RATE_LIMIT_WINDOW`, default `1s`

Exceeded requests return `429`.

## Logging

Access logs are written to `./logs/caddy/access.log` through the `/var/log/caddy` bind mount. Log rotation is configured in [Caddyfile](./Caddyfile).

## Validate / Format

```bash
docker compose run --rm --entrypoint sh gateway -c "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
docker compose run --rm --entrypoint sh gateway -c "caddy fmt /etc/caddy/Caddyfile"
```

The compose mount is read-only, so `caddy fmt` prints the formatted Caddyfile to stdout. Format the host file intentionally before committing changes.
