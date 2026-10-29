import { describe, expect, it } from 'vitest';
import { choicesText, collectionPlan, fieldPlan, junctionNames, keyFieldType, parseChoices, reorder } from '../src/lib/builder.ts';
import type { FieldType } from '../src/lib/schema.ts';

const keys: Record<string, FieldType> = { posts: 'uuid', authors: 'uuid', tags: 'integer', directus_files: 'uuid', directus_users: 'uuid' };
const keyType = (c: string) => keys[c]!;

describe('collectionPlan', () => {
  it('creates the table with its key and the optional fields', () => {
    const steps = collectionPlan({ name: 'posts', primaryKey: { field: 'id', kind: 'uuid' }, optional: ['status', 'sort', 'user_created', 'date_created'] });
    expect(steps[0]).toMatchObject({
      op: 'createCollection',
      payload: {
        collection: 'posts',
        schema: {},
        meta: { singleton: false, sort_field: 'sort', archive_field: 'status', archive_value: 'archived', unarchive_value: 'draft' },
      },
    });
    const fields = (steps[0]!.payload.fields as Array<{ field: string; type: string; schema: Record<string, unknown> }>).map((f) => `${f.field}:${f.type}`);
    // In the order the dialog lists them, whatever order they were picked in.
    expect(fields).toEqual(['id:uuid', 'status:string', 'sort:integer', 'date_created:timestamp', 'user_created:uuid']);
    expect(steps.slice(1)).toEqual([
      { op: 'createRelation', payload: { collection: 'posts', field: 'user_created', related_collection: 'directus_users', schema: { on_delete: 'SET NULL' } } },
    ]);
  });

  it('supports integer and manual keys, and singletons', () => {
    const [int] = collectionPlan({ name: 'tags', primaryKey: { field: 'id', kind: 'integer' } });
    expect((int!.payload.fields as unknown[])[0]).toMatchObject({ type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } });
    const [slug] = collectionPlan({ name: 'pages', primaryKey: { field: 'slug', kind: 'string' }, singleton: true });
    expect(slug!.payload).toMatchObject({ meta: { singleton: true }, fields: [{ field: 'slug', type: 'string', schema: { is_primary_key: true } }] });
  });

  it("doesn't share the optional fields' definitions between plans", () => {
    const [a] = collectionPlan({ name: 'a', primaryKey: { field: 'id', kind: 'uuid' }, optional: ['status'] });
    ((a!.payload.fields as Array<{ meta: Record<string, unknown> }>)[1]!.meta).note = 'changed';
    const [b] = collectionPlan({ name: 'b', primaryKey: { field: 'id', kind: 'uuid' }, optional: ['status'] });
    expect((b!.payload.fields as Array<{ meta: Record<string, unknown> }>)[1]!.meta.note).toBeUndefined();
  });
});

describe('fieldPlan', () => {
  it('creates plain fields with their interface and column options', () => {
    expect(fieldPlan({ collection: 'posts', field: 'title', kind: 'string', required: true, unique: true, defaultValue: 'Untitled', width: 'half' }, keyType)).toEqual([
      {
        op: 'createField',
        collection: 'posts',
        payload: {
          field: 'title',
          type: 'string',
          meta: { width: 'half', note: null, required: true, interface: 'input' },
          schema: { is_unique: true, default_value: 'Untitled' },
        },
      },
    ]);
    expect(fieldPlan({ collection: 'posts', field: 'on', kind: 'boolean' }, keyType)[0]!).toMatchObject({ payload: { type: 'boolean', schema: { default_value: false } } });
    expect(fieldPlan({ collection: 'posts', field: 'status', kind: 'select', choices: [{ text: 'Draft', value: 'draft' }] }, keyType)[0]!).toMatchObject({
      payload: { type: 'string', meta: { interface: 'select-dropdown', options: { choices: [{ text: 'Draft', value: 'draft' }] } } },
    });
    expect(fieldPlan({ collection: 'posts', field: 'seo', kind: 'divider' }, keyType)[0]!).toMatchObject({
      payload: { type: 'alias', schema: null, meta: { interface: 'presentation-divider', special: ['alias', 'no-data'] } },
    });
  });

  it('creates an image field with its relation to the file library', () => {
    expect(fieldPlan({ collection: 'posts', field: 'cover', kind: 'image' }, keyType)).toEqual([
      { op: 'createField', collection: 'posts', payload: { field: 'cover', type: 'uuid', meta: { width: 'full', note: null, interface: 'file-image', special: ['file'] }, schema: {} } },
      { op: 'createRelation', payload: { collection: 'posts', field: 'cover', related_collection: 'directus_files', schema: { on_delete: 'SET NULL' } } },
    ]);
  });

  it('creates a many to one, with the field listing them on the other side if asked', () => {
    const steps = fieldPlan({ collection: 'posts', field: 'tag', kind: 'm2o', related: 'tags', reverse: 'posts' }, keyType);
    expect(steps.map((s) => s.op)).toEqual(['createField', 'createField', 'createRelation']);
    expect(steps[0]).toMatchObject({ collection: 'posts', payload: { field: 'tag', type: 'integer', meta: { special: ['m2o'] } } });
    expect(steps[1]).toMatchObject({ collection: 'tags', payload: { field: 'posts', type: 'alias', meta: { special: ['o2m'] } } });
    expect(steps[2]).toMatchObject({ payload: { collection: 'posts', field: 'tag', related_collection: 'tags', meta: { one_field: 'posts' } } });
    expect(fieldPlan({ collection: 'posts', field: 'author', kind: 'm2o', related: 'authors' }, keyType)).toHaveLength(2);
  });

  it('creates a one to many: the key field on the other side, then the alias, then the relation', () => {
    const steps = fieldPlan({ collection: 'authors', field: 'posts', kind: 'o2m', related: 'posts', foreignKey: 'authors_id' }, keyType);
    expect(steps).toEqual([
      { op: 'createField', collection: 'posts', payload: { field: 'authors_id', type: 'uuid', meta: { interface: 'select-dropdown-m2o', special: ['m2o'] }, schema: {} } },
      { op: 'createField', collection: 'authors', payload: { field: 'posts', type: 'alias', meta: { width: 'full', note: null, interface: 'list-o2m', special: ['o2m'] }, schema: null } },
      {
        op: 'createRelation',
        payload: { collection: 'posts', field: 'authors_id', related_collection: 'authors', meta: { one_field: 'posts', one_deselect_action: 'nullify' }, schema: { on_delete: 'SET NULL' } },
      },
    ]);
  });

  it('creates a many to many through a new junction collection', () => {
    const steps = fieldPlan({ collection: 'posts', field: 'tags', kind: 'm2m', related: 'tags' }, keyType);
    expect(steps.map((s) => s.op)).toEqual(['createCollection', 'createField', 'createRelation', 'createRelation']);
    expect(steps[0]!.payload).toMatchObject({
      collection: 'posts_tags',
      meta: { hidden: true },
      fields: [
        { field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } },
        { field: 'posts_id', type: 'uuid' },
        { field: 'tags_id', type: 'integer' },
      ],
    });
    expect(steps[2]!.payload).toMatchObject({
      collection: 'posts_tags',
      field: 'posts_id',
      related_collection: 'posts',
      meta: { one_field: 'tags', junction_field: 'tags_id', one_deselect_action: 'delete' },
      schema: { on_delete: 'CASCADE' },
    });
    expect(steps[3]!.payload).toMatchObject({ collection: 'posts_tags', field: 'tags_id', related_collection: 'tags', meta: { one_field: null, junction_field: 'posts_id' } });
  });

  it('names a self-referencing junction apart', () => {
    expect(junctionNames('posts', 'posts')).toEqual({ junction: 'posts_related_posts', here: 'posts_id', there: 'related_posts_id' });
    expect(keyFieldType('bigInteger')).toBe('bigInteger');
  });

  it('needs the related collection of a relation', () => {
    expect(() => fieldPlan({ collection: 'posts', field: 'x', kind: 'm2o' }, keyType)).toThrow(/related/);
    expect(() => fieldPlan({ collection: 'posts', field: 'x', kind: 'o2m', related: 'tags' }, keyType)).toThrow(/foreignKey/);
  });
});

describe('choices', () => {
  it('reads one choice per line, with optional text', () => {
    expect(parseChoices('draft: Draft\n\npublished\n draft \nweird: a: b')).toEqual([
      { value: 'draft', text: 'Draft' },
      { value: 'published', text: 'published' },
      { value: 'weird', text: 'a: b' },
    ]);
    expect(choicesText([{ value: 'draft', text: 'Draft' }, { value: 'x', text: 'x' }, 'plain'])).toBe('draft: Draft\nx\nplain');
    expect(choicesText(null)).toBe('');
  });
});

describe('reorder', () => {
  const fields = [
    { field: 'id', sort: 1 },
    { field: 'title', sort: 2 },
    { field: 'body', sort: 3 },
  ];
  it('swaps a field with its neighbour and renumbers what changed', () => {
    expect(reorder(fields, 'body', -1)).toEqual([
      { field: 'body', sort: 2 },
      { field: 'title', sort: 3 },
    ]);
    expect(reorder(fields, 'id', -1)).toEqual([]);
    expect(reorder(fields, 'body', 1)).toEqual([]);
  });

  it('numbers fields that had no sort yet', () => {
    expect(reorder([{ field: 'a', sort: null }, { field: 'b', sort: null }], 'b', -1)).toEqual([
      { field: 'b', sort: 1 },
      { field: 'a', sort: 2 },
    ]);
  });
});
