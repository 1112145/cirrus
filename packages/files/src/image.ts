/**
 * Image dimensions and Exif metadata from the first bytes of a file, without decoding it (Workers
 * have no sharp): what Directus' getMetadata reports, for the formats it reads metadata of. Width
 * and height are as displayed: swapped when the Exif orientation rotates the image by 90°.
 */

/** Directus SUPPORTED_IMAGE_METADATA_FORMATS. */
export const METADATA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/avif'];

/** Directus' default FILE_METADATA_ALLOW_LIST: `<section>.<tag>` paths into the metadata. */
export const DEFAULT_METADATA_ALLOW_LIST: readonly string[] = [
  'ifd0.Make',
  'ifd0.Model',
  'exif.FNumber',
  'exif.ExposureTime',
  'exif.FocalLength',
  'exif.ISOSpeedRatings',
];

export type ImageMetadata = {
  width: number;
  height: number;
  /** The allowed Exif tags, by section (`ifd0`, `exif`) as Directus stores them; `{}` without any. */
  metadata: Record<string, Record<string, unknown>>;
};

/** Exif tags Cirrus reads, by section, with exif-reader's names (which Directus uses). */
const TAGS: Record<'ifd0' | 'exif', Record<number, string>> = {
  ifd0: {
    0x010f: 'Make',
    0x0110: 'Model',
    0x0112: 'Orientation',
    0x0131: 'Software',
    0x0132: 'DateTime',
    0x013b: 'Artist',
    0x8298: 'Copyright',
  },
  exif: {
    0x829a: 'ExposureTime',
    0x829d: 'FNumber',
    0x8822: 'ExposureProgram',
    0x8827: 'ISOSpeedRatings',
    0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized',
    0x920a: 'FocalLength',
    0xa405: 'FocalLengthIn35mmFormat',
    0xa433: 'LensMake',
    0xa434: 'LensModel',
  },
};

const EXIF_IFD = 0x8769;
const IMAGE_WIDTH = 0x0100;
const IMAGE_LENGTH = 0x0101;

type Tiff = { ifd0: Map<number, unknown>; exif: Map<number, unknown> };
type Found = { width: number; height: number; tiff: Tiff | null; rotated?: boolean };

/**
 * Dimensions and metadata of a JPEG, PNG, WebP, GIF, TIFF or AVIF image from its first bytes (the
 * more, the likelier a JPEG's frame header is among them); null when they aren't one of those, or
 * don't reach the dimensions.
 */
export function readImageMetadata(bytes: Uint8Array, allowList: readonly string[] = DEFAULT_METADATA_ALLOW_LIST): ImageMetadata | null {
  let found: Found | null;
  try {
    found = sniff(bytes);
  } catch {
    return null;
  }
  if (!found || !(found.width > 0) || !(found.height > 0)) return null;
  const orientation = found.tiff?.ifd0.get(0x0112);
  const swap = found.rotated || (typeof orientation === 'number' && orientation >= 5 && orientation <= 8);
  return {
    width: swap ? found.height : found.width,
    height: swap ? found.width : found.height,
    metadata: found.tiff ? pick(found.tiff, allowList) : {},
  };
}

function pick(tiff: Tiff, allowList: readonly string[]): Record<string, Record<string, unknown>> {
  const all = allowList.includes('*');
  const out: Record<string, Record<string, unknown>> = {};
  for (const section of ['ifd0', 'exif'] as const) {
    for (const [tag, value] of tiff[section]) {
      const name = TAGS[section][tag];
      if (!name || value === undefined) continue;
      if (!all && !allowList.includes(section) && !allowList.includes(`${section}.${name}`)) continue;
      (out[section] ??= {})[name] = value;
    }
  }
  return out;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

function sniff(b: Uint8Array): Found | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    return { width: v.getUint32(16), height: v.getUint32(20), tiff: null };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b, v);
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true), tiff: null };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b, v);
  if (b.length >= 8 && (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*')) {
    const tiff = readTiff(b, v, 0, b.length);
    const width = tiff?.ifd0.get(IMAGE_WIDTH);
    const height = tiff?.ifd0.get(IMAGE_LENGTH);
    return typeof width === 'number' && typeof height === 'number' ? { width, height, tiff } : null;
  }
  if (b.length >= 16 && ascii(b, 4, 4) === 'ftyp') return heif(b, v);
  return null;
}

/** Walk the JPEG markers to the frame header (SOFn), reading the Exif APP1 segment on the way. */
function jpeg(b: Uint8Array, v: DataView): Found | null {
  let tiff: Tiff | null = null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    // Fill bytes, and markers without a length.
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    // End of image or start of scan before any frame header.
    if (m === 0xd9 || m === 0xda) return null;
    const length = v.getUint16(i + 2);
    if (length < 2) return null;
    if (m === 0xe1 && !tiff && i + 10 <= b.length && ascii(b, i + 4, 6) === 'Exif\0\0') {
      tiff = readTiff(b, v, i + 10, Math.min(b.length, i + 2 + length));
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: v.getUint16(i + 5), width: v.getUint16(i + 7), tiff };
    }
    i += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array, v: DataView): Found | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    // Lossy: a key frame's start code, then 14-bit dimensions.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff, tiff: null };
  }
  if (chunk === 'VP8L') {
    // Lossless: a signature byte, then width - 1 and height - 1 in 14 bits each.
    if (b[20] !== 0x2f) return null;
    const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), tiff: null };
  }
  if (chunk === 'VP8X') {
    // Extended: canvas width - 1 and height - 1 in 24 bits each.
    const u24 = (at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
    return { width: 1 + u24(24), height: 1 + u24(27), tiff: null };
  }
  return null;
}

/**
 * AVIF (and other HEIF) images: the ISO BMFF item properties under meta/iprp/ipco. The largest
 * `ispe` (spatial extent) is the image (others are thumbnails or alpha planes); an `irot` by 90°
 * or 270° swaps the displayed dimensions.
 */
function heif(b: Uint8Array, v: DataView): Found | null {
  const brand = ascii(b, 8, 4);
  if (!['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'].includes(brand)) return null;
  const boxes = function* (start: number, end: number) {
    let i = start;
    while (i + 8 <= end) {
      let size = v.getUint32(i);
      const type = ascii(b, i + 4, 4);
      let header = 8;
      if (size === 1) {
        if (i + 16 > end) return;
        size = Number(v.getBigUint64(i + 8));
        header = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < header) return;
      yield { type, start: i + header, end: Math.min(end, i + size) };
      i += size;
    }
  };
  const child = (start: number, end: number, type: string) => {
    for (const box of boxes(start, end)) if (box.type === type) return box;
    return null;
  };
  const meta = child(0, b.length, 'meta');
  // meta is a full box: 4 bytes of version and flags before its children.
  const iprp = meta && child(meta.start + 4, meta.end, 'iprp');
  const ipco = iprp && child(iprp.start, iprp.end, 'ipco');
  if (!ipco) return null;
  let best: { width: number; height: number } | null = null;
  let rotated = false;
  for (const box of boxes(ipco.start, ipco.end)) {
    if (box.type === 'ispe' && box.start + 12 <= box.end) {
      const width = v.getUint32(box.start + 4);
      const height = v.getUint32(box.start + 8);
      if (!best || width * height > best.width * best.height) best = { width, height };
    } else if (box.type === 'irot' && box.start < box.end) {
      rotated = (b[box.start]! & 0x03) % 2 === 1;
    }
  }
  return best && { ...best, tiff: null, rotated };
}

const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/**
 * A TIFF structure (an Exif segment, or a TIFF file) starting at `start`: the tags of IFD0 and of
 * the Exif IFD it points to. Offsets are relative to `start`; anything past `end` is left out.
 */
function readTiff(b: Uint8Array, v: DataView, start: number, end: number): Tiff | null {
  if (start + 8 > end) return null;
  const order = ascii(b, start, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (at: number) => v.getUint16(at, le);
  const u32 = (at: number) => v.getUint32(at, le);
  if (u16(start + 2) !== 42) return null;

  const value = (entry: number): unknown => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = SIZES[type];
    if (!size || count === 0 || size * count > 64 * 1024) return undefined;
    const total = size * count;
    const at = total <= 4 ? entry + 8 : start + u32(entry + 8);
    if (at < start || at + total > end) return undefined;
    if (type === 2) {
      const raw = b.subarray(at, at + count);
      const nul = raw.indexOf(0);
      return new TextDecoder().decode(nul < 0 ? raw : raw.subarray(0, nul)).trim();
    }
    if (type === 1 || type === 7) return undefined;
    const list: number[] = [];
    for (let k = 0; k < count; k++) {
      const o = at + k * size;
      if (type === 3) list.push(u16(o));
      else if (type === 4) list.push(u32(o));
      else if (type === 9) list.push(v.getInt32(o, le));
      else if (type === 5) list.push(u32(o) / u32(o + 4));
      else list.push(v.getInt32(o, le) / v.getInt32(o + 4, le));
    }
    if (list.some((n) => !Number.isFinite(n))) return undefined;
    return count === 1 ? list[0] : list;
  };

  const ifd = (offset: number): Map<number, unknown> => {
    const tags = new Map<number, unknown>();
    const at = start + offset;
    if (offset < 8 || at + 2 > end) return tags;
    const n = u16(at);
    for (let k = 0; k < n; k++) {
      const entry = at + 2 + k * 12;
      if (entry + 12 > end) break;
      tags.set(u16(entry), value(entry));
    }
    return tags;
  };

  const ifd0 = ifd(u32(start + 4));
  const pointer = ifd0.get(EXIF_IFD);
  return { ifd0, exif: typeof pointer === 'number' ? ifd(pointer) : new Map() };
}
