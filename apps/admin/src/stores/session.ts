import { readMe, readPolicyGlobals } from '@directus/sdk';
import { reactive } from 'vue';
import { client, request } from '../api.ts';

/** Who is logged in. The session cookie survives reloads; `restore()` checks it once at startup. */

export type Me = { id: string; email: string; first_name: string | null; last_name: string | null; role: string | null };

export const session = reactive({
  user: null as Me | null,
  admin: false,
  /** restore() has run. */
  checked: false,
  project: 'Cirrus',
});

async function loadUser() {
  const [me, globals] = await Promise.all([
    request<Me>(readMe({ fields: ['id', 'email', 'first_name', 'last_name', 'role'] })),
    request<{ app_access: boolean; admin_access: boolean }>(readPolicyGlobals()),
  ]);
  if (!globals.app_access && !globals.admin_access) {
    await client.logout().catch(() => {});
    throw new Error("Your account doesn't have access to the app.");
  }
  session.user = me;
  session.admin = globals.admin_access;
}

/** Pick up the session of an earlier visit, if its cookie is still good. */
export async function restore(): Promise<void> {
  // Plain fetch: the SDK would try to refresh the session first.
  fetch('/server/info')
    .then((r) => r.json())
    .then((body: { data?: { project?: { project_name?: string } } }) => {
      if (body.data?.project?.project_name) session.project = body.data.project.project_name;
    })
    .catch(() => {});
  try {
    await client.refresh();
    await loadUser();
  } catch {
    session.user = null;
  } finally {
    session.checked = true;
  }
}

export async function login(email: string, password: string): Promise<void> {
  await client.login({ email, password });
  await loadUser();
}

export async function logout(): Promise<void> {
  await client.logout().catch(() => {});
  forget();
}

/** The session is gone (expired, or ended elsewhere). */
export function forget() {
  client.stopRefreshing();
  session.user = null;
  session.admin = false;
}

export const displayName = (me: Me) => [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email;
