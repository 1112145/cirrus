import { invalidPayload } from '@cirrus/shared';
import type { Context } from 'hono';

/** Parse a JSON body; malformed JSON is an INVALID_PAYLOAD, not a 500. */
export async function readJson(c: Context): Promise<unknown> {
  const body = await readOptionalJson(c);
  if (body === undefined) throw invalidPayload('Request body is empty');
  return body;
}

/** Parse a JSON body that may be left out (undefined). */
export async function readOptionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw invalidPayload('Request body is not valid JSON');
  }
}
