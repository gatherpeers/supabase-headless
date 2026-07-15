# Edge Functions

Ship Deno handlers the same way you would on Supabase — `/functions/v1/<name>` — without a per-function compose service or Studio deploy step.

Functions run on [supabase/edge-runtime](https://github.com/supabase/edge-runtime) behind Caddy. A small custom loader ([index.ts](./index.ts)) is baked into the image: it discovers directories under the bind-mounted [app/](./app/) tree, validates the function name, and dispatches to Edge Runtime workers. Stack helpers (`@stack/`) live in the image; your app mounts only the routable function tree — ideal when this repo is vendored as a submodule.

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
├── deno.json          # Loader/worker @stack alias (image)
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

The vendor tree needs function folders and an optional `_shared/` directory:

```text
my-app/functions/
├── checkout-webhook/
│   │── index.ts
├───└── util.ts
└── _shared/
    └── billing.ts
```

Rebuild the functions image when upgrading the stack submodule to pick up loader or `@stack` helper updates:

```bash
docker compose build functions --no-cache
docker compose up -d --force-recreate --no-deps functions
```

## Import Aliases

Workers read [deno.json](./deno.json) baked in the image for `@stack/` only.

- `@stack/`: stack helpers in the image (`./_shared/` relative to the loader)
- App helpers in `_shared/`: use relative imports from each function, e.g. `../_shared/billing.ts`

Edge Runtime workers run inside each function directory. Import-map aliases to paths outside that directory (including absolute `/home/deno/functions/_shared/`) are not loaded reliably. Relative `../_shared/` imports from sibling folders on the mount work.

```ts
import { json } from '@stack/json.ts'
import { billCustomer } from '../_shared/billing.ts'
```

Do not mount over stack `_shared`. Extend behavior through `functions/_shared/` on the mount or local files inside the function directory.

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

Create `functions/app/<name>/index.ts` and export a default object with a `fetch` handler (the module worker contract used by Supabase Edge Functions, Cloudflare Workers, and Bun):

```ts
import { json } from '@stack/json.ts'

export default {
  fetch: () => json({ ok: true }),
}
```

Do not use `Deno.serve` in app functions. The loader in [index.ts](./index.ts) still uses `Deno.serve` as the container entrypoint; that is separate from per-function handlers.

The app directory is mounted read-only into the container. During development, a changed file may still be cached by a live worker; restart `functions` when you need a clean reload.

## Authorization Patterns

Functions are gateway-auth bypass routes. Caddy forwards requests to Edge Runtime without enforcing `apikey`, so **each function must decide whether it is public, caller-scoped, or admin-only.**

Caller-scoped RLS client:

```ts
import { json } from '@stack/json.ts'
import { createRlsClient } from '@stack/supabase.ts'

export default {
  fetch: async (req: Request) => {
    let supabase
    try {
      supabase = createRlsClient(req)
    } catch {
      return json({ msg: 'Unauthorized' }, 401)
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return json({ msg: 'Unauthorized' }, 401)

    return json({ user })
  },
}
```

Service-role client:

```ts
import { createAdminClient } from '@stack/supabase.ts'

export default {
  fetch: async () => {
    // Add application-specific authorization before bypassing RLS.
    const supabase = createAdminClient()
    // ...
  },
}
```

Never use the service-role client for a public handler without an authorization check.

## Shared Helpers

- `createRlsClient(req)`: internal gateway URL plus caller `Authorization`; RLS is enforced by PostgREST.
- `createAdminClient()`: internal gateway URL plus service role; bypasses RLS.
- `createPublicUrlClient()`: public URL only, useful for `storage.getPublicUrl()`.
- `requireEnv(name)`: fail fast on missing environment variables.
- `json(body, statusOrInit)`: JSON response helper.

`SUPABASE_URL` is `http://gateway:8080`, so function-to-Supabase calls stay on the gateway's unexported Docker-network listener. `storage.getPublicUrl()` is computed client-side by `supabase-js`; use `createPublicUrlClient()` when a function needs to return browser-facing Storage URLs.

## Environment

[compose.yml](../compose.yml) defines these Supabase variables for the Functions container:

- `SUPABASE_URL`: internal gateway URL, currently `http://gateway:8080`.
- `SUPABASE_PUBLIC_URL`: browser-facing API URL.
- `SUPABASE_ANON_KEY`: legacy HS256 anon API key used by the shared client helpers.
- `SUPABASE_SERVICE_ROLE_KEY`: legacy HS256 service-role API key used by the admin client helper.
- `SUPABASE_PUBLISHABLE_KEYS`: JSON map containing the opaque publishable key.
- `SUPABASE_SECRET_KEYS`: JSON map containing the opaque secret key.

The loader forwards the container environment to every worker. Add application-specific secrets only when every function in that container is allowed to see them, or split sensitive functions into a separate deployment.

## Dependencies

Deno imports are pinned in source, for example `npm:@supabase/supabase-js@2.110.0` in [_shared/supabase.ts](./_shared/supabase.ts). Follow [MAINTENANCE.md](../MAINTENANCE.md) when bumping versions.

## Tests

The SDK compatibility runner invokes [example1](./app/example1/index.ts) and [example2](./app/example2/index.ts) from [scripts/supabase-js](../scripts/supabase-js/).
