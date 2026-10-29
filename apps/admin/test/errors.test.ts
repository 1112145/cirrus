import { describe, expect, it } from 'vitest';
import { apiErrors, errorCode, errorMessage, fieldErrors, isAuthError } from '../src/lib/errors.ts';

const failed = (...errors: Array<{ message: string; extensions?: Record<string, unknown> }>) => ({ errors, response: {} });

describe('errors', () => {
  it('reads the errors @directus/sdk throws', () => {
    const e = failed({ message: 'Value is required', extensions: { code: 'FAILED_VALIDATION', field: 'title' } }, { message: 'Too long', extensions: { code: 'FAILED_VALIDATION', field: 'slug' } });
    expect(errorCode(e)).toBe('FAILED_VALIDATION');
    expect(errorMessage(e)).toBe('Value is required Too long');
    expect(fieldErrors(e)).toEqual({ title: 'Value is required', slug: 'Too long' });
  });

  it('turns anything else into one error', () => {
    expect(apiErrors(new Error('Network down'))).toEqual([{ message: 'Network down', code: null, extensions: {} }]);
    expect(errorMessage(undefined)).toBe('Something went wrong.');
  });

  it('knows when the session is gone', () => {
    expect(isAuthError(failed({ message: 'x', extensions: { code: 'TOKEN_EXPIRED' } }))).toBe(true);
    expect(isAuthError(failed({ message: 'x', extensions: { code: 'FORBIDDEN' } }))).toBe(false);
  });
});
