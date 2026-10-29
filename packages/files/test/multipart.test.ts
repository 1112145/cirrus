import { describe, expect, it } from 'vitest';
import { MultipartError, type MultipartEvent, MultipartParser, multipartBoundary, parseHeaderValue, readMultipart } from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Serialize FormData the way fetch does (undici), as bytes and a Content-Type. */
async function encode(form: FormData): Promise<{ bytes: Uint8Array; type: string }> {
  const req = new Request('http://x/', { method: 'POST', body: form });
  return { bytes: new Uint8Array(await req.arrayBuffer()), type: req.headers.get('content-type')! };
}

type Collected = Array<{ field: string; value: string } | { file: string; filename: string; mimeType: string; content: Uint8Array }>;

/** Run the parser over the body split into the given chunk sizes (cycled), and collect fields and files. */
function parse(bytes: Uint8Array, boundary: string, sizes: number[] = [bytes.length], limits = {}): Collected {
  const parser = new MultipartParser(boundary, limits);
  const events: MultipartEvent[] = [];
  let i = 0;
  let k = 0;
  while (i < bytes.length) {
    const n = Math.max(1, sizes[k++ % sizes.length]!);
    events.push(...parser.push(bytes.subarray(i, i + n)));
    i += n;
  }
  events.push(...parser.finish());
  return collect(events);
}

function collect(events: MultipartEvent[]): Collected {
  const out: Collected = [];
  let file: { file: string; filename: string; mimeType: string; chunks: Uint8Array[] } | null = null;
  for (const e of events) {
    if (e.type === 'field') out.push({ field: e.name, value: e.value });
    else if (e.type === 'file') file = { file: e.name, filename: e.filename, mimeType: e.mimeType, chunks: [] };
    else if (e.type === 'data') file!.chunks.push(e.chunk.slice());
    else {
      const content = new Uint8Array(file!.chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of file!.chunks) {
        content.set(c, o);
        o += c.length;
      }
      out.push({ file: file!.file, filename: file!.filename, mimeType: file!.mimeType, content });
      file = null;
    }
  }
  return out;
}

const raw = (s: string) => enc.encode(s.replace(/\n/g, '\r\n'));

describe('multipartBoundary / parseHeaderValue', () => {
  it('reads the boundary of multipart/form-data only', () => {
    expect(multipartBoundary('multipart/form-data; boundary=----abc')).toBe('----abc');
    expect(multipartBoundary('Multipart/Form-Data; charset=utf-8; boundary="a b"')).toBe('a b');
    expect(multipartBoundary('application/json')).toBeNull();
    expect(multipartBoundary('multipart/form-data')).toBeNull();
    expect(multipartBoundary(null)).toBeNull();
  });

  it('parses parameters, quoted values and escapes', () => {
    const { type, params } = parseHeaderValue('form-data; name="a\\"b"; filename="C:\\fake\\x.png"; flag; size=3');
    expect(type).toBe('form-data');
    expect(params.get('name')).toBe('a"b');
    expect(params.get('filename')).toBe('C:\\fake\\x.png');
    expect(params.get('size')).toBe('3');
  });
});

describe('MultipartParser', () => {
  it('parses fields and files serialized by fetch, whatever the chunking', async () => {
    const big = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    const form = new FormData();
    form.append('title', 'Hello wörld');
    form.append('folder', '');
    form.append('file', new File([big], 'photo.jpg', { type: 'image/jpeg' }));
    form.append('after', 'x');
    form.append('file', new File(['plain\r\n--text'], 'notes.txt', { type: 'text/plain' }));
    const { bytes, type } = await encode(form);
    const boundary = multipartBoundary(type)!;
    const expected = [
      { field: 'title', value: 'Hello wörld' },
      { field: 'folder', value: '' },
      { file: 'file', filename: 'photo.jpg', mimeType: 'image/jpeg', content: big },
      { field: 'after', value: 'x' },
      { file: 'file', filename: 'notes.txt', mimeType: 'text/plain', content: enc.encode('plain\r\n--text') },
    ];
    expect(parse(bytes, boundary)).toEqual(expected);
    expect(parse(bytes, boundary, [1])).toEqual(expected);
    expect(parse(bytes, boundary, [3, 1, 4096, 2, 17])).toEqual(expected);
  });

  it('finds delimiters split across chunks and keeps lookalikes in the content', () => {
    // Content holding CRs, partial delimiters and the boundary without its leading dashes.
    const content = '\r\r\n-\r\n--b\r\n--bound\r\n--boundar xboundary\r';
    const body = raw(`--boundary\nContent-Disposition: form-data; name="f"; filename="a.bin"\n\n`);
    const all = new Uint8Array([...body, ...enc.encode(content), ...raw('\n--boundary--\n')]);
    for (const sizes of [[1], [2], [5], [all.length]]) {
      const [file] = parse(all, 'boundary', sizes);
      expect(dec.decode((file as { content: Uint8Array }).content)).toBe(content);
    }
  });

  it('ignores the preamble and epilogue, and accepts padding after a boundary', () => {
    const body = raw('preamble\n--b  \nContent-Disposition: form-data; name="a"\n\n1\n--b\ncontent-disposition: form-data; name="b"\n\n2\n--b--\nepilogue');
    expect(parse(body, 'b')).toEqual([
      { field: 'a', value: '1' },
      { field: 'b', value: '2' },
    ]);
  });

  it('reads RFC 5987 file names, strips paths, and defaults the type', () => {
    const body = raw(
      `--b\nContent-Disposition: form-data; name="f"; filename="fallback.txt"; filename*=UTF-8''na%C3%AFve.txt\n\nx\n` +
        `--b\nContent-Disposition: form-data; name="g"; filename="C:\\fakepath\\pic.png"\n\ny\n--b--`,
    );
    const [a, b] = parse(body, 'b') as Array<{ filename: string; mimeType: string }>;
    expect(a!.filename).toBe('naïve.txt');
    expect(a!.mimeType).toBe('application/octet-stream');
    expect(b!.filename).toBe('pic.png');
  });

  it('treats an empty file name as a file', () => {
    const body = raw('--b\nContent-Disposition: form-data; name="f"; filename=""\nContent-Type: image/png\n\n\n--b--');
    expect(parse(body, 'b')).toEqual([{ file: 'f', filename: '', mimeType: 'image/png', content: new Uint8Array() }]);
  });

  it('rejects malformed bodies', () => {
    const fail = (s: string, limits = {}) => expect(() => parse(raw(s), 'b', [s.length], limits)).toThrow(MultipartError);
    // No closing boundary
    fail('--b\nContent-Disposition: form-data; name="a"\n\n1\n');
    // Nothing at all
    fail('no boundary here');
    // A part without a name
    fail('--b\nContent-Type: text/plain\n\n1\n--b--');
    // Garbage after a boundary
    fail('--b\nContent-Disposition: form-data; name="a"\n\n1\n--bX\n--b--');
    // Limits
    fail('--b\nContent-Disposition: form-data; name="a"\n\n12345\n--b--', { fieldSize: 4 });
    fail(`--b\nContent-Disposition: form-data; name="a"\nX-Long: ${'x'.repeat(100)}\n\n1\n--b--`, { headerSize: 64 });
    fail('--b\nContent-Disposition: form-data; name="a"\n\n1\n--b\nContent-Disposition: form-data; name="b"\n\n2\n--b--', { parts: 1 });
  });

  it('rejects a part without headers', () => {
    expect(() => parse(raw('--b\n\nx\n--b--'), 'b')).toThrow(MultipartError);
  });
});

describe('readMultipart', () => {
  it('reads a stream and stops at the closing boundary', async () => {
    const form = new FormData();
    form.append('a', '1');
    form.append('f', new File(['abc'], 'x.txt'));
    const req = new Request('http://x/', { method: 'POST', body: form });
    const boundary = multipartBoundary(req.headers.get('content-type'))!;
    const events: MultipartEvent[] = [];
    for await (const e of readMultipart(req.body!, boundary)) events.push(e);
    expect(collect(events)).toEqual([
      { field: 'a', value: '1' },
      { file: 'f', filename: 'x.txt', mimeType: 'application/octet-stream', content: enc.encode('abc') },
    ]);
  });

  it('fails on a truncated stream', async () => {
    const stream = new Blob([raw('--b\nContent-Disposition: form-data; name="a"\n\n1')]).stream();
    await expect(async () => {
      for await (const _ of readMultipart(stream, 'b'));
    }).rejects.toThrow(MultipartError);
  });
});
