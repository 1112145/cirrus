<script setup lang="ts">
import { computed } from 'vue';
import { assetUrl } from '../api.ts';
import { renderTemplate } from '../lib/display.ts';
import { FILES } from '../lib/schema.ts';
import { fallbackLabel, USERS } from '../lib/system.ts';
import { templateFor } from '../stores/model.ts';

/** A related item as people recognize it: its display template, and a thumbnail for images and avatars. */
const props = defineProps<{ collection: string; item: unknown }>();

const label = computed(() => {
  if (props.item === null || props.item === undefined) return '';
  if (typeof props.item !== 'object') return String(props.item);
  const text = renderTemplate(templateFor(props.collection), props.item);
  return text || fallbackLabel(props.collection, props.item as Record<string, unknown>) || '—';
});

/** The image to show: an image file itself, or a user's avatar. */
const image = computed(() => {
  if (!props.item || typeof props.item !== 'object') return null;
  if (props.collection === FILES) {
    const file = props.item as { id?: string; type?: string | null };
    return file.id && file.type?.startsWith('image/') ? file.id : null;
  }
  if (props.collection === USERS) {
    const avatar = (props.item as { avatar?: unknown }).avatar;
    return typeof avatar === 'string' ? avatar : null;
  }
  return null;
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
    <img
      v-if="image"
      class="thumb"
      :class="{ round: collection === USERS }"
      :src="assetUrl(image, { key: 'system-small-cover' })"
      alt=""
      loading="lazy"
      @error="fallback"
    />
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

.thumb.round {
  border-radius: 50%;
}
</style>
