import {
  DEFAULT_METADATA_ALLOW_LIST,
  formatTitle,
  METADATA_TYPES,
  mimeAllowed,
  MultipartError,
  multipartBoundary,
  parseBytes,
  readImageMetadata,
  readMultipart,
  stem,
  storageExtension,
} from '@cirrus/files';
import type { RowQuery } from '@cirrus/query';
import { CirrusError, invalidPayload, isPlainObject, uuidv7 } from '@cirrus/shared';
import type { Bindings } from '../env.ts';
import type { ItemsContext } from '../items/context.ts';
import { type Key, parseKey } from '../items/payload.ts';
import { createMany, deleteMany, deleteOne, updateOneWith } from '../items/service.ts';
import { STORAGE_LOCATION } from '../system/collections.ts';
import { bucketOf, ObjectWriter, removeObjects } from './storage.ts';

/**
 * Files (spec §11), following Directus' FilesService and files controller: uploads stream into R2
 * as they arrive, then one batch writes the records (with the request's permissions); on failure
 * the uploaded objects are deleted again. Deleting files deletes their objects once the records
 * are gone.
 */

export type FilesConfig = {
  maxSize: number | null;
  mimeAllowList: string[];
  metadataAllowList: string[];
};

const list = (v: string | undefined, fallback: readonly string[]) => {
  const items = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : [...fallback];
};

export const filesConfig = (env: Bindings): FilesConfig => ({
  maxSize: parseBytes(env.FILES_MAX_UPLOAD_SIZE),
  mimeAllowList: list(env.FILES_MIME_TYPE_ALLOW_LIST, ['*/*']),
  metadataAllowList: list(env.FILE_METADATA_ALLOW_LIST, DEFAULT_METADATA_ALLOW_LIST),
});

type Payload = Record<string, unknown>;

/** An uploaded object, waiting for its record: the request's values, and the server's (the new record's id among them). */
type Stored = { key: string; body: Payload; managed: Payload };

/** The record's key for a new upload: the one the payload gives, or a new UUIDv7 (`generated`). */
function newKey(ctx: ItemsContext, body: Payload): { id: string; generated: boolean } {
  if (body.id === undefined || body.id === null || body.id === '') return { id: uuidv7(), generated: true };
  return { id: String(parseKey(ctx, body.id)), generated: false };
}

/**
 * The object key of an upload. Contents are stored before their record is written, so the key
 * must be one no other file uses: Directus' `<id><ext>` when the id was just generated, else (a
 * replacement, or an id the request gives, which may be taken) with a random suffix, so a write
 * that fails never touches another file's contents.
 */
function objectKey(id: string, filename: string, type: string, fresh: boolean): string {
  const suffix = fresh ? '' : `-${uuidv7().slice(-12)}`;
  return `${id}${suffix}${storageExtension(filename, type)}`;
}

/**
 * What the server sets for an upload (Directus uploadOne): where the contents are, their size, and
 * for images their dimensions and Exif metadata, unless the payload sets those itself.
 */
function uploadValues(cfg: FilesConfig, body: Payload, now: Date, object: { key: string; type: string; size: number; head: Uint8Array }): Payload {
  const managed: Payload = { storage: STORAGE_LOCATION, filename_disk: object.key, filesize: object.size, uploaded_on: now.toISOString() };
  const image = METADATA_TYPES.includes(object.type) ? readImageMetadata(object.head, cfg.metadataAllowList) : null;
  for (const [field, value] of [
    ['width', image?.width ?? null],
    ['height', image?.height ?? null],
    ['metadata', image?.metadata ?? null],
  ] as const) {
    if (body[field] === undefined || body[field] === null) managed[field] = value;
  }
  return managed;
}

/**
 * Values the upload implies (Directus' multipart handler): the title from the file name (not for
 * replacements), the download name, and the type the client sent the file with. They are the
 * server's to set, so they need no field permission; the payload's own values win, except `type`.
 */
function impliedValues(body: Payload, filename: string, type: string, replacing: boolean): Payload {
  const out: Payload = { type };
  if (!replacing && !body.title) out.title = formatTitle(stem(filename));
  if (!body.filename_download) out.filename_download = filename;
  return out;
}

/** Multipart field values, as Directus reads them: "null", "true" and "false" are those values. */
function fieldValue(v: string): unknown {
  const t = v.trim();
  return t === 'null' ? null : t === 'true' ? true : t === 'false' ? false : v;
}

/**
 * Upload the files of a multipart/form-data request: create a file for each (fields before a file
 * describe it), or replace the contents of `replace`. Every file is stored before any record is
 * written, and the records are written in one batch: all or nothing.
 */
export async function uploadFiles(ctx: ItemsContext, request: Request, replace: Key | null): Promise<Key[]> {
  const boundary = multipartBoundary(request.headers.get('content-type'));
  if (!boundary || !request.body) throw invalidPayload('Expected a multipart/form-data body');
  const cfg = filesConfig(ctx.req.env);
  const bucket = bucketOf(ctx.req.env);
  // Fail before uploading anything when the request may not write files at all.
  ctx.access(replace === null ? 'create' : 'update');

  const stored: Stored[] = [];
  let fields: Payload = {};
  let current: { writer: ObjectWriter; body: Payload; filename: string; type: string; id: string } | null = null;
  try {
    for await (const e of readMultipart(request.body, boundary)) {
      if (e.type === 'field') {
        fields[e.name] = fieldValue(e.value);
      } else if (e.type === 'file') {
        if (!e.filename) throw invalidPayload('File is missing filename');
        if (!mimeAllowed(e.mimeType, cfg.mimeAllowList)) throw invalidPayload('File is of invalid content type');
        if (replace !== null && stored.length) throw invalidPayload('A file can only be replaced by one file');
        const { id, generated } = replace === null ? newKey(ctx, fields) : { id: String(replace), generated: false };
        const key = objectKey(id, e.filename, e.mimeType, generated);
        current = { writer: new ObjectWriter(bucket, key, { contentType: e.mimeType, maxSize: cfg.maxSize }), body: fields, filename: e.filename, type: e.mimeType, id };
        fields = {};
      } else if (e.type === 'data') {
        await current!.writer.write(e.chunk);
      } else {
        const { writer, body, filename, type, id } = current!;
        const { size, head } = await writer.finish();
        current = null;
        const managed = { ...impliedValues(body, filename, type, replace !== null), ...uploadValues(cfg, body, ctx.now, { key: writer.key, type, size, head }) };
        // The object key was made from the id, so the server sets it.
        if (replace === null) managed.id = id;
        stored.push({ key: writer.key, body, managed });
      }
    }
  } catch (e) {
    await current?.writer.abort();
    await removeObjects(bucket, stored.map((s) => s.key));
    if (e instanceof MultipartError) throw invalidPayload(e.message);
    throw e;
  }
  if (stored.length === 0) throw invalidPayload('No files were included in the body');
  return saveRecords(ctx, bucket, stored, replace);
}

/** Write the records of stored uploads; on failure, delete the objects. A replacement deletes the old contents. */
async function saveRecords(ctx: ItemsContext, bucket: R2Bucket, stored: Stored[], replace: Key | null): Promise<Key[]> {
  let previous: Payload | null;
  try {
    if (replace === null) return await createMany(ctx, stored.map((s) => s.body), stored.map((s) => s.managed));
    ({ previous } = await updateOneWith(ctx, replace, stored[0]!.body, { managed: stored[0]!.managed, previous: ['filename_disk'] }));
  } catch (e) {
    await removeObjects(bucket, stored.map((s) => s.key));
    throw e;
  }
  // The record points at the new contents now: the old ones can go.
  const old = previous?.filename_disk;
  if (typeof old === 'string' && old !== stored[0]!.key) await removeObjects(bucket, [old]);
  return [replace];
}

/** POST /files with JSON (Directus createOne): records without contents, which need a type. */
export async function createRecords(ctx: ItemsContext, bodies: unknown[]): Promise<Key[]> {
  for (const body of bodies) {
    if (isPlainObject(body) && !body.type) throw invalidPayload('"type" is required');
  }
  return createMany(ctx, bodies);
}

/**
 * Import a file from a URL (Directus importOne): fetched by the Worker and stored like an upload.
 * `data` describes it; with the `id` of an existing file, it replaces that file's contents.
 */
export async function importFile(ctx: ItemsContext, body: unknown): Promise<Key> {
  if (!isPlainObject(body)) throw invalidPayload('"url" is required');
  if (typeof body.url !== 'string' || body.url === '') throw invalidPayload('"url" is required');
  if (body.data !== undefined && !isPlainObject(body.data)) throw invalidPayload('"data" must be of type object');
  const options = body.options ?? {};
  if (!isPlainObject(options)) throw invalidPayload('"options" must be of type object');
  const filter = options.filterMimeType;
  if (filter !== undefined && !(Array.isArray(filter) && filter.every((p) => typeof p === 'string'))) {
    throw invalidPayload('"options.filterMimeType" must be an array of strings');
  }
  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    throw invalidPayload('"url" must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidPayload('"url" must be a http or https URL');

  const cfg = filesConfig(ctx.req.env);
  const bucket = bucketOf(ctx.req.env);
  const data: Payload = (body.data as Payload | undefined) ?? {};
  const existing = data.id !== undefined && data.id !== null ? await fileExists(ctx, parseKey(ctx, data.id)) : null;
  ctx.access(existing === null ? 'create' : 'update');

  const unavailable = () =>
    new CirrusError('SERVICE_UNAVAILABLE', `Service "external-file" is unavailable. Couldn't fetch file from URL "${body.url}".`, {
      service: 'external-file',
      reason: `Couldn't fetch file from URL "${body.url}"`,
    });
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    console.warn(`Couldn't fetch file from URL "${body.url}"`, e);
    throw unavailable();
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw unavailable();
  }
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  const reject = (scope: string) => invalidPayload(`File content type "${type}" is not allowed for upload by ${scope} file type restrictions`);
  try {
    if (!mimeAllowed(type, cfg.mimeAllowList)) throw reject('your global');
    if (filter?.length && !mimeAllowed(type, filter as string[])) throw reject("this field's");
  } catch (e) {
    await res.body.cancel();
    throw e;
  }

  let filename = new URL(res.url || url.href).pathname;
  filename = filename.slice(filename.lastIndexOf('/') + 1);
  try {
    filename = decodeURI(filename);
  } catch {
    // keep it encoded
  }
  const { id, generated } = existing === null ? newKey(ctx, data) : { id: existing, generated: false };
  const key = objectKey(id, filename, type, generated);
  const writer = new ObjectWriter(bucket, key, { contentType: type, maxSize: cfg.maxSize });
  let object: { size: number; head: Uint8Array };
  try {
    for await (const chunk of res.body) await writer.write(chunk);
    object = await writer.finish();
  } catch (e) {
    await writer.abort();
    await res.body.cancel().catch(() => {});
    throw e;
  }
  // Directus: the type, download name and title (from the whole name) the URL implies, unless `data` sets them.
  const implied: Payload = { type };
  if (data.filename_download === undefined) implied.filename_download = filename;
  if (data.title === undefined) implied.title = formatTitle(filename);
  const managed: Payload = { ...implied, ...uploadValues(cfg, data, ctx.now, { key, type, ...object }) };
  if (existing === null) managed.id = id;
  const [saved] = await saveRecords(ctx, bucket, [{ key, body: data, managed }], existing);
  return saved!;
}

/** The key, when a file with it exists (whatever the request may see: an import by id replaces it). */
async function fileExists(ctx: ItemsContext, key: Key): Promise<string | null> {
  const row = await ctx.db.prepare('SELECT id FROM cirrus_files WHERE id = ?1').bind(key).first<{ id: string }>();
  return row?.id ?? null;
}

/** Delete files by keys or query, then their objects. */
export async function deleteFiles(ctx: ItemsContext, target: { keys: Key[] } | { query: RowQuery }): Promise<void> {
  await removeContents(ctx, await deleteMany(ctx, target, ['filename_disk']));
}

export async function deleteFile(ctx: ItemsContext, key: Key): Promise<void> {
  await removeContents(ctx, await deleteOne(ctx, key, ['filename_disk']));
}

/** The objects of deleted files. Records without contents (JSON-created ones) need no bucket. */
async function removeContents(ctx: ItemsContext, rows: ReadonlyArray<Record<string, unknown>>) {
  const keys = rows.map((r) => r.filename_disk).filter((k): k is string => typeof k === 'string');
  if (keys.length === 0) return;
  if (!ctx.req.env.STORAGE) {
    console.error(`No STORAGE binding: couldn't delete stored files ${keys.join(', ')}`);
    return;
  }
  await removeObjects(ctx.req.env.STORAGE, keys);
}
