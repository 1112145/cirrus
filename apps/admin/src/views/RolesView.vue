<script setup lang="ts">
import { readRoles } from '@directus/sdk';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { request } from '../api.ts';
import Icon from '../components/Icon.vue';
import PageLayout from '../components/PageLayout.vue';
import SettingsNav from '../components/SettingsNav.vue';
import { type Role, translate } from '../lib/access.ts';
import { notifyError } from '../stores/notify.ts';

/** Roles, nested under their parents: who is who, and how many users and policies each has. */
const router = useRouter();

type RoleRow = Role & { users: Array<{ id: string }>; policies: Array<{ id: string }> };
const roles = ref<RoleRow[]>([]);
const loaded = ref(false);

onMounted(async () => {
  try {
    roles.value = await request<RoleRow[]>(
      readRoles({ fields: ['id', 'name', 'icon', 'description', 'parent', 'users.id', 'policies.id'], sort: ['name'], limit: -1, deep: { users: { _limit: -1 } } }),
    );
  } catch (e) {
    notifyError(e);
  } finally {
    loaded.value = true;
  }
});

/** Roles in tree order, with their depth. */
const tree = computed(() => {
  const known = new Set(roles.value.map((r) => r.id));
  const out: Array<{ role: RoleRow; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of roles.value.filter((x) => (x.parent && known.has(x.parent) ? x.parent : null) === parent)) {
      out.push({ role: r, depth });
      if (depth < 20) walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
});
</script>

<template>
  <PageLayout title="Roles" subtitle="Groups of users; a role gives its users the policies attached to it and to the roles above it">
    <template #nav><SettingsNav /></template>
    <template #actions>
      <RouterLink to="/settings/roles/+" class="btn primary"><Icon name="plus" :size="18" />Create role</RouterLink>
    </template>

    <div v-if="tree.length" class="card">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Users</th>
              <th>Policies</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="{ role, depth } in tree" :key="role.id" @click="router.push(`/settings/roles/${role.id}`)">
              <td>
                <span class="name" :style="{ paddingLeft: `${depth * 20}px` }">
                  <Icon name="users" :size="18" />
                  <strong>{{ translate(role.name) }}</strong>
                </span>
              </td>
              <td>{{ role.users?.length ?? 0 }}</td>
              <td>{{ role.policies?.length ?? 0 }}</td>
              <td class="muted">{{ translate(role.description) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else-if="loaded" class="empty card">
      <Icon name="users" :size="32" />
      <p>No roles yet.</p>
    </div>
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

td.muted {
  white-space: normal;
}
</style>
