<script setup lang="ts">
/** A module's page: an optional navigation panel, then a header with actions above the content. */
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <div class="page">
    <aside v-if="$slots.nav" class="nav-panel">
      <slot name="nav" />
    </aside>
    <section class="main">
      <header class="page-header">
        <slot name="back" />
        <div class="titles">
          <slot name="title">
            <h1>{{ title }}</h1>
          </slot>
          <div v-if="subtitle" class="subtitle muted">{{ subtitle }}</div>
        </div>
        <div class="actions"><slot name="actions" /></div>
      </header>
      <div class="page-content"><slot /></div>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  height: 100%;
  min-width: 0;
}

.nav-panel {
  width: 240px;
  flex: none;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 16px 10px;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 68px;
  padding: 14px 28px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.titles {
  flex: 1;
  min-width: 0;
}

.titles :deep(h1) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtitle {
  font-size: 13px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-content {
  flex: 1;
  overflow: auto;
  padding: 24px 28px 64px;
}

@media (max-width: 860px) {
  .nav-panel {
    display: none;
  }

  .page-header,
  .page-content {
    padding-left: 16px;
    padding-right: 16px;
  }
}
</style>
