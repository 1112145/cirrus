import { describe, expect, it } from 'vitest';
import { type Filter, parseFilter, parsePresets, recordVariables, sanitizeQuery, validatePayload, validationMessage } from '../src/index.ts';
import { posts } from './helpers.ts';

const errors = (filter: Filter, row: Record<string, string | number | null>) => validatePayload(posts, filter, row).map((e) => e.type);
const valid = (filter: Filter, row: Record<string, string | number | null>) => validatePayload(posts, filter, row).length === 0;

describe('validatePayload', () => {
  it.each<[string, Filter, Record<string, string | number | null>, boolean]>([
    ['_eq', { status: { _eq: 'draft' } }, { status: 'draft' }, true],
    ['_eq fails', { status: { _eq: 'draft' } }, { status: 'published' }, false],
    ['shorthand', { status: 'draft' }, { status: 'draft' }, true],
    ['_eq null', { title: { _eq: null } }, { title: null }, true],
    ['_neq', { status: { _neq: 'archived' } }, { status: 'draft' }, true],
    ['_neq passes null', { status: { _neq: 'archived' } }, { status: null }, true],
    ['_neq fails', { status: { _neq: 'archived' } }, { status: 'archived' }, false],
    ['_in', { status: { _in: ['draft', 'review'] } }, { status: 'review' }, true],
    ['_in fails', { status: { _in: ['draft', 'review'] } }, { status: 'x' }, false],
    ['_nin', { status: { _nin: ['archived'] } }, { status: 'draft' }, true],
    ['_nin passes null', { status: { _nin: ['archived'] } }, { status: null }, true],
    ['_gt with a numeric string rule', { views: { _gt: '5' } }, { views: 7 }, true],
    ['_gt fails', { views: { _gt: 5 } }, { views: 5 }, false],
    ['_gt fails on null', { views: { _gt: 5 } }, { views: null }, false],
    ['_gte', { views: { _gte: 5 } }, { views: 5 }, true],
    ['_lt', { views: { _lt: 5 } }, { views: 4 }, true],
    ['_lte fails', { views: { _lte: 5 } }, { views: 6 }, false],
    ['_between', { views: { _between: [1, 10] } }, { views: 10 }, true],
    ['_between fails', { views: { _between: [1, 10] } }, { views: 11 }, false],
    ['_nbetween', { views: { _nbetween: [1, 10] } }, { views: 11 }, true],
    ['dates compare as dates', { published_on: { _gte: '2024-01-01' } }, { published_on: '2024-02-01' }, true],
    ['timestamps are normalized', { created_at: { _lt: '2024-01-01' } }, { created_at: '2023-12-31T23:00:00.000Z' }, true],
    ['booleans', { published: { _eq: true } }, { published: 1 }, true],
    ['booleans fail', { published: { _eq: true } }, { published: 0 }, false],
    ['_null', { title: { _null: true } }, { title: null }, true],
    ['_nnull fails', { title: { _nnull: true } }, { title: null }, false],
    ['_empty', { body: { _empty: true } }, { body: '' }, true],
    ['_nempty fails', { body: { _nempty: true } }, { body: '' }, false],
    ['_contains', { title: { _contains: 'ell' } }, { title: 'Hello' }, true],
    ['_contains is case-sensitive', { title: { _contains: 'ELL' } }, { title: 'Hello' }, false],
    ['_icontains', { title: { _icontains: 'ELL' } }, { title: 'Hello' }, true],
    ['_ncontains passes null', { title: { _ncontains: 'x' } }, { title: null }, true],
    ['_starts_with', { title: { _starts_with: 'He' } }, { title: 'Hello' }, true],
    ['_nends_with fails', { title: { _nends_with: 'lo' } }, { title: 'Hello' }, false],
    ['_regex', { title: { _regex: '^[A-Z][a-z]+$' } }, { title: 'Hello' }, true],
    ['_regex in slashes', { title: { _regex: '/^h/' } }, { title: 'Hello' }, false],
    ['several operators all apply', { views: { _gt: 1, _lt: 5 } }, { views: 7 }, false],
  ])('%s', (_, filter, row, expected) => {
    expect(valid(filter, row)).toBe(expected);
  });

  it('skips fields the payload leaves out, except _submitted', () => {
    expect(valid({ title: { _nnull: true }, views: { _gt: 1 } }, {})).toBe(true);
    expect(errors({ title: { _submitted: true } }, {})).toEqual(['required']);
    expect(valid({ title: { _submitted: true } }, { title: null })).toBe(true);
  });

  it('needs every _and branch and one _or branch', () => {
    const rule = { _or: [{ status: { _eq: 'draft' } }, { views: { _eq: 0 } }] };
    expect(valid(rule, { status: 'draft', views: 3 })).toBe(true);
    expect(valid(rule, { status: 'x', views: 0 })).toBe(true);
    expect(errors(rule, { status: 'x', views: 3 })).toEqual(['eq', 'eq']);
    expect(errors({ _and: [{ status: { _eq: 'draft' } }, { views: { _eq: 0 } }] }, { status: 'x', views: 0 })).toEqual(['eq']);
    expect(valid({ _or: [] }, { status: 'x' })).toBe(true);
  });

  it('describes errors like Directus', () => {
    const [e] = validatePayload(posts, { status: { _in: ['draft', 'review'] } }, { status: 'x' });
    expect(e).toEqual({ field: 'status', type: 'in', valid: ['draft', 'review'] });
    expect(validationMessage(e!)).toBe('Validation failed for field "status". Value has to be one of "draft", "review".');
    expect(validationMessage({ field: 'title', type: 'required' })).toBe('Validation failed for field "title". Value is required.');
  });

  it('rejects malformed rules', () => {
    expect(() => validatePayload(posts, { _eq: 1 }, {})).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
    expect(() => validatePayload(posts, { views: { _nope: 1 } }, { views: 1 })).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
    expect(() => validatePayload(posts, { title: { _regex: '(' } }, { title: 'x' })).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
  });
});

describe('dynamic variables', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const vars = {
    now,
    user: 'u1',
    role: 'r2',
    roles: ['r1', 'r2'],
    policies: ['p1'],
    userRecord: { department: 'sales', email_notifications: 1 },
    roleRecord: { name: 'Editor' },
  };

  it('resolves the current user, role, roles, policies and record fields', () => {
    expect(
      parseFilter(
        {
          author: { _eq: '$CURRENT_USER' },
          role: { _eq: '$CURRENT_ROLE' },
          r: { _in: '$CURRENT_ROLES' },
          p: { _in: ['$CURRENT_POLICIES'] },
          d: { _eq: '$CURRENT_USER.department' },
          n: { _eq: '$CURRENT_ROLE.name' },
          x: { _eq: '$CURRENT_USER.nope' },
        },
        vars,
      ),
    ).toEqual({
      author: { _eq: 'u1' },
      role: { _eq: 'r2' },
      r: { _in: ['r1', 'r2'] },
      p: { _in: ['p1'] },
      d: { _eq: 'sales' },
      n: { _eq: 'Editor' },
      x: { _eq: null },
    });
  });

  it('resolves to null and [] without a user', () => {
    const q = sanitizeQuery({ filter: { a: { _eq: '$CURRENT_USER' }, b: { _in: '$CURRENT_ROLES' }, c: '$CURRENT_USER.x' } }, { limitDefault: 100, limitMax: -1, variables: { now } });
    expect(q.filter).toEqual({ a: { _eq: null }, b: { _in: [] }, c: null });
  });

  it('finds the record fields a value refers to', () => {
    const found = recordVariables([{ a: '$CURRENT_USER.department' }, { _or: [{ b: { _eq: '$CURRENT_ROLE.name' } }] }, '$CURRENT_USER']);
    expect([...found.user]).toEqual(['department']);
    expect([...found.role]).toEqual(['name']);
  });

  it('resolves presets', () => {
    expect(parsePresets({ owner: '$CURRENT_USER', status: 'draft', at: '$NOW', tags: ['$CURRENT_ROLE'], n: 1, flag: 'true' }, vars)).toEqual({
      owner: 'u1',
      status: 'draft',
      at: now,
      tags: ['r2'],
      n: 1,
      flag: 'true',
    });
  });
});
