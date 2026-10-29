# Cirrus

A Directus-style headless CMS that runs entirely on Cloudflare (Workers + Hono, D1, R2, KV, Durable Objects, Queues).
Its REST API is compatible with `@directus/sdk` 21.3.0 (Directus 11.17.4). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

> **Status:** early development. M0 (scaffold), M1 (schema: collections and fields) and M2 (items: CRUD with filter, sort, fields, search and paging) are done; see the [milestones](https://github.com/1112145/cirrus/milestones) for the roadmap.

## Layout

```
apps/api/            Hono Worker
  src/routes/        HTTP endpoints (/server, /collections, /fields, /items)
  src/schema/        schema snapshot, Directus payload mapping, schema-change service
  src/items/         items service: payload processing (field specials, hashing), reads and writes
  src/middleware/    auth (admin token), JSON body, Directus error format
  migrations/        D1 migrations for the system tables (cirrus_*)
  test/              tests running inside workerd; test/contract/ uses the real @directus/sdk
  wrangler.jsonc
packages/shared/     Directus-style error codes, UUIDv7, PBKDF2 hashing
packages/schema/     field types → SQLite, value codecs, DDL generator, migration planner (pure)
packages/query/      Directus query parsing, filter → SQL compiler, item statements (pure)
docs/                architecture and decision log
```

`packages/sdk` and `apps/admin` (M6) are added when their milestone starts.

## Getting started

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm db:migrate:local      # create the system tables in local D1
echo 'ADMIN_TOKEN=dev-admin-token' > apps/api/.dev.vars
pnpm dev                   # http://localhost:8787/server/ping → pong
pnpm test                  # unit + contract tests
pnpm typecheck
```

Create a collection (schema endpoints need the admin token until auth lands in M3):

```bash
curl -X POST http://localhost:8787/collections \
  -H 'Authorization: Bearer dev-admin-token' -H 'Content-Type: application/json' \
  -d '{"collection":"posts","schema":{},"fields":[{"field":"title","type":"string"}]}'
```

then work with its items (also admin-only until M3):

```bash
curl -X POST http://localhost:8787/items/posts \
  -H 'Authorization: Bearer dev-admin-token' -H 'Content-Type: application/json' \
  -d '[{"title":"Hello"},{"title":"World"}]'
curl -g 'http://localhost:8787/items/posts?filter[title][_icontains]=hello&sort=-title&meta=*' \
  -H 'Authorization: Bearer dev-admin-token'
```

or with the SDK: `createDirectus(url).with(staticToken(token)).with(rest())`, then `readItems('posts', { filter: … })`.

## First deploy

```bash
cd apps/api
npx wrangler d1 create cirrus          # copy the database_id into wrangler.jsonc
pnpm db:migrate:remote
npx wrangler secret put ADMIN_TOKEN    # a long random string; without it nobody can change the schema
pnpm deploy
```

## Conventions

- Throw `CirrusError(code, message)` from `@cirrus/shared`; the error middleware serializes it as `{ errors: [{ message, extensions: { code } }] }`.
- Primary keys default to UUIDv7 (`uuidv7()` in `@cirrus/shared`).
- Never build SQL from input strings: identifiers must match metadata, values are always bind parameters. The one exception is DDL defaults, which SQLite can't bind; they go through `defaultSql()` in `@cirrus/schema`.
- Item SQL comes from `@cirrus/query` and must respect D1's limits (spec §8.5): numbered parameters through `Params` (at most 100), lists as one JSON parameter read with `json_each()`, no `LIKE`/`GLOB`.
- Schema changes go through `commit()` in `apps/api/src/schema/service.ts`: one atomic D1 batch that also swaps `schema_version`.
- Every new endpoint needs a contract test in `apps/api/test/contract/`.
- `compatibility_date` in `wrangler.jsonc` must not exceed the date supported by the workerd bundled with `@cloudflare/vitest-plugin`.

## Roadmap

| Milestone | Status |
|---|---|
| M0 – Scaffold | ✅ |
| M1 – Schema (collections/fields) | ✅ |
| M2 – Items | ✅ |
| M3 – Auth & RBAC | ⏳ |
| M4 – Relations | |
| M5 – Files | |
| M6 – Admin UI MVP | |
| M7+ – Extensions | |
