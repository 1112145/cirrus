import { describe, expect, it } from 'vitest';
import { fileSize, formatValue, renderTemplate, templateFields, templateOf, valueAt } from '../src/lib/display.ts';
import type { Collection, Field } from '../src/lib/schema.ts';

const field = (name: string, type: Field['type'], extra: Partial<Field> = {}): Field => ({ collection: 'posts', field: name, type, meta: null, schema: null, ...extra });

describe('display templates', () => {
  it('reads the fields a template names', () => {
    expect(templateFields('{{ title }} by {{author.name}} {{ $thumbnail }}')).toEqual(['title', 'author.name']);
  });

  it('fills a template, dropping empty placeholders', () => {
    const item = { title: 'Hello', author: { name: 'Ada' }, tags: ['a', 'b'], draft: true };
    expect(renderTemplate('{{ title }} by {{ author.name }}', item)).toBe('Hello by Ada');
    expect(renderTemplate('{{ title }} {{ missing.path }} ({{ tags }})', item)).toBe('Hello (a, b)');
    expect(renderTemplate('{{ draft }}', item)).toBe('Yes');
    expect(valueAt(item, 'author.name')).toBe('Ada');
    expect(valueAt(item, 'title.length')).toBeNull();
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });

  it("picks a collection's own template, else a title-like field, else the key", () => {
    const pk = field('id', 'uuid', { schema: { is_primary_key: true } as Field['schema'] });
    const collection = (template: string | null) => ({ collection: 'posts', meta: { display_template: template }, schema: {} }) as unknown as Collection;
    expect(templateOf(collection('{{ slug }}'), [pk])).toBe('{{ slug }}');
    expect(templateOf(collection(null), [pk, field('body', 'text'), field('title', 'string')])).toBe('{{ title }}');
    expect(templateOf(collection(null), [pk, field('views', 'integer'), field('body', 'json')])).toBe('{{ views }}');
    expect(templateOf(undefined, [pk])).toBe('{{ id }}');
  });

  it('formats file sizes', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(1536)).toBe('1.5 KB');
    expect(fileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(fileSize(null)).toBe('');
  });
});
