import { describe, expect, it } from 'vitest';
import {
  accessPayload,
  byCollection,
  filterSuggestions,
  fullPermission,
  levelOf,
  newToken,
  objectText,
  parentChoices,
  parseObject,
  type Permission,
  type Role,
  translate,
} from '../src/lib/access.ts';
import { InputError } from '../src/lib/values.ts';

const perm = (extra: Partial<Permission> = {}): Permission => ({
  id: 1,
  policy: 'p',
  collection: 'posts',
  action: 'read',
  permissions: {},
  validation: null,
  presets: null,
  fields: ['*'],
  ...extra,
});

describe('permission levels', () => {
  it('tells none, all and custom apart', () => {
    expect(levelOf(undefined)).toBe('none');
    expect(levelOf(perm())).toBe('all');
    expect(levelOf(perm({ permissions: null, validation: {} }))).toBe('all');
    expect(levelOf(perm({ fields: ['title'] }))).toBe('custom');
    expect(levelOf(perm({ fields: null }))).toBe('custom');
    expect(levelOf(perm({ permissions: { status: { _eq: 'published' } } }))).toBe('custom');
    expect(levelOf(perm({ validation: { title: { _nempty: true } } }))).toBe('custom');
    expect(levelOf(perm({ presets: { status: 'draft' } }))).toBe('custom');
    expect(levelOf(fullPermission('p', 'posts', 'create'))).toBe('all');
  });

  it('groups a policy’s permissions by collection and action, leaving shares out', () => {
    const m = byCollection([perm(), perm({ id: 2, action: 'update' }), perm({ id: 3, collection: 'tags' }), perm({ id: 4, action: 'share' }), perm({ id: 5 })]);
    expect([...m.keys()]).toEqual(['posts', 'tags']);
    expect(m.get('posts')!.read!.id).toBe(1);
    expect(m.get('posts')!.update!.id).toBe(2);
    expect(Object.keys(m.get('posts')!)).toEqual(['read', 'update']);
  });
});

describe('JSON rules', () => {
  it('reads objects, empty as null, and refuses anything else', () => {
    expect(parseObject('  ')).toBeNull();
    expect(parseObject('{"a": {"_eq": 1}}')).toEqual({ a: { _eq: 1 } });
    expect(() => parseObject('[1]', 'The filter')).toThrow('The filter must be a JSON object.');
    expect(() => parseObject('{a', 'The filter')).toThrow(InputError);
    expect(objectText({})).toBe('');
    expect(objectText(null)).toBe('');
    expect(objectText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('suggests filters the collection can use', () => {
    expect(filterSuggestions('posts', ['id', 'title']).map((s) => s.label)).toEqual([]);
    expect(filterSuggestions('posts', ['user_created', 'status'])).toEqual([
      { label: 'Items they created', filter: { user_created: { _eq: '$CURRENT_USER' } } },
      { label: 'Published items', filter: { status: { _eq: 'published' } } },
    ]);
    expect(filterSuggestions('directus_users', [])[0]!.filter).toEqual({ id: { _eq: '$CURRENT_USER' } });
  });
});

describe('roles and policies', () => {
  it('shows the seeded translation keys in English', () => {
    expect(translate('$t:public_label')).toBe('Public');
    expect(translate('$t:something_else')).toBe('something else');
    expect(translate('Editors')).toBe('Editors');
    expect(translate(null)).toBe('');
  });

  it('offers as parents the roles that make no cycle', () => {
    const roles: Role[] = [
      { id: 'a', name: 'A', icon: null, description: null, parent: null },
      { id: 'b', name: 'B', icon: null, description: null, parent: 'a' },
      { id: 'c', name: 'C', icon: null, description: null, parent: 'b' },
      { id: 'd', name: 'D', icon: null, description: null, parent: null },
    ];
    expect(parentChoices(roles, 'b').map((r) => r.id)).toEqual(['a', 'd']);
    expect(parentChoices(roles, 'a').map((r) => r.id)).toEqual(['d']);
    expect(parentChoices(roles, null)).toHaveLength(4);
  });

  it('keeps access rows by key and creates the new ones', () => {
    expect(accessPayload([{ id: 'x', policy: { id: 'p1' } }, { policy: { id: 'p2' } }, { policy: 'p3' }])).toEqual(['x', { policy: 'p2' }, { policy: 'p3' }]);
  });

  it('makes static tokens that are long, random and URL-safe', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newToken()).not.toBe(a);
  });
});
