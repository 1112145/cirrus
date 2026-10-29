<script setup lang="ts">
import { readRoles } from '@directus/sdk';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readPage, request } from '../api.ts';
import Icon from '../components/Icon.vue';
import ItemLabel from '../components/ItemLabel.vue';
import NavList from '../components/NavList.vue';
import PageLayout from '../components/PageLayout.vue';
import { type Role, translate } from '../lib/access.ts';
import { ROLES, USER_STATUSES, USERS } from '../lib/system.ts';
import { notifyError } from '../stores/notify.ts';
import { can } from '../stores/schema.ts';

/** The user directory: everyone the user may see, by role. */
const route = useRoute();
const router = useRouter();

type UserRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar: string | null;
  status: string;
  last_access: string | null;
  role: { id: string; name: string } | string | null;
};

const PAGE = 25;
const roles = ref<Role[]>([]);
const users = ref<UserRow[]>([]);
const total = ref(0);
const page = ref(1);
const search = ref('');
const loading = ref(false);
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE)));

/** The role in the URL: a role's id, `none` for users without one, or nothing for everyone. */
const roleFilter = computed(() => (typeof route.query.role === 'string' ? route.query.role : null));
const roleName = computed(() => (roleFilter.value === 'none' ? 'No role' : translate(roles.value.find((r) => r.id === roleFilter.value)?.name) || 'Users'));

const nav = computed(() => [
  { key: 'all', label: 'All users', to: '/users', icon: 'users' as const, active: roleFilter.value === null },
  ...roles.value.map((r) => ({ key: r.id, label: translate(r.name), to: { path: '/users', query: { role: r.id } }, icon: 'shield' as const, active: roleFilter.value === r.id })),
  ...(roles.value.length ? [{ key: 'none', label: 'No role', to: { path: '/users', query: { role: 'none' } }, icon: 'user' as const, active: roleFilter.value === 'none' }] : []),
]);

onMounted(async () => {
  if (!can(ROLES, 'read')) return;
  try {
    roles.value = await request<Role[]>(readRoles({ fields: ['id', 'name', 'icon', 'description', 'parent'], sort: ['name'], limit: -1 }));
  } catch (e) {
    notifyError(e);
  }
});

async function load() {
  loading.value = true;
  try {
    const filter = roleFilter.value === null ? undefined : roleFilter.value === 'none' ? { role: { _null: true } } : { role: { _eq: roleFilter.value } };
    const res = await readPage<UserRow>('/users', {
      fields: ['id', 'first_name', 'last_name', 'email', 'avatar', 'status', 'last_access', ...(can(ROLES, 'read') ? ['role.id', 'role.name'] : ['role'])],
      filter,
      search: search.value || undefined,
      sort: ['first_name', 'last_name', 'email'],
      limit: PAGE,
      page: page.value,
    });
    users.value = res.data;
    total.value = res.total;
  } catch (e) {
    notifyError(e);
  } finally {
    loading.value = false;
  }
}

watch(
  roleFilter,
  () => {
    page.value = 1;
    void load();
  },
  { immediate: true },
);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    page.value = 1;
    void load();
  }, 250);
});

function go(delta: number) {
  page.value = Math.min(pages.value, Math.max(1, page.value + delta));
  void load();
}

const statusText = (s: string) => USER_STATUSES.find((x) => x.value === s)?.text ?? s;
const roleOf = (u: UserRow) => (u.role && typeof u.role === 'object' ? translate(u.role.name) : '');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const createLink = computed(() => (roleFilter.value && roleFilter.value !== 'none' ? { path: '/users/+', query: { role: roleFilter.value } } : '/users/+'));
</script>

<template>
  <PageLayout :title="roleName" :subtitle="`${total} user${total === 1 ? '' : 's'}`">
    <template #nav><NavList heading="Users" :items="nav" /></template>
    <template #actions>
      <label class="search">
        <Icon name="search" :size="18" />
        <input v-model="search" class="input" type="search" placeholder="Search users…" aria-label="Search users" />
      </label>
      <RouterLink v-if="can(USERS, 'create')" :to="createLink" class="btn primary"><Icon name="plus" :size="18" />Create user</RouterLink>
    </template>

    <div class="card">
      <div class="table-wrap">
        <table class="table" :class="{ loading }">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last access</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" @click="router.push(`/users/${u.id}`)">
              <td><ItemLabel :collection="USERS" :item="u" /></td>
              <td>{{ u.email }}</td>
              <td>{{ roleOf(u) || '—' }}</td>
              <td>
                <span class="badge" :class="{ primary: u.status === 'active' }">{{ statusText(u.status) }}</span>
              </td>
              <td class="muted">{{ when(u.last_access) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!loading && !users.length" class="empty">
        <p>{{ search ? 'No users match your search.' : 'No users here yet.' }}</p>
      </div>
      <div v-if="pages > 1" class="pagination">
        <span class="spacer" />
        <button type="button" class="icon-btn" :disabled="page <= 1" aria-label="Previous page" @click="go(-1)"><Icon name="left" /></button>
        <span>{{ page }} / {{ pages }}</span>
        <button type="button" class="icon-btn" :disabled="page >= pages" aria-label="Next page" @click="go(1)"><Icon name="right" /></button>
      </div>
    </div>
  </PageLayout>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-subtle);
}

.search .input {
  width: 220px;
}

table.loading {
  opacity: 0.6;
}
</style>
