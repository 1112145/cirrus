import { describe, expect, it } from 'vitest';
import { formatTemporal, fromDbValue, normalizeTemporal, toDbValue, ValueMismatch } from '../src/index.ts';

const mismatch = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValueMismatch);
    return (e as ValueMismatch).expected;
  }
  throw new Error('expected a ValueMismatch');
};

describe('toDbValue', () => {
  it.each([
    ['string', 'abc', 'abc'],
    ['string', 42, '42'],
    ['text', true, 'true'],
    ['uuid', '0190F5B2-8C4A-7B3E-9F00-000000000001', '0190f5b2-8c4a-7b3e-9f00-000000000001'],
    ['uuid', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'],
    ['csv', ['a', 'b', 3], 'a,b,3'],
    ['csv', 'x,y', 'x,y'],
    ['integer', 7, 7],
    ['integer', '-12', -12],
    ['bigInteger', 9007199254740991, 9007199254740991],
    ['float', '1.5', 1.5],
    ['decimal', 2, 2],
    ['boolean', true, 1],
    ['boolean', 'false', 0],
    ['boolean', 1, 1],
    ['json', { a: [1, 2] }, '{"a":[1,2]}'],
    ['json', '[1,2]', '[1,2]'],
    ['json', 'hello', '"hello"'],
    ['json', 3, '3'],
    ['timestamp', '2024-03-01T10:20:30Z', '2024-03-01T10:20:30.000Z'],
    ['timestamp', '2024-03-01T10:20:30.5+02:00', '2024-03-01T08:20:30.500Z'],
    ['timestamp', '2024-03-01', '2024-03-01T00:00:00.000Z'],
    ['timestamp', '2024-03-01 10:20', '2024-03-01T10:20:00.000Z'],
    ['dateTime', '2024-03-01 10:20:30.123', '2024-03-01T10:20:30'],
    ['dateTime', '2024-03-01T23:30:00-01:00', '2024-03-02T00:30:00'],
    ['dateTime', '2024-03-01', '2024-03-01T00:00:00'],
    ['date', '2024-02-29', '2024-02-29'],
    ['date', '2024-02-29T23:00:00+05:00', '2024-02-29'],
    ['time', '09:05', '09:05:00'],
    ['time', '23:59:59.999', '23:59:59'],
  ] as const)('%s %j → %j', (type, input, expected) => {
    expect(toDbValue(type, input)).toBe(expected);
  });

  it('keeps null', () => {
    expect(toDbValue('integer', null)).toBeNull();
    expect(toDbValue('json', null)).toBeNull();
  });

  it.each([
    ['string', { a: 1 }, 'a string'],
    ['uuid', 'not-a-uuid', 'a UUID'],
    ['integer', 1.5, 'an integer'],
    ['integer', 'abc', 'an integer'],
    ['integer', true, 'an integer'],
    ['bigInteger', '9007199254740993', 'an integer between -9007199254740991 and 9007199254740991'],
    ['float', 'NaN', 'a number'],
    ['boolean', 'yes', 'a boolean'],
    ['csv', 5, 'an array of strings or a comma-separated string'],
    ['date', '2023-02-29', 'a date (YYYY-MM-DD)'],
    ['date', '01/02/2024', 'a date (YYYY-MM-DD)'],
    ['time', '24:00', 'a time (HH:MM:SS)'],
    ['dateTime', '2024-13-01T00:00:00', 'a date and time (YYYY-MM-DDTHH:MM:SS)'],
    ['timestamp', 1700000000000, 'an ISO 8601 date and time'],
  ] as const)('%s rejects %j', (type, input, expected) => {
    expect(mismatch(() => toDbValue(type, input))).toBe(expected);
  });
});

describe('dates', () => {
  const at = new Date('2024-05-06T07:08:09.123Z');

  it('formats a Date per type, in UTC', () => {
    expect(formatTemporal('timestamp', at)).toBe('2024-05-06T07:08:09.123Z');
    expect(formatTemporal('dateTime', at)).toBe('2024-05-06T07:08:09');
    expect(formatTemporal('date', at)).toBe('2024-05-06');
    expect(formatTemporal('time', at)).toBe('07:08:09');
  });

  it('normalizes Dates like strings', () => {
    expect(normalizeTemporal('date', at)).toBe('2024-05-06');
    expect(mismatch(() => normalizeTemporal('date', new Date('nope')))).toBe('a date (YYYY-MM-DD)');
  });
});

describe('fromDbValue', () => {
  it.each([
    ['boolean', 1, true],
    ['boolean', 0, false],
    ['json', '{"a":1}', { a: 1 }],
    ['json', 'not json', 'not json'],
    ['csv', 'a,b', ['a', 'b']],
    ['csv', '', []],
    ['integer', 5, 5],
    ['string', null, null],
  ] as const)('%s %j → %j', (type, input, expected) => {
    expect(fromDbValue(type, input)).toEqual(expected);
  });
});
