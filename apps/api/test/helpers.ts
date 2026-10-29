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

/** JSON body of a 200 response; shows the error body when the status differs. */
export async function ok<T = any>(res: Response): Promise<{ data: T; meta?: Record<string, number> }> {
  const text = await res.text();
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${text}`);
  return JSON.parse(text);
}

/** Status and error extensions of an error response. */
export const errorOf = async (res: Response) => ({ status: res.status, ...(await firstError(res)).extensions });

/** The Administrator role seeded by migration 0003. */
export const ADMIN_ROLE = '01a1857c-54d5-7148-8495-9e81c8a7caa5';
/** The public policy seeded by migration 0003 (Directus' id). */
export const PUBLIC_POLICY = 'abf8a154-5b1c-4a46-ac9c-7300570f4f17';

/** Create a user as admin; returns its id. */
export const createUser = async (user: Record<string, unknown>) => (await ok<{ id: string }>(await api('POST', '/users', user))).data.id;

/** Log in (json mode); returns the token pair. */
export async function login(email: string, password: string) {
  const { data } = await ok<{ access_token: string; refresh_token: string; expires: number }>(
    await api('POST', '/auth/login', { email, password, mode: 'json' }, null),
  );
  return data;
}
