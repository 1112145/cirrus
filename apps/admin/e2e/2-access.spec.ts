import { expect, type Page, test } from '@playwright/test';
import { ADMIN, BASE } from './env.ts';

/**
 * M7's goal: a writer can be given access, and limited, entirely through the UI: a policy with
 * permissions down to their own items, a role holding it, a user in that role (with a static
 * token), and what that user then sees. Runs after 1-posts.spec.ts on the same Worker.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
const WRITER = { email: 'writer@example.com', password: 'writer-password' };
let token = '';

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

const dialog = () => page.locator('dialog[open]');
const field = (name: string) => page.locator('.field', { has: page.locator(`label[for="field-${name}"]`) });
const save = () => page.getByRole('button', { name: 'Save', exact: true }).click();
const cell = (collection: string, action: string) => page.locator(`[data-collection="${collection}"] [data-action="${action}"]`);

async function signIn(user: { email: string; password: string }) {
  await page.goto('/admin/login');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/content$/);
}

async function signOut() {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
}

test('the admin builds a notes collection with an owner (a user)', async () => {
  await signIn(ADMIN);
  await page.goto('/admin/settings/data-model');
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.fill('#collection-name', 'notes');
  for (const v of ['status', 'sort', 'date_updated']) await dialog().locator(`input[value=${v}]`).uncheck();
  await dialog().locator('input[value=user_created]').check();
  await dialog().getByRole('button', { name: 'Create collection' }).click();
  await expect(page).toHaveURL(/\/data-model\/notes$/);

  for (const [kind, name] of [
    ['string', 'title'],
    ['m2o', 'owner'],
  ] as const) {
    await page.getByRole('button', { name: 'Add field' }).first().click();
    await dialog().locator(`[data-kind=${kind}]`).click();
    await page.fill('#field-name', name);
    if (kind === 'm2o') await page.selectOption('#field-related', 'directus_users');
    await dialog().getByRole('button', { name: 'Add field' }).click();
    await expect(page.locator(`[data-field=${name}]`)).toBeVisible();
  }
  await expect(page.locator('[data-field=owner]')).toContainText('Many to one → Users');
});

test('a policy limits writers to their own notes', async () => {
  await page.locator('.nav-list').getByText('Policies').click();
  await expect(page.locator('tbody tr').first()).toContainText('Public');
  await page.getByRole('link', { name: 'Create policy' }).click();
  await page.fill('#policy-name', 'Writers');
  await save();
  await expect(page).toHaveURL(/\/settings\/policies\/[0-9a-f-]{36}$/);

  await page.getByRole('button', { name: 'All access to notes' }).click();
  for (const a of ['create', 'read', 'update', 'delete']) await expect(cell('notes', a)).toHaveAttribute('data-level', 'all');

  // Updates: only their own notes, only the title.
  await cell('notes', 'update').click();
  await dialog().getByText('Custom', { exact: true }).click();
  await dialog().getByRole('button', { name: 'Items they created' }).click();
  await dialog().getByLabel('All fields, including ones added later').uncheck();
  await dialog().locator('label', { hasText: /^title$/ }).locator('input').check();
  await dialog().getByRole('button', { name: 'Save' }).click();
  await expect(cell('notes', 'update')).toHaveAttribute('data-level', 'custom');

  // No deletes.
  await cell('notes', 'delete').click();
  await dialog().getByText('No access', { exact: true }).click();
  await dialog().getByRole('button', { name: 'Save' }).click();
  await expect(cell('notes', 'delete')).toHaveAttribute('data-level', 'none');

  // Reopening the cell shows what was saved.
  await cell('notes', 'update').click();
  await expect(dialog().locator('#permission-filter')).toHaveValue(/"user_created"/);
  await dialog().getByRole('button', { name: 'Cancel' }).click();
});

test('a role holds the policy, and a writer is created in it', async () => {
  await page.locator('.nav-list').getByText('Roles').click();
  await page.getByRole('link', { name: 'Create role' }).click();
  await page.fill('#role-name', 'Writer');
  await page.selectOption('select[aria-label="Policy to add"]', { label: 'Writers' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await save();
  await expect(page).toHaveURL(/\/settings\/roles\/[0-9a-f-]{36}$/);
  await expect(page.locator('h1')).toHaveText('Writer');

  await page.getByRole('link', { name: 'Create user' }).click();
  await page.fill('#field-first_name', 'Wren');
  await page.fill('#field-last_name', 'Writer');
  await page.fill('#field-email', WRITER.email);
  await page.fill('#field-password', WRITER.password);
  await expect(page.locator('#field-role option:checked')).toHaveText('Writer');
  await save();
  await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]{36}$/);
  await expect(page.locator('h1')).toHaveText('Wren Writer');

  // A static token, shown once, then usable with the API.
  await page.getByRole('button', { name: 'Generate token' }).click();
  token = (await page.locator('[data-test=token]').textContent())!.trim();
  await save();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  const me = await page.request.get(`${BASE}/users/me?fields=email`, { headers: { Authorization: `Bearer ${token}` } });
  expect(await me.json()).toEqual({ data: { email: WRITER.email } });

  // The directory lists them under their role.
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await page.locator('.nav-list').getByText('Writer').click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText(WRITER.email);
});

test('the admin writes a note owned by the writer', async () => {
  await page.goto('/admin/content/notes/+');
  await page.fill('#field-title', 'Admin note');
  await field('owner').getByRole('button', { name: 'Select' }).click();
  await dialog().getByText('Wren Writer').click();
  await expect(field('owner')).toContainText('Wren Writer');
  await save();
  await expect(page).toHaveURL(/\/admin\/content\/notes\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(field('owner')).toContainText('Wren Writer');
  await signOut();
});

test('the writer can only do what the policy allows', async () => {
  await signIn(WRITER);
  await expect(page.locator('nav.modules')).not.toContainText('Settings');
  await expect(page.locator('nav.modules a[aria-label="Settings"]')).toHaveCount(0);

  // Someone else's note: read only.
  await page.goto('/admin/content/notes');
  await page.locator('tbody tr', { hasText: 'Admin note' }).click();
  await expect(page.getByText('You may read this item but not change it.')).toBeVisible();
  await expect(page.locator('#field-title')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0);

  // Their own: created, then edited (the title only), never deleted.
  await page.goto('/admin/content/notes/+');
  await page.fill('#field-title', 'Writer note');
  await save();
  await expect(page).toHaveURL(/\/admin\/content\/notes\/[0-9a-f-]{36}$/);
  await expect(page.locator('#field-title')).toBeEnabled();
  await expect(page.locator('h1')).toHaveText('Writer note');
  await page.fill('#field-title', 'Writer note, edited');
  await save();
  await expect(page.locator('h1')).toHaveText('Writer note, edited');
  await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0);

  // Settings are for admins; the directory shows only themselves, read only.
  await page.goto('/admin/settings/policies');
  await expect(page).toHaveURL(/\/admin\/content$/);
  await page.goto('/admin/users');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'Your profile' }).click();
  await expect(page.getByText('You may see your profile but not change it.')).toBeVisible();
  await signOut();
});

test('removing the role takes the access away', async () => {
  await signIn(ADMIN);
  await page.goto('/admin/settings/roles');
  await page.locator('tbody tr', { hasText: 'Writer' }).click();
  await expect(page.getByText('Wren Writer')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Writers' }).click();
  await save();
  await expect(page.getByText('No policies: this role')).toBeVisible();

  // Without the policy's app access, the writer's token still works for the API but reads nothing.
  const notes = await page.request.get(`${BASE}/items/notes`, { headers: { Authorization: `Bearer ${token}` } });
  expect(notes.status()).toBe(403);
});
