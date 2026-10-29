import { beforeEach, describe, expect, it } from 'vitest';
import type { Collection, Field, Relation } from '../src/lib/schema.ts';
import { columnPaths, displayPaths, formFields, formPaths, listColumns, templateFor, toPayload } from '../src/stores/model.ts';
import { fieldOf, schema } from '../src/stores/schema.ts';
import { session } from '../src/stores/session.ts';

const f = (collection: string, field: string, type: Field['type'], meta: Partial<NonNullable<Field['meta']>> = {}, pk = false): Field => ({
  collection,
  field,
  type,
  meta: { special: null, interface: null, options: null, display: null, readonly: false, hidden: false, sort: null, width: 'full', note: null, required: false, group: null, validation: null, searchable: true, ...meta },
  schema:
    type === 'alias'
      ? null
      : { default_value: null, max_length: null, is_nullable: !pk, is_unique: pk, is_indexed: false, is_primary_key: pk, has_auto_increment: pk && type === 'integer' },
});
const c = (collection: string, template: string | null = null): Collection => ({
  collection,
  meta: { icon: null, note: null, display_template: template, hidden: false, singleton: false, sort_field: null, group: null, sort: null },
  schema: {},
});
const r = (collection: string, field: string, related: string, meta: Partial<NonNullable<Relation['meta']>> = {}): Relation => ({
  collection,
  field,
  related_collection: related,
  meta: { one_field: null, junction_field: null, sort_field: null, one_deselect_action: 'nullify', ...meta },
  schema: null,
});

beforeEach(() => {
  session.admin = false;
  Object.assign(schema, {
    loaded: true,
    collections: [c('posts', '{{ title }}'), c('authors'), c('tags'), c('posts_tags')],
    fields: [
      f('posts', 'id', 'uuid', { hidden: true, special: ['uuid'] }, true),
      f('posts', 'title', 'string'),
      f('posts', 'body', 'text'),
      f('posts', 'data', 'json'),
      f('posts', 'date_created', 'timestamp', { special: ['date-created'], readonly: true }),
      f('posts', 'author', 'uuid'),
      f('posts', 'cover', 'uuid'),
      f('posts', 'tags', 'alias', { special: ['m2m'] }),
      f('posts', 'seo', 'alias', { interface: 'presentation-divider' }),
      f('posts', 'notes', 'alias'),
      f('authors', 'id', 'uuid', {}, true),
      f('authors', 'name', 'string'),
      f('authors', 'posts', 'alias', { special: ['o2m'] }),
      f('tags', 'id', 'integer', {}, true),
      f('tags', 'label', 'string'),
      f('posts_tags', 'id', 'integer', {}, true),
      f('posts_tags', 'posts_id', 'uuid'),
      f('posts_tags', 'tags_id', 'integer'),
    ],
    relations: [
      r('posts', 'author', 'authors', { one_field: 'posts' }),
      r('posts', 'cover', 'directus_files'),
      r('posts_tags', 'posts_id', 'posts', { one_field: 'tags', junction_field: 'tags_id' }),
      r('posts_tags', 'tags_id', 'tags', { junction_field: 'posts_id' }),
    ],
    permissions: {
      posts: { read: { access: 'full', fields: ['*'] }, update: { access: 'full', fields: ['title'] } },
      authors: { read: { access: 'full', fields: ['*'] } },
      tags: { read: { access: 'full', fields: ['*'] } },
      posts_tags: { read: { access: 'full', fields: ['*'] } },
      directus_files: { read: { access: 'none' } },
    },
  });
});

describe('what forms and lists read', () => {
  it('names items by their template', () => {
    expect(templateFor('posts')).toBe('{{ title }}');
    expect(templateFor('authors')).toBe('{{ name }}');
    expect(templateFor('directus_files')).toBe('{{ title }}');
    expect(displayPaths('tags', 'tags.tags_id.')).toEqual(['tags.tags_id.id', 'tags.tags_id.label']);
  });

  it('reads related items through the fields they show, leaving out what may not be read', () => {
    expect(formPaths('posts')).toEqual(['*', 'author.id', 'author.name', 'tags.id', 'tags.tags_id.id', 'tags.tags_id.label']);
    expect(formPaths('authors')).toEqual(['*', 'posts.id', 'posts.title']);
    session.admin = true;
    expect(formPaths('posts')).toContain('cover.filename_download');
  });

  it('shows visible fields, without the automatic ones when creating', () => {
    expect(formFields('posts', true).map((x) => x.field)).toEqual(['title', 'body', 'data', 'author', 'cover', 'tags', 'seo']);
    expect(formFields('posts', false).map((x) => x.field)).toEqual(['title', 'body', 'data', 'date_created', 'author', 'cover', 'tags', 'seo']);
  });

  it('lists the fields that fit in a cell', () => {
    const columns = listColumns('posts');
    expect(columns.map((x) => x.field)).toEqual(['title', 'date_created', 'author', 'cover']);
    expect(columnPaths('posts', columns)).toEqual(['id', 'title', 'date_created', 'author.id', 'author.name', 'cover']);
  });
});

describe('toPayload', () => {
  it('sends keys for many to one and file fields', () => {
    expect(toPayload(fieldOf('posts', 'author')!, { id: 'a1', name: 'Ada' })).toBe('a1');
    expect(toPayload(fieldOf('posts', 'author')!, 'a2')).toBe('a2');
    expect(toPayload(fieldOf('posts', 'cover')!, null)).toBeNull();
    expect(toPayload(fieldOf('posts', 'title')!, 'Hi')).toBe('Hi');
  });

  it('sends the related keys of a one to many', () => {
    expect(toPayload(fieldOf('authors', 'posts')!, [{ id: 'p1', title: 'x' }, 'p2'])).toEqual(['p1', 'p2']);
  });

  it('keeps junction rows by key and creates rows for new links', () => {
    expect(toPayload(fieldOf('posts', 'tags')!, [{ id: 7, tags_id: { id: 1, label: 'a' } }, { tags_id: { id: 2, label: 'b' } }])).toEqual([7, { tags_id: 2 }]);
  });
});
