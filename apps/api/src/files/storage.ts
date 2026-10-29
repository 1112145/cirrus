import { stem } from '@cirrus/files';
import { CirrusError, contentTooLarge, isCirrusError } from '@cirrus/shared';
import type { Bindings } from '../env.ts';

/**
 * File contents in R2 (spec §11, ADR-024). Uploads are written as they arrive: a file that fits in
 * one part is a single put, a larger one an R2 multipart upload, so a Worker holds at most one part
 * in memory whatever the file's size. R2 needs every part but the last to have the same size, of
 * at least 5 MiB.
 */

export const PART_SIZE = 8 * 1024 * 1024;

/** Bytes kept from the start of each upload, to read image dimensions and Exif metadata. */
const HEAD_SIZE = 512 * 1024;

/** The bucket, or SERVICE_UNAVAILABLE when the Worker has no STORAGE binding. */
export function bucketOf(env: Bindings): R2Bucket {
  if (!env.STORAGE) throw new CirrusError('SERVICE_UNAVAILABLE', 'Files need the STORAGE R2 binding, which this Worker lacks.', { service: 'files' });
  return env.STORAGE;
}

/** Directus' error when storage fails: SERVICE_UNAVAILABLE, with the cause logged. */
async function saving<T>(key: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isCirrusError(e)) throw e;
    console.error(`Couldn't save file ${key}`, e);
    throw new CirrusError('SERVICE_UNAVAILABLE', `Service "files" is unavailable. Couldn't save file ${key}.`, { service: 'files', reason: `Couldn't save file ${key}` });
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.length === size) return chunks[0]!;
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export class ObjectWriter {
  readonly #bucket: R2Bucket;
  readonly #key: string;
  readonly #contentType: string;
  readonly #maxSize: number | null;
  readonly #partSize: number;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #size = 0;
  #head: Uint8Array[] = [];
  #headSize = 0;
  #upload: R2MultipartUpload | null = null;
  #parts: R2UploadedPart[] = [];

  constructor(bucket: R2Bucket, key: string, opts: { contentType: string; maxSize: number | null; partSize?: number }) {
    this.#bucket = bucket;
    this.#key = key;
    this.#contentType = opts.contentType;
    this.#maxSize = opts.maxSize;
    this.#partSize = opts.partSize ?? PART_SIZE;
  }

  get key(): string {
    return this.#key;
  }

  /** Add the next bytes; uploads a part whenever a whole one is buffered. CONTENT_TOO_LARGE past the maximum. */
  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    this.#size += chunk.length;
    if (this.#maxSize !== null && this.#size > this.#maxSize) throw contentTooLarge();
    if (this.#headSize < HEAD_SIZE) {
      const take = chunk.subarray(0, HEAD_SIZE - this.#headSize);
      this.#head.push(take);
      this.#headSize += take.length;
    }
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    while (this.#buffered >= this.#partSize) await this.#uploadPart(this.#take(this.#partSize));
  }

  /** The first `n` buffered bytes, as one array. */
  #take(n: number): Uint8Array {
    const out: Uint8Array[] = [];
    let need = n;
    while (need > 0) {
      const c = this.#chunks[0]!;
      if (c.length <= need) {
        out.push(c);
        this.#chunks.shift();
        need -= c.length;
      } else {
        out.push(c.subarray(0, need));
        this.#chunks[0] = c.subarray(need);
        need = 0;
      }
    }
    this.#buffered -= n;
    return concat(out, n);
  }

  async #uploadPart(part: Uint8Array) {
    await saving(this.#key, async () => {
      this.#upload ??= await this.#bucket.createMultipartUpload(this.#key, { httpMetadata: { contentType: this.#contentType } });
      this.#parts.push(await this.#upload.uploadPart(this.#parts.length + 1, part));
    });
  }

  /** Store what is left; returns the size and the first bytes (for metadata). */
  async finish(): Promise<{ size: number; head: Uint8Array }> {
    const rest = this.#take(this.#buffered);
    const upload = this.#upload;
    if (upload) {
      if (rest.length) await this.#uploadPart(rest);
      await saving(this.#key, () => upload.complete(this.#parts));
    } else {
      await saving(this.#key, () => this.#bucket.put(this.#key, rest, { httpMetadata: { contentType: this.#contentType } }));
    }
    return { size: this.#size, head: concat(this.#head, this.#headSize) };
  }

  /** Give up: drop the parts uploaded so far. */
  async abort(): Promise<void> {
    this.#chunks = [];
    this.#buffered = 0;
    await this.#upload?.abort().catch(() => {});
  }
}

/**
 * The key of a transformed image of the object at `key` (Directus: `<name>__<hash><ext>`), so the
 * object's variants share a prefix and go with it.
 */
export const variantKey = (key: string, hash: string, extension: string) => `${stem(key)}__${hash}${extension}`;

/**
 * Delete objects and their transformed variants. Called after the records are gone, so a failure
 * only leaves unreferenced objects behind; it is logged rather than failing the request.
 */
export async function removeObjects(bucket: R2Bucket, keys: ReadonlyArray<string | null | undefined>): Promise<void> {
  const all = new Set<string>();
  try {
    for (const key of keys) {
      if (!key) continue;
      all.add(key);
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: `${stem(key)}__`, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects) all.add(o.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    const list = [...all];
    // R2 deletes at most 1000 keys per call.
    for (let i = 0; i < list.length; i += 1000) await bucket.delete(list.slice(i, i + 1000));
  } catch (e) {
    console.error(`Couldn't delete stored files ${[...all].join(', ')}`, e);
  }
}
