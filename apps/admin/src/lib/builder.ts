import { FILES, type FieldType } from './schema.ts';

/**
 * Data model changes as the Directus app makes them: a new collection or field becomes a list of
 * API calls (collections, fields, relations) that run in order. Pure, so the plans are tested on
 * their own; `stores/builder.ts` runs them.
 */

type Json = Record<string, unknown>;

export type Step =
  | { op: 'createCollection'; payload: Json }
  | { op: 'createField'; collection: string; payload: Json }
  | { op: 'createRelation'; payload: Json };

// Collections ------------------------------------------------------------------------------------

export type PrimaryKeyKind = 'uuid' | 'integer' | 'string';

export const PRIMARY_KEYS: Array<{ kind: PrimaryKeyKind; label: string; hint: string }> = [
  { kind: 'uuid', label: 'Generated UUID', hint: 'Unique, hard to guess; the server sets it.' },
  { kind: 'integer', label: 'Auto-increment integer', hint: '1, 2, 3…; the server sets it.' },
  { kind: 'string', label: 'Manual string', hint: 'Typed in when creating an item (slugs, codes).' },
];

/** Fields most collections want, set or kept by the server (the Directus app's "optional system fields"). */
export type OptionalField = 'status' | 'sort' | 'user_created' | 'date_created' | 'user_updated' | 'date_updated';

export const OPTIONAL_FIELDS: Array<{ field: OptionalField; label: string }> = [
  { field: 'status', label: 'Status (published, draft, archived)' },
  { field: 'sort', label: 'Sort (manual order)' },
  { field: 'date_created', label: 'Date created' },
  { field: 'user_created', label: 'User created' },
  { field: 'date_updated', label: 'Date updated' },
  { field: 'user_updated', label: 'User updated' },
];

function primaryKey(field: string, kind: PrimaryKeyKind): Json {
  switch (kind) {
    case 'uuid':
      return { field, type: 'uuid', meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] }, schema: { is_primary_key: true } };
    case 'integer':
      return { field, type: 'integer', meta: { hidden: true, readonly: true, interface: 'input' }, schema: { is_primary_key: true, has_auto_increment: true } };
    case 'string':
      return { field, type: 'string', meta: { interface: 'input', required: true }, schema: { is_primary_key: true } };
  }
}

const OPTIONAL: Record<OptionalField, Json> = {
  status: {
    field: 'status',
    type: 'string',
    meta: {
      width: 'full',
      interface: 'select-dropdown',
      display: 'labels',
      options: {
        choices: [
          { text: 'Published', value: 'published' },
          { text: 'Draft', value: 'draft' },
          { text: 'Archived', value: 'archived' },
        ],
      },
    },
    schema: { default_value: 'draft', is_nullable: false },
  },
  sort: { field: 'sort', type: 'integer', meta: { interface: 'input', hidden: true }, schema: {} },
  user_created: {
    field: 'user_created',
    type: 'uuid',
    meta: { special: ['user-created'], interface: 'select-dropdown-m2o', display: 'user', readonly: true, hidden: true, width: 'half' },
    schema: {},
  },
  date_created: {
    field: 'date_created',
    type: 'timestamp',
    meta: { special: ['date-created'], interface: 'datetime', display: 'datetime', readonly: true, hidden: true, width: 'half' },
    schema: {},
  },
  user_updated: {
    field: 'user_updated',
    type: 'uuid',
    meta: { special: ['user-updated'], interface: 'select-dropdown-m2o', display: 'user', readonly: true, hidden: true, width: 'half' },
    schema: {},
  },
  date_updated: {
    field: 'date_updated',
    type: 'timestamp',
    meta: { special: ['date-updated'], interface: 'datetime', display: 'datetime', readonly: true, hidden: true, width: 'half' },
    schema: {},
  },
};

export type NewCollection = {
  name: string;
  primaryKey: { field: string; kind: PrimaryKeyKind };
  singleton?: boolean;
  note?: string | null;
  optional?: OptionalField[];
};

export function collectionPlan(c: NewCollection): Step[] {
  const optional = OPTIONAL_FIELDS.map((o) => o.field).filter((f) => c.optional?.includes(f));
  const fields = [primaryKey(c.primaryKey.field, c.primaryKey.kind), ...optional.map((f) => structuredClone(OPTIONAL[f]))];
  const meta: Json = { singleton: c.singleton ?? false, note: c.note || null };
  if (optional.includes('sort')) meta.sort_field = 'sort';
  if (optional.includes('status')) Object.assign(meta, { archive_field: 'status', archive_value: 'archived', unarchive_value: 'draft' });
  const steps: Step[] = [{ op: 'createCollection', payload: { collection: c.name, meta, schema: {}, fields } }];
  for (const f of ['user_created', 'user_updated'] as const) {
    if (optional.includes(f)) {
      steps.push({ op: 'createRelation', payload: { collection: c.name, field: f, related_collection: 'directus_users', schema: { on_delete: 'SET NULL' } } });
    }
  }
  return steps;
}

// Fields -----------------------------------------------------------------------------------------

export type FieldKind =
  | 'string'
  | 'text'
  | 'markdown'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'timestamp'
  | 'date'
  | 'select'
  | 'tags'
  | 'json'
  | 'image'
  | 'file'
  | 'm2o'
  | 'o2m'
  | 'm2m'
  | 'divider';

export type KindGroup = 'Text & numbers' | 'Choices & dates' | 'Files' | 'Relations' | 'Layout';

export const FIELD_KINDS: Array<{ kind: FieldKind; label: string; hint: string; group: KindGroup }> = [
  { kind: 'string', label: 'Text', hint: 'A single line of text', group: 'Text & numbers' },
  { kind: 'text', label: 'Long text', hint: 'Several lines of plain text', group: 'Text & numbers' },
  { kind: 'markdown', label: 'Markdown', hint: 'Formatted text, written in Markdown', group: 'Text & numbers' },
  { kind: 'integer', label: 'Whole number', hint: '42', group: 'Text & numbers' },
  { kind: 'float', label: 'Decimal number', hint: '3.14', group: 'Text & numbers' },
  { kind: 'boolean', label: 'Toggle', hint: 'On or off', group: 'Choices & dates' },
  { kind: 'select', label: 'Dropdown', hint: 'One of a list of choices', group: 'Choices & dates' },
  { kind: 'tags', label: 'Tags', hint: 'A list of words', group: 'Choices & dates' },
  { kind: 'timestamp', label: 'Date & time', hint: 'A moment, stored in UTC', group: 'Choices & dates' },
  { kind: 'date', label: 'Date', hint: 'A day', group: 'Choices & dates' },
  { kind: 'json', label: 'JSON', hint: 'Any structured data', group: 'Choices & dates' },
  { kind: 'image', label: 'Image', hint: 'An image from the file library', group: 'Files' },
  { kind: 'file', label: 'File', hint: 'Any file from the file library', group: 'Files' },
  { kind: 'm2o', label: 'Many to one', hint: 'One item of another collection (a post’s author)', group: 'Relations' },
  { kind: 'o2m', label: 'One to many', hint: 'The items of another collection pointing here (an author’s posts)', group: 'Relations' },
  { kind: 'm2m', label: 'Many to many', hint: 'Any number of items of another collection (a post’s tags)', group: 'Relations' },
  { kind: 'divider', label: 'Divider', hint: 'A heading between fields in the form', group: 'Layout' },
];

export const isRelational = (kind: FieldKind) => kind === 'm2o' || kind === 'o2m' || kind === 'm2m';

export type Choice = { text: string; value: string };

export type NewField = {
  collection: string;
  field: string;
  kind: FieldKind;
  required?: boolean;
  note?: string | null;
  width?: 'full' | 'half';
  unique?: boolean;
  /** The default value, as the API takes it. */
  defaultValue?: unknown;
  choices?: Choice[];
  /** m2o, o2m, m2m: the other collection. */
  related?: string;
  /** m2o: an O2M alias to create on the related collection (optional). */
  reverse?: string | null;
  /** o2m: the field to create on the related collection, holding this collection's keys. */
  foreignKey?: string;
  /** m2m: the junction collection to create. */
  junction?: string;
};

/** What a field of a collection's primary key type stores: integers for integer keys, else the same type. */
export const keyFieldType = (pkType: FieldType): FieldType => (pkType === 'bigInteger' ? 'bigInteger' : pkType === 'integer' ? 'integer' : pkType);

/** The names a many to many's junction gets by default (Directus' naming). */
export function junctionNames(collection: string, related: string) {
  const self = collection === related;
  return {
    junction: `${collection}_${self ? 'related_' : ''}${related}`.slice(0, 64),
    here: `${collection}_id`,
    there: self ? `related_${related}_id` : `${related}_id`,
  };
}

function baseMeta(f: NewField): Json {
  const meta: Json = { width: f.width ?? 'full', note: f.note || null };
  if (f.required) meta.required = true;
  return meta;
}

/**
 * The steps that create a field. `keyType` gives a collection's primary key type, for fields
 * holding its keys.
 */
export function fieldPlan(f: NewField, keyType: (collection: string) => FieldType): Step[] {
  const meta = baseMeta(f);
  const schema: Json = {};
  if (f.unique) schema.is_unique = true;
  if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') schema.default_value = f.defaultValue;
  const field = (type: FieldType, extra: Json, s: Json | null = schema): Step => ({
    op: 'createField',
    collection: f.collection,
    payload: { field: f.field, type, meta: { ...meta, ...extra }, schema: type === 'alias' ? null : s },
  });

  switch (f.kind) {
    case 'string':
      return [field('string', { interface: 'input' })];
    case 'text':
      return [field('text', { interface: 'input-multiline' })];
    case 'markdown':
      return [field('text', { interface: 'input-rich-text-md' })];
    case 'integer':
      return [field('integer', { interface: 'input' })];
    case 'float':
      return [field('float', { interface: 'input' })];
    case 'boolean':
      return [field('boolean', { interface: 'boolean', special: ['cast-boolean'] }, { ...schema, default_value: f.defaultValue ?? false })];
    case 'timestamp':
      return [field('timestamp', { interface: 'datetime' })];
    case 'date':
      return [field('date', { interface: 'datetime' })];
    case 'select':
      return [field('string', { interface: 'select-dropdown', display: 'labels', options: { choices: f.choices ?? [] } })];
    case 'tags':
      return [field('json', { interface: 'tags', special: ['cast-json'] })];
    case 'json':
      return [field('json', { interface: 'input-code', special: ['cast-json'], options: { language: 'json' } })];
    case 'image':
    case 'file':
      return [
        field(keyType(FILES), { interface: f.kind === 'image' ? 'file-image' : 'file', special: ['file'] }),
        { op: 'createRelation', payload: { collection: f.collection, field: f.field, related_collection: FILES, schema: { on_delete: 'SET NULL' } } },
      ];
    case 'divider':
      return [field('alias', { interface: 'presentation-divider', special: ['alias', 'no-data'], width: 'full' })];
    case 'm2o': {
      const related = need(f.related, 'related');
      const steps: Step[] = [field(keyFieldType(keyType(related)), { interface: 'select-dropdown-m2o', special: ['m2o'] })];
      if (f.reverse) {
        steps.push({ op: 'createField', collection: related, payload: { field: f.reverse, type: 'alias', meta: { interface: 'list-o2m', special: ['o2m'] }, schema: null } });
      }
      steps.push({
        op: 'createRelation',
        payload: { collection: f.collection, field: f.field, related_collection: related, meta: { one_field: f.reverse || null }, schema: { on_delete: 'SET NULL' } },
      });
      return steps;
    }
    case 'o2m': {
      const related = need(f.related, 'related');
      const fk = need(f.foreignKey, 'foreignKey');
      return [
        { op: 'createField', collection: related, payload: { field: fk, type: keyFieldType(keyType(f.collection)), meta: { interface: 'select-dropdown-m2o', special: ['m2o'] }, schema: {} } },
        field('alias', { interface: 'list-o2m', special: ['o2m'] }),
        {
          op: 'createRelation',
          payload: { collection: related, field: fk, related_collection: f.collection, meta: { one_field: f.field, one_deselect_action: 'nullify' }, schema: { on_delete: 'SET NULL' } },
        },
      ];
    }
    case 'm2m': {
      const related = need(f.related, 'related');
      const names = junctionNames(f.collection, related);
      const junction = f.junction || names.junction;
      const hidden = { hidden: true, interface: 'input' };
      return [
        {
          op: 'createCollection',
          payload: {
            collection: junction,
            meta: { hidden: true, icon: 'import_export' },
            schema: {},
            fields: [
              { field: 'id', type: 'integer', meta: { hidden: true }, schema: { is_primary_key: true, has_auto_increment: true } },
              { field: names.here, type: keyFieldType(keyType(f.collection)), meta: hidden, schema: {} },
              { field: names.there, type: keyFieldType(keyType(related)), meta: hidden, schema: {} },
            ],
          },
        },
        field('alias', { interface: 'list-m2m', special: ['m2m'] }),
        {
          op: 'createRelation',
          payload: {
            collection: junction,
            field: names.here,
            related_collection: f.collection,
            meta: { one_field: f.field, junction_field: names.there, one_deselect_action: 'delete' },
            schema: { on_delete: 'CASCADE' },
          },
        },
        {
          op: 'createRelation',
          payload: { collection: junction, field: names.there, related_collection: related, meta: { one_field: null, junction_field: names.here }, schema: { on_delete: 'CASCADE' } },
        },
      ];
    }
  }
}

function need<T>(v: T | undefined | null, name: string): T {
  if (v === undefined || v === null || v === '') throw new Error(`"${name}" is required for this kind of field`);
  return v;
}

/** Choices from text, one per line: `value` or `value: Text`. */
export function parseChoices(text: string): Choice[] {
  const out: Choice[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    const value = (i >= 0 ? s.slice(0, i) : s).trim();
    const label = (i >= 0 ? s.slice(i + 1) : '').trim();
    if (value && !out.some((c) => c.value === value)) out.push({ value, text: label || value });
  }
  return out;
}

/** Choices back to text, for editing. */
export const choicesText = (choices: unknown): string =>
  Array.isArray(choices)
    ? choices
        .map((c) => (typeof c === 'object' && c !== null ? (c as { value?: unknown; text?: unknown }) : { value: c, text: c }))
        .map((c) => (c.text !== undefined && String(c.text) !== String(c.value) ? `${String(c.value)}: ${String(c.text)}` : String(c.value)))
        .join('\n')
    : '';

/** The order of a collection's fields after moving one up or down: their new `meta.sort`, for those that change. */
export function reorder(fields: ReadonlyArray<{ field: string; sort: number | null }>, field: string, delta: -1 | 1): Array<{ field: string; sort: number }> {
  const list = [...fields];
  const i = list.findIndex((f) => f.field === field);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j]!, list[i]!];
  return list.map((f, k) => ({ field: f.field, sort: k + 1 })).filter((f, k) => fields.find((x) => x.field === f.field)!.sort !== k + 1);
}
