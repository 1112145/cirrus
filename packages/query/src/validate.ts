import type { DbValue } from '@cirrus/schema';
import { invalidQuery, isPlainObject } from '@cirrus/shared';
import { comparable, flag, list, primitive } from './compile.ts';
import type { Filter, QueryCollection, QueryField } from './types.ts';

/**
 * Payload validation with filter rules: field `meta.validation` and permission `validation`
 * (spec §8.6, §10), following Directus' validatePayload:
 * - fields the payload leaves out pass every rule except `_submitted`;
 * - `_and` needs every branch, `_or` at least one (otherwise it reports every branch's errors);
 * - several operators on one field all apply.
 *
 * Values are compared in their stored form: the payload has been through toDbValue, and filter
 * values are converted like the SQL filters convert them (compile.ts), so `"10"` equals 10 for an
 * integer field and dates compare as dates. Unlike SQL, a null value passes the negative
 * operators (`_neq`, `_nin`, `_ncontains`, …), as it does in Directus.
 */

/** One failed rule, as Directus' FailedValidationError extensions describe it. */
export type ValidationError = {
  field: string;
  /** The operator without its underscore (eq, in, gt, contains, regex, …), or `required` for `_submitted`. */
  type: string;
  valid?: unknown;
  invalid?: unknown;
  substring?: string;
};

type Values = Readonly<Record<string, DbValue>>;

const MAX_DEPTH = 32;

export function validatePayload(c: QueryCollection, filter: Filter, row: Values): ValidationError[] {
  return check(c, filter, row, 0);
}

function check(c: QueryCollection, filter: Filter, row: Values, depth: number): ValidationError[] {
  if (depth > MAX_DEPTH) throw invalidQuery('The validation rule is nested too deeply');
  const errors: ValidationError[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(value)) throw invalidQuery(`"${key}" has to be an array of filters`);
      const results = value.map((sub, i) => {
        if (!isPlainObject(sub)) throw invalidQuery(`"${key}[${i}]" has to be a filter object`);
        return check(c, sub, row, depth + 1);
      });
      if (key === '_and' || (results.length > 0 && results.every((r) => r.length > 0))) errors.push(...results.flat());
    } else if (key.startsWith('_')) {
      throw invalidQuery(`"${key}" has to be used on a field`);
    } else {
      errors.push(...checkField(c, key, value, row));
    }
  }
  return errors;
}

function checkField(c: QueryCollection, name: string, rule: unknown, row: Values): ValidationError[] {
  const ops: Array<[string, unknown]> = isPlainObject(rule) ? Object.entries(rule) : [['_eq', rule]];
  const present = Object.hasOwn(row, name);
  const f = c.fields.find((x) => x.field === name && x.type !== 'alias');
  const errors: ValidationError[] = [];
  for (const [op, v] of ops) {
    // Paths into relations arrive with M4; until then such rules can't fail.
    if (!op.startsWith('_')) continue;
    if (op === '_submitted') {
      if (flag(op, v) && !present) errors.push({ field: name, type: 'required' });
      continue;
    }
    if (!present || !f) continue;
    const error = checkOperator(f, op, v, row[name]!);
    if (error) errors.push({ field: name, ...error });
  }
  return errors;
}

type Failure = Omit<ValidationError, 'field'>;

/** a < b, a > b, …: numbers numerically, text as text (stored dates sort as text); mixed types never compare. */
function compare(a: DbValue, b: DbValue): number | null {
  if (a === null || b === null || typeof a !== typeof b) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

const asString = (v: DbValue) => (v === null ? null : String(v));

function regex(pattern: unknown): RegExp {
  if (typeof pattern !== 'string') throw invalidQuery('"_regex" has to be a string');
  const source = pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/') ? pattern.slice(1, -1) : pattern;
  try {
    return new RegExp(source);
  } catch {
    throw invalidQuery(`"${pattern}" is not a valid regular expression`);
  }
}

function checkOperator(f: QueryField, op: string, v: unknown, actual: DbValue): Failure | null {
  const value = () => comparable(f, primitive(op, v));
  const values = () => list(op, v).map((x) => comparable(f, primitive(op, x)));
  const fail = (type: string, extra: Omit<Failure, 'type'> = {}): Failure => ({ type, ...extra });
  const cmp = (test: (n: number) => boolean, type: string) => {
    const r = compare(actual, value());
    return r !== null && test(r) ? null : fail(type, { valid: v });
  };

  switch (op) {
    case '_eq':
      return (v === null ? actual === null : actual === value()) ? null : fail('eq', { valid: v });
    case '_neq':
      return (v === null ? actual !== null : actual !== value()) ? null : fail('neq', { invalid: v });
    case '_in':
      return values().includes(actual) ? null : fail('in', { valid: v });
    case '_nin':
      return actual === null || !values().includes(actual) ? null : fail('nin', { invalid: v });
    case '_gt':
      return cmp((n) => n > 0, 'gt');
    case '_gte':
      return cmp((n) => n >= 0, 'gte');
    case '_lt':
      return cmp((n) => n < 0, 'lt');
    case '_lte':
      return cmp((n) => n <= 0, 'lte');
    case '_between':
    case '_nbetween': {
      const range = values();
      if (range.length !== 2) throw invalidQuery(`"${op}" has to be an array of two values`);
      const lo = compare(actual, range[0]!);
      const hi = compare(actual, range[1]!);
      const inside = lo !== null && hi !== null && lo >= 0 && hi <= 0;
      if (op === '_between') return inside ? null : fail('between', { valid: v });
      return actual === null || !inside ? null : fail('nbetween', { invalid: v });
    }
    case '_null':
    case '_nnull': {
      const wantNull = (op === '_null') === flag(op, v);
      return (actual === null) === wantNull ? null : fail(wantNull ? 'null' : 'nnull');
    }
    case '_empty':
    case '_nempty': {
      const wantEmpty = (op === '_empty') === flag(op, v);
      return (actual === null || actual === '') === wantEmpty ? null : fail(wantEmpty ? 'empty' : 'nempty');
    }
    case '_regex': {
      const s = asString(actual);
      return s !== null && regex(v).test(s) ? null : fail('regex');
    }
  }

  const textOp = /^_(n)?(i)?(contains|starts_with|ends_with)$/.exec(op);
  if (textOp) {
    const [, negated, insensitive, kind] = textOp;
    const fold = (s: string) => (insensitive ? s.toLowerCase() : s);
    const needle = fold(String(primitive(op, v)));
    const s = asString(actual);
    if (s === null) return negated ? null : fail(op.slice(1), { substring: String(v) });
    const hay = fold(s);
    const found = kind === 'contains' ? hay.includes(needle) : kind === 'starts_with' ? hay.startsWith(needle) : hay.endsWith(needle);
    return found !== Boolean(negated) ? null : fail(op.slice(1), { substring: String(v) });
  }

  if (['_intersects', '_nintersects', '_intersects_bbox', '_nintersects_bbox'].includes(op)) throw invalidQuery(`"${op}" is not supported`);
  if (op === '_some' || op === '_none') throw invalidQuery(`"${op}" can only be used on relational fields`);
  throw invalidQuery(`"${op}" is not a valid filter operator`);
}

/** Directus' FailedValidationError message for one error. */
export function validationMessage(e: ValidationError): string {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => `"${String(x)}"`).join(', ') : String(v));
  const detail: Record<string, string> = {
    eq: `Value has to be ${String(e.valid)}.`,
    neq: `Value can't be ${String(e.invalid)}.`,
    in: `Value has to be one of ${list(e.valid)}.`,
    nin: `Value can't be one of ${list(e.invalid)}.`,
    gt: `Value has to be greater than ${String(e.valid)}.`,
    gte: `Value has to be greater than or equal to ${String(e.valid)}.`,
    lt: `Value has to be less than ${String(e.valid)}.`,
    lte: `Value has to be less than or equal to ${String(e.valid)}.`,
    between: `Value has to be between ${list(e.valid)}.`,
    nbetween: `Value can't be between ${list(e.invalid)}.`,
    null: 'Value has to be null.',
    nnull: "Value can't be null.",
    empty: 'Value has to be empty.',
    nempty: "Value can't be empty.",
    contains: `Value has to contain ${e.substring}.`,
    ncontains: `Value can't contain ${e.substring}.`,
    icontains: `Value has to contain ${e.substring}.`,
    nicontains: `Value can't contain ${e.substring}.`,
    starts_with: `Value has to start with ${e.substring}.`,
    nstarts_with: `Value can't start with ${e.substring}.`,
    istarts_with: `Value has to start with ${e.substring}.`,
    nistarts_with: `Value can't start with ${e.substring}.`,
    ends_with: `Value has to end with ${e.substring}.`,
    nends_with: `Value can't end with ${e.substring}.`,
    iends_with: `Value has to end with ${e.substring}.`,
    niends_with: `Value can't end with ${e.substring}.`,
    regex: "Value doesn't have the correct format.",
    required: 'Value is required.',
  };
  return `Validation failed for field "${e.field}".${detail[e.type] ? ` ${detail[e.type]}` : ''}`;
}
