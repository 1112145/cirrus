<script setup lang="ts">
import { computed } from 'vue';
import { assetUrl } from '../api.ts';
import { renderTemplate } from '../lib/display.ts';
import { FILES } from '../lib/schema.ts';
import { templateFor } from '../stores/model.ts';

/** A related item as people recognize it: its display template, and a thumbnail for images. */
const props = defineProps<{ collection: string; item: unknown }>();

const label = computed(() => {
  if (props.item === null || props.item === undefined) return '';
  if (typeof props.item !== 'object') return String(props.item);
  const text = renderTemplate(templateFor(props.collection), props.item);
  if (text) return text;
  const fallback = props.collection === FILES ? (props.item as Record<string, unknown>).filename_download : null;
  return typeof fallback === 'string' ? fallback : '—';
});

const image = computed(() => {
  if (props.collection !== FILES || !props.item || typeof props.item !== 'object') return null;
  const file = props.item as { id?: string; type?: string | null };
  return file.id && file.type?.startsWith('image/') ? file.id : null;
});

/** A thumbnail, or the original when transformations aren't available. */
function fallback(e: Event) {
  const img = e.target as HTMLImageElement;
  if (image.value && !img.dataset.fallback) {
    img.dataset.fallback = '1';
    img.src = assetUrl(image.value);
  }
}
</script>

<template>
  <span class="item-label">
    <img v-if="image" class="thumb" :src="assetUrl(image, { key: 'system-small-cover' })" alt="" loading="lazy" @error="fallback" />
    <span class="text">{{ label }}</span>
  </span>
</template>

<style scoped>
.item-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
