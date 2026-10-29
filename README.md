# Cirrus

A Directus-style headless CMS that runs entirely on Cloudflare (Workers + Hono, D1, R2, KV, Durable Objects, Queues).
Its REST API is compatible with `@directus/sdk` 21.3.0 (Directus 11.17.4). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

> **Status:** early development. M0 (scaffold), M1 (schema: collections and fields), M2 (items: CRUD with filter, sort, fields, search and paging), M3 (auth: login, roles, policies, permissions down to rows and fields), M4 (relations: M2O, O2M, M2M, nested fields, relational filters, `deep`, nested writes, `on_delete`) and M5 (files: uploads streamed into R2, folders, assets with Range, cache headers and image transformations) are done; see the [milestones](https://github.com/1112145/cirrus/milestones) for the roadmap.

## Layout

```
apps/api/            Hono Worker
  src/routes/        HTTP endpoints (/server, /auth, /collections, /fields, /relations, /items, /users, /roles, /policies, /permissions, /access, /files, /folders, /assets)
  src/schema/        schema snapshot, Directus payload mapping, schema-change service, relations
  src/items/         items service: payload processing, permission checks, reads, writes, nested writes, on_delete
  src/access/        roles/policies/permissions snapshot, the policies of a request, app access permissions
  src/auth/          login, refresh and logout (JWT access tokens, rotating refresh tokens)
  src/files/         uploads into R2, imports, replacing and deleting contents, assets and image transformations
  src/system/        system collections (directus_users, …) over the cirrus_* tables
  src/middleware/    authentication (tokens), JSON body, Directus error format
  migrations/        D1 migrations for the system tables (cirrus_*)
  test/              tests running inside workerd; test/contract/ uses the real @directus/sdk
  wrangler.jsonc
packages/shared/     Directus-style error codes, UUIDv7, PBKDF2 hashing, JWT, tokens, IP ranges
packages/schema/     field types → SQLite, value codecs, DDL generator, migration planner (pure)
packages/query/      Directus query parsing, filter → SQL compiler with permissions and relations, nested reads, item statements, payload validation (pure)
packages/files/      streaming multipart parser, image dimensions and Exif, MIME types, titles, asset transformation plans (pure)
docs/                architecture and decision log
```

`packages/sdk` and `apps/admin` (M6) are added when their milestone starts.

## Getting started

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm db:migrate:local      # create the system tables in local D1
printf 'SECRET=dev-secret\nADMIN_TOKEN=dev-admin-token\n' > apps/api/.dev.vars
pnpm dev                   # http://localhost:8787/server/ping → pong
pnpm test                  # unit + contract tests
pnpm typecheck
```

`SECRET` signs access tokens. `ADMIN_TOKEN` is a static admin token: use it to create the first user, with the
Administrator role the migrations seed:

```bash
curl -X POST http://localhost:8787/users \
  -H 'Authorization: Bearer dev-admin-token' -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"change me","role":"01a1857c-54d5-7148-8495-9e81c8a7caa5"}'
curl -X POST http://localhost:8787/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"change me","mode":"json"}'
# → { "data": { "access_token": "…", "refresh_token": "…", "expires": 900000 } }
```

Then use the access token (or the SDK: `createDirectus(url).with(authentication('json')).with(rest())`, then `login({ email, password })`).
Create a collection:

```bash
curl -X POST http://localhost:8787/collections \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"collection":"posts","schema":{},"fields":[{"field":"title","type":"string"}]}'
```

then work with its items:

```bash
curl -X POST http://localhost:8787/items/posts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[{"title":"Hello"},{"title":"World"}]'
curl -g 'http://localhost:8787/items/posts?filter[title][_icontains]=hello&sort=-title&meta=*' \
  -H "Authorization: Bearer $TOKEN"
```

Relate collections like Directus: create the fields, then the relation (`one_field` names the O2M alias on the
other side; `schema.on_delete` says what deleting an author does to their posts):

```bash
curl -X POST http://localhost:8787/collections \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"collection":"authors","schema":{},"fields":[{"field":"name","type":"string"},{"field":"posts","type":"alias","meta":{"special":["o2m"]}}]}'
curl -X POST http://localhost:8787/fields/posts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"field":"author","type":"uuid"}'
curl -X POST http://localhost:8787/relations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"collection":"posts","field":"author","related_collection":"authors","meta":{"one_field":"posts"},"schema":{"on_delete":"SET NULL"}}'
curl -X POST 'http://localhost:8787/items/authors?fields=name,posts.title' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"Ada","posts":[{"title":"Hi"}]}'
curl -g 'http://localhost:8787/items/posts?fields=title,author.name&filter[author][name][_eq]=Ada' \
  -H "Authorization: Bearer $TOKEN"
```

Upload files (multipart, as `uploadFiles()` sends them; fields before a file describe it), relate items to them,
and serve them, resized by the `IMAGES` binding:

```bash
curl -X POST 'http://localhost:8787/files?fields=id,title,width,height' \
  -H "Authorization: Bearer $TOKEN" -F 'title=Beach' -F 'file=@beach.jpg;type=image/jpeg'
curl -X POST http://localhost:8787/fields/posts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"field":"cover","type":"uuid","meta":{"interface":"file-image","special":["file"]}}'
curl -X POST http://localhost:8787/relations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"collection":"posts","field":"cover","related_collection":"directus_files","schema":{"on_delete":"SET NULL"}}'
curl "http://localhost:8787/assets/$FILE_ID?width=600&height=400&fit=cover&format=webp" \
  -H "Authorization: Bearer $TOKEN" -o cover.webp
```

Non-admins need permissions: create a policy with `/policies` and `/permissions` (row filters such as
`{ "author": { "_eq": "$CURRENT_USER" } }`, allowed fields, validation, presets), attach it to a role or a user
(`/roles` with `policies: [{ "policy": "<id>" }]`, or `/access`), and give users that role. Requests without a
token get the public policy, which starts with no permissions.

## First deploy

```bash
cd apps/api
npx wrangler d1 create cirrus          # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create cirrus-files
pnpm db:migrate:remote
npx wrangler secret put SECRET         # a long random string; it signs access tokens
npx wrangler secret put ADMIN_TOKEN    # optional: another long random string, to create the first users
pnpm deploy
```

Asset transformations use [Cloudflare Images](https://developers.cloudflare.com/images/transform-images/bindings/)
through the `IMAGES` binding (billed per transformation beyond the free allowance; each variant is made once and kept
in R2). Remove the binding from `wrangler.jsonc` to turn them off.

## Conventions

- Throw `CirrusError(code, message)` from `@cirrus/shared`; the error middleware serializes it as `{ errors: [{ message, extensions: { code } }] }`.
- Primary keys default to UUIDv7 (`uuidv7()` in `@cirrus/shared`).
- Never build SQL from input strings: identifiers must match metadata, values are always bind parameters. The one exception is DDL defaults, which SQLite can't bind; they go through `defaultSql()` in `@cirrus/schema`.
- Item SQL comes from `@cirrus/query` and must respect D1's limits (spec §8.5): numbered parameters through `Params` (at most 100), lists as one JSON parameter read with `json_each()`, no `LIKE`/`GLOB`.
- Schema changes go through `commit()` in `apps/api/src/schema/service.ts`: one atomic D1 batch that also swaps `schema_version`.
- Items reads and writes go through `apps/api/src/items/service.ts`, which applies the request's permissions; system collections (`directus_users`, …) are defined in `apps/api/src/system/collections.ts` and use the same service.
- A write that must check rows first (permissions, nested writes) puts a guard statement (`guardItems()` in `@cirrus/query`) before itself in the same batch, so D1 rolls everything back when a row doesn't qualify.
- Writes to roles, policies, access and permissions replace `schema_version`, so every isolate reloads the snapshot.
- Relations are kept by the items service, not by SQLite foreign keys (ADR-021): writes setting M2O keys add a
  `foreignKeyGuard()`, and deletes go through `planDelete()`, which applies `on_delete`. A batch that stashes keys
  (`stashKeys()`, `stashNewKey()`) ends with `clearKeys()`; `Batch` in `items/service.ts` does that.
- Pass the request's `related` resolver in every `Scope`, so relational filters (permissions' too) compile.
- Files' contents are written to R2 before their records, under keys no other file can have, and deleted when the
  record write fails; deleting or replacing a file deletes the old contents (and their variants) after the batch.
  `filename_disk` is the server's: requests can't set it.
- Every new endpoint needs a contract test in `apps/api/test/contract/`.
- `compatibility_date` in `wrangler.jsonc` must not exceed the date supported by the workerd bundled with `@cloudflare/vitest-plugin`.

## Roadmap

| Milestone | Status |
|---|---|
| M0 – Scaffold | ✅ |
| M1 – Schema (collections/fields) | ✅ |
| M2 – Items | ✅ |
| M3 – Auth & RBAC | ✅ |
| M4 – Relations | ✅ |
| M5 – Files | ✅ |
| M6 – Admin UI MVP | ⏳ |
| M7+ – Extensions | |
