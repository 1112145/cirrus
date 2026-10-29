import { describe, expect, it } from 'vitest';
import {
  type Access,
  buildAccess,
  countItems,
  deleteItems,
  type Filter,
  guardItems,
  type PermissionRule,
  type Query,
  selectItems,
  type Statement,
  updateItems,
  writeCondition,
} from '../src/index.ts';
import { AUTHOR, database, posts } from './helpers.ts';

const rule = (r: Partial<PermissionRule>): PermissionRule => ({ fields: ['*'], permissions: null, validation: null, presets: null, ...r });

const query = (q: Partial<Query> = {}): Query => ({
  fields: ['id'],
  filter: null,
  search: null,
  sort: null,
  limit: -1,
  offset: 0,
  meta: [],
  ...q,
});

const OWN: Filter = { author: { _eq: AUTHOR } };
const PUBLISHED: Filter = { status: { _eq: 'published' } };

/** Editors see their own posts; anyone sees published posts, but only their id, title and status. */
const twoPolicies = buildAccess(posts, [
  rule({ fields: ['id', 'title', 'status'], permissions: PUBLISHED }),
  rule({ fields: ['*'], permissions: OWN }),
]);

const rejects = (fn: () => unknown, code: string, reason?: string) =>
  expect(fn).toThrow(expect.objectContaining({ code, ...(reason ? { extensions: { reason } } : {}) }));

describe('buildAccess', () => {
  it('ORs the row filters; a permission without one opens every row', () => {
    expect(buildAccess(posts, [rule({ permissions: OWN })]).filter).toEqual(OWN);
    expect(buildAccess(posts, [rule({ permissions: OWN }), rule({ permissions: PUBLISHED })]).filter).toEqual({ _or: [OWN, PUBLISHED] });
    expect(buildAccess(posts, [rule({ permissions: OWN }), rule({ permissions: {} })]).filter).toBeNull();
  });

  it('gives each field the condition of the permissions that grant it', () => {
    expect(Object.fromEntries(twoPolicies.fields)).toEqual({
      id: null,
      title: null,
      status: null,
      body: OWN,
      views: OWN,
      rating: OWN,
      published: OWN,
      tags: OWN,
      data: OWN,
      published_on: OWN,
      created_at: OWN,
      author: OWN,
      secret: OWN,
      divider: OWN,
    });
    // Granted by a permission without a row filter: visible on every row.
    const open = buildAccess(posts, [rule({ fields: ['title'] }), rule({ fields: ['*'], permissions: OWN })]);
    expect(open.filter).toBeNull();
    expect(open.fields.get('title')).toBeNull();
    expect(open.fields.get('views')).toEqual(OWN);
  });

  it('grants nothing for fields: null, and only real fields', () => {
    const a = buildAccess(posts, [rule({ fields: null }), rule({ fields: ['title', 'nope'] })]);
    expect([...a.fields.keys()]).toEqual(['title']);
    expect(a.allFields).toBe(false);
    expect(twoPolicies.allFields).toBe(true);
  });

  it('merges presets in order and ORs validations', () => {
    const a = buildAccess(posts, [
      rule({ presets: { status: 'draft', views: 0 }, validation: { views: { _lt: 10 } } }),
      rule({ presets: { status: 'review' }, validation: { title: { _nnull: true } } }),
    ]);
    expect(a.presets).toEqual({ status: 'review', views: 0 });
    expect(a.validation).toEqual({ _or: [{ views: { _lt: 10 } }, { title: { _nnull: true } }] });
    expect(buildAccess(posts, [rule({ validation: { views: { _lt: 10 } } }), rule({ validation: {} })]).validation).toBeNull();
  });

  it('writeCondition combines the row filter with the fields written', () => {
    expect(writeCondition(twoPolicies, ['title'])).toEqual({ _or: [PUBLISHED, OWN] });
    expect(writeCondition(twoPolicies, ['title', 'views', 'secret'])).toEqual({ _and: [{ _or: [PUBLISHED, OWN] }, OWN] });
    expect(writeCondition(buildAccess(posts, [rule({})]), ['title'])).toBeNull();
  });
});

describe('reads with access', () => {
  const { run } = database();
  const rows = (q: Partial<Query>, access: Access | null, restrict: Filter | null = null) =>
    run(selectItems(posts, query(q), { access, restrict }));
  const ids = (q: Partial<Query>, access: Access | null) => rows(q, access).map((r) => r.id);

  it('only returns the rows a permission allows', () => {
    expect(ids({}, buildAccess(posts, [rule({ permissions: OWN })]))).toEqual([1, 3]);
    expect(ids({}, twoPolicies)).toEqual([1, 2, 3, 5]);
    expect(ids({ filter: { title: { _contains: 'o' } } }, twoPolicies)).toEqual([1, 2, 3]);
  });

  it('reads a field only on the rows of the permissions that grant it', () => {
    expect(rows({ fields: ['id', 'title', 'views'] }, twoPolicies)).toEqual([
      { id: 1, title: 'Hello World', views: 10 },
      { id: 2, title: 'Second', views: null },
      { id: 3, title: 'draft notes', views: 0 },
      { id: 5, title: null, views: null },
    ]);
  });

  it('uses the same rule in filters, sorts and search, so hidden values cannot be probed', () => {
    // Row 2 has 25 views, but this request can't see them there.
    expect(ids({ filter: { views: { _gt: 5 } } }, twoPolicies)).toEqual([1]);
    expect(ids({ search: '25' }, twoPolicies)).toEqual([]);
    expect(ids({ search: '10' }, twoPolicies)).toEqual([1]);
    expect(ids({ sort: ['-views'] }, twoPolicies)).toEqual([1, 3, 2, 5]);
  });

  it('expands * to the granted fields and rejects the others', () => {
    const titles = buildAccess(posts, [rule({ fields: ['id', 'title'] })]);
    expect(selectItems(posts, query({ fields: ['*'] }), { access: titles }).fields.map((f) => f.field)).toEqual(['id', 'title']);
    const reason = `You don't have permission to access field "body" in collection "posts" or it does not exist.`;
    rejects(() => selectItems(posts, query({ fields: ['body'] }), { access: titles }), 'FORBIDDEN', reason);
    rejects(() => selectItems(posts, query({ filter: { body: { _null: true } } }), { access: titles }), 'FORBIDDEN', reason);
    rejects(() => selectItems(posts, query({ sort: ['body'] }), { access: titles }), 'FORBIDDEN', reason);
    // Search skips fields that aren't granted.
    expect(ids({ search: 'First post' }, titles)).toEqual([]);
  });

  it('applies restrict without field checks', () => {
    const titles = buildAccess(posts, [rule({ fields: ['id', 'title'] })]);
    expect(rows({}, titles, { author: { _eq: AUTHOR } }).map((r) => r.id)).toEqual([1, 3]);
  });

  it('counts within the access', () => {
    expect(run(countItems(posts, null, null, { access: twoPolicies }))).toEqual([{ count: 4 }]);
    expect(run(countItems(posts, { views: { _gte: 0 } }, null, { access: twoPolicies }))).toEqual([{ count: 2 }]);
  });

  it('compiles CASE once per field and keeps parameters shared', () => {
    const s = selectItems(posts, query({ fields: ['views'], filter: { views: { _gt: 1 } }, sort: ['views'] }), { access: twoPolicies });
    expect(s.sql).toBe(
      'SELECT (CASE WHEN "posts"."author" = ?1 THEN "posts"."views" END) AS "views" FROM "posts" WHERE ' +
        '(("posts"."status" = ?2 OR "posts"."author" = ?1) AND (CASE WHEN "posts"."author" = ?1 THEN "posts"."views" END) > ?3) ' +
        'ORDER BY (CASE WHEN "posts"."author" = ?1 THEN "posts"."views" END) ASC, "posts"."id" ASC',
    );
    expect(s.params).toEqual([AUTHOR, 'published', 1]);
  });
});

describe('guards', () => {
  const guardFails = (run: (s: Statement) => unknown, s: Statement | null) => {
    expect(s).not.toBeNull();
    expect(() => run(s!)).toThrow(/CHECK constraint failed: cirrus_guard/);
  };
  const guardPasses = (run: (s: Statement) => unknown, s: Statement | null) => {
    if (s) expect(run(s)).toEqual([]);
  };

  it('fails when a key is missing or its row does not meet the condition', () => {
    const { run } = database();
    guardPasses(run, guardItems(posts, { keys: [1, 3] }, OWN));
    guardPasses(run, guardItems(posts, { key: 1 }, OWN));
    guardPasses(run, guardItems(posts, { keys: [1, 1, 3] }, OWN));
    guardFails(run, guardItems(posts, { keys: [1, 2] }, OWN));
    guardFails(run, guardItems(posts, { keys: [1, 99] }, null));
    guardPasses(run, guardItems(posts, { keys: [1, 2] }, null));
    expect(guardItems(posts, { keys: [] }, OWN)).toBeNull();
  });

  it('fails when a row a query selects does not meet the condition', () => {
    const { run } = database();
    const q = { filter: { views: { _gte: 0 } }, search: null, sort: null, limit: -1, offset: 0 };
    guardFails(run, guardItems(posts, { query: q }, OWN));
    guardPasses(run, guardItems(posts, { query: { ...q, filter: { title: { _eq: 'draft notes' } } } }, OWN));
    // Rows outside the scope aren't selected, so they can't fail it.
    guardPasses(run, guardItems(posts, { query: q }, OWN, { access: buildAccess(posts, [rule({ permissions: OWN })]) }));
    expect(guardItems(posts, { query: q }, null)).toBeNull();
  });

  it('rolls back the batch it is part of', () => {
    const { db, run } = database();
    const batch = (statements: Array<Statement | null>) => {
      db.exec('BEGIN');
      try {
        for (const s of statements) if (s) run(s);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };
    const keys = { keys: [1, 2] };
    expect(() => batch([guardItems(posts, keys, OWN), updateItems(posts, { views: 0 }, keys)])).toThrow(/cirrus_guard/);
    expect(run({ sql: 'SELECT views FROM posts WHERE id IN (1, 2) ORDER BY id', params: [] })).toEqual([{ views: 10 }, { views: 25 }]);
  });
});

describe('writes with access', () => {
  it('only touch rows within the scope', () => {
    const { run } = database();
    const own = buildAccess(posts, [rule({ permissions: OWN })]);
    const all = { filter: null, search: null, sort: null, limit: -1, offset: 0 };
    expect(run(updateItems(posts, { views: 1 }, { query: all }, { access: own })).map((r) => r.id)).toEqual([1, 3]);
    expect(run(updateItems(posts, { views: 2 }, { keys: [1, 2] }, { restrict: OWN })).map((r) => r.id)).toEqual([1]);
    expect(run(deleteItems(posts, { key: 2 }, { access: own }))).toEqual([]);
    expect(run(deleteItems(posts, { key: 3 }, { access: own }))).toEqual([{ id: 3 }]);
  });

  it('checks a query target against the access fields', () => {
    const titles = buildAccess(posts, [rule({ fields: ['id', 'title'] })]);
    const q = { filter: { views: { _gt: 0 } }, search: null, sort: null, limit: -1, offset: 0 };
    rejects(() => updateItems(posts, { title: 'x' }, { query: q }, { access: titles }), 'FORBIDDEN');
  });
});

describe('concealed fields', () => {
  const hidden = { ...posts, fields: posts.fields.map((f) => (f.field === 'secret' ? { ...f, concealed: true, searchable: true } : f)) };
  const { run } = database();
  const select = (q: Partial<Query>, scope = {}) => run(selectItems(hidden, query(q), scope)).map((r) => r.id);

  it('can only be tested for null by requests', () => {
    expect(select({ filter: { secret: { _nnull: true } } })).toEqual([1]);
    expect(select({ filter: { secret: { _null: false } } })).toEqual([1]);
    for (const filter of [{ secret: { _starts_with: 'a' } }, { secret: 'apple' }, { secret: { _null: true, _eq: 'apple' } }]) {
      rejects(() => select({ filter }), 'INVALID_QUERY');
    }
    rejects(() => select({ sort: ['secret'] }), 'INVALID_QUERY');
    expect(select({ search: 'apple' })).toEqual([]);
  });

  it('can be used by permissions and restrict', () => {
    expect(select({}, { restrict: { secret: { _eq: 'apple' } } })).toEqual([1]);
    expect(select({}, { access: buildAccess(hidden, [rule({ permissions: { secret: { _starts_with: 'app' } } })]) })).toEqual([1]);
  });
});
