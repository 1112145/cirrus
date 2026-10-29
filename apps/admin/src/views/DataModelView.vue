<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import PageLayout from '../components/PageLayout.vue';
import { collectionPlan, OPTIONAL_FIELDS, type OptionalField, PRIMARY_KEYS, type PrimaryKeyKind } from '../lib/builder.ts';
import { errorMessage } from '../lib/errors.ts';
import { isFolder, nameError, titleOf } from '../lib/schema.ts';
import { runPlan } from '../stores/builder.ts';
import { notify } from '../stores/notify.ts';
import { schema } from '../stores/schema.ts';

/** The data model: every collection, and creating new ones. */
const router = useRouter();

const collections = computed(() =>
  [...schema.collections]
    .filter((c) => !c.collection.startsWith('directus_'))
    .sort((a, b) => Number(a.meta?.hidden ?? false) - Number(b.meta?.hidden ?? false) || a.collection.localeCompare(b.collection)),
);
const fieldCount = (name: string) => schema.fields.filter((f) => f.collection === name).length;

// New collection ---------------------------------------------------------------------------------

const open = ref(false);
const name = ref('');
const pkField = ref('id');
const pkKind = ref<PrimaryKeyKind>('uuid');
const singleton = ref(false);
const note = ref('');
const optional = ref<OptionalField[]>(['status', 'sort', 'date_created', 'date_updated']);
const busy = ref(false);
const error = ref<string | null>(null);
const touched = ref(false);

function start() {
  name.value = '';
  pkField.value = 'id';
  pkKind.value = 'uuid';
  singleton.value = false;
  note.value = '';
  optional.value = ['status', 'sort', 'date_created', 'date_updated'];
  error.value = null;
  touched.value = false;
  open.value = true;
}

const nameProblem = computed(() => {
  const problem = nameError(name.value, 'collection');
  if (problem) return problem;
  return schema.collections.some((c) => c.collection.toLowerCase() === name.value.toLowerCase()) ? 'A collection with this name exists.' : null;
});
const pkProblem = computed(() => nameError(pkField.value, 'field') ?? (optional.value.includes(pkField.value as OptionalField) ? 'Another field has this name.' : null));

watch(name, () => {
  error.value = null;
});

async function create() {
  touched.value = true;
  if (nameProblem.value || pkProblem.value) return;
  busy.value = true;
  error.value = null;
  try {
    await runPlan(
      collectionPlan({ name: name.value, primaryKey: { field: pkField.value, kind: pkKind.value }, singleton: singleton.value, note: note.value, optional: optional.value }),
    );
    open.value = false;
    notify(`Created ${titleOf(name.value)}.`);
    await router.push(`/settings/data-model/${name.value}`);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PageLayout title="Data model" subtitle="Collections, their fields and relations">
    <template #actions>
      <button type="button" class="btn primary" @click="start"><Icon name="plus" :size="18" />Create collection</button>
    </template>

    <div v-if="collections.length" class="card">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Collection</th>
              <th>Fields</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in collections" :key="c.collection" :class="{ dim: c.meta?.hidden }" @click="router.push(`/settings/data-model/${c.collection}`)">
              <td>
                <span class="name">
                  <Icon :name="isFolder(c) ? 'folder' : 'box'" :size="18" />
                  <strong>{{ titleOf(c.collection) }}</strong>
                  <code class="subtle">{{ c.collection }}</code>
                  <span v-if="c.meta?.singleton" class="badge">Singleton</span>
                  <span v-if="c.meta?.hidden" class="badge">Hidden</span>
                  <span v-if="isFolder(c)" class="badge">Folder</span>
                </span>
              </td>
              <td>{{ isFolder(c) ? '—' : fieldCount(c.collection) }}</td>
              <td class="muted">{{ c.meta?.note ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else class="empty card">
      <Icon name="database" :size="32" />
      <p>No collections yet. A collection is a table of items, such as posts or products.</p>
      <button type="button" class="btn primary" @click="start">Create the first collection</button>
    </div>

    <Modal :open="open" title="Create collection" wide @close="open = false">
      <form id="new-collection" class="form" novalidate @submit.prevent="create">
        <div class="form-grid">
          <div class="field">
            <label for="collection-name">Name<span class="required">*</span></label>
            <input id="collection-name" v-model.trim="name" class="input" :class="{ invalid: touched && nameProblem }" placeholder="posts" autocomplete="off" autofocus />
            <div v-if="touched && nameProblem" class="error">{{ nameProblem }}</div>
            <div v-else class="hint">Lowercase, with underscores: the table's name in the API (<code>/items/{{ name || 'posts' }}</code>).</div>
          </div>
          <div class="field">
            <label for="collection-note">Note</label>
            <input id="collection-note" v-model="note" class="input" placeholder="What it holds" />
          </div>
          <div class="field">
            <label for="pk-field">Primary key field</label>
            <input id="pk-field" v-model.trim="pkField" class="input" :class="{ invalid: touched && pkProblem }" />
            <div v-if="touched && pkProblem" class="error">{{ pkProblem }}</div>
          </div>
          <div class="field">
            <label for="pk-kind">Primary key type</label>
            <select id="pk-kind" v-model="pkKind" class="input">
              <option v-for="k in PRIMARY_KEYS" :key="k.kind" :value="k.kind">{{ k.label }}</option>
            </select>
            <div class="hint">{{ PRIMARY_KEYS.find((k) => k.kind === pkKind)?.hint }}</div>
          </div>
          <fieldset class="field full options">
            <legend class="label">Optional fields</legend>
            <label v-for="o in OPTIONAL_FIELDS" :key="o.field" class="checkbox">
              <input v-model="optional" type="checkbox" :value="o.field" />{{ o.label }}
            </label>
          </fieldset>
          <label class="checkbox full">
            <input v-model="singleton" type="checkbox" class="switch" />
            Singleton: a single item, such as a site's settings or home page
          </label>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <button type="button" class="btn" @click="open = false">Cancel</button>
        <button type="submit" form="new-collection" class="btn primary" :disabled="busy">{{ busy ? 'Creating…' : 'Create collection' }}</button>
      </template>
    </Modal>
  </PageLayout>
</template>

<style scoped>
.name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.name :deep(.icon) {
  color: var(--text-subtle);
}

tr.dim {
  opacity: 0.7;
}

.options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  margin: 0;
  padding: 0;
  border: 0;
}

.options legend {
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 13px;
}

.form .error {
  color: var(--danger);
}
</style>
