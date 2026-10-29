<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { displayName, logout, session } from '../stores/session.ts';
import Icon, { type ICONS } from './Icon.vue';

/** The app around the modules: the module bar on the left, the current module beside it. */
const route = useRoute();
const router = useRouter();

const modules = computed(() => {
  const list: Array<{ path: string; label: string; icon: keyof typeof ICONS }> = [
    { path: '/content', label: 'Content', icon: 'box' },
    { path: '/files', label: 'File library', icon: 'image' },
  ];
  if (session.admin) list.push({ path: '/settings/data-model', label: 'Data model', icon: 'database' });
  return list;
});

const initials = computed(() => {
  const me = session.user;
  if (!me) return '';
  return displayName(me)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
});

async function signOut() {
  await logout();
  await router.push('/login');
}
</script>

<template>
  <div class="shell">
    <nav class="modules" aria-label="Modules">
      <RouterLink to="/content" class="logo" :title="session.project"><Icon name="cloud" :size="24" /></RouterLink>
      <RouterLink
        v-for="m in modules"
        :key="m.path"
        :to="m.path"
        class="module"
        :class="{ active: route.path.startsWith(m.path) }"
        :title="m.label"
        :aria-label="m.label"
      >
        <Icon :name="m.icon" :size="22" />
      </RouterLink>
      <span class="spacer" />
      <div v-if="session.user" class="avatar" :title="displayName(session.user)">{{ initials }}</div>
      <button type="button" class="module" title="Log out" aria-label="Log out" @click="signOut"><Icon name="logout" :size="22" /></button>
    </nav>
    <main class="module-view">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.modules {
  width: 60px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 0;
  background: var(--modules);
}

.logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 10px;
  border-radius: 10px;
  background: var(--primary);
  color: #fff;
}

.module {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--modules-text);
  cursor: pointer;
}

.module:hover {
  color: var(--modules-active);
  background: rgb(255 255 255 / 0.08);
}

.module.active {
  color: var(--modules-active);
  background: rgb(255 255 255 / 0.14);
}

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgb(255 255 255 / 0.15);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

.module-view {
  flex: 1;
  min-width: 0;
  height: 100%;
}
</style>
