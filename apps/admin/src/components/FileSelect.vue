<script setup lang="ts">
import { uploadFiles } from '@directus/sdk';
import { computed, ref } from 'vue';
import { assetUrl, request } from '../api.ts';
import { keyOf } from '../lib/payload.ts';
import { FILES } from '../lib/schema.ts';
import { notifyError } from '../stores/notify.ts';
import { can } from '../stores/schema.ts';
import Icon from './Icon.vue';
import ItemPicker from './ItemPicker.vue';

/** A file field (an M2O to directus_files): upload a file or choose one from the library. */
const props = defineProps<{ modelValue: unknown; image?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>();
const picking = ref(false);
const uploading = ref(false);
const input = ref<HTMLInputElement | null>(null);

type FileItem = { id: string; title?: string | null; type?: string | null; filename_download?: string | null };
const file = computed<FileItem | null>(() => {
  const id = keyOf(props.modelValue, 'id');
  if (id === null) return null;
  return typeof props.modelValue === 'object' ? (props.modelValue as FileItem) : { id: String(id) };
});
const isImage = computed(() => file.value?.type?.startsWith('image/') ?? props.image);

async function upload(e: Event) {
  const chosen = (e.target as HTMLInputElement).files?.[0];
  if (!chosen) return;
  uploading.value = true;
  try {
    const form = new FormData();
    form.append('file', chosen);
    const created = await request<FileItem>(uploadFiles(form, { fields: ['id', 'title', 'type', 'filename_download'] }));
    emit('update:modelValue', created);
  } catch (err) {
    notifyError(err);
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = '';
  }
}

function select(items: Array<Record<string, unknown>>) {
  picking.value = false;
  if (items[0]) emit('update:modelValue', items[0]);
}

function fallback(e: Event) {
  const img = e.target as HTMLImageElement;
  if (file.value && !img.dataset.fallback) {
    img.dataset.fallback = '1';
    img.src = assetUrl(file.value.id);
  }
}
</script>

<template>
  <div class="file-select" :class="{ disabled }">
    <div v-if="file" class="current">
      <img v-if="isImage" class="preview" :src="assetUrl(file.id, { key: 'system-medium-contain' })" alt="" @error="fallback" />
      <div v-else class="preview icon"><Icon name="file" :size="28" /></div>
      <div class="meta">
        <strong>{{ file.title || file.filename_download || 'File' }}</strong>
        <span v-if="file.type" class="subtle">{{ file.type }}</span>
        <a :href="assetUrl(file.id)" target="_blank" rel="noopener" class="open">Open <Icon name="external" :size="14" /></a>
      </div>
    </div>
    <div v-else class="empty-file subtle">{{ image ? 'No image' : 'No file' }}</div>
    <div v-if="!disabled" class="toolbar">
      <button type="button" class="btn small" :disabled="uploading || !can(FILES, 'create')" @click="input?.click()">
        <Icon name="upload" :size="16" />{{ uploading ? 'Uploading…' : 'Upload' }}
      </button>
      <button v-if="can(FILES, 'read')" type="button" class="btn small" @click="picking = true"><Icon name="image" :size="16" />Library</button>
      <button v-if="file" type="button" class="btn small" @click="emit('update:modelValue', null)"><Icon name="x" :size="16" />Remove</button>
      <input ref="input" type="file" class="visually-hidden" :accept="image ? 'image/*' : undefined" tabindex="-1" aria-hidden="true" @change="upload" />
    </div>
    <ItemPicker :open="picking" :collection="FILES" @close="picking = false" @select="select" />
  </div>
</template>

<style scoped>
.file-select {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--panel);
}

.file-select.disabled {
  background: var(--panel-2);
}

.current {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.preview {
  width: 120px;
  height: 80px;
  flex: none;
  border-radius: var(--radius-sm);
  object-fit: contain;
  background: var(--panel-2);
}

.preview.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-subtle);
}

.meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.meta strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

.empty-file {
  padding: 6px 0;
}
</style>
