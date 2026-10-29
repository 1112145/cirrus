import { authentication, createDirectus, queryToParams, rest } from '@directus/sdk';
import { isAuthError } from './lib/errors.ts';

/**
 * The API, through @directus/sdk, as any Directus client would use it. The app logs in in
 * `session` mode: the access token lives in an httpOnly cookie on this origin, so requests (and
 * `<img src="/assets/…">`) are authenticated without the app ever holding a token.
 */
// The app manages any collection: no static schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const client = createDirectus<any>(window.location.origin)
  .with(authentication('session', { credentials: 'include' }))
  .with(rest({ credentials: 'include' }));

type Command = Parameters<typeof client.request>[0];

let onAuthLost: () => void = () => {};

/** Called when a request fails because the session is gone (expired, logged out elsewhere). */
export const whenAuthLost = (cb: () => void) => {
  onAuthLost = cb;
};

/** Run an SDK command. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function request<T = any>(command: Command): Promise<T> {
  try {
    return (await client.request(command)) as T;
  } catch (e) {
    if (isAuthError(e)) onAuthLost();
    throw e;
  }
}

/**
 * A page of items with the number of matches: the SDK keeps only `data`, so lists read
 * `meta.filter_count` with a plain request (the session cookie authenticates it).
 */
export async function readPage<T = Record<string, unknown>>(path: string, query: Record<string, unknown>): Promise<{ data: T[]; total: number }> {
  const params = new URLSearchParams(queryToParams({ ...query, meta: 'filter_count' }) as Record<string, string>);
  const res = await fetch(`${path}?${params}`, { credentials: 'include', headers: { Accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as { data?: T[]; meta?: { filter_count?: number }; errors?: unknown };
  if (!res.ok) {
    const error = { errors: body.errors ?? [{ message: res.statusText, extensions: { code: null } }], response: res };
    if (isAuthError(error)) onAuthLost();
    throw error;
  }
  return { data: body.data ?? [], total: body.meta?.filter_count ?? body.data?.length ?? 0 };
}

export type AssetOptions = { key?: string; width?: number; height?: number; fit?: string; download?: boolean };

/** The URL of a file's contents, possibly transformed (the session cookie authenticates it). */
export function assetUrl(id: string, opts: AssetOptions = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === false) continue;
    params.set(k, v === true ? '' : String(v));
  }
  const query = params.toString().replace(/=(&|$)/g, '$1');
  return `/assets/${id}${query ? `?${query}` : ''}`;
}
