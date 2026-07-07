# Edge Functions

Deno functions on [`supabase/edge-runtime`](https://github.com/supabase/edge-runtime), fronted by Caddy at `/functions/v1/*`.

## Request flow

```
Caddy → functions:9000 → functions/index.ts (main loader) → per-function worker
```

[index.ts](./index.ts) parses the first URL segment as the function name, validates `[a-zA-Z0-9_-]+`, and dispatches via `EdgeRuntime.userWorkers.create()`. Workers are reused (`forceCreate: false`); retired workers are recreated on `WorkerAlreadyRetired`.

## Layout

```
functions/
├── index.ts           # Main loader (required)
├── _shared/           # Not routed
│   ├── supabase.ts
│   ├── requireEnv.ts
│   └── json.ts
├── example1/
│   └── index.ts
└── example2/
    └── index.ts
```

Any directory with `index.ts` or `index.js` is served at `/functions/v1/<name>/`. `_shared` and dot-directories are excluded.

## Worker limits

| Setting | Value |
| --- | --- |
| Memory | 150 MB |
| Wall timeout | 5 min |
| CPU soft / hard | 10 s / 20 s |
| Module cache | enabled |

## Routing examples

```
/functions/v1/example1/foo  →  example1
/functions/v1/_shared       →  404 (excluded)
/functions/v1/missing       →  404 (no entrypoint)
```

## Internal endpoints

- `GET /_internal/health` — container healthcheck
- `GET /_internal/metric` — runtime metrics

## Writing a function

1. Create `functions/<name>/index.ts` with `Deno.serve(...)`.
2. Redeploy is automatic (volume mount); restart the container if workers cache stale code.

### Public handler

```ts
import { json } from '../_shared/json.ts'

Deno.serve(() => json({ ok: true }))
```

### RLS-scoped (caller JWT)

```ts
import { createRlsClient } from '../_shared/supabase.ts'
import { json } from '../_shared/json.ts'

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

### Service role (bypass RLS)

```ts
import { createAdminClient } from '../_shared/supabase.ts'

Deno.serve(async (req) => {
  // Add your own authorization before using admin client.
  const supabase = createAdminClient()
  // ...
})
```

## Shared helpers (`_shared/`)

| Export | Purpose |
| --- | --- |
| `createRlsClient(req)` | Client with caller's `Authorization` header; RLS enforced |
| `createAdminClient()` | Service-role client; bypasses RLS |
| `createPublicUrlClient()` | `SUPABASE_PUBLIC_URL` only — for `storage.getPublicUrl()` |
| `requireEnv(name)` | Fail fast on missing env |
| `json(body, status?)` | JSON response helper |

`SUPABASE_URL` is `http://gateway` so traffic stays on `private_net`. Use `createPublicUrlClient()` when the browser needs a public storage URL.

## Environment (from `compose.yml`)

Forwarded to every worker:

| Variable | Role |
| --- | --- |
| `SUPABASE_URL` | Internal gateway (`http://gateway`) |
| `SUPABASE_PUBLIC_URL` | Public API base URL |
| `SUPABASE_ANON_KEY` | Internal asymmetric anon JWT |
| `SUPABASE_SERVICE_ROLE_KEY` | Internal asymmetric service JWT |

Add more keys on the `functions` service in `compose.yml` as needed.

## Dependencies

Pinned in source, e.g. `npm:@supabase/supabase-js@2.110.0` in [_shared/supabase.ts](./_shared/supabase.ts). Bump via [MAINTENANCE.md](../MAINTENANCE.md).

## Tests

Integration tests invoke `example1` and `example2`: [scripts/supabase-js](../scripts/supabase-js/).
