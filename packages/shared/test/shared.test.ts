import { describe, expect, it } from 'vitest';
import { CirrusError, isUuid, uuidv7, uuidv7Timestamp } from '../src/index.ts';

describe('uuidv7', () => {
  it('đúng format và version 7', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]!);
  });

  it('nhúng timestamp', () => {
    const t = Date.UTC(2026, 9, 28, 15, 0, 0);
    expect(uuidv7Timestamp(uuidv7(t))).toBe(t);
  });

  it('tăng dần kể cả trong cùng một millisecond', () => {
    const t = Date.now();
    const ids = Array.from({ length: 1000 }, () => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tăng dần theo thời gian', () => {
    const a = uuidv7(1_000_000);
    const b = uuidv7(1_000_001);
    expect(a < b).toBe(true);
  });
});

describe('CirrusError', () => {
  it('serialize theo format Directus', () => {
    const e = new CirrusError('FORBIDDEN', "You don't have permission to access this.");
    expect(e.status).toBe(403);
    expect(e.toBody()).toEqual({
      errors: [{ message: "You don't have permission to access this.", extensions: { code: 'FORBIDDEN' } }],
    });
  });

  it('giữ extensions bổ sung, code không bị ghi đè', () => {
    const e = new CirrusError('RECORD_NOT_UNIQUE', 'dup', { collection: 'posts', field: 'slug', code: 'X' });
    expect(e.toBody().errors[0]!.extensions).toEqual({ collection: 'posts', field: 'slug', code: 'RECORD_NOT_UNIQUE' });
  });
});
