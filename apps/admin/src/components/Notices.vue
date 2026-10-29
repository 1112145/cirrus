<script setup lang="ts">
import { answer, confirmation, dismiss, notices } from '../stores/notify.ts';
import Icon from './Icon.vue';
import Modal from './Modal.vue';
</script>

<template>
  <div class="notices" role="status" aria-live="polite">
    <div v-for="n in notices" :key="n.id" class="notice" :class="n.kind">
      <Icon :name="n.kind === 'error' ? 'x' : 'check'" :size="18" />
      <span>{{ n.message }}</span>
      <button type="button" class="icon-btn" aria-label="Dismiss" @click="dismiss(n.id)"><Icon name="x" :size="16" /></button>
    </div>
  </div>
  <Modal :open="confirmation.open" title="Are you sure?" @close="answer(false)">
    <p class="message">{{ confirmation.message }}</p>
    <template #footer>
      <button type="button" class="btn" @click="answer(false)">Cancel</button>
      <button type="button" class="btn" :class="confirmation.danger ? 'danger' : 'primary'" data-test="confirm" @click="answer(true)">
        {{ confirmation.action }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.notices {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 40px));
}

.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  border-radius: var(--radius);
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
}

.notice span {
  flex: 1;
}

.notice.success {
  border-left: 4px solid var(--success);
}

.notice.success > .icon {
  color: var(--success);
}

.notice.error {
  border-left: 4px solid var(--danger);
}

.notice.error > .icon {
  color: var(--danger);
}

.message {
  margin: 0;
}
</style>
