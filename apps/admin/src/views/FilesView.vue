<script setup lang="ts">
import { createFolder, deleteFolder, readFolders, updateFolder, uploadFiles } from '@directus/sdk';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { assetUrl, readPage, request } from '../api.ts';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import NavList from '../components/NavList.vue';
import PageLayout from '../components/PageLayout.vue';
import { fileSize } from '../lib/display.ts';
import { errorMessage } from '../lib/errors.ts';
import { FILES } from '../lib/schema.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';
import { can } from '../stores/schema.ts';

/** The file library: folders, a grid of files, uploads (button or drag and drop). */
const route = useRoute();
const router = useRouter();

type Folder = { id: string; name: string; parent: string | null };
type FileRow = { id: string; title: string | null; type: string | null; filesize: number | null; filename_download: string | null; width: number | null; height: number | null };

const PAGE = 48;
const folders = ref<Folder[]>([]);
const files = ref<FileRow[]>([]);
const total = ref(0);
const page = ref(1);
const search = ref('');
const loading = ref(false);
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE)));

const folderId = computed(() => (typeof route.query.folder === 'string' ? route.query.folder : null));
const folder = computed(() => folders.value.find((f) => f.id === folderId.value) ?? null);

// Folders ----------------------------------------------------------------------------------------

async function loadFolders() {
  if (!can('directus_folders', 'read')) return;
  try {
    folders.value = await request<Folder[]>(readFolders({ fields: ['id', 'name', 'parent'], limit: -1, sort: ['name'] }));
  } catch (e) {
    notifyError(e);
  }
}

/** The folder tree, flattened in display order with each folder's depth. */
const tree = computed(() => {
  const out: Array<{ folder: Folder; depth: number }> = [];
  const known = new Set(folders.value.map((f) => f.id));
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.value.filter((x) => (x.parent && known.has(x.parent) ? x.parent : null) === parent)) {
      out.push({ folder: f, depth });
      if (depth < 20) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
});

const nav = computed(() => [
  { key: 'all', label: 'All files', to: '/files', icon: 'image' as const, active: folderId.value === null },
  ...tree.value.map(({ folder: f, depth }) => ({
    key: f.id,
    label: f.name,
    to: { path: '/files', query: { folder: f.id } },
    icon: 'folder' as const,
    active: f.id === folderId.value,
    depth,
  })),
]);

const folderDialog = ref<{ open: boolean; mode: 'create' | 'rename'; name: string; error: string | null; busy: boolean }>({
  open: false,
  mode: 'create',
  name: '',
  error: null,
  busy: false,
});

function openFolderDialog(mode: 'create' | 'rename') {
  folderDialog.value = { open: true, mode, name: mode === 'rename' ? (folder.value?.name ?? '') : '', error: null, busy: false };
}

async function submitFolder() {
  const d = folderDialog.value;
  const name = d.name.trim();
  if (!name) {
    d.error = 'A name is required.';
    return;
  }
  d.busy = true;
  try {
    if (d.mode === 'create') {
      const created = await request<Folder>(createFolder({ name, parent: folderId.value }, { fields: ['id', 'name', 'parent'] }));
      await loadFolders();
      await router.push({ path: '/files', query: { folder: created.id } });
    } else if (folder.value) {
      await request(updateFolder(folder.value.id, { name }));
      await loadFolders();
    }
    d.open = false;
  } catch (e) {
    d.error = errorMessage(e);
  } finally {
    d.busy = false;
  }
}

async function removeFolder() {
  const f = folder.value;
  if (!f) return;
  if (folders.value.some((x) => x.parent === f.id)) {
    notify('Delete or move this folder’s subfolders first.', 'error');
    return;
  }
  const ok = await confirm(`Delete the folder “${f.name}”? Its files stay in the library, outside any folder.`, { action: 'Delete', danger: true });
  if (!ok) return;
  try {
    await request(deleteFolder(f.id));
    notify('Folder deleted.');
    await loadFolders();
    await router.push(f.parent ? { path: '/files', query: { folder: f.parent } } : '/files');
  } catch (e) {
    notifyError(e);
  }
}

// Files ------------------------------------------------------------------------------------------

async function load() {
  loading.value = true;
  try {
    const res = await readPage<FileRow>('/files', {
      fields: ['id', 'title', 'type', 'filesize', 'filename_download', 'width', 'height'],
      filter: folderId.value ? { folder: { _eq: folderId.value } } : undefined,
      search: search.value || undefined,
      sort: ['-uploaded_on'],
      limit: PAGE,
      page: page.value,
    });
    files.value = res.data;
    total.value = res.total;
  } catch (e) {
    notifyError(e);
  } finally {
    loading.value = false;
  }
}

void loadFolders();
watch(
  folderId,
  () => {
    page.value = 1;
    void load();
  },
  { immediate: true },
);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    page.value = 1;
    void load();
  }, 250);
});

function go(delta: number) {
  page.value = Math.min(pages.value, Math.max(1, page.value + delta));
  void load();
}

// Uploads ----------------------------------------------------------------------------------------

const input = ref<HTMLInputElement | null>(null);
const uploading = ref<{ done: number; total: number } | null>(null);
const dragging = ref(false);
const mayUpload = computed(() => can(FILES, 'create'));

/** Uploads one at a time: each file is its own request, so one failing doesn't stop the rest. */
async function upload(list: FileList | File[]) {
  const chosen = [...list];
  if (!chosen.length || !mayUpload.value) return;
  uploading.value = { done: 0, total: chosen.length };
  let failed = 0;
  for (const file of chosen) {
    const form = new FormData();
    // Directus reads the fields before the file.
    if (folderId.value) form.append('folder', folderId.value);
    form.append('file', file);
    try {
      await request(uploadFiles(form, { fields: ['id'] }));
    } catch (e) {
      failed++;
      notify(`${file.name}: ${errorMessage(e)}`, 'error');
    }
    uploading.value = { done: uploading.value.done + 1, total: chosen.length };
  }
  const ok = chosen.length - failed;
  if (ok) notify(`Uploaded ${ok} file${ok === 1 ? '' : 's'}.`);
  uploading.value = null;
  page.value = 1;
  await load();
}

function picked(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.files) void upload(el.files);
  el.value = '';
}

let depth = 0;
function dragEnter(e: DragEvent) {
  if (!mayUpload.value || !e.dataTransfer?.types.includes('Files')) return;
  depth++;
  dragging.value = true;
}
function dragLeave() {
  depth = Math.max(0, depth - 1);
  if (depth === 0) dragging.value = false;
}
function drop(e: DragEvent) {
  depth = 0;
  dragging.value = false;
  if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
}

// Display ----------------------------------------------------------------------------------------

const isImage = (f: FileRow) => f.type?.startsWith('image/') ?? false;

function fallback(e: Event, f: FileRow) {
  const img = e.target as HTMLImageElement;
  if (!img.dataset.fallback) {
    img.dataset.fallback = '1';
    img.src = assetUrl(f.id);
  }
}
</script>

<template>
  <PageLayout :title="folder?.name ?? 'File library'" :subtitle="`${total} file${total === 1 ? '' : 's'}`">
    <template #nav>
      <NavList heading="File library" :items="nav" />
      <button v-if="can('directus_folders', 'create')" type="button" class="btn small new-folder" @click="openFolderDialog('create')">
        <Icon name="plus" :size="16" />New folder
      </button>
    </template>
    <template #actions>
      <label class="search">
        <Icon name="search" :size="18" />
        <input v-model="search" class="input" type="search" placeholder="Search files…" aria-label="Search files" />
      </label>
      <template v-if="folder">
        <button v-if="can('directus_folders', 'update')" type="button" class="icon-btn" title="Rename folder" aria-label="Rename folder" @click="openFolderDialog('rename')">
          <Icon name="edit" />
        </button>
        <button v-if="can('directus_folders', 'delete')" type="button" class="icon-btn danger" title="Delete folder" aria-label="Delete folder" @click="removeFolder">
          <Icon name="trash" />
        </button>
      </template>
      <button v-if="mayUpload" type="button" class="btn primary" :disabled="!!uploading" @click="input?.click()">
        <Icon name="upload" :size="18" />{{ uploading ? `Uploading ${uploading.done + 1} of ${uploading.total}…` : 'Upload' }}
      </button>
      <input ref="input" type="file" multiple class="visually-hidden" tabindex="-1" aria-hidden="true" data-test="upload-input" @change="picked" />
    </template>

    <div class="drop-area" :class="{ dragging }" @dragenter.prevent="dragEnter" @dragover.prevent @dragleave="dragLeave" @drop.prevent="drop">
      <div v-if="dragging" class="drop-hint"><Icon name="upload" :size="32" />Drop files to upload{{ folder ? ` to ${folder.name}` : '' }}</div>
      <div v-if="files.length" class="grid" :class="{ loading }">
        <RouterLink v-for="f in files" :key="f.id" :to="`/files/${f.id}`" class="card tile">
          <div class="preview">
            <img v-if="isImage(f)" :src="assetUrl(f.id, { key: 'system-medium-cover' })" alt="" loading="lazy" @error="fallback($event, f)" />
            <Icon v-else name="file" :size="36" />
          </div>
          <div class="info">
            <strong :title="f.title ?? undefined">{{ f.title || f.filename_download }}</strong>
            <span class="subtle">{{ f.type?.split('/')[1]?.toUpperCase() ?? 'FILE' }} · {{ fileSize(f.filesize) }}</span>
          </div>
        </RouterLink>
      </div>
      <div v-else-if="!loading" class="empty card">
        <Icon name="image" :size="32" />
        <p>{{ search ? 'No files match your search.' : folder ? 'This folder is empty.' : 'No files yet.' }}</p>
        <p v-if="mayUpload && !search" class="subtle">Drop files here, or use Upload.</p>
      </div>
      <div v-if="pages > 1" class="pagination">
        <span class="spacer" />
        <button type="button" class="icon-btn" :disabled="page <= 1" aria-label="Previous page" @click="go(-1)"><Icon name="left" /></button>
        <span>{{ page }} / {{ pages }}</span>
        <button type="button" class="icon-btn" :disabled="page >= pages" aria-label="Next page" @click="go(1)"><Icon name="right" /></button>
      </div>
    </div>

    <Modal :open="folderDialog.open" :title="folderDialog.mode === 'create' ? 'New folder' : 'Rename folder'" @close="folderDialog.open = false">
      <form id="folder-form" class="field" @submit.prevent="submitFolder">
        <label for="folder-name">Name</label>
        <input id="folder-name" v-model="folderDialog.name" class="input" autofocus />
        <div v-if="folderDialog.error" class="error">{{ folderDialog.error }}</div>
        <div v-else-if="folderDialog.mode === 'create' && folder" class="hint">Inside {{ folder.name }}</div>
      </form>
      <template #footer>
        <button type="button" class="btn" @click="folderDialog.open = false">Cancel</button>
        <button type="submit" form="folder-form" class="btn primary" :disabled="folderDialog.busy">{{ folderDialog.mode === 'create' ? 'Create' : 'Save' }}</button>
      </template>
    </Modal>
  </PageLayout>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-subtle);
}

.search .input {
  width: 220px;
}

.new-folder {
  margin: 12px 10px 0;
}

.drop-area {
  position: relative;
  min-height: 100%;
}

.drop-area.dragging {
  outline: 2px dashed var(--primary);
  outline-offset: 6px;
  border-radius: var(--radius);
}

.drop-hint {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--primary-soft) 88%, transparent);
  color: var(--primary);
  font-weight: 600;
  pointer-events: none;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
}

.grid.loading {
  opacity: 0.6;
}

.tile {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text);
}

.tile:hover {
  border-color: var(--primary);
}

.preview {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  background: var(--panel-2);
  color: var(--text-subtle);
}

.preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.info {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  min-width: 0;
  font-size: 13px;
}

.info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
