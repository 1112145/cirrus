<script setup lang="ts">
import { useRoute } from 'vue-router';
import ItemEditor from '../components/ItemEditor.vue';

/** /content/:collection/:id — an item's form (`+` creates one). */
const route = useRoute();
</script>

<template>
  <ItemEditor :collection="String(route.params.collection)" :id="String(route.params.id)" />
</template>
