import { CirrusError, invalidQuery } from '@cirrus/shared';

/**
 * Directus asset transformations (`/assets/:id?width=…`) → Cloudflare Images binding operations
 * (spec §11). Directus runs sharp; Workers have the Images binding instead, so the parameters are
 * translated: resizes with each `fit`, focal points, output formats and qualities, and the
 * `transforms` operations the binding can do. Pure: the Worker runs the plan.
 */

/** Directus ASSET_TRANSFORM_QUERY_KEYS. */
export const TRANSFORM_KEYS = [
  'key',
  'transforms',
  'width',
  'height',
  'format',
  'fit',
  'quality',
  'withoutEnlargement',
  'focal_point_x',
  'focal_point_y',
] as const;

/** Directus' (sharp's) fits. */
export const FITS = ['cover', 'contain', 'inside', 'outside', 'fill'] as const;
export type Fit = (typeof FITS)[number];

/** A sharp operation and its arguments, as in Directus' `transforms` parameter. */
export type Transformation = [string, ...unknown[]];

export type TransformParams = {
  key?: string;
  transforms?: Transformation[];
  width?: number;
  height?: number;
  format?: string;
  fit?: Fit;
  quality?: number;
  withoutEnlargement?: boolean;
  focal_point_x?: number;
  focal_point_y?: number;
};

/** Directus TransformationMethods: the operation names `transforms` may use. */
const METHODS = [
  'toFormat', 'jpeg', 'png', 'tiff', 'webp', 'avif', 'resize', 'extend', 'extract', 'trim', 'rotate', 'flip', 'flop',
  'sharpen', 'median', 'blur', 'flatten', 'gamma', 'negate', 'normalise', 'normalize', 'clahe', 'convolve', 'threshold',
  'linear', 'recomb', 'modulate', 'tint', 'greyscale', 'grayscale', 'toColorspace', 'toColourspace', 'removeAlpha',
  'ensureAlpha', 'extractChannel', 'bandbool',
];

/** Directus SYSTEM_ASSET_ALLOW_LIST: the presets the admin app uses for thumbnails. */
export const SYSTEM_PRESETS: Readonly<Record<string, TransformParams>> = {
  'system-small-cover': { format: 'auto', transforms: [['resize', { width: 64, height: 64, fit: 'cover' }]] },
  'system-small-contain': { format: 'auto', transforms: [['resize', { width: 64, fit: 'contain' }]] },
  'system-medium-cover': { format: 'auto', transforms: [['resize', { width: 300, height: 300, fit: 'cover' }]] },
  'system-medium-contain': { format: 'auto', transforms: [['resize', { width: 300, fit: 'contain' }]] },
  'system-large-cover': { format: 'auto', transforms: [['resize', { width: 800, height: 800, fit: 'cover' }]] },
  'system-large-contain': { format: 'auto', transforms: [['resize', { width: 800, fit: 'contain' }]] },
};

/** Directus SUPPORTED_IMAGE_TRANSFORM_FORMATS that the Images binding reads (it can't read TIFF). */
export const TRANSFORMABLE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/** One operation of the Images binding (its ImageTransform, the part Cirrus uses). */
export type ImageStep = {
  width?: number;
  height?: number;
  fit?: 'scale-down' | 'contain' | 'pad' | 'squeeze' | 'cover' | 'crop';
  gravity?: { x: number; y: number; mode: 'box-center' };
  background?: string;
  rotate?: 0 | 90 | 180 | 270;
  flip?: 'h' | 'v' | 'hv';
  blur?: number;
  sharpen?: number;
  brightness?: number;
  saturation?: number;
  trim?: 'border' | { top: number; left: number; width: number; height: number };
};

export type OutputType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';

/** What to do to an image: operations in order, then the output. */
export type ImagePlan = {
  steps: ImageStep[];
  type: OutputType;
  quality?: number;
  /** Extension of the generated file (with the dot): the output format's when one was asked for. */
  extension: string | null;
};

/** The file being transformed: what Directus' resolvePreset reads. */
export type TransformSource = {
  type: string | null;
  width: number | null;
  height: number | null;
  focal_point_x: number | null;
  focal_point_y: number | null;
};

const bad = (reason: string) => invalidQuery(reason);

/** Directus IllegalAssetTransformationError. */
const illegal = () => new CirrusError('ILLEGAL_ASSET_TRANSFORMATION', 'Illegal asset transformation.', { invalidTransformations: ['width', 'height'] });

const positiveInt = (name: string, raw: unknown): number => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw bad(`"${name}" must be a positive integer`);
  return n;
};

const number = (name: string, raw: unknown): number => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw bad(`"${name}" must be a number`);
  return n;
};

const quality = (raw: unknown): number => {
  const q = positiveInt('quality', raw);
  if (q > 100) throw bad('"quality" must be between 1 and 100');
  return q;
};

const fitOf = (raw: unknown): Fit => {
  if (!FITS.includes(raw as Fit)) throw bad(`"fit" must be one of ${FITS.join(', ')}`);
  return raw as Fit;
};

/**
 * The transformation parameters of an asset request; null when there are none. Checks them as
 * Directus does: `transforms` is a JSON array of known operations (at most `maxOperations`), and
 * `key` names a preset.
 */
export function parseTransformParams(query: URLSearchParams, opts: { maxOperations: number }): TransformParams | null {
  const present = TRANSFORM_KEYS.filter((k) => query.has(k));
  if (present.length === 0) return null;
  const get = (k: string) => query.get(k)!;
  const params: TransformParams = {};
  for (const k of present) {
    const raw = get(k);
    switch (k) {
      case 'key':
        if (!Object.hasOwn(SYSTEM_PRESETS, raw)) throw bad(`Key "${raw}" isn't configured`);
        params.key = raw;
        break;
      case 'transforms': {
        const reason = '"transforms" Parameter needs to be a JSON array of allowed transformations';
        let list: unknown;
        try {
          list = JSON.parse(raw);
        } catch {
          throw bad(reason);
        }
        if (!Array.isArray(list)) throw bad(reason);
        if (list.length > opts.maxOperations) throw bad(`"transforms" Parameter is only allowed ${opts.maxOperations} transformations`);
        for (const t of list) {
          const name = Array.isArray(t) ? t[0] : undefined;
          if (typeof name !== 'string' || !METHODS.includes(name)) {
            throw bad(`"transforms" Parameter does not allow "${String(name)}" as a transformation`);
          }
        }
        params.transforms = list as Transformation[];
        break;
      }
      case 'width':
      case 'height':
        params[k] = positiveInt(k, raw);
        break;
      case 'quality':
        params.quality = quality(raw);
        break;
      case 'fit':
        params.fit = fitOf(raw);
        break;
      case 'format':
        params.format = raw.toLowerCase();
        break;
      case 'withoutEnlargement':
        params.withoutEnlargement = raw !== 'false' && raw !== '0';
        break;
      case 'focal_point_x':
      case 'focal_point_y':
        params[k] = number(k, raw);
        break;
    }
  }
  return params;
}

/** Whether the request's parameters (with their preset) negotiate the format with the Accept header. */
export const negotiatesFormat = (params: TransformParams) => withPreset(params).format === 'auto';

const withPreset = (params: TransformParams): TransformParams => ({ ...(params.key ? SYSTEM_PRESETS[params.key] : {}), ...params });

const OUTPUTS: Record<string, OutputType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Directus getFormat: the format asked for (`auto`: by Accept), else the file's own. */
function formatOf(file: TransformSource, format: string | undefined, accept: string | null): string {
  const own = file.type?.split('/')[1];
  if (format) {
    if (format !== 'auto') return format;
    if (accept?.includes('image/avif')) return 'avif';
    if (accept?.includes('image/webp')) return 'webp';
    if (own && ['avif', 'webp', 'tiff'].includes(own)) return 'png';
  }
  return own || 'jpg';
}

function outputOf(format: string): OutputType {
  const type = OUTPUTS[format];
  if (!type) throw bad(`Format "${format}" isn't supported; use jpg, png, webp or avif`);
  return type;
}

type Size = { width: number; height: number };

/**
 * sharp's resize as Images binding operations. With one dimension the aspect ratio is kept,
 * whatever the fit; with both: cover crops (around the focal point, if any), contain letterboxes
 * (sharp's black background), inside fits within, outside covers without cropping, fill stretches.
 */
function resize(source: Size, w: number | undefined, h: number | undefined, fit: Fit, withoutEnlargement: boolean, focal: { x: number; y: number } | null): ImageStep {
  if (withoutEnlargement) {
    if (w !== undefined) w = Math.min(w, source.width);
    if (h !== undefined) h = Math.min(h, source.height);
  }
  if (w === undefined || h === undefined) return { ...(w ? { width: w } : {}), ...(h ? { height: h } : {}), fit: 'contain' };
  switch (fit) {
    case 'cover': {
      const step: ImageStep = { width: w, height: h, fit: 'cover' };
      if (focal) {
        const clamp = (n: number) => Math.min(1, Math.max(0, n));
        step.gravity = { x: clamp(focal.x / source.width), y: clamp(focal.y / source.height), mode: 'box-center' };
      }
      return step;
    }
    case 'contain':
      return { width: w, height: h, fit: 'pad', background: '#000000' };
    case 'inside':
      return { width: w, height: h, fit: 'contain' };
    case 'fill':
      return { width: w, height: h, fit: 'squeeze' };
    case 'outside': {
      const scale = Math.max(w / source.width, h / source.height);
      return { width: Math.round(source.width * scale), height: Math.round(source.height * scale), fit: 'squeeze' };
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const unsupported = (name: string) => bad(`The "${name}" transformation isn't supported`);

/** One `transforms` operation: steps to add, or an output format. */
function operation(t: Transformation, source: Size, out: { format?: string; quality?: number }): ImageStep | null {
  const [name, ...args] = t;
  const opts = isObject(args[0]) ? args[0] : {};
  switch (name) {
    case 'toFormat':
      out.format = String(args[0]).toLowerCase();
      if (isObject(args[1]) && args[1].quality !== undefined) out.quality = quality(args[1].quality);
      return null;
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'avif':
    case 'tiff':
      out.format = name;
      if (opts.quality !== undefined) out.quality = quality(opts.quality);
      return null;
    case 'resize': {
      // resize(options) or resize(width, height, options)
      const o = isObject(args[0]) ? args[0] : isObject(args[2]) ? args[2] : {};
      const w = isObject(args[0]) ? o.width : args[0];
      const h = isObject(args[0]) ? o.height : args[1];
      return resize(
        source,
        w == null ? undefined : positiveInt('width', w),
        h == null ? undefined : positiveInt('height', h),
        o.fit === undefined ? 'cover' : fitOf(o.fit),
        o.withoutEnlargement === true,
        null,
      );
    }
    case 'extract': {
      const region = ['left', 'top', 'width', 'height'].map((k) => {
        const n = number(k, opts[k]);
        if (!Number.isInteger(n) || n < 0) throw bad(`"${k}" must be a non-negative integer`);
        return n;
      });
      const [left, top, width, height] = region as [number, number, number, number];
      return { trim: { left, top, width, height } };
    }
    case 'rotate': {
      if (args[0] === undefined) return null; // auto-orientation, which the binding does anyway
      const angle = ((number('angle', args[0]) % 360) + 360) % 360;
      if (angle % 90 !== 0) throw bad('Images can only be rotated by multiples of 90 degrees');
      return { rotate: angle as 0 | 90 | 180 | 270 };
    }
    case 'flip':
      return { flip: 'v' };
    case 'flop':
      return { flip: 'h' };
    case 'blur':
      return { blur: args[0] === undefined || args[0] === true ? 1 : Math.min(250, Math.max(1, Math.round(number('sigma', args[0])))) };
    case 'sharpen': {
      const sigma = isObject(args[0]) ? args[0].sigma : args[0];
      return { sharpen: sigma === undefined ? 1 : Math.min(10, Math.max(0, number('sigma', sigma))) };
    }
    case 'modulate': {
      if (opts.hue !== undefined || opts.lightness !== undefined) throw bad('"modulate" only supports brightness and saturation');
      const step: ImageStep = {};
      if (opts.brightness !== undefined) step.brightness = number('brightness', opts.brightness);
      if (opts.saturation !== undefined) step.saturation = number('saturation', opts.saturation);
      return step;
    }
    case 'grayscale':
    case 'greyscale':
      return args[0] === false ? null : { saturation: 0 };
    case 'trim':
      return { trim: 'border' };
    default:
      throw unsupported(name);
  }
}

/**
 * What to do to a file for these parameters (Directus resolvePreset + getAsset); null to serve the
 * file as it is: no transformation asked for, or a type that can't be transformed. Throws
 * ILLEGAL_ASSET_TRANSFORMATION when the file's dimensions are unknown or over `maxDimension`.
 */
export function planTransform(
  params: TransformParams,
  file: TransformSource,
  opts: { accept: string | null; maxDimension: number },
): ImagePlan | null {
  const p = withPreset(params);
  const known = file.width && file.height ? { width: file.width, height: file.height } : null;
  const resizes = (p.width !== undefined || p.height !== undefined) && known !== null;
  const output = p.format !== undefined || p.quality !== undefined;
  if (!(p.transforms?.length || output || resizes)) return null;
  if (!file.type || !TRANSFORMABLE_TYPES.includes(file.type)) return null;
  if (!known || known.width > opts.maxDimension || known.height > opts.maxDimension) throw illegal();

  const out: { format?: string; quality?: number } = {};
  if (output) {
    out.format = formatOf(file, p.format, opts.accept);
    if (p.quality !== undefined) out.quality = p.quality;
  }
  const steps: ImageStep[] = [];
  for (const t of p.transforms ?? []) {
    const step = operation(t, known, out);
    if (step && Object.keys(step).length) steps.push(step);
  }
  if (resizes) {
    const fx = p.focal_point_x ?? file.focal_point_x;
    const fy = p.focal_point_y ?? file.focal_point_y;
    const focal = (p.fit === undefined || p.fit === 'cover') && fx != null && fy != null ? { x: fx, y: fy } : null;
    steps.push(resize(known, p.width, p.height, p.fit ?? 'cover', p.withoutEnlargement ?? false, focal));
  }
  const format = out.format ?? file.type.split('/')[1]!;
  return {
    steps,
    type: outputOf(format),
    ...(out.quality !== undefined ? { quality: out.quality } : {}),
    extension: out.format ? `.${out.format}` : null,
  };
}

/** A short, stable name for a plan, for the generated file's key (Directus: `<file>__<hash><ext>`). */
export async function planHash(plan: ImagePlan): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([plan.steps, plan.type, plan.quality ?? null])));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
