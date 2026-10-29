<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import NavList from './NavList.vue';

/** The settings module's navigation (admins only). */
const route = useRoute();

const items = computed(() =>
  [
    { key: 'data-model', label: 'Data model', to: '/settings/data-model', icon: 'database' as const },
    { key: 'roles', label: 'Roles', to: '/settings/roles', icon: 'users' as const },
    { key: 'policies', label: 'Policies', to: '/settings/policies', icon: 'shield' as const },
  ].map((i) => ({ ...i, active: route.path.startsWith(i.to) })),
);
</script>

<template>
  <NavList heading="Settings" :items="items" />
</template>
