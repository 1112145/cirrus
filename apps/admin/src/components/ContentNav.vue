<script setup lang="ts">
import { computed } from 'vue';
import { titleOf } from '../lib/schema.ts';
import { contentCollections } from '../stores/schema.ts';
import NavList from './NavList.vue';

/** The content module's navigation: the collections the user may read. */
const props = defineProps<{ active?: string }>();

const items = computed(() =>
  contentCollections().map((c) => ({
    key: c.collection,
    label: titleOf(c.collection),
    to: `/content/${c.collection}`,
    icon: 'box' as const,
    active: c.collection === props.active,
  })),
);
</script>

<template>
  <NavList heading="Content" :items="items">
    <p v-if="!items.length" class="subtle empty-nav">No collections yet.</p>
  </NavList>
</template>

<style scoped>
.empty-nav {
  padding: 0 10px;
  font-size: 13px;
}
</style>
