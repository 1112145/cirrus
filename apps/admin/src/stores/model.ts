import { templateFields, templateOf } from '../lib/display.ts';
import { keyOf } from '../lib/payload.ts';
import { type Field, FILES, isAlias, isAutomatic, relationOf, type RelationInfo } from '../lib/schema.ts';
import { can, collectionOf, fieldsOf, primaryKeyOf, schema } from './schema.ts';

/** What the screens need to ask for, derived from the data model. */

/** How a collection's items are named (its display template). */
export function templateFor(collection: string): string {
  if (collection === FILES) return '{{ title }}';
  return templateOf(collectionOf(collection), fieldsOf(collection));
}

export const relationFor = (field: Field): RelationInfo | null => relationOf(field, schema.relations);

/** The paths to read for showing related items of `collection`: their key and their template's fields. */
export function displayPaths(collection: string, prefix = ''): string[] {
  const own = collection === FILES ? ['id', 'title', 'type', 'filename_download'] : [primaryKeyOf(collection), ...templateFields(templateFor(collection))];
  return [...new Set(own)].map((p) => `${prefix}${p}`);
}

/**
 * The fields an item form reads: every column, and what relational fields show. Paths into
 * collections the user may not read are left out: the API refuses a read that names them.
 */
export function formPaths(collection: string): string[] {
  const paths = ['*'];
  for (const f of fieldsOf(collection)) {
    const rel = relationFor(f);
    if (!rel || !can(rel.related, 'read')) continue;
    if (rel.kind === 'm2o' || rel.kind === 'file' || rel.kind === 'o2m') paths.push(...displayPaths(rel.related, `${f.field}.`));
    else if (can(rel.junction, 'read')) {
      paths.push(`${f.field}.${primaryKeyOf(rel.junction)}`, ...displayPaths(rel.related, `${f.field}.${rel.junctionField}.`));
    }
  }
  return [...new Set(paths)];
}

/** The fields a form shows: visible ones, without the keys and dates the server sets when creating. */
export function formFields(collection: string, creating: boolean): Field[] {
  return fieldsOf(collection).filter((f) => {
    if (f.meta?.hidden) return false;
    if (creating && isAutomatic(f)) return false;
    if (isAlias(f) && !relationFor(f) && f.meta?.interface !== 'presentation-divider') return false;
    return true;
  });
}

/** Columns of a collection's list: the visible fields that fit in a cell, at most six. */
export function listColumns(collection: string): Field[] {
  const fields = fieldsOf(collection).filter((f) => {
    if (f.meta?.hidden || isAlias(f)) return false;
    return !['json', 'text', 'hash'].includes(f.type) || relationFor(f) !== null;
  });
  return fields.slice(0, 6);
}

/** The paths a list reads for its columns. */
export function columnPaths(collection: string, columns: readonly Field[]): string[] {
  const paths = [primaryKeyOf(collection)];
  for (const f of columns) {
    const rel = relationFor(f);
    if (rel && (rel.kind === 'm2o' || rel.kind === 'file') && can(rel.related, 'read')) paths.push(...displayPaths(rel.related, `${f.field}.`));
    else paths.push(f.field);
  }
  return [...new Set(paths)];
}

/**
 * A form value as the API takes it: keys for M2O and file fields (not the loaded items, which
 * would be nested updates); for an O2M the list of related keys, for an M2M the junction rows to
 * keep (by key) and to create (`{ <junction field>: key }`). Lists replace the related items, so
 * those left out are unlinked.
 */
export function toPayload(field: Field, value: unknown): unknown {
  const rel = relationFor(field);
  if (!rel) return value;
  const key = (v: unknown, collection: string) => keyOf(v, primaryKeyOf(collection));
  if (rel.kind === 'm2o' || rel.kind === 'file') return key(value, rel.related);
  const rows = Array.isArray(value) ? value : [];
  if (rel.kind === 'o2m') return rows.map((r) => key(r, rel.related)).filter((k) => k !== null);
  const junctionPk = primaryKeyOf(rel.junction);
  return rows.map((r) => {
    const own = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)[junctionPk] : r;
    if (own !== undefined && own !== null) return own;
    return { [rel.junctionField]: key((r as Record<string, unknown>)[rel.junctionField], rel.related) };
  });
}
