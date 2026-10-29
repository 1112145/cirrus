<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { errorCode, errorMessage } from '../lib/errors.ts';
import { loadSchema } from '../stores/schema.ts';
import { login, session } from '../stores/session.ts';

const router = useRouter();
const route = useRoute();
const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    await login(email.value.trim(), password.value);
    await loadSchema();
    const target = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/content';
    await router.replace(target);
  } catch (e) {
    error.value = errorCode(e) === 'INVALID_CREDENTIALS' ? 'Wrong email or password.' : errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form class="card panel" @submit.prevent="submit">
      <div class="brand">
        <span class="logo"><Icon name="cloud" :size="26" /></span>
        <h1>{{ session.project }}</h1>
      </div>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" v-model="email" class="input" type="email" autocomplete="username" required autofocus />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" v-model="password" class="input" type="password" autocomplete="current-password" required />
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="btn primary" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
    </form>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 24px;
  background:
    radial-gradient(circle at 20% 10%, var(--primary-soft), transparent 45%),
    var(--bg);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: min(380px, 100%);
  padding: 32px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--primary);
  color: #fff;
}

.error {
  margin: 0;
  color: var(--danger);
}

.btn {
  height: 40px;
}
</style>
