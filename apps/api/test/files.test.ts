import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ObjectWriter, PART_SIZE } from '../src/files/storage.ts';
import { JPEG, PNG } from './fixtures.ts';
import { ADMIN_TOKEN, api, call, createUser, errorOf, ok, PUBLIC_POLICY } from './helpers.ts';

/**
 * Files, folders and assets (spec §11): uploads streamed into R2, the records written with the
 * request's permissions, contents deleted with their records, and assets served with Range,
 * conditional requests and image transformations. Every test in this file shares one D1 database
 * and one R2 bucket.
 */

type File = Record<string, any> & { id: string; filename_disk: string | null };

const bucket = () => env.STORAGE!;
const data = async <T = any>(res: Response) => (await ok<T>(res)).data;
const auth = (token: string | null): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** A multipart body: [name, value] for fields, [name, File] for files, in order. */
function form(...entries: Array<[string, string | Blob]>): FormData {
  const f = new FormData();
  for (const [name, value] of entries) f.append(name, value);
  return f;
}

const jpeg = (name = 'photo.jpg') => new File([JPEG], name, { type: 'image/jpeg' });
const text = (content: string, name = 'notes.txt') => new File([content], name, { type: 'text/plain' });

const upload = (body: FormData | BodyInit, token: string | null = ADMIN_TOKEN, query = '', method = 'POST', path = '/files') =>
  call(`${path}${query}`, { method, headers: auth(token), body });

const uploadOne = async (file: Blob, ...fields: Array<[string, string]>): Promise<File> => data(await upload(form(...fields, ['file', file])));

/** SHA-256 of bytes, to compare large contents (deep equality on megabytes is slow). */
const digest = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

const objects = async () => (await bucket().list()).objects.map((o) => o.key).sort();
const stored = async (key: string) => new Uint8Array(await (await bucket().get(key))!.arrayBuffer());
const asset = (path: string, init: { token?: string | null; headers?: Record<string, string>; method?: string } = {}) =>
  call(`/assets/${path}`, { method: init.method ?? 'GET', headers: { ...auth(init.token === undefined ? ADMIN_TOKEN : init.token), ...init.headers } });

/** A user with a static token and a role whose policy has these permissions. */
async function userWith(name: string, permissions: Array<Record<string, unknown>>): Promise<{ id: string; token: string }> {
  const policy = (await data(await api('POST', '/policies', { name }))).id;
  if (permissions.length) await ok(await api('POST', '/permissions', permissions.map((p) => ({ policy, ...p }))));
  const role = (await data(await api('POST', '/roles', { name, policies: [{ policy }] }))).id;
  const token = `${name}-static-token`;
  const id = await createUser({ email: `${name}@example.com`, role, token });
  return { id, token };
}

describe('uploads', () => {
  it('streams a file into R2 and describes it as Directus does', async () => {
    const res = await upload(form(['folder', 'null'], ['file', jpeg('my-holiday_photo.JPG')]));
    const file = await data<File>(res);
    expect(file).toMatchObject({
      title: 'My Holiday Photo',
      filename_download: 'my-holiday_photo.JPG',
      filename_disk: `${file.id}.jpg`,
      storage: 'r2',
      type: 'image/jpeg',
      filesize: JPEG.length,
      width: 40,
      height: 20,
      metadata: { ifd0: { Make: 'Cirrus', Model: 'Test Cam' } },
      folder: null,
      uploaded_by: null,
    });
    expect(file.uploaded_on).toBe(file.created_on);
    expect(await stored(file.filename_disk!)).toEqual(JPEG);
    expect((await bucket().head(file.filename_disk!))!.httpMetadata!.contentType).toBe('image/jpeg');
  });

  it('uploads several files; fields describe the file after them', async () => {
    const folder = (await data(await api('POST', '/folders', { name: 'Uploads' }))).id;
    const res = await upload(
      form(['folder', folder], ['title', 'First'], ['file', jpeg('a.jpg')], ['description', 'second'], ['file', text('hello', 'b.txt')], ['title', 'ignored']),
      ADMIN_TOKEN,
      '?fields=title,folder,description,type,width,metadata,filename_disk',
    );
    const [a, b] = await data<File[]>(res);
    expect(a).toMatchObject({ title: 'First', folder, description: null, type: 'image/jpeg', width: 40 });
    expect(b).toMatchObject({ title: 'B', folder: null, description: 'second', type: 'text/plain', width: null, metadata: null });
    expect(new TextDecoder().decode(await stored(b!.filename_disk!))).toBe('hello');
  });

  it('keeps the id, title and download name the request gives', async () => {
    const id = '01a1875e-0000-7000-8000-000000000001';
    const file = await uploadOne(jpeg(), ['id', id], ['title', 'Mine'], ['filename_download', 'cover.jpg'], ['width', '999']);
    expect(file).toMatchObject({ id, title: 'Mine', filename_download: 'cover.jpg', width: 999, height: 20 });
    // An id the request gives may be taken: its contents go to a key no other file can have.
    expect(file.filename_disk).toMatch(new RegExp(`^${id}-[0-9a-f]{12}\\.jpg$`));
  });

  it("never touches another file's contents when a new file takes its id", async () => {
    const existing = await uploadOne(new File([PNG], 'kept.png', { type: 'image/png' }));
    const before = await objects();
    expect(await errorOf(await upload(form(['id', existing.id], ['file', jpeg('kept.png')])))).toMatchObject({ code: 'RECORD_NOT_UNIQUE', field: 'id' });
    expect(await objects()).toEqual(before);
    expect(await stored(existing.filename_disk!)).toEqual(PNG);
  });

  it('names stored files by the type when the name has no plain extension', async () => {
    const file = await uploadOne(new File([PNG], 'scan', { type: 'image/png' }));
    expect(file.filename_disk).toBe(`${file.id}.png`);
    expect(file).toMatchObject({ title: 'Scan', width: 2, height: 1 });
  });

  it('stores large files with an R2 multipart upload', async () => {
    const big = new Uint8Array(PART_SIZE * 2 + 12345);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251;
    const file = await uploadOne(new File([big], 'big.bin', { type: 'application/octet-stream' }));
    expect(file.filesize).toBe(big.length);
    const object = await bucket().get(file.filename_disk!, { range: { offset: PART_SIZE * 2, length: 12345 } });
    expect(await digest(new Uint8Array(await object!.arrayBuffer()))).toBe(await digest(big.subarray(PART_SIZE * 2)));
    expect(await digest(await stored(file.filename_disk!))).toBe(await digest(big));
  });

  it('rejects bodies without files, files without names, and broken bodies, storing nothing', async () => {
    const before = await objects();
    expect(await errorOf(await upload(form(['title', 'x'])))).toMatchObject({ status: 400, code: 'INVALID_PAYLOAD', reason: 'No files were included in the body' });
    const unnamed = form(['file', new File(['x'], '', { type: 'text/plain' })]);
    expect(await errorOf(await upload(unnamed))).toMatchObject({ code: 'INVALID_PAYLOAD', reason: 'File is missing filename' });
    const truncated = new TextEncoder().encode('--b\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc');
    const res = await call('/files', { method: 'POST', headers: { ...auth(ADMIN_TOKEN), 'Content-Type': 'multipart/form-data; boundary=b' }, body: truncated });
    expect(await errorOf(res)).toMatchObject({ code: 'INVALID_PAYLOAD', reason: 'Unexpected end of multipart body' });
    expect(await objects()).toEqual(before);
  });

  it("doesn't let requests choose the object key or the storage", async () => {
    const before = await objects();
    expect(await errorOf(await upload(form(['filename_disk', 'other.jpg'], ['file', jpeg()])))).toMatchObject({
      code: 'INVALID_PAYLOAD',
      reason: '"filename_disk" is set by the server',
    });
    expect(await errorOf(await upload(form(['storage', 'local'], ['file', jpeg()])))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await objects()).toEqual(before);
    const file = await uploadOne(jpeg());
    expect(await errorOf(await api('PATCH', `/files/${file.id}`, { filename_disk: 'x.jpg' }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await errorOf(await api('PATCH', '/files', { keys: [file.id], data: { filename_disk: 'x.jpg' } }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('creates records without contents from JSON, which need a type', async () => {
    expect(await errorOf(await api('POST', '/files', { filename_download: 'a.txt' }))).toMatchObject({ code: 'INVALID_PAYLOAD', reason: '"type" is required' });
    const file = await data<File>(await api('POST', '/files', { filename_download: 'embed.mp4', type: 'video/mp4', embed: 'https://example.com/v' }));
    expect(file).toMatchObject({ storage: 'r2', filename_disk: null, type: 'video/mp4', embed: 'https://example.com/v' });
    expect(await errorOf(await asset(file.id))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('answers with the query of the request, or 204 when it may not read the file', async () => {
    const res = await upload(form(['file', jpeg()]), ADMIN_TOKEN, '?fields=title,type');
    expect(await data(res)).toEqual({ title: 'Photo', type: 'image/jpeg' });
    expect(await errorOf(await upload(form(['file', jpeg()]), ADMIN_TOKEN, '?fields=nope'))).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('permissions', () => {
  let uploader: { id: string; token: string };
  let limited: { id: string; token: string };
  let folder: string;

  beforeAll(async () => {
    folder = (await data(await api('POST', '/folders', { name: 'Inbox' }))).id;
    uploader = await userWith('uploader', [
      // What the upload implies (type, title, download name, size, key) needs no field permission.
      { collection: 'directus_files', action: 'create', fields: ['description', 'folder'], presets: { folder }, validation: { type: { _starts_with: 'image/' } } },
      { collection: 'directus_files', action: 'read', permissions: { uploaded_by: { _eq: '$CURRENT_USER' } }, fields: ['*'] },
      { collection: 'directus_files', action: 'update', permissions: { uploaded_by: { _eq: '$CURRENT_USER' } }, fields: ['description'] },
      { collection: 'directus_files', action: 'delete', permissions: { uploaded_by: { _eq: '$CURRENT_USER' } } },
    ]);
    limited = await userWith('limited', [{ collection: 'directus_files', action: 'create', fields: ['folder'], validation: { filesize: { _lt: 100 } } }]);
  });

  it('uploads within the permission: presets apply, the user is recorded', async () => {
    const file = await data<File>(await upload(form(['description', 'mine'], ['file', jpeg()]), uploader.token));
    expect(file).toMatchObject({ uploaded_by: uploader.id, folder, description: 'mine', title: 'Photo' });
  });

  it('checks fields and validation, including the values the upload sets, and keeps nothing on failure', async () => {
    const before = await objects();
    expect(await errorOf(await upload(form(['title', 'x'], ['file', jpeg()]), uploader.token))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await errorOf(await upload(form(['file', text('x')]), uploader.token))).toMatchObject({ code: 'FAILED_VALIDATION', field: 'type' });
    expect(await errorOf(await upload(form(['file', jpeg()]), limited.token))).toMatchObject({ code: 'FAILED_VALIDATION', field: 'filesize' });
    expect(await errorOf(await upload(form(['file', jpeg()]), null))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await objects()).toEqual(before);
  });

  it('answers 204 when the uploader may not read the file', async () => {
    const res = await upload(form(['file', new File(['x'], 'tiny.png', { type: 'image/png' })]), limited.token);
    expect(res.status).toBe(204);
  });

  it('replaces and deletes only what the permission reaches', async () => {
    const theirs = await uploadOne(jpeg());
    const before = await objects();
    const denied = await upload(form(['file', text('x')]), uploader.token, '', 'PATCH', `/files/${theirs.id}`);
    expect(await errorOf(denied)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await objects()).toEqual(before);
    expect(await errorOf(await api('DELETE', `/files/${theirs.id}`, undefined, uploader.token))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await stored(theirs.filename_disk!)).toEqual(JPEG);

    const mine = await data<File>(await upload(form(['file', jpeg()]), uploader.token));
    // Replacing needs update permission on the row, not on the fields the upload sets.
    const replaced = await data<File>(await upload(form(['file', new File([PNG], 'new.png', { type: 'image/png' })]), uploader.token, '', 'PATCH', `/files/${mine.id}`));
    expect(replaced).toMatchObject({ id: mine.id, type: 'image/png', filename_download: 'new.png', modified_by: uploader.id });
    expect(await bucket().head(mine.filename_disk!)).toBeNull();
    expect((await api('DELETE', `/files/${mine.id}`, undefined, uploader.token)).status).toBe(204);
    expect(await bucket().head(replaced.filename_disk!)).toBeNull();
  });
});

describe('replacing contents', () => {
  it('stores the new contents under a new key, then deletes the old ones and their variants', async () => {
    const file = await uploadOne(jpeg('first.jpg'), ['title', 'Kept']);
    // A variant of the old contents.
    expect((await asset(`${file.id}?width=10`)).status).toBe(200);
    const old = (await objects()).filter((k) => k.startsWith(file.id));
    expect(old).toHaveLength(2);

    const res = await upload(form(['file', new File([PNG], 'second.png', { type: 'image/png' })]), ADMIN_TOKEN, '', 'PATCH', `/files/${file.id}`);
    const replaced = await data<File>(res);
    expect(replaced).toMatchObject({ id: file.id, title: 'Kept', filename_download: 'second.png', type: 'image/png', filesize: PNG.length, width: 2, height: 1 });
    expect(replaced.filename_disk).toMatch(new RegExp(`^${file.id}-[0-9a-f]{12}\\.png$`));
    expect((await objects()).filter((k) => k.startsWith(file.id))).toEqual([replaced.filename_disk]);
    expect(new Uint8Array(await (await asset(file.id)).arrayBuffer())).toEqual(PNG);
  });

  it('resets image details when the new contents are not an image', async () => {
    const file = await uploadOne(jpeg());
    const replaced = await data<File>(await upload(form(['file', text('plain')]), ADMIN_TOKEN, '', 'PATCH', `/files/${file.id}`));
    expect(replaced).toMatchObject({ type: 'text/plain', width: null, height: null, metadata: null, filesize: 5 });
  });

  it('takes one file, and keeps the old contents when the update fails', async () => {
    const file = await uploadOne(jpeg());
    const before = await objects();
    const two = form(['file', jpeg()], ['file', jpeg()]);
    expect(await errorOf(await upload(two, ADMIN_TOKEN, '', 'PATCH', `/files/${file.id}`))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    const missing = await upload(form(['file', jpeg()]), ADMIN_TOKEN, '', 'PATCH', '/files/01a1875e-0000-7000-8000-00000000dead');
    expect(await errorOf(missing)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await objects()).toEqual(before);
  });

  it('updates records with JSON', async () => {
    const file = await uploadOne(jpeg());
    const updated = await data<File>(await api('PATCH', `/files/${file.id}?fields=title,filename_disk`, { title: 'Renamed' }));
    expect(updated).toEqual({ title: 'Renamed', filename_disk: file.filename_disk });
  });
});

describe('deleting files', () => {
  it('deletes the contents and variants with the records, by key, keys or query', async () => {
    const [a, b, c] = [await uploadOne(jpeg()), await uploadOne(jpeg()), await uploadOne(jpeg(), ['title', 'delete me'])];
    await asset(`${a.id}?width=8&format=png`);
    expect((await api('DELETE', `/files/${a.id}`)).status).toBe(204);
    expect((await api('DELETE', '/files', [b.id])).status).toBe(204);
    expect((await api('DELETE', '/files', { query: { filter: { title: { _eq: 'delete me' } } } })).status).toBe(204);
    const left = await objects();
    for (const f of [a, b, c]) expect(left.filter((k) => k.startsWith(f.id))).toEqual([]);
  });

  it('applies on_delete to what points at a file, and clears avatars', async () => {
    await ok(await api('POST', '/collections', { collection: 'galleries', schema: {}, fields: [{ field: 'title', type: 'string' }, { field: 'cover', type: 'uuid', meta: { special: ['file'] } }] }));
    await ok(await api('POST', '/relations', { collection: 'galleries', field: 'cover', related_collection: 'directus_files', schema: { on_delete: 'RESTRICT' } }));
    const kept = await uploadOne(jpeg());
    await ok(await api('POST', '/items/galleries', { title: 'G', cover: kept.id }));
    expect(await errorOf(await api('DELETE', `/files/${kept.id}`))).toMatchObject({ code: 'INVALID_FOREIGN_KEY', collection: 'galleries', field: 'cover' });
    expect(await stored(kept.filename_disk!)).toEqual(JPEG);

    const avatar = await uploadOne(jpeg());
    const user = await createUser({ email: 'avatar@example.com', avatar: avatar.id });
    expect((await api('DELETE', `/files/${avatar.id}`)).status).toBe(204);
    expect((await data(await api('GET', `/users/${user}?fields=avatar`))).avatar).toBeNull();
  });

  it("clears the uploader when a user is deleted", async () => {
    const author = await userWith('author', [
      { collection: 'directus_files', action: 'create', fields: ['*'] },
      { collection: 'directus_files', action: 'update', fields: ['*'] },
    ]);
    const res = await upload(form(['file', jpeg()]), author.token);
    expect(res.status).toBe(204);
    const [file] = await data<File[]>(await api('GET', `/files?filter[uploaded_by][_eq]=${author.id}&fields=id`));
    expect((await api('DELETE', `/users/${author.id}`)).status).toBe(204);
    expect(await data(await api('GET', `/files/${file!.id}?fields=uploaded_by`))).toEqual({ uploaded_by: null });
  });

  it('checks that avatars are files', async () => {
    expect(await errorOf(await api('POST', '/users', { email: 'ghost@example.com', avatar: '01a1875e-0000-7000-8000-00000000beef' }))).toMatchObject({
      code: 'INVALID_FOREIGN_KEY',
      field: 'avatar',
    });
  });
});

describe('folders', () => {
  it('nest, hold files, and clear them when deleted', async () => {
    const root = await data(await api('POST', '/folders', { name: 'Root' }));
    const child = await data(await api('POST', '/folders', { name: 'Child', parent: root.id }));
    expect(await data(await api('GET', `/folders?filter[parent][_eq]=${root.id}&fields=name`))).toEqual([{ name: 'Child' }]);
    const file = await uploadOne(jpeg(), ['folder', child.id]);
    expect((await data(await api('GET', `/files/${file.id}?fields=folder.name,folder.parent.name`))).folder).toEqual({ name: 'Child', parent: { name: 'Root' } });

    // A folder with subfolders can't be deleted (as in Directus); its files lose their folder.
    expect(await errorOf(await api('DELETE', `/folders/${root.id}`))).toMatchObject({ code: 'INVALID_FOREIGN_KEY' });
    expect((await api('DELETE', `/folders/${child.id}`)).status).toBe(204);
    expect((await data(await api('GET', `/files/${file.id}?fields=folder`))).folder).toBeNull();
  });

  it('check parents and folders of files', async () => {
    const folder = await data(await api('POST', '/folders', { name: 'Self' }));
    expect(await errorOf(await api('PATCH', `/folders/${folder.id}`, { parent: folder.id }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await errorOf(await api('POST', '/folders', { name: 'Orphan', parent: '01a1875e-0000-7000-8000-00000000cafe' }))).toMatchObject({
      code: 'INVALID_FOREIGN_KEY',
    });
    const file = await uploadOne(jpeg());
    expect(await errorOf(await api('PATCH', `/files/${file.id}`, { folder: '01a1875e-0000-7000-8000-00000000cafe' }))).toMatchObject({
      code: 'INVALID_FOREIGN_KEY',
    });
  });
});

describe('a post with a cover image (M5 done-when)', () => {
  it('relates items to files, reads them through the relation, and serves the image', async () => {
    await ok(
      await api('POST', '/collections', {
        collection: 'articles',
        schema: {},
        fields: [
          { field: 'title', type: 'string' },
          { field: 'cover', type: 'uuid', meta: { interface: 'file-image', special: ['file'] } },
        ],
      }),
    );
    await ok(await api('POST', '/relations', { collection: 'articles', field: 'cover', related_collection: 'directus_files', schema: { on_delete: 'SET NULL' } }));
    const cover = await uploadOne(jpeg('beach.jpg'));
    const article = await data(await api('POST', '/items/articles?fields=title,cover.title,cover.width,cover.type', { title: 'Summer', cover: cover.id }));
    expect(article).toEqual({ title: 'Summer', cover: { title: 'Beach', width: 40, type: 'image/jpeg' } });
    const found = await data(await api('GET', '/items/articles?filter[cover][type][_starts_with]=image/&fields=title'));
    expect(found).toEqual([{ title: 'Summer' }]);
    expect(new Uint8Array(await (await asset(cover.id)).arrayBuffer())).toEqual(JPEG);
    expect(await errorOf(await api('POST', '/items/articles', { title: 'Broken', cover: '01a1875e-0000-7000-8000-00000000f00d' }))).toMatchObject({
      code: 'INVALID_FOREIGN_KEY',
      field: 'cover',
    });

    // Deleting the file clears the cover (on_delete SET NULL).
    expect((await api('DELETE', `/files/${cover.id}`)).status).toBe(204);
    expect(await data(await api('GET', '/items/articles?fields=title,cover'))).toEqual([{ title: 'Summer', cover: null }]);
  });
});

describe('assets', () => {
  let file: File;
  let note: File;
  let publicFolder: string;

  beforeAll(async () => {
    publicFolder = (await data(await api('POST', '/folders', { name: 'Public' }))).id;
    file = await uploadOne(jpeg('café photo.jpg'), ['folder', publicFolder]);
    note = await uploadOne(text('0123456789abcdefghij', 'note.txt'), ['folder', publicFolder]);
    // The public may read the files of the public folder.
    await ok(await api('POST', '/permissions', { policy: PUBLIC_POLICY, collection: 'directus_files', action: 'read', permissions: { folder: { _eq: publicFolder } }, fields: ['id'] }));
  });

  it('serves the contents with Directus headers', async () => {
    const res = await asset(file.id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    const seconds = Math.floor(Date.parse(file.modified_on) / 1000);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'image/jpeg',
      'content-length': String(JPEG.length),
      'content-disposition': `inline; filename="caf? photo.jpg"; filename*=UTF-8''caf%C3%A9%20photo.jpg`,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=2592000',
      etag: `"${seconds}"`,
      'last-modified': new Date(Date.parse(file.modified_on)).toUTCString(),
      vary: 'Origin, Cache-Control',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
    });
  });

  it('takes the name from the path, downloads as attachments, and finds the id in a longer segment', async () => {
    expect((await asset(`${file.id}/cover.jpg`)).headers.get('content-disposition')).toBe('inline; filename="cover.jpg"');
    expect((await asset(`${file.id}?download`)).headers.get('content-disposition')).toMatch(/^attachment; /);
    expect((await asset(`${file.id}.jpg`)).status).toBe(200);
    expect(await errorOf(await asset('not-a-uuid'))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await errorOf(await asset('01a1875e-0000-7000-8000-000000000404'))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('serves byte ranges', async () => {
    const range = async (r: string) => {
      const res = await asset(note.id, { headers: { Range: r } });
      return { status: res.status, range: res.headers.get('content-range'), length: res.headers.get('content-length'), body: await res.text() };
    };
    expect(await range('bytes=0-3')).toEqual({ status: 206, range: 'bytes 0-3/20', length: '4', body: '0123' });
    expect(await range('bytes=16-')).toEqual({ status: 206, range: 'bytes 16-19/20', length: '4', body: 'ghij' });
    expect(await range('bytes=-2')).toEqual({ status: 206, range: 'bytes 18-19/20', length: '2', body: 'ij' });
    expect(await range('bytes=5-100')).toMatchObject({ status: 206, range: 'bytes 5-19/20', body: '56789abcdefghij' });
    expect(await range('items=0-1')).toMatchObject({ status: 200, body: '0123456789abcdefghij' });
    expect(await errorOf(await asset(note.id, { headers: { Range: 'bytes=20-' } }))).toMatchObject({ status: 416, code: 'RANGE_NOT_SATISFIABLE' });
    expect(await errorOf(await asset(note.id, { headers: { Range: 'bytes=5-2' } }))).toMatchObject({ status: 416 });
  });

  it('answers HEAD and conditional requests', async () => {
    const head = await asset(note.id, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('20');
    expect(await head.text()).toBe('');
    const etag = head.headers.get('etag')!;
    const lastModified = head.headers.get('last-modified')!;
    expect((await asset(note.id, { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await asset(note.id, { headers: { 'If-Modified-Since': lastModified } })).status).toBe(304);
    expect((await asset(note.id, { headers: { 'If-None-Match': '"0"' } })).status).toBe(200);
    expect((await asset(note.id, { headers: { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' } })).status).toBe(200);
  });

  it('serves the public what its permissions reach, cacheable by anyone', async () => {
    const res = await asset(file.id, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=2592000');
    const elsewhere = await uploadOne(jpeg());
    expect(await errorOf(await asset(elsewhere.id, { token: null }))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    // A token in the query string, as for <img src>.
    expect((await call(`/assets/${elsewhere.id}?access_token=${ADMIN_TOKEN}`)).status).toBe(200);
  });

  describe('transformations', () => {
    it('resizes and converts with the IMAGES binding, and keeps the result in R2', async () => {
      const res = await asset(`${file.id}?width=20&height=20&fit=cover&format=webp&quality=60`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WEBP');
      expect(res.headers.get('etag')).toMatch(/^"\d+-[0-9a-f]{24}"$/);
      const variants = (await objects()).filter((k) => k.startsWith(`${file.id}__`));
      expect(variants).toHaveLength(1);
      expect(variants[0]).toMatch(/\.webp$/);

      // The second request reads the kept variant.
      const again = await asset(`${file.id}?width=20&height=20&fit=cover&format=webp&quality=60`);
      expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    });

    it('negotiates the format of presets with Accept', async () => {
      const res = await asset(`${file.id}?key=system-small-cover`, { headers: { Accept: 'image/avif,image/webp,*/*' } });
      expect(res.headers.get('content-type')).toBe('image/avif');
      expect(res.headers.get('vary')).toBe('Origin, Cache-Control, Accept');
      const png = await asset(`${file.id}?width=8&format=png`);
      expect(png.headers.get('content-type')).toBe('image/png');
    });

    it('serves files that aren\'t transformable as they are', async () => {
      const res = await asset(`${note.id}?width=10`);
      expect(res.headers.get('content-type')).toBe('text/plain');
      expect(await res.text()).toBe('0123456789abcdefghij');
    });

    it('rejects bad parameters and images too large to transform', async () => {
      expect(await errorOf(await asset(`${file.id}?width=-1`))).toMatchObject({ status: 400, code: 'INVALID_QUERY' });
      expect(await errorOf(await asset(`${file.id}?format=tiff`))).toMatchObject({ code: 'INVALID_QUERY' });
      expect(await errorOf(await asset(`${file.id}?key=mine`))).toMatchObject({ code: 'INVALID_QUERY', reason: 'Key "mine" isn\'t configured' });
      expect(await errorOf(await asset(`${file.id}?transforms=[["negate"]]`))).toMatchObject({ code: 'INVALID_QUERY' });
      const huge = await uploadOne(jpeg());
      await ok(await api('PATCH', `/files/${huge.id}`, { width: 7000 }));
      expect(await errorOf(await asset(`${huge.id}?width=10`))).toMatchObject({ status: 400, code: 'ILLEGAL_ASSET_TRANSFORMATION' });
    });
  });
});

describe('imports', () => {
  const importFile = (body: unknown, token: string | null = ADMIN_TOKEN) => api('POST', '/files/import', body, token);

  it('fetches a URL and stores it like an upload', async () => {
    const file = await data<File>(await importFile({ url: 'https://files.test/images/sunset-photo.png', data: { description: 'From the web' } }));
    expect(file).toMatchObject({
      title: 'Sunset Photo.png',
      filename_download: 'sunset-photo.png',
      filename_disk: `${file.id}.png`,
      type: 'image/png',
      description: 'From the web',
      width: 2,
      height: 1,
      filesize: PNG.length,
    });
    expect(await stored(file.filename_disk!)).toEqual(PNG);
  });

  it('follows redirects and takes the name from the final URL', async () => {
    const file = await data<File>(await importFile({ url: 'https://files.test/redirect' }));
    expect(file).toMatchObject({ filename_download: 'café menu.txt', type: 'text/plain', filesize: 15, filename_disk: `${file.id}.txt` });
  });

  it('replaces the contents of the file `data.id` names', async () => {
    const existing = await uploadOne(jpeg());
    const file = await data<File>(await importFile({ url: 'https://files.test/images/sunset-photo.png', data: { id: existing.id } }));
    expect(file).toMatchObject({ id: existing.id, type: 'image/png', width: 2 });
    expect(await bucket().head(existing.filename_disk!)).toBeNull();
  });

  it('reports bad requests and unreachable files', async () => {
    expect(await errorOf(await importFile({}))).toMatchObject({ code: 'INVALID_PAYLOAD', reason: '"url" is required' });
    expect(await errorOf(await importFile({ url: 'ftp://files.test/a' }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await errorOf(await importFile({ url: 'https://files.test/missing' }))).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE', service: 'external-file' });
    expect(await errorOf(await importFile({ url: 'https://files.test/page.html', options: { filterMimeType: ['image/*'] } }))).toMatchObject({
      code: 'INVALID_PAYLOAD',
      reason: 'File content type "text/html" is not allowed for upload by this field\'s file type restrictions',
    });
    expect(await errorOf(await importFile({ url: 'https://files.test/images/sunset-photo.png' }, null))).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('ObjectWriter', () => {
  it('fails past the maximum size, leaving nothing behind', async () => {
    const writer = new ObjectWriter(bucket(), 'limited.bin', { contentType: 'application/octet-stream', maxSize: PART_SIZE + 10 });
    await writer.write(new Uint8Array(PART_SIZE));
    await expect(writer.write(new Uint8Array(11))).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE', status: 413 });
    await writer.abort();
    expect(await bucket().head('limited.bin')).toBeNull();
  });

  it('writes a file of exactly one part', async () => {
    const writer = new ObjectWriter(bucket(), 'exact.bin', { contentType: 'application/octet-stream', maxSize: null });
    await writer.write(new Uint8Array(PART_SIZE).fill(7));
    expect((await writer.finish()).size).toBe(PART_SIZE);
    expect((await bucket().head('exact.bin'))!.size).toBe(PART_SIZE);
  });
});
