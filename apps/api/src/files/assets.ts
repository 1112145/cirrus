import { extname, negotiatesFormat, parseTransformParams, type ImagePlan, planHash, planTransform } from '@cirrus/files';
import { selectItems, selectKeys, type Statement } from '@cirrus/query';
import { isUuidLike } from '@cirrus/schema';
import { CirrusError, forbidden, invalidQuery, parseDuration } from '@cirrus/shared';
import type { Context } from 'hono';
import type { AppEnv, Bindings } from '../env.ts';
import { itemsContext } from '../items/context.ts';
import { requestContext } from '../request.ts';
import { bucketOf, variantKey } from './storage.ts';

/**
 * GET /assets/:id (Directus' assets controller): a file's contents, for requests that may read the
 * file, with Range requests, conditional requests and cache headers; with transformation
 * parameters, an image made by the IMAGES binding and kept in R2 next to the original, so each
 * variant is made once.
 */

type FileRow = {
  id: string;
  filename_disk: string | null;
  filename_download: string;
  type: string | null;
  width: number | null;
  height: number | null;
  focal_point_x: number | null;
  focal_point_y: number | null;
  modified_on: string | null;
};

const FIELDS = ['id', 'filename_disk', 'filename_download', 'type', 'width', 'height', 'focal_point_x', 'focal_point_y', 'modified_on'];

const intVar = (v: string | undefined, fallback: number) => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v) : fallback);

/** ASSETS_CACHE_TTL in seconds: 30 days by default; "0" for none. */
const cacheTtl = (env: Bindings) => (/^\s*0+\s*[a-z]*\s*$/i.test(env.ASSETS_CACHE_TTL ?? '') ? 0 : Math.round(parseDuration(env.ASSETS_CACHE_TTL, 30 * 86_400_000) / 1000));

/**
 * The file, if the request may read it (Directus validateItemAccess: its row, whatever fields):
 * one batch reading the record (as the server) and checking the request's read access to it.
 */
async function readFile(c: Context<AppEnv>, id: string): Promise<FileRow> {
  const req = await requestContext(c);
  const ctx = await itemsContext(req, 'directus_files', { system: true });
  const access = ctx.access('read');
  const all = { filter: { id: { _eq: id } }, search: null, sort: null, limit: 1, offset: 0 };
  const statements: Statement[] = [selectItems(ctx.info, { fields: FIELDS, ...all })];
  if (access) statements.push(selectKeys(ctx.info, { key: id }, { restrict: access.filter, related: ctx.related }));
  const results = await ctx.db.batch(statements.map((s) => ctx.db.prepare(s.sql).bind(...s.params)));
  const row = results[0]!.results[0] as FileRow | undefined;
  if (!row || (access && results[1]!.results.length === 0)) throw forbidden();
  return row;
}

/** Content-Disposition with an ASCII file name and, when it differs, the UTF-8 one (RFC 6266). */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '?');
  const header = `${type}; filename="${ascii.replace(/[\\"]/g, '\\$&')}"`;
  if (ascii === filename) return header;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${header}; filename*=UTF-8''${encoded}`;
}

/** A single byte range of a `size`-byte file (the first, when several are asked for); null to send it all. */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(,|$)/i.exec(header);
  if (!m) return null;
  const [, from, to] = m;
  if (from === '' && to === '') return 'unsatisfiable';
  if (from === '') {
    const n = Math.min(Number(to), size);
    return n > 0 ? { offset: size - n, length: n } : 'unsatisfiable';
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

/** Whether the client's copy is current (If-None-Match, else If-Modified-Since). */
function notModified(request: Request, etag: string, modified: number | null): boolean {
  const tags = request.headers.get('if-none-match');
  if (tags) return tags.split(',').some((t) => ['*', etag, `W/${etag}`].includes(t.trim()));
  const since = request.headers.get('if-modified-since');
  if (!since || modified === null) return false;
  const t = Date.parse(since);
  return !Number.isNaN(t) && Math.floor(modified / 1000) <= Math.floor(t / 1000);
}

export async function serveAsset(c: Context<AppEnv>): Promise<Response> {
  const raw = c.req.param('pk') ?? '';
  // Directus reads the id from the first 36 characters, so `/assets/<id>.jpg` works too.
  const id = raw.substring(0, 36);
  if (!isUuidLike(id)) throw forbidden();
  const url = new URL(c.req.url);
  const params = parseTransformParams(url.searchParams, { maxOperations: intVar(c.env.ASSETS_TRANSFORM_MAX_OPERATIONS, 5) });
  const file = await readFile(c, id.toLowerCase());
  if (!file.filename_disk) throw forbidden();
  const bucket = bucketOf(c.env);
  const { accountability } = await requestContext(c);
  const accept = c.req.header('accept') ?? null;
  const plan = params
    ? planTransform(params, file, { accept, maxDimension: intVar(c.env.ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION, 6000) })
    : null;
  const hash = plan ? await planHash(plan) : null;

  const modified = file.modified_on ? Date.parse(file.modified_on) : NaN;
  const seconds = Number.isNaN(modified) ? null : Math.floor(modified / 1000);
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    // Anonymous requests may be cached by anyone; others only by the client (Directus: by role).
    'Cache-Control': `${accountability.user === null && !accountability.admin ? 'public' : 'private'}, max-age=${cacheTtl(c.env)}`,
    Vary: params && negotiatesFormat(params) ? 'Origin, Cache-Control, Accept' : 'Origin, Cache-Control',
    // Uploaded HTML or SVG must not run scripts on this origin.
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  const etag = seconds === null ? null : hash ? `"${seconds}-${hash}"` : `"${seconds}"`;
  if (etag) {
    headers.set('ETag', etag);
    headers.set('Last-Modified', new Date(modified).toUTCString());
  }
  const filename = c.req.param('filename') ?? file.filename_download ?? file.id;
  headers.set('Content-Disposition', contentDisposition(url.searchParams.has('download') ? 'attachment' : 'inline', filename));

  const head = c.req.raw.method === 'HEAD';
  if (etag && notModified(c.req.raw, etag, seconds === null ? null : modified)) {
    for (const h of ['Content-Disposition', 'Accept-Ranges']) headers.delete(h);
    return new Response(null, { status: 304, headers });
  }

  if (plan) {
    const { bytes, type } = await variant(c.env, bucket, file.filename_disk, plan, hash!);
    headers.set('Content-Type', type);
    headers.set('Content-Length', String(bytes.length));
    return new Response(head ? null : bytes, { headers });
  }

  headers.set('Content-Type', file.type || 'application/octet-stream');
  const rangeHeader = c.req.header('range') ?? null;
  if (head || rangeHeader) {
    const meta = await bucket.head(file.filename_disk);
    if (!meta) throw forbidden();
    const range = head ? null : parseRange(rangeHeader, meta.size);
    if (range === 'unsatisfiable') {
      throw new CirrusError('RANGE_NOT_SATISFIABLE', `Range "${rangeHeader}" is invalid or the file's size doesn't match the requested range.`, {
        range: rangeHeader,
      });
    }
    if (head || !range) {
      headers.set('Content-Length', String(meta.size));
      if (head) return new Response(null, { headers });
    } else {
      const object = await bucket.get(file.filename_disk, { range });
      if (!object) throw forbidden();
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
      headers.set('Content-Length', String(range.length));
      return new Response(object.body, { status: 206, headers });
    }
  }
  const object = await bucket.get(file.filename_disk);
  if (!object) throw forbidden();
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

/** The transformed image: from R2 when it was made before, else made by the IMAGES binding and kept. */
async function variant(env: Bindings, bucket: R2Bucket, original: string, plan: ImagePlan, hash: string): Promise<{ bytes: Uint8Array; type: string }> {
  const key = variantKey(original, hash, plan.extension ?? extname(original));
  const kept = await bucket.get(key);
  if (kept) return { bytes: new Uint8Array(await kept.arrayBuffer()), type: kept.httpMetadata?.contentType ?? plan.type };

  if (!env.IMAGES) throw invalidQuery('Dynamic asset generation is disabled for this project: it needs the IMAGES binding');
  const source = await bucket.get(original);
  if (!source) throw forbidden();
  let bytes: Uint8Array;
  let type: string;
  try {
    let image = env.IMAGES.input(source.body);
    for (const step of plan.steps) image = image.transform(step as ImageTransform);
    const result = await image.output({ format: plan.type, ...(plan.quality !== undefined ? { quality: plan.quality } : {}) });
    type = result.contentType();
    bytes = new Uint8Array(await result.response().arrayBuffer());
  } catch (e) {
    console.error(`Couldn't transform ${original}`, e);
    throw new CirrusError('ILLEGAL_ASSET_TRANSFORMATION', 'Illegal asset transformation.', { reason: e instanceof Error ? e.message : String(e) });
  }
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  return { bytes, type };
}
