<script setup lang="ts">
import { deleteCollection, deleteField, updateCollection, updateFields } from '@directus/sdk';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { request } from '../api.ts';
import FieldDialog from '../components/FieldDialog.vue';
import Icon from '../components/Icon.vue';
import PageLayout from '../components/PageLayout.vue';
import { reorder } from '../lib/builder.ts';
import { templateFields, templateOf } from '../lib/display.ts';
import { errorMessage } from '../lib/errors.ts';
import { type Field, interfaceOf, isFolder, isPrimaryKey, titleOf } from '../lib/schema.ts';
import { relationFor } from '../stores/model.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';
import { collectionOf, fieldsOf, loadSchema, schema } from '../stores/schema.ts';

/** A collection's settings: its fields (add, edit, reorder, delete) and its own options. */
const route = useRoute();
const router = useRouter();

const name = computed(() => String(route.params.collection));
const collection = computed(() => collectionOf(name.value));
const fields = computed(() => fieldsOf(name.value));
const folder = computed(() => !!collection.value && isFolder(collection.value));

// Fields -----------------------------------------------------------------------------------------

const dialog = ref<{ open: boolean; field: Field | null }>({ open: false, field: null });
const addField = () => (dialog.value = { open: true, field: null });
const editField = (f: Field) => (dialog.value = { open: true, field: f });
const busy = ref(false);

function describe(f: Field): string {
  const rel = relationFor(f);
  if (rel?.kind === 'file') return f.meta?.interface === 'file' ? 'File' : 'Image';
  if (rel?.kind === 'm2o') return `Many to one → ${titleOf(rel.related)}`;
  if (rel?.kind === 'o2m') return `One to many → ${titleOf(rel.related)}`;
  if (rel?.kind === 'm2m') return `Many to many → ${titleOf(rel.related)}`;
  const iface = interfaceOf(f, schema.relations);
  if (iface === 'presentation-divider') return 'Divider';
  if (iface === 'select-dropdown') return 'Dropdown';
  if (iface === 'tags') return 'Tags';
  if (iface === 'input-rich-text-md') return 'Markdown';
  return f.type;
}

async function move(f: Field, delta: -1 | 1) {
  const changes = reorder(
    fields.value.map((x) => ({ field: x.field, sort: x.meta?.sort ?? null })),
    f.field,
    delta,
  );
  if (!changes.length) return;
  busy.value = true;
  try {
    await request(updateFields(name.value, changes.map((c) => ({ field: c.field, meta: { sort: c.sort } }))));
    await loadSchema();
  } catch (e) {
    notifyError(e);
  } finally {
    busy.value = false;
  }
}

async function removeField(f: Field) {
  const rel = relationFor(f);
  const extra = rel?.kind === 'o2m' ? ` The ${rel.foreignKey} field of ${titleOf(rel.related)} stays.` : rel?.kind === 'm2m' ? ` The ${rel.junction} junction collection stays.` : '';
  if (!(await confirm(`Delete the field “${f.field}” and its values from every item? This can't be undone.${extra}`, { action: 'Delete field', danger: true }))) return;
  busy.value = true;
  try {
    await request(deleteField(name.value, f.field));
    notify(`Deleted ${titleOf(f.field)}.`);
  } catch (e) {
    notifyError(e);
  } finally {
    await loadSchema();
    busy.value = false;
  }
}

function saved() {
  dialog.value = { open: false, field: null };
}

// Collection options -------------------------------------------------------------------------------

const note = ref('');
const template = ref('');
const singleton = ref(false);
const hidden = ref(false);
const sortField = ref('');
const savingMeta = ref(false);
const metaError = ref<string | null>(null);

function reset() {
  const meta = collection.value?.meta;
  note.value = meta?.note ?? '';
  template.value = meta?.display_template ?? '';
  singleton.value = meta?.singleton ?? false;
  hidden.value = meta?.hidden ?? false;
  sortField.value = meta?.sort_field ?? '';
  metaError.value = null;
}
watch(collection, reset, { immediate: true });

const metaDirty = computed(() => {
  const meta = collection.value?.meta;
  return (
    note.value !== (meta?.note ?? '') ||
    template.value !== (meta?.display_template ?? '') ||
    singleton.value !== (meta?.singleton ?? false) ||
    hidden.value !== (meta?.hidden ?? false) ||
    sortField.value !== (meta?.sort_field ?? '')
  );
});

const sortable = computed(() => fields.value.filter((f) => (f.type === 'integer' || f.type === 'bigInteger') && !isPrimaryKey(f)));
const unknownInTemplate = computed(() => templateFields(template.value).filter((p) => !fields.value.some((f) => f.field === p.split('.')[0])));

async function saveMeta() {
  savingMeta.value = true;
  metaError.value = null;
  try {
    await request(
      updateCollection(name.value, {
        meta: { note: note.value || null, display_template: template.value || null, singleton: singleton.value, hidden: hidden.value, sort_field: sortField.value || null },
      }),
    );
    await loadSchema();
    notify('Saved.');
  } catch (e) {
    metaError.value = errorMessage(e);
  } finally {
    savingMeta.value = false;
  }
}

async function removeCollection() {
  const ok = await confirm(
    `Delete the collection “${name.value}” with all its items? Fields of other collections pointing at it go too. This can't be undone.`,
    { action: 'Delete collection', danger: true },
  );
  if (!ok) return;
  try {
    await request(deleteCollection(name.value));
    await loadSchema();
    notify(`Deleted ${titleOf(name.value)}.`);
    await router.push('/settings/data-model');
  } catch (e) {
    notifyError(e);
  }
}
</script>

<template>
  <PageLayout :subtitle="collection ? name : undefined">
    <template #back>
      <RouterLink to="/settings/data-model" class="icon-btn" aria-label="Back to the data model"><Icon name="back" /></RouterLink>
    </template>
    <template #title>
      <h1>{{ collection ? titleOf(name) : 'Not found' }}</h1>
    </template>
    <template v-if="collection" #actions>
      <RouterLink v-if="!folder" :to="`/content/${name}`" class="btn"><Icon name="box" :size="18" />Content</RouterLink>
      <button type="button" class="icon-btn danger" title="Delete collection" aria-label="Delete collection" @click="removeCollection"><Icon name="trash" /></button>
    </template>

    <div v-if="!collection" class="empty card">
      <p>There's no collection named “{{ name }}”.</p>
      <RouterLink to="/settings/data-model" class="btn">Back to the data model</RouterLink>
    </div>
    <div v-else class="sections">
      <section v-if="!folder" class="card">
        <header class="section-head">
          <h2>Fields</h2>
          <span class="spacer" />
          <button type="button" class="btn primary small" @click="addField"><Icon name="plus" :size="16" />Add field</button>
        </header>
        <ul class="fields" :class="{ busy }">
          <li v-for="(f, i) in fields" :key="f.field" class="field-row" :data-field="f.field">
            <div class="order">
              <button type="button" class="icon-btn" :disabled="i === 0 || busy" :aria-label="`Move ${f.field} up`" @click="move(f, -1)"><Icon name="up" :size="16" /></button>
              <button type="button" class="icon-btn" :disabled="i === fields.length - 1 || busy" :aria-label="`Move ${f.field} down`" @click="move(f, 1)">
                <Icon name="down" :size="16" />
              </button>
            </div>
            <button type="button" class="field-main" @click="editField(f)">
              <strong>{{ f.field }}</strong>
              <span class="muted">{{ describe(f) }}</span>
              <span v-if="isPrimaryKey(f)" class="badge primary">Primary key</span>
              <span v-if="f.meta?.required" class="badge">Required</span>
              <span v-if="f.meta?.hidden" class="badge">Hidden</span>
              <span v-if="f.meta?.readonly && !isPrimaryKey(f)" class="badge">Read-only</span>
            </button>
            <button type="button" class="icon-btn" :aria-label="`Edit ${f.field}`" @click="editField(f)"><Icon name="edit" :size="18" /></button>
            <button v-if="!isPrimaryKey(f)" type="button" class="icon-btn danger" :aria-label="`Delete ${f.field}`" :disabled="busy" @click="removeField(f)">
              <Icon name="trash" :size="18" />
            </button>
            <span v-else class="icon-placeholder" />
          </li>
        </ul>
      </section>

      <section class="card">
        <header class="section-head"><h2>Collection</h2></header>
        <form class="options" novalidate @submit.prevent="saveMeta">
          <div class="form-grid">
            <div class="field full">
              <label for="c-note">Note</label>
              <input id="c-note" v-model="note" class="input" />
            </div>
            <div v-if="!folder" class="field full">
              <label for="c-template">Display template</label>
              <input id="c-template" v-model="template" class="input" :placeholder="templateOf(undefined, fields)" />
              <div v-if="unknownInTemplate.length" class="error">Unknown fields: {{ unknownInTemplate.join(', ') }}</div>
              <div v-else class="hint">How items are named in lists and relations, such as <code v-pre>{{ title }} ({{ status }})</code>.</div>
            </div>
            <div v-if="!folder" class="field">
              <label for="c-sort">Sort field</label>
              <select id="c-sort" v-model="sortField" class="input">
                <option value="">None</option>
                <option v-for="f in sortable" :key="f.field" :value="f.field">{{ f.field }}</option>
              </select>
              <div class="hint">An integer field ordering the items manually.</div>
            </div>
            <div class="field flags">
              <span class="label">Options</span>
              <label v-if="!folder" class="checkbox"><input v-model="singleton" type="checkbox" />Singleton (a single item)</label>
              <label class="checkbox"><input v-model="hidden" type="checkbox" />Hidden in the content module</label>
            </div>
          </div>
          <p v-if="metaError" class="error" role="alert">{{ metaError }}</p>
          <div class="toolbar actions">
            <button type="button" class="btn" :disabled="!metaDirty" @click="reset">Reset</button>
            <button type="submit" class="btn primary" :disabled="!metaDirty || savingMeta">{{ savingMeta ? 'Saving…' : 'Save' }}</button>
          </div>
        </form>
      </section>
    </div>

    <FieldDialog :open="dialog.open" :collection="name" :field="dialog.field" @close="dialog.open = false" @saved="saved" />
  </PageLayout>
</template>

<style scoped>
.sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 960px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.fields {
  list-style: none;
  margin: 0;
  padding: 8px;
}

.fields.busy {
  opacity: 0.6;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-sm);
}

.field-row:hover {
  background: var(--panel-2);
}

.order {
  display: flex;
  flex-direction: column;
}

.order .icon-btn {
  width: 26px;
  height: 18px;
}

.field-main {
  all: unset;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  cursor: pointer;
}

.field-main:focus-visible {
  outline: 2px solid var(--primary);
  border-radius: var(--radius-sm);
}

.icon-placeholder {
  width: 32px;
}

.options {
  padding: 18px;
}

.flags {
  gap: 8px;
}

.options .error {
  color: var(--danger);
}

.actions {
  justify-content: flex-end;
  margin-top: 18px;
}
</style>
