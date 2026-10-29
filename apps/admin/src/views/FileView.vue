<script setup lang="ts">
import { deleteFile, readFile, readFolders, updateFile } from '@directus/sdk';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { assetUrl, request } from '../api.ts';
import FieldInput from '../components/FieldInput.vue';
import { useUnsavedGuard } from '../composables/unsaved.ts';
import Icon from '../components/Icon.vue';
import PageLayout from '../components/PageLayout.vue';
import { fileSize } from '../lib/display.ts';
import { errorCode, errorMessage, fieldErrors } from '../lib/errors.ts';
import { changes, type Item, same } from '../lib/payload.ts';
import { FILES, type Field, titleOf } from '../lib/schema.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';
import { can, fieldsOf } from '../stores/schema.ts';

/** A file: preview, details, its editable metadata; download, replace or delete it. */
const route = useRoute();
const router = useRouter();

type Folder = { id: string; name: string; parent: string | null };
type FileItem = Item & {
  id: string;
  title: string | null;
  type: string | null;
  filesize: number | null;
  width: number | null;
  height: number | null;
  filename_download: string;
  folder: string | null;
  uploaded_on: string | null;
  modified_on: string | null;
};

const id = computed(() => String(route.params.id));
const file = ref<FileItem | null>(null);
const edits = ref<Item>({});
const errors = ref<Record<string, string>>({});
const inputErrors = ref<Record<string, string>>({});
const folders = ref<Folder[]>([]);
const missing = ref(false);
const saving = ref(false);
const replacing = ref(false);
/** Changes after a replace, so the browser loads the new contents. */
const version = ref(0);

const editable = computed(() => fieldsOf(FILES).filter((f) => !f.meta?.hidden && !f.meta?.readonly));
const mayUpdate = computed(() => can(FILES, 'update'));

async function load() {
  edits.value = {};
  errors.value = {};
  inputErrors.value = {};
  missing.value = false;
  file.value = null;
  try {
    file.value = await request<FileItem>(readFile(id.value, { fields: ['*'] }));
  } catch (e) {
    missing.value = true;
    if (errorCode(e) !== 'FORBIDDEN') notifyError(e);
  }
}

watch(id, load, { immediate: true });

onMounted(async () => {
  if (!can('directus_folders', 'read')) return;
  try {
    folders.value = await request<Folder[]>(readFolders({ fields: ['id', 'name', 'parent'], limit: -1, sort: ['name'] }));
  } catch {
    // The folder field just offers fewer choices.
  }
});

const values = computed<Item>(() => ({ ...(file.value ?? {}), ...edits.value }));
const pending = computed(() => (file.value ? changes(file.value, edits.value) : {}));
const dirty = computed(() => Object.keys(pending.value).length > 0);

function set(field: string, value: unknown) {
  const next = { ...edits.value };
  if (file.value && same(file.value[field], value)) delete next[field];
  else next[field] = value;
  edits.value = next;
}

function setInputError(field: string, message: string | null) {
  const next = { ...inputErrors.value };
  if (message) next[field] = message;
  else delete next[field];
  inputErrors.value = next;
}

async function save() {
  if (!dirty.value || saving.value) return;
  if (Object.keys(inputErrors.value).length) {
    notify('Fix the highlighted fields first.', 'error');
    return;
  }
  saving.value = true;
  errors.value = {};
  try {
    file.value = await request<FileItem>(updateFile(id.value, pending.value, { fields: ['*'] }));
    edits.value = {};
    notify('Saved.');
  } catch (e) {
    errors.value = fieldErrors(e);
    notify(errorMessage(e), 'error');
  } finally {
    saving.value = false;
  }
}

const replaceInput = ref<HTMLInputElement | null>(null);

async function replace(e: Event) {
  const el = e.target as HTMLInputElement;
  const chosen = el.files?.[0];
  el.value = '';
  if (!chosen) return;
  replacing.value = true;
  try {
    const form = new FormData();
    form.append('file', chosen);
    const updated = await request<FileItem>(updateFile(id.value, form, { fields: ['*'] }));
    file.value = updated;
    version.value++;
    notify('File replaced.');
  } catch (err) {
    notifyError(err);
  } finally {
    replacing.value = false;
  }
}

async function remove() {
  if (!(await confirm('Delete this file? Items using it lose it, and this can’t be undone.', { action: 'Delete', danger: true }))) return;
  try {
    const folder = file.value?.folder;
    await request(deleteFile(id.value));
    edits.value = {};
    notify('File deleted.');
    await router.push(folder ? { path: '/files', query: { folder } } : '/files');
  } catch (e) {
    notifyError(e);
  }
}

// Unsaved changes ----------------------------------------------------------------------------------

useUnsavedGuard(dirty, save);

// Display ----------------------------------------------------------------------------------------

const kind = computed(() => {
  const type = file.value?.type ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'other';
});

const src = computed(() => {
  if (!file.value) return '';
  const url = assetUrl(file.value.id, kind.value === 'image' ? { key: 'system-large-contain' } : {});
  return version.value ? `${url}${url.includes('?') ? '&' : '?'}v=${version.value}` : url;
});

function fallback(e: Event) {
  const img = e.target as HTMLImageElement;
  if (file.value && !img.dataset.fallback) {
    img.dataset.fallback = '1';
    img.src = `${assetUrl(file.value.id)}?v=${version.value}`;
  }
}

const details = computed(() => {
  const f = file.value;
  if (!f) return [];
  const rows: Array<[string, string]> = [
    ['Type', f.type ?? '—'],
    ['Size', fileSize(f.filesize) || '—'],
  ];
  if (f.width && f.height) rows.push(['Dimensions', `${f.width} × ${f.height}`]);
  if (f.uploaded_on) rows.push(['Uploaded', new Date(f.uploaded_on).toLocaleString()]);
  if (f.modified_on) rows.push(['Modified', new Date(f.modified_on).toLocaleString()]);
  return rows;
});

/** Folders as options, indented by depth. */
const folderOptions = computed(() => {
  const out: Array<{ id: string; label: string }> = [];
  const known = new Set(folders.value.map((f) => f.id));
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.value.filter((x) => (x.parent && known.has(x.parent) ? x.parent : null) === parent)) {
      out.push({ id: f.id, label: `${'  '.repeat(depth)}${f.name}` });
      if (depth < 20) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
});

const width = (f: Field) => (f.meta?.width === 'half' ? 'half' : 'full');
</script>

<template>
  <PageLayout :subtitle="file?.filename_download">
    <template #back>
      <RouterLink :to="file?.folder ? { path: '/files', query: { folder: file.folder } } : '/files'" class="icon-btn" aria-label="Back to the library">
        <Icon name="back" />
      </RouterLink>
    </template>
    <template #title>
      <h1>{{ file ? file.title || file.filename_download : 'File' }}</h1>
    </template>
    <template v-if="file" #actions>
      <span v-if="dirty" class="badge">Unsaved changes</span>
      <a :href="assetUrl(file.id, { download: true })" class="icon-btn" title="Download" aria-label="Download"><Icon name="download" /></a>
      <button v-if="mayUpdate" type="button" class="icon-btn" title="Replace file" aria-label="Replace file" :disabled="replacing" @click="replaceInput?.click()">
        <Icon name="replace" />
      </button>
      <input ref="replaceInput" type="file" class="visually-hidden" tabindex="-1" aria-hidden="true" data-test="replace-input" @change="replace" />
      <button v-if="can(FILES, 'delete')" type="button" class="icon-btn danger" title="Delete" aria-label="Delete file" @click="remove"><Icon name="trash" /></button>
      <button type="button" class="btn primary" :disabled="!dirty || saving || !mayUpdate" @click="save">
        <Icon name="check" :size="18" />{{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>

    <div v-if="missing" class="empty card">
      <p>This file doesn't exist, or you may not read it.</p>
      <RouterLink to="/files" class="btn">Back to the library</RouterLink>
    </div>
    <div v-else-if="!file" class="subtle">Loading…</div>
    <div v-else class="layout">
      <div class="side">
        <div class="card preview" :class="{ busy: replacing }">
          <img v-if="kind === 'image'" :src="src" :alt="file.title ?? ''" @error="fallback" />
          <video v-else-if="kind === 'video'" :src="src" controls />
          <audio v-else-if="kind === 'audio'" :src="src" controls />
          <div v-else class="other"><Icon name="file" :size="48" /><span>{{ file.type ?? 'File' }}</span></div>
        </div>
        <dl class="card details">
          <template v-for="[k, v] in details" :key="k">
            <dt>{{ k }}</dt>
            <dd>{{ v }}</dd>
          </template>
        </dl>
      </div>
      <form class="card form" novalidate @submit.prevent="save">
        <div class="form-grid">
          <div v-for="f in editable" :key="f.field" class="field" :class="width(f)">
            <label :for="`field-${f.field}`">{{ f.field === 'filename_download' ? 'Download name' : titleOf(f.field) }}</label>
            <FieldInput
              :id="`field-${f.field}`"
              :field="f"
              :model-value="values[f.field] ?? null"
              :disabled="!mayUpdate"
              :invalid="!!(errors[f.field] || inputErrors[f.field])"
              @update:model-value="set(f.field, $event)"
              @input-error="setInputError(f.field, $event)"
            />
            <div v-if="errors[f.field] || inputErrors[f.field]" class="error">{{ errors[f.field] || inputErrors[f.field] }}</div>
          </div>
          <div v-if="can('directus_folders', 'read')" class="field half">
            <label for="field-folder">Folder</label>
            <select
              id="field-folder"
              class="input"
              :disabled="!mayUpdate"
              :value="(values.folder as string | null) ?? ''"
              @change="set('folder', ($event.target as HTMLSelectElement).value || null)"
            >
              <option value="">No folder</option>
              <option v-for="o in folderOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </div>
  </PageLayout>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(260px, 420px) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

@media (max-width: 960px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  overflow: hidden;
  background: var(--panel-2);
}

.preview.busy {
  opacity: 0.5;
}

.preview img,
.preview video {
  display: block;
  max-width: 100%;
  max-height: 420px;
}

.preview audio {
  width: calc(100% - 32px);
}

.other {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--text-subtle);
}

.details {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  margin: 0;
  padding: 16px;
  font-size: 13px;
}

.details dt {
  color: var(--text-muted);
}

.details dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.form {
  padding: 24px;
}
</style>
