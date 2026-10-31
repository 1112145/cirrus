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
| Image transformations (sharp) | **Cloudflare Images** binding (ADR-025) |
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
│  │  └─ wrangler.example.jsonc  # template; wrangler.jsonc is each operator's git-ignored copy
│  └─ admin/          # Vue 3 (Vite) SPA, served by the Worker under /admin — M6
└─ packages/
   ├─ shared/         # Directus error codes, UUIDv7, types, zod schemas, filter DSL types
   ├─ query/          # query parsing, filter → SQL builder, item statements (pure; tests run the SQL on node:sqlite) — M2
   ├─ schema/         # type mapping, DDL generator, migration planner (pure; tests run the SQL on node:sqlite) — M1
   ├─ files/          # streaming multipart parser, image dimensions and Exif, MIME types, titles, transformation plans (pure) — M5
   └─ sdk/            # TypeScript client SDK — M8+
```

The Wrangler config and `migrations/` live in `apps/api` so the Worker is self-contained. Only the template
`wrangler.example.jsonc` is committed, with placeholder IDs; tests and the e2e suite read it, and the `dev`,
`db:migrate:*` and `deploy` scripts copy it to the git-ignored `wrangler.jsonc` when missing. A package is only created once the milestone that needs it starts.

Tooling: pnpm 10 workspaces, TypeScript 5.9, Vitest 4 + `@cloudflare/vitest-plugin` (the new name of `vitest-pool-workers`), Wrangler 4. `compatibility_date` must not exceed the date supported by the plugin's bundled workerd.

---

## 6. Data model — system tables

Every system table uses the `cirrus_` prefix; user collections may not use it. The authoritative definition is [`apps/api/migrations/`](../apps/api/migrations/) (`0002` adds the full Directus collection/field meta, `0003` the Directus user fields, sessions and the guard table, `0004` the relation meta and the batch keys table, `0005` files and folders). The API exposes these tables as Directus' system collections (`directus_users`, `directus_roles`, `directus_policies`, `directus_permissions`, `directus_access`, `directus_files`, `directus_folders`), defined in code in `apps/api/src/system/collections.ts` (ADR-019).

| Table | Purpose |
|---|---|
| `cirrus_collections` | One row per user collection (the real table name) or folder, plus the Directus collection meta (icon, note, hidden, singleton, sort field, group, …) |
| `cirrus_fields` | Field metadata: type, column properties (primary/nullable/unique/indexed, default, auto-increment), Directus field meta (interface + options, special, validation, sort, group, …) |
| `cirrus_relations` | `many_collection.many_field` → `one_collection`, optional O2M alias (`one_field`), junction field for M2M, O2M `sort_field`, `one_deselect_action`, `on_delete` (NULL: created with `schema: null`, nothing enforced) |
| `cirrus_roles` | Roles, nestable via `parent` (child roles inherit policies) |
| `cirrus_policies` | `admin_access`, `app_access`, `ip_access` (CIDR list), `enforce_tfa` |
| `cirrus_access` | Attaches a policy to a role **or** a user; both NULL = public policy |
| `cirrus_users` | Email (case-insensitive, unique), password hash, role, status, the Directus profile fields, static token (its SHA-256 only) |
| `cirrus_sessions` | One row per refresh token (its SHA-256), with the user, expiry, IP, user agent and origin |
| `cirrus_login_attempts` | Login rate limit counters (per IP and email, per IP, per email): attempts in the current window and when it ends (ADR-029) |
| `cirrus_permissions` | Per policy × collection × action: allowed `fields`, row-level `permissions` filter, payload `validation`, `presets` |
| `cirrus_files` | Directus 11's file columns: `storage`, `filename_disk` (the object's key in R2; unique, set by the server), `filename_download`, `title`, `type`, `folder`, `filesize`, `width`/`height`, `metadata`, focal point, uploader/modifier and dates (§11) |
| `cirrus_folders` | `name` and `parent` (a folder with subfolders can't be deleted, as in Directus) |
| `cirrus_settings` | Key/value JSON, including `schema_version` |
| `cirrus_guard` | Never holds rows: guard statements insert into it to fail their batch (ADR-018); `ok` fails as FORBIDDEN, `fk` as INVALID_FOREIGN_KEY |
| `cirrus_batch_keys` | Scratch keys passed between statements of one batch (ADR-023); the batch empties it as its last statement |

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
- **Relations:** metadata only (`cirrus_relations`), never DDL: user tables have no SQLite foreign keys (ADR-021), so creating or deleting a relation never rebuilds a table.
- **Change type / nullable / default:** the standard SQLite **table rebuild**:
  1. `CREATE TABLE _new_x (…)` with the new schema
  2. `INSERT INTO _new_x SELECT … FROM x` (with casts)
  3. `DROP TABLE x`
  4. `ALTER TABLE _new_x RENAME TO x`
  5. Recreate indexes

  All in one batch, with the temporary table named `cirrus_rebuild_<name>`. Values are copied without casts: `STRICT` makes the copy fail (and the batch roll back) when existing values don't fit the new type, instead of silently converting them. The admin UI must warn about rebuilds, since they are slow on large tables.

### 7.3 Migration planner

`packages/schema` takes `(current metadata, desired metadata)` and returns a list of DDL steps plus a `requiresRebuild` flag (`planTableChange`). It is pure logic; its tests execute the generated SQL on Node's built-in SQLite, without D1.

Schema snapshots (§7.5) use it to apply a whole schema at once.

### 7.4 D1 limits to keep in mind

- Database size is capped (currently 10 GB per database): enough for one project, but no blobs.
- Writes are serialized per database: avoid long transactions and run large rebuilds at quiet times.
- No interactive transactions through the binding; only `batch()` is atomic.
- ⚠️ Re-check the current limits in the Cloudflare docs before relying on them.

### 7.5 Schema snapshots

Implemented in `apps/api/src/schema/snapshot.ts` and `apps/api/src/routes/schema.ts`, with deep-diff's format in `packages/shared/src/diff.ts`. The schema can be versioned in git and moved between projects as with Directus (`schemaSnapshot()`, `schemaDiff()`, `schemaApply()` in the SDK). Admin only.

- `GET /schema/snapshot`: `{ version: 1, directus: "11.17.4", vendor: "sqlite", collections, fields, systemFields: [], relations }`, the objects of `/collections`, `/fields` and `/relations` without their ids, keys sorted, collections by name. `?export=json` downloads it as a file (Directus also exports YAML; Cirrus doesn't).
- `POST /schema/diff` with a snapshot: `{ data: { hash, diff: { collections, fields, systemFields, relations } } }`, each entry naming what it changes and listing deep-diff changes (`N`, `D`, `E`, `A`); 204 when there are none. Fields and relations of deleted collections aren't listed. A snapshot of another Directus version or database is refused unless `?force=true`. The snapshot is checked as a whole first and put in the form this server would give it, so only meaningful differences show up: from Postgres, `data_type`, constraint names and `nextval(…)` defaults are dropped, and properties Cirrus doesn't know are ignored, as everywhere in the API.
- `POST /schema/apply` with `{ hash, diff }`: refused (`INVALID_PAYLOAD`) when the hash isn't the current schema's, which means the schema changed since the diff. The diff is applied to the current snapshot, the result is checked as a whole, and the DDL and metadata writes that turn the schema into it run in one batch (ADR-030): a schema is applied entirely or not at all. Changes to existing data fail as the API's would (`CONTAINS_NULL_VALUES`, `INVALID_FOREIGN_KEY`, …) and leave everything as it was.
- What a snapshot can't do, as through the API: turn a folder into a table or back, give an alias field a column, change a primary key, change system collections (their fields, relations and `systemFields` are fixed), or describe many-to-any relations. Collections and fields can't be renamed: a new name is a deletion and a creation.

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

The system collections are served by the same code at their Directus paths: `/users`, `/roles`, `/policies`, `/permissions`, `/access`, `/files` and `/folders` (§11), plus `/users/me`, `/roles/me`, `/policies/me/globals`, `/permissions/me` and `/permissions/me/:collection/:id`. `/items/directus_*` is `FORBIDDEN`, as in Directus.

Each request is one D1 round trip after the schema check: reads batch the data query with the queries for relational fields and the count queries, writes run as one batch, so a write is all or nothing.

### 8.2 Query parameters

Accepted as JSON strings (`filter={…}`), in bracket syntax (`filter[status][_eq]=x`, `fields[]=a`), or as a SEARCH body.

| Param | Example | Notes |
|---|---|---|
| `fields` | `fields=title,author.name,comments.*` | `*` = every field the request may read: columns, and O2M aliases as lists of keys (other alias fields have no value and are skipped); `*.*` adds every relational field with its fields, as in Directus. Relational paths: §8.4 |
| `filter` | `filter={"status":{"_eq":"published"}}` | §8.3 |
| `sort` | `sort=-created_at,author.name` | default: the collection's `sort_field`, else the primary key; the primary key is always appended as a tiebreaker. Paths through M2O fields sort on the related item's value |
| `limit` / `offset` / `page` | `limit=20&page=2` | default `QUERY_LIMIT_DEFAULT` (100); at most `QUERY_LIMIT_MAX` (1000, ADR-016), where `limit=-1` means that maximum; `page` wins over `offset` |
| `search` | `search=hello` | string/text fields contain the term (ignoring case), numeric fields equal it when it is a number, UUID fields when it is a UUID; fields with `meta.searchable: false` are skipped |
| `meta` | `meta=total_count,filter_count` or `meta=*` | |
| `deep` | `deep={"comments":{"_limit":5,"_sort":"-date"}}` | the query of a relational field's items: `_filter`, `_search`, `_sort`, `_limit`, `_offset`, `_page` (O2M; an M2O only takes `_filter`), and the `deep` of their own relational fields. JSON or bracket syntax |
| `aggregate` / `groupBy` / `alias` | | `INVALID_QUERY` ("not supported yet") rather than a silently different response |

Paths into relations may have at most `MAX_RELATIONAL_DEPTH` segments (Directus' variable and default: 10, at least 2) in `fields`, `sort`, `filter` and `deep`; deeper ones are `INVALID_QUERY` ("Max relational depth exceeded").

### 8.3 Filter DSL

- Logical: `_and`, `_or` (empty groups match everything, as in Directus); several keys in one object are ANDed.
- Shorthand: `{ "status": "draft" }` is `{ "status": { "_eq": "draft" } }`.
- Comparison: `_eq`, `_neq`, `_lt`, `_lte`, `_gt`, `_gte`, `_in`, `_nin`, `_between`, `_nbetween`, `_null`, `_nnull`, `_empty`, `_nempty`. `_eq: null` / `_neq: null` test for NULL; otherwise SQL semantics apply (`_neq` and `_nin` don't match NULL), as in Directus.
- String: `_contains`, `_starts_with`, `_ends_with` (case-sensitive, like Directus on Postgres), their `_i…` case-insensitive and `_n…` negated forms.
- Values are converted to the field's storage form before comparing (§8.6): `"10"` for an integer field is 10, `"2024-01-05"` for a timestamp field is `2024-01-05T00:00:00.000Z`, so comparisons are correct, not textual accidents. Query-string values `true`, `false` and `null` are read as such.
- Relational filters (spec §9): `{ "author": { "name": { "_eq": "Ada" } } }` filters on the item an M2O points at, like Directus' LEFT JOIN: without one (or when the request may not read it) its fields are null, so `_null` matches; operators next to the fields still apply to the key. `{ "comments": { "_some": {…} } }` matches items with a related item matching, `_none` items with none; `{ "comments": {…} }` means `_some`. M2M goes through the junction (`{ "tags": { "tags_id": { "name": "x" } } }`). The related collections' read access applies inside: their row filter, and only the fields they grant (CASE WHEN for partial grants), so a filter can't reveal what a read couldn't. Permission filters may use relational paths too; they are compiled without those checks.
- Dynamic variables: `$NOW`, `$NOW(-1 year)` (units: years, months, weeks, days, hours, minutes, seconds and their short forms), `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_ROLES` (the role and its ancestors), `$CURRENT_POLICIES`, and `$CURRENT_USER.<path>` / `$CURRENT_ROLE.<path>`, paths through relations included (`$CURRENT_USER.role.name`; through an O2M, the list of values). The user's record is read only when something refers to it, with the paths referred to, like an item read as an admin (so concealed values stay masked). Without a user they resolve to null / `[]`.
- Hashed and concealed fields (passwords, static tokens, `conceal` fields) can only be filtered with `_null` / `_nnull` and can't be sorted or searched, so their values can't be recovered by probing (Directus CVE-2023-27481). Permission filters may use them.
- Not supported: `_regex` (SQLite has no regex function), geometry operators (no geometry type), functions (`count(comments)`, `year(date)`).
- Errors follow Directus: unknown fields are `FORBIDDEN` ("… or it does not exist."), malformed filters `INVALID_QUERY`.

### 8.4 Query builder

Pipeline: `parse params (parseQueryString) → sanitize (sanitizeQuery: defaults, limits, dynamic variables) → compile against the collection and the request's Access (unknown or ungranted fields, operators and value types are rejected here) → SQL + numbered binds`. The Access (§10) adds its row filter to every statement and turns fields granted on only some rows into `CASE WHEN … THEN "field" END`, in the SELECT list and wherever the request's filter, sort or search uses them.

- Identifiers: only names present in metadata, quoted as `"…"`.
- Values: always bind parameters.
- Writes: `INSERT … SELECT … FROM json_each(?1) RETURNING pk` for creates; `UPDATE`/`DELETE … WHERE pk IN (…) RETURNING pk`, where `…` is a key, a JSON list of keys, or the keys a query selects (with its sort, limit and offset, as in Directus).
- Relational paths compile to subqueries correlated with the row they start from (each related table under an alias such as `"_r1"`, which no collection name can be; the statement's own columns are qualified with its table name, so subqueries can refer to them): an M2O column is a scalar subquery on the related item (LEFT JOIN semantics, also for `sort=author.name`), an O2M filter is `EXISTS`. Sorting through an O2M is `INVALID_QUERY`: it would repeat items.
- Relational fields (`read.ts`, ADR-022): each one is one more statement in the read's batch, selecting the related items of the rows the statement before it returns. That parent selection is repeated as a subquery (`WHERE "author_id" IN (SELECT … ORDER BY … LIMIT …)`) rather than passed as keys, so the whole read is one round trip and one consistent snapshot, and related rows are merged in the app, so items are never repeated the way a JOIN would. O2M items are limited per parent (`deep` `_limit`, default `QUERY_LIMIT_DEFAULT`, as in Directus) with `ROW_NUMBER() OVER (PARTITION BY fk …)`, ordered by `_sort`, else the relation's `sort_field`, else the key. Hidden columns carry what merging needs (`_key`, `_parent`, `_m0`, …; field names start with a letter, so they never collide).
- Each related collection is read with the request's read access to it: its row filter, its granted fields (`*` expands to those), CASE WHEN for partially granted ones. An M2O the request may not read is null; an O2M alias granted on only some rows is null on the others. Relational fields that wildcards bring in are left out when the request may not read their collection; asking for one by name is FORBIDDEN.

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
- Keys that aren't columns are ignored, as in Directus; relational fields are nested writes (below).
- Specials: `uuid` (and UUID primary keys, ADR-007) get a UUIDv7 on create; `date-created` / `date-updated` are set on create / update; `user-created` / `user-updated` get the current user (null for public requests and `ADMIN_TOKEN`); `hash` fields (type or special) are hashed with PBKDF2-SHA256, 100 000 iterations (the most Workers allow), in PHC format; `conceal` fields read as `**********`.
- String fields with a `max_length` are checked (`VALUE_TOO_LONG`), since SQLite doesn't enforce lengths.
- The primary key can't be changed by an update.
- Constraint errors map to Directus codes: `RECORD_NOT_UNIQUE`, `NOT_NULL_VIOLATION` (with `collection` and `field`).
- Following Directus' processPayload, with permissions: the payload may only set fields the permission grants (`FORBIDDEN` with the field names otherwise), presets fill in what it leaves out, then field `meta.validation` rules (for everyone) and the permissions' `validation` must pass. Rules are filters checked in `packages/query/src/validate.ts` with the same value conversions as SQL filters: fields the payload leaves out pass, except with `_submitted`; `_regex` works here. Failures are `FAILED_VALIDATION` errors, one per failed rule, with Directus' messages and extensions (`field`, `type`, `valid`/`invalid`/`substring`). Hashing runs after validation. `meta.required` is enforced by the admin app, not the API, in Directus too.
- Nested writes (Directus' processM2O/processO2M), on every relation, system ones included (`roles.users`, `users.role`, …). An M2O given as an object: with the related key it updates that item (only the key: links it), without one it creates it, before the parent, which gets its key. An O2M: an array replaces the related items (keys link, objects with a key update, objects without one create; items no longer listed are deselected, deleted or unlinked as the relation's `one_deselect_action` says), or `{ create, update, delete }` changes them one by one. M2M is an O2M to the junction, whose items' M2O objects reach the other side (`{ "tags": [{ "tags_id": { "name": "new" } }] }`). Every related write is checked against the related collection's permissions, and everything runs in the parent's batch, at most 5 levels deep.
- New items whose auto-increment key nested writes need (their O2M items, or the M2O pointing at them) are inserted one at a time; the key is stashed in `cirrus_batch_keys` right after, and later statements read it from there (ADR-023). Other keys are known beforehand (UUIDv7 or given).
- M2O keys must reference items (relations with a schema, ADR-021): a guard per field checks every key the write sets, in the same batch; otherwise `INVALID_FOREIGN_KEY` with the `collection` and `field`. Keys of items the batch creates, and a nested O2M's link to its parent, need no check.

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
- A nested M2O object with a key updates that item, which must exist; Directus creates it with that key when it doesn't.
- `*` and `*.*` leave out relational fields whose collection the request may not read, rather than failing the read.
- A relational filter applies the related collection's read access (row filter and fields); filters can't reach items a read couldn't.
- Validation rules (`meta.validation`, permission `validation`) see the payload only, as in Directus: paths into related items pass.

## 9. Relations

Implemented in M4: `apps/api/src/schema/relations.ts` (payloads, changes), `apps/api/src/routes/relations.ts`, the relational parts of `packages/query` (`sql.ts`, `read.ts`, the guards and batch keys in `compile.ts`) and of the items service (`apps/api/src/items`).

| Type | Storage |
|---|---|
| M2O | a column on the "many" collection holding the related key + one `cirrus_relations` row |
| O2M | an alias field on the "one" collection, named by the M2O's relation (`one_field`) |
| M2M | a junction collection with two M2O relations, each naming the other field as `junction_field`; each side's alias is an O2M to the junction |
| M2A | later ❓ |

**API** (Directus shape): `GET /relations`, `/relations/:collection` (its M2O fields), `/relations/:collection/:field`; `POST /relations`, `PATCH` and `DELETE /relations/:collection/:field`, admin-only. A relation is `{ collection, field, related_collection, meta: { one_field, junction_field, sort_field, one_deselect_action, … }, schema }`. As in Directus, the field must exist first (and `one_field` must be an alias field of the related collection), its type must store keys like the related primary key (`integer` and `bigInteger` mix), and `schema: null` creates a relation nothing enforces; any other `schema` (or none) enforces it, with `on_delete` (`NO ACTION` by default, as a database foreign key). Non-admins see the relations whose fields they may read. Relations may point at user collections and at `directus_users`, `directus_roles`, `directus_policies`, `directus_files` and `directus_folders`; the system collections' own relations (`directus_users.role`, `directus_roles.users`, `directus_access.policy`, `directus_files.folder`, …) are defined in code and work in queries, but aren't listed, like the system collections themselves. Their tables' foreign keys keep them, except `directus_users.avatar`, which the items service keeps like user relations (ADR-026).

**Enforcement** (ADR-021): Cirrus keeps relations in the items service instead of SQLite foreign keys, in the same batch as the write:
- keys an M2O is set to must reference items: one guard statement per field (§8.6);
- deleting items applies `on_delete` to what points at them, as a database would: the doomed keys are stashed first (ADR-023), so every action and the delete see the same rows; `RESTRICT` fails when references exist, `CASCADE` deletes the referencing items (applying their own relations; self-references delete whole subtrees through a recursive CTE), `SET NULL` / `SET DEFAULT` reset the keys, and `NO ACTION` fails if references remain once the other actions ran. Failures are `INVALID_FOREIGN_KEY` with the referencing `collection` and `field`. Like a database's, these actions don't check the request's permissions. Cascades stop after 10 relations; deeper references fail the delete;
- creating a relation (or giving it a schema) over a column whose values reference nothing is `INVALID_FOREIGN_KEY`.

**Schema changes**, as in Directus: deleting an M2O field deletes its relation and the O2M alias on the other side; deleting an O2M alias leaves its relation without one; relations forget deleted junction and sort fields. Deleting a collection deletes its relations, the M2O fields of other collections pointing at it, and the aliases listing its items. A field holding keys can't change to a type the related key doesn't have.

**Queries:** relational `fields`, `filter`, `sort` and `deep` (§8.2–8.4); nested writes (§8.6).

---

## 10. Auth & permissions

Implemented in M3: `apps/api/src/auth` (login, refresh, logout), `apps/api/src/middleware/auth.ts` (tokens), `apps/api/src/request.ts` (accountability), `apps/api/src/access` (snapshot, permissions), and the permission checks in `apps/api/src/items/service.ts` and `packages/query` (`access.ts`, `compile.ts`, `validate.ts`).

**Auth**
- Email/password login (`POST /auth/login`), passwords hashed with PBKDF2-SHA256 via WebCrypto. Emails match ignoring case; an unknown email costs a hash check like a wrong password, so it doesn't reveal which emails exist. Suspended users are told so (`USER_SUSPENDED`) only once their password is right; other inactive users get `INVALID_CREDENTIALS`.
- Access tokens: HS256 JWTs signed with the `SECRET` secret, `ACCESS_TOKEN_TTL` (15 minutes), with Directus' claims `{ id, role, app_access, admin_access, iss: "directus" }`. Only `id` and `role` are trusted: each request recomputes policies and admin/app access from the current snapshot, so permission changes apply at once; a role change applies at the next refresh (ADR-017).
- Refresh tokens: 32 random bytes, `REFRESH_TOKEN_TTL` (7 days), stored in `cirrus_sessions` as their SHA-256. `POST /auth/refresh` replaces the token in one statement, so each works once; expired sessions and sessions of users no longer active are refused and removed. `POST /auth/logout` deletes the session. Modes: `json` (refresh token in the body), `cookie` (httpOnly `directus_refresh_token` cookie, `REFRESH_TOKEN_COOKIE_SECURE` / `_SAME_SITE` / `_DOMAIN`) and `session` (below).
- `session` mode (since M6; the admin app's): the session lasts `SESSION_COOKIE_TTL` (1 day), and the access token, as long, carries Directus' `session` claim naming it and is set as the httpOnly `directus_session_token` cookie (`SESSION_COOKIE_SECURE` / `_SAME_SITE` / `_DOMAIN`); the response is `{ data: { expires } }`. A request without a token is authenticated by that cookie, and every request with a session token checks that its session is still open, so logging out ends it at once. `POST /auth/refresh` with `mode: "session"` extends the session and sets a new cookie, keeping the session's token (ADR-027); `POST /auth/logout` ends it, even with an expired cookie. The cookie only counts for reads and for writes whose `Origin` is absent or this origin; one that doesn't check out (expired, logged out, another secret) is ignored, so the request is public rather than failing.
- Static tokens: `directus_users.token`, stored as its SHA-256 and read as `**********`; active users only.
- Login rate limiting: failed logins count per `LOGIN_RATE_LIMIT_DURATION` (15 minutes) against the client IP (`CF-Connecting-IP`; IPv6 clients by their /64) and email together (`LOGIN_RATE_LIMIT_IP_EMAIL`, 10), the IP (`LOGIN_RATE_LIMIT_IP`, 30) and the email (`LOGIN_RATE_LIMIT_EMAIL`, 100); `0` turns a limit off. A login over any of them is refused before its password is hashed, with Directus' `REQUESTS_EXCEEDED` (429, `limit` and `reset` in the extensions, and a `Retry-After` header), even when the password is right. A successful login gives its attempts back and starts the IP and email pair over (ADR-029).
- `ADMIN_TOKEN`: an optional static admin token without a user, to create the first users and as a way back in (ADR-013).
- Tokens arrive as `Authorization: Bearer` or `?access_token=`; a JWT with `iss: "directus"` is verified (`INVALID_TOKEN`, `TOKEN_EXPIRED`), anything else is looked up as a static token (`INVALID_CREDENTIALS`).
- Later: 2FA (`otp`, `enforce_tfa`), SSO/OAuth, password reset (needs email), a cron job deleting expired sessions.

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

Implemented in M5: `packages/files` (pure: the streaming multipart parser, image dimensions and Exif, MIME types, titles, transformation plans; tests run on Node), `apps/api/src/files` (R2 storage, the files service, assets), `apps/api/src/routes/files.ts`, and the system collections `directus_files` and `directus_folders` over `cirrus_files` and `cirrus_folders` (migration `0005`). The contents live in the R2 bucket bound as `STORAGE`, under `filename_disk`.

### 11.1 Endpoints

```
POST   /files                    upload (multipart/form-data), or a record without contents (JSON, needs `type`)
POST   /files/import             { url, data?, options?: { filterMimeType } }: fetch a URL, store it like an upload
PATCH  /files/:id                replace the contents (multipart/form-data), or update the record (JSON)
GET | SEARCH | PATCH | DELETE /files…    the items endpoints of directus_files; deletes also delete the contents
/folders…                        the items endpoints of directus_folders
GET    /assets/:id[/:filename]   the contents (and HEAD), possibly transformed
```

### 11.2 Uploads

- Multipart bodies are parsed as they arrive (`readMultipart()`), with the rules of Directus' busboy handler: fields describe the next file (fields after the last one are ignored); `"null"`, `"true"` and `"false"` are those values; a file without a name, or with a type `FILES_MIME_TYPE_ALLOW_LIST` doesn't allow, is `INVALID_PAYLOAD`, and so is a body without files ("No files were included in the body") or a malformed one. Several files answer a list, one an object.
- Each file is written to R2 while it is read (`ObjectWriter`): a single put when it fits in one part (8 MiB), otherwise an R2 multipart upload in equal parts, so a Worker holds at most a part in memory whatever the size (ADR-024). `FILES_MAX_UPLOAD_SIZE` (e.g. `100mb`) caps each file (`CONTENT_TOO_LARGE`, 413); without it the plan's request body limit applies (100 MB on Free and Pro). Storage failures are `SERVICE_UNAVAILABLE` (`service: "files"`).
- Then one batch writes the records of every file in the request through the items service (permissions, presets, validation, relations): all or nothing. When it fails, the stored objects are deleted. A request without create permission fails before anything is stored.
- The server sets what the upload determines. These values need no field permission, but validation sees them, so a permission can require `type` to start with `image/` or `filesize` to stay under a limit: `id` (a UUIDv7, unless the request gives one), `storage` (`r2`), `filename_disk`, `filesize`, `uploaded_on`, `type` (the part's Content-Type), and, unless the request sets them, `title` (`formatTitle()` of the name, a port of @directus/format-title), `filename_download`, `width`, `height` and `metadata`.
- Image details are read from the first bytes without decoding (`readImageMetadata()`; Workers have no sharp), for Directus' metadata types (JPEG, PNG, WebP, GIF, TIFF, AVIF): width and height as displayed (swapped for Exif orientations 5–8), and the Exif tags `FILE_METADATA_ALLOW_LIST` names (Directus' default: `ifd0.Make`, `ifd0.Model`, `exif.FNumber`, `exif.ExposureTime`, `exif.FocalLength`, `exif.ISOSpeedRatings`), as `{ ifd0: {…}, exif: {…} }`. IPTC, XMP and ICC aren't read.
- Object keys: Directus' `<id><ext>` when the id was just generated; otherwise (a replacement, or an id the request gives, which may be taken) `<id>-<random><ext>`, so a write that fails never touches another file's contents. Requests can't set `filename_disk` or another `storage` (`INVALID_PAYLOAD`): a record pointing at another file's object would serve that file.
- Replacing (`PATCH /files/:id` with one file) stores the new contents under a new key and updates the record (update permission on the row; the title stays, the image details are read again), reading the old key in the same batch; the old contents and their variants are deleted afterwards.
- `POST /files` with JSON creates records without contents (`filename_disk` null), as Directus' createOne; they need a `type`, and their assets are `FORBIDDEN`.
- Imports are fetched by the Worker (`http` and `https`, redirects followed): the name comes from the final URL, the type from its Content-Type (checked against the allow list and `options.filterMimeType`), the title is `formatTitle()` of the whole name, as in Directus. `data.id` naming an existing file replaces its contents. Unreachable URLs and answers other than 2xx are `SERVICE_UNAVAILABLE` (`service: "external-file"`).

### 11.3 Deleting, folders and relations

- Deleting files (by key, keys or query) runs through the items service, so relations pointing at them apply their `on_delete` (§9). The batch returns the deleted rows' `filename_disk`; their objects and variants are deleted once it has committed. A failure there only leaves unreferenced objects behind, and is logged.
- `directus_files.folder`, `uploaded_by` and `modified_by`, and `directus_folders.parent`, are kept by the tables' own foreign keys, as in Directus: deleting a folder clears its files' folder, a folder with subfolders can't be deleted (`INVALID_FOREIGN_KEY`), and deleting a user clears what they uploaded or modified.
- `directus_users.avatar` points at files without a foreign key (adding one would rebuild `cirrus_users`, ADR-021): the items service keeps it like user relations, so avatars must be files and deleting a file clears them (ADR-026).
- User collections may relate to `directus_files` and `directus_folders`: a post's cover image is a `uuid` field with a relation to `directus_files`, with any `on_delete`. Reads, filters and sorts reach through it (`cover.title`, `filter[cover][type][_starts_with]=image/`).

### 11.4 Assets

`GET /assets/:id` reads the id from the first 36 characters, as Directus does, so `/assets/<id>.jpg` works; `/assets/:id/:filename` sets the download name.
- Access: the request must be able to read the file's row (whatever fields; Directus validateItemAccess). The record is read as the server, in the same batch as that check. Malformed ids, files without contents and missing objects are `FORBIDDEN`. Tokens may come as `?access_token=`, for `<img src>`.
- Headers, as Directus': `Content-Type` (the file's type), `Content-Length`, `Content-Disposition` (`inline`, or `attachment` with `?download`; an ASCII name plus RFC 6266 `filename*` when it isn't one), `Accept-Ranges: bytes`, `Cache-Control: public|private, max-age=` `ASSETS_CACHE_TTL` (30 days), `Last-Modified` and `ETag` from `modified_on` (a variant's ETag adds its hash), `Vary: Origin, Cache-Control` (plus `Accept` when the format is negotiated). Also `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`, so uploaded HTML or SVG can't run scripts on the API's origin.
- `Range: bytes=a-b`, `a-` or `-n` (the first range when several are asked for) answers 206 with `Content-Range`; a range outside the file is `RANGE_NOT_SATISFIABLE` (416); other units are ignored. `If-None-Match` and `If-Modified-Since` answer 304. `HEAD` answers the headers without reading the object.

### 11.5 Image transformations

`?width`, `height`, `fit`, `format`, `quality`, `withoutEnlargement`, `focal_point_x`, `focal_point_y`, `key` (Directus' `system-*` presets; project presets wait for settings) and `transforms` (a JSON list of `[operation, …arguments]`, at most `ASSETS_TRANSFORM_MAX_OPERATIONS`, 5) are planned in `packages/files` (`planTransform()`, following Directus' resolvePreset) and run by Cloudflare Images through the `IMAGES` binding (ADR-025).
- Only JPEG, PNG, WebP and AVIF are transformed (Directus' list without TIFF, which the binding can't read); other files are served as they are, as in Directus. The dimensions must be known and at most `ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION` (6000) per side, else `ILLEGAL_ASSET_TRANSFORMATION`.
- sharp's fits become the binding's: `cover` → `cover` (centered on the focal point, as a `box-center` gravity), `contain` → `pad` (black, as sharp), `inside` → `contain`, `fill` → `squeeze`, `outside` → the size it computes; with one dimension the aspect ratio is kept. `withoutEnlargement` caps the size at the image's.
- `format`: `jpg`/`jpeg`, `png`, `webp`, `avif`, or `auto` (AVIF or WebP when `Accept` allows them, else Directus' fallback); `tiff` is `INVALID_QUERY`.
- `transforms` may use what the binding can do: `resize`, `extract`, `rotate` (by multiples of 90°), `flip`, `flop`, `blur`, `sharpen`, `modulate` (brightness, saturation), `greyscale`, `trim`, and the format operations (`toFormat`, `jpeg`, `png`, `webp`, `avif`). Other Directus operations are `INVALID_QUERY`.
- Each variant is made once and kept in R2 next to the original as `<name>__<hash><ext>` (Directus' naming), and deleted with it. Without the `IMAGES` binding, transformations are `INVALID_QUERY` ("Dynamic asset generation is disabled").

### 11.6 Differences from Directus

- Values the upload determines need no field permission (Directus' create permission must grant `type`, `title`, `storage` and `filename_download`), and validation sees the size and dimensions (Directus writes them afterwards, without checks).
- The files of one request are stored together: all or none (Directus writes each as it comes).
- Replacing a file reads its image details again (Directus keeps the old metadata, and the old dimensions of a replacement that isn't an image).
- `Cache-Control` is `public` for anonymous requests only; Directus also uses it for users without a role, who may have policies of their own.
- A range ending where it starts (`bytes=0-0`) is one byte; Directus refuses it. `withoutEnlargement=false` is false; Directus reads any value as true.
- Not yet: TUS resumable uploads, zip downloads (`POST /assets/files`, `/assets/folder/:id`), the presets and default folder of `directus_settings`, IPTC and XMP metadata.

---

## 12. Extensions: hooks, flows, realtime, cache

- **Sync hooks:** `items.create.before` / `after`, … run inside the request (validation, data transformation).
- **Async flows:** `items.*` events are pushed to a **Queue**; a consumer runs the operations (webhooks, email, item updates). Flow definitions live in system tables (`cirrus_flows`, `cirrus_operations`).
- **Schedules:** Cron Triggers start flows on a schedule.
- **Realtime:** a Durable Object per collection; clients subscribe over WebSocket and the Items service publishes events after successful writes. WebSocket Hibernation keeps costs down.
- **Cache:** response cache for public `GET`s in KV/Cache API, invalidated per collection on writes.

---

## 13. Admin UI

Implemented in M6: `apps/admin`, a Vue 3 SPA (Vite, vue-router, `@directus/sdk`) with its own small components and styles (light and dark), in English. It uses the API exactly as any SDK client would (ADR-028).

**Serving.** Workers Static Assets serve the build under `/admin`, with the SPA fallback: Vite writes it to
`apps/admin/dist/admin/` and copies `index.html` to `dist/` for the fallback, rather than using
`assets.base_path`, which Cloudflare does not enable on every account; `run_worker_first: ["/*", "!/admin/*"]` sends every other path to the Worker, so the app's files never invoke it. `/` and `/admin` redirect to `/admin/`. `pnpm dev` and `pnpm run deploy` build the app first (`wrangler dev` refuses a missing assets directory); `pnpm dev:admin` runs Vite with hot reload on `/admin/`, proxying the API paths to `wrangler dev` with the Worker's `Origin`, so session-cookie writes pass the same-origin check.

**Session.** The app logs in in `session` mode (§10): it never holds a token, and `<img src="/assets/…">` is authenticated by the cookie. At start it tries one `refresh()` to pick up an earlier session; the SDK then refreshes before the token expires. A request failing with `INVALID_CREDENTIALS`, `TOKEN_EXPIRED` or `INVALID_TOKEN` leads back to the login, which returns to the page afterwards. Users need app access (`/policies/me/globals`); the settings module (data model, roles, policies) is for admins.

**Data model** (Settings, `/settings/data-model`). After login the app loads `/collections`, `/fields`, `/relations` and `/permissions/me`, and reloads them after every schema change.
- Collections: list, create (primary key: generated UUID, auto-increment integer or manual string; the Directus app's optional fields `status` (with the archive settings), `sort`, `date_created`, `user_created`, `date_updated`, `user_updated`; singleton), options (note, display template, sort field, singleton, hidden), delete.
- Fields: add, edit (note, required, read-only, hidden, width, choices, unique, default value), move up or down (`meta.sort`), delete. Kinds: text, long text, Markdown, whole and decimal number, toggle, dropdown, tags, date & time, date, JSON, image, file, many to one (optionally with the one to many on the other side), one to many (creating the key field on the other side), many to many, divider. A many to many creates a hidden junction collection (`posts_tags`, with an integer key and `posts_id`/`tags_id`) and its two relations (`one_deselect_action: delete`, `on_delete: CASCADE`), as the Directus app does. Types can't be changed; changing a default value rebuilds the table (§7.2), which the dialog says.
- Each change is a plan of API calls (`src/lib/builder.ts`), run in order; when a step fails, the steps before it are undone newest first, since the API has no transaction across requests. `apps/api/test/admin-plans.test.ts` runs the plans against the Worker and uses what they create.

**Content** (`/content`). The navigation lists the collections the user may read (not hidden, not folders).
- Lists: up to six columns (visible fields that fit in a cell; many to one and file fields show the related item's display template and thumbnail; dropdowns their choice's text), sorting by column, search, pages of 25 with `meta=filter_count` (read with a plain `fetch`, as the SDK keeps only `data`), selecting and deleting.
- Forms are built from the fields: their relation, else `meta.interface`, else the type's default (`interfaceOf()`): text inputs, text areas, JSON, dropdowns, tags, toggles, date and time inputs (timestamps shown in local time, sent in UTC), a picker for many to one, upload or library for files, lists for one to many and many to many (add existing items, remove). Display templates (`meta.display_template`, else a title-like field) name related items. A singleton opens its form directly.
- Saving sends only the fields that changed, as the Directus app does: many to one and file fields as keys, one to many as the list of related keys, many to many as the junction rows to keep (by key) and to create (`{ tags_id: key }`). Required fields (`meta.required`, which Directus checks in its app, not its API) and inputs their type can't take are checked first; validation errors from the API show at their fields.
- Permissions: Create follows `/permissions/me`; an item's form asks `/permissions/me/:collection/:key` whether that item may be updated and deleted (a policy may allow some items only, such as the user's own), and is read only, without Delete, when not. Fields the permission's `fields` leave out, read-only fields, keys and automatic fields (`date-created`, `user-updated`, …) are disabled; relations into collections the user may not read are left out of the form's `fields`.
- System collections are read at their own paths (`/users`, `/files`, …, never `/items/directus_*`) and named by their own templates (a user by their name, else their email, with their avatar), so many to one fields to users work like any other.
- Leaving a form with unsaved changes asks first (also on reload); Ctrl/⌘+S saves.

**Files** (`/files`). A folder tree (create, rename, delete folders without subfolders), a grid of thumbnails (`system-medium-cover`, falling back to the original when a transformation fails), search, paging, and uploads with a button or by dropping files (one request per file, into the open folder). A file's page shows a preview (image, video, audio) and its details, and edits its metadata and folder; it downloads, replaces and deletes the file.

**Users** (`/users`, since M7). The directory lists the users the user may read (everyone for admins, themselves by Directus' minimal app permissions), by role, with search and paging. A user's page edits their profile (avatar, names, email, title, location, description, tags), sign-in (a new password; a static token generated in the browser, shown once and stored by the API as its SHA-256) and access (status, role, and policies attached to the user directly). The avatar in the module bar opens one's own profile; whether it can be changed follows the permissions, as in Directus (the minimal app permissions only read it).

**Access** (Settings, since M7; admins).
- Roles: a tree (by `parent`) with their users and policies; a role's page edits its name, description, parent (only roles that make no cycle), and the policies attached to it (its `policies`: access rows kept by key, new ones as `{ policy }`), and lists its users, with a link creating a user in it.
- Policies: the public policy first, then by name, with what they give and how many roles and users have them. A policy's page edits its name, description, app access, admin access and IP ranges, lists the roles and users that have it, and holds its permissions: a matrix of collections (the data model's, then the system ones Cirrus serves) × create, read, update, delete, each none, all or custom. A cell opens the permission: no access, all access (`fields: ["*"]`, empty filter and validation), or custom: the items (a filter, with ready-made ones such as "items they created"), the fields, and for writes the validation and presets. Rows can be set to all or none at once. As in the Directus app, permission changes are saved at once, while the policy's own fields wait for Save. `share` isn't shown: Cirrus has no shares yet.

**Tests.** Unit tests (Vitest with happy-dom) cover the pure modules, the data model store and the field inputs. The end-to-end suite (`pnpm test:e2e`: Playwright in Chromium against `wrangler dev` on a fresh local state; its spec files run in order on one Worker) builds the posts/authors/tags model in the UI, creates, edits and deletes posts with a cover, an author and tags, uses the file library, and checks the session across reloads and logout; then (M7) gives a writer a policy limited to their own notes, through a role, with a static token, signs in as them to check what they can and can't do, and takes the access away. CI runs both.

**Later:** settings (project name, presets), inviting users and resetting passwords (need email), two-factor authentication, a filter builder for permissions (JSON for now), other layouts (cards, calendar), saved filters and bookmarks, rich text and Markdown editors with preview, creating related items from a form (only existing ones can be linked now), sorting by drag and drop, field groups and conditions, interface options beyond choices, translations, revisions.

---

## 14. Roadmap

Tracked as [GitHub milestones](https://github.com/1112145/cirrus/milestones).

| Milestone | Content | Done when |
|---|---|---|
| **M0 – Scaffold** ✅ | Monorepo, Hono Worker, D1 binding, system table migrations, CI | `wrangler dev` runs and tests pass (contract: `serverPing`/`serverInfo`/`serverHealth`) |
| **M1 – Schema** ✅ | Collections/fields API, DDL generator, schema snapshot | A `posts` collection can be created via the API |
| **M2 – Items** ✅ | Dynamic CRUD + filter/sort/fields/pagination | CRUD on `posts` with nested `_and/_or` filters |
| **M3 – Auth & RBAC** ✅ | Login, JWT, roles, policies, permissions + row-level | An "editor" role only sees its own posts |
| **M4 – Relations** ✅ | M2O, O2M, M2M + nested `fields`, relational filters, `deep`, nested writes, `on_delete` | `posts.author.name`, `posts.tags.*` |
| **M5 – Files** ✅ | Uploads streamed into R2, folders, assets (Range, cache headers), image transformations (Images binding) | A post can have a cover image |
| **M6 – Admin UI MVP** ✅ | Data model + Content + Files, served by the Worker; `session` auth mode | `posts` can be managed entirely through the UI |
| **M7 – Users & access** ✅ | User directory, roles, policies and permissions in the admin | An editor can be given access, limited to their own items, entirely through the UI |
| **M8+** | Flows (Queues), realtime (DO), cache, SDK; schema snapshots are done (§7.5) | — |

---

## 15. Risks & open questions

| # | Issue | Notes |
|---|---|---|
| R1 | Rebuilding large tables may be slow or hit time limits | Warn in the UI; consider chunked rebuilds via Queues |
| R2 | Schema snapshots drifting between isolates | Check `schema_version` in D1 on each request (one small, strongly consistent query) — ADR-012 |
| R3 | Deep relational queries causing N+1 / CPU cost | One statement per relational field, all in one batch (ADR-022); `MAX_RELATIONAL_DEPTH`; O2M items limited per parent. Each statement counts towards D1's queries per Worker invocation, so wide `*.*.*` reads can hit it |
| R7 | Relations are only as consistent as the code path that writes items (ADR-021) | Every item write goes through the items service, which there is no way around in the API; tests cover each write and delete path |
| R8 | R2 and D1 can't share a transaction: a Worker stopped between storing an upload and writing its record, or a failed delete of old contents, leaves objects nothing references | Never the other way round (records always point at stored objects, ADR-024); failures are logged. Later: a scheduled job deleting objects without a record |
| R9 | Imports fetch any public `http(s)` URL from the Worker | Workers can't reach private networks; only requests with create permission on `directus_files` can import |
| R4 | D1's single writer under concurrent writes | Acceptable for single-project; monitor latency |
| R5 | Combining row-level filters and field permissions across policies makes SQL complex (`CASE WHEN` per field) | One CASE per field and statement, sharing parameters; tested on SQLite in `packages/query` |
| R6 | Passwords guessed at the speed of PBKDF2 | ✅ Failed logins are limited per IP and email, per IP and per email (ADR-029). A botnet guessing one password stays under the per-IP limits: the email's limit (100 per 15 minutes) bounds it, at the cost of locking that email out while it lasts |
| Q1 | Vue or React for the admin UI? | ✅ Vue — ADR-006 |
| Q2 | Default ID: integer autoincrement or UUID? | ✅ UUID by default, integer selectable per collection — ADR-007 |
| Q3 | Directus SDK compatibility? | ✅ Yes (REST) — ADR-008, §17 |
| Q4 | Which image transform service? | ✅ The Cloudflare Images binding — ADR-025 |
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
| ADR-019 | System collections (`directus_users`, `directus_roles`, `directus_policies`, `directus_permissions`, `directus_access`, and since M5 `directus_files`, `directus_folders`) are defined in code over the `cirrus_*` tables and served by the items service, so queries, permissions, errors and nested writes behave as for user collections. They aren't listed in `/collections` yet | ✅ Accepted |
| ADR-020 | The public policy applies to requests without a user and to users without a role, as in Directus 11 (not to every request, as this document first said) | ✅ Accepted |
| ADR-021 | Relations are kept by the items service, not by SQLite foreign keys (this document first planned foreign keys). D1 runs every batch in a transaction, so `PRAGMA foreign_keys = OFF` is a no-op, and `defer_foreign_keys` only defers checks: when a table rebuild (§7.2) drops a referenced table, SQLite's implicit `DELETE` runs the children's `ON DELETE CASCADE` / `SET NULL` on every row (verified on workerd's D1). Adding or dropping a constraint would also need a rebuild. Instead, writes check the M2O keys they set with guard statements and deletes apply `on_delete` themselves, in the same batch (as permissions do, ADR-018); relations are metadata, so schema changes never touch data. The system tables keep their own foreign keys, which nothing rebuilds | ✅ Accepted |
| ADR-022 | Reads with relational fields run one statement per relational field in the same batch as the items, each repeating its parent selection as a subquery rather than receiving keys from a previous round trip: one round trip and one snapshot for any depth, at the cost of re-evaluating the parent query (SQLite materializes `IN (subquery)` once). O2M limits apply per parent, with `ROW_NUMBER()` | ✅ Accepted |
| ADR-023 | `cirrus_batch_keys` passes keys between statements of one batch: the keys a delete removes (so on_delete actions can't change which rows it removes) and the auto-increment keys of items a nested write creates (read back with `max(key)`, which AUTOINCREMENT makes the new row's). D1 serializes writes and a batch empties the table as its last statement, so it never holds rows outside a transaction | ✅ Accepted |
| ADR-024 | Uploads are streamed into R2 as they arrive, then their records are written in one D1 batch. The multipart parser is Cirrus' own (`packages/files`), since `formData()` buffers whole files in the Worker's 128 MB; R2 refuses streams of unknown length, so `ObjectWriter` stores a file that fits in one 8 MiB part with a put, and a larger one as a multipart upload in equal parts. Directus creates the record first and deletes it when the write fails; Cirrus stores first, under keys no other file can have, so the record write stays one atomic batch, with permissions and validation seeing the size and dimensions, and a failure only has to delete objects. Old contents are deleted after the batch that stops referencing them | ✅ Accepted |
| ADR-025 | Image transformations run on the Cloudflare Images binding (Q4), and each variant is kept in R2 next to its original, as Directus keeps them in storage. The binding reads the R2 stream directly, needs no zone or public URL (unlike Image Resizing through `fetch` with `cf.image`), and works on every plan; WebAssembly image libraries would strain the Worker's CPU and size limits. Directus' sharp parameters are translated (§11.5); operations the binding lacks are refused rather than ignored. Local development and tests use miniflare's binding, backed by sharp | ✅ Accepted |
| ADR-026 | `directus_users.avatar` → `directus_files` is kept by the items service, like user relations (ADR-021): adding a foreign key to `cirrus_users` would rebuild it, firing the cascades of the tables that reference it. The other relations of `cirrus_files` and `cirrus_folders` are their own foreign keys, created with the tables | ✅ Accepted |
| ADR-027 | `session` mode (the admin app's login) follows Directus: the access token, naming its session in a `session` claim, is an httpOnly cookie, and requests with it check that the session is still open (one indexed D1 read), so logout ends it at once. Unlike Directus, refreshing extends the session without rotating its token: the token never leaves the httpOnly cookie, and rotating without Directus' grace period (ADR-017) would log out every tab but one when several refresh at once. The cookie authenticates only requests without a token, and writes only when `Origin` is absent or this origin (against cross-site requests SameSite lets through); a cookie that doesn't check out is ignored rather than failing every request, logins included | ✅ Accepted |
| ADR-028 | The admin app is Vue 3 + vue-router + `@directus/sdk` with its own small components and CSS, no UI kit (about 75 KB of gzipped JS and CSS), and uses the API only as an SDK client would, so it exercises the compatibility Cirrus promises. Workers Static Assets serve it under `/admin` with `run_worker_first: ["/*", "!/admin/*"]`: same origin as the API (no CORS, the session cookie just works), and its files never invoke the Worker. Data model changes are plans of API calls, undone newest first when a step fails, since the API has no transactions across requests | ✅ Accepted |
| ADR-029 | Login rate limits are counters in D1 (`cirrus_login_attempts`), not the Workers rate limiting binding or a Durable Object: the binding counts per Cloudflare location and only in 10 or 60 second periods, and a Durable Object is one more thing to deploy for a small table. A login adds one attempt to each of its counters (IP and email, IP, email) in one batch before the password is checked; D1 runs batches one at a time, so concurrent guesses can't get past the limit. A successful login gives the attempts back, so the counts are failed logins. Fixed windows: expired rows are deleted by the next login. Directus' own `RATE_LIMITER_*` (every request, per IP) and the lockout setting (`auth_login_attempts`, which suspends the user) aren't followed: the first is a different feature, and the second lets anyone suspend an account | ✅ Accepted |
| ADR-030 | `POST /schema/apply` is declarative, not a replay of the diff's entries as Directus' is: the diff is applied to the current snapshot, the result is checked as a whole, and one batch writes the difference. D1 has no transactions across batches, so replaying entries through the services (one batch each) would leave a schema half applied when a later step fails, and a dropped column can't be undone. One batch needs no intermediate schemas: tables are dropped, created or changed by the migration planner, and metadata is written in one statement per table (rows as JSON, read with `json_each()`), so a large schema stays within D1's statements per invocation. Relations that change are deleted and inserted again with their ids, and new collections are grouped once they all exist, so no unique key or foreign key of the system tables clashes midway. The hash is a SHA-256 of the snapshot's collections, fields and relations | ✅ Accepted |

---

## 17. `@directus/sdk` compatibility

Goal: a client written as `createDirectus(url).with(rest()).with(authentication())` works against Cirrus unchanged, within the supported endpoints.

### 17.1 What must match

| Area | Requirement |
|---|---|
| Paths | Unchanged: `/items/:collection`, `/collections`, `/fields/:collection`, `/relations`, `/files`, `/folders`, `/assets/:id`, `/users`, `/users/me`, `/roles`, `/policies`, `/permissions`, `/permissions/me`, `/auth/*`, `/schema/snapshot`, `/schema/diff`, `/schema/apply`, `/server/info`, `/server/ping`, `/server/health` |
| Query params | Accept both JSON strings (`filter={…}`) and bracket syntax (`filter[status][_eq]=x`); `fields` and `sort` as comma-separated lists or arrays; minimal `deep` and `alias` support |
| Responses | Wrapped in `{ "data": … }`, with `meta` when requested |
| Errors | `{ "errors": [{ "message", "extensions": { "code" } }] }` using Directus codes (`FORBIDDEN`, `INVALID_CREDENTIALS`, `INVALID_PAYLOAD`, `RECORD_NOT_UNIQUE`, `TOKEN_EXPIRED`, …) and matching HTTP statuses |
| Auth | `POST /auth/login` → `{ data: { access_token, expires, refresh_token } }`; `POST /auth/refresh`, `POST /auth/logout`; `json`, `cookie` and `session` modes; static tokens via `Authorization: Bearer` or `?access_token=` |
| Schema endpoints | Directus shapes: field = `{ collection, field, type, meta: {…}, schema: {…} }`, collection = `{ collection, meta, schema }` |

### 17.2 Design consequences

- **Storage and API shape are separate layers.** `cirrus_fields` stays flat (§6); `apps/api/src/schema/meta.ts` (one spec per meta property: validation, default, column) and `directus.ts` convert to and from the `meta`/`schema` shape, so the internal model is not tied to the Directus format.
- **System collection names.** The SDK uses dedicated paths (`/users`, `/files`, …) rather than `/items/directus_users`, so the internal `cirrus_` prefix can stay. Relations pointing at users/files must still map `directus_users` ↔ `cirrus_users` and `directus_files` ↔ `cirrus_files`.
- **Error codes** live in one shared module; services throw errors with a standard `code` and the final middleware serializes them in Directus format.
- **Data types:** gradually add the common Directus types (`dateTime`, `timestamp`, `date`, `time`, `bigInteger`, `decimal`, `csv`, `hash`) to the mapping in §7.1.

### 17.3 Compatibility testing

- A **contract test** suite runs the real `@directus/sdk` 21.3.0 against the local Worker via `@cloudflare/vitest-plugin`.
- Each milestone adds tests for its endpoints: M0 → `serverPing`, `serverInfo`, `serverHealth`, error detection via `isDirectusError`; M1 → `createCollection`, `createField`, `readCollections`, `readCollection`, `readFields`, `readFieldsByCollection`, `readField`, `updateCollection`, `updateCollectionsBatch`, `updateField`, `updateFields`, `deleteField`, `deleteCollection`; M2 → `readItems`, `readItem`, `createItem`, `createItems`, `updateItem`, `updateItems`, `updateItemsBatch`, `deleteItem`, `deleteItems`, `readSingleton`, `updateSingleton`, `withSearch`; M3 → `login` (command and `authentication()`), `refresh`, `logout`, `readMe`, `updateMe`, `readUsers`, `readUser`, `createUser(s)`, `updateUser`, `deleteUser`, `readRoles`, `readRole`, `readRolesMe`, `createRole`, `updateRole`, `deleteRole`, `readPolicies`, `readPolicy`, `readPolicyGlobals`, `createPolicy`, `updatePolicy`, `deletePolicy`, `readPermissions`, `readPermission`, `readUserPermissions`, `readItemPermissions`, `createPermission(s)`, `updatePermission`, `deletePermission`, `readProviders`; M4 → `createRelation`, `readRelations`, `readRelationByCollection`, `readRelation`, `updateRelation`, `deleteRelation`, and `createItem`, `readItems`, `readItem`, `updateItem` with relational fields (object syntax), filters, sorts and `deep`; M5 → `uploadFiles`, `importFile`, `readFiles`, `readFile`, `updateFile` (JSON and `FormData`), `updateFiles`, `updateFilesBatch`, `deleteFile`, `deleteFiles`, `readAssetRaw`, `readAssetBlob`, `readAssetArrayBuffer` (with transformations), `createFolder(s)`, `readFolders`, `readFolder`, `updateFolder(s)`, `updateFoldersBatch`, `deleteFolder(s)`, and a relation to `directus_files` (a cover image); M6 → `authentication('session')` with a browser-like cookie jar: `login`, `readMe`, `refresh`, `logout`. The admin app itself is an SDK client, tested end to end (§13).
- With a real Directus available, send the same requests to both and compare response snapshots (ignoring ids and timestamps). The reference server uses the `directus/directus:11.17.4` image (not v12, which limits collections on the Core tier).
- `@directus/sdk` is MIT-licensed; the licensing limits apply only to the Directus server, not to using the SDK as a test client.

### 17.4 Out of compatibility scope (early phases)

GraphQL, `realtime()` (the Directus WebSocket protocol), revisions, translations, extensions, the Directus Flows UI format.
