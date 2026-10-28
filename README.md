# Cirrus

A Directus-style headless CMS that runs entirely on Cloudflare (Workers + Hono, D1, R2, KV, Durable Objects, Queues).
Its REST API is compatible with `@directus/sdk` 21.3.0 (Directus 11.17.4). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

> **Status:** early development. M0 (scaffold) is done; see the [milestones](https://github.com/1112145/cirrus/milestones) for the roadmap.

## Layout

```
apps/api/            Hono Worker
  src/               routes, middleware
  migrations/        D1 migrations for the system tables (cirrus_*)
  test/              tests running inside workerd; test/contract/ uses the real @directus/sdk
  wrangler.jsonc
packages/shared/     Directus-style error codes, UUIDv7
docs/                architecture and decision log
```

`packages/query`, `packages/schema` (M1–M2), `packages/sdk` and `apps/admin` (M6) are added when their milestone starts.

## Getting started

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm db:migrate:local      # create the system tables in local D1
pnpm dev                   # http://localhost:8787/server/ping → pong
pnpm test                  # unit + contract tests
pnpm typecheck
```

## First deploy

```bash
cd apps/api
npx wrangler d1 create cirrus          # copy the database_id into wrangler.jsonc
pnpm db:migrate:remote
pnpm deploy
```

## Conventions

- Throw `CirrusError(code, message)` from `@cirrus/shared`; the error middleware serializes it as `{ errors: [{ message, extensions: { code } }] }`.
- Primary keys default to UUIDv7 (`uuidv7()` in `@cirrus/shared`).
- Never build SQL from input strings: identifiers must match metadata, values are always bind parameters.
- Every new endpoint needs a contract test in `apps/api/test/contract/`.
- `compatibility_date` in `wrangler.jsonc` must not exceed the date supported by the workerd bundled with `@cloudflare/vitest-plugin`.

## Roadmap

| Milestone | Status |
|---|---|
| M0 – Scaffold | ✅ |
| M1 – Schema (collections/fields) | ⏳ |
| M2 – Items | |
| M3 – Auth & RBAC | |
| M4 – Relations | |
| M5 – Files | |
| M6 – Admin UI MVP | |
| M7+ – Extensions | |
