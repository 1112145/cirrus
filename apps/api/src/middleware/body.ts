import { invalidPayload } from '@cirrus/shared';
import type { Context } from 'hono';

/** Parse a JSON body; malformed JSON is an INVALID_PAYLOAD, not a 500. */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) throw invalidPayload('Request body is empty');
  try {
    return JSON.parse(text);
  } catch {
    throw invalidPayload('Request body is not valid JSON');
  }
}
