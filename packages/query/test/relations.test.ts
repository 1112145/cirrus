import { createTableSql, type FieldDef, type FieldType } from '@cirrus/schema';
import { forbidden } from '@cirrus/shared';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  type Access,
  buildAccess,
  clearKeys,
  deleteItems,
  type Filter,
  FOREIGN_KEY_CONSTRAINT,
  foreignKeyGuard,
  GUARD_TABLE,
  insertItems,
  KEYS_TABLE,
  planRead,
  type Query,
  type QueryCollection,
  type QueryField,
  type QueryRelation,
  type Related,
  referenceGuard,
  type Row,
  sanitizeQuery,
  selectItems,
  selectKeys,
  type Statement,
  stashClosure,
  stashKeys,
  stashNewKey,
  updateItems,
} from '../src/index.ts';

// A small schema with every kind of relation, on real SQLite --------------------------------------

type Spec = { type: FieldType; relation?: QueryRelation };
const m2o = (collection: string): Spec => ({ type: 'integer', relation: { type: 'm2o', collection } });
const o2m = (collection: string, field: string, sortField: string | null = null): Spec => ({ type: 'alias', relation: { type: 'o2m', collection, field, sortField } });

const SPECS: Record<string, Record<string, Spec>> = {
  authors: { id: { type: 'integer' }, name: { type: 'string' }, team: { type: 'string' }, secret: { type: 'string' }, posts: o2m('posts', 'author') },
  posts: {
    id: { type: 'integer' },
    title: { type: 'string' },
    author: m2o('authors'),
    editor: m2o('authors'),
    comments: o2m('comments', 'post'),
    tags: o2m('posts_tags', 'post'),
  },
  comments: { id: { type: 'integer' }, post: m2o('posts'), body: { type: 'string' }, author: m2o('authors'), rank: { type: 'integer' } },
  tags: { id: { type: 'integer' }, name: { type: 'string' }, posts: o2m('posts_tags', 'tag') },
  posts_tags: { id: { type: 'integer' }, post: m2o('posts'), tag: m2o('tags') },
  categories: { id: { type: 'integer' }, name: { type: 'string' }, parent: m2o('categories'), children: o2m('categories', 'parent', 'name') },
};

const collections = new Map<string, QueryCollection>(
  Object.entries(SPECS).map(([name, fields]) => [
    name,
    {
      collection: name,
      primary: 'id',
      sortField: null,
      fields: Object.entries(fields).map(([field, s]): QueryField => ({ field, type: s.type, searchable: true, relation: s.relation ?? null })),
    },
  ]),
);
const info = (name: string) => collections.get(name)!;

/** Admin-like resolver; `accesses` gives some collections a read access, `denied` none at all. */
const resolver = (accesses: Record<string, Access> = {}, denied: string[] = []): Related => ({
  collection: (name) => {
    const c = collections.get(name);
    if (!c) throw forbidden();
    return c;
  },
  readAccess: (name) => {
    if (denied.includes(name)) throw forbidden(`You don't have permission to access collection "${name}" or it does not exist.`);
    return accesses[name] ?? null;
  },
});
const admin = resolver();

const access = (name: string, rules: Array<{ fields?: string[]; permissions?: Filter | null }>) =>
  buildAccess(info(name), rules.map((r) => ({ fields: r.fields ?? ['*'], permissions: r.permissions ?? null, validation: null, presets: null })));

function database() {
  const db = new DatabaseSync(':memory:');
  for (const [name, fields] of Object.entries(SPECS)) {
    const defs: FieldDef[] = Object.entries(fields).map(([field, s]) => ({
      field,
      type: s.type,
      column:
        s.type === 'alias'
          ? null
          : { primaryKey: field === 'id', autoIncrement: field === 'id', nullable: field !== 'id', unique: false, indexed: false, defaultValue: null, maxLength: null, numericPrecision: null, numericScale: null },
    }));
    db.exec(createTableSql({ name, fields: defs }));
  }
  db.exec(`CREATE TABLE ${GUARD_TABLE} (ok INTEGER CONSTRAINT cirrus_guard CHECK (ok = 1), fk INTEGER CONSTRAINT ${FOREIGN_KEY_CONSTRAINT} CHECK (fk = 1))`);
  db.exec(`CREATE TABLE ${KEYS_TABLE} (slot INTEGER NOT NULL, value NOT NULL, PRIMARY KEY (slot, value)) WITHOUT ROWID`);
  db.exec(`
    INSERT INTO authors (name, team, secret) VALUES ('Ann', 'red', 's1'), ('Bob', 'blue', 's2'), ('Cid', 'red', 's3');
    INSERT INTO posts (title, author, editor) VALUES ('Hello', 1, 2), ('World', 2, NULL), ('Orphan', NULL, NULL), ('Third', 1, NULL);
    INSERT INTO comments (post, body, author, rank) VALUES (1, 'nice', 2, 1), (1, 'meh', 3, 2), (2, 'wow', 1, 1), (1, 'third', 1, 3);
    INSERT INTO tags (name) VALUES ('news'), ('tech');
    INSERT INTO posts_tags (post, tag) VALUES (1, 1), (1, 2), (2, 2);
    INSERT INTO categories (name, parent) VALUES ('root', NULL), ('kid', 1), ('grandkid', 2), ('other', NULL), ('kid2', 1);
  `);
  const run = (s: Statement) => db.prepare(s.sql).all(...s.params) as Array<Record<string, unknown>>;
  /** A D1 batch: one transaction, rolled back when a statement fails. */
  const batch = (statements: Statement[]) => {
    db.exec('BEGIN');
    try {
      const results = statements.map(run);
      db.exec('COMMIT');
      return results;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  return { db, run, batch };
}

const { run } = database();

const query = (over: Partial<Query> = {}): Query => ({ fields: ['id'], filter: null, search: null, sort: null, limit: -1, offset: 0, meta: [], deep: null, ...over });

/** Ids a filter/sort selects in a collection. */
const ids = (name: string, filter: Filter | null, o: { sort?: string[]; related?: Related | null; access?: Access | null } = {}) =>
  run(selectItems(info(name), query({ filter, sort: o.sort ?? null }), { related: o.related === undefined ? admin : o.related, access: o.access ?? null })).map((r) => r.id);

const rejects = (fn: () => unknown, code: string, reason: string) =>
  expect(fn).toThrow(expect.objectContaining({ code, extensions: { reason } }));

/** Read with relational fields; results run as one batch. */
function read(name: string, over: Partial<Query>, o: { related?: Related; access?: Access | null; limitDefault?: number } = {}) {
  const plan = planRead(info(name), query(over), { related: o.related ?? admin, access: o.access ?? null }, { limitDefault: o.limitDefault ?? 100 });
  return plan.assemble(plan.statements.map(run));
}

// Filters ----------------------------------------------------------------------------------------

describe('relational filters', () => {
  it.each<[string, string, Filter, number[]]>([
    ['M2O', 'posts', { author: { name: { _eq: 'Ann' } } }, [1, 4]],
    ['M2O without an item reads as null (LEFT JOIN)', 'posts', { author: { name: { _null: true } } }, [3]],
    ['M2O with operators on the key too', 'posts', { author: { _neq: 2, team: { _eq: 'red' } } }, [1, 4]],
    ['M2O shorthand inside', 'posts', { editor: { name: 'Bob' } }, [1]],
    ['M2O chain', 'comments', { post: { author: { name: 'Ann' } } }, [1, 2, 4]],
    ['O2M: some item matches', 'posts', { comments: { body: { _eq: 'wow' } } }, [2]],
    ['O2M _some', 'posts', { comments: { _some: { author: { team: 'red' } } } }, [1, 2]],
    ['O2M _none', 'posts', { comments: { _none: {} } }, [3, 4]],
    ['O2M _none with a filter', 'posts', { comments: { _none: { rank: { _gt: 1 } } } }, [2, 3, 4]],
    ['M2M', 'posts', { tags: { tag: { name: { _eq: 'tech' } } } }, [1, 2]],
    ['O2M under M2O', 'comments', { post: { tags: { _some: { tag: { name: 'news' } } } } }, [1, 2, 4]],
    ['self-referencing M2O', 'categories', { parent: { name: 'root' } }, [2, 5]],
    ['self-referencing M2O chain', 'categories', { parent: { parent: { name: 'root' } } }, [3]],
    ['self-referencing O2M', 'categories', { children: { _some: { name: 'grandkid' } } }, [2]],
    ['inside _or', 'posts', { _or: [{ author: { name: 'Bob' } }, { comments: { rank: { _gte: 3 } } }] }, [1, 2]],
  ])('%s', (_, name, filter, expected) => {
    expect(ids(name, filter)).toEqual(expected);
  });

  it.each<[Filter, string, string]>([
    [{ author: { nope: { _eq: 1 } } }, 'FORBIDDEN', `You don't have permission to access field "author.nope" in collection "authors" or it does not exist.`],
    [{ author: { name: { nope: 1 } } }, 'FORBIDDEN', `You don't have permission to access field "author.name.nope" in collection "authors" or it does not exist.`],
    [{ comments: { _eq: 1 } }, 'INVALID_QUERY', `"_eq" can't be used on one-to-many field "comments"`],
    [{ comments: 'x' }, 'INVALID_QUERY', '"comments" is a one-to-many field: filter its items with "_some" or "_none"'],
    [{ comments: { _some: 'x' } }, 'INVALID_QUERY', '"_some" has to be a filter object'],
    [{ title: { _some: {} } }, 'INVALID_QUERY', '"_some" can only be used on one-to-many fields'],
    [{ author: { _none: {} } }, 'INVALID_QUERY', '"_none" can only be used on one-to-many fields'],
  ])('rejects %j', (filter, code, reason) => {
    rejects(() => ids('posts', filter), code, reason);
  });

  it('needs a resolver for related collections', () => {
    rejects(() => ids('posts', { author: { name: 'Ann' } }, { related: null }), 'FORBIDDEN', `You don't have permission to access field "author" in collection "posts" or it does not exist.`);
  });

  it("applies the related collection's read access: other items read as missing", () => {
    const related = resolver({ authors: access('authors', [{ permissions: { team: { _eq: 'red' } } }]) });
    expect(ids('posts', { author: { name: 'Bob' } }, { related })).toEqual([]);
    // Bob can't be read, so post 2 has no (visible) author.
    expect(ids('posts', { author: { name: { _null: true } } }, { related })).toEqual([2, 3]);
    expect(ids('posts', { comments: { author: { name: 'Bob' } } }, { related })).toEqual([]);
  });

  it('applies the related fields the access grants, and their conditions', () => {
    // `secret` only on red authors, `name` everywhere
    const authors = access('authors', [{ fields: ['id', 'name', 'team'] }, { fields: ['secret'], permissions: { team: { _eq: 'red' } } }]);
    const related = resolver({ authors });
    expect(ids('posts', { author: { secret: { _eq: 's2' } } }, { related })).toEqual([]);
    expect(ids('posts', { author: { secret: { _eq: 's1' } } }, { related })).toEqual([1, 4]);
    rejects(
      () => ids('posts', { author: { nope: 1 } }, { related: resolver({ authors: access('authors', [{ fields: ['name'] }]) }) }),
      'FORBIDDEN',
      `You don't have permission to access field "author.nope" in collection "authors" or it does not exist.`,
    );
  });

  it('is FORBIDDEN through a collection the request may not read', () => {
    const related = resolver({}, ['authors']);
    rejects(() => ids('posts', { author: { name: 'Ann' } }, { related }), 'FORBIDDEN', `You don't have permission to access collection "authors" or it does not exist.`);
    // The key itself is a field of posts.
    expect(ids('posts', { author: { _eq: 1 } }, { related })).toEqual([1, 4]);
  });

  it('compiles permission filters through relations without checks', () => {
    const posts = access('posts', [{ permissions: { author: { team: { _eq: 'red' } } } }]);
    expect(ids('posts', null, { access: posts, related: resolver({}, ['authors']) })).toEqual([1, 4]);
  });

  it('needs the relational field to be granted', () => {
    const posts = access('posts', [{ fields: ['id', 'title'] }]);
    rejects(() => ids('posts', { author: { name: 'Ann' } }, { access: posts }), 'FORBIDDEN', `You don't have permission to access field "author" in collection "posts" or it does not exist.`);
    rejects(() => ids('posts', { comments: { _some: {} } }, { access: posts }), 'FORBIDDEN', `You don't have permission to access field "comments" in collection "posts" or it does not exist.`);
  });

  it('gives an O2M granted on some rows no items on the others', () => {
    const posts = access('posts', [{ fields: ['id', 'title'] }, { fields: ['comments'], permissions: { title: { _eq: 'World' } } }]);
    expect(ids('posts', { comments: { _some: {} } }, { access: posts })).toEqual([2]);
    expect(ids('posts', { comments: { _none: {} } }, { access: posts })).toEqual([]);
  });
});

describe('relational sorts', () => {
  it('sorts on M2O paths; items without one sort first', () => {
    expect(ids('posts', null, { sort: ['author.name', 'id'] })).toEqual([3, 1, 4, 2]);
    expect(ids('posts', null, { sort: ['-author.name'] })).toEqual([2, 1, 4, 3]);
    expect(ids('comments', null, { sort: ['post.author.name', '-rank'] })).toEqual([4, 2, 1, 3]);
  });

  it("can't sort on O2M paths", () => {
    rejects(() => ids('posts', null, { sort: ['comments.rank'] }), 'INVALID_QUERY', `Can't sort on "comments.rank": "comments" is a one-to-many field`);
    rejects(() => ids('posts', null, { sort: ['title.x'] }), 'FORBIDDEN', `You don't have permission to access field "title.x" in collection "posts" or it does not exist.`);
  });
});

// Nested reads -----------------------------------------------------------------------------------

describe('nested reads', () => {
  it('reads M2O items; missing ones are null', () => {
    expect(read('posts', { fields: ['title', 'author.name'] })).toEqual([
      { title: 'Hello', author: { name: 'Ann' } },
      { title: 'World', author: { name: 'Bob' } },
      { title: 'Orphan', author: null },
      { title: 'Third', author: { name: 'Ann' } },
    ]);
  });

  it('reads O2M items, in the relation sort or by key, and their keys without subfields', () => {
    expect(read('posts', { fields: ['id', 'comments'], limit: 2 })).toEqual([
      { id: 1, comments: [1, 2, 4] },
      { id: 2, comments: [3] },
    ]);
    expect(read('categories', { fields: ['name', 'children.name'], filter: { parent: { _null: true } } })).toEqual([
      { name: 'root', children: [{ name: 'kid' }, { name: 'kid2' }] },
      { name: 'other', children: [] },
    ]);
  });

  it('reads M2M through the junction', () => {
    expect(read('posts', { fields: ['title', 'tags.tag.name'], limit: 2 })).toEqual([
      { title: 'Hello', tags: [{ tag: { name: 'news' } }, { tag: { name: 'tech' } }] },
      { title: 'World', tags: [{ tag: { name: 'tech' } }] },
    ]);
  });

  it('expands wildcards like Directus: * includes O2M keys, *.* every relational field', () => {
    expect(read('posts', { fields: ['*'], filter: { id: { _eq: 1 } } })).toEqual([{ id: 1, title: 'Hello', author: 1, editor: 2, comments: [1, 2, 4], tags: [1, 2] }]);
    const [post] = read('posts', { fields: ['*.*'], filter: { id: { _eq: 2 } } });
    expect(post).toEqual({
      id: 2,
      title: 'World',
      author: { id: 2, name: 'Bob', team: 'blue', secret: 's2', posts: [2] },
      editor: null,
      comments: [{ id: 3, post: 2, body: 'wow', author: 1, rank: 1 }],
      tags: [{ id: 3, post: 2, tag: 2 }],
    });
    // Subfields win over the plain value.
    expect(read('posts', { fields: ['author', 'author.name'], filter: { id: { _eq: 1 } } })).toEqual([{ author: { name: 'Ann' } }]);
  });

  it('applies deep queries: filter, sort, limit and offset per parent', () => {
    const deep = { comments: { filter: null, search: null, sort: ['-rank'], limit: 2, offset: 0, deep: null } };
    expect(read('posts', { fields: ['id', 'comments.rank'], deep, limit: 2 })).toEqual([
      { id: 1, comments: [{ rank: 3 }, { rank: 2 }] },
      { id: 2, comments: [{ rank: 1 }] },
    ]);
    const second = { comments: { filter: null, search: null, sort: ['-rank'], limit: 1, offset: 1, deep: null } };
    expect(read('posts', { fields: ['id', 'comments.rank'], deep: second, limit: 2 })).toEqual([
      { id: 1, comments: [{ rank: 2 }] },
      { id: 2, comments: [] },
    ]);
    const filtered = { author: { filter: { team: { _eq: 'red' } }, search: null, sort: null, limit: null, offset: 0, deep: null } };
    expect(read('posts', { fields: ['id', 'author.name'], deep: filtered, limit: 2 })).toEqual([
      { id: 1, author: { name: 'Ann' } },
      { id: 2, author: null },
    ]);
  });

  it('limits O2M items per parent by default', () => {
    expect(read('posts', { fields: ['id', 'comments'], limit: 1 }, { limitDefault: 2 })).toEqual([{ id: 1, comments: [1, 2] }]);
  });

  it("reads nested relations of limited O2M items only for the items returned", () => {
    const deep = { comments: { filter: null, search: null, sort: null, limit: 1, offset: 0, deep: null } };
    const plan = planRead(info('posts'), query({ fields: ['id', 'comments.author.name'], deep, limit: 1 }), { related: admin }, { limitDefault: 100 });
    const results = plan.statements.map(run);
    // posts 1 → its first comment (1) → that comment's author (Bob) only
    expect(results.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(plan.assemble(results)).toEqual([{ id: 1, comments: [{ author: { name: 'Bob' } }] }]);
  });

  it("applies each collection's read access", () => {
    const related = resolver({
      authors: access('authors', [{ fields: ['id', 'name'], permissions: { team: { _eq: 'red' } } }]),
      comments: access('comments', [{ fields: ['id', 'body'], permissions: { rank: { _eq: 1 } } }]),
    });
    expect(read('posts', { fields: ['id', 'author.*', 'comments.*'], limit: 2 }, { related })).toEqual([
      { id: 1, author: { id: 1, name: 'Ann' }, comments: [{ id: 1, body: 'nice' }] },
      { id: 2, author: null, comments: [{ id: 3, body: 'wow' }] },
    ]);
    rejects(() => read('posts', { fields: ['author.secret'] }, { related }), 'FORBIDDEN', `You don't have permission to access field "author.secret" in collection "authors" or it does not exist.`);
  });

  it('leaves out what wildcards reach in collections the request may not read; asking explicitly is FORBIDDEN', () => {
    const related = resolver({}, ['comments', 'authors']);
    expect(read('posts', { fields: ['*'], filter: { id: { _eq: 1 } } }, { related })).toEqual([{ id: 1, title: 'Hello', author: 1, editor: 2, tags: [1, 2] }]);
    expect(read('posts', { fields: ['*.*'], filter: { id: { _eq: 1 } } }, { related })[0]).toMatchObject({ author: 1, editor: 2 });
    rejects(() => read('posts', { fields: ['comments'] }, { related }), 'FORBIDDEN', `You don't have permission to access collection "comments" or it does not exist.`);
    rejects(() => read('posts', { fields: ['author.name'] }, { related }), 'FORBIDDEN', `You don't have permission to access collection "authors" or it does not exist.`);
  });

  it('reads an O2M granted on some rows as null on the others', () => {
    const posts = access('posts', [{ fields: ['id'] }, { fields: ['comments'], permissions: { title: { _eq: 'World' } } }]);
    expect(read('posts', { fields: ['id', 'comments'], limit: 2 }, { access: posts })).toEqual([
      { id: 1, comments: null },
      { id: 2, comments: [3] },
    ]);
  });

  it('rejects fields that are not relational or do not exist', () => {
    rejects(() => read('posts', { fields: ['title.x'] }), 'FORBIDDEN', `You don't have permission to access field "title.x" in collection "posts" or it does not exist.`);
    rejects(() => read('posts', { fields: ['author.nope'] }), 'FORBIDDEN', `You don't have permission to access field "author.nope" in collection "authors" or it does not exist.`);
  });

  it('reports the relational fields for items that are missing', () => {
    const plan = planRead(info('posts'), query({ fields: ['title', 'author.name', 'comments'] }), { related: admin }, { limitDefault: 100 });
    expect(plan.empty).toEqual({ author: null, comments: [] });
    expect(plan.fields.map((f) => f.field)).toEqual(['title']);
  });
});

// Writes -----------------------------------------------------------------------------------------

describe('foreign keys and on_delete statements', () => {
  it('checks that M2O keys reference items, with a probe to find the field afterwards', () => {
    const { run, batch } = database();
    const ok = foreignKeyGuard(info('authors'), [1, 2, 2])!;
    expect(run(ok.guard)).toEqual([]);
    expect(run(ok.probe)).toEqual([]);
    const bad = foreignKeyGuard(info('authors'), [1, 9])!;
    expect(() => batch([bad.guard])).toThrow(/CHECK constraint failed: cirrus_foreign_key/);
    expect(run(bad.probe)).toEqual([{ missing: 1 }]);
    expect(foreignKeyGuard(info('authors'), [])).toBeNull();
  });

  it('stashes the keys a delete removes, nulls references and guards the restricted ones', () => {
    const { run, batch } = database();
    const doomed: Statement[] = [
      stashKeys(info('authors'), { query: { filter: { team: { _eq: 'red' } }, search: null, sort: null, limit: -1, offset: 0 } }, {}, 1),
      updateItems(info('posts'), { author: null }, { refs: { field: 'author', slot: 1 } }),
      referenceGuard(info('comments'), 'author', 1),
    ];
    expect(() => batch([...doomed, deleteItems(info('authors'), { slot: 1 })])).toThrow(/cirrus_foreign_key/);
    // Nothing happened.
    expect(run({ sql: 'SELECT count(*) AS n FROM posts WHERE author IS NULL', params: [] })).toEqual([{ n: 1 }]);

    const results = batch([...doomed.slice(0, 2), deleteItems(info('comments'), { refs: { field: 'author', slot: 1 } }), deleteItems(info('authors'), { slot: 1 }), clearKeys()]);
    expect(results[1]!.map((r) => r.id)).toEqual([1, 4]);
    expect(results[3]!.map((r) => r.id).sort()).toEqual([1, 3]);
    expect(run({ sql: 'SELECT id, author FROM posts ORDER BY id', params: [] })).toEqual([
      { id: 1, author: null },
      { id: 2, author: 2 },
      { id: 3, author: null },
      { id: 4, author: null },
    ]);
    expect(run({ sql: `SELECT count(*) AS n FROM ${KEYS_TABLE}`, params: [] })).toEqual([{ n: 0 }]);
  });

  it('extends stashed keys to whole subtrees of a self-referencing collection', () => {
    const { run, batch } = database();
    const categories = info('categories');
    batch([stashKeys(categories, { key: 1 }, {}, 3), stashClosure(categories, 3, ['parent']), referenceGuard(categories, 'parent', 3, true), deleteItems(categories, { slot: 3 }), clearKeys()]);
    expect(run({ sql: 'SELECT name FROM categories ORDER BY id', params: [] })).toEqual([{ name: 'other' }]);
  });

  it('passes auto-increment keys of new items to later statements', () => {
    const { run, batch } = database();
    const author = { slot: 7 };
    const rows: Row[] = [{ title: 'New', author }];
    const results = batch([
      ...insertItems(info('authors'), [{ name: 'Dee', team: 'green' }]),
      stashNewKey(info('authors'), 7),
      ...insertItems(info('posts'), rows),
      updateItems(info('posts'), { editor: author }, { key: 2 }),
      clearKeys(),
    ]);
    expect(results[0]).toEqual([{ id: 4 }]);
    expect(run({ sql: 'SELECT id, author, editor FROM posts WHERE id IN (2, 5) ORDER BY id', params: [] })).toEqual([
      { id: 2, author: 2, editor: 4 },
      { id: 5, author: 4, editor: null },
    ]);
  });

  it('selects keys by slot', () => {
    const { batch } = database();
    const [, keys] = batch([stashKeys(info('posts'), { keys: [2, 4, 9] }, {}, 1), selectKeys(info('posts'), { slot: 1 }), clearKeys()]);
    expect(keys!.map((r) => r.id)).toEqual([2, 4]);
  });
});

// Sanitize ---------------------------------------------------------------------------------------

describe('deep and relational depth', () => {
  const opts = { limitDefault: 100, limitMax: 1000, variables: { now: new Date() } };

  it('parses deep queries from JSON and bracket syntax', () => {
    const q = sanitizeQuery({ deep: '{"comments":{"_limit":"2","_sort":"-rank","_filter":{"rank":{"_gt":"1"}},"author":{"_filter":{"name":"Ann"}}}}' }, opts);
    expect(q.deep).toEqual({
      comments: {
        filter: { rank: { _gt: '1' } },
        search: null,
        sort: ['-rank'],
        limit: 2,
        offset: 0,
        deep: { author: { filter: { name: 'Ann' }, search: null, sort: null, limit: null, offset: 0, deep: null } },
      },
    });
    expect(sanitizeQuery({ deep: { comments: { _page: '3', _limit: '5' } } }, opts).deep?.comments).toMatchObject({ limit: 5, offset: 10 });
    expect(sanitizeQuery({ deep: { comments: { _page: '2' } } }, opts).deep?.comments).toMatchObject({ limit: null, offset: 100 });
    expect(sanitizeQuery({ deep: { comments: { _limit: '-1' } } }, opts).deep?.comments?.limit).toBe(1000);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ deep: '{' }, 'Invalid JSON for deep object'],
    [{ deep: '[]' }, '"deep" has to be an object'],
    [{ deep: { _limit: 1 } }, '"deep._limit" has to be nested in a relational field'],
    [{ deep: { comments: 1 } }, '"deep.comments" has to be an object'],
    [{ deep: { comments: { _group: 'x' } } }, '"deep.comments._group" is not supported'],
    [{ deep: { comments: { _limit: 5000 } } }, '"limit" must be less than or equal to 1000'],
  ])('rejects %j', (raw, reason) => {
    rejects(() => sanitizeQuery(raw, opts), 'INVALID_QUERY', reason);
  });

  it('caps relational depth in fields, sort, filter and deep (Directus MAX_RELATIONAL_DEPTH)', () => {
    const o = { ...opts, maxRelationalDepth: 3 };
    expect(() => sanitizeQuery({ fields: 'a.b.c', sort: 'a.b.c', filter: { a: { b: { c: { _eq: 1 } } } } }, o)).not.toThrow();
    for (const raw of [
      { fields: 'a.b.c.d' },
      { sort: '-a.b.c.d' },
      { filter: { _and: [{ a: { b: { c: { d: { _eq: 1 } } } } }] } },
      { deep: { a: { b: { c: { _limit: 1 } } } } },
      { deep: { a: { b: { _filter: { c: { d: 1 } } } } } },
    ]) {
      rejects(() => sanitizeQuery(raw, o), 'INVALID_QUERY', 'Max relational depth exceeded');
    }
    // At least 2, as in Directus.
    expect(() => sanitizeQuery({ fields: 'a.b' }, { ...opts, maxRelationalDepth: 1 })).not.toThrow();
  });

  it('resolves $CURRENT_USER paths through related items', () => {
    const variables = { now: new Date(), user: 'u1', userRecord: { role: { name: 'Editor' }, policies: [{ policy: 'p1' }, { policy: 'p2' }], team: null } };
    const q = sanitizeQuery(
      { filter: { _and: [{ a: { _eq: '$CURRENT_USER.role.name' } }, { b: { _in: '$CURRENT_USER.policies.policy' } }, { c: { _eq: '$CURRENT_USER.team.name' } }] } },
      { ...opts, variables },
    );
    expect(q.filter).toEqual({ _and: [{ a: { _eq: 'Editor' } }, { b: { _in: ['p1', 'p2'] } }, { c: { _eq: null } }] });
  });
});
