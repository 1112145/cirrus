<script setup lang="ts">
import { computed } from 'vue';
import { formatValue } from '../lib/display.ts';
import type { Field } from '../lib/schema.ts';
import { relationFor } from '../stores/model.ts';
import ItemLabel from './ItemLabel.vue';

/** A value in a list's cell. */
const props = defineProps<{ field: Field; value: unknown }>();

const relation = computed(() => relationFor(props.field));

const text = computed(() => {
  const v = props.value;
  if (v === null || v === undefined || v === '') return '';
  if (props.field.type === 'timestamp' || props.field.type === 'dateTime') {
    const d = new Date(props.field.type === 'dateTime' ? `${String(v)}` : String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }
  if (props.field.type === 'date') {
    const d = new Date(`${String(v)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
  }
  // Dropdowns show the text of the chosen value.
  const choices = props.field.meta?.options?.choices;
  if (Array.isArray(choices)) {
    const choice = choices.find((c) => typeof c === 'object' && c !== null && (c as { value?: unknown }).value === v) as { text?: unknown } | undefined;
    if (choice?.text !== undefined) return String(choice.text);
  }
  return formatValue(v);
});
</script>

<template>
  <ItemLabel v-if="relation && (relation.kind === 'm2o' || relation.kind === 'file') && value !== null && value !== undefined" :collection="relation.related" :item="value" />
  <span v-else-if="field.type === 'boolean' && value !== null && value !== undefined" class="badge" :class="{ primary: value === true }">{{ text }}</span>
  <span v-else-if="text">{{ text }}</span>
  <span v-else class="subtle">—</span>
</template>
