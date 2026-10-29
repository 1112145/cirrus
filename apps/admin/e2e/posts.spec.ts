import { expect, type Page, test } from '@playwright/test';
import { ADMIN } from './env.ts';

/**
 * M6's goal: `posts` can be managed entirely through the UI — its data model (with an image, a
 * many to one and a many to many), its items, and the files they use. The tests run in order on
 * one page, as one person would.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;

// A 4×4 PNG: the cover image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGMwD78GRwzEcQA44hZBOqLspgAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

const dialog = () => page.locator('dialog[open]');
const field = (name: string) => page.locator('.field', { has: page.locator(`label[for="field-${name}"]`) });

async function confirm() {
  await page.locator('[data-test=confirm]').click();
}

async function createCollection(name: string, opts: { keepOptional?: boolean; integerKey?: boolean } = {}) {
  await page.goto('/admin/settings/data-model');
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.fill('#collection-name', name);
  if (!opts.keepOptional) for (const v of ['status', 'sort', 'date_created', 'date_updated']) await dialog().locator(`input[value=${v}]`).uncheck();
  if (opts.integerKey) await page.selectOption('#pk-kind', 'integer');
  await dialog().getByRole('button', { name: 'Create collection' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/settings/data-model/${name}$`));
}

async function addField(kind: string, name: string, setup?: () => Promise<void>) {
  await page.getByRole('button', { name: 'Add field' }).first().click();
  await dialog().locator(`[data-kind=${kind}]`).click();
  await page.fill('#field-name', name);
  await setup?.();
  await dialog().getByRole('button', { name: 'Add field' }).click();
  await expect(page.locator(`[data-field=${name}]`)).toBeVisible();
}

async function save() {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

test('the app asks to sign in, and refuses a wrong password', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.fill('#email', ADMIN.email);
  await page.fill('#password', 'wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
  await page.fill('#password', ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/content$/);
  await expect(page.getByText('There are no collections yet.')).toBeVisible();
});

test('the data model of posts is built in the UI', async () => {
  await createCollection('authors');
  await addField('string', 'name', () => page.getByLabel('Required').check());

  await createCollection('tags', { integerKey: true });
  await addField('string', 'label');

  await createCollection('posts', { keepOptional: true });
  await addField('string', 'title', () => page.getByLabel('Required').check());
  await addField('markdown', 'body');
  await addField('image', 'cover');
  await addField('m2o', 'author', async () => {
    await page.selectOption('#field-related', 'authors');
    await page.getByLabel(/Also list them on/).check();
  });
  await addField('m2m', 'tags', () => page.selectOption('#field-related', 'tags').then(() => undefined));
  await addField('boolean', 'featured', () => page.selectOption('#field-width', 'half').then(() => undefined));

  await expect(page.locator('[data-field=author]')).toContainText('Many to one → Authors');
  await expect(page.locator('[data-field=tags]')).toContainText('Many to many → Tags');

  // Fields can be moved and edited.
  await page.getByRole('button', { name: 'Move featured up' }).click();
  await expect.poll(() => page.locator('[data-field]').evaluateAll((els) => els.map((e) => e.getAttribute('data-field')).slice(-2))).toEqual(['featured', 'tags']);
  await page.getByRole('button', { name: 'Edit body' }).click();
  await page.fill('#field-note', 'Markdown is welcome');
  await dialog().getByRole('button', { name: 'Save' }).click();
  await expect(dialog()).toHaveCount(0);

  await page.fill('#c-template', '{{ title }}');
  await save();
  await expect(page.getByText('Saved.').first()).toBeVisible();

  // The junction collection exists, hidden from the content module.
  await page.goto('/admin/settings/data-model');
  await expect(page.locator('tr', { hasText: 'posts_tags' })).toContainText('Hidden');
  await page.goto('/admin/content');
  await expect(page.locator('.nav-list')).toHaveText(/Authors\s*Posts\s*Tags/);
});

test('related items are created', async () => {
  await page.goto('/admin/content/authors');
  await page.getByRole('link', { name: 'Create item' }).click();
  await page.fill('#field-name', 'Ada Lovelace');
  await save();
  await expect(page).toHaveURL(/\/admin\/content\/authors\/[0-9a-f-]{36}$/);
  await expect(page.locator('h1')).toHaveText('Ada Lovelace');

  for (const label of ['news', 'cloud']) {
    await page.goto('/admin/content/tags/+');
    await page.fill('#field-label', label);
    await save();
    await expect(page).toHaveURL(/\/admin\/content\/tags\/\d+$/);
  }
});

test('a post is created with a cover, an author and tags', async () => {
  await page.goto('/admin/content/posts');
  await expect(page.getByText('No items yet.')).toBeVisible();
  await page.getByRole('link', { name: 'Create item' }).click();
  await expect(page.locator('h1')).toHaveText('New item');

  // Required fields are checked before saving.
  await page.fill('#field-body', '# Hello\n\nThe first post.');
  await save();
  await expect(field('title').locator('.error')).toHaveText('This field is required.');

  await page.fill('#field-title', 'Hello Cirrus');
  await field('cover').locator('input[type=file]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
  await expect(field('cover')).toContainText('image/png');

  await field('author').getByRole('button', { name: 'Select' }).click();
  await dialog().getByText('Ada Lovelace').click();
  await expect(field('author')).toContainText('Ada Lovelace');

  await field('tags').getByRole('button', { name: 'Add existing' }).click();
  await dialog().getByText('news').click();
  await dialog().getByText('cloud').click();
  await dialog().getByRole('button', { name: /Add 2/ }).click();
  await expect(field('tags').locator('.row')).toHaveCount(2);

  await page.locator('#field-featured').check();
  await save();
  await expect(page).toHaveURL(/\/admin\/content\/posts\/[0-9a-f-]{36}$/);
  await expect(page.locator('h1')).toHaveText('Hello Cirrus');

  await page.goto('/admin/content/posts');
  const row = page.locator('tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Draft');
  await expect(row).toContainText('Hello Cirrus');
  await expect(row).toContainText('Ada Lovelace');
  await expect(row).toContainText('Yes');
});

test('a post is edited, and leaving with unsaved changes asks first', async () => {
  await page.goto('/admin/content/posts');
  await page.locator('tbody tr').first().click();
  await page.fill('#field-title', 'Hello again');
  await page.selectOption('#field-status', 'published');
  await field('tags').locator('.row', { hasText: 'cloud' }).getByRole('button', { name: 'Remove' }).click();

  await page.locator('.nav-list').getByText('Authors').click();
  await expect(dialog()).toContainText('Discard your unsaved changes?');
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/admin\/content\/posts\//);

  await save();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#field-title')).toHaveValue('Hello again');
  await expect(page.locator('#field-status')).toHaveValue('published');
  await expect(field('tags').locator('.row')).toHaveText(['news']);

  // The author lists the post through the reverse field.
  await field('author').getByText('Ada Lovelace').waitFor();
  await page.goto('/admin/content/authors');
  await page.locator('tbody tr').first().click();
  await expect(field('posts')).toContainText('Hello again');
});

test('the cover is in the file library, where it can be edited', async () => {
  await page.getByRole('link', { name: 'File library' }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.fill('#folder-name', 'Covers');
  await dialog().getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/folder=/);
  await expect(page.getByText('This folder is empty.')).toBeVisible();

  await page.locator('[data-test=upload-input]').setInputFiles([{ name: 'second.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(page.locator('.tile')).toHaveCount(1);
  await page.locator('.tile').first().click();
  await expect(page.locator('h1')).toHaveText('Second');
  await expect(page.locator('#field-folder')).toHaveValue(/[0-9a-f-]{36}/);
  await page.fill('#field-title', 'Second cover');
  await save();
  await expect(page.locator('h1')).toHaveText('Second cover');

  await page.getByRole('button', { name: 'Delete file' }).click();
  await confirm();
  await expect(page).toHaveURL(/\/admin\/files\?folder=/);
  await expect(page.getByText('This folder is empty.')).toBeVisible();
});

test('a post is deleted', async () => {
  await page.goto('/admin/content/posts');
  await page.locator('tbody tr').first().click();
  await page.getByRole('button', { name: 'Delete item' }).click();
  await confirm();
  await expect(page).toHaveURL(/\/admin\/content\/posts$/);
  await expect(page.getByText('No items yet.')).toBeVisible();
});

test('the session survives a reload and ends on logout', async () => {
  await page.reload();
  await expect(page).toHaveURL(/\/admin\/content\/posts$/);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto('/admin/content/posts');
  await expect(page).toHaveURL(/\/admin\/login\?redirect=/);
});
