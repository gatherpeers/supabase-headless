# Edge Functions

Functions run on [supabase/edge-runtime](https://github.com/supabase/edge-runtime) and are exposed by Caddy at `/functions/v1/*`.

This repository uses a small custom loader instead of one compose service per function. The loader in [index.ts](./index.ts) is baked into the functions image, discovers directories under [app/](./app/), validates the requested function name, and dispatches requests to Edge Runtime workers.

## Request Flow

```text
Caddy -> functions:9000 -> loader (image) -> per-function worker (app mount)
```

`index.ts` parses the first URL segment as the function name, accepts only `[a-zA-Z0-9_-]+`, excludes `_shared` and dot-directories, and serves directories that contain `index.ts` or `index.js`.

Workers are reused with `forceCreate: false`. If a worker has already retired, the loader retries with a fresh worker.

## Layout

```text
functions/
├── Dockerfile         # Bakes loader + stack _shared into the image
├── index.ts           # Main loader (image)
├── deno.json          # @stack and @shared import aliases for workers
├── _shared/           # Stack helpers (image), not routable
│   ├── json.ts
│   ├── requireEnv.ts
│   └── supabase.ts
└── app/               # Bind-mounted routable functions
    ├── _shared/       # Optional app-only helpers (not routable)
    ├── example1/
    │   └── index.ts
    └── example2/
        └── index.ts
```

Only [app/](./app/) is mounted into the container. The loader and stack `_shared` helpers ship in the image so vendored apps can mount their own function tree without copying platform code.

Any directory with an entrypoint under `app/` is served at `/functions/v1/<name>/`.

Examples:

- `/functions/v1/example1/foo` routes to `example1`.
- `/functions/v1/_shared` returns `404`.
- `/functions/v1/missing` returns `404`.

## Vendoring

Mount application functions into `functions/` from a compose override:

```yaml
services:
  functions:
    volumes: !override
      - ./functions:/home/deno/functions:ro
```

The vendor tree only needs function folders and an optional `_shared/` directory:

```text
my-app/supabase/functions/
├── checkout-webhook/
│   └── index.ts
└── _shared/
    └── billing.ts
```

Rebuild the functions image when upgrading the stack submodule to pick up loader or `@stack` helper updates:

```bash
docker compose build functions
docker compose up -d functions
```

## Import Aliases

Workers resolve shared code through [deno.json](./deno.json):

- `@stack/`: stack helpers baked into the image
- `@shared/`: optional helpers from `_shared/` on the mount (e.g. `functions/_shared/` in your app repo)

```ts
import { json } from '@stack/json.ts'
import { billCustomer } from '@shared/billing.ts' // Just an example
```

Do not mount over stack `_shared`. Extend behavior through `@shared/` or local files inside the function directory.

## Worker Limits

- Memory: `150 MB`
- Wall timeout: `5 min`
- CPU soft limit: `10 s`
- CPU hard limit: `20 s`
- Module cache: enabled

These limits live in [index.ts](./index.ts).

## Internal Endpoints

- `GET /_internal/health`: Docker healthcheck.
- `GET /_internal/metric`: Edge Runtime metrics.

These endpoints are for container-internal use. Caddy blocks `/functions/v1/_internal*` so they are not exposed through the public API domain.

## Writing A Function

Create `functions/app/<name>/index.ts` and call `Deno.serve(...)`.

```ts
import { json } from '@stack/json.ts'

Deno.serve(() => json({ ok: true }))
```

The app directory is mounted read-only into the container. During development, a changed file may still be cached by a live worker; restart `functions` when you need a clean reload.

## Authorization Patterns

Functions are gateway-auth bypass routes. Caddy forwards requests to Edge Runtime without enforcing `apikey`, so **each function must decide whether it is public, caller-scoped, or admin-only.**

Caller-scoped RLS client:

```ts
import { json } from '@stack/json.ts'
import { createRlsClient } from '@stack/supabase.ts'

Deno.serve(async (req) => {
  let supabase
  try {
    supabase = createRlsClient(req)
  } catch {
    return json({ msg: 'Unauthorized' }, 401)
  }

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json({ msg: 'Unauthorized' }, 401)

  return json({ user })
})
```

Service-role client:

```ts
import { createAdminClient } from '@stack/supabase.ts'

Deno.serve(async () => {
  // Add application-specific authorization before bypassing RLS.
  const supabase = createAdminClient()
  // ...
})
```

Never use the service-role client for a public handler without an authorization check.

## Shared Helpers

- `createRlsClient(req)`: internal gateway URL plus caller `Authorization`; RLS is enforced by PostgREST.
- `createAdminClient()`: internal gateway URL plus service role; bypasses RLS.
- `createPublicUrlClient()`: public URL only, useful for `storage.getPublicUrl()`.
- `requireEnv(name)`: fail fast on missing environment variables.
- `json(body, statusOrInit)`: JSON response helper.

`SUPABASE_URL` is `http://gateway`, so function-to-Supabase calls stay inside Docker networking. `storage.getPublicUrl()` is computed client-side by `supabase-js`; use `createPublicUrlClient()` when a function needs to return browser-facing Storage URLs.

## Environment

[compose.yml](../compose.yml) defines these Supabase variables for the Functions container:

- `SUPABASE_URL`: internal gateway URL, currently `http://gateway`.
- `SUPABASE_PUBLIC_URL`: browser-facing API URL.
- `SUPABASE_ANON_KEY`: internal asymmetric anon JWT.
- `SUPABASE_SERVICE_ROLE_KEY`: internal asymmetric service-role JWT.

The loader forwards the container environment to every worker. Add application-specific secrets only when every function in that container is allowed to see them, or split sensitive functions into a separate deployment.

## Dependencies

Deno imports are pinned in source, for example `npm:@supabase/supabase-js@2.110.0` in [_shared/supabase.ts](./_shared/supabase.ts). Follow [MAINTENANCE.md](../MAINTENANCE.md) when bumping versions.

## Tests

The SDK compatibility runner invokes [example1](./app/example1/index.ts) and [example2](./app/example2/index.ts) from [scripts/supabase-js](../scripts/supabase-js/).
