<script setup lang="ts">
import { createRole, deleteRole, readPolicies, readRole, readRoles, updateRole } from '@directus/sdk';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readPage, request } from '../api.ts';
import Icon from '../components/Icon.vue';
import ItemLabel from '../components/ItemLabel.vue';
import PageLayout from '../components/PageLayout.vue';
import PolicyList, { type AccessRow } from '../components/PolicyList.vue';
import SettingsNav from '../components/SettingsNav.vue';
import { useUnsavedGuard } from '../composables/unsaved.ts';
import { accessPayload, parentChoices, type Policy, type Role, translate } from '../lib/access.ts';
import { errorCode, errorMessage, fieldErrors } from '../lib/errors.ts';
import { changes, type Item, same } from '../lib/payload.ts';
import { USERS } from '../lib/system.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';

/** A role: its name, the role above it, its policies and its users. */
const route = useRoute();
const router = useRouter();

const id = computed(() => String(route.params.id));
const creating = computed(() => id.value === '+');

const original = ref<Item | null>(null);
const edits = ref<Item>({});
const errors = ref<Record<string, string>>({});
const missing = ref(false);
const saving = ref(false);
const roles = ref<Role[]>([]);
const policies = ref<Policy[]>([]);
const users = ref<Array<Record<string, unknown>>>([]);
const userCount = ref(0);

async function load() {
  edits.value = {};
  errors.value = {};
  missing.value = false;
  users.value = [];
  userCount.value = 0;
  if (creating.value) {
    original.value = { name: '', description: null, parent: null, policies: [] };
    return;
  }
  original.value = null;
  try {
    original.value = await request<Item>(readRole(id.value, { fields: ['id', 'name', 'icon', 'description', 'parent', 'policies.id', 'policies.policy.id', 'policies.policy.name'] }));
    const res = await readPage('/users', { fields: ['id', 'first_name', 'last_name', 'email', 'avatar'], filter: { role: { _eq: id.value } }, sort: ['first_name', 'email'], limit: 50 });
    users.value = res.data;
    userCount.value = res.total;
  } catch (e) {
    missing.value = true;
    if (errorCode(e) !== 'FORBIDDEN') notifyError(e);
  }
}

watch(id, load, { immediate: true });

onMounted(async () => {
  try {
    [roles.value, policies.value] = await Promise.all([
      request<Role[]>(readRoles({ fields: ['id', 'name', 'icon', 'description', 'parent'], sort: ['name'], limit: -1 })),
      request<Policy[]>(readPolicies({ fields: ['id', 'name', 'icon', 'description', 'admin_access', 'app_access'], sort: ['name'], limit: -1 })),
    ]);
  } catch (e) {
    notifyError(e);
  }
});

const values = computed<Item>(() => ({ ...(original.value ?? {}), ...edits.value }));
const pending = computed<Item>(() => {
  if (!original.value) return {};
  if (!creating.value) return changes(original.value, edits.value);
  return Object.fromEntries(Object.entries(values.value).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));
});
const dirty = computed(() => Object.keys(creating.value ? edits.value : pending.value).length > 0);

function set(field: string, value: unknown) {
  const next = { ...edits.value };
  if (!creating.value && original.value && same(original.value[field], value)) delete next[field];
  else next[field] = value;
  edits.value = next;
  if (errors.value[field]) errors.value = Object.fromEntries(Object.entries(errors.value).filter(([k]) => k !== field));
}

const parents = computed(() => parentChoices(roles.value, creating.value ? null : id.value));
const accessRows = computed<AccessRow[]>(() => (Array.isArray(values.value.policies) ? (values.value.policies as AccessRow[]) : []));

async function save() {
  if (!dirty.value || saving.value) return;
  if (!String(values.value.name ?? '').trim()) {
    errors.value = { name: 'This field is required.' };
    notify('Some fields need attention.', 'error');
    return;
  }
  saving.value = true;
  errors.value = {};
  const payload: Item = { ...pending.value };
  if (payload.policies) payload.policies = accessPayload(payload.policies as AccessRow[]);
  try {
    if (creating.value) {
      const created = await request<{ id: string }>(createRole(payload, { fields: ['id'] }));
      edits.value = {};
      notify('Role created.');
      await router.replace(`/settings/roles/${created.id}`);
      return;
    }
    await request(updateRole(id.value, payload));
    notify('Saved.');
    edits.value = {};
    await load();
  } catch (e) {
    errors.value = fieldErrors(e);
    notify(errorMessage(e), 'error');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const who = userCount.value ? ` Its ${userCount.value} user${userCount.value === 1 ? '' : 's'} will have no role.` : '';
  if (!(await confirm(`Delete the role “${translate(String(original.value?.name ?? ''))}”?${who}`, { action: 'Delete', danger: true }))) return;
  try {
    await request(deleteRole(id.value));
    edits.value = {};
    notify('Role deleted.');
    await router.push('/settings/roles');
  } catch (e) {
    notifyError(e);
  }
}

useUnsavedGuard(dirty, save);
</script>

<template>
  <PageLayout :subtitle="creating ? 'Roles' : 'Role'">
    <template #nav><SettingsNav /></template>
    <template #back>
      <RouterLink to="/settings/roles" class="icon-btn" aria-label="Back to roles"><Icon name="back" /></RouterLink>
    </template>
    <template #title>
      <h1>{{ creating ? 'New role' : translate(String(original?.name ?? 'Role')) }}</h1>
    </template>
    <template v-if="!missing" #actions>
      <span v-if="dirty" class="badge">Unsaved changes</span>
      <button v-if="!creating" type="button" class="icon-btn danger" title="Delete" aria-label="Delete role" @click="remove"><Icon name="trash" /></button>
      <button type="button" class="btn primary" :disabled="!dirty || saving" @click="save"><Icon name="check" :size="18" />{{ saving ? 'Saving…' : 'Save' }}</button>
    </template>

    <div v-if="missing" class="empty card">
      <p>This role doesn't exist.</p>
      <RouterLink to="/settings/roles" class="btn">Back to roles</RouterLink>
    </div>
    <div v-else-if="!original" class="subtle">Loading…</div>
    <form v-else class="layout" novalidate @submit.prevent="save">
      <section class="card section">
        <div class="form-grid">
          <div class="field">
            <label for="role-name">Name<span class="required">*</span></label>
            <input id="role-name" class="input" :class="{ invalid: errors.name }" :value="values.name" autofocus @input="set('name', ($event.target as HTMLInputElement).value)" />
            <div v-if="errors.name" class="error">{{ errors.name }}</div>
          </div>
          <div class="field">
            <label for="role-parent">Parent role</label>
            <select id="role-parent" class="input" :value="(values.parent as string | null) ?? ''" @change="set('parent', ($event.target as HTMLSelectElement).value || null)">
              <option value="">None</option>
              <option v-for="r in parents" :key="r.id" :value="r.id">{{ translate(r.name) }}</option>
            </select>
            <div class="hint">Users of this role also get the policies of the roles above it.</div>
          </div>
          <div class="field full">
            <label for="role-description">Description</label>
            <input id="role-description" class="input" :value="translate(values.description as string | null)" @input="set('description', ($event.target as HTMLInputElement).value || null)" />
          </div>
          <div class="field full">
            <span class="label">Policies</span>
            <PolicyList :model-value="accessRows" :policies="policies" empty="No policies: this role's users can do nothing yet." @update:model-value="set('policies', $event)" />
            <div class="hint">
              What the role's users may do. <RouterLink to="/settings/policies/+">Create a policy</RouterLink> to give it new permissions.
            </div>
          </div>
        </div>
      </section>

      <section v-if="!creating" class="card section">
        <header class="section-head">
          <h2>Users</h2>
          <span class="badge">{{ userCount }}</span>
          <span class="spacer" />
          <RouterLink :to="{ path: '/users/+', query: { role: id } }" class="btn small"><Icon name="plus" :size="16" />Create user</RouterLink>
        </header>
        <ul v-if="users.length" class="users">
          <li v-for="u in users" :key="String(u.id)">
            <RouterLink :to="`/users/${u.id}`" class="user"><ItemLabel :collection="USERS" :item="u" /><span class="subtle">{{ u.email }}</span></RouterLink>
          </li>
        </ul>
        <p v-else class="subtle">No users have this role.</p>
        <RouterLink v-if="userCount > users.length" :to="{ path: '/users', query: { role: id } }">See all {{ userCount }} users</RouterLink>
      </section>
      <button type="submit" hidden />
    </form>
  </PageLayout>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 960px;
}

.section {
  padding: 20px 24px 24px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.users {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--text);
}

.user:hover {
  background: var(--panel-2);
}
</style>
