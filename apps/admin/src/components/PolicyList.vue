<script setup lang="ts">
import { computed, ref } from 'vue';
import { type Policy, translate } from '../lib/access.ts';
import Icon from './Icon.vue';

/**
 * The policies attached to a role or a user: their access rows, as loaded (`{ id, policy: { id, name } }`)
 * or added here (`{ policy: { id, name } }`).
 */
export type AccessRow = { id?: string; policy: { id: string; name: string } | string };

const props = defineProps<{ modelValue: AccessRow[]; policies: Policy[]; disabled?: boolean; empty?: string }>();
const emit = defineEmits<{ 'update:modelValue': [rows: AccessRow[]] }>();

const policyOf = (row: AccessRow) =>
  typeof row.policy === 'object' ? row.policy : { id: row.policy, name: props.policies.find((p) => p.id === row.policy)?.name ?? row.policy };
const attachable = computed(() => props.policies.filter((p) => !props.modelValue.some((r) => policyOf(r).id === p.id)));
const chosen = ref('');

function add() {
  const policy = props.policies.find((p) => p.id === chosen.value);
  if (!policy) return;
  emit('update:modelValue', [...props.modelValue, { policy: { id: policy.id, name: policy.name } }]);
  chosen.value = '';
}

const remove = (i: number) => emit('update:modelValue', props.modelValue.filter((_, j) => j !== i));
</script>

<template>
  <div class="policy-list input" :class="{ disabled }">
    <ul v-if="modelValue.length" class="rows">
      <li v-for="(row, i) in modelValue" :key="policyOf(row).id" class="row">
        <Icon name="shield" :size="16" />
        <span class="name">{{ translate(policyOf(row).name) }}</span>
        <span class="spacer" />
        <RouterLink class="icon-btn" :to="`/settings/policies/${policyOf(row).id}`" aria-label="Open policy"><Icon name="external" :size="16" /></RouterLink>
        <button v-if="!disabled" type="button" class="icon-btn danger" :aria-label="`Remove ${translate(policyOf(row).name)}`" @click="remove(i)">
          <Icon name="x" :size="16" />
        </button>
      </li>
    </ul>
    <div v-else class="subtle none">{{ empty ?? 'No policies.' }}</div>
    <div v-if="!disabled && attachable.length" class="toolbar">
      <select v-model="chosen" class="input attach" aria-label="Policy to add">
        <option value="">Add a policy…</option>
        <option v-for="p in attachable" :key="p.id" :value="p.id">{{ translate(p.name) }}</option>
      </select>
      <button type="button" class="btn small" :disabled="!chosen" @click="add"><Icon name="plus" :size="16" />Add</button>
    </div>
  </div>
</template>

<style scoped>
.policy-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}

.policy-list.disabled {
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

.row > .icon {
  color: var(--text-subtle);
}

.none {
  padding: 4px 2px;
}

.attach {
  width: auto;
  min-width: 220px;
}
</style>
