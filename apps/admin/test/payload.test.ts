import { describe, expect, it } from 'vitest';
import { changes, isEmpty, keyOf, missingRequired, same } from '../src/lib/payload.ts';

describe('payload', () => {
  it('compares JSON values deeply', () => {
    expect(same({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(same([1, 2], [2, 1])).toBe(false);
    expect(same(null, {})).toBe(false);
  });

  it('keeps only the edits that change the item', () => {
    expect(changes({ title: 'a', tags: [1, 2] }, { title: 'a', tags: [1], body: null })).toEqual({ tags: [1], body: null });
  });

  it('reads keys of related values', () => {
    expect(keyOf({ id: 3, name: 'x' }, 'id')).toBe(3);
    expect(keyOf('abc', 'id')).toBe('abc');
    expect(keyOf(null, 'id')).toBeNull();
    expect(keyOf({ name: 'x' }, 'id')).toBeNull();
  });

  it('finds required fields left empty', () => {
    const fields = [
      { field: 'title', meta: { required: true } },
      { field: 'tags', meta: { required: true } },
      { field: 'body', meta: { required: false } },
      { field: 'secret', meta: { required: true } },
    ];
    expect(isEmpty('  ')).toBe(true);
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty(false)).toBe(false);
    expect(missingRequired(fields, { title: ' ', tags: [] }, true)).toEqual(['title', 'tags', 'secret']);
    // Updating: fields the item was read without aren't checked.
    expect(missingRequired(fields, { title: 'x', tags: [1] }, false)).toEqual([]);
    expect(missingRequired(fields, { title: null }, false)).toEqual(['title']);
  });
});
