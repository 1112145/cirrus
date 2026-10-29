<script setup lang="ts">
import { computed, ref } from 'vue';
import { keyOf } from '../lib/payload.ts';
import type { RelationInfo } from '../lib/schema.ts';
import { can, primaryKeyOf } from '../stores/schema.ts';
import Icon from './Icon.vue';
import ItemLabel from './ItemLabel.vue';
import ItemPicker from './ItemPicker.vue';

/**
 * An O2M or M2M field: the related items, which can be removed or added from existing ones. The
 * value is the list as loaded: related items (O2M), or junction rows holding them (M2M).
 */
const props = defineProps<{ modelValue: unknown; relation: Extract<RelationInfo, { kind: 'o2m' | 'm2m' }>; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: unknown[]] }>();
const picking = ref(false);

type Row = Record<string, unknown>;
const rows = computed<Row[]>(() => (Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map((v) => (typeof v === 'object' && v ? (v as Row) : { [pkOfRow.value]: v })) : []));

/** The key of a row's own item: the related item (O2M) or the junction row (M2M). */
const pkOfRow = computed(() => primaryKeyOf(props.relation.kind === 'm2m' ? props.relation.junction : props.relation.related));
const relatedPk = computed(() => primaryKeyOf(props.relation.related));

/** The related item a row shows. */
const relatedOf = (row: Row): unknown => (props.relation.kind === 'm2m' ? row[props.relation.junctionField] : row);

const relatedKeys = computed(() => rows.value.map((r) => keyOf(relatedOf(r), relatedPk.value)).filter((k): k is string | number => k !== null));

function remove(i: number) {
  emit(
    'update:modelValue',
    rows.value.filter((_, j) => j !== i),
  );
}

function add(items: Row[]) {
  picking.value = false;
  const added = props.relation.kind === 'm2m' ? items.map((item) => ({ [(props.relation as { junctionField: string }).junctionField]: item })) : items;
  emit('update:modelValue', [...rows.value, ...added]);
}
</script>

<template>
  <div class="related input" :class="{ disabled }">
    <ul v-if="rows.length" class="rows">
      <li v-for="(row, i) in rows" :key="i" class="row">
        <ItemLabel :collection="relation.related" :item="relatedOf(row)" />
        <span class="spacer" />
        <RouterLink
          v-if="keyOf(relatedOf(row), relatedPk) !== null && relation.related !== 'directus_files'"
          class="icon-btn"
          :to="`/content/${relation.related}/${keyOf(relatedOf(row), relatedPk)}`"
          aria-label="Open"
        >
          <Icon name="external" :size="16" />
        </RouterLink>
        <button v-if="!disabled" type="button" class="icon-btn danger" aria-label="Remove" @click="remove(i)"><Icon name="x" :size="16" /></button>
      </li>
    </ul>
    <div v-else class="subtle none">No items</div>
    <div v-if="!disabled && can(relation.related, 'read')" class="toolbar">
      <button type="button" class="btn small" @click="picking = true"><Icon name="plus" :size="16" />Add existing</button>
    </div>
    <ItemPicker :open="picking" :collection="relation.related" multiple :exclude="relatedKeys" @close="picking = false" @select="add" />
  </div>
</template>

<style scoped>
.related {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}

.related.disabled {
  background: var(--panel-2);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
}

.none {
  padding: 4px 2px;
}
</style>
