import { request } from '@playwright/test';
import { ADMIN, BASE, TOKEN } from './env.ts';

/** The first admin, created with ADMIN_TOKEN as an operator would. */
export default async function globalSetup() {
  const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
  const roles = (await (await api.get('/roles?filter[name][_eq]=Administrator&fields=id')).json()) as { data: Array<{ id: string }> };
  const res = await api.post('/users', { data: { ...ADMIN, role: roles.data[0]!.id, first_name: 'Ada', last_name: 'Admin' } });
  if (!res.ok()) throw new Error(`Creating the admin failed: ${res.status()} ${await res.text()}`);
  await api.dispose();
}
