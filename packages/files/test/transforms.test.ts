import { isCirrusError } from '@cirrus/shared';
import { describe, expect, it } from 'vitest';
import { type ImagePlan, negotiatesFormat, parseTransformParams, planHash, planTransform, type TransformSource } from '../src/index.ts';

const params = (q: string) => parseTransformParams(new URLSearchParams(q), { maxOperations: 5 });

const jpeg: TransformSource = { type: 'image/jpeg', width: 1000, height: 500, focal_point_x: null, focal_point_y: null };
const opts: { accept: string | null; maxDimension: number } = { accept: null, maxDimension: 6000 };
/** The plan for a query string (typed as present; the tests check for null where it isn't). */
const plan = (q: string, file = jpeg, o = opts) => planTransform(params(q)!, file, o) as ImagePlan;

const errorOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (isCirrusError(e)) return { code: e.code, reason: e.extensions.reason };
    throw e;
  }
  throw new Error('expected an error');
};

describe('parseTransformParams', () => {
  it('is null without transformation parameters', () => {
    expect(params('download&foo=1')).toBeNull();
  });

  it('parses and checks each parameter', () => {
    expect(params('width=100&height=50&fit=inside&quality=80&format=WEBP&withoutEnlargement=true&focal_point_x=10')).toEqual({
      width: 100,
      height: 50,
      fit: 'inside',
      quality: 80,
      format: 'webp',
      withoutEnlargement: true,
      focal_point_x: 10,
    });
    expect(params('withoutEnlargement=false')).toEqual({ withoutEnlargement: false });
    expect(params('key=system-small-cover')).toEqual({ key: 'system-small-cover' });
    expect(params('transforms=[["blur",3],["flip"]]')).toEqual({ transforms: [['blur', 3], ['flip']] });
  });

  it('rejects bad values as Directus does', () => {
    expect(errorOf(() => params('width=0'))).toEqual({ code: 'INVALID_QUERY', reason: '"width" must be a positive integer' });
    expect(errorOf(() => params('width=abc')).code).toBe('INVALID_QUERY');
    expect(errorOf(() => params('quality=101')).code).toBe('INVALID_QUERY');
    expect(errorOf(() => params('fit=stretch')).code).toBe('INVALID_QUERY');
    expect(errorOf(() => params('key=nope'))).toEqual({ code: 'INVALID_QUERY', reason: 'Key "nope" isn\'t configured' });
    expect(errorOf(() => params('transforms=nope')).reason).toBe('"transforms" Parameter needs to be a JSON array of allowed transformations');
    expect(errorOf(() => params('transforms={}')).code).toBe('INVALID_QUERY');
    expect(errorOf(() => params('transforms=[["eval"]]')).reason).toBe('"transforms" Parameter does not allow "eval" as a transformation');
    expect(errorOf(() => params(`transforms=${JSON.stringify(new Array(6).fill(['flip']))}`)).reason).toBe(
      '"transforms" Parameter is only allowed 5 transformations',
    );
  });
});

describe('planTransform', () => {
  it('serves the file as it is when nothing changes it, or it can\'t be transformed', () => {
    expect(plan('focal_point_x=3')).toBeNull();
    expect(plan('width=100', { ...jpeg, type: 'application/pdf' })).toBeNull();
    expect(plan('width=100', { ...jpeg, type: 'image/gif' })).toBeNull();
    // Without known dimensions, a resize alone is skipped (Directus resolvePreset).
    expect(plan('width=100', { ...jpeg, width: null })).toBeNull();
  });

  it('needs known dimensions within the maximum', () => {
    expect(errorOf(() => plan('format=png', { ...jpeg, width: null })).code).toBe('ILLEGAL_ASSET_TRANSFORMATION');
    expect(errorOf(() => plan('width=10', { ...jpeg, width: 7000 })).code).toBe('ILLEGAL_ASSET_TRANSFORMATION');
  });

  it('resizes with each fit', () => {
    expect(plan('width=200')).toEqual({ steps: [{ width: 200, fit: 'contain' }], type: 'image/jpeg', extension: null });
    expect(plan('width=200&height=200').steps).toEqual([{ width: 200, height: 200, fit: 'cover' }]);
    expect(plan('width=200&height=200&fit=contain').steps).toEqual([{ width: 200, height: 200, fit: 'pad', background: '#000000' }]);
    expect(plan('width=200&height=200&fit=inside').steps).toEqual([{ width: 200, height: 200, fit: 'contain' }]);
    expect(plan('width=200&height=200&fit=fill').steps).toEqual([{ width: 200, height: 200, fit: 'squeeze' }]);
    // 1000x500 covering 200x200 without cropping: 400x200.
    expect(plan('width=200&height=200&fit=outside').steps).toEqual([{ width: 400, height: 200, fit: 'squeeze' }]);
    expect(plan('width=2000&height=100&withoutEnlargement').steps).toEqual([{ width: 1000, height: 100, fit: 'cover' }]);
  });

  it('crops around the focal point', () => {
    expect(plan('width=100&height=100&focal_point_x=250&focal_point_y=500').steps).toEqual([
      { width: 100, height: 100, fit: 'cover', gravity: { x: 0.25, y: 1, mode: 'box-center' } },
    ]);
    const withFocal = { ...jpeg, focal_point_x: 500, focal_point_y: 250 };
    expect(plan('width=100&height=100', withFocal).steps[0]!.gravity).toEqual({ x: 0.5, y: 0.5, mode: 'box-center' });
    expect(plan('width=100&height=100&fit=inside', withFocal).steps[0]!.gravity).toBeUndefined();
  });

  it('picks the output format and quality', () => {
    expect(plan('format=webp&quality=70')).toEqual({ steps: [], type: 'image/webp', quality: 70, extension: '.webp' });
    expect(plan('quality=50')).toEqual({ steps: [], type: 'image/jpeg', quality: 50, extension: '.jpeg' });
    expect(plan('format=jpg').type).toBe('image/jpeg');
    expect(plan('format=auto').type).toBe('image/jpeg');
    expect(plan('format=auto', jpeg, { ...opts, accept: 'image/avif,image/webp,*/*' }).type).toBe('image/avif');
    expect(plan('format=auto', jpeg, { ...opts, accept: 'image/webp,*/*' }).type).toBe('image/webp');
    expect(plan('format=auto', { ...jpeg, type: 'image/webp' }).type).toBe('image/png');
    expect(errorOf(() => plan('format=tiff')).code).toBe('INVALID_QUERY');
    expect(errorOf(() => plan('format=bmp')).code).toBe('INVALID_QUERY');
  });

  it('applies presets, with the request\'s parameters on top', () => {
    expect(negotiatesFormat(params('key=system-small-cover')!)).toBe(true);
    expect(plan('key=system-small-cover', jpeg, { ...opts, accept: 'image/webp' })).toEqual({
      steps: [{ width: 64, height: 64, fit: 'cover' }],
      type: 'image/webp',
      extension: '.webp',
    });
    expect(plan('key=system-medium-contain&format=png')).toEqual({ steps: [{ width: 300, fit: 'contain' }], type: 'image/png', extension: '.png' });
  });

  it('translates the transforms the binding supports', () => {
    const steps = (t: unknown[]) => plan(`transforms=${JSON.stringify(t)}`);
    expect(
      steps([['rotate', -90], ['flip'], ['flop'], ['blur', 2.4], ['sharpen', { sigma: 3 }]]).steps,
    ).toEqual([{ rotate: 270 }, { flip: 'v' }, { flip: 'h' }, { blur: 2 }, { sharpen: 3 }]);
    expect(steps([['modulate', { brightness: 1.2, saturation: 0.5 }], ['grayscale'], ['trim'], ['rotate']]).steps).toEqual([
      { brightness: 1.2, saturation: 0.5 },
      { saturation: 0 },
      { trim: 'border' },
    ]);
    expect(steps([['extract', { left: 1, top: 2, width: 30, height: 40 }]]).steps).toEqual([{ trim: { left: 1, top: 2, width: 30, height: 40 } }]);
    expect(steps([['resize', 200, 100, { fit: 'fill' }]]).steps).toEqual([{ width: 200, height: 100, fit: 'squeeze' }]);
    expect(steps([['resize', { width: 50 }]]).steps).toEqual([{ width: 50, fit: 'contain' }]);
    expect(steps([['toFormat', 'png', { quality: 60 }]])).toEqual({ steps: [], type: 'image/png', quality: 60, extension: '.png' });
    expect(steps([['webp', { quality: 30 }]])).toMatchObject({ type: 'image/webp', quality: 30 });
    expect(errorOf(() => steps([['rotate', 45]])).code).toBe('INVALID_QUERY');
    expect(errorOf(() => steps([['negate']])).reason).toBe('The "negate" transformation isn\'t supported');
    expect(errorOf(() => steps([['modulate', { hue: 90 }]])).code).toBe('INVALID_QUERY');
  });

  it('names plans by their content', async () => {
    const a = await planHash(plan('width=100'));
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(await planHash(plan('width=100'))).toBe(a);
    expect(await planHash(plan('width=101'))).not.toBe(a);
  });
});
