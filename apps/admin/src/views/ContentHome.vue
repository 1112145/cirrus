<script setup lang="ts">
import { computed } from 'vue';
import ContentNav from '../components/ContentNav.vue';
import Icon from '../components/Icon.vue';
import PageLayout from '../components/PageLayout.vue';
import { titleOf } from '../lib/schema.ts';
import { contentCollections } from '../stores/schema.ts';
import { session } from '../stores/session.ts';

const collections = computed(contentCollections);
</script>

<template>
  <PageLayout title="Content">
    <template #nav><ContentNav /></template>
    <div v-if="collections.length" class="grid">
      <RouterLink v-for="c in collections" :key="c.collection" :to="`/content/${c.collection}`" class="card tile">
        <Icon name="box" :size="22" />
        <div>
          <strong>{{ titleOf(c.collection) }}</strong>
          <div v-if="c.meta?.note" class="muted note">{{ c.meta.note }}</div>
        </div>
      </RouterLink>
    </div>
    <div v-else class="empty card">
      <Icon name="database" :size="32" />
      <p>There are no collections yet.</p>
      <RouterLink v-if="session.admin" to="/settings/data-model" class="btn primary">Create a collection</RouterLink>
    </div>
  </PageLayout>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.tile {
  display: flex;
  gap: 12px;
  padding: 16px;
  color: var(--text);
}

.tile:hover {
  border-color: var(--primary);
}

.tile :deep(.icon) {
  color: var(--primary);
}

.note {
  font-size: 13px;
}
</style>
