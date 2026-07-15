# Gateway (Caddy)

`gateway` is the only public entry point for the stack — and the only process that publishes host ports. It replaces Kong/Envoy with a single, reviewable [Caddy](https://caddyserver.com/) configuration: automatic TLS and HTTP/3, route matching, prefix rewrites, CORS, sliding-window rate limits, access logs, security headers, and modern Supabase `sb_*` API-key translation.

Where the official self-hosted stack keeps Kong (or Envoy) as the API gateway and optionally puts Caddy in front for TLS, Headless makes Caddy the gateway. One config file, one public edge, backends stay on an internal Docker network.

> Official Supabase gateway configs (Kong and Envoy) live in [supabase/supabase `docker/volumes/api`](https://github.com/supabase/supabase/tree/master/docker/volumes/api). Upstream also ships a [Caddy overlay](https://github.com/supabase/supabase/blob/master/docker/docker-compose.caddy.yml) that terminates TLS in front of Kong — a different role from this service.

Path prefixes are configurable in `.env` (`AUTH_PREFIX`, `REST_PREFIX`, `REALTIME_PREFIX`, `STORAGE_PREFIX`, `FUNCTIONS_PREFIX`). Defaults match the conventional Supabase paths so official SDKs need no special routing.

## Why Caddy Here

- **Smaller surface** — no Kong declarative config, no Envoy Lua filters to keep in sync with Studio.
- **Production TLS by default** — local CA for `localhost`, Let's Encrypt when `PUBLIC_API_DOMAIN` is public.
- **First-class opaque keys** — `sb_publishable_*` / `sb_secret_*` translated to internal ES256 JWTs before Auth, REST, and Realtime see the request.
- **Hardening that matches (and sometimes leads) upstream** — OpenAPI root restricted to `service_role`, Realtime tenant-admin routes blocked, Functions `/_internal` never exposed.
- **Operator-friendly** — rate limits, HSTS / frame / nosniff headers, and access logs in one place.

## Build

The custom image uses [Caddy 2](https://caddyserver.com/) plus [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit). See [Dockerfile](./Dockerfile).

## API Key Translation

[Supabase](https://supabase.com/docs/guides/getting-started/api-keys)'s newer `sb_publishable_*` and `sb_secret_*` keys are opaque strings. The gateway matches them literally and substitutes internal JWTs before proxying to services that expect JWT-shaped `apikey` and `Authorization` values. Clients keep the short opaque keys; backends keep verifying JWTs. `sb_publishable_*` is safe for browser/mobile clients; `sb_secret_*` is server-only because it maps to `service_role`.

Protected routes run this chain:

1. Copy `?apikey=` to the `Apikey` header for clients that cannot set custom WebSocket headers.
2. Map recognized keys to an internal JWT and role (`anon` or `service_role`).
3. Reject missing or unknown keys with `401`.
4. Replace `Apikey` with the internal JWT.
5. Synthesize `Authorization: Bearer <jwt>` when the client did not send a real bearer token.

Accepted keys:

- `SUPABASE_PUBLISHABLE_KEY` -> `ANON_KEY_ASYMMETRIC`
- `SUPABASE_SECRET_KEY` -> `SERVICE_ROLE_KEY_ASYMMETRIC`
- Legacy HS256 `ANON_KEY` and `SERVICE_ROLE_KEY` pass through for migration compatibility.

Internal asymmetric JWTs are translation targets, not accepted client API keys. Blank key variables are represented internally by distinct map sentinels, but Caddy rejects those values before lookup. This preserves upstream-compatible legacy-only operation without making a predictable placeholder usable as an API key. Locally generated opaque keys use Supabase's `supabase-self-hosted|<key>` checksum input; the gateway still treats the complete key as an opaque literal, like upstream.

Storage and Functions intentionally do not require a gateway API-key check. Storage must accept signed URLs and AWS SigV4 requests; Functions perform their own handler-level authorization. When Storage does include a recognized key, Caddy translates it but does not overwrite AWS SigV4 `Authorization` headers.

## Default Routes

- `/auth/v1/verify`, `/auth/v1/callback`, `/auth/v1/authorize`, and `/auth/v1/.well-known/jwks.json` -> `auth:9999`, open.
- `/.well-known/oauth-authorization-server` -> `auth:9999`, open.
- `/auth/v1/sso/saml/acs`, `/auth/v1/sso/saml/metadata` -> `auth:9999`, open.
- `/auth/v1/*` -> `auth:9999`, API key required.
- `/rest/v1`, `/rest/v1/` (OpenAPI spec root) -> `rest:3000`, `service_role` only (anon/publishable get `403`); mirrors [supabase/supabase#45462](https://github.com/supabase/supabase/pull/45462).
- `/rest/v1/*` -> `rest:3000`, API key required.
- `/graphql/v1/*` -> `rest:3000/rpc/graphql` with `Content-Profile: graphql_public`, API key required; needs `pg_graphql` and a `graphql_public` schema (not shipped by default).
- `/realtime/v1/api/tenants*` and `/realtime/v1/api/openapi*` -> blocked with `403`.
- `/realtime/v1/api/*` -> `realtime:4000/api/*`, API key required.
- `/realtime/v1/*` -> `realtime:4000/socket/*`, API key required.
- `/storage/v1/*` -> `storage:5000`, gateway auth bypass.
- `/functions/v1/_internal`, `/functions/v1/_internal/*` -> blocked with `404`.
- `/functions/v1/*` -> `functions:9000`, gateway auth bypass.
- `/admin/*` -> `realtime:4000`, protected by Realtime dashboard auth.

`/admin` and `/admin/` redirect to `/admin/dashboard/`. `/realtime/v1/admin/*` redirects to `/admin/*`. Realtime tenant-management endpoints are blocked at the gateway to match the upstream hardening in [supabase/supabase#46856](https://github.com/supabase/supabase/pull/46856).

Realtime seeding and proxied API/WebSocket requests share the stable `REALTIME_TENANT_ID` value. Caddy rewrites the upstream `Host` header to this identifier so Realtime resolves the same tenant regardless of the public API domain.

Treat `/admin/*` as an administrative surface. Keep `REALTIME_DASHBOARD_PASSWORD` strong and add network-level protection for production deployments when possible.

Commented optional routes in [Caddyfile](./Caddyfile) include `/pg/*` for `postgres-meta`, `/api/mcp`, and a Studio catch-all. They are documented for parity but are not enabled by [compose.yml](../compose.yml).

## CORS

CORS is controlled by `CORS_ALLOWED_ORIGIN`, emitted verbatim as `Access-Control-Allow-Origin` on every response.

The default is **unquoted** `*`, matching upstream Supabase (Envoy/Kong and the hosted platform). This is safe here because the auth boundary is the `apikey`/JWT (and RLS), not the request origin, and the gateway sends no `Access-Control-Allow-Credentials`, so no cookies are involved. A wildcard origin without credentials only lets browser JS *attempt* a call — it still needs a valid key and token to succeed. See the comment above `Access-Control-Allow-Origin` in [Caddyfile](./Caddyfile): if you ever enable credentialed CORS on the gateway or use `credentials: 'include'` from the browser, replace `*` with a single origin.

Options:

- **`*`** (default): any browser origin may call the API with bearer tokens. Matches upstream.
- **A single concrete origin** (e.g. `${APP_URL}`): a mild hardening that also blocks other browser origins at the CORS layer. No `Vary: Origin` is needed because the emitted origin is static.

Preflight responses echo `Access-Control-Request-Headers`, matching Kong's forward-compatible behavior, and expose all response headers as in Envoy. Because credentialed CORS is disabled, the wildcard exposed-header value retains its wildcard meaning.

## Internal Gateway URL

Public clients use HTTPS on ports `443/tcp` (HTTP/1.1 and HTTP/2) or `443/udp` (HTTP/3). Edge Functions use `http://gateway:8080` on Docker networking to avoid a TLS round trip without opening a plaintext path on the published public listener. Port `8080` is not published to the host.

## Auth Email Templates

[Caddyfile](./Caddyfile) can serve GoTrue mailer templates internally on `:8081` under `/mailer/*`. This is not wired by default; [compose.yml](../compose.yml) does not mount an `auth/mailer` directory.

To enable custom templates:

1. Add templates under a host path such as `./auth/mailer/templates/`.
2. Mount that path into `gateway` as `/srv/auth-mailer:ro`.
3. Configure the relevant `GOTRUE_MAILER_TEMPLATES_*` and `GOTRUE_MAILER_EXTERNAL_HOSTS` variables on `auth` (see the upstream [Supabase Docker env example](https://github.com/supabase/supabase/blob/master/docker/.env.example)).

Port `8081` is not published to the host. Only services that can reach the internal Docker network should call it.

## CDN / Reverse Proxy

When Caddy is behind Cloudflare, Fastly, an ALB, or another Layer 7 proxy, configure only that proxy's actual CIDRs in the global `servers` block and enable `trusted_proxies_strict` for proxies that append `X-Forwarded-For`. Do not broadly trust all private ranges when direct traffic can reach a Docker/NAT peer. Correct trust configuration makes `{client_ip}`, rate limits, `X-Real-IP`, Auth forwarded-for handling, and access logs use the real visitor IP instead of the Docker peer.

On Linux with Caddy binding host ports `80` and `443`, consider setting Docker `userland-proxy: false` to preserve client IPs more reliably.

## Rate Limiting

One public-edge limiter covers every external request, including open and protected APIs, preflights, blocked paths, the Realtime dashboard, and fallback responses. Internal requests through `gateway:8080` are exempt. Public limiting uses a sliding window keyed by `{client_ip}`:

- `GATEWAY_RATE_LIMIT_EVENTS`, default `100`
- `GATEWAY_RATE_LIMIT_WINDOW`, default `1s`

Exceeded requests return `429`.

## Logging

Access logs are written to `./logs/caddy/access.log` through the `/var/log/caddy` bind mount. Log rotation is configured in [Caddyfile](./Caddyfile). Caddy records the generated request `uuid`, returns it through `REQUEST_ID_HEADER`, and forwards the same value upstream. API-key/signature headers and sensitive query parameters are removed or redacted before encoding the log entry; Caddy also redacts `Authorization` and cookies by default.

## Validate / Format

```bash
docker compose run --rm --entrypoint sh gateway -c "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
docker compose run --rm --entrypoint sh gateway -c "caddy fmt /etc/caddy/Caddyfile"
```

The compose mount is read-only, so `caddy fmt` prints the formatted Caddyfile to stdout. Format the host file intentionally before committing changes.
