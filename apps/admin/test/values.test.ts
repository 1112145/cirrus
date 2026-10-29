import { describe, expect, it } from 'vitest';
import { fromInput, InputError, inputType, tags, toInput } from '../src/lib/values.ts';

describe('values', () => {
  it('converts timestamps between UTC and local time', () => {
    const local = toInput('timestamp', '2026-01-05T10:00:00.000Z');
    expect(new Date(local).toISOString()).toBe('2026-01-05T10:00:00.000Z');
    expect(fromInput('timestamp', local)).toBe('2026-01-05T10:00:00.000Z');
    expect(toInput('timestamp', 'not a date')).toBe('');
  });

  it('keeps dateTime, date and time as they are, with seconds', () => {
    expect(toInput('dateTime', '2026-01-05T10:00:00')).toBe('2026-01-05T10:00:00');
    expect(fromInput('dateTime', '2026-01-05T10:00')).toBe('2026-01-05T10:00:00');
    expect(toInput('date', '2026-01-05')).toBe('2026-01-05');
    expect(fromInput('time', '09:30')).toBe('09:30:00');
  });

  it('parses numbers and refuses what they cannot hold', () => {
    expect(fromInput('integer', '42')).toBe(42);
    expect(() => fromInput('integer', '4.2')).toThrow(InputError);
    expect(fromInput('float', '4.2')).toBe(4.2);
    expect(() => fromInput('float', 'abc')).toThrow(InputError);
    expect(fromInput('integer', '  ')).toBeNull();
  });

  it('parses JSON and CSV', () => {
    expect(fromInput('json', '{"a": [1, 2]}')).toEqual({ a: [1, 2] });
    expect(() => fromInput('json', '{a}')).toThrow('Enter valid JSON.');
    expect(toInput('json', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(fromInput('csv', 'a, b,,a ')).toEqual(['a', 'b']);
    expect(toInput('csv', ['a', 'b'])).toBe('a, b');
    expect(tags(' x ,y,x')).toEqual(['x', 'y']);
  });

  it('shows nothing for null and picks input types', () => {
    expect(toInput('string', null)).toBe('');
    expect(fromInput('string', '')).toBeNull();
    expect(inputType('bigInteger')).toBe('number');
    expect(inputType('timestamp')).toBe('datetime-local');
    expect(inputType('uuid')).toBe('text');
  });
});
