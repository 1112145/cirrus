<script setup lang="ts">
import { createItem, deleteItem, readItem, readSingleton, updateItem, updateSingleton } from '@directus/sdk';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router';
import { request } from '../api.ts';
import { renderTemplate } from '../lib/display.ts';
import { errorCode, errorMessage, fieldErrors } from '../lib/errors.ts';
import { changes, type Item, keyOf, missingRequired, same } from '../lib/payload.ts';
import { type Field, isAutomatic, isPrimaryKey, titleOf } from '../lib/schema.ts';
import { formFields, formPaths, templateFor, toPayload } from '../stores/model.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';
import { can, collectionOf, fieldOf, primaryKeyOf, schema } from '../stores/schema.ts';
import { session } from '../stores/session.ts';
import ContentNav from './ContentNav.vue';
import FieldInput from './FieldInput.vue';
import Icon from './Icon.vue';
import PageLayout from './PageLayout.vue';

/**
 * An item's form: create (`id` is `+`), edit, or a singleton's one item (`id` is null). Saving
 * sends only the fields that changed, as the Directus app does.
 */
const props = defineProps<{ collection: string; id: string | null }>();
const router = useRouter();

const creating = computed(() => props.id === '+');
const singleton = computed(() => props.id === null);
const pk = computed(() => primaryKeyOf(props.collection));
const fields = computed(() => formFields(props.collection, creating.value));

const original = ref<Item | null>(null);
const edits = ref<Item>({});
const errors = ref<Record<string, string>>({});
/** Inputs holding text their type can't take (half-typed JSON, a word in a number field). */
const inputErrors = reactive<Record<string, string>>({});
const loading = ref(false);
const saving = ref(false);
const missing = ref(false);

/** What the form shows when creating: the fields' defaults (the server applies them too). */
function defaults(): Item {
  const out: Item = {};
  for (const f of fields.value) {
    const d = f.schema?.default_value;
    if (d === null || d === undefined || isAutomatic(f)) continue;
    if (['timestamp', 'dateTime', 'date', 'time'].includes(f.type)) continue;
    out[f.field] = d;
  }
  return out;
}

async function load() {
  edits.value = {};
  errors.value = {};
  for (const k of Object.keys(inputErrors)) delete inputErrors[k];
  missing.value = false;
  if (creating.value) {
    original.value = defaults();
    return;
  }
  loading.value = true;
  original.value = null;
  try {
    const query = { fields: formPaths(props.collection) };
    original.value = singleton.value
      ? await request<Item>(readSingleton(props.collection, query))
      : await request<Item>(readItem(props.collection, props.id!, query));
  } catch (e) {
    // Items the user may not read are reported as missing, like ones that don't exist.
    missing.value = true;
    if (errorCode(e) !== 'FORBIDDEN') notifyError(e);
  } finally {
    loading.value = false;
  }
}

watch(() => [props.collection, props.id], load, { immediate: true });

const values = computed<Item>(() => ({ ...(original.value ?? {}), ...edits.value }));
const pending = computed(() => (original.value ? changes(creating.value ? {} : original.value, edits.value) : {}));
const dirty = computed(() => Object.keys(pending.value).length > 0);

function set(field: string, value: unknown) {
  const next = { ...edits.value };
  if (!creating.value && original.value && same(original.value[field], value)) delete next[field];
  else next[field] = value;
  edits.value = next;
  if (errors.value[field]) errors.value = Object.fromEntries(Object.entries(errors.value).filter(([k]) => k !== field));
}

function setInputError(field: string, message: string | null) {
  if (message) inputErrors[field] = message;
  else delete inputErrors[field];
}

// Permissions ------------------------------------------------------------------------------------

const action = computed(() => (creating.value ? 'create' : 'update'));
const mayWrite = computed(() => can(props.collection, action.value));
const mayDelete = computed(() => !creating.value && !singleton.value && can(props.collection, 'delete'));

/** Fields the user may write: all for full access to every field, else those the permission lists. */
function writable(field: Field): boolean {
  if (!mayWrite.value || field.meta?.readonly) return false;
  if (!creating.value && (isPrimaryKey(field) || isAutomatic(field))) return false;
  if (session.admin) return true;
  const allowed = schema.permissions[props.collection]?.[action.value]?.fields;
  return !allowed || allowed.includes('*') || allowed.includes(field.field);
}

// Saving -----------------------------------------------------------------------------------------

const invalid = computed(() => Object.keys(inputErrors).length > 0);

async function save() {
  if (!dirty.value || saving.value) return;
  if (invalid.value) {
    notify('Fix the highlighted fields first.', 'error');
    return;
  }
  const empty = missingRequired(fields.value.filter(writable), values.value, creating.value);
  if (empty.length) {
    errors.value = Object.fromEntries(empty.map((f) => [f, 'This field is required.']));
    notify('Some fields need attention.', 'error');
    return;
  }
  const payload = Object.fromEntries(
    Object.entries(pending.value).map(([k, v]) => {
      const field = fieldOf(props.collection, k);
      return [k, field ? toPayload(field, v) : v];
    }),
  );
  saving.value = true;
  errors.value = {};
  try {
    const query = { fields: formPaths(props.collection) };
    if (creating.value) {
      const created = await request<Item>(createItem(props.collection, payload, { fields: [pk.value] }));
      edits.value = {};
      notify('Item created.');
      await router.replace(`/content/${props.collection}/${encodeURIComponent(String(keyOf(created, pk.value)))}`);
      return;
    }
    original.value = singleton.value
      ? await request<Item>(updateSingleton(props.collection, payload, query))
      : await request<Item>(updateItem(props.collection, props.id!, payload, query));
    edits.value = {};
    notify('Saved.');
  } catch (e) {
    errors.value = fieldErrors(e);
    notify(Object.keys(errors.value).length ? 'Some fields need attention.' : errorMessage(e), 'error');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!(await confirm('Delete this item? This can’t be undone.', { action: 'Delete', danger: true }))) return;
  try {
    await request(deleteItem(props.collection, props.id!));
    edits.value = {};
    notify('Item deleted.');
    await router.push(`/content/${props.collection}`);
  } catch (e) {
    notifyError(e);
  }
}

// Unsaved changes ----------------------------------------------------------------------------------

const leave = async () => !dirty.value || (await confirm('Discard your unsaved changes?', { action: 'Discard', danger: true }));
onBeforeRouteLeave(leave);
onBeforeRouteUpdate(leave);

function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) e.preventDefault();
}

function shortcut(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    void save();
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('keydown', shortcut);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('keydown', shortcut);
});

// Header -----------------------------------------------------------------------------------------

const title = computed(() => {
  if (singleton.value) return titleOf(props.collection);
  if (creating.value) return 'New item';
  if (!original.value) return titleOf(props.collection);
  return renderTemplate(templateFor(props.collection), original.value) || `${titleOf(props.collection)} item`;
});

const width = (f: Field) => (f.meta?.width === 'half' || f.meta?.width === 'half-left' || f.meta?.width === 'half-right' ? 'half' : 'full');
const inputId = (f: Field) => `field-${f.field}`;
</script>

<template>
  <PageLayout :subtitle="singleton ? (collectionOf(collection)?.meta?.note ?? undefined) : titleOf(collection)">
    <template #nav><ContentNav :active="collection" /></template>
    <template v-if="!singleton" #back>
      <RouterLink :to="`/content/${collection}`" class="icon-btn" aria-label="Back to the list"><Icon name="back" /></RouterLink>
    </template>
    <template #title>
      <h1>{{ title }}</h1>
    </template>
    <template v-if="!missing" #actions>
      <span v-if="dirty" class="badge">Unsaved changes</span>
      <button v-if="mayDelete" type="button" class="icon-btn danger" aria-label="Delete item" title="Delete" @click="remove"><Icon name="trash" /></button>
      <button type="button" class="btn primary" :disabled="!dirty || saving || !mayWrite" @click="save">
        <Icon name="check" :size="18" />{{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>

    <div v-if="missing" class="empty card">
      <p>This item doesn't exist, or you may not read it.</p>
      <RouterLink :to="`/content/${collection}`" class="btn">Back to {{ titleOf(collection) }}</RouterLink>
    </div>
    <div v-else-if="loading || !original" class="subtle">Loading…</div>
    <form v-else class="card form" novalidate @submit.prevent="save">
      <p v-if="!mayWrite" class="notice muted">You may read this item but not change it.</p>
      <div class="form-grid">
        <div v-for="f in fields" :key="f.field" class="field" :class="width(f)">
          <template v-if="f.meta?.interface === 'presentation-divider'">
            <div class="divider-title">{{ titleOf(f.field) }}</div>
            <FieldInput :field="f" :model-value="null" />
          </template>
          <template v-else>
            <label :for="inputId(f)">
              {{ titleOf(f.field) }}<span v-if="f.meta?.required" class="required" aria-label="required">*</span>
            </label>
            <FieldInput
              :id="inputId(f)"
              :field="f"
              :model-value="values[f.field] ?? null"
              :disabled="!writable(f)"
              :invalid="!!(errors[f.field] || inputErrors[f.field])"
              @update:model-value="set(f.field, $event)"
              @input-error="setInputError(f.field, $event)"
            />
            <div v-if="errors[f.field] || inputErrors[f.field]" class="error" role="alert">{{ errors[f.field] || inputErrors[f.field] }}</div>
            <div v-else-if="f.meta?.note" class="hint">{{ f.meta.note }}</div>
          </template>
        </div>
      </div>
      <div v-if="!fields.length" class="empty">
        <p>This collection has no fields to edit yet.</p>
        <RouterLink v-if="session.admin" :to="`/settings/data-model/${collection}`" class="btn">Add fields</RouterLink>
      </div>
      <button type="submit" hidden />
    </form>
  </PageLayout>
</template>

<style scoped>
.form {
  max-width: 960px;
  padding: 24px;
}

.notice {
  margin: 0 0 18px;
}

.divider-title {
  font-weight: 600;
  font-size: 15px;
  margin-top: 8px;
}
</style>
