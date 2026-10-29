import { type Collection, type Field, isAlias, isPrimaryKey, sortFields } from './schema.ts';

/**
 * Display templates (Directus `meta.display_template`): text with `{{ path }}` placeholders, such as
 * `{{ title }} by {{ author.name }}`, that names an item in lists and relational fields.
 */

const PLACEHOLDER = /\{\{\s*([\w.$]+)\s*\}\}/g;

/** The field paths a template reads, to ask the API for. */
export function templateFields(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((p) => !p.startsWith('$')))];
}

/** A value at a path in an item: `author.name`. */
export function valueAt(item: unknown, path: string): unknown {
  let v: unknown = item;
  for (const key of path.split('.')) {
    if (v === null || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[key];
  }
  return v ?? null;
}

/** A value as short text. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The template filled in for an item; empty placeholders leave nothing behind. */
export function renderTemplate(template: string, item: unknown): string {
  return template.replace(PLACEHOLDER, (_, path: string) => formatValue(valueAt(item, path))).replace(/\s+/g, ' ').trim();
}

const TEXTUAL = ['string', 'text', 'uuid', 'integer', 'bigInteger'];

/**
 * The template for a collection's items: its own, else its first visible text field (a title or a
 * name, preferably), else its primary key.
 */
export function templateOf(collection: Collection | undefined, fields: readonly Field[]): string {
  const own = collection?.meta?.display_template;
  if (own) return own;
  const visible = sortFields(fields).filter((f) => !isAlias(f) && !f.meta?.hidden && !isPrimaryKey(f));
  const named = visible.find((f) => ['title', 'name', 'label', 'email', 'filename_download'].includes(f.field));
  const first = named ?? visible.find((f) => TEXTUAL.includes(f.type));
  const pk = fields.find(isPrimaryKey);
  return `{{ ${(first ?? pk)?.field ?? 'id'} }}`;
}

/** A file size as people read it: `1.4 MB`. */
export function fileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}
