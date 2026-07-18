# Vendoring Supabase Headless Into An App

Use this repository as a **pinned Git submodule** inside your application repo. The app owns product SQL, Edge Functions, secrets, and compose overrides. This stack owns the reusable data plane (gateway, Postgres, Auth, REST, Realtime, Storage, Functions loader).

Day-to-day stack operation (start, secrets, TLS, migrations rules, production checklist) lives in the [main README](./README.md) and service docs. This file only covers **how to vendor and configure** the stack from an app project.

## Ownership Split

| Owned by the app repo | Owned by `vendor/supabase-headless` |
| --- | --- |
| Root `compose.yml` include + overrides | Base services and default wiring |
| Root `.env` / `.env.example` | Platform env contract + `generate-keys.mjs` |
| `db/app/migrations/*.sql` | Postgres image, bootstrap, stack migrations, migrator |
| App Edge Functions | Edge Runtime loader and `@stack/*` helpers |
| Optional auth mailer templates | Gateway route that can serve them |
| Optional extra services (ETL, workers, …) | Caddy, Auth, REST, Realtime, Storage, RustFS, imgproxy |

Do **not** edit files under `vendor/supabase-headless` for product work. Those changes are wiped on the next pin bump, and a dirty submodule blocks a clean checkout of a new tag (Git will refuse or leave conflicts until you discard local vendor edits).

## Bare Minimum

The smallest working app layout is:

```text
my-app/
├── .env                 # copied from the vendor .env.example, then secrets filled
├── .gitmodules
├── compose.yml          # include only
└── vendor/
    └── supabase-headless/   # submodule pin
```

Root `compose.yml`:

```yaml
include:
  - path: ./vendor/supabase-headless/compose.yml
```

That is enough to start the full stack. Compose resolves paths inside the included file relative to the vendor directory, so vendor mounts (Caddyfile, stack SQL, example functions under `functions/app`, …) keep working. Docker Compose still loads **your app root** `.env` for variable substitution.

You do not need app migrations, custom functions, or auth overrides to boot. Until you mount your own trees, the stack uses the vendor defaults (empty app migration history + example functions).

## First-Time Init

From a new or existing app repository:

```bash
git init   # skip if the app repo already exists

git submodule add https://github.com/gatherpeers/supabase-headless.git vendor/supabase-headless
cd vendor/supabase-headless
git fetch --tags
git checkout v0.0.14   # pin a release tag; replace with the tag you want
cd ../..

# Persist the pin in the parent repo
git add .gitmodules vendor/supabase-headless
git commit -m "Add supabase-headless submodule at v0.0.14"
```

Create the include compose file (see [Bare Minimum](#bare-minimum)), then:

```bash
cp vendor/supabase-headless/.env.example .env
node vendor/supabase-headless/generate-keys.mjs --update-env
docker compose up -d
```

Ignore `vendor/supabase-headless/.env` in the app `.gitignore`. The composed stack reads the **app root** `.env` only.

Cloning an app that already vendors the stack:

```bash
git clone --recurse-submodules <your-app-repo>
# or, after a normal clone:
git submodule update --init --recursive
```

For start/stop, local HTTPS, and production hardening after bring-up, follow the [main README](./README.md).

## Command Prefix

Anything documented in this repository as a path under the repo root must be prefixed with `vendor/supabase-headless` when you run it from the app.

Examples:

| In this repo | From the app repo root |
| --- | --- |
| `node generate-keys.mjs --update-env` | `node vendor/supabase-headless/generate-keys.mjs --update-env` |
| `./db/types-gen-ts.sh …` | `bash vendor/supabase-headless/db/types-gen-ts.sh …` |
| Docs under `caddy/`, `db/`, `functions/` | `vendor/supabase-headless/caddy/…`, etc. |

`docker compose …` stays unprefixed: run it from the **app root** so it picks up your include file and root `.env`.

## Bumping The Vendor Pin

When this repository publishes a new tag:

```bash
cd vendor/supabase-headless
git fetch --tags
git checkout v0.0.14
cd ../..

git add vendor/supabase-headless
git commit -m "Bump supabase-headless to v0.0.14"
git push origin main
```

Before committing the pin:

1. Read the vendor [README](./README.md) / [MAINTENANCE.md](./MAINTENANCE.md) and the upstream [Supabase self-hosted Docker changelog](https://github.com/supabase/supabase/blob/master/docker/CHANGELOG.md).
2. Diff env vars, gateway routes, function loader contracts, and stack migrations.
3. Validate and restart from the app root: `docker compose config` then `docker compose up -d`.
4. Rebuild the functions image if the loader or `@stack` helpers changed (`docker compose build functions`).

If `git checkout` fails because the submodule is dirty, you changed files under `vendor/`. Discard those edits (or move them into the app repo as overrides) and try again.

## Configuration

### What must be set

For local bring-up: copy `.env.example` → `.env` and run `generate-keys.mjs --update-env`. Empty JWT/API keys and infrastructure secrets are filled automatically. See [First-Time Setup](./README.md#first-time-setup) in the main README.

For a real deployment you must still set product values in the root `.env` (domains, SMTP/OAuth, CORS, contact email, Realtime dashboard password, and so on). The platform block in `.env.example` is the contract; append app-only variables under the `APPLICATION` section.

Compose include alone does **not** copy env files. The app root `.env` is required.

### Configuration surfaces

| Surface | Use for |
| --- | --- |
| App root `.env` | Domains, secrets, CORS, pool sizes, Auth/SMTP/OAuth toggles already wired in the vendor compose |
| App `compose.yml` service overrides | Extra env on existing services, volume mounts, resource limits, `name:` / project name |
| New compose services | App-only sidecars (ETL, workers, one-shot jobs) on `private_net` / `public_net` |
| App SQL / functions trees | Product schema and Deno handlers (via mounts below) |

Prefer `.env` when the vendor compose already interpolates the variable. Prefer a compose override when you need a new mount, a new `GOTRUE_*` (or other) var not listed in the base compose, or a new service.

Optional but useful on the include file:

```yaml
name: ${COMPOSE_PROJECT_NAME:-my-app}

include:
  - path: ./vendor/supabase-headless/compose.yml
```

### Common overrides

**App migrations** — mount your SQL into the migrator (paths relative to the app root):

```yaml
services:
  db-migrate:
    volumes:
      - ./db/app/migrations:/app/migrations:ro
```

Authoring rules: [db/README.md](./db/README.md).

**App Edge Functions** — replace the vendor `functions/app` mount with your tree (`!override` is required so you do not keep the vendor example mount):

```yaml
services:
  functions:
    volumes: !override
      - ./functions:/home/deno/functions:ro
```

Loader contract and `@stack/*` imports: [functions/README.md](./functions/README.md).

**Custom auth email templates** — mount templates into the gateway and point `GOTRUE_MAILER_TEMPLATES_*` at `http://gateway:8081/mailer/…`. Details: [caddy/README.md](./caddy/README.md#auth-email-templates).

**Auth / product env not in the base compose** — redeclare the `auth` (or other) service in the app compose and add the extra `environment:` entries.

**Gateway logs on the app tree** — the base compose writes Caddy logs under the vendor `logs/` path. Remount if you want them in the app repo:

```yaml
services:
  gateway:
    volumes:
      - ./logs/caddy:/var/log/caddy
```

**Extra services** — declare them in the app compose, attach to `private_net` (and `public_net` only if they need outbound internet), and depend on `db` / `db-migrate` as needed. Keep them out of the vendor repo.

### What you usually leave alone

- Stack migrations under `vendor/.../db/stack`
- Caddyfile, unless you intentionally fork gateway behavior (prefer filing changes upstream)
- Image pins in the vendor compose (bump the submodule tag instead)
- Internal network layout and host port publishing (only the gateway should publish `80`/`443`)

## Suggested App Layout

A typical product backend after the bare minimum:

```text
my-app/
├── .env / .env.example
├── .gitmodules
├── compose.yml              # include + overrides
├── db/app/migrations/       # product SQL
├── functions/               # product Edge Functions (+ optional _shared/)
├── auth/mailer/templates/   # optional
└── vendor/supabase-headless/
```

Keep platform secrets generation and type generation pointed at the vendor scripts; keep generated outputs (`database.types.ts`, local CA certs) in the app repo or gitignored as you prefer.

## Related Docs

- [README.md](./README.md) — architecture, first-time setup of the stack itself, local HTTPS, production checklist
- [db/README.md](./db/README.md) — migrations, RLS, types
- [functions/README.md](./functions/README.md) — Edge Functions layout and vendoring mounts
- [caddy/README.md](./caddy/README.md) — gateway, CORS, mailer templates
- [MAINTENANCE.md](./MAINTENANCE.md) — image pins and upgrade workflow