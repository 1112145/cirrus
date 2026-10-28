# Cirrus

Headless CMS kiểu Directus chạy hoàn toàn trên Cloudflare (Workers + Hono, D1, R2, KV, Durable Objects, Queues).
REST API tương thích `@directus/sdk` 21.3.0 (Directus 11.17.4). Kiến trúc: xem `cirrus-architecture.md` trong project.

## Cấu trúc

```
apps/api/            Worker Hono
  src/               routes, middleware
  migrations/        D1 migrations cho system tables (cirrus_*)
  test/              test chạy trong workerd; test/contract/ dùng @directus/sdk thật
  wrangler.jsonc
packages/shared/     error codes kiểu Directus, UUIDv7
```

`packages/query`, `packages/schema` (M1–M2), `packages/sdk` và `apps/admin` (M6) được thêm khi tới milestone tương ứng.

## Bắt đầu

Yêu cầu Node 22+ và pnpm 10.

```bash
pnpm install
pnpm db:migrate:local      # tạo system tables trong D1 local
pnpm dev                   # http://localhost:8787/server/ping → pong
pnpm test                  # unit + contract test
pnpm typecheck
```

## Deploy lần đầu

```bash
cd apps/api
npx wrangler d1 create cirrus          # chép database_id vào wrangler.jsonc
pnpm db:migrate:remote
pnpm deploy
```

## Quy ước

- Mọi lỗi ném `CirrusError(code, message)` từ `@cirrus/shared`; middleware serialize ra `{ errors: [{ message, extensions: { code } }] }`.
- Primary key mặc định UUIDv7 (`uuidv7()` trong `@cirrus/shared`).
- Không nối chuỗi SQL từ input: identifier phải khớp metadata, value luôn là bind parameter.
- Mỗi endpoint mới cần có contract test trong `apps/api/test/contract/`.
- `compatibility_date` trong `wrangler.jsonc` không được vượt ngày mà workerd của `@cloudflare/vitest-plugin` hỗ trợ.

## Trạng thái

| Milestone | Trạng thái |
|---|---|
| M0 – Scaffold | ✅ |
| M1 – Schema (collections/fields) | ⏳ |
