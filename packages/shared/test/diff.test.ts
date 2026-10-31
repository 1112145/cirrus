import { describe, expect, it } from 'vitest';
import { applyDiffEntry, deepDiff, isDiffEntry, sortKeysDeep } from '../src/index.ts';

const clone = <T>(v: T): T => structuredClone(v);

/** Apply every change of deepDiff(a, b) to a copy of a: it must give b. */
function roundTrip(a: Record<string, unknown>, b: Record<string, unknown>) {
  const target = clone(a);
  for (const change of deepDiff(a, b)) expect(applyDiffEntry(target, clone(change))).toBe(true);
  expect(target).toEqual(b);
}

describe('deepDiff', () => {
  it("reports changes as deep-diff does", () => {
    expect(deepDiff({ a: 1 }, { a: 1 })).toEqual([]);
    expect(deepDiff(undefined, { a: 1 })).toEqual([{ kind: 'N', rhs: { a: 1 } }]);
    expect(deepDiff({ a: 1 }, undefined)).toEqual([{ kind: 'D', lhs: { a: 1 } }]);
    expect(deepDiff({ a: 1, b: { c: null }, d: 1 }, { a: 2, b: { c: 'x' }, e: true })).toEqual([
      { kind: 'E', path: ['a'], lhs: 1, rhs: 2 },
      { kind: 'E', path: ['b', 'c'], lhs: null, rhs: 'x' },
      { kind: 'D', path: ['d'], lhs: 1 },
      { kind: 'N', path: ['e'], rhs: true },
    ]);
    expect(deepDiff({ l: ['a', 'b', 'c'] }, { l: ['a', 'x'] })).toEqual([
      { kind: 'E', path: ['l', 1], lhs: 'b', rhs: 'x' },
      { kind: 'A', path: ['l'], index: 2, item: { kind: 'D', lhs: 'c' } },
    ]);
    expect(deepDiff({ l: [] }, { l: [{ v: 1 }] })).toEqual([{ kind: 'A', path: ['l'], index: 0, item: { kind: 'N', rhs: { v: 1 } } }]);
    expect(deepDiff({ o: null }, { o: { a: 1 } })).toEqual([{ kind: 'E', path: ['o'], lhs: null, rhs: { a: 1 } }]);
    expect(deepDiff({ o: [1] }, { o: { 0: 1 } })).toEqual([{ kind: 'E', path: ['o'], lhs: [1], rhs: { 0: 1 } }]);
  });

  it('gives changes that turn one value into the other', () => {
    roundTrip({ a: 1, b: { c: [1, 2, 3, 4], d: 'x' } }, { a: 2, b: { c: [1, 9], e: null } });
    roundTrip({ list: [{ x: 1 }, { x: 2 }] }, { list: [{ x: 1, y: [true] }, { x: 3 }, { x: 4 }] });
    roundTrip({ meta: null }, { meta: { options: { choices: [1] } } });
  });
});

describe('applyDiffEntry', () => {
  it('truncates arrays for trailing deletions, in any order', () => {
    const target = { l: [1, 2, 3, 4] };
    applyDiffEntry(target, { kind: 'A', path: ['l'], index: 2, item: { kind: 'D', lhs: 3 } });
    applyDiffEntry(target, { kind: 'A', path: ['l'], index: 3, item: { kind: 'D', lhs: 4 } });
    expect(target.l).toEqual([1, 2]);
  });

  it("refuses paths that lead nowhere and changes to the whole value", () => {
    expect(applyDiffEntry({ a: 1 }, { kind: 'E', path: ['a', 'b'], lhs: 1, rhs: 2 })).toBe(false);
    expect(applyDiffEntry({ a: 1 }, { kind: 'N', rhs: 1 })).toBe(false);
    expect(applyDiffEntry({ a: 'x' }, { kind: 'A', path: ['a'], index: 0, item: { kind: 'N', rhs: 1 } })).toBe(false);
  });
});

it('isDiffEntry', () => {
  expect(isDiffEntry({ kind: 'E', path: ['a', 0], lhs: 1, rhs: 2 })).toBe(true);
  expect(isDiffEntry({ kind: 'A', path: ['a'], index: 0, item: { kind: 'D', lhs: 1 } })).toBe(true);
  for (const bad of [null, [], { kind: 'Q' }, { kind: 'N' }, { kind: 'E', lhs: 1 }, { kind: 'A', index: 1.5, item: { kind: 'N', rhs: 1 } }, { kind: 'D', lhs: 1, path: [{}] }]) {
    expect(isDiffEntry(bad)).toBe(false);
  }
});

it('sortKeysDeep', () => {
  expect(JSON.stringify(sortKeysDeep({ b: 1, a: [{ d: 1, c: 2 }] }))).toBe('{"a":[{"c":2,"d":1}],"b":1}');
});
