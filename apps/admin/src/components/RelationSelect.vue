<script setup lang="ts">
import { computed, ref } from 'vue';
import { keyOf } from '../lib/payload.ts';
import { can, primaryKeyOf } from '../stores/schema.ts';
import Icon from './Icon.vue';
import ItemLabel from './ItemLabel.vue';
import ItemPicker from './ItemPicker.vue';

/**
 * An M2O field: the related item it points at, chosen from that collection. The value is the
 * item as loaded (with its template's fields) or, once changed, the chosen item.
 */
const props = defineProps<{ modelValue: unknown; related: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>();
const picking = ref(false);

const key = computed(() => keyOf(props.modelValue, primaryKeyOf(props.related)));
const readable = computed(() => can(props.related, 'read'));

function select(items: Array<Record<string, unknown>>) {
  picking.value = false;
  if (items[0]) emit('update:modelValue', items[0]);
}
</script>

<template>
  <div class="relation input" :class="{ disabled }">
    <ItemLabel v-if="key !== null" class="label" :collection="related" :item="modelValue" />
    <span v-else class="placeholder subtle">None</span>
    <span class="spacer" />
    <template v-if="!disabled">
      <button v-if="readable" type="button" class="btn small" @click="picking = true">{{ key === null ? 'Select' : 'Change' }}</button>
      <button v-if="key !== null" type="button" class="icon-btn" aria-label="Clear" @click="emit('update:modelValue', null)"><Icon name="x" :size="16" /></button>
    </template>
    <ItemPicker :open="picking" :collection="related" @close="picking = false" @select="select" />
  </div>
</template>

<style scoped>
.relation {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
  padding-bottom: 4px;
}

.relation.disabled {
  background: var(--panel-2);
}

.label {
  min-width: 0;
}
</style>
