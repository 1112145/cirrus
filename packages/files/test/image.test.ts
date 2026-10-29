import { describe, expect, it } from 'vitest';
import { readImageMetadata } from '../src/index.ts';

// Hand-built headers: just enough of each format for the reader.

const bytes = (...parts: Array<number[] | Uint8Array | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [...p])));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

const png = (w: number, h: number) => bytes([0x89], 'PNG\r\n\x1a\n', be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0]);
const gif = (w: number, h: number) => bytes('GIF89a', le16(w), le16(h), [0, 0, 0]);

type Entry = [tag: number, type: number, value: number | number[] | string];

/** A TIFF structure: IFD0 at 8, the Exif IFD (if any) at 512, out-of-line values from 1024. */
function tiff(ifd0: Entry[], exif: Entry[] | null = null, le = true): Uint8Array {
  const buf = new ArrayBuffer(4096);
  const v = new DataView(buf);
  const b = new Uint8Array(buf);
  b.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  let data = 1024;
  const write = (at: number, entries: Entry[]) => {
    v.setUint16(at, entries.length, le);
    entries.forEach(([tag, type, value], k) => {
      const e = at + 2 + k * 12;
      v.setUint16(e, tag, le);
      v.setUint16(e + 2, type, le);
      const list = typeof value === 'string' ? [...`${value}\0`].map((c) => c.charCodeAt(0)) : Array.isArray(value) ? value : [value];
      const size = type === 2 ? 1 : type === 3 ? 2 : type === 4 ? 4 : 8;
      const count = type === 5 ? list.length / 2 : list.length;
      v.setUint32(e + 4, count, le);
      let o = size * count <= 4 ? e + 8 : data;
      if (o === data) {
        v.setUint32(e + 8, data, le);
        data += size * count;
      }
      for (const n of list) {
        if (type === 2) b[o++] = n;
        else if (type === 3) (v.setUint16(o, n, le), (o += 2));
        else (v.setUint32(o, n, le), (o += 4));
      }
    });
  };
  write(8, exif ? [...ifd0, [0x8769, 4, 512]] : ifd0);
  if (exif) write(512, exif);
  return b.slice(0, data);
}

const exifEntries: Entry[] = [
  [0x829d, 5, [28, 10]],
  [0x829a, 5, [1, 60]],
  [0x8827, 3, 100],
  [0x920a, 5, [42, 10]],
  [0xa434, 2, 'Lens'],
];

function jpeg(w: number, h: number, exif: Uint8Array | null = null) {
  const app1 = exif ? bytes([0xff, 0xe1], be16(exif.length + 8), 'Exif\0\0', exif) : bytes();
  const jfif = bytes([0xff, 0xe0], be16(16), 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = bytes([0xff, 0xc2], be16(17), [8], be16(h), be16(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return bytes([0xff, 0xd8], jfif, app1, sof, [0xff, 0xda]);
}

describe('readImageMetadata', () => {
  it('reads PNG and GIF dimensions', () => {
    expect(readImageMetadata(png(640, 480))).toEqual({ width: 640, height: 480, metadata: {} });
    expect(readImageMetadata(gif(3, 7))).toEqual({ width: 3, height: 7, metadata: {} });
  });

  it('reads JPEG frame headers and the allowed Exif tags', () => {
    expect(readImageMetadata(jpeg(1200, 800))).toEqual({ width: 1200, height: 800, metadata: {} });
    const exif = tiff(
      [
        [0x010f, 2, 'Canon  '],
        [0x0110, 2, 'EOS'],
        [0x0112, 3, 1],
      ],
      exifEntries,
    );
    expect(readImageMetadata(jpeg(1200, 800, exif))).toEqual({
      width: 1200,
      height: 800,
      metadata: { ifd0: { Make: 'Canon', Model: 'EOS' }, exif: { FNumber: 2.8, ExposureTime: 1 / 60, FocalLength: 4.2, ISOSpeedRatings: 100 } },
    });
    expect(readImageMetadata(jpeg(1200, 800, exif), ['exif.LensModel', 'ifd0'])!.metadata).toEqual({
      ifd0: { Make: 'Canon', Model: 'EOS', Orientation: 1 },
      exif: { LensModel: 'Lens' },
    });
  });

  it('swaps dimensions for rotating Exif orientations, in either byte order', () => {
    for (const le of [true, false]) {
      const rotated = tiff([[0x0112, 3, 6]], null, le);
      expect(readImageMetadata(jpeg(1200, 800, rotated))).toMatchObject({ width: 800, height: 1200 });
      const mirrored = tiff([[0x0112, 3, 2]], null, le);
      expect(readImageMetadata(jpeg(1200, 800, mirrored))).toMatchObject({ width: 1200, height: 800 });
    }
  });

  it('reads WebP (lossy, lossless, extended)', () => {
    const riff = (chunk: string, payload: number[]) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], payload, new Array(16).fill(0));
    const vp8 = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(500), ...le16(300)]);
    expect(readImageMetadata(vp8)).toMatchObject({ width: 500, height: 300 });
    // VP8L: 14 bits of width - 1, then 14 bits of height - 1, little-endian.
    const w = 400 - 1;
    const h = 250 - 1;
    const bits = w | (h << 14);
    const vp8l = riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]);
    expect(readImageMetadata(vp8l)).toMatchObject({ width: 400, height: 250 });
    const vp8x = riff('VP8X', [0, 0, 0, 0, ...le24(1999), ...le24(999)]);
    expect(readImageMetadata(vp8x)).toMatchObject({ width: 2000, height: 1000 });
  });

  it('reads TIFF files', () => {
    const file = tiff([
      [0x0100, 4, 3000],
      [0x0101, 3, 2000],
      [0x010f, 2, 'Nikon'],
    ]);
    expect(readImageMetadata(file)).toEqual({ width: 3000, height: 2000, metadata: { ifd0: { Make: 'Nikon' } } });
  });

  it('reads AVIF item properties', () => {
    const box = (type: string, payload: number[]) => [...be32(8 + payload.length), ...bytes(type)];
    const full = (type: string, payload: number[]) => box(type, [0, 0, 0, 0, ...payload]).concat([0, 0, 0, 0, ...payload]);
    const plain = (type: string, payload: number[]) => box(type, payload).concat(payload);
    const ipco = plain('ipco', [...full('ispe', [...be32(160), ...be32(90)]), ...full('ispe', [...be32(1920), ...be32(1080)])]);
    const meta = full('meta', [...full('hdlr', new Array(20).fill(0)), ...plain('iprp', ipco)]);
    const avif = bytes(plain('ftyp', [...bytes('avif'), 0, 0, 0, 0, ...bytes('mif1')]), meta);
    expect(readImageMetadata(avif)).toEqual({ width: 1920, height: 1080, metadata: {} });
    const rotatedIpco = plain('ipco', [...full('ispe', [...be32(1920), ...be32(1080)]), ...plain('irot', [1])]);
    const rotated = bytes(plain('ftyp', [...bytes('avif'), 0, 0, 0, 0]), full('meta', plain('iprp', rotatedIpco)));
    expect(readImageMetadata(rotated)).toMatchObject({ width: 1080, height: 1920 });
  });

  it('returns null for other or truncated content', () => {
    expect(readImageMetadata(bytes('hello world, not an image'))).toBeNull();
    expect(readImageMetadata(png(640, 480).slice(0, 20))).toBeNull();
    expect(readImageMetadata(jpeg(10, 10).slice(0, 25))).toBeNull();
    expect(readImageMetadata(bytes([0xff, 0xd8, 0xff, 0xda]))).toBeNull();
    expect(readImageMetadata(png(0, 10))).toBeNull();
    expect(readImageMetadata(new Uint8Array())).toBeNull();
  });

  it('ignores Exif values pointing outside the bytes it has', () => {
    const exif = tiff([[0x010f, 2, 'A long make name']]);
    const cut = exif.slice(0, 30);
    expect(readImageMetadata(jpeg(8, 8, cut))).toEqual({ width: 8, height: 8, metadata: {} });
  });
});
