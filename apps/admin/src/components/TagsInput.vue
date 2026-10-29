<script setup lang="ts">
import { ref } from 'vue';
import { tags as split } from '../lib/values.ts';
import Icon from './Icon.vue';

/** A list of tags: type and press Enter (or a comma) to add one. */
const props = defineProps<{ modelValue: string[] | null; disabled?: boolean; id?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string[] | null] }>();
const draft = ref('');

function add() {
  const added = split(draft.value);
  draft.value = '';
  if (!added.length) return;
  const next = [...new Set([...(props.modelValue ?? []), ...added])];
  emit('update:modelValue', next);
}

function remove(tag: string) {
  const next = (props.modelValue ?? []).filter((t) => t !== tag);
  emit('update:modelValue', next.length ? next : null);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    add();
  } else if (e.key === 'Backspace' && !draft.value && props.modelValue?.length) {
    remove(props.modelValue[props.modelValue.length - 1]!);
  }
}
</script>

<template>
  <div class="tags input" :class="{ disabled }">
    <span v-for="tag in modelValue ?? []" :key="tag" class="tag">
      {{ tag }}
      <button v-if="!disabled" type="button" :aria-label="`Remove ${tag}`" @click="remove(tag)"><Icon name="x" :size="12" /></button>
    </span>
    <input v-if="!disabled" :id="id" v-model="draft" placeholder="Add a tag…" @keydown="onKey" @blur="add" />
  </div>
</template>

<style scoped>
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.tags.disabled {
  background: var(--panel-2);
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border-radius: 12px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 13px;
  font-weight: 500;
}

.tag button {
  display: inline-flex;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 2px;
}

input {
  flex: 1;
  min-width: 120px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
}
</style>
