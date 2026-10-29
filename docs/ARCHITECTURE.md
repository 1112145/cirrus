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
   ├─ query/          # query parsing, filter → SQL builder, item statements (pure; tests run the SQL on node:sqlite) — M2
   ├─ schema/         # type mapping, DDL generator, migration planner (pure; tests run the SQL on node:sqlite) — M1
   └─ sdk/            # TypeScript client SDK — M7+
```

`wrangler.jsonc` and `migrations/` live in `apps/api` so the Worker is self-contained. A package is only created once the milestone that needs it starts.

Tooling: pnpm 10 workspaces, TypeScript 5.9, Vitest 4 + `@cloudflare/vitest-plugin` (the new name of `vitest-pool-workers`), Wrangler 4. `compatibility_date` must not exceed the date supported by the plugin's bundled workerd.

---

## 6. Data model — system tables

Every system table uses the `cirrus_` prefix; user collections may not use it. The authoritative definition is [`apps/api/migrations/`](../apps/api/migrations/) (`0002` adds the full Directus collection/field meta, `0003` the Directus user fields, sessions and the guard table). The API exposes the access tables as Directus' system collections (`directus_users`, `directus_roles`, `directus_policies`, `directus_permissions`, `directus_access`), defined in code in `apps/api/src/system/collections.ts` (ADR-019).

| Table | Purpose |
|---|---|
| `cirrus_collections` | One row per user collection (the real table name) or folder, plus the Directus collection meta (icon, note, hidden, singleton, sort field, group, …) |
| `cirrus_fields` | Field metadata: type, column properties (primary/nullable/unique/indexed, default, auto-increment), Directus field meta (interface + options, special, validation, sort, group, …) |
| `cirrus_relations` | `many_collection.many_field` → `one_collection`, optional O2M alias (`one_field`), junction field for M2M, `on_delete` |
| `cirrus_roles` | Roles, nestable via `parent` (child roles inherit policies) |
| `cirrus_policies` | `admin_access`, `app_access`, `ip_access` (CIDR list), `enforce_tfa` |
| `cirrus_access` | Attaches a policy to a role **or** a user; both NULL = public policy |
| `cirrus_users` | Email (case-insensitive, unique), password hash, role, status, the Directus profile fields, static token (its SHA-256 only) |
| `cirrus_sessions` | One row per refresh token (its SHA-256), with the user, expiry, IP, user agent and origin |
| `cirrus_permissions` | Per policy × collection × action: allowed `fields`, row-level `permissions` filter, payload `validation`, `presets` |
| `cirrus_files` | R2 storage key, filename, MIME type, size, dimensions, uploader |
| `cirrus_settings` | Key/value JSON, including `schema_version` |
| `cirrus_guard` | Never holds rows: guard statements insert into it to fail their batch (ADR-018) |

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

Implemented in M2: `packages/query` (pure: query parsing, filter → SQL, item statements; tests run the SQL on Node's SQLite) and `apps/api/src/items` (payload processing, the service, D1 execution). Since M3, every read and write applies the request's permissions (§10); the public policy starts with none, as in Directus.

### 8.1 Endpoints

```
GET    /items/:collection            list (a singleton: its one item)
SEARCH /items/:collection            list with { query } in the body, or read { keys }
GET    /items/:collection/:id        get one
POST   /items/:collection            create (object or array)
PATCH  /items/:collection/:id        update one
PATCH  /items/:collection            update many: [items with keys] | { keys, data } | { query, data }; a singleton: upsert
DELETE /items/:collection/:id        delete one
DELETE /items/:collection            delete many: [keys] | { keys } | { query }
```

Response: `{ "data": …, "meta": { "total_count", "filter_count" } }` (meta only when requested). Writes answer with the written items as the request's query reads them (`?fields=` …), or 204 when that query matches none of them (or the request may not read them); deletes answer 204. As in Directus, collections that don't exist (and folders) are `FORBIDDEN`, and so are items that don't exist. Admins' updates and deletes by keys skip missing items; with permissions, every key must exist and be writable, or nothing is written (Directus validateAccess). By query, they apply to the rows the query selects within the permission's rows, so its limit (default 100) applies, as in Directus.

The system collections are served by the same code at their Directus paths: `/users`, `/roles`, `/policies`, `/permissions`, `/access`, plus `/users/me`, `/roles/me`, `/policies/me/globals`, `/permissions/me` and `/permissions/me/:collection/:id`. `/items/directus_*` is `FORBIDDEN`, as in Directus.

Each request is one D1 round trip after the schema check: reads batch the data query with the count queries, writes run as one batch, so a write is all or nothing.

### 8.2 Query parameters

Accepted as JSON strings (`filter={…}`), in bracket syntax (`filter[status][_eq]=x`, `fields[]=a`), or as a SEARCH body.

| Param | Example | Notes |
|---|---|---|
| `fields` | `fields=id,title` | `*` = every column; alias fields have no column and are skipped. Relational paths (`author.name`) come with M4 |
| `filter` | `filter={"status":{"_eq":"published"}}` | §8.3 |
| `sort` | `sort=-created_at,title` | default: the collection's `sort_field`, else the primary key; the primary key is always appended as a tiebreaker |
| `limit` / `offset` / `page` | `limit=20&page=2` | default `QUERY_LIMIT_DEFAULT` (100); at most `QUERY_LIMIT_MAX` (1000, ADR-016), where `limit=-1` means that maximum; `page` wins over `offset` |
| `search` | `search=hello` | string/text fields contain the term (ignoring case), numeric fields equal it when it is a number, UUID fields when it is a UUID; fields with `meta.searchable: false` are skipped |
| `meta` | `meta=total_count,filter_count` or `meta=*` | |
| `deep` | | accepted and ignored until relations (M4) |
| `aggregate` / `groupBy` / `alias` | | `INVALID_QUERY` ("not supported yet") rather than a silently different response |

### 8.3 Filter DSL

- Logical: `_and`, `_or` (empty groups match everything, as in Directus); several keys in one object are ANDed.
- Shorthand: `{ "status": "draft" }` is `{ "status": { "_eq": "draft" } }`.
- Comparison: `_eq`, `_neq`, `_lt`, `_lte`, `_gt`, `_gte`, `_in`, `_nin`, `_between`, `_nbetween`, `_null`, `_nnull`, `_empty`, `_nempty`. `_eq: null` / `_neq: null` test for NULL; otherwise SQL semantics apply (`_neq` and `_nin` don't match NULL), as in Directus.
- String: `_contains`, `_starts_with`, `_ends_with` (case-sensitive, like Directus on Postgres), their `_i…` case-insensitive and `_n…` negated forms.
- Values are converted to the field's storage form before comparing (§8.6): `"10"` for an integer field is 10, `"2024-01-05"` for a timestamp field is `2024-01-05T00:00:00.000Z`, so comparisons are correct, not textual accidents. Query-string values `true`, `false` and `null` are read as such.
- Dynamic variables: `$NOW`, `$NOW(-1 year)` (units: years, months, weeks, days, hours, minutes, seconds and their short forms), `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_ROLES` (the role and its ancestors), `$CURRENT_POLICIES`, and `$CURRENT_USER.<field>` / `$CURRENT_ROLE.<field>` (the user's record is read only when something refers to it; relational paths come with M4). Without a user they resolve to null / `[]`.
- Hashed and concealed fields (passwords, static tokens, `conceal` fields) can only be filtered with `_null` / `_nnull` and can't be sorted or searched, so their values can't be recovered by probing (Directus CVE-2023-27481). Permission filters may use them.
- Not supported: `_regex` (SQLite has no regex function), geometry operators (no geometry type). Relational filters (`author.name`, `_some`, `_none`) come with M4.
- Errors follow Directus: unknown fields are `FORBIDDEN` ("… or it does not exist."), malformed filters `INVALID_QUERY`.

### 8.4 Query builder

Pipeline: `parse params (parseQueryString) → sanitize (sanitizeQuery: defaults, limits, dynamic variables) → compile against the collection and the request's Access (unknown or ungranted fields, operators and value types are rejected here) → SQL + numbered binds`. The Access (§10) adds its row filter to every statement and turns fields granted on only some rows into `CASE WHEN … THEN "field" END`, in the SELECT list and wherever the request's filter, sort or search uses them.

- Identifiers: only names present in metadata, quoted as `"…"`.
- Values: always bind parameters.
- Writes: `INSERT … SELECT … FROM json_each(?1) RETURNING pk` for creates; `UPDATE`/`DELETE … WHERE pk IN (…) RETURNING pk`, where `…` is a key, a JSON list of keys, or the keys a query selects (with its sort, limit and offset, as in Directus).
- M4: M2O relations in `fields` via `LEFT JOIN`; O2M/M2M via a second query with `WHERE fk IN (…)`, merged in the app (avoids row duplication). Relation depth (default 3) is capped.

### 8.5 D1 constraints

D1 is SQLite behind an API with its own limits ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/); re-check them before relying on them), which shape the generated SQL:

| Limit | Consequence |
|---|---|
| At most 100 bound parameters per statement | Parameters are numbered (`?1`, `?2`, …) and equal values share one. Lists (`_in`, keys, inserted rows) travel as one JSON array read with `json_each()`. A query needing more than 100 distinct values is refused with `INVALID_QUERY` |
| `LIKE`/`GLOB` patterns of at most 50 bytes | String operators and search use `instr()` / `substr()`, which have no such limit and need no wildcard escaping. Bonus: `_contains` is case-sensitive, where SQLite's `LIKE` isn't |
| Strings (bound values) of at most 2 MB | Inserted rows are split into JSON batches of at most 512 KB, still in one atomic batch |
| No interactive transactions | Every write is a single `batch()`; `RETURNING` reports which rows changed, so missing items are detected without a separate read |

SQLite's `lower()` (and `LIKE`) fold ASCII letters only, so case-insensitive operators treat `É` and `é` as different.

### 8.6 Values and payloads

`packages/schema/src/values.ts` checks each payload value against its field type and stores it in one canonical form, so filters compare like with like:

| Type | Accepted | Stored |
|---|---|---|
| string, text, hash | strings (numbers and booleans as text) | TEXT |
| uuid | any 8-4-4-4-12 hex string | lowercase |
| integer, bigInteger | integers, integer strings, within ±(2^53 − 1): D1 returns JS numbers, so larger values couldn't be read back exactly | INTEGER |
| float, decimal | numbers, numeric strings | REAL |
| boolean | `true`/`false`, `1`/`0`, `"true"`/`"false"` | 0/1, returned as booleans |
| json | any JSON; a string holding valid JSON is stored as that JSON (Directus behaves the same) | JSON text, returned parsed |
| csv | array or comma-separated string | `a,b`, returned as an array |
| timestamp | ISO 8601 date/time; no zone = UTC | `YYYY-MM-DDTHH:MM:SS.sssZ` |
| dateTime | ISO 8601 date/time; a zone is converted to UTC | `YYYY-MM-DDTHH:MM:SS` |
| date / time | `YYYY-MM-DD` (a time part is ignored) / `HH:MM[:SS]` | as shown |

Payload processing (`apps/api/src/items/payload.ts`), following Directus' PayloadService:
- Keys that aren't columns are ignored, as in Directus; alias fields (nested relational writes) come with M4.
- Specials: `uuid` (and UUID primary keys, ADR-007) get a UUIDv7 on create; `date-created` / `date-updated` are set on create / update; `user-created` / `user-updated` get the current user (null for public requests and `ADMIN_TOKEN`); `hash` fields (type or special) are hashed with PBKDF2-SHA256, 100 000 iterations (the most Workers allow), in PHC format; `conceal` fields read as `**********`.
- String fields with a `max_length` are checked (`VALUE_TOO_LONG`), since SQLite doesn't enforce lengths.
- The primary key can't be changed by an update.
- Constraint errors map to Directus codes: `RECORD_NOT_UNIQUE`, `NOT_NULL_VIOLATION` (with `collection` and `field`).
- Following Directus' processPayload, with permissions: the payload may only set fields the permission grants (`FORBIDDEN` with the field names otherwise), presets fill in what it leaves out, then field `meta.validation` rules (for everyone) and the permissions' `validation` must pass. Rules are filters checked in `packages/query/src/validate.ts` with the same value conversions as SQL filters: fields the payload leaves out pass, except with `_submitted`; `_regex` works here. Failures are `FAILED_VALIDATION` errors, one per failed rule, with Directus' messages and extensions (`field`, `type`, `valid`/`invalid`/`substring`). Hashing runs after validation. `meta.required` is enforced by the admin app, not the API, in Directus too.
- Nested O2M writes, on the system aliases that support them (`roles.policies`, `roles.users`, `roles.children`, `users.policies`, `policies.permissions`; user collections in M4): an array replaces the related items (keys link, objects with a key update, objects without one create; items no longer listed are deleted or unlinked), or `{ create, update, delete }` changes them one by one. Every related write is checked against the related collection's permissions, and everything runs in the parent's batch.

### 8.7 Differences from Directus

Deliberate, where Directus' behavior is a quirk or doesn't fit D1:
- Every operator in `{ "field": { "_gt": 1, "_lt": 5 } }` applies; Directus applies only the first.
- Updating or deleting an item that doesn't exist is `FORBIDDEN` for admins too (Directus answers 204 to admins).
- `?fields=`, `filter` and `sort` on a write are checked before writing, so a bad query doesn't leave a write behind with a 204.
- `_contains` and friends treat `%` and `_` literally.
- Values are type-checked (`INVALID_PAYLOAD` / `INVALID_QUERY`) instead of surfacing database errors.
- Updates and deletes by query select rows within the permission's rows (others are left alone, not `FORBIDDEN`), and their query may filter on the fields the request may read. Directus selects with full access, then fails when a selected row isn't writable.
- A permission's `validation` is satisfied when one granting policy's rule passes (policies are additive), field `meta.validation` always applies.
- Nested updates through `{ update: [...] }` only reach items already linked to the parent; links to items that don't exist are `FORBIDDEN`, for admins too.

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

Implemented in M3: `apps/api/src/auth` (login, refresh, logout), `apps/api/src/middleware/auth.ts` (tokens), `apps/api/src/request.ts` (accountability), `apps/api/src/access` (snapshot, permissions), and the permission checks in `apps/api/src/items/service.ts` and `packages/query` (`access.ts`, `compile.ts`, `validate.ts`).

**Auth**
- Email/password login (`POST /auth/login`), passwords hashed with PBKDF2-SHA256 via WebCrypto. Emails match ignoring case; an unknown email costs a hash check like a wrong password, so it doesn't reveal which emails exist. Suspended users are told so (`USER_SUSPENDED`) only once their password is right; other inactive users get `INVALID_CREDENTIALS`.
- Access tokens: HS256 JWTs signed with the `SECRET` secret, `ACCESS_TOKEN_TTL` (15 minutes), with Directus' claims `{ id, role, app_access, admin_access, iss: "directus" }`. Only `id` and `role` are trusted: each request recomputes policies and admin/app access from the current snapshot, so permission changes apply at once; a role change applies at the next refresh (ADR-017).
- Refresh tokens: 32 random bytes, `REFRESH_TOKEN_TTL` (7 days), stored in `cirrus_sessions` as their SHA-256. `POST /auth/refresh` replaces the token in one statement, so each works once; expired sessions and sessions of users no longer active are refused and removed. `POST /auth/logout` deletes the session. Modes: `json` (refresh token in the body) and `cookie` (httpOnly `directus_refresh_token` cookie, `REFRESH_TOKEN_COOKIE_SECURE` / `_SAME_SITE` / `_DOMAIN`). `session` mode comes with the admin UI (M6).
- Static tokens: `directus_users.token`, stored as its SHA-256 and read as `**********`; active users only.
- `ADMIN_TOKEN`: an optional static admin token without a user, to create the first users and as a way back in (ADR-013).
- Tokens arrive as `Authorization: Bearer` or `?access_token=`; a JWT with `iss: "directus"` is verified (`INVALID_TOKEN`, `TOKEN_EXPIRED`), anything else is looked up as a static token (`INVALID_CREDENTIALS`).
- Later: 2FA (`otp`, `enforce_tfa`), SSO/OAuth, password reset (needs email), login rate limiting, a cron job deleting expired sessions.

**Model (Directus 11):** `role` (nestable via `parent`) → `cirrus_access` → `policy` → `permissions`. A policy can be attached to a role or directly to a user; an access row with both `role` and `user` NULL is the **public policy** (seeded with Directus' id, with no permissions). Migration `0003` also seeds an Administrator role with an admin policy.

**Collecting the policies for a request** (Directus 11 fetchPolicies), from the schema snapshot, which holds roles, policies, access rows and permissions (ADR-012): every write to them replaces `schema_version`.
- The role tree: the user's role and its ancestors via `parent` (`$CURRENT_ROLES`, top-level first).
- The policies of those roles (parents first), then the user's own policies. Users without a role, and requests without a user, get the public policy instead of role policies; users with a role don't get it.
- Policies whose `ip_access` (IPs and CIDR ranges) doesn't match the request IP (`CF-Connecting-IP`) are dropped.
- Users with app access also get Directus' minimal app permissions: read their own user, roles, policies, permissions and access rows.

**Evaluation** (per collection and action; `buildAccess()` in `packages/query/src/access.ts`)
1. Any policy with `admin_access` → no checks.
2. No permission for `(policies, collection, action)` → `FORBIDDEN` ("You don't have permission to "read" from collection …").
3. Policies add up:
   - Rows: the permissions' `permissions` filters ORed (one without a filter opens every row), ANDed into every statement.
   - Fields: a field is usable if some permission grants it (`*` or by name). Its value is visible on the rows of the permissions that grant it: when those aren't all of them (and none is unrestricted), it reads as `CASE WHEN <their filters> THEN field END`, also in the request's filters, sorts and search, so hidden values can't be probed. `*` expands to the granted fields; asking for others is `FORBIDDEN`.
   - Writes: payload fields must be granted; an update or delete must reach only rows within the row filter (and, per field written, within that field's condition) — checked by a guard statement in the same batch (ADR-018), so a request touching one forbidden row writes nothing.
   - `validation`: valid if one permission's rule passes; `presets`: merged in policy order, the payload wins.
4. `/permissions/me` reports `{ collection: { action: { access: none | partial | full, fields, presets } } }`; `/permissions/me/:collection/:id` whether the item may be updated, deleted and shared.
5. `/collections` and `/fields` list what the request may read; schema changes stay admin-only.

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
| **M2 – Items** ✅ | Dynamic CRUD + filter/sort/fields/pagination | CRUD on `posts` with nested `_and/_or` filters |
| **M3 – Auth & RBAC** ✅ | Login, JWT, roles, policies, permissions + row-level | An "editor" role only sees its own posts |
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
| R5 | Combining row-level filters and field permissions across policies makes SQL complex (`CASE WHEN` per field) | One CASE per field and statement, sharing parameters; tested on SQLite in `packages/query` |
| R6 | No login rate limiting yet: passwords can be guessed at the speed of PBKDF2 | Add a rate limit (Workers rate limiting binding or a Durable Object) before production use |
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
| ADR-013 | `ADMIN_TOKEN` (optional secret) is a static admin token without a user, sent like a Directus static token (`Authorization: Bearer` or `?access_token=`). Before M3 it was the only way in; now it creates the first users and stays as a way back in (Directus has no equivalent; leave it unset to disable it) | ✅ Accepted |
| ADR-014 | Item SQL is generated within D1's limits (§8.5): numbered, shared bind parameters (at most 100), lists as one JSON parameter read with `json_each()`, and `instr()`/`substr()` instead of `LIKE`/`GLOB` | ✅ Accepted |
| ADR-015 | Item values are type-checked and stored in one canonical form per type (§8.6): lowercase UUIDs, UTC ISO timestamps, booleans as 0/1, integers within ±(2^53 − 1). Filter values are converted the same way before comparing | ✅ Accepted |
| ADR-016 | `QUERY_LIMIT_DEFAULT` = 100 (as in Directus) and `QUERY_LIMIT_MAX` = 1000 (Directus: unlimited), both Worker vars: every row is serialized within the Worker's CPU and memory limits. With a maximum, `limit=-1` returns that many, as in Directus | ✅ Accepted |
| ADR-017 | Access tokens are HS256 JWTs (WebCrypto, `SECRET`) with Directus' claims; requests recompute policies from the snapshot instead of trusting `admin_access`/`app_access` claims. Refresh tokens and static tokens are random values stored only as SHA-256 digests (fast hashing is enough for high-entropy tokens, and a leaked database leaks no working token); refresh tokens rotate on every use. Directus stores both in plain text and keeps a short grace period for reused refresh tokens, which Cirrus doesn't | ✅ Accepted |
| ADR-018 | Writes that must check rows first put a guard statement before themselves in the same D1 batch: `INSERT INTO cirrus_guard SELECT 0 WHERE <violation>`, against a table whose CHECK always fails. D1 batches are transactions, so a violation rolls back everything, in one round trip, without the race of a separate read. Used for permissions on keys and queries, and for nested writes | ✅ Accepted |
| ADR-019 | System collections (`directus_users`, `directus_roles`, `directus_policies`, `directus_permissions`, `directus_access`) are defined in code over the `cirrus_*` tables and served by the items service, so queries, permissions, errors and nested writes behave as for user collections. They aren't listed in `/collections` yet | ✅ Accepted |
| ADR-020 | The public policy applies to requests without a user and to users without a role, as in Directus 11 (not to every request, as this document first said) | ✅ Accepted |

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
- Each milestone adds tests for its endpoints: M0 → `serverPing`, `serverInfo`, `serverHealth`, error detection via `isDirectusError`; M1 → `createCollection`, `createField`, `readCollections`, `readCollection`, `readFields`, `readFieldsByCollection`, `readField`, `updateCollection`, `updateCollectionsBatch`, `updateField`, `updateFields`, `deleteField`, `deleteCollection`; M2 → `readItems`, `readItem`, `createItem`, `createItems`, `updateItem`, `updateItems`, `updateItemsBatch`, `deleteItem`, `deleteItems`, `readSingleton`, `updateSingleton`, `withSearch`; M3 → `login` (command and `authentication()`), `refresh`, `logout`, `readMe`, `updateMe`, `readUsers`, `readUser`, `createUser(s)`, `updateUser`, `deleteUser`, `readRoles`, `readRole`, `readRolesMe`, `createRole`, `updateRole`, `deleteRole`, `readPolicies`, `readPolicy`, `readPolicyGlobals`, `createPolicy`, `updatePolicy`, `deletePolicy`, `readPermissions`, `readPermission`, `readUserPermissions`, `readItemPermissions`, `createPermission(s)`, `updatePermission`, `deletePermission`, `readProviders`; M5 → `uploadFiles`.
- With a real Directus available, send the same requests to both and compare response snapshots (ignoring ids and timestamps). The reference server uses the `directus/directus:11.17.4` image (not v12, which limits collections on the Core tier).
- `@directus/sdk` is MIT-licensed; the licensing limits apply only to the Directus server, not to using the SDK as a test client.

### 17.4 Out of compatibility scope (early phases)

GraphQL, `realtime()` (the Directus WebSocket protocol), revisions, translations, extensions, the Directus Flows UI format.
