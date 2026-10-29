import { describe, expect, it } from 'vitest';
import {
  countItems,
  deleteItems,
  type Filter,
  insertItems,
  type QueryCollection,
  resolveFields,
  type Row,
  selectItems,
  selectKeys,
  updateItems,
} from '../src/index.ts';
import { AUTHOR, database, posts } from './helpers.ts';

const { run } = database();

type Opts = { search?: string | null; sort?: string[] | null; limit?: number; offset?: number; collection?: QueryCollection };

/** Ids of the seed rows a query selects, in result order. */
const ids = (filter: Filter | null, o: Opts = {}) =>
  run(
    selectItems(o.collection ?? posts, {
      fields: ['id'],
      filter,
      search: o.search ?? null,
      sort: o.sort ?? null,
      limit: o.limit ?? -1,
      offset: o.offset ?? 0,
    }),
  ).map((r) => r.id);

const rejects = (fn: () => unknown, code: string, reason: string) =>
  expect(fn).toThrow(expect.objectContaining({ code, extensions: { reason } }));

describe('filter operators', () => {
  it.each<[string, Filter, number[]]>([
    ['_eq', { status: { _eq: 'published' } }, [1, 2, 5]],
    ['shorthand _eq', { status: 'draft' }, [3, 6]],
    ['_eq null', { title: { _eq: null } }, [5]],
    ['_neq', { status: { _neq: 'published' } }, [3, 4, 6]],
    ['_neq null', { title: { _neq: null } }, [1, 2, 3, 4, 6]],
    ['_gt', { views: { _gt: 10 } }, [2, 4]],
    ['_gte (numeric string)', { views: { _gte: '10' } }, [1, 2, 4]],
    ['_lt', { views: { _lt: 10 } }, [3, 6]],
    ['_lte', { views: { _lte: 7 } }, [3, 6]],
    ['_in', { views: { _in: [10, 25] } }, [1, 2]],
    ['_nin (nulls excluded, as in SQL)', { views: { _nin: [0, 7] } }, [1, 2, 4]],
    ['_in empty', { views: { _in: [] } }, []],
    ['_between', { views: { _between: [7, 25] } }, [1, 2, 6]],
    ['_nbetween', { views: { _nbetween: [7, 25] } }, [3, 4]],
    ['_null', { rating: { _null: true } }, [3]],
    ['_null false', { rating: { _null: false } }, [1, 2, 4, 5, 6]],
    ['_nnull', { rating: { _nnull: true } }, [1, 2, 4, 5, 6]],
    ['_empty', { body: { _empty: true } }, [3, 6]],
    ['_nempty', { body: { _nempty: true } }, [1, 2, 4, 5]],
    ['_contains is case-sensitive', { title: { _contains: 'hello' } }, [6]],
    ['_contains', { title: { _contains: 'llo' } }, [1, 6]],
    ['_contains treats % and _ literally', { title: { _contains: '100%' } }, [4]],
    ['_contains treats _ literally', { title: { _contains: 't_t' } }, [4]],
    ['_ncontains', { title: { _ncontains: 'o' } }, [4]],
    ['_icontains', { title: { _icontains: 'HELLO' } }, [1, 6]],
    ['_nicontains', { title: { _nicontains: 'HELLO' } }, [2, 3, 4]],
    ['_starts_with', { title: { _starts_with: 'Hello' } }, [1]],
    ['_nstarts_with', { title: { _nstarts_with: 'Hello' } }, [2, 3, 4, 6]],
    ['_istarts_with', { title: { _istarts_with: 'hello' } }, [1]],
    ['_nistarts_with', { title: { _nistarts_with: 'hello' } }, [2, 3, 4, 6]],
    ['_ends_with', { title: { _ends_with: 'hello' } }, [6]],
    ['_ends_with counts characters, not bytes', { body: { _ends_with: 'café' } }, [2]],
    ['_nends_with', { title: { _nends_with: 'hello' } }, [1, 2, 3, 4]],
    ['_iends_with', { title: { _iends_with: 'WORLD' } }, [1]],
    ['_niends_with', { title: { _niends_with: 'HELLO' } }, [1, 2, 3, 4]],
    ['case folding is ASCII-only, like SQLite LIKE', { title: { _icontains: 'école' } }, []],
    ['booleans', { published: { _eq: true } }, [1, 2, 6]],
    ['booleans from strings', { published: { _eq: 'false' } }, [3, 4]],
    ['dates are normalized', { published_on: { _eq: '2024-01-05' } }, [1, 6]],
    ['date compared to a date-time', { published_on: { _gt: '2024-02-01T15:00:00Z' } }, [2, 5]],
    ['timestamps compare as instants', { created_at: { _gte: '2024-02-10T09:30:00+01:00' } }, [2, 3]],
    ['$NOW (a Date)', { created_at: { _lt: new Date('2024-01-01T00:00:00Z') } }, [4]],
    ['UUIDs ignore case', { author: { _eq: AUTHOR.toUpperCase() } }, [1, 3]],
    ['csv as text', { tags: { _contains: 'intro' } }, [1, 6]],
    ['json as text', { data: { _contains: '"a"' } }, [1]],
    ['several operators on one field', { views: { _gt: 5, _lt: 50 } }, [1, 2, 6]],
    ['empty filter', {}, [1, 2, 3, 4, 5, 6]],
    ['empty _and / _or match everything', { _and: [], _or: [] }, [1, 2, 3, 4, 5, 6]],
  ])('%s', (_name, filter, expected) => {
    expect(ids(filter)).toEqual(expected);
  });

  it('works with values longer than D1 allows in LIKE patterns', () => {
    expect(ids({ body: { _contains: 'x'.repeat(200) } })).toEqual([]);
  });

  it('nests _and / _or', () => {
    const filter: Filter = {
      _and: [
        { _or: [{ status: { _eq: 'draft' } }, { views: { _gte: 100 } }] },
        { _or: [{ title: { _icontains: 'notes' } }, { published: { _eq: false } }] },
      ],
    };
    expect(ids(filter)).toEqual([3, 4]);
    expect(ids({ _or: [filter, { _and: [{ status: 'published' }, { rating: { _gt: 4 } }] }] })).toEqual([1, 3, 4]);
  });
});

describe('filter errors', () => {
  const field = (path: string) => `You don't have permission to access field "${path}" in collection "posts" or it does not exist.`;

  it.each<[Filter, string, string]>([
    [{ nope: { _eq: 1 } }, 'FORBIDDEN', field('nope')],
    [{ divider: { _eq: 1 } }, 'FORBIDDEN', field('divider')],
    [{ title: { name: { _eq: 'x' } } }, 'FORBIDDEN', field('title.name')],
    [{ _eq: 1 }, 'INVALID_QUERY', '"_eq" has to be used on a field'],
    [{ _and: {} }, 'INVALID_QUERY', '"_and" has to be an array of filters'],
    [{ title: { _foo: 1 } }, 'INVALID_QUERY', '"_foo" is not a valid filter operator'],
    [{ title: { _regex: 'a' } }, 'INVALID_QUERY', '"_regex" is not supported'],
    [{ title: { _some: {} } }, 'INVALID_QUERY', '"_some" can only be used on one-to-many fields'],
    [{ title: { _eq: '' } }, 'INVALID_QUERY', `You can't filter for an empty string in "_eq". Use "_empty" or "_nempty" instead`],
    [{ title: { _eq: { a: 1 } } }, 'INVALID_QUERY', 'The filter value for "_eq" has to be a string, number, or boolean'],
    [{ views: { _eq: 'abc' } }, 'INVALID_QUERY', 'The filter value for "views" must be a number'],
    [{ created_at: { _gt: 'yesterday' } }, 'INVALID_QUERY', 'The filter value for "created_at" must be an ISO 8601 date and time'],
    [{ title: { _in: 'x' } }, 'INVALID_QUERY', '"_in" has to be an array of values'],
    [{ views: { _between: [1] } }, 'INVALID_QUERY', '"_between" has to be an array of two values'],
    [{ title: { _null: 'yes' } }, 'INVALID_QUERY', '"_null" has to be a boolean'],
  ])('%j', (filter, code, reason) => {
    rejects(() => ids(filter), code, reason);
  });
});

describe('parameters', () => {
  it('numbers parameters and shares equal values', () => {
    const s = selectItems(posts, {
      fields: ['id', 'title'],
      filter: { _or: [{ status: { _eq: 'published' } }, { views: { _gt: 10 } }, { body: { _eq: 'published' } }] },
      search: null,
      sort: ['-views'],
      limit: 10,
      offset: 20,
    });
    expect(s.sql).toBe(
      'SELECT "posts"."id" AS "id", "posts"."title" AS "title" FROM "posts" WHERE ("posts"."status" = ?1 OR "posts"."views" > ?2 OR "posts"."body" = ?1) ' +
        'ORDER BY "posts"."views" DESC, "posts"."id" ASC LIMIT ?2 OFFSET ?3',
    );
    expect(s.params).toEqual(['published', 10, 20]);
  });

  it('refuses queries needing more than 100 distinct values (D1 limit)', () => {
    const many = { _or: Array.from({ length: 101 }, (_, i) => ({ views: { _eq: i } })) };
    rejects(() => ids(many), 'INVALID_QUERY', 'The query needs more than 100 distinct values');
    expect(ids({ _or: many._or.slice(0, 100) })).toEqual([1, 2, 3, 6]);
  });

  it('passes lists as one JSON parameter', () => {
    const s = selectItems(posts, { fields: ['id'], filter: { views: { _in: Array.from({ length: 1000 }, (_, i) => i) } }, search: null, sort: null, limit: -1, offset: 0 });
    expect(s.params).toHaveLength(1);
    expect(run(s).map((r) => r.id)).toEqual([1, 2, 3, 4, 6]);
  });
});

describe('search', () => {
  it.each<[string, number[]]>([
    ['hello', [1, 6]],
    ['CAFÉ', []],
    ['café', [2]],
    ['25', [2]],
    ['4.5', [1]],
    [AUTHOR, [1, 3]],
    ['apple', []], // only in a field with meta.searchable = false
  ])('%s', (term, expected) => {
    expect(ids(null, { search: term })).toEqual(expected);
  });

  it('combines with the filter', () => {
    expect(ids({ status: 'published' }, { search: 'hello' })).toEqual([1]);
  });
});

describe('sort and pagination', () => {
  it('defaults to the primary key, or the collection sort field', () => {
    expect(ids(null)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(null, { collection: { ...posts, sortField: 'views' } })).toEqual([5, 3, 6, 1, 2, 4]);
  });

  it('sorts by several fields, breaking ties by primary key', () => {
    expect(ids(null, { sort: ['-views'] })).toEqual([4, 2, 1, 6, 3, 5]);
    expect(ids(null, { sort: ['status', '-id'] })).toEqual([4, 6, 3, 5, 2, 1]);
    expect(ids(null, { sort: ['published'] })).toEqual([5, 3, 4, 1, 2, 6]);
  });

  it('pages', () => {
    expect(ids(null, { limit: 2, offset: 2 })).toEqual([3, 4]);
    expect(ids(null, { limit: -1, offset: 4 })).toEqual([5, 6]);
    expect(ids(null, { limit: 0 })).toEqual([]);
  });

  it('rejects unknown sort fields', () => {
    rejects(() => ids(null, { sort: ['-nope'] }), 'FORBIDDEN', `You don't have permission to access field "nope" in collection "posts" or it does not exist.`);
  });
});

describe('fields', () => {
  const names = (requested: string[]) => resolveFields(posts, requested).map((f) => f.field);

  it('expands * to every column, skipping aliases', () => {
    expect(names(['*'])).toEqual(posts.fields.filter((f) => f.type !== 'alias').map((f) => f.field));
    expect(names(['*.*'])).toEqual(names(['*']));
  });

  it('keeps request order and drops duplicates', () => {
    expect(names(['title', 'id', 'title', 'divider'])).toEqual(['title', 'id']);
  });

  it('still returns one row per item when only aliases are requested', () => {
    const s = selectItems(posts, { fields: ['divider'], filter: null, search: null, sort: null, limit: 2, offset: 0 });
    expect(s.fields).toEqual([]);
    expect(run(s)).toHaveLength(2);
  });

  it.each(['nope', 'title.length', '*.title'])('rejects %s', (path) => {
    rejects(() => names([path]), 'FORBIDDEN', `You don't have permission to access field "${path}" in collection "posts" or it does not exist.`);
  });
});

describe('count', () => {
  it('counts all rows or the matching ones', () => {
    expect(countItems(posts, null, null).sql).toBe('SELECT count(*) AS "count" FROM "posts"');
    expect(run(countItems(posts, null, null))).toEqual([{ count: 6 }]);
    expect(run(countItems(posts, { status: 'published' }, 'hello'))).toEqual([{ count: 1 }]);
  });
});

describe('writes', () => {
  const sorted = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id as number).sort((a, b) => a - b);

  it('inserts consecutive rows with the same columns in one statement; omitted columns get defaults', () => {
    const { run } = database();
    const statements = insertItems(posts, [{ title: 'a' }, { title: 'b' }, { title: 'c', status: 'x' }, {}]);
    expect(statements.map((s) => s.sql)).toEqual([
      `INSERT INTO "posts" ("title") SELECT json_extract(value, '$[0]') FROM json_each(?1) RETURNING "id"`,
      `INSERT INTO "posts" ("title", "status") SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1) RETURNING "id"`,
      'INSERT INTO "posts" DEFAULT VALUES RETURNING "id"',
    ]);
    expect(statements.flatMap((s) => sorted(run(s)))).toEqual([7, 8, 9, 10]);
    expect(run({ sql: 'SELECT title, status FROM posts WHERE id > 6 ORDER BY id', params: [] })).toEqual([
      { title: 'a', status: 'draft' },
      { title: 'b', status: 'draft' },
      { title: 'c', status: 'x' },
      { title: null, status: 'draft' },
    ]);
  });

  it('keeps each statement within D1 limits for large inserts', () => {
    const { run } = database();
    const rows: Row[] = Array.from({ length: 3000 }, (_, i) => ({ title: `t${i}`, body: 'x'.repeat(500), views: i }));
    const statements = insertItems(posts, rows);
    expect(statements.length).toBeGreaterThan(1);
    expect(statements.every((s) => s.params.length === 1 && String(s.params[0]).length <= 512 * 1024)).toBe(true);
    for (const s of statements) run(s);
    expect(run(countItems(posts, null, null))).toEqual([{ count: 3006 }]);
  });

  it('updates by key, keys or query, returning the keys changed', () => {
    const { run } = database();
    expect(sorted(run(updateItems(posts, { views: 1 }, { key: 2 })))).toEqual([2]);
    expect(sorted(run(updateItems(posts, { views: 2 }, { keys: [1, 3, 99] })))).toEqual([1, 3]);
    const top = { filter: { status: { _eq: 'published' } }, search: null, sort: ['-rating'], limit: 2, offset: 0 };
    expect(sorted(run(updateItems(posts, { status: 'featured', views: 3 }, { query: top })))).toEqual([1, 2]);
    expect(run({ sql: 'SELECT id, status, views FROM posts WHERE id <= 3 ORDER BY id', params: [] })).toEqual([
      { id: 1, status: 'featured', views: 3 },
      { id: 2, status: 'featured', views: 3 },
      { id: 3, status: 'draft', views: 2 },
    ]);
  });

  it('deletes and selects keys', () => {
    const { run } = database();
    expect(sorted(run(selectKeys(posts, { keys: [1, 2, 42] })))).toEqual([1, 2]);
    expect(sorted(run(deleteItems(posts, { query: { filter: { published: { _eq: true } }, search: null, sort: null, limit: -1, offset: 0 } })))).toEqual([1, 2, 6]);
    expect(sorted(run(deleteItems(posts, { key: 1 })))).toEqual([]);
    expect(run(countItems(posts, null, null))).toEqual([{ count: 3 }]);
  });

  it('only writes columns of the collection', () => {
    rejects(() => updateItems(posts, { divider: 1 }, { key: 1 }), 'FORBIDDEN', `You don't have permission to access field "divider" in collection "posts" or it does not exist.`);
  });
});
