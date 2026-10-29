<script setup lang="ts">
import { createUser, deleteUser, readPolicies, readRoles, readUser, updateUser } from '@directus/sdk';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { request } from '../api.ts';
import FieldInput from '../components/FieldInput.vue';
import FileSelect from '../components/FileSelect.vue';
import Icon from '../components/Icon.vue';
import PageLayout from '../components/PageLayout.vue';
import PolicyList, { type AccessRow } from '../components/PolicyList.vue';
import { useUnsavedGuard } from '../composables/unsaved.ts';
import { accessPayload, newToken, type Policy, type Role, translate } from '../lib/access.ts';
import { errorCode, errorMessage, fieldErrors } from '../lib/errors.ts';
import { changes, type Item, keyOf, same } from '../lib/payload.ts';
import { type Field, FILES, titleOf } from '../lib/schema.ts';
import { ACCESS, POLICIES, ROLES, USER_STATUSES, USERS } from '../lib/system.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';
import { can, type ItemAccess, itemAccess, schema, systemField } from '../stores/schema.ts';
import { displayName, session } from '../stores/session.ts';

/** A user: profile, sign-in (password, static token), and access (status, role, policies). */
const route = useRoute();
const router = useRouter();

const id = computed(() => String(route.params.id));
const creating = computed(() => id.value === '+');
const self = computed(() => id.value === session.user?.id);

const original = ref<Item | null>(null);
const edits = ref<Item>({});
const errors = ref<Record<string, string>>({});
const missing = ref(false);
/** What the user may do with this user, as /permissions/me says. */
const access = ref<ItemAccess>({ update: true, delete: false });
const saving = ref(false);
const roles = ref<Role[]>([]);
const policies = ref<Policy[]>([]);
/** A token generated in this visit, shown until the page is left. */
const shownToken = ref<string | null>(null);

const f = (field: string, type: Field['type'], extra: Partial<NonNullable<Field['meta']>> = {}) => systemField(USERS, field, type, 0, extra);
const PROFILE: Field[] = [
  f('first_name', 'string', { width: 'half' }),
  f('last_name', 'string', { width: 'half' }),
  f('email', 'string', { required: true }),
  f('title', 'string', { width: 'half' }),
  f('location', 'string', { width: 'half' }),
  f('description', 'text', { interface: 'input-multiline' }),
  f('tags', 'json', { interface: 'tags' }),
];

// Loading ------------------------------------------------------------------------------------------

const readPaths = () => [
  '*',
  ...(can(FILES, 'read') ? ['avatar.id', 'avatar.title', 'avatar.type', 'avatar.filename_download'] : []),
  ...(can(ACCESS, 'read') && can(POLICIES, 'read') ? ['policies.id', 'policies.policy.id', 'policies.policy.name'] : []),
];

async function load() {
  edits.value = {};
  errors.value = {};
  missing.value = false;
  shownToken.value = null;
  if (creating.value) {
    original.value = { status: 'active', role: typeof route.query.role === 'string' ? route.query.role : null, policies: [] };
    return;
  }
  original.value = null;
  try {
    const [user, allowed] = await Promise.all([request<Item>(readUser(id.value, { fields: readPaths() })), itemAccess(USERS, id.value)]);
    original.value = user;
    access.value = allowed;
  } catch (e) {
    missing.value = true;
    if (errorCode(e) !== 'FORBIDDEN') notifyError(e);
  }
}

watch(id, load, { immediate: true });

onMounted(async () => {
  try {
    if (can(ROLES, 'read')) roles.value = await request<Role[]>(readRoles({ fields: ['id', 'name', 'icon', 'description', 'parent'], sort: ['name'], limit: -1 }));
    if (can(POLICIES, 'read') && session.admin) {
      policies.value = await request<Policy[]>(readPolicies({ fields: ['id', 'name', 'icon', 'description', 'admin_access', 'app_access'], sort: ['name'], limit: -1 }));
    }
  } catch (e) {
    notifyError(e);
  }
});

// Editing ----------------------------------------------------------------------------------------

const values = computed<Item>(() => ({ ...(original.value ?? {}), ...edits.value }));
/** What saving sends: a new user's values (defaults included), or an existing user's changes. */
const pending = computed<Item>(() => {
  if (!original.value) return {};
  if (!creating.value) return changes(original.value, edits.value);
  return Object.fromEntries(Object.entries(values.value).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
});
const dirty = computed(() => Object.keys(creating.value ? edits.value : pending.value).length > 0);

function set(field: string, value: unknown) {
  const next = { ...edits.value };
  if (!creating.value && original.value && same(original.value[field], value)) delete next[field];
  else next[field] = value;
  edits.value = next;
  if (errors.value[field]) errors.value = Object.fromEntries(Object.entries(errors.value).filter(([k]) => k !== field));
}

/** Whether the user may change a field: admins all, others as their permissions allow. */
function writable(field: string): boolean {
  if (session.admin) return true;
  const action = creating.value ? 'create' : 'update';
  if (!can(USERS, action) || (!creating.value && !access.value.update)) return false;
  const allowed = schema.permissions[USERS]?.[action]?.fields;
  return !allowed || allowed.includes('*') || allowed.includes(field);
}

const mayWrite = computed(() => session.admin || (can(USERS, creating.value ? 'create' : 'update') && (creating.value || access.value.update)));
const mayDelete = computed(() => !creating.value && !self.value && (session.admin || (can(USERS, 'delete') && access.value.delete)));

// Policies attached to the user itself (on top of their role's).
const accessRows = computed<AccessRow[]>(() => (Array.isArray(values.value.policies) ? (values.value.policies as AccessRow[]) : []));

// Static token: the API keeps its SHA-256 and reads it back as asterisks.
const hasToken = computed(() => values.value.token !== null && values.value.token !== undefined && values.value.token !== '');

function generateToken() {
  shownToken.value = newToken();
  set('token', shownToken.value);
}

function removeToken() {
  shownToken.value = null;
  set('token', null);
}

async function copyToken() {
  if (!shownToken.value) return;
  try {
    await navigator.clipboard.writeText(shownToken.value);
    notify('Token copied.');
  } catch {
    notify('Select the token and copy it.', 'info');
  }
}

// Saving -----------------------------------------------------------------------------------------

function payloadOf(edits: Item): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(edits)) {
    if (k === 'password' && (v === '' || v === null)) continue;
    if (k === 'avatar' || k === 'role') out[k] = keyOf(v, 'id');
    else if (k === 'policies') out[k] = accessPayload(v as AccessRow[]);
    else out[k] = v;
  }
  return out;
}

async function save() {
  if (!dirty.value || saving.value) return;
  if (!values.value.email || String(values.value.email).trim() === '') {
    errors.value = { email: 'This field is required.' };
    notify('Some fields need attention.', 'error');
    return;
  }
  saving.value = true;
  errors.value = {};
  try {
    const payload = payloadOf(pending.value);
    if (creating.value) {
      const created = await request<{ id: string }>(createUser(payload, { fields: ['id'] }));
      edits.value = {};
      notify('User created.');
      await router.replace(`/users/${created.id}`);
      return;
    }
    original.value = await request<Item>(updateUser(id.value, payload, { fields: readPaths() }));
    edits.value = {};
    if (self.value && session.user) {
      Object.assign(session.user, { first_name: original.value.first_name, last_name: original.value.last_name, email: original.value.email });
    }
    notify('Saved.');
  } catch (e) {
    errors.value = fieldErrors(e);
    notify(errorMessage(e), 'error');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!(await confirm('Delete this user? They can no longer sign in, and this can’t be undone.', { action: 'Delete', danger: true }))) return;
  try {
    await request(deleteUser(id.value));
    edits.value = {};
    notify('User deleted.');
    await router.push('/users');
  } catch (e) {
    notifyError(e);
  }
}

useUnsavedGuard(dirty, save);

const title = computed(() => {
  if (creating.value) return 'New user';
  const u = original.value;
  if (!u) return 'User';
  return displayName({ id: '', email: String(u.email ?? ''), first_name: (u.first_name as string) ?? null, last_name: (u.last_name as string) ?? null, role: null });
});
const when = (iso: unknown) => (typeof iso === 'string' ? new Date(iso).toLocaleString() : 'Never');
</script>

<template>
  <PageLayout :subtitle="self ? 'Your profile' : creating ? 'Users' : String(original?.email ?? '')">
    <template #back>
      <RouterLink to="/users" class="icon-btn" aria-label="Back to users"><Icon name="back" /></RouterLink>
    </template>
    <template #title>
      <h1>{{ title }}</h1>
    </template>
    <template v-if="!missing" #actions>
      <span v-if="dirty" class="badge">Unsaved changes</span>
      <button v-if="mayDelete" type="button" class="icon-btn danger" title="Delete" aria-label="Delete user" @click="remove"><Icon name="trash" /></button>
      <button type="button" class="btn primary" :disabled="!dirty || saving || !mayWrite" @click="save">
        <Icon name="check" :size="18" />{{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>

    <div v-if="missing" class="empty card">
      <p>This user doesn't exist, or you may not see them.</p>
      <RouterLink to="/users" class="btn">Back to users</RouterLink>
    </div>
    <div v-else-if="!original" class="subtle">Loading…</div>
    <form v-else class="layout" novalidate @submit.prevent="save">
      <p v-if="!mayWrite" class="card notice muted">
        {{ self ? 'You may see your profile but not change it.' : 'You may see this user but not change them.' }} An admin can allow it with a policy's
        permissions on Users.
      </p>
      <section class="card section">
        <h2>Profile</h2>
        <div class="form-grid">
          <div class="field full">
            <span class="label">Avatar</span>
            <FileSelect :model-value="values.avatar ?? null" image :disabled="!writable('avatar')" @update:model-value="set('avatar', $event)" />
          </div>
          <div v-for="field in PROFILE" :key="field.field" class="field" :class="field.meta?.width === 'half' ? 'half' : 'full'">
            <label :for="`field-${field.field}`">
              {{ titleOf(field.field) }}
              <span v-if="field.meta?.required" class="required">*</span>
            </label>
            <FieldInput
              :id="`field-${field.field}`"
              :field="field"
              :model-value="values[field.field] ?? null"
              :disabled="!writable(field.field)"
              :invalid="!!errors[field.field]"
              @update:model-value="set(field.field, $event)"
            />
            <div v-if="errors[field.field]" class="error">{{ errors[field.field] }}</div>
          </div>
        </div>
      </section>

      <section class="card section">
        <h2>Sign-in</h2>
        <div class="form-grid">
          <div class="field">
            <label for="field-password">{{ creating ? 'Password' : 'New password' }}</label>
            <input
              id="field-password"
              class="input"
              type="password"
              autocomplete="new-password"
              :value="(edits.password as string) ?? ''"
              :disabled="!writable('password')"
              :placeholder="creating ? '' : 'Leave empty to keep the current one'"
              @input="set('password', ($event.target as HTMLInputElement).value)"
            />
            <div v-if="errors.password" class="error">{{ errors.password }}</div>
            <div v-else-if="creating" class="hint">Without a password, the user can only use a static token.</div>
          </div>
          <div class="field">
            <span class="label">Last access</span>
            <div class="static">{{ when(values.last_access) }}</div>
          </div>
          <div v-if="writable('token')" class="field full">
            <span class="label">Static token</span>
            <div v-if="shownToken" class="token">
              <code data-test="token">{{ shownToken }}</code>
              <button type="button" class="btn small" @click="copyToken"><Icon name="check" :size="16" />Copy</button>
            </div>
            <div class="toolbar">
              <span v-if="!shownToken" class="muted">{{ hasToken ? 'A token is set.' : 'No token.' }}</span>
              <button type="button" class="btn small" @click="generateToken"><Icon name="key" :size="16" />{{ hasToken ? 'Regenerate' : 'Generate token' }}</button>
              <button v-if="hasToken" type="button" class="btn small" @click="removeToken"><Icon name="x" :size="16" />Remove</button>
            </div>
            <div class="hint">
              For scripts and other servers: sent as <code>Authorization: Bearer &lt;token&gt;</code>, it acts as this user. It's shown once, then
              only its fingerprint is kept; save to apply.
            </div>
          </div>
        </div>
      </section>

      <section v-if="session.admin || writable('status') || writable('role')" class="card section">
        <h2>Access</h2>
        <div class="form-grid">
          <div class="field">
            <label for="field-status">Status</label>
            <select id="field-status" class="input" :value="values.status as string" :disabled="!writable('status') || self" @change="set('status', ($event.target as HTMLSelectElement).value)">
              <option v-for="s in USER_STATUSES" :key="s.value" :value="s.value">{{ s.text }}</option>
            </select>
            <div class="hint">Only active users can sign in.</div>
          </div>
          <div class="field">
            <label for="field-role">Role</label>
            <select
              id="field-role"
              class="input"
              :value="keyOf(values.role, 'id') ?? ''"
              :disabled="!writable('role') || (self && session.admin)"
              @change="set('role', ($event.target as HTMLSelectElement).value || null)"
            >
              <option value="">No role</option>
              <option v-for="r in roles" :key="r.id" :value="r.id">{{ translate(r.name) }}</option>
            </select>
            <div v-if="self && session.admin" class="hint">You can't change your own role here.</div>
          </div>
          <div v-if="session.admin" class="field full">
            <span class="label">Policies of this user</span>
            <PolicyList
              :model-value="accessRows"
              :policies="policies"
              empty="None: the user has their role's policies."
              @update:model-value="set('policies', $event)"
            />
            <div class="hint">On top of the policies of their role.</div>
          </div>
        </div>
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

.notice {
  margin: 0;
  padding: 14px 24px;
}

.section h2 {
  margin-bottom: 18px;
}

.static {
  min-height: 36px;
  display: flex;
  align-items: center;
  color: var(--text-muted);
}

.token {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--primary);
  border-radius: var(--radius-sm);
  background: var(--primary-soft);
}

.token code {
  flex: 1;
  overflow-wrap: anywhere;
}

</style>
