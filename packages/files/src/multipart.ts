/**
 * A streaming multipart/form-data parser (RFC 7578), so uploads go to storage as they arrive
 * instead of being buffered in the Worker's memory: push() the body's chunks and act on the events
 * it returns, in order. Fields are collected whole (they are small); file contents come out as
 * `data` events between `file` and `end`, as views into the pushed chunks.
 */

export type MultipartEvent =
  | { type: 'field'; name: string; value: string }
  | { type: 'file'; name: string; filename: string; mimeType: string }
  | { type: 'data'; chunk: Uint8Array }
  | { type: 'end' };

export type MultipartLimits = {
  /** Bytes of one part's header block. */
  headerSize: number;
  /** Bytes of one field's value. */
  fieldSize: number;
  /** Parts (fields and files). */
  parts: number;
};

const DEFAULT_LIMITS: MultipartLimits = { headerSize: 16 * 1024, fieldSize: 1024 * 1024, parts: 1000 };

/** The body isn't valid multipart/form-data, or goes over a limit. */
export class MultipartError extends Error {
  override name = 'MultipartError';
}

const CR = 13;
const LF = 10;
const DASH = 45;
const EMPTY = new Uint8Array(0);
const CRLF = Uint8Array.of(CR, LF);
const HEADER_END = Uint8Array.of(CR, LF, CR, LF);
const decoder = new TextDecoder();

/** The boundary of a multipart/form-data Content-Type; null for other types. */
export function multipartBoundary(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const { type, params } = parseHeaderValue(contentType);
  if (type !== 'multipart/form-data') return null;
  const boundary = params.get('boundary');
  return boundary && boundary.length <= 200 ? boundary : null;
}

/**
 * A header value with parameters, like `form-data; name="a"; filename="b.png"`: the lowercased
 * value before the first `;`, and the parameters (names lowercased, first occurrence wins). Quoted
 * values may escape `"` and `\` with a backslash; other backslashes are kept, since browsers send
 * Windows paths unescaped.
 */
export function parseHeaderValue(value: string): { type: string; params: Map<string, string> } {
  const s = value;
  let i = s.indexOf(';');
  const type = (i < 0 ? s : s.slice(0, i)).trim().toLowerCase();
  const params = new Map<string, string>();
  const space = (k: number) => s[k] === ' ' || s[k] === '\t';
  while (i >= 0 && i < s.length) {
    i++;
    while (i < s.length && space(i)) i++;
    const eq = s.indexOf('=', i);
    const semi = s.indexOf(';', i);
    if (eq < 0 || (semi >= 0 && semi < eq)) {
      i = semi;
      continue;
    }
    const name = s.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    while (i < s.length && space(i)) i++;
    let v = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) i++;
        v += s[i];
        i++;
      }
      i = s.indexOf(';', i);
    } else {
      const end = s.indexOf(';', i);
      v = (end < 0 ? s.slice(i) : s.slice(i, end)).trim();
      i = end;
    }
    if (name && !params.has(name)) params.set(name, v);
  }
  return { type, params };
}

/** An RFC 5987 extended value (`UTF-8''na%C3%AFve.txt`); null when malformed. */
function extendedValue(v: string): string | null {
  const m = /^([\w!#$%&+^`{}~-]+)'[^']*'(.*)$/.exec(v);
  if (!m) return null;
  const charset = m[1]!.toLowerCase();
  try {
    if (charset === 'utf-8') return decodeURIComponent(m[2]!);
    if (charset === 'iso-8859-1') return unescape(m[2]!);
  } catch {
    return null;
  }
  return null;
}

/** The file name without any path a client sent with it. */
const basename = (name: string) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);

/** First position of `needle` in `haystack` at or after `from`; -1 when absent. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0]!;
  const last = haystack.length - needle.length;
  for (let i = haystack.indexOf(first, from); i >= 0 && i <= last; i = haystack.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** Length of the longest end of `haystack` that is the start of `needle` (it may continue in the next chunk). */
function partialMatch(haystack: Uint8Array, needle: Uint8Array): number {
  const start = Math.max(0, haystack.length - needle.length + 1);
  for (let i = haystack.indexOf(needle[0]!, start); i >= 0; i = haystack.indexOf(needle[0]!, i + 1)) {
    let j = 0;
    while (i + j < haystack.length && haystack[i + j] === needle[j]) j++;
    if (i + j === haystack.length) return haystack.length - i;
  }
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

type Part = { kind: 'file' } | { kind: 'field'; name: string; chunks: Uint8Array[]; size: number };

export class MultipartParser {
  readonly #delimiter: Uint8Array;
  readonly #limits: MultipartLimits;
  /** Bytes not handled yet. Starts with the CRLF the first delimiter line lacks. */
  #buffer: Uint8Array = CRLF;
  #state: 'preamble' | 'boundary' | 'headers' | 'body' | 'done' = 'preamble';
  #part: Part | null = null;
  #parts = 0;

  constructor(boundary: string, limits: Partial<MultipartLimits> = {}) {
    if (!boundary) throw new MultipartError('Missing multipart boundary');
    this.#delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Whether the closing boundary was seen; anything after it is ignored. */
  get done(): boolean {
    return this.#state === 'done';
  }

  /** Feed the next chunk of the body; returns the events it completes. */
  push(chunk: Uint8Array): MultipartEvent[] {
    if (this.#state === 'done' || chunk.length === 0) return [];
    this.#buffer = this.#buffer.length ? concat(this.#buffer, chunk) : chunk;
    return this.#run();
  }

  /** The body ended: throws unless its closing boundary was seen. */
  finish(): MultipartEvent[] {
    if (this.#state !== 'done') throw new MultipartError('Unexpected end of multipart body');
    return [];
  }

  #run(): MultipartEvent[] {
    const events: MultipartEvent[] = [];
    for (;;) {
      const buf = this.#buffer;
      switch (this.#state) {
        case 'preamble':
        case 'body': {
          const i = indexOfBytes(buf, this.#delimiter);
          if (i < 0) {
            // Keep what may be the start of a delimiter; the rest is content (or preamble).
            const keep = partialMatch(buf, this.#delimiter);
            if (this.#state === 'body') this.#data(buf.subarray(0, buf.length - keep), events);
            this.#buffer = buf.slice(buf.length - keep);
            return events;
          }
          if (this.#state === 'body') {
            this.#data(buf.subarray(0, i), events);
            this.#end(events);
          }
          this.#buffer = buf.subarray(i + this.#delimiter.length);
          this.#state = 'boundary';
          break;
        }
        case 'boundary': {
          // After a delimiter: `--` closes the body; otherwise optional padding, then CRLF.
          if (buf.length < 2) return events;
          if (buf[0] === DASH && buf[1] === DASH) {
            this.#state = 'done';
            this.#buffer = EMPTY;
            return events;
          }
          let j = 0;
          while (j < buf.length && (buf[j] === 32 || buf[j] === 9)) j++;
          if (j + 2 > buf.length) {
            if (j > 256) throw new MultipartError('Malformed multipart boundary');
            return events;
          }
          if (buf[j] !== CR || buf[j + 1] !== LF) throw new MultipartError('Malformed multipart boundary');
          this.#buffer = buf.subarray(j + 2);
          this.#state = 'headers';
          break;
        }
        case 'headers': {
          let end: number;
          let skip = 4;
          if (buf.length >= 2 && buf[0] === CR && buf[1] === LF) {
            end = 0;
            skip = 2;
          } else {
            end = indexOfBytes(buf, HEADER_END);
          }
          if (end < 0) {
            if (buf.length > this.#limits.headerSize) throw new MultipartError('Multipart headers are too large');
            return events;
          }
          if (end > this.#limits.headerSize) throw new MultipartError('Multipart headers are too large');
          this.#start(decoder.decode(buf.subarray(0, end)), events);
          this.#buffer = buf.subarray(end + skip);
          this.#state = 'body';
          break;
        }
        case 'done':
          return events;
      }
    }
  }

  #start(headerBlock: string, events: MultipartEvent[]) {
    if (++this.#parts > this.#limits.parts) throw new MultipartError('Too many parts in multipart body');
    const headers = new Map<string, string>();
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
    }
    const disposition = headers.get('content-disposition');
    const { type, params } = parseHeaderValue(disposition ?? '');
    const name = params.get('name');
    if (type !== 'form-data' || name === undefined) throw new MultipartError('Multipart part without a form-data name');

    const extended = params.has('filename*') ? extendedValue(params.get('filename*')!) : null;
    const filename = extended ?? params.get('filename');
    if (filename === undefined) {
      this.#part = { kind: 'field', name, chunks: [], size: 0 };
      return;
    }
    this.#part = { kind: 'file' };
    const mimeType = parseHeaderValue(headers.get('content-type') ?? '').type || 'application/octet-stream';
    events.push({ type: 'file', name, filename: basename(filename), mimeType });
  }

  #data(chunk: Uint8Array, events: MultipartEvent[]) {
    const part = this.#part;
    if (!part || chunk.length === 0) return;
    if (part.kind === 'file') {
      events.push({ type: 'data', chunk });
      return;
    }
    part.size += chunk.length;
    if (part.size > this.#limits.fieldSize) throw new MultipartError(`Field "${part.name}" is too large`);
    // Copy: the chunk may be a view of a buffer that is kept as the next tail.
    part.chunks.push(chunk.slice());
  }

  #end(events: MultipartEvent[]) {
    const part = this.#part;
    this.#part = null;
    if (!part) return;
    if (part.kind === 'file') {
      events.push({ type: 'end' });
      return;
    }
    const bytes = part.chunks.length === 1 ? part.chunks[0]! : part.chunks.reduce(concat, EMPTY);
    events.push({ type: 'field', name: part.name, value: decoder.decode(bytes) });
  }
}

/**
 * The events of a multipart/form-data body, read as it arrives. The caller handles each event
 * (awaiting writes) before the next chunk is read, so memory stays bounded. Stopping early cancels
 * the body.
 */
export async function* readMultipart(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  limits: Partial<MultipartLimits> = {},
): AsyncGenerator<MultipartEvent> {
  const parser = new MultipartParser(boundary, limits);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(value);
      // The epilogue (anything after the closing boundary) isn't read.
      if (parser.done) break;
    }
    yield* parser.finish();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
