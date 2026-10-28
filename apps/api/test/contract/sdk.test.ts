/**
 * Contract tests: @directus/sdk 21.3.0 (ships with Directus 11.17.4) calling the Worker directly.
 * Each milestone adds its new commands here (spec §17.3).
 */
import { createDirectus, isDirectusError, rest, serverHealth, serverInfo, serverPing } from '@directus/sdk';
import { describe, expect, it } from 'vitest';
import { BASE, workerFetch } from '../helpers.ts';

const client = createDirectus(BASE, { globals: { fetch: workerFetch } }).with(rest());

describe('@directus/sdk contract — M0', () => {
  it('serverPing()', async () => {
    expect(await client.request(serverPing())).toBe('pong');
  });

  it('serverInfo()', async () => {
    const info = await client.request(serverInfo());
    expect(info.project.project_name).toBe('Cirrus');
  });

  it('serverHealth()', async () => {
    const health = await client.request(serverHealth());
    expect(health).toMatchObject({ status: 'ok' });
  });

  it('errors are recognized by the SDK as DirectusError', async () => {
    const err = await client
      .request(() => ({ method: 'GET', path: '/does-not-exist' }))
      .catch((e: unknown) => e);
    expect(isDirectusError(err)).toBe(true);
    expect((err as { errors: Array<{ extensions: { code: string } }> }).errors[0]?.extensions.code).toBe('ROUTE_NOT_FOUND');
  });
});
