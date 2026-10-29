import { describe, expect, it } from 'vitest';
import { fallbackLabel, itemRoute, pathOf, systemDisplay } from '../src/lib/system.ts';

describe('system collections', () => {
  it('are read at their own paths, never /items/directus_*', () => {
    expect(pathOf('directus_users')).toBe('/users');
    expect(pathOf('directus_files')).toBe('/files');
    expect(pathOf('directus_roles')).toBe('/roles');
    expect(pathOf('posts')).toBe('/items/posts');
  });

  it('are named by their own templates, with a fallback', () => {
    expect(systemDisplay('directus_users')).toEqual({ template: '{{ first_name }} {{ last_name }}', fields: ['id', 'first_name', 'last_name', 'email', 'avatar'] });
    expect(systemDisplay('posts')).toBeNull();
    expect(fallbackLabel('directus_users', { email: 'a@b.c' })).toBe('a@b.c');
    expect(fallbackLabel('directus_files', { filename_download: 'x.png' })).toBe('x.png');
    expect(fallbackLabel('posts', { email: 'a@b.c' })).toBeNull();
  });

  it('link to their pages in the app', () => {
    expect(itemRoute('directus_users', 'u1')).toBe('/users/u1');
    expect(itemRoute('directus_policies', 'p')).toBe('/settings/policies/p');
    expect(itemRoute('directus_folders', 'f')).toBe('/files?folder=f');
    expect(itemRoute('directus_access', 'a')).toBeNull();
    expect(itemRoute('posts', 'a b')).toBe('/content/posts/a%20b');
  });
});
