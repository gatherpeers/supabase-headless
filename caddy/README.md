# Gateway (Caddy)

Public entry point for the stack. Handles TLS, reverse proxying, sliding-window rate limits, and translation of client API keys (`sb_*` opaque keys and legacy HS256 JWTs) into internal asymmetric JWTs for upstream services.

Path prefixes are configurable via `.env` (`AUTH_PREFIX`, `REST_PREFIX`, etc.). Defaults match the table below.

## Build

Custom image: [Caddy 2](https://caddyserver.com/) with the [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit) plugin ([Dockerfile](./Dockerfile)).

## API key handling

Protected routes run this chain (snippet names mirror the upstream Supabase Envoy config for cross-reference):

1. Copy `?apikey=` to the `Apikey` header (WebSocket clients).
2. Map recognised keys to internal JWT + role (`anon` / `service_role`).
3. Reject unknown keys with `401`.
4. Replace `Apikey` with the internal asymmetric JWT.
5. Synthesise `Authorization: Bearer …` when the client did not send a valid bearer token.

Storage and Functions skip key translation — they use their own auth (SigV4, function-level checks). Authorization is only synthesised when the header is empty or starts with `Bearer sb_`, so AWS SigV4 on Storage is not overwritten.

### Accepted keys

| Client sends | Env variable | Upstream receives |
| --- | --- | --- |
| `sb_publishable_*` | `SUPABASE_PUBLISHABLE_KEY` | `ANON_KEY_ASYMMETRIC` |
| `sb_secret_*` | `SUPABASE_SECRET_KEY` | `SERVICE_ROLE_KEY_ASYMMETRIC` |
| ES256 JWT (`anon`) | `ANON_KEY_ASYMMETRIC` | passthrough |
| ES256 JWT (`service_role`) | `SERVICE_ROLE_KEY_ASYMMETRIC` | passthrough |
| HS256 JWT (legacy) | `ANON_KEY` / `SERVICE_ROLE_KEY` | passthrough |

## Routes (default prefixes)

| Path | Upstream | API key |
| --- | --- | --- |
| `/auth/v1/verify`, `/callback`, `/authorize`, `/.well-known/jwks.json` | `auth:9999` | open |
| `/.well-known/oauth-authorization-server` | `auth:9999` | open |
| `/sso/saml/*` | `auth:9999` | open |
| `/auth/v1/*` | `auth:9999` | required |
| `/rest/v1/*` | `rest:3000` | required |
| `/graphql/v1/*` | `rest:3000` → `/rpc/graphql` | required |
| `/realtime/v1/api/tenants`, `/realtime/v1/api/openapi` | — | **403** |
| `/realtime/v1/api/*` | `realtime:4000` | required |
| `/realtime/v1/*` (WebSocket) | `realtime:4000` → `/socket/*` | required |
| `/storage/v1/*` | `storage:5000` | bypass |
| `/functions/v1/*` | `functions:9000` | bypass |
| `/admin/*` | `realtime:4000` | Realtime basic auth |

`/realtime/v1/admin/*` redirects to `/admin/*`. Tenant management endpoints (`/realtime/v1/api/tenants`, `/api/openapi`) are blocked at the gateway ([supabase/supabase#46856](https://github.com/supabase/supabase/pull/46856)).

Commented optional routes in [Caddyfile](./Caddyfile): `/pg/*` (postgres-meta), `/api/mcp`, Studio. None are enabled in `compose.yml`.

## Auth email templates (optional)

The Caddyfile can serve HTML mailer templates on `:8081` at `/mailer/*` (`root /srv/auth-mailer`). This is **not wired by default** — there is no `auth/mailer/` tree or volume mount in `compose.yml`.

To use custom GoTrue templates:

1. Add templates under a host path (e.g. `./auth/mailer/templates/`).
2. Mount them in `gateway.volumes` (e.g. `./auth/mailer/templates:/srv/auth-mailer:ro`).
3. Set `GOTRUE_MAILER_TEMPLATES_*` and `GOTRUE_MAILER_EXTERNAL_HOSTS` on the `auth` service (see [upstream Supabase docker env](https://github.com/supabase/supabase/blob/master/docker/.env.example)).

Port `8081` is not published to the host; only `private_net` clients (GoTrue) can reach it.

## Validate / format

```bash
docker compose run --rm --entrypoint sh gateway -c "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
docker compose run --rm --entrypoint sh gateway -c "caddy fmt --overwrite /etc/caddy/Caddyfile"
```

## CDN / reverse proxy

If a CDN sits in front of Caddy, uncomment `servers { trusted_proxies … }` in the Caddyfile so `{client_ip}` and rate limits use the real client address.

On Linux with Caddy on host ports 80/443, set `userland-proxy: false` in `/etc/docker/daemon.json`.

## Rate limiting

Sliding window on `{client_ip}`:

- `GATEWAY_RATE_LIMIT_EVENTS` (default `100`)
- `GATEWAY_RATE_LIMIT_WINDOW` (default `1s`)

Returns `429` when exceeded.

## Logging

Access log: `./logs/caddy/access.log` (bind-mounted from `/var/log/caddy/` in the container).
