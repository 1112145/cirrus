/**
 * Errors from the API, as @directus/sdk throws them: `{ errors: [{ message, extensions: { code, … } }], response }`.
 */

export type ApiError = { message: string; code: string | null; extensions: Record<string, unknown> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The errors of a failed request; a single generic one for anything else (network errors, bugs). */
export function apiErrors(e: unknown): ApiError[] {
  if (isObject(e) && Array.isArray(e.errors) && e.errors.length) {
    return e.errors.map((err) => {
      const x = isObject(err) ? err : {};
      const extensions = isObject(x.extensions) ? x.extensions : {};
      return {
        message: typeof x.message === 'string' ? x.message : 'Something went wrong.',
        code: typeof extensions.code === 'string' ? extensions.code : null,
        extensions,
      };
    });
  }
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong.';
  return [{ message, code: null, extensions: {} }];
}

/** One line for a notification. */
export function errorMessage(e: unknown): string {
  const errors = apiErrors(e);
  return errors.length === 1 ? errors[0]!.message : errors.map((x) => x.message).join(' ');
}

/** The error code of a failed request, if it has one. */
export const errorCode = (e: unknown): string | null => apiErrors(e)[0]!.code;

/** Errors that mean the session is gone: the user has to log in again. */
export const isAuthError = (e: unknown) => ['INVALID_CREDENTIALS', 'TOKEN_EXPIRED', 'INVALID_TOKEN'].includes(errorCode(e) ?? '');

/** Failed validations by field (FAILED_VALIDATION, NOT_NULL_VIOLATION, …), for showing them next to the inputs. */
export function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const err of apiErrors(e)) {
    const field = err.extensions.field;
    if (typeof field === 'string' && !out[field]) out[field] = err.message;
  }
  return out;
}
