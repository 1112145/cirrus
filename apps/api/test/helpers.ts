import { env, exports } from 'cloudflare:workers';

const BASE = 'http://cirrus.test';

/** Matches the ADMIN_TOKEN binding in vitest.config.ts. */
export const ADMIN_TOKEN = 'test-admin-token';

/** Call the Worker under test without going over the network. */
export const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(BASE + path, init));

/** fetch shim that lets @directus/sdk call the Worker directly. */
export const workerFetch: typeof fetch = (input, init) => exports.default.fetch(new Request(input, init));

/** JSON request, as admin unless another token (or null for none) is given. */
export const api = (method: string, path: string, body?: unknown, token: string | null = ADMIN_TOKEN) =>
  call(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? null : JSON.stringify(body),
  });

type ErrorBody = { errors: Array<{ message: string; extensions: { code: string; reason?: string } & Record<string, unknown> }> };

/** First error of a Directus error response. */
export const firstError = async (res: Response) => (await res.json<ErrorBody>()).errors[0]!;

/** CREATE statement SQLite stored for a table, or null when it doesn't exist. */
export const tableSql = async (name: string) =>
  (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first<{ sql: string }>())
    ?.sql ?? null;

export const tableColumns = async (name: string) =>
  (await env.DB.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>()).results.map((c) => c.name);

export const tableIndexes = async (name: string) =>
  (
    await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
      .bind(name)
      .all<{ name: string }>()
  ).results.map((r) => r.name);

export { BASE };
