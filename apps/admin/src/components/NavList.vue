<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';
import Icon, { type ICONS } from './Icon.vue';

/** The navigation panel's list of links. */
defineProps<{ heading?: string; items: Array<{ key: string; label: string; to: RouteLocationRaw; icon?: keyof typeof ICONS; active?: boolean; depth?: number }> }>();
</script>

<template>
  <nav class="nav-list">
    <div v-if="heading" class="heading">{{ heading }}</div>
    <RouterLink
      v-for="item in items"
      :key="item.key"
      :to="item.to"
      class="item"
      :class="{ active: item.active }"
      :style="item.depth ? { paddingLeft: `${10 + item.depth * 16}px` } : undefined"
    >
      <Icon :name="item.icon ?? 'box'" :size="18" />
      <span>{{ item.label }}</span>
    </RouterLink>
    <slot />
  </nav>
</template>

<style scoped>
.nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.heading {
  padding: 4px 10px 10px;
  color: var(--text-subtle);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--text);
  font-weight: 500;
}

.item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item :deep(.icon) {
  color: var(--text-subtle);
}

.item:hover {
  background: var(--panel-2);
}

.item.active {
  background: var(--primary-soft);
  color: var(--primary);
}

.item.active :deep(.icon) {
  color: var(--primary);
}
</style>
