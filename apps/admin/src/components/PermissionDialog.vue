<script setup lang="ts">
import { createPermission, deletePermission, updatePermission } from '@directus/sdk';
import { computed, ref, watch } from 'vue';
import { request } from '../api.ts';
import { type Action, filterSuggestions, fullPermission, type Level, levelOf, objectText, parseObject, type Permission } from '../lib/access.ts';
import { errorMessage } from '../lib/errors.ts';
import { isSystem, SYSTEM_FIELDS } from '../lib/system.ts';
import { InputError } from '../lib/values.ts';
import { fieldsOf } from '../stores/schema.ts';
import Modal from './Modal.vue';

/**
 * One permission of a policy: no access, all access, or custom: which items (a filter), which
 * fields, what a write must pass (validation) and what it gets by default (presets).
 */
const props = defineProps<{ open: boolean; policy: string; collection: string; label: string; action: Action; permission?: Permission }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const level = ref<Level>('none');
const allFields = ref(true);
const fields = ref<string[]>([]);
const filter = ref('');
const validation = ref('');
const presets = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

/** The collection's fields: the data model's, or those the API defines for system collections. */
const fieldNames = computed(() => (isSystem(props.collection) ? (SYSTEM_FIELDS[props.collection] ?? []) : fieldsOf(props.collection).map((f) => f.field)));
const suggestions = computed(() => filterSuggestions(props.collection, fieldNames.value));

// What each action takes, as in Directus: reads, updates and deletes are limited to items; creates
// and updates to fields, with validation and presets.
const hasFilter = computed(() => props.action !== 'create');
const hasFields = computed(() => props.action !== 'delete');
const hasWriteRules = computed(() => props.action === 'create' || props.action === 'update');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const p = props.permission;
    level.value = levelOf(p);
    allFields.value = !p || (p.fields?.includes('*') ?? false);
    fields.value = p?.fields?.filter((f) => f !== '*') ?? [];
    filter.value = objectText(p?.permissions);
    validation.value = objectText(p?.validation);
    presets.value = objectText(p?.presets);
    error.value = null;
    busy.value = false;
  },
);

function toggleField(name: string, on: boolean) {
  fields.value = on ? [...new Set([...fields.value, name])] : fields.value.filter((f) => f !== name);
}

function custom(): Omit<Permission, 'id'> {
  return {
    policy: props.policy,
    collection: props.collection,
    action: props.action,
    permissions: hasFilter.value ? (parseObject(filter.value, 'The item filter') ?? {}) : null,
    validation: hasWriteRules.value ? (parseObject(validation.value, 'The validation') ?? {}) : null,
    presets: hasWriteRules.value ? parseObject(presets.value, 'The presets') : null,
    fields: hasFields.value ? (allFields.value ? ['*'] : fields.value) : null,
  };
}

async function save() {
  error.value = null;
  let next: Omit<Permission, 'id'> | null;
  try {
    next = level.value === 'none' ? null : level.value === 'all' ? fullPermission(props.policy, props.collection, props.action) : custom();
  } catch (e) {
    error.value = e instanceof InputError ? e.message : String(e);
    return;
  }
  if (next && hasFields.value && !next.fields?.length) {
    error.value = 'Choose at least one field, or all of them.';
    return;
  }
  busy.value = true;
  try {
    const existing = props.permission?.id;
    if (next === null) {
      if (existing !== undefined) await request(deletePermission(existing));
    } else if (existing !== undefined) {
      await request(updatePermission(existing, next));
    } else {
      await request(createPermission(next));
    }
    emit('saved');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

const ACTION_TEXT: Record<Action, string> = { create: 'Create', read: 'Read', update: 'Update', delete: 'Delete' };
</script>

<template>
  <Modal :open="open" :title="`${label} · ${ACTION_TEXT[action]}`" wide @close="emit('close')">
    <form id="permission-form" novalidate @submit.prevent="save">
      <fieldset class="levels">
        <legend class="visually-hidden">Access</legend>
        <label class="level" :class="{ chosen: level === 'none' }">
          <input v-model="level" type="radio" value="none" />
          <strong>No access</strong>
          <span class="subtle">Requests are refused.</span>
        </label>
        <label class="level" :class="{ chosen: level === 'all' }">
          <input v-model="level" type="radio" value="all" />
          <strong>All access</strong>
          <span class="subtle">Every item and field.</span>
        </label>
        <label class="level" :class="{ chosen: level === 'custom' }">
          <input v-model="level" type="radio" value="custom" />
          <strong>Custom</strong>
          <span class="subtle">Some items, some fields, rules.</span>
        </label>
      </fieldset>

      <div v-if="level === 'custom'" class="custom">
        <div v-if="hasFilter" class="field">
          <label for="permission-filter">Items</label>
          <textarea id="permission-filter" v-model="filter" class="input code" placeholder='Empty: every item. For example {"status": {"_eq": "published"}}' />
          <div v-if="suggestions.length" class="toolbar">
            <span class="subtle">Use:</span>
            <button v-for="s in suggestions" :key="s.label" type="button" class="btn small" @click="filter = JSON.stringify(s.filter, null, 2)">{{ s.label }}</button>
            <button v-if="filter" type="button" class="btn small" @click="filter = ''">Every item</button>
          </div>
          <div class="hint">
            A filter, as in queries: only matching items can be {{ action === 'read' ? 'read' : action === 'update' ? 'updated' : 'deleted' }}. Variables:
            <code>$CURRENT_USER</code>, <code>$CURRENT_ROLE</code>, <code>$NOW</code>.
          </div>
        </div>

        <div v-if="hasFields" class="field">
          <span class="label">Fields</span>
          <label class="checkbox"><input v-model="allFields" type="checkbox" />All fields, including ones added later</label>
          <div v-if="!allFields" class="fields">
            <label v-for="name in fieldNames" :key="name" class="checkbox">
              <input type="checkbox" :checked="fields.includes(name)" @change="toggleField(name, ($event.target as HTMLInputElement).checked)" />
              <code>{{ name }}</code>
            </label>
          </div>
        </div>

        <template v-if="hasWriteRules">
          <div class="field">
            <label for="permission-validation">Validation</label>
            <textarea id="permission-validation" v-model="validation" class="input code" placeholder='Empty: no rules. For example {"title": {"_nempty": true}}' />
            <div class="hint">A filter the values must pass.</div>
          </div>
          <div class="field">
            <label for="permission-presets">Presets</label>
            <textarea id="permission-presets" v-model="presets" class="input code" placeholder='Empty: none. For example {"status": "draft"}' />
            <div class="hint">Default values; what a request sends wins.</div>
          </div>
        </template>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" class="btn" @click="emit('close')">Cancel</button>
      <button type="submit" form="permission-form" class="btn primary" :disabled="busy">{{ busy ? 'Saving…' : 'Save' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.levels {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0 0 20px;
  padding: 0;
  border: 0;
}

.level {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.level input {
  grid-row: span 2;
  margin: 3px 0 0;
}

.level span {
  font-size: 12px;
}

.level.chosen {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.custom {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.fields .checkbox {
  font-weight: 400;
}

textarea.input.code {
  min-height: 90px;
}

form > .error {
  margin: 16px 0 0;
  color: var(--danger);
}

@media (max-width: 640px) {
  .levels {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
