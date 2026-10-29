import { describe, expect, it } from 'vitest';
import { createTableSql, indexName, NOW, planCreateTable, planDropTable, planTableChange } from '../src/index.ts';
import { field, sqlite, table, uuidPk } from './helpers.ts';

const posts = table(
  'posts',
  uuidPk,
  field('title', 'string', { nullable: false, defaultValue: 'Untitled' }),
  field('slug', 'string', { unique: true }),
  field('views', 'integer', { indexed: true, defaultValue: 0 }),
  field('published', 'boolean', { defaultValue: false }),
  field('data', 'json'),
  field('divider', 'alias'),
);

describe('createTableSql', () => {
  it('renders a STRICT table; unique/indexed become separate indexes', () => {
    expect(planCreateTable(posts)).toEqual([
      [
        'CREATE TABLE "posts" (',
        '  "id" TEXT PRIMARY KEY NOT NULL,',
        `  "title" TEXT NOT NULL DEFAULT 'Untitled',`,
        '  "slug" TEXT,',
        '  "views" INTEGER DEFAULT 0,',
        '  "published" INTEGER DEFAULT 0 CHECK ("published" IN (0, 1)),',
        '  "data" TEXT CHECK (json_valid("data"))',
        ') STRICT',
      ].join('\n'),
      'CREATE UNIQUE INDEX "posts.slug.unique" ON "posts" ("slug")',
      'CREATE INDEX "posts.views.index" ON "posts" ("views")',
    ]);
  });

  it('enforces types, checks, defaults and uniqueness in SQLite', () => {
    const s = sqlite();
    s.run(planCreateTable(posts));
    s.run([`INSERT INTO posts (id, slug) VALUES ('a', 'hello')`]);
    expect(s.rows('SELECT title, views, published FROM posts')).toEqual([{ title: 'Untitled', views: 0, published: 0 }]);

    expect(() => s.run([`INSERT INTO posts (id, views) VALUES ('b', 'many')`])).toThrow(/cannot store TEXT value in INTEGER column/);
    expect(() => s.run([`INSERT INTO posts (id, published) VALUES ('b', 2)`])).toThrow(/CHECK constraint failed/);
    expect(() => s.run([`INSERT INTO posts (id, data) VALUES ('b', '{oops')`])).toThrow(/CHECK constraint failed/);
    expect(() => s.run([`INSERT INTO posts (id, slug) VALUES ('b', 'hello')`])).toThrow(/UNIQUE constraint failed: posts.slug/);
    expect(() => s.run([`INSERT INTO posts (id) VALUES (NULL)`])).toThrow(/NOT NULL constraint failed: posts.id/);
    expect(s.indexes('posts')).toEqual([indexName('posts', 'slug', 'unique'), indexName('posts', 'views', 'index')]);
  });

  it('integer primary keys can auto-increment', () => {
    const s = sqlite();
    s.run(planCreateTable(table('tags', field('id', 'integer', { primaryKey: true, autoIncrement: true, nullable: false }))));
    s.run(['INSERT INTO tags DEFAULT VALUES', 'INSERT INTO tags DEFAULT VALUES']);
    expect(s.rows('SELECT id FROM tags')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('CURRENT_TIMESTAMP defaults produce ISO 8601 UTC', () => {
    const s = sqlite();
    s.run(planCreateTable(table('logs', uuidPk, field('at', 'timestamp', { defaultValue: NOW }))));
    s.run([`INSERT INTO logs (id) VALUES ('a')`]);
    expect(s.rows('SELECT at FROM logs')[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('needs exactly one primary key', () => {
    expect(() => createTableSql(table('x', field('a', 'string')))).toThrow('exactly one primary key');
    expect(() => createTableSql(table('x', uuidPk, field('b', 'uuid', { primaryKey: true })))).toThrow('exactly one primary key');
  });

  it('drops tables with their indexes', () => {
    const s = sqlite();
    s.run(planCreateTable(posts));
    s.run(planDropTable('posts'));
    expect(s.rows("SELECT name FROM sqlite_master WHERE tbl_name = 'posts'")).toEqual([]);
  });
});

describe('planTableChange — in place', () => {
  const base = table('posts', uuidPk, field('title', 'string'));

  it('adds a nullable column', () => {
    const plan = planTableChange(base, table('posts', ...base.fields, field('body', 'text')));
    expect(plan).toEqual({ statements: ['ALTER TABLE "posts" ADD COLUMN "body" TEXT'], requiresRebuild: false });
  });

  it('adds a unique column through an index', () => {
    const s = sqlite();
    s.run(planCreateTable(base));
    s.run([`INSERT INTO posts VALUES ('a', 'A')`]);
    const plan = planTableChange(base, table('posts', ...base.fields, field('slug', 'string', { unique: true })));
    expect(plan.statements).toEqual([
      'ALTER TABLE "posts" ADD COLUMN "slug" TEXT',
      'CREATE UNIQUE INDEX "posts.slug.unique" ON "posts" ("slug")',
    ]);
    s.run(plan.statements);
    expect(s.rows('SELECT * FROM posts')).toEqual([{ id: 'a', title: 'A', slug: null }]);
  });

  it('adds a NOT NULL column without default only while the table is empty', () => {
    const desired = table('posts', ...base.fields, field('rank', 'integer', { nullable: false }));
    const plan = planTableChange(base, desired);
    expect(plan.requiresRebuild).toBe(false);

    const empty = sqlite();
    empty.run(planCreateTable(base));
    empty.run(plan.statements);

    const filled = sqlite();
    filled.run(planCreateTable(base));
    filled.run([`INSERT INTO posts VALUES ('a', 'A')`]);
    expect(() => filled.run(plan.statements)).toThrow(/Cannot add a NOT NULL column with default value NULL/);
  });

  it('drops an indexed column after its index', () => {
    const current = table('posts', uuidPk, field('title', 'string'), field('slug', 'string', { unique: true }));
    const plan = planTableChange(current, base);
    expect(plan.statements).toEqual(['DROP INDEX "posts.slug.unique"', 'ALTER TABLE "posts" DROP COLUMN "slug"']);

    const s = sqlite();
    s.run(planCreateTable(current));
    s.run(plan.statements);
    expect(s.columns('posts')).toEqual(['id', 'title']);
  });

  it('toggles unique and indexed without touching the column', () => {
    const unique = table('posts', uuidPk, field('title', 'string', { unique: true }));
    const indexed = table('posts', uuidPk, field('title', 'string', { indexed: true }));
    expect(planTableChange(base, unique).statements).toEqual(['CREATE UNIQUE INDEX "posts.title.unique" ON "posts" ("title")']);
    expect(planTableChange(unique, indexed).statements).toEqual([
      'DROP INDEX "posts.title.unique"',
      'CREATE INDEX "posts.title.index" ON "posts" ("title")',
    ]);
    expect(planTableChange(indexed, base).statements).toEqual(['DROP INDEX "posts.title.index"']);
  });

  it('needs nothing when only metadata changes', () => {
    expect(planTableChange(base, table('posts', uuidPk, field('title', 'text')))).toEqual({ statements: [], requiresRebuild: false });
    expect(planTableChange(base, table('posts', uuidPk, field('title', 'string', { maxLength: 80 }))).statements).toEqual([]);
    expect(planTableChange(base, table('posts', ...base.fields, field('divider', 'alias'))).statements).toEqual([]);
  });

  it("can't rename tables", () => {
    expect(() => planTableChange(base, table('articles', ...base.fields))).toThrow("Can't rename");
  });
});

describe('planTableChange — rebuild', () => {
  const current = table(
    'posts',
    field('id', 'integer', { primaryKey: true, autoIncrement: true, nullable: false }),
    field('title', 'string', { unique: true }),
    field('count', 'string'),
  );
  const seed = (s: ReturnType<typeof sqlite>) => {
    s.run(planCreateTable(current));
    s.run([`INSERT INTO posts (title, count) VALUES ('A', '1'), ('B', '22'), ('C', NULL)`]);
  };

  it('changes a column type, keeping data, ids and indexes', () => {
    const desired = table('posts', current.fields[0]!, current.fields[1]!, field('count', 'integer'));
    const plan = planTableChange(current, desired);
    expect(plan.requiresRebuild).toBe(true);
    expect(plan.statements.slice(1)).toEqual([
      'INSERT INTO "cirrus_rebuild_posts" ("id", "title", "count") SELECT "id", "title", "count" FROM "posts"',
      'DROP TABLE "posts"',
      'ALTER TABLE "cirrus_rebuild_posts" RENAME TO "posts"',
      'CREATE UNIQUE INDEX "posts.title.unique" ON "posts" ("title")',
    ]);

    const s = sqlite();
    seed(s);
    s.run(plan.statements);
    expect(s.rows('SELECT id, title, count, typeof(count) AS t FROM posts ORDER BY id')).toEqual([
      { id: 1, title: 'A', count: 1, t: 'integer' },
      { id: 2, title: 'B', count: 22, t: 'integer' },
      { id: 3, title: 'C', count: null, t: 'null' },
    ]);
    expect(s.indexes('posts')).toEqual(['posts.title.unique']);
    s.run([`INSERT INTO posts (title) VALUES ('D')`]);
    expect(s.rows(`SELECT id FROM posts WHERE title = 'D'`)).toEqual([{ id: 4 }]);
  });

  it("fails atomically when existing values don't fit the new type", () => {
    const s = sqlite();
    seed(s);
    s.run([`INSERT INTO posts (title, count) VALUES ('X', 'lots')`]);
    const plan = planTableChange(current, table('posts', current.fields[0]!, current.fields[1]!, field('count', 'integer')));
    expect(() => s.run(plan.statements)).toThrow(/cannot store TEXT value in INTEGER column cirrus_rebuild_posts.count/);
    expect(s.columns('posts')).toEqual(['id', 'title', 'count']);
    expect(s.rows('SELECT count(*) AS n FROM posts')).toEqual([{ n: 4 }]);
  });

  it('making a column NOT NULL fails on existing NULLs', () => {
    const s = sqlite();
    seed(s);
    const plan = planTableChange(current, table('posts', current.fields[0]!, current.fields[1]!, field('count', 'string', { nullable: false })));
    expect(() => s.run(plan.statements)).toThrow(/NOT NULL constraint failed: cirrus_rebuild_posts.count/);
  });

  it('changing a default rebuilds; existing values stay', () => {
    const s = sqlite();
    seed(s);
    const plan = planTableChange(current, table('posts', current.fields[0]!, current.fields[1]!, field('count', 'string', { defaultValue: '0' })));
    expect(plan.requiresRebuild).toBe(true);
    s.run(plan.statements);
    s.run([`INSERT INTO posts (title) VALUES ('D')`]);
    expect(s.rows('SELECT count FROM posts ORDER BY id')).toEqual([{ count: '1' }, { count: '22' }, { count: null }, { count: '0' }]);
  });

  it('adding a column with a CURRENT_TIMESTAMP default rebuilds and fills existing rows', () => {
    const s = sqlite();
    seed(s);
    const plan = planTableChange(current, table('posts', ...current.fields, field('created', 'dateTime', { defaultValue: NOW })));
    expect(plan.requiresRebuild).toBe(true);
    s.run(plan.statements);
    for (const row of s.rows('SELECT created FROM posts')) expect(row.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  });
});
