import { describe, expect, it } from 'vitest';
import { adjustDate, parseQueryString, sanitizeQuery, type SanitizeOptions } from '../src/index.ts';

const NOW = new Date('2024-03-31T12:00:00.000Z');
const opts: SanitizeOptions = { limitDefault: 100, limitMax: 1000, variables: { now: NOW } };
const fromQs = (qs: string, o = opts) => sanitizeQuery(parseQueryString(new URLSearchParams(qs).entries()), o);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const invalid = (fn: () => unknown, reason: string) =>
  expect(fn).toThrow(expect.objectContaining({ code: 'INVALID_QUERY', extensions: { reason } }));

describe('sanitizeQuery', () => {
  it('applies Directus defaults', () => {
    expect(sanitizeQuery({}, opts)).toEqual({
      fields: ['*'],
      filter: null,
      search: null,
      sort: null,
      limit: 100,
      offset: 0,
      meta: [],
    });
  });

  it('reads lists from CSV strings and arrays', () => {
    expect(fromQs('fields=id, title&sort=-views,title').fields).toEqual(['id', 'title']);
    expect(fromQs('fields[]=id&fields[]=title,body').fields).toEqual(['id', 'title', 'body']);
    expect(fromQs('sort=-views,title').sort).toEqual(['-views', 'title']);
    expect(fromQs('fields=').fields).toEqual(['*']);
  });

  it('handles limit, offset and page', () => {
    expect(fromQs('limit=10&offset=5')).toMatchObject({ limit: 10, offset: 5 });
    expect(fromQs('limit=10&page=3')).toMatchObject({ limit: 10, offset: 20 });
    expect(fromQs('limit=10&page=3&offset=1')).toMatchObject({ offset: 20 });
    expect(fromQs('limit=10&page=1&offset=4')).toMatchObject({ offset: 4 });
    expect(sanitizeQuery({ limit: 0 }, opts).limit).toBe(0);
  });

  it('caps limit at the maximum; -1 means the maximum', () => {
    expect(fromQs('limit=-1').limit).toBe(1000);
    expect(fromQs('limit=-1', { ...opts, limitMax: -1 }).limit).toBe(-1);
    expect(fromQs('', { ...opts, limitDefault: 50, limitMax: 20 }).limit).toBe(20);
    invalid(() => fromQs('limit=1001'), '"limit" must be less than or equal to 1000');
  });

  it.each([
    ['limit=abc', '"limit" must be an integer'],
    ['limit=1.5', '"limit" must be an integer'],
    ['limit=-2', '"limit" must be greater than or equal to -1'],
    ['offset=-1', '"offset" must be greater than or equal to 0'],
    ['page=x', '"page" must be an integer'],
    ['meta=count', '"meta" must be "total_count", "filter_count" or "*"'],
    ['search[]=a', '"search" must be a string'],
    ['filter={oops', 'Invalid JSON for filter object'],
    ['filter=[1]', 'Invalid filter object'],
    ['filter={"_and":{"a":1}}', '"_and" has to be an array of filters'],
    ['filter={"_or":[1]}', '"_or[0]" has to be a filter object'],
    ['filter={"id":{"_in":[]}}', '"_in" has to be an array of values'],
    ['filter={"d":{"_gt":"$NOW(%2B1 fortnight)"}}', 'Invalid date adjustment "+1 fortnight" in "$NOW(+1 fortnight)"'],
    ['aggregate[count]=*', '"aggregate" is not supported yet'],
    ['groupBy=status', '"groupBy" is not supported yet'],
    ['alias[t]=title', '"alias" is not supported yet'],
  ])('rejects %s', (qs, reason) => {
    invalid(() => fromQs(qs), reason);
  });

  it('reads meta', () => {
    expect(fromQs('meta=*').meta).toEqual(['total_count', 'filter_count']);
    expect(fromQs('meta=filter_count').meta).toEqual(['filter_count']);
  });

  it('reads search', () => {
    expect(fromQs('search=hello').search).toBe('hello');
    expect(fromQs('search=').search).toBeNull();
  });
});

describe('filters', () => {
  it('parses JSON and bracket syntax to the same filter', () => {
    const json = fromQs(`filter=${encodeURIComponent('{"_or":[{"status":{"_eq":"published"}},{"views":{"_gt":"10"}}]}')}`);
    const brackets = fromQs('filter[_or][0][status][_eq]=published&filter[_or][1][views][_gt]=10');
    expect(plain(brackets.filter)).toEqual(plain(json.filter));
  });

  it('reads true/false/null strings as values and splits lists', () => {
    const q = fromQs('filter[a][_eq]=true&filter[b][_null]=false&filter[c][_eq]=null&filter[id][_in]=1,2,3&filter[d][_between]=1,5');
    expect(plain(q.filter)).toEqual({
      a: { _eq: true },
      b: { _null: false },
      c: { _eq: null },
      id: { _in: ['1', '2', '3'] },
      d: { _between: ['1', '5'] },
    });
  });

  it('resolves $NOW, with adjustments', () => {
    const q = fromQs(`filter=${encodeURIComponent('{"a":{"_lt":"$NOW"},"b":{"_gt":"$NOW(-1 month)"},"c":"$NOW()"}')}`);
    const f = q.filter as any;
    expect(f.a._lt).toEqual(NOW);
    expect(f.b._gt).toEqual(new Date('2024-02-29T12:00:00.000Z'));
    expect(f.c).toEqual(NOW);
  });

  it('refuses filters nested too deeply', () => {
    let filter: Record<string, unknown> = { a: { _eq: 1 } };
    for (let i = 0; i < 40; i++) filter = { _and: [filter] };
    invalid(() => sanitizeQuery({ filter }, opts), 'The filter is nested too deeply');
  });

  it('resolves user variables to nothing without a user', () => {
    const q = fromQs(`filter=${encodeURIComponent('{"owner":{"_eq":"$CURRENT_USER"},"role":{"_in":"$CURRENT_ROLES"},"x":"$CURRENT_USER.email"}')}`);
    expect(plain(q.filter)).toEqual({ owner: { _eq: null }, role: { _in: [] }, x: null });
  });
});

describe('adjustDate', () => {
  const base = new Date('2024-01-31T10:00:00.000Z');
  it.each([
    ['+1 day', '2024-02-01T10:00:00.000Z'],
    ['-2 hours', '2024-01-31T08:00:00.000Z'],
    ['1 month', '2024-02-29T10:00:00.000Z'],
    ['-1 year', '2023-01-31T10:00:00.000Z'],
    ['+1y', '2025-01-31T10:00:00.000Z'],
    ['3 weeks', '2024-02-21T10:00:00.000Z'],
    ['30 min', '2024-01-31T10:30:00.000Z'],
    ['-15 s', '2024-01-31T09:59:45.000Z'],
  ])('%s', (adjustment, expected) => {
    expect(adjustDate(base, adjustment)?.toISOString()).toBe(expected);
  });

  it('rejects unknown units', () => {
    expect(adjustDate(base, '1 fortnight')).toBeNull();
    expect(adjustDate(base, 'soon')).toBeNull();
  });
});
