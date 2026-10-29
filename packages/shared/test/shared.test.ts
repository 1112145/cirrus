import { describe, expect, it } from 'vitest';
import { CirrusError, forbidden, invalidPayload, isUuid, uuidv7, uuidv7Timestamp } from '../src/index.ts';

describe('uuidv7', () => {
  it('has a valid format and version 7', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]!);
  });

  it('embeds the timestamp', () => {
    const t = Date.UTC(2026, 9, 28, 15, 0, 0);
    expect(uuidv7Timestamp(uuidv7(t))).toBe(t);
  });

  it('is increasing within the same millisecond', () => {
    const t = Date.now();
    const ids = Array.from({ length: 1000 }, () => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is increasing over time', () => {
    const a = uuidv7(1_000_000);
    const b = uuidv7(1_000_001);
    expect(a < b).toBe(true);
  });
});

describe('CirrusError', () => {
  it('serializes in Directus format', () => {
    const e = new CirrusError('FORBIDDEN', "You don't have permission to access this.");
    expect(e.status).toBe(403);
    expect(e.toBody()).toEqual({
      errors: [{ message: "You don't have permission to access this.", extensions: { code: 'FORBIDDEN' } }],
    });
  });

  it('keeps extra extensions without overriding code', () => {
    const e = new CirrusError('RECORD_NOT_UNIQUE', 'dup', { collection: 'posts', field: 'slug', code: 'X' });
    expect(e.toBody().errors[0]!.extensions).toEqual({ collection: 'posts', field: 'slug', code: 'RECORD_NOT_UNIQUE' });
  });
});

describe('error helpers', () => {
  it('invalidPayload follows the Directus message format', () => {
    expect(invalidPayload('Collection "posts" already exists').toBody()).toEqual({
      errors: [
        {
          message: 'Invalid payload. Collection "posts" already exists.',
          extensions: { reason: 'Collection "posts" already exists', code: 'INVALID_PAYLOAD' },
        },
      ],
    });
  });

  it('forbidden is a 403', () => {
    expect(forbidden().status).toBe(403);
  });
});
