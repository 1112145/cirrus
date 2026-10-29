<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

/** A modal dialog (the native <dialog>: focus trapping and Escape for free). */
const props = defineProps<{ open: boolean; title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);

function sync() {
  const d = dialog.value;
  if (!d) return;
  if (props.open && !d.open) d.showModal();
  if (!props.open && d.open) d.close();
}

onMounted(sync);
watch(() => props.open, sync);
</script>

<template>
  <dialog ref="dialog" class="dialog" :class="{ wide }" :aria-label="title" @cancel.prevent="emit('close')" @close="open && emit('close')">
    <template v-if="open">
      <div class="dialog-head">
        <h2>{{ title }}</h2>
        <span class="spacer" />
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="x" /></button>
      </div>
      <div class="dialog-body"><slot /></div>
      <div v-if="$slots.footer" class="dialog-foot"><slot name="footer" /></div>
    </template>
  </dialog>
</template>
