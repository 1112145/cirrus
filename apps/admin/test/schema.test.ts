import { describe, expect, it } from 'vitest';
import { type Field, interfaceOf, isAutomatic, nameError, type Relation, relationOf, slugify, sortFields, titleOf } from '../src/lib/schema.ts';

const field = (collection: string, name: string, type: Field['type'], meta: Partial<NonNullable<Field['meta']>> = {}, schema: Partial<NonNullable<Field['schema']>> | null = {}): Field => ({
  collection,
  field: name,
  type,
  meta: { special: null, interface: null, options: null, display: null, readonly: false, hidden: false, sort: null, width: 'full', note: null, required: false, group: null, validation: null, searchable: true, ...meta },
  schema: schema && { default_value: null, max_length: null, is_nullable: true, is_unique: false, is_indexed: false, is_primary_key: false, has_auto_increment: false, ...schema },
});

const relation = (collection: string, name: string, related: string | null, meta: Partial<NonNullable<Relation['meta']>> = {}): Relation => ({
  collection,
  field: name,
  related_collection: related,
  meta: { one_field: null, junction_field: null, sort_field: null, one_deselect_action: 'nullify', ...meta },
  schema: { on_delete: 'SET NULL' },
});

const relations: Relation[] = [
  relation('posts', 'author', 'authors', { one_field: 'posts' }),
  relation('posts', 'cover', 'directus_files'),
  relation('posts_tags', 'posts_id', 'posts', { one_field: 'tags', junction_field: 'tags_id', one_deselect_action: 'delete' }),
  relation('posts_tags', 'tags_id', 'tags', { junction_field: 'posts_id' }),
];

describe('relationOf', () => {
  it('finds M2O, file, O2M and M2M fields', () => {
    expect(relationOf({ collection: 'posts', field: 'author' }, relations)).toMatchObject({ kind: 'm2o', related: 'authors' });
    expect(relationOf({ collection: 'posts', field: 'cover' }, relations)).toMatchObject({ kind: 'file', related: 'directus_files' });
    expect(relationOf({ collection: 'authors', field: 'posts' }, relations)).toMatchObject({ kind: 'o2m', related: 'posts', foreignKey: 'author' });
    expect(relationOf({ collection: 'posts', field: 'tags' }, relations)).toMatchObject({
      kind: 'm2m',
      related: 'tags',
      junction: 'posts_tags',
      foreignKey: 'posts_id',
      junctionField: 'tags_id',
    });
    expect(relationOf({ collection: 'posts', field: 'title' }, relations)).toBeNull();
  });

  it('treats a junction field without its other relation as an O2M', () => {
    expect(relationOf({ collection: 'posts', field: 'tags' }, relations.slice(0, 3))).toMatchObject({ kind: 'o2m', related: 'posts_tags' });
  });
});

describe('interfaceOf', () => {
  it('uses the relation first, then the meta, then the type', () => {
    expect(interfaceOf(field('posts', 'author', 'uuid', { interface: 'input' }), relations)).toBe('select-dropdown-m2o');
    expect(interfaceOf(field('posts', 'cover', 'uuid'), relations)).toBe('file-image');
    expect(interfaceOf(field('posts', 'cover', 'uuid', { interface: 'file' }), relations)).toBe('file');
    expect(interfaceOf(field('posts', 'tags', 'alias'), relations)).toBe('list-m2m');
    expect(interfaceOf(field('posts', 'status', 'string', { interface: 'select-dropdown' }), relations)).toBe('select-dropdown');
    expect(interfaceOf(field('posts', 'body', 'text'), relations)).toBe('input-multiline');
    expect(interfaceOf(field('posts', 'data', 'json'), relations)).toBe('input-code');
    expect(interfaceOf(field('posts', 'on', 'boolean'), relations)).toBe('boolean');
  });
});

describe('isAutomatic', () => {
  it('knows the fields the server sets', () => {
    expect(isAutomatic(field('posts', 'id', 'uuid', {}, { is_primary_key: true }))).toBe(true);
    expect(isAutomatic(field('posts', 'id', 'integer', {}, { is_primary_key: true, has_auto_increment: true }))).toBe(true);
    expect(isAutomatic(field('posts', 'slug', 'string', {}, { is_primary_key: true }))).toBe(false);
    expect(isAutomatic(field('posts', 'date_created', 'timestamp', { special: ['date-created'] }))).toBe(true);
    expect(isAutomatic(field('posts', 'user_updated', 'uuid', { special: ['user-updated'] }))).toBe(true);
    expect(isAutomatic(field('posts', 'title', 'string'))).toBe(false);
  });
});

describe('names', () => {
  it('checks collection and field names', () => {
    expect(nameError('posts', 'collection')).toBeNull();
    expect(nameError('', 'collection')).toMatch(/required/);
    expect(nameError('Posts', 'collection')).toMatch(/lowercase/);
    expect(nameError('1posts', 'collection')).toMatch(/starting with a letter/);
    expect(nameError('cirrus_x', 'collection')).toMatch(/reserved/);
    expect(nameError('directus_x', 'collection')).toMatch(/reserved/);
    expect(nameError('rowid', 'field')).toMatch(/reserved/);
    expect(nameError('rowid', 'collection')).toBeNull();
    expect(nameError('a'.repeat(65), 'field')).toMatch(/64/);
  });

  it('turns labels into names and back', () => {
    expect(slugify('Blog posts!')).toBe('blog_posts');
    expect(slugify('Crème brûlée')).toBe('creme_brulee');
    expect(slugify('2024 sales')).toBe('n2024_sales');
    expect(titleOf('blog_posts')).toBe('Blog Posts');
    expect(titleOf('directus_files')).toBe('Files');
  });
});

describe('sortFields', () => {
  it('orders by meta.sort and keeps the given order otherwise', () => {
    const fields = [field('a', 'x', 'string', { sort: 2 }), field('a', 'y', 'string'), field('a', 'z', 'string', { sort: 1 }), field('a', 'w', 'string')];
    expect(sortFields(fields).map((f) => f.field)).toEqual(['z', 'x', 'y', 'w']);
  });
});
