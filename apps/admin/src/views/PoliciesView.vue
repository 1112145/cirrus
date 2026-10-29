<script setup lang="ts">
import { readPolicies } from '@directus/sdk';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { readPage, request } from '../api.ts';
import Icon from '../components/Icon.vue';
import PageLayout from '../components/PageLayout.vue';
import SettingsNav from '../components/SettingsNav.vue';
import { type Access, type Policy, PUBLIC_POLICY, translate } from '../lib/access.ts';
import { notifyError } from '../stores/notify.ts';

/** Policies: sets of permissions, attached to roles and users (and the public policy, to everyone). */
const router = useRouter();

type PolicyRow = Policy & { permissions: Array<{ id: number }> };
const policies = ref<PolicyRow[]>([]);
const access = ref<Access[]>([]);
const loaded = ref(false);

onMounted(async () => {
  try {
    const [p, a] = await Promise.all([
      request<PolicyRow[]>(readPolicies({ fields: ['id', 'name', 'icon', 'description', 'admin_access', 'app_access', 'permissions.id'], sort: ['name'], limit: -1, deep: { permissions: { _limit: -1 } } })),
      readPage<Access>('/access', { fields: ['id', 'role', 'user', 'policy'], limit: -1 }),
    ]);
    policies.value = p;
    access.value = a.data;
  } catch (e) {
    notifyError(e);
  } finally {
    loaded.value = true;
  }
});

/** The public policy first, then by name. */
const sorted = computed(() => [...policies.value].sort((a, b) => Number(b.id === PUBLIC_POLICY) - Number(a.id === PUBLIC_POLICY) || translate(a.name).localeCompare(translate(b.name))));
const count = (id: string, kind: 'role' | 'user') => access.value.filter((a) => a.policy === id && a[kind] !== null).length;
</script>

<template>
  <PageLayout title="Policies" subtitle="Sets of permissions; attach them to roles or users">
    <template #nav><SettingsNav /></template>
    <template #actions>
      <RouterLink to="/settings/policies/+" class="btn primary"><Icon name="plus" :size="18" />Create policy</RouterLink>
    </template>

    <div v-if="sorted.length" class="card">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Policy</th>
              <th>Access</th>
              <th>Roles</th>
              <th>Users</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in sorted" :key="p.id" @click="router.push(`/settings/policies/${p.id}`)">
              <td>
                <span class="name">
                  <Icon :name="p.id === PUBLIC_POLICY ? 'globe' : 'shield'" :size="18" />
                  <strong>{{ translate(p.name) }}</strong>
                </span>
              </td>
              <td>
                <span v-if="p.id === PUBLIC_POLICY" class="badge">Everyone</span>
                <span v-else-if="p.admin_access" class="badge primary">Admin</span>
                <span v-else class="badge">{{ p.permissions?.length ?? 0 }} permission{{ p.permissions?.length === 1 ? '' : 's' }}{{ p.app_access ? ' · app' : '' }}</span>
              </td>
              <td>{{ p.id === PUBLIC_POLICY ? '—' : count(p.id, 'role') }}</td>
              <td>{{ p.id === PUBLIC_POLICY ? '—' : count(p.id, 'user') }}</td>
              <td class="muted">{{ translate(p.description) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else-if="loaded" class="empty card">
      <Icon name="shield" :size="32" />
      <p>No policies yet.</p>
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
