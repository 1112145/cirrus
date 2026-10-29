import { onBeforeUnmount, onMounted, type Ref } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { confirm } from '../stores/notify.ts';

/**
 * Ask before leaving a form with unsaved changes: to another page (or another item in the same
 * view), and on reload or close. With `save`, Ctrl/⌘+S saves.
 */
export function useUnsavedGuard(dirty: Ref<boolean>, save?: () => unknown) {
  const leave = async () => !dirty.value || (await confirm('Discard your unsaved changes?', { action: 'Discard', danger: true }));
  onBeforeRouteLeave(leave);
  onBeforeRouteUpdate(leave);

  function beforeUnload(e: BeforeUnloadEvent) {
    if (dirty.value) e.preventDefault();
  }
  function shortcut(e: KeyboardEvent) {
    if (save && (e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
  }
  onMounted(() => {
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', shortcut);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('keydown', shortcut);
  });
}
