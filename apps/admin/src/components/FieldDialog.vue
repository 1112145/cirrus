<script setup lang="ts">
import { updateField } from '@directus/sdk';
import { computed, ref, watch } from 'vue';
import { request } from '../api.ts';
import { choicesText, FIELD_KINDS, type FieldKind, fieldPlan, isRelational, junctionNames, type KindGroup, parseChoices } from '../lib/builder.ts';
import { errorMessage } from '../lib/errors.ts';
import { type Field, FILES, isAlias, isFolder, isPrimaryKey, nameError, titleOf } from '../lib/schema.ts';
import { fromInput, InputError, toInput } from '../lib/values.ts';
import { keyType, runPlan } from '../stores/builder.ts';
import { relationFor } from '../stores/model.ts';
import { notify } from '../stores/notify.ts';
import { fieldsOf, loadSchema, schema } from '../stores/schema.ts';
import Icon from './Icon.vue';
import Modal from './Modal.vue';

/** Add a field to a collection (pick a kind, then set it up), or edit an existing field's settings. */
const props = defineProps<{ open: boolean; collection: string; field?: Field | null }>();
const emit = defineEmits<{ close: []; saved: [field: string] }>();

const editing = computed(() => !!props.field);
const kind = ref<FieldKind | null>(null);
const name = ref('');
const note = ref('');
const required = ref(false);
const unique = ref(false);
const hidden = ref(false);
const readonly = ref(false);
const width = ref<'full' | 'half'>('full');
const defaultText = ref('');
const defaultOn = ref(false);
const choices = ref('');
const related = ref('');
const reverse = ref(false);
const reverseName = ref('');
const foreignKey = ref('');
const junction = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const touched = ref(false);

/** The kind an existing field is shown as, for the settings that apply to it. */
function kindOf(f: Field): FieldKind | null {
  const rel = relationFor(f);
  if (rel) return rel.kind === 'file' ? (f.meta?.interface === 'file' ? 'file' : 'image') : rel.kind;
  if (f.meta?.interface === 'presentation-divider') return 'divider';
  if (f.meta?.interface === 'select-dropdown') return 'select';
  if (f.meta?.interface === 'tags') return 'tags';
  switch (f.type) {
    case 'string':
      return 'string';
    case 'text':
      return f.meta?.interface === 'input-rich-text-md' ? 'markdown' : 'text';
    case 'integer':
    case 'bigInteger':
      return 'integer';
    case 'float':
    case 'decimal':
      return 'float';
    case 'boolean':
      return 'boolean';
    case 'timestamp':
    case 'dateTime':
      return 'timestamp';
    case 'date':
      return 'date';
    case 'json':
      return 'json';
    default:
      return null;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const f = props.field;
    error.value = null;
    touched.value = false;
    busy.value = false;
    kind.value = f ? kindOf(f) : null;
    name.value = f?.field ?? '';
    note.value = f?.meta?.note ?? '';
    required.value = f?.meta?.required ?? false;
    unique.value = f?.schema?.is_unique ?? false;
    hidden.value = f?.meta?.hidden ?? false;
    readonly.value = f?.meta?.readonly ?? false;
    width.value = f?.meta?.width === 'half' ? 'half' : 'full';
    const d = f?.schema?.default_value;
    defaultText.value = f && d !== null && d !== undefined && typeof d !== 'boolean' ? toInput(f.type, d) : '';
    defaultOn.value = d === true;
    choices.value = choicesText(f?.meta?.options?.choices);
    related.value = '';
    reverse.value = false;
    reverseName.value = '';
    foreignKey.value = '';
    junction.value = '';
  },
);

// Choosing a kind ----------------------------------------------------------------------------------

const groups = computed(() => {
  const out = new Map<KindGroup, typeof FIELD_KINDS>();
  for (const k of FIELD_KINDS) out.set(k.group, [...(out.get(k.group) ?? []), k]);
  return [...out];
});
const kindInfo = computed(() => FIELD_KINDS.find((k) => k.kind === kind.value));

/** Collections a relation can point at: those with items (not folders, junctions or the system's), and users. */
const targets = computed(() => [
  ...schema.collections.filter((c) => !isFolder(c) && !c.collection.startsWith('directus_') && !(c.meta?.hidden && c.meta.icon === 'import_export')).map((c) => c.collection),
  'directus_users',
]);

function choose(k: FieldKind) {
  kind.value = k;
  if (isRelational(k)) related.value = targets.value.find((c) => c !== props.collection) ?? targets.value[0] ?? '';
}

// Names that follow the relation's collections until edited.
watch([related, kind], () => {
  if (editing.value || !related.value) return;
  if (kind.value === 'o2m') foreignKey.value = `${props.collection}_id`.slice(0, 64);
  if (kind.value === 'm2o') reverseName.value = props.collection;
  if (kind.value === 'm2m') junction.value = junctionNames(props.collection, related.value).junction;
});

// Checks -----------------------------------------------------------------------------------------

const exists = (collection: string, field: string) => fieldsOf(collection).some((f) => f.field.toLowerCase() === field.toLowerCase());

const problems = computed(() => {
  const out: Record<string, string> = {};
  if (!editing.value) {
    const n = nameError(name.value, 'field');
    if (n) out.name = n;
    else if (exists(props.collection, name.value)) out.name = 'This collection has a field with this name.';
  }
  if (!editing.value && isRelational(kind.value!) && !related.value) out.related = 'Choose a collection.';
  if (!editing.value && kind.value === 'm2o' && reverse.value) {
    if (related.value.startsWith('directus_')) out.reverse = "System collections can't get new fields.";
    else out.reverse = nameError(reverseName.value, 'field') ?? (exists(related.value, reverseName.value) ? `${titleOf(related.value)} has a field with this name.` : '');
  }
  if (!editing.value && kind.value === 'o2m') {
    if (related.value.startsWith('directus_')) out.related = "System collections can't get new fields.";
    out.foreignKey = nameError(foreignKey.value, 'field') ?? (exists(related.value, foreignKey.value) ? `${titleOf(related.value)} has a field with this name.` : '');
  }
  if (!editing.value && kind.value === 'm2m') {
    out.junction =
      nameError(junction.value, 'collection') ?? (schema.collections.some((c) => c.collection.toLowerCase() === junction.value.toLowerCase()) ? 'A collection with this name exists.' : '');
  }
  if (kind.value === 'select' && !parseChoices(choices.value).length) out.choices = 'Add at least one choice.';
  if (defaultText.value.trim() && fieldType.value) {
    try {
      fromInput(fieldType.value, defaultText.value);
    } catch (e) {
      if (e instanceof InputError) out.default = e.message;
    }
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
});

/** The stored type of the field, for its default value. */
const fieldType = computed(() => {
  if (props.field) return props.field.type;
  switch (kind.value) {
    case 'string':
    case 'select':
      return 'string';
    case 'integer':
      return 'integer';
    case 'float':
      return 'float';
    default:
      return null;
  }
});

const hasDefault = computed(() => ['string', 'select', 'integer', 'float'].includes(kind.value ?? '') && (!props.field || !isPrimaryKey(props.field)));
const hasColumn = computed(() => (props.field ? !isAlias(props.field) : !['o2m', 'm2m', 'divider'].includes(kind.value ?? '')));
const canBeUnique = computed(() => hasColumn.value && ['string', 'integer', 'float'].includes(kind.value ?? '') && (!props.field || !isPrimaryKey(props.field)));

const defaultValue = () => (kind.value === 'boolean' ? defaultOn.value : defaultText.value.trim() && fieldType.value ? fromInput(fieldType.value, defaultText.value) : null);

// Saving -----------------------------------------------------------------------------------------

async function submit() {
  touched.value = true;
  if (Object.keys(problems.value).length || !kind.value) return;
  busy.value = true;
  error.value = null;
  try {
    if (props.field) await saveExisting(props.field);
    else {
      await runPlan(
        fieldPlan(
          {
            collection: props.collection,
            field: name.value,
            kind: kind.value,
            required: required.value,
            note: note.value,
            width: width.value,
            unique: canBeUnique.value && unique.value,
            defaultValue: hasDefault.value || kind.value === 'boolean' ? defaultValue() : undefined,
            choices: kind.value === 'select' ? parseChoices(choices.value) : undefined,
            related: related.value || undefined,
            reverse: kind.value === 'm2o' && reverse.value ? reverseName.value : null,
            foreignKey: foreignKey.value || undefined,
            junction: junction.value || undefined,
          },
          keyType,
        ),
      );
      notify(`Added ${titleOf(name.value)}.`);
    }
    emit('saved', name.value);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function saveExisting(f: Field) {
  const meta: Record<string, unknown> = { note: note.value || null, required: required.value, hidden: hidden.value, readonly: readonly.value, width: width.value };
  if (kind.value === 'select') meta.options = { ...(f.meta?.options ?? {}), choices: parseChoices(choices.value) };
  const payload: Record<string, unknown> = { meta };
  if (hasColumn.value) {
    const s: Record<string, unknown> = {};
    if (canBeUnique.value && unique.value !== (f.schema?.is_unique ?? false)) s.is_unique = unique.value;
    if (hasDefault.value || kind.value === 'boolean') {
      const d = defaultValue();
      if (d !== (f.schema?.default_value ?? null)) s.default_value = d;
    }
    if (Object.keys(s).length) payload.schema = s;
  }
  try {
    await request(updateField(props.collection, f.field, payload));
  } finally {
    await loadSchema();
  }
  notify(`Saved ${titleOf(f.field)}.`);
}

const title = computed(() => {
  if (props.field) return `${titleOf(props.field.field)} field`;
  return kindInfo.value ? `New ${kindInfo.value.label.toLowerCase()} field` : 'New field';
});

const relationSummary = computed(() => {
  const f = props.field;
  const rel = f && relationFor(f);
  if (!rel) return null;
  if (rel.kind === 'file') return `Points at a file in the file library.`;
  if (rel.kind === 'm2o') return `Holds the key of a ${titleOf(rel.related)} item.`;
  if (rel.kind === 'o2m') return `Lists the ${titleOf(rel.related)} items whose “${rel.foreignKey}” points here.`;
  return `Links ${titleOf(rel.related)} items through the ${rel.junction} junction collection.`;
});
</script>

<template>
  <Modal :open="open" :title="title" wide @close="emit('close')">
    <!-- Step 1: the kind of field -->
    <div v-if="!editing && !kind" class="kinds">
      <section v-for="[group, kinds] in groups" :key="group">
        <h3 class="group">{{ group }}</h3>
        <div class="kind-grid">
          <button v-for="k in kinds" :key="k.kind" type="button" class="kind" :data-kind="k.kind" @click="choose(k.kind)">
            <strong>{{ k.label }}</strong>
            <span class="subtle">{{ k.hint }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- Step 2: its settings -->
    <form v-else id="field-form" novalidate @submit.prevent="submit">
      <p v-if="relationSummary" class="muted summary"><Icon name="relation" :size="16" />{{ relationSummary }}</p>
      <div class="form-grid">
        <div class="field">
          <label for="field-name">Key<span v-if="!editing" class="required">*</span></label>
          <input id="field-name" v-model.trim="name" class="input" :class="{ invalid: touched && problems.name }" :disabled="editing" autocomplete="off" autofocus />
          <div v-if="touched && problems.name" class="error">{{ problems.name }}</div>
          <div v-else-if="!editing" class="hint">Lowercase, with underscores; it can't be renamed later.</div>
        </div>
        <div class="field">
          <label>Kind</label>
          <div class="kind-row">
            <span class="badge primary">{{ kindInfo?.label ?? field?.type }}</span>
            <button v-if="!editing" type="button" class="btn small" @click="kind = null">Change</button>
          </div>
        </div>

        <!-- Relations -->
        <template v-if="!editing && isRelational(kind!)">
          <div class="field">
            <label for="field-related">Related collection</label>
            <select id="field-related" v-model="related" class="input" :class="{ invalid: touched && problems.related }">
              <option v-for="c in targets" :key="c" :value="c">{{ titleOf(c) }}</option>
            </select>
            <div v-if="touched && problems.related" class="error">{{ problems.related }}</div>
          </div>
          <div v-if="kind === 'o2m'" class="field">
            <label for="field-fk">Field on {{ titleOf(related || 'the related collection') }}</label>
            <input id="field-fk" v-model.trim="foreignKey" class="input" :class="{ invalid: touched && problems.foreignKey }" />
            <div v-if="touched && problems.foreignKey" class="error">{{ problems.foreignKey }}</div>
            <div v-else class="hint">A new many to one field holding the key of the {{ titleOf(collection) }} item.</div>
          </div>
          <div v-if="kind === 'm2m'" class="field">
            <label for="field-junction">Junction collection</label>
            <input id="field-junction" v-model.trim="junction" class="input" :class="{ invalid: touched && problems.junction }" />
            <div v-if="touched && problems.junction" class="error">{{ problems.junction }}</div>
            <div v-else class="hint">A hidden collection created to hold the links.</div>
          </div>
          <div v-if="kind === 'm2o' && !related.startsWith('directus_')" class="field">
            <label class="checkbox"><input v-model="reverse" type="checkbox" />Also list them on {{ titleOf(related || 'the related collection') }}</label>
            <input v-if="reverse" v-model.trim="reverseName" class="input" :class="{ invalid: touched && problems.reverse }" aria-label="Name of the one to many field" />
            <div v-if="reverse && touched && problems.reverse" class="error">{{ problems.reverse }}</div>
            <div v-else-if="reverse" class="hint">A one to many field on {{ titleOf(related) }} listing its {{ titleOf(collection) }} items.</div>
          </div>
        </template>

        <!-- Choices -->
        <div v-if="kind === 'select'" class="field full">
          <label for="field-choices">Choices</label>
          <textarea id="field-choices" v-model="choices" class="input code" :class="{ invalid: touched && problems.choices }" placeholder="draft: Draft&#10;published: Published" />
          <div v-if="touched && problems.choices" class="error">{{ problems.choices }}</div>
          <div v-else class="hint">One per line: the value stored, optionally followed by a colon and the text shown.</div>
        </div>

        <!-- Defaults and constraints -->
        <div v-if="hasDefault" class="field">
          <label for="field-default">Default value</label>
          <input id="field-default" v-model="defaultText" class="input" :class="{ invalid: problems.default }" />
          <div v-if="problems.default" class="error">{{ problems.default }}</div>
          <div v-else-if="editing" class="hint">Changing it rebuilds the table, which takes a while on large collections.</div>
        </div>
        <div v-if="kind === 'boolean'" class="field">
          <span class="label">Default value</span>
          <label class="checkbox"><input v-model="defaultOn" type="checkbox" class="switch" />On by default</label>
        </div>

        <div class="field full">
          <label for="field-note">Note</label>
          <input id="field-note" v-model="note" class="input" placeholder="Shown below the field in the form" />
        </div>

        <div class="field">
          <label for="field-width">Width in the form</label>
          <select id="field-width" v-model="width" class="input">
            <option value="full">Full</option>
            <option value="half">Half</option>
          </select>
        </div>
        <div class="field flags">
          <span class="label">Options</span>
          <label v-if="kind !== 'divider'" class="checkbox"><input v-model="required" type="checkbox" />Required</label>
          <label v-if="canBeUnique" class="checkbox"><input v-model="unique" type="checkbox" />Unique</label>
          <template v-if="editing">
            <label class="checkbox"><input v-model="readonly" type="checkbox" />Read-only</label>
            <label class="checkbox"><input v-model="hidden" type="checkbox" />Hidden in the form</label>
          </template>
        </div>
      </div>
      <p v-if="kind === 'image' || kind === 'file'" class="hint">Files are uploaded to the file library ({{ titleOf(FILES) }}).</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>

    <template v-if="editing || kind" #footer>
      <button type="button" class="btn" @click="emit('close')">Cancel</button>
      <button type="submit" form="field-form" class="btn primary" :disabled="busy">{{ busy ? 'Saving…' : editing ? 'Save' : 'Add field' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.kinds {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.group {
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.kind-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.kind {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.kind:hover,
.kind:focus-visible {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.kind span {
  font-size: 12px;
}

.kind-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
}

.flags {
  gap: 8px;
}

.summary {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 18px;
}

form > .error,
form > .hint {
  margin: 16px 0 0;
}

form > .error {
  color: var(--danger);
}

form > .hint {
  color: var(--text-subtle);
  font-size: 12px;
}
</style>
