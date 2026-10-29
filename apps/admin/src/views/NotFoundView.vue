<script setup lang="ts">
import Icon from '../components/Icon.vue';
import PageLayout from '../components/PageLayout.vue';
</script>

<template>
  <PageLayout title="Not found">
    <div class="empty card">
      <Icon name="search" :size="32" />
      <p>There's nothing here.</p>
      <RouterLink to="/content" class="btn">Go to content</RouterLink>
    </div>
  </PageLayout>
</template>
