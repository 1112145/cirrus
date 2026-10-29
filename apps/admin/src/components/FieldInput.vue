<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { same } from '../lib/payload.ts';
import { type Field, interfaceOf } from '../lib/schema.ts';
import { fromInput, InputError, inputType, toInput } from '../lib/values.ts';
import { relationFor } from '../stores/model.ts';
import { schema } from '../stores/schema.ts';
import FileSelect from './FileSelect.vue';
import RelatedList from './RelatedList.vue';
import RelationSelect from './RelationSelect.vue';
import TagsInput from './TagsInput.vue';

/** The input for a field, chosen by its interface (Directus `meta.interface`) and type. */
const props = defineProps<{ field: Field; modelValue: unknown; disabled?: boolean; id?: string; invalid?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: unknown]; 'input-error': [message: string | null] }>();

const iface = computed(() => interfaceOf(props.field, schema.relations));
const relation = computed(() => relationFor(props.field));
const type = computed(() => props.field.type);

const choices = computed(() => {
  const raw = props.field.meta?.options?.choices;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (typeof c === 'object' && c !== null ? (c as { text?: unknown; value?: unknown }) : { text: c, value: c }))
    .map((c) => ({ text: String(c.text ?? c.value), value: c.value }));
});

/** Text inputs keep what was typed, so a half-typed number or JSON isn't lost. */
const text = ref(toInput(type.value, props.modelValue));
watch(
  () => props.modelValue,
  (v) => {
    let typed: unknown;
    try {
      typed = fromInput(type.value, text.value);
    } catch {
      typed = undefined;
    }
    if (!same(typed, v)) text.value = toInput(type.value, v);
  },
);

function onText(value: string) {
  text.value = value;
  try {
    emit('update:modelValue', fromInput(type.value, value));
    emit('input-error', null);
  } catch (e) {
    if (e instanceof InputError) emit('input-error', e.message);
    else throw e;
  }
}

const multiline = computed(() => ['input-multiline', 'input-rich-text-html', 'input-rich-text-md', 'input-code', 'textarea'].includes(iface.value) || type.value === 'json');
const asArray = computed(() => (Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map(String) : null));
const placeholder = computed(() => {
  const p = props.field.meta?.options?.placeholder;
  return typeof p === 'string' ? p : undefined;
});
</script>

<template>
  <!-- Relations -->
  <FileSelect v-if="relation?.kind === 'file'" :model-value="modelValue" :image="iface === 'file-image'" :disabled="disabled" @update:model-value="emit('update:modelValue', $event)" />
  <RelationSelect
    v-else-if="relation?.kind === 'm2o'"
    :model-value="modelValue"
    :related="relation.related"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <RelatedList
    v-else-if="relation?.kind === 'o2m' || relation?.kind === 'm2m'"
    :model-value="modelValue"
    :relation="relation"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />

  <!-- Choices, toggles, tags -->
  <label v-else-if="type === 'boolean'" class="checkbox">
    <input :id="id" type="checkbox" class="switch" :checked="modelValue === true" :disabled="disabled" @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)" />
    <span>{{ modelValue === true ? 'Enabled' : modelValue === false ? 'Disabled' : 'Not set' }}</span>
  </label>
  <select
    v-else-if="(iface === 'select-dropdown' || iface === 'select-radio') && choices.length"
    :id="id"
    class="input"
    :class="{ invalid }"
    :disabled="disabled"
    :value="modelValue === null || modelValue === undefined ? '' : String(modelValue)"
    @change="
      emit(
        'update:modelValue',
        ($event.target as HTMLSelectElement).value === '' ? null : (choices.find((c) => String(c.value) === ($event.target as HTMLSelectElement).value)?.value ?? null),
      )
    "
  >
    <option value="">—</option>
    <option v-for="c in choices" :key="String(c.value)" :value="String(c.value)">{{ c.text }}</option>
  </select>
  <TagsInput
    v-else-if="iface === 'tags' || iface === 'select-multiple-checkbox' || type === 'csv'"
    :id="id"
    :model-value="asArray"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />

  <!-- Text -->
  <div v-else-if="iface === 'presentation-divider'" class="divider" />
  <textarea
    v-else-if="multiline"
    :id="id"
    class="input"
    :class="{ code: type === 'json' || iface === 'input-code', invalid }"
    :value="text"
    :disabled="disabled"
    :placeholder="placeholder"
    @input="onText(($event.target as HTMLTextAreaElement).value)"
  />
  <input
    v-else
    :id="id"
    class="input"
    :class="{ invalid }"
    :type="inputType(type)"
    :step="type === 'float' || type === 'decimal' ? 'any' : inputType(type) === 'datetime-local' || type === 'time' ? 1 : undefined"
    :value="text"
    :disabled="disabled"
    :placeholder="placeholder"
    @input="onText(($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.divider {
  border-top: 1px solid var(--border);
}
</style>
