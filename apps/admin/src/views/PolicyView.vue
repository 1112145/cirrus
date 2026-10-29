<script setup lang="ts">
import { createPermission, createPolicy, deletePermission, deletePolicy, readPermissions, readPolicy, updatePermission, updatePolicy } from '@directus/sdk';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readPage, request } from '../api.ts';
import Icon from '../components/Icon.vue';
import ItemLabel from '../components/ItemLabel.vue';
import PageLayout from '../components/PageLayout.vue';
import PermissionDialog from '../components/PermissionDialog.vue';
import SettingsNav from '../components/SettingsNav.vue';
import TagsInput from '../components/TagsInput.vue';
import { useUnsavedGuard } from '../composables/unsaved.ts';
import { type Action, ACTIONS, byCollection, fullPermission, type Level, levelOf, type Permission, PUBLIC_POLICY, translate } from '../lib/access.ts';
import { errorCode, errorMessage, fieldErrors } from '../lib/errors.ts';
import { changes, type Item, same } from '../lib/payload.ts';
import { isFolder, titleOf } from '../lib/schema.ts';
import { SYSTEM_PERMISSION_COLLECTIONS, USERS } from '../lib/system.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';
import { schema } from '../stores/schema.ts';

/** A policy: what it is, who has it, and its permissions, collection by collection. */
const route = useRoute();
const router = useRouter();

type UsedBy = { id: string; role: { id: string; name: string } | null; user: Record<string, unknown> | null };

const id = computed(() => String(route.params.id));
const creating = computed(() => id.value === '+');
const isPublic = computed(() => id.value === PUBLIC_POLICY);

const original = ref<Item | null>(null);
const edits = ref<Item>({});
const errors = ref<Record<string, string>>({});
const missing = ref(false);
const saving = ref(false);
const permissions = ref<Permission[]>([]);
const usedBy = ref<UsedBy[]>([]);

async function loadPermissions() {
  permissions.value = await request<Permission[]>(readPermissions({ filter: { policy: { _eq: id.value } }, limit: -1 }));
}

async function load() {
  edits.value = {};
  errors.value = {};
  missing.value = false;
  permissions.value = [];
  usedBy.value = [];
  if (creating.value) {
    original.value = { name: '', description: null, app_access: true, admin_access: false, ip_access: null };
    return;
  }
  original.value = null;
  try {
    original.value = await request<Item>(readPolicy(id.value, { fields: ['id', 'name', 'icon', 'description', 'ip_access', 'enforce_tfa', 'admin_access', 'app_access'] }));
    const [, used] = await Promise.all([
      loadPermissions(),
      readPage<UsedBy>('/access', {
        fields: ['id', 'role.id', 'role.name', 'user.id', 'user.first_name', 'user.last_name', 'user.email', 'user.avatar'],
        filter: { policy: { _eq: id.value } },
        limit: -1,
      }),
    ]);
    usedBy.value = used.data;
  } catch (e) {
    missing.value = true;
    if (errorCode(e) !== 'FORBIDDEN') notifyError(e);
  }
}

watch(id, load, { immediate: true });

// The policy itself ---------------------------------------------------------------------------------

const values = computed<Item>(() => ({ ...(original.value ?? {}), ...edits.value }));
const pending = computed<Item>(() => {
  if (!original.value) return {};
  if (!creating.value) return changes(original.value, edits.value);
  return Object.fromEntries(Object.entries(values.value).filter(([, v]) => v !== null && v !== ''));
});
const dirty = computed(() => Object.keys(creating.value ? edits.value : pending.value).length > 0);

function set(field: string, value: unknown) {
  const next = { ...edits.value };
  if (!creating.value && original.value && same(original.value[field], value)) delete next[field];
  else next[field] = value;
  edits.value = next;
  if (errors.value[field]) errors.value = Object.fromEntries(Object.entries(errors.value).filter(([k]) => k !== field));
}

async function save() {
  if (!dirty.value || saving.value) return;
  if (!String(values.value.name ?? '').trim()) {
    errors.value = { name: 'This field is required.' };
    notify('Some fields need attention.', 'error');
    return;
  }
  saving.value = true;
  errors.value = {};
  try {
    if (creating.value) {
      const created = await request<{ id: string }>(createPolicy(pending.value, { fields: ['id'] }));
      edits.value = {};
      notify('Policy created. Now give it permissions.');
      await router.replace(`/settings/policies/${created.id}`);
      return;
    }
    original.value = { ...original.value, ...(await request<Item>(updatePolicy(id.value, pending.value))) };
    edits.value = {};
    notify('Saved.');
  } catch (e) {
    errors.value = fieldErrors(e);
    notify(errorMessage(e), 'error');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const who = usedBy.value.length ? ` ${usedBy.value.length} role${usedBy.value.length === 1 ? '' : 's'} or user${usedBy.value.length === 1 ? '' : 's'} lose it.` : '';
  if (!(await confirm(`Delete the policy “${translate(String(original.value?.name ?? ''))}” and its permissions?${who}`, { action: 'Delete', danger: true }))) return;
  try {
    await request(deletePolicy(id.value));
    edits.value = {};
    notify('Policy deleted.');
    await router.push('/settings/policies');
  } catch (e) {
    notifyError(e);
  }
}

useUnsavedGuard(dirty, save);

// Permissions ------------------------------------------------------------------------------------

/** The collections permissions can name: the data model's (folders aside), then the system ones. */
const rows = computed(() => [
  ...schema.collections
    .filter((c) => !isFolder(c))
    .map((c) => ({ collection: c.collection, label: titleOf(c.collection), hidden: c.meta?.hidden ?? false, system: false }))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.collection.localeCompare(b.collection)),
  ...SYSTEM_PERMISSION_COLLECTIONS.map((c) => ({ ...c, hidden: false, system: true })),
]);
const matrix = computed(() => byCollection(permissions.value));
const levelAt = (collection: string, action: Action): Level => levelOf(matrix.value.get(collection)?.[action]);

const dialog = ref<{ open: boolean; collection: string; label: string; action: Action }>({ open: false, collection: '', label: '', action: 'read' });
const openCell = (row: { collection: string; label: string }, action: Action) => (dialog.value = { open: true, collection: row.collection, label: row.label, action });

async function saved() {
  dialog.value.open = false;
  await refresh();
}

const busyRow = ref<string | null>(null);

/** All or no access to every action on a collection. */
async function setRow(collection: string, level: 'all' | 'none') {
  busyRow.value = collection;
  try {
    for (const action of ACTIONS) {
      const p = matrix.value.get(collection)?.[action];
      if (level === 'none' && p?.id !== undefined) await request(deletePermission(p.id));
      if (level === 'all' && levelOf(p) !== 'all') {
        const full = fullPermission(id.value, collection, action);
        await request(p?.id !== undefined ? updatePermission(p.id, full) : createPermission(full));
      }
    }
  } catch (e) {
    notifyError(e);
  } finally {
    busyRow.value = null;
    await refresh();
  }
}

async function refresh() {
  try {
    await loadPermissions();
  } catch (e) {
    notifyError(e);
  }
}

const ICON: Record<Level, 'minus' | 'check' | 'sliders'> = { none: 'minus', all: 'check', custom: 'sliders' };
const LEVEL_TEXT: Record<Level, string> = { none: 'No access', all: 'All access', custom: 'Custom access' };
const usedLabel = (u: UsedBy) => (u.role ? translate(u.role.name) : '');
</script>

<template>
  <PageLayout :subtitle="isPublic ? 'Applies to every request without a user, and to users without a role' : 'Policy'">
    <template #nav><SettingsNav /></template>
    <template #back>
      <RouterLink to="/settings/policies" class="icon-btn" aria-label="Back to policies"><Icon name="back" /></RouterLink>
    </template>
    <template #title>
      <h1>{{ creating ? 'New policy' : translate(String(original?.name ?? 'Policy')) }}</h1>
    </template>
    <template v-if="!missing" #actions>
      <span v-if="dirty" class="badge">Unsaved changes</span>
      <button v-if="!creating && !isPublic" type="button" class="icon-btn danger" title="Delete" aria-label="Delete policy" @click="remove"><Icon name="trash" /></button>
      <button v-if="!isPublic" type="button" class="btn primary" :disabled="!dirty || saving" @click="save">
        <Icon name="check" :size="18" />{{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>

    <div v-if="missing" class="empty card">
      <p>This policy doesn't exist.</p>
      <RouterLink to="/settings/policies" class="btn">Back to policies</RouterLink>
    </div>
    <div v-else-if="!original" class="subtle">Loading…</div>
    <div v-else class="layout">
      <form v-if="!isPublic" class="card section" novalidate @submit.prevent="save">
        <div class="form-grid">
          <div class="field">
            <label for="policy-name">Name<span class="required">*</span></label>
            <input id="policy-name" class="input" :class="{ invalid: errors.name }" :value="values.name" autofocus @input="set('name', ($event.target as HTMLInputElement).value)" />
            <div v-if="errors.name" class="error">{{ errors.name }}</div>
          </div>
          <div class="field">
            <label for="policy-description">Description</label>
            <input id="policy-description" class="input" :value="translate(values.description as string | null)" @input="set('description', ($event.target as HTMLInputElement).value || null)" />
          </div>
          <div class="field flags">
            <span class="label">Access</span>
            <label class="checkbox">
              <input type="checkbox" class="switch" :checked="values.app_access === true" @change="set('app_access', ($event.target as HTMLInputElement).checked)" />
              App access: can sign in to this app
            </label>
            <label class="checkbox">
              <input type="checkbox" class="switch" :checked="values.admin_access === true" @change="set('admin_access', ($event.target as HTMLInputElement).checked)" />
              Admin access: may do everything
            </label>
          </div>
          <div class="field">
            <label for="policy-ip">IP access</label>
            <TagsInput id="policy-ip" :model-value="(values.ip_access as string[] | null) ?? null" @update:model-value="set('ip_access', $event)" />
            <div class="hint">Addresses or ranges (<code>10.0.0.0/8</code>) the policy applies from. Empty: anywhere.</div>
          </div>
        </div>
        <button type="submit" hidden />
      </form>

      <section v-if="creating" class="card section subtle">Save the policy to give it permissions.</section>
      <section v-else-if="values.admin_access === true && original.admin_access === true" class="card section">
        <h2>Permissions</h2>
        <p class="muted">This policy gives admin access: permissions don't apply to its users.</p>
      </section>
      <section v-else class="card">
        <header class="section-head">
          <h2>Permissions</h2>
          <span class="spacer" />
          <span class="legend subtle">
            <span><Icon name="minus" :size="14" /> none</span><span class="all"><Icon name="check" :size="14" /> all</span><span class="custom"><Icon name="sliders" :size="14" /> custom</span>
          </span>
        </header>
        <div class="table-wrap">
          <table class="table matrix">
            <thead>
              <tr>
                <th>Collection</th>
                <th v-for="a in ACTIONS" :key="a" class="action">{{ a }}</th>
                <th class="row-actions" />
              </tr>
            </thead>
            <tbody>
              <template v-for="(row, i) in rows" :key="row.collection">
                <tr v-if="row.system && !rows[i - 1]?.system" class="group">
                  <td :colspan="ACTIONS.length + 2">System</td>
                </tr>
                <tr :class="{ busy: busyRow === row.collection }" :data-collection="row.collection">
                  <td>
                    <span class="collection">
                      {{ row.label }}
                      <code class="subtle">{{ row.collection }}</code>
                      <span v-if="row.hidden" class="badge">Hidden</span>
                    </span>
                  </td>
                  <td v-for="a in ACTIONS" :key="a" class="action">
                    <button
                      type="button"
                      class="cell"
                      :class="levelAt(row.collection, a)"
                      :title="`${LEVEL_TEXT[levelAt(row.collection, a)]}: ${a} ${row.label}`"
                      :aria-label="`${a} ${row.collection}: ${LEVEL_TEXT[levelAt(row.collection, a)]}`"
                      :data-action="a"
                      :data-level="levelAt(row.collection, a)"
                      @click="openCell(row, a)"
                    >
                      <Icon :name="ICON[levelAt(row.collection, a)]" :size="18" />
                    </button>
                  </td>
                  <td class="row-actions">
                    <button type="button" class="btn small" :disabled="busyRow !== null" :aria-label="`All access to ${row.collection}`" @click="setRow(row.collection, 'all')">All</button>
                    <button type="button" class="btn small" :disabled="busyRow !== null" :aria-label="`No access to ${row.collection}`" @click="setRow(row.collection, 'none')">None</button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p class="hint footnote">
          Changes here are saved at once. Many to many fields need permissions on their junction collection too (the hidden ones).
        </p>
      </section>

      <section v-if="!creating && !isPublic" class="card section">
        <h2>Used by</h2>
        <ul v-if="usedBy.length" class="used">
          <li v-for="u in usedBy" :key="u.id">
            <RouterLink v-if="u.role" :to="`/settings/roles/${u.role.id}`" class="who"><Icon name="users" :size="16" />{{ usedLabel(u) }}<span class="subtle">role</span></RouterLink>
            <RouterLink v-else-if="u.user" :to="`/users/${u.user.id}`" class="who"><ItemLabel :collection="USERS" :item="u.user" /><span class="subtle">user</span></RouterLink>
          </li>
        </ul>
        <p v-else class="subtle">
          No role or user has this policy yet. Add it to a <RouterLink :to="'/settings/roles'">role</RouterLink> or a <RouterLink to="/users">user</RouterLink>.
        </p>
      </section>
    </div>

    <PermissionDialog
      :open="dialog.open"
      :policy="id"
      :collection="dialog.collection"
      :label="dialog.label"
      :action="dialog.action"
      :permission="matrix.get(dialog.collection)?.[dialog.action]"
      @close="dialog.open = false"
      @saved="saved"
    />
  </PageLayout>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1040px;
}

.section {
  padding: 20px 24px 24px;
}

.section h2 {
  margin-bottom: 12px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.flags {
  gap: 8px;
}

.legend {
  display: flex;
  gap: 12px;
  font-size: 12px;
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.legend .all {
  color: var(--success);
}

.legend .custom {
  color: var(--primary);
}

.matrix th.action,
.matrix td.action {
  width: 84px;
  text-align: center;
}

.matrix tbody tr {
  cursor: default;
}

.matrix tr.busy {
  opacity: 0.5;
}

.matrix tr.group td {
  background: var(--panel-2);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.collection {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text-subtle);
  cursor: pointer;
}

.cell:hover {
  border-color: var(--primary);
}

.cell.all {
  border-color: var(--success);
  background: var(--success-soft);
  color: var(--success);
}

.cell.custom {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.row-actions {
  width: 130px;
  text-align: right;
}

.row-actions .btn {
  margin-left: 4px;
}

.footnote {
  padding: 12px 18px;
  margin: 0;
}

.used {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.who {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--text);
}

.who:hover {
  background: var(--panel-2);
}
</style>
