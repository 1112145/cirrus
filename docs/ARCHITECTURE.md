# Cirrus — Architecture (v0.1, draft)

> A Directus-style headless CMS / data platform that runs entirely on Cloudflare.
> Status: **proposal**. Items marked ❓ are open decisions.

---

## 1. Goals & scope

**Goals**
- Define collections and fields through the API or the admin UI, and get a matching dynamic REST API.
- Fine-grained access control by role → collection → action → field.
- File management on R2.
- 100% serverless on Cloudflare, with near-zero cost at low traffic.

**Scope**
- **Single-project:** one deployment = one project = one database. No multi-tenancy.
- **REST API compatible with `@directus/sdk`** for the endpoint groups Cirrus supports (see §17). Features outside that scope (GraphQL, revisions, …) are not covered.

**Out of scope (early phases)**
- GraphQL, content i18n, revisions/versioning, multiple databases.

---

## 2. Design principles

1. **Metadata is the source of truth.** Every user table has matching metadata; the dynamic API reads it to validate requests and build queries.
2. **Real tables, no EAV.** Each collection is a real SQLite table in D1, so queries and indexes stay efficient.
3. **Vertical slices first.** Every milestone must work end to end.
4. **Safe by default.** SQL is never built from input strings: identifiers are checked against metadata and every value goes through a bind parameter.
5. **Edge-friendly.** Workers hold no state; state lives only in D1, KV, R2 and Durable Objects.

---

## 3. Stack & mapping from Directus

| Directus component | Cirrus on Cloudflare |
|---|---|
| Node.js + Express | Workers + **Hono** |
| PostgreSQL/MySQL | **D1** (SQLite) |
| Storage adapters | **R2** |
| Cache (Redis) | **KV** (+ Cache API) |
| Flows / hooks | **Queues** (async), middleware (sync) |
| WebSockets / realtime | **Durable Objects** (WebSocket Hibernation) |
| Schedules | **Cron Triggers** |
| Admin app (Vue) | SPA served by **Workers Static Assets** |

---

## 4. Overview

```
             ┌──────────────── Worker: cirrus-api (Hono) ────────────────┐
 Client ───► │ auth mw → permission mw → router                           │
             │   /items/:collection  → Items service → Query builder ──►  │──► D1
             │   /collections, /fields, /relations → Schema service ──►   │──► D1 (DDL)
             │   /files  → Files service ─────────────────────────────►   │──► R2
             │   /auth   → Auth service                                   │
             │   hooks (sync) ── emit ──► Queue ──► Flow consumer         │
             └────────────────────────────────────────────────────────────┘
                  │ schema snapshot cache                 │ realtime events
                  ▼                                       ▼
                 KV                               Durable Object (per collection/room)
```

**Schema snapshot:** all metadata (collections, fields, relations, permissions) is loaded into one object and cached in isolate memory. Each request revalidates it with one small query on `cirrus_settings.schema_version` in D1, which every schema change replaces with a new value (ADR-012).

---

## 5. Repository layout

```
cirrus/
├─ apps/
│  ├─ api/            # Hono Worker: routes, services, middleware
│  │  ├─ migrations/  # D1 migrations for the system tables
│  │  ├─ test/        # tests run inside workerd; test/contract/ uses the real @directus/sdk
│  │  └─ wrangler.jsonc
│  └─ admin/          # Vue 3 (Vite) SPA — M6
└─ packages/
   ├─ shared/         # Directus error codes, UUIDv7, types, zod schemas, filter DSL types
   ├─ query/          # filter → SQL builder (pure, testable without D1) — M2
   ├─ schema/         # type mapping, DDL generator, migration planner (pure; tests run the SQL on node:sqlite) — M1
   └─ sdk/            # TypeScript client SDK — M7+
```

`wrangler.jsonc` and `migrations/` live in `apps/api` so the Worker is self-contained. A package is only created once the milestone that needs it starts.

Tooling: pnpm 10 workspaces, TypeScript 5.9, Vitest 4 + `@cloudflare/vitest-plugin` (the new name of `vitest-pool-workers`), Wrangler 4. `compatibility_date` must not exceed the date supported by the plugin's bundled workerd.

---

## 6. Data model — system tables

Every system table uses the `cirrus_` prefix; user collections may not use it. The authoritative definition is [`apps/api/migrations/`](../apps/api/migrations/) (`0002` adds the full Directus collection/field meta).

| Table | Purpose |
|---|---|
| `cirrus_collections` | One row per user collection (the real table name) or folder, plus the Directus collection meta (icon, note, hidden, singleton, sort field, group, …) |
| `cirrus_fields` | Field metadata: type, column properties (primary/nullable/unique/indexed, default, auto-increment), Directus field meta (interface + options, special, validation, sort, group, …) |
| `cirrus_relations` | `many_collection.many_field` → `one_collection`, optional O2M alias (`one_field`), junction field for M2M, `on_delete` |
| `cirrus_roles` | Roles, nestable via `parent` (child roles inherit policies) |
| `cirrus_policies` | `admin_access`, `app_access`, `ip_access` (CIDR list), `enforce_tfa` |
| `cirrus_access` | Attaches a policy to a role **or** a user; both NULL = public policy |
| `cirrus_users` | Email (case-insensitive, unique), password hash, role, status |
| `cirrus_permissions` | Per policy × collection × action: allowed `fields`, row-level `permissions` filter, payload `validation`, `presets` |
| `cirrus_files` | R2 storage key, filename, MIME type, size, dimensions, uploader |
| `cirrus_settings` | Key/value JSON, including `schema_version` |

JSON columns carry a `json_valid()` CHECK; booleans are `0/1` with CHECKs.

---

## 7. Schema engine & migrations

### 7.1 Type mapping

Field types use the Directus names. User tables are `STRICT` (ADR-011), so SQLite rejects values the column type can't hold.

| Field type | SQLite | Notes |
|---|---|---|
| string, text, uuid, hash, csv | TEXT | UUIDs generated in the app; primary keys use UUIDv7 (time-ordered, more compact B-tree than v4) |
| integer, bigInteger | INTEGER | |
| boolean | INTEGER | 0/1 with a CHECK, converted on serialization |
| float, decimal | REAL | SQLite has no exact decimal type |
| dateTime, date, time, timestamp | TEXT | ISO 8601 (UTC for timestamp); `CURRENT_TIMESTAMP` / `now()` allowed as default |
| json | TEXT | validated with a `json_valid()` CHECK |
| alias | — | no column (O2M, M2M, UI dividers) |

Primary keys: `uuid` (default, ADR-007), `string`, or `integer`/`bigInteger` with optional auto-increment.

### 7.2 DDL operations

Every schema change is one `db.batch()`: DDL + metadata writes + a compare-and-swap on `schema_version` (ADR-012), so it is atomic and can't be based on an outdated snapshot.

- **Create collection:** `CREATE TABLE … STRICT` + indexes + metadata. Without `schema` it is a Directus folder: metadata only.
- **Unique / indexed:** separate indexes named `<collection>.<field>.unique|index` (dots can't appear in names, so they never collide with tables), so toggling them is `CREATE/DROP INDEX`, never a rebuild.
- **Add field:** `ALTER TABLE … ADD COLUMN`. A `NOT NULL` column without default only works while the table is empty (`CONTAINS_NULL_VALUES` otherwise); a non-constant default (`CURRENT_TIMESTAMP`) needs a rebuild.
- **Drop field:** drop its index, then `ALTER TABLE … DROP COLUMN`.
- **Rename field / collection:** not supported (Directus doesn't support it either).
- **Change type / nullable / default (FK in M4):** the standard SQLite **table rebuild**:
  1. `CREATE TABLE _new_x (…)` with the new schema
  2. `INSERT INTO _new_x SELECT … FROM x` (with casts)
  3. `DROP TABLE x`
  4. `ALTER TABLE _new_x RENAME TO x`
  5. Recreate indexes

  All in one batch, with the temporary table named `cirrus_rebuild_<name>`. Values are copied without casts: `STRICT` makes the copy fail (and the batch roll back) when existing values don't fit the new type, instead of silently converting them. The admin UI must warn about rebuilds, since they are slow on large tables.

### 7.3 Migration planner

`packages/schema` takes `(current metadata, desired metadata)` and returns a list of DDL steps plus a `requiresRebuild` flag (`planTableChange`). It is pure logic; its tests execute the generated SQL on Node's built-in SQLite, without D1.

Later: `GET /schema/snapshot` + `POST /schema/apply` to version the schema in git (like Directus schema snapshots).

### 7.4 D1 limits to keep in mind

- Database size is capped (currently 10 GB per database): enough for one project, but no blobs.
- Writes are serialized per database: avoid long transactions and run large rebuilds at quiet times.
- No interactive transactions through the binding; only `batch()` is atomic.
- ⚠️ Re-check the current limits in the Cloudflare docs before relying on them.

---

## 8. Items API

### 8.1 Endpoints

```
GET    /items/:collection            list
GET    /items/:collection/:id        get one
POST   /items/:collection            create (object or array)
PATCH  /items/:collection/:id        update one
PATCH  /items/:collection            update many (keys + data)
DELETE /items/:collection/:id        delete one
DELETE /items/:collection            delete many
```

Response: `{ "data": …, "meta": { "total_count", "filter_count" } }` (meta only when requested).

### 8.2 Query parameters

| Param | Example |
|---|---|
| `fields` | `fields=id,title,author.name,tags.*` |
| `filter` | `filter={"status":{"_eq":"published"}}` |
| `sort` | `sort=-created_at,title` |
| `limit` / `offset` / `page` | `limit=20&page=2` |
| `search` | simple full-text (LIKE on string fields) |
| `meta` | `meta=total_count,filter_count` |
| `aggregate` / `groupBy` | later |

### 8.3 Filter DSL

- Logical: `_and`, `_or`
- Comparison: `_eq`, `_neq`, `_lt`, `_lte`, `_gt`, `_gte`, `_in`, `_nin`, `_null`, `_nnull`, `_between`
- String: `_contains`, `_icontains`, `_starts_with`, `_ends_with`
- Relational: path filters such as `author.name`, plus `_some` / `_none` for O2M/M2M
- Dynamic variables: `$CURRENT_USER`, `$CURRENT_ROLE`, `$NOW` (needed for row-level permissions)

### 8.4 Query builder

Pipeline: `parse params → validate against the schema snapshot → merge permission filters → build SQL AST → render SQL + binds`.

- Identifiers: only names present in metadata, quoted as `"…"`.
- Values: always bind parameters.
- M2O relations in `fields`: `LEFT JOIN`.
- O2M/M2M relations in `fields`: a second query with `WHERE fk IN (…)`, merged in the app (avoids row duplication).
- Relation depth (default 3) and maximum `limit` (e.g. 1000) are capped to prevent heavy queries.

---

## 9. Relations

| Type | Storage |
|---|---|
| M2O | FK column on the "many" table + one `cirrus_relations` row |
| O2M | alias field on the "one" table, pointing back at the M2O relation |
| M2M | junction table (two FKs) + two relations, an alias field on each side |
| M2A | later ❓ |

Nested writes for O2M/M2M in Directus format (`{ create: [], update: [], delete: [] }`) come later.

---

## 10. Auth & permissions

**Auth**
- Email/password, hashed with PBKDF2 via WebCrypto (built into Workers).
- Short-lived JWT access tokens (15 minutes) + refresh tokens stored in D1 (or KV) so they can be revoked.
- Static tokens for server-to-server use.
- SSO/OAuth: later ❓

**Model (Directus 11):** `role` (nestable via `parent`) → `cirrus_access` → `policy` → `permissions`. A policy can be attached to a role or directly to a user; an access row with both `role` and `user` NULL is the **public policy**.

**Collecting the policies for a request** (precomputed, cached per user/role):
- The public policy (always applies, even when logged in).
- Policies of the user's role and of every ancestor role via `parent`.
- Policies attached directly to the user.
- Drop policies whose `ip_access` does not match the request IP.

**Evaluation** (middleware, per request)
1. Any policy with `admin_access` → skip all checks.
2. Fetch every permission for `(policy ∈ policies, collection, action)`; none → 403.
3. **Combine policies additively (union):**
   - `fields`: union of allowed fields.
   - `permissions` (row-level): OR the filters across policies, then AND the result into the query filter. A field is only returned on rows that satisfy the filter of a policy that grants that field (Directus 11 uses `CASE WHEN`; Cirrus does the same in the query builder).
   - `validation`: a payload is valid if it satisfies at least one granting policy.
   - `presets`: merged in `sort` order.
4. `app_access` controls admin UI access; `enforce_tfa` requires 2FA (later).

Policies, access rows and permissions are all part of the schema snapshot, so D1 is not queried on every request.

---

## 11. Files (R2)

- `POST /files`: multipart upload streamed straight into R2, metadata written to `cirrus_files`.
- Large files: R2 presigned URLs / multipart upload.
- `GET /assets/:id`: served through the Worker with permission checks and `Range` support.
- Image transforms (`?width=&format=`): Cloudflare Images / Image Resizing ❓ (depends on plan).
- Caching: `Cache-Control` + Cache API for public assets.

---

## 12. Extensions: hooks, flows, realtime, cache

- **Sync hooks:** `items.create.before` / `after`, … run inside the request (validation, data transformation).
- **Async flows:** `items.*` events are pushed to a **Queue**; a consumer runs the operations (webhooks, email, item updates). Flow definitions live in system tables (`cirrus_flows`, `cirrus_operations`).
- **Schedules:** Cron Triggers start flows on a schedule.
- **Realtime:** a Durable Object per collection; clients subscribe over WebSocket and the Items service publishes events after successful writes. WebSocket Hibernation keeps costs down.
- **Cache:** response cache for public `GET`s in KV/Cache API, invalidated per collection on writes.

---

## 13. Admin UI

- **Vue 3 + Vite** SPA served from Workers Static Assets on the same domain as the API (no CORS).
- Screens, in priority order: Login → Data model (collections/fields) → Content (item list/detail) → Files → Users/Roles/Permissions → Settings.
- Item forms are rendered dynamically from `cirrus_fields.interface` + `options`.

---

## 14. Roadmap

Tracked as [GitHub milestones](https://github.com/1112145/cirrus/milestones).

| Milestone | Content | Done when |
|---|---|---|
| **M0 – Scaffold** ✅ | Monorepo, Hono Worker, D1 binding, system table migrations, CI | `wrangler dev` runs and tests pass (contract: `serverPing`/`serverInfo`/`serverHealth`) |
| **M1 – Schema** ✅ | Collections/fields API, DDL generator, schema snapshot | A `posts` collection can be created via the API |
| **M2 – Items** | Dynamic CRUD + filter/sort/fields/pagination | CRUD on `posts` with nested `_and/_or` filters |
| **M3 – Auth & RBAC** | Login, JWT, roles, policies, permissions + row-level | An "editor" role only sees its own posts |
| **M4 – Relations** | M2O, O2M, M2M + nested `fields` | `posts.author.name`, `posts.tags.*` |
| **M5 – Files** | Upload/serve via R2 | A post can have a cover image |
| **M6 – Admin UI MVP** | Data model + Content + Files | `posts` can be managed entirely through the UI |
| **M7+** | Flows (Queues), realtime (DO), cache, schema snapshot, SDK | — |

---

## 15. Risks & open questions

| # | Issue | Notes |
|---|---|---|
| R1 | Rebuilding large tables may be slow or hit time limits | Warn in the UI; consider chunked rebuilds via Queues |
| R2 | Schema snapshots drifting between isolates | Check `schema_version` in D1 on each request (one small, strongly consistent query) — ADR-012 |
| R3 | Deep relational queries causing N+1 / CPU cost | Depth limit, batched `IN (…)` |
| R4 | D1's single writer under concurrent writes | Acceptable for single-project; monitor latency |
| R5 | Combining row-level filters and field permissions across policies makes SQL complex (`CASE WHEN` per field) | Test heavily in `packages/query`; cache merged permissions per policy set |
| Q1 | Vue or React for the admin UI? | ✅ Vue — ADR-006 |
| Q2 | Default ID: integer autoincrement or UUID? | ✅ UUID by default, integer selectable per collection — ADR-007 |
| Q3 | Directus SDK compatibility? | ✅ Yes (REST) — ADR-008, §17 |
| Q4 | Which image transform service? | ❓ (M5) |
| Q5 | Which Directus / `@directus/sdk` version to target? | ✅ Directus 11.x — ADR-009 |
| Q6 | Adopt the Directus 11 **policy** model? | ✅ Yes — ADR-010, §6, §10 |

---

## 16. Architecture decision log (ADR)

| ID | Decision | Status |
|---|---|---|
| ADR-001 | Single-project, no multi-tenancy | ✅ Accepted |
| ADR-002 | Workers + Hono, D1, R2, KV, DO, Queues | ✅ Accepted |
| ADR-003 | Each collection is a real table; metadata in `cirrus_*` | 🟡 Proposed |
| ADR-004 | Directus query syntax (`filter`, `fields`, …) | ✅ Accepted (follows from ADR-008) |
| ADR-005 | pnpm monorepo; `query` and `schema` as pure packages | 🟡 Proposed |
| ADR-006 | Admin UI in Vue 3 (Vite), served via Workers Static Assets | ✅ Accepted |
| ADR-007 | Primary keys default to UUID (app-generated, UUIDv7); integer autoincrement selectable per collection | ✅ Accepted |
| ADR-008 | REST API compatible with `@directus/sdk` (requests, responses, errors, auth) for supported endpoints | ✅ Accepted |
| ADR-009 | Compatibility target is **Directus 11.x**, not v12: v12 enforces licensing (collection/seat/flow limits on the Core tier) and changes the API (`?version=published`, `archived` collections). Pinned: reference server **Directus 11.17.4** (last 11.x release), client **`@directus/sdk` 21.3.0** (released the same day, 2026-04-30; SDK 22.0.0 ships with Directus 12) | ✅ Accepted |
| ADR-010 | Access control follows the Directus 11 policy model: nested roles, policies attached to roles or users, permissions belong to policies, additive across policies | ✅ Accepted |
| ADR-011 | User tables are `STRICT`; unique/indexed flags are separate named indexes, so toggling them never rebuilds the table | ✅ Accepted |
| ADR-012 | Schema snapshot cached in isolate memory and revalidated against `schema_version` in D1 on each request, not in KV: KV is eventually consistent (up to ~60 s), which would serve outdated schemas after a change, and a cold load is a single D1 batch anyway. Each schema change writes a new UUIDv7 `schema_version` with a compare-and-swap in the same batch, so concurrent changes can't overwrite each other | ✅ Accepted |
| ADR-013 | Until users and auth exist (M3), admin access is the `ADMIN_TOKEN` secret, sent like a Directus static token (`Authorization: Bearer` or `?access_token=`). Without it, schema endpoints answer `FORBIDDEN` | ✅ Accepted (temporary) |

---

## 17. `@directus/sdk` compatibility

Goal: a client written as `createDirectus(url).with(rest()).with(authentication())` works against Cirrus unchanged, within the supported endpoints.

### 17.1 What must match

| Area | Requirement |
|---|---|
| Paths | Unchanged: `/items/:collection`, `/collections`, `/fields/:collection`, `/relations`, `/files`, `/assets/:id`, `/users`, `/users/me`, `/roles`, `/policies`, `/permissions`, `/permissions/me`, `/auth/*`, `/server/info`, `/server/ping`, `/server/health` |
| Query params | Accept both JSON strings (`filter={…}`) and bracket syntax (`filter[status][_eq]=x`); `fields` and `sort` as comma-separated lists or arrays; minimal `deep` and `alias` support |
| Responses | Wrapped in `{ "data": … }`, with `meta` when requested |
| Errors | `{ "errors": [{ "message", "extensions": { "code" } }] }` using Directus codes (`FORBIDDEN`, `INVALID_CREDENTIALS`, `INVALID_PAYLOAD`, `RECORD_NOT_UNIQUE`, `TOKEN_EXPIRED`, …) and matching HTTP statuses |
| Auth | `POST /auth/login` → `{ data: { access_token, expires, refresh_token } }`; `POST /auth/refresh`, `POST /auth/logout`; `json` and `cookie` modes; static tokens via `Authorization: Bearer` or `?access_token=` |
| Schema endpoints | Directus shapes: field = `{ collection, field, type, meta: {…}, schema: {…} }`, collection = `{ collection, meta, schema }` |

### 17.2 Design consequences

- **Storage and API shape are separate layers.** `cirrus_fields` stays flat (§6); `apps/api/src/schema/meta.ts` (one spec per meta property: validation, default, column) and `directus.ts` convert to and from the `meta`/`schema` shape, so the internal model is not tied to the Directus format.
- **System collection names.** The SDK uses dedicated paths (`/users`, `/files`, …) rather than `/items/directus_users`, so the internal `cirrus_` prefix can stay. Relations pointing at users/files must still map `directus_users` ↔ `cirrus_users` and `directus_files` ↔ `cirrus_files`.
- **Error codes** live in one shared module; services throw errors with a standard `code` and the final middleware serializes them in Directus format.
- **Data types:** gradually add the common Directus types (`dateTime`, `timestamp`, `date`, `time`, `bigInteger`, `decimal`, `csv`, `hash`) to the mapping in §7.1.

### 17.3 Compatibility testing

- A **contract test** suite runs the real `@directus/sdk` 21.3.0 against the local Worker via `@cloudflare/vitest-plugin`.
- Each milestone adds tests for its endpoints: M0 → `serverPing`, `serverInfo`, `serverHealth`, error detection via `isDirectusError`; M1 → `createCollection`, `createField`, `readCollections`, `readCollection`, `readFields`, `readFieldsByCollection`, `readField`, `updateCollection`, `updateCollectionsBatch`, `updateField`, `updateFields`, `deleteField`, `deleteCollection`; M2 → `readItems`, `createItem`, `updateItem`, `deleteItem`; M3 → `login`, `refresh`, `readMe`; M5 → `uploadFiles`.
- With a real Directus available, send the same requests to both and compare response snapshots (ignoring ids and timestamps). The reference server uses the `directus/directus:11.17.4` image (not v12, which limits collections on the Core tier).
- `@directus/sdk` is MIT-licensed; the licensing limits apply only to the Directus server, not to using the SDK as a test client.

### 17.4 Out of compatibility scope (early phases)

GraphQL, `realtime()` (the Directus WebSocket protocol), revisions, translations, extensions, the Directus Flows UI format.
