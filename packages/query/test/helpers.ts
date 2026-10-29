import { createTableSql, type FieldDef, type TableDef } from '@cirrus/schema';
import { DatabaseSync } from 'node:sqlite';
import { insertItems, type QueryCollection, type Row, type Statement } from '../src/index.ts';

const col = (over: Partial<NonNullable<FieldDef['column']>> = {}) => ({
  primaryKey: false,
  autoIncrement: false,
  nullable: true,
  unique: false,
  indexed: false,
  defaultValue: null,
  maxLength: null,
  numericPrecision: null,
  numericScale: null,
  ...over,
});

/** A collection with one field of most types, to run generated SQL against real SQLite. */
export const fields: FieldDef[] = [
  { field: 'id', type: 'integer', column: col({ primaryKey: true, autoIncrement: true, nullable: false }) },
  { field: 'title', type: 'string', column: col() },
  { field: 'body', type: 'text', column: col() },
  { field: 'status', type: 'string', column: col({ defaultValue: 'draft' }) },
  { field: 'views', type: 'integer', column: col() },
  { field: 'rating', type: 'float', column: col() },
  { field: 'published', type: 'boolean', column: col() },
  { field: 'tags', type: 'csv', column: col() },
  { field: 'data', type: 'json', column: col() },
  { field: 'published_on', type: 'date', column: col() },
  { field: 'created_at', type: 'timestamp', column: col() },
  { field: 'author', type: 'uuid', column: col() },
  { field: 'secret', type: 'string', column: col() },
  { field: 'divider', type: 'alias', column: null },
];

export const posts: QueryCollection = {
  collection: 'posts',
  primary: 'id',
  sortField: null,
  fields: fields.map((f) => ({ field: f.field, type: f.type, searchable: f.field !== 'secret' })),
};

export const AUTHOR = '0190f5b2-8c4a-7b3e-9f00-00000000000a';

/** Rows 1–6 (ids follow insertion order). */
export const seed: Row[] = [
  { title: 'Hello World', body: 'First post', status: 'published', views: 10, rating: 4.5, published: 1, tags: 'news,intro', data: '{"a":1}', published_on: '2024-01-05', created_at: '2024-01-05T10:00:00.000Z', author: AUTHOR, secret: 'apple' },
  { title: 'Second', body: 'Más café', status: 'published', views: 25, rating: 3, published: 1, tags: 'news', data: '[1,2]', published_on: '2024-02-10', created_at: '2024-02-10T08:30:00.000Z', author: null, secret: null },
  { title: 'draft notes', body: null, views: 0, rating: null, published: 0, tags: '', data: null, published_on: null, created_at: '2024-03-01T00:00:00.000Z', author: AUTHOR, secret: null },
  { title: 'A 100% legit_title', body: 'wildcards % and _ and [x]', status: 'archived', views: 100, rating: 5, published: 0, tags: null, data: '"s"', published_on: '2023-12-31', created_at: '2023-12-31T23:59:59.999Z', author: null, secret: null },
  { title: null, body: 'no title', status: 'published', views: null, rating: 1.25, published: null, tags: 'misc', data: null, published_on: '2024-02-29', created_at: null, author: null, secret: null },
  { title: 'ÉCOLE hello', body: '', status: 'draft', views: 7, rating: 2, published: 1, tags: 'intro', data: '{}', published_on: '2024-01-05', created_at: '2024-01-06T00:00:00.000Z', author: null, secret: null },
];

/** Real SQLite (node:sqlite) with the posts table and seed rows. */
export function database() {
  const db = new DatabaseSync(':memory:');
  const table: TableDef = { name: 'posts', fields };
  db.exec(createTableSql(table));
  const run = (s: Statement) => db.prepare(s.sql).all(...s.params) as Array<Record<string, unknown>>;
  for (const s of insertItems(posts, seed)) run(s);
  return { db, run };
}
