import { type Context, Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { serveAsset } from '../files/assets.ts';
import { createRecords, deleteFile, deleteFiles, importFile, uploadFiles } from '../files/service.ts';
import { itemsContext } from '../items/context.ts';
import { type Key, parseKey, parseKeys } from '../items/payload.ts';
import { readMany, readOne, updateOne, validateQuery } from '../items/service.ts';
import { readJson } from '../middleware/body.ts';
import { requestContext } from '../request.ts';
import { itemRoutes, parseBatch, readBack, toQuery, urlQuery } from './item-routes.ts';

/**
 * Files, folders and assets (spec §11), at their Directus paths. /files is the items endpoints of
 * directus_files, except that creating, replacing and deleting files also stores and deletes their
 * contents in R2.
 */

const context = (name: string) => async (c: Context<AppEnv>) => itemsContext(await requestContext(c), name, { system: true });
const filesContext = context('directus_files');

const isMultipart = (c: Context<AppEnv>) => (c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data');

/** The created or replaced files as the request's query reads them: one, or a list for several (Directus). */
async function readUploaded(c: Context<AppEnv>, keys: Key[]) {
  const ctx = await filesContext(c);
  const q = await urlQuery(c, ctx);
  return readBack(c, () => (keys.length > 1 ? readMany(ctx, keys, q) : readOne(ctx, keys[0]!, q)));
}

/**
 * SDK: uploadFiles, importFile, readFiles, readFile, updateFile (JSON or FormData), updateFiles,
 * updateFilesBatch, deleteFile, deleteFiles.
 */
export const files = new Hono<AppEnv>();

// Upload (multipart/form-data), or create records without contents (JSON, Directus createOne).
files.post('/', async (c) => {
  const ctx = await filesContext(c);
  validateQuery(ctx, await urlQuery(c, ctx));
  if (isMultipart(c)) return readUploaded(c, await uploadFiles(ctx, c.req.raw, null));
  const body = await readJson(c);
  return readUploaded(c, await createRecords(ctx, Array.isArray(body) ? body : [body]));
});

files.post('/import', async (c) => {
  const ctx = await filesContext(c);
  validateQuery(ctx, await urlQuery(c, ctx));
  return readUploaded(c, [await importFile(ctx, await readJson(c))]);
});

// Replace a file's contents (multipart/form-data), or update its record.
files.patch('/:pk', async (c) => {
  const ctx = await filesContext(c);
  validateQuery(ctx, await urlQuery(c, ctx));
  const key = parseKey(ctx, c.req.param('pk'));
  if (isMultipart(c)) return readUploaded(c, await uploadFiles(ctx, c.req.raw, key));
  return readUploaded(c, [await updateOne(ctx, key, await readJson(c))]);
});

files.delete('/', async (c) => {
  const ctx = await filesContext(c);
  const body = await readJson(c);
  if (Array.isArray(body)) {
    await deleteFiles(ctx, { keys: parseKeys(ctx, body) });
  } else {
    const batch = parseBatch(body);
    await deleteFiles(ctx, batch.keys ? { keys: parseKeys(ctx, batch.keys) } : { query: await toQuery(c.env, ctx, batch.query!) });
  }
  return c.body(null, 204);
});

files.delete('/:pk', async (c) => {
  const ctx = await filesContext(c);
  await deleteFile(ctx, parseKey(ctx, c.req.param('pk')));
  return c.body(null, 204);
});

// Reads, and updates of several records: as for any collection.
itemRoutes(files, '', filesContext);

/** SDK: readFolders, readFolder, createFolder(s), updateFolder(s), updateFoldersBatch, deleteFolder(s) */
export const folders = new Hono<AppEnv>();

itemRoutes(folders, '', context('directus_folders'));

/** SDK: readAssetRaw, readAssetBlob, readAssetArrayBuffer (GET, and HEAD). */
export const assets = new Hono<AppEnv>();

assets.get('/:pk/:filename?', serveAsset);
