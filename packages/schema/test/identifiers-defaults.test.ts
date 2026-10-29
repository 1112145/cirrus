import { describe, expect, it } from 'vitest';
import {
  assertCollectionName,
  assertFieldName,
  defaultSql,
  NOW,
  normalizeDefault,
  quoteIdent,
  sameName,
} from '../src/index.ts';

describe('identifiers', () => {
  it('accepts letters, digits and underscores starting with a letter', () => {
    for (const name of ['posts', 'Posts', 'blog_posts2', 'a', 'x'.repeat(64)]) {
      expect(() => assertCollectionName(name)).not.toThrow();
      expect(() => assertFieldName(name)).not.toThrow();
    }
  });

  it('rejects anything else', () => {
    for (const name of ['', '1posts', '_posts', 'blog-posts', 'a.b', 'a b', 'a"b', 'x'.repeat(65), 42, null, undefined]) {
      expect(() => assertCollectionName(name)).toThrow(/Invalid payload\. Collection name .* is invalid/);
      expect(() => assertFieldName(name)).toThrow(/Invalid payload\. Field name .* is invalid/);
    }
  });

  it('reserves system prefixes, case-insensitively', () => {
    expect(() => assertCollectionName('cirrus_users')).toThrow(`Collections can't start with "cirrus_"`);
    expect(() => assertCollectionName('CIRRUS_users')).toThrow(`Collections can't start with "cirrus_"`);
    expect(() => assertCollectionName('directus_users')).toThrow(`Collections can't start with "directus_"`);
    expect(() => assertCollectionName('Sqlite_master')).toThrow(`Collections can't start with "sqlite_"`);
  });

  it('reserves rowid aliases as field names', () => {
    expect(() => assertFieldName('rowid')).toThrow('Field name "rowid" is reserved');
    expect(() => assertFieldName('OID')).toThrow('Field name "OID" is reserved');
  });

  it('quotes identifiers and compares them case-insensitively', () => {
    expect(quoteIdent('posts')).toBe('"posts"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(sameName('Posts', 'posts')).toBe(true);
  });
});

describe('normalizeDefault', () => {
  it('passes null through', () => {
    expect(normalizeDefault('string', null)).toBeNull();
    expect(normalizeDefault('alias', undefined)).toBeNull();
  });

  it('integers', () => {
    expect(normalizeDefault('integer', 5)).toBe(5);
    expect(normalizeDefault('integer', '-12')).toBe(-12);
    expect(normalizeDefault('bigInteger', '9007199254740993')).toBe('9007199254740993');
    expect(() => normalizeDefault('integer', 1.5)).toThrow('must be an integer');
    expect(() => normalizeDefault('integer', '1; DROP TABLE x')).toThrow('must be an integer');
  });

  it('floats', () => {
    expect(normalizeDefault('float', '1.5')).toBe(1.5);
    expect(normalizeDefault('decimal', 2)).toBe(2);
    expect(() => normalizeDefault('float', Number.NaN)).toThrow('must be a number');
    expect(() => normalizeDefault('float', 'abc')).toThrow('must be a number');
  });

  it('booleans', () => {
    expect(normalizeDefault('boolean', true)).toBe(true);
    expect(normalizeDefault('boolean', 'false')).toBe(false);
    expect(normalizeDefault('boolean', 1)).toBe(true);
    expect(() => normalizeDefault('boolean', 'yes')).toThrow('must be a boolean');
  });

  it('temporal fields accept CURRENT_TIMESTAMP and now()', () => {
    expect(normalizeDefault('timestamp', 'now()')).toBe(NOW);
    expect(normalizeDefault('dateTime', 'CURRENT_TIMESTAMP')).toBe(NOW);
    expect(normalizeDefault('date', '2026-01-01')).toBe('2026-01-01');
    // not special for other types
    expect(normalizeDefault('string', 'now()')).toBe('now()');
  });

  it('strings, uuids and json', () => {
    expect(normalizeDefault('string', "it's")).toBe("it's");
    expect(() => normalizeDefault('string', 5)).toThrow('must be a string');
    expect(() => normalizeDefault('string', 'a\u0000b')).toThrow('must be a string');
    expect(() => normalizeDefault('uuid', 'nope')).toThrow('must be a UUID');
    expect(normalizeDefault('json', { a: [1] })).toEqual({ a: [1] });
  });

  it('aliases have no default', () => {
    expect(() => normalizeDefault('alias', 'x')).toThrow("Alias fields can't have a default value");
  });
});

describe('defaultSql', () => {
  it('renders literals safely', () => {
    expect(defaultSql('string', "it's")).toBe("'it''s'");
    expect(defaultSql('integer', -3)).toBe('-3');
    expect(defaultSql('bigInteger', '9007199254740993')).toBe('9007199254740993');
    expect(defaultSql('boolean', false)).toBe('0');
    expect(defaultSql('json', { a: "'" })).toBe(`'{"a":"''"}'`);
    expect(defaultSql('json', 'text')).toBe(`'"text"'`);
    expect(defaultSql('string', null)).toBeNull();
  });

  it('renders the current time per temporal type', () => {
    expect(defaultSql('timestamp', NOW)).toBe("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    expect(defaultSql('date', NOW)).toBe("(date('now'))");
  });
});
