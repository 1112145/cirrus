import type { FieldType } from './schema.ts';

/**
 * API values ↔ the values of HTML inputs, per field type. The API stores timestamps in UTC
 * (`2026-01-05T10:00:00.000Z`) and dateTime without a zone (`2026-01-05T10:00:00`); the browser's
 * `datetime-local` input shows local time, so timestamps are converted and dateTimes taken as they are.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** A `datetime-local` value (local time) for a Date. */
const localDateTime = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** What an input shows for an API value. */
export function toInput(type: FieldType, value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'timestamp': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? '' : localDateTime(d);
    }
    case 'dateTime':
      return String(value).slice(0, 19);
    case 'date':
      return String(value).slice(0, 10);
    case 'time':
      return String(value).slice(0, 8);
    case 'json':
      return JSON.stringify(value, null, 2);
    case 'csv':
      return Array.isArray(value) ? value.join(', ') : String(value);
    default:
      return String(value);
  }
}

export class InputError extends Error {}

/** The API value for what an input holds; empty is null. Throws InputError for values the type can't take. */
export function fromInput(type: FieldType, input: string): unknown {
  if (input.trim() === '') return null;
  switch (type) {
    case 'integer':
    case 'bigInteger': {
      const n = Number(input);
      if (!Number.isInteger(n)) throw new InputError('Enter a whole number.');
      return n;
    }
    case 'float':
    case 'decimal': {
      const n = Number(input);
      if (!Number.isFinite(n)) throw new InputError('Enter a number.');
      return n;
    }
    case 'timestamp': {
      const d = new Date(input);
      if (Number.isNaN(d.getTime())) throw new InputError('Enter a date and time.');
      return d.toISOString();
    }
    case 'dateTime':
      return input.length === 16 ? `${input}:00` : input;
    case 'time':
      return input.length === 5 ? `${input}:00` : input;
    case 'json':
      try {
        return JSON.parse(input);
      } catch {
        throw new InputError('Enter valid JSON.');
      }
    case 'csv':
      return tags(input);
    default:
      return input;
  }
}

/** Tags from comma-separated text, trimmed, without empties or repeats. */
export const tags = (input: string) => [...new Set(input.split(',').map((s) => s.trim()).filter(Boolean))];

/** The input type for a field type. */
export function inputType(type: FieldType): string {
  switch (type) {
    case 'integer':
    case 'bigInteger':
    case 'float':
    case 'decimal':
      return 'number';
    case 'timestamp':
    case 'dateTime':
      return 'datetime-local';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    default:
      return 'text';
  }
}
