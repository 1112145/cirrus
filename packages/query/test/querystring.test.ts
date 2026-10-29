import { describe, expect, it } from 'vitest';
import { parseQueryString } from '../src/index.ts';

const parse = (qs: string) => JSON.parse(JSON.stringify(parseQueryString(new URLSearchParams(qs).entries())));

describe('parseQueryString', () => {
  it('reads plain keys', () => {
    expect(parse('fields=id,title&limit=5')).toEqual({ fields: 'id,title', limit: '5' });
  });

  it('turns repeated keys and [] into arrays', () => {
    expect(parse('fields=id&fields=title')).toEqual({ fields: ['id', 'title'] });
    expect(parse('fields[]=id&fields[]=title')).toEqual({ fields: ['id', 'title'] });
  });

  it('nests bracket syntax', () => {
    expect(parse('filter[status][_eq]=published&filter[views][_gt]=10')).toEqual({
      filter: { status: { _eq: 'published' }, views: { _gt: '10' } },
    });
  });

  it('reads indexed keys as arrays, compacting holes', () => {
    expect(parse('filter[_or][0][a][_eq]=1&filter[_or][1][b][_eq]=2&filter[_or][5][c][_null]=true')).toEqual({
      filter: { _or: [{ a: { _eq: '1' } }, { b: { _eq: '2' } }, { c: { _null: 'true' } }] },
    });
    expect(parse('filter[id][_in][]=1&filter[id][_in][]=2')).toEqual({ filter: { id: { _in: ['1', '2'] } } });
  });

  it('takes malformed bracket keys literally', () => {
    expect(parse('a[b=1&c]=2&d[e]f=3')).toEqual({ 'a[b': '1', 'c]': '2', 'd[e]f': '3' });
  });

  it('keeps __proto__ as data', () => {
    const out = parseQueryString(new URLSearchParams('filter[__proto__][x]=1').entries()) as any;
    expect(Object.keys(out.filter)).toEqual(['__proto__']);
    expect(({} as any).x).toBeUndefined();
  });

  it.each(['a=1&a[b]=2', 'a[b]=1&a=2', 'a[0]=1&a[x]=2', 'a[0]=1&a[0]=2'])('rejects conflicting keys: %s', (qs) => {
    expect(() => parse(qs)).toThrow(expect.objectContaining({ code: 'INVALID_QUERY' }));
  });
});
