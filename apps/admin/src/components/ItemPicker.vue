<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { readPage } from '../api.ts';
import { FILES } from '../lib/schema.ts';
import { pathOf } from '../lib/system.ts';
import { displayPaths } from '../stores/model.ts';
import { notifyError } from '../stores/notify.ts';
import { primaryKeyOf } from '../stores/schema.ts';
import Icon from './Icon.vue';
import ItemLabel from './ItemLabel.vue';
import Modal from './Modal.vue';

/** Choose existing items of a collection (or files): searchable, paged. */
const props = defineProps<{ open: boolean; collection: string; multiple?: boolean; exclude?: Array<string | number> }>();
const emit = defineEmits<{ close: []; select: [items: Array<Record<string, unknown>>] }>();

const PAGE = 20;
const search = ref('');
const page = ref(1);
const items = ref<Array<Record<string, unknown>>>([]);
const total = ref(0);
const loading = ref(false);
const chosen = ref<Map<string | number, Record<string, unknown>>>(new Map());

const pk = computed(() => primaryKeyOf(props.collection));
const path = computed(() => pathOf(props.collection));
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE)));

async function load() {
  loading.value = true;
  try {
    const res = await readPage(path.value, { fields: displayPaths(props.collection), search: search.value || undefined, limit: PAGE, page: page.value });
    items.value = res.data;
    total.value = res.total;
  } catch (e) {
    notifyError(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    chosen.value = new Map();
    page.value = 1;
    void load();
  },
  { immediate: true },
);

let timer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    page.value = 1;
    void load();
  }, 250);
});

const keyOf = (item: Record<string, unknown>) => item[pk.value] as string | number;
const excluded = (item: Record<string, unknown>) => props.exclude?.includes(keyOf(item)) ?? false;

function pick(item: Record<string, unknown>) {
  if (excluded(item)) return;
  if (!props.multiple) {
    emit('select', [item]);
    return;
  }
  const next = new Map(chosen.value);
  if (next.has(keyOf(item))) next.delete(keyOf(item));
  else next.set(keyOf(item), item);
  chosen.value = next;
}

function go(delta: number) {
  page.value = Math.min(pages.value, Math.max(1, page.value + delta));
  void load();
}
</script>

<template>
  <Modal :open="open" :title="collection === FILES ? 'Choose a file' : 'Choose items'" @close="emit('close')">
    <label class="search">
      <Icon name="search" :size="18" />
      <input v-model="search" class="input" type="search" placeholder="Search…" aria-label="Search" />
    </label>
    <ul class="results" :class="{ loading }">
      <li v-for="item in items" :key="String(keyOf(item))">
        <button type="button" class="result" :class="{ chosen: chosen.has(keyOf(item)), excluded: excluded(item) }" :disabled="excluded(item)" @click="pick(item)">
          <input v-if="multiple" type="checkbox" :checked="chosen.has(keyOf(item)) || excluded(item)" tabindex="-1" aria-hidden="true" />
          <ItemLabel :collection="collection" :item="item" />
        </button>
      </li>
      <li v-if="!loading && !items.length" class="empty">Nothing found.</li>
    </ul>
    <div v-if="pages > 1" class="pager">
      <button type="button" class="icon-btn" :disabled="page <= 1" aria-label="Previous page" @click="go(-1)"><Icon name="left" /></button>
      <span class="muted">{{ page }} / {{ pages }}</span>
      <button type="button" class="icon-btn" :disabled="page >= pages" aria-label="Next page" @click="go(1)"><Icon name="right" /></button>
    </div>
    <template v-if="multiple" #footer>
      <button type="button" class="btn" @click="emit('close')">Cancel</button>
      <button type="button" class="btn primary" :disabled="!chosen.size" @click="emit('select', [...chosen.values()])">Add {{ chosen.size || '' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-subtle);
  margin-bottom: 12px;
}

.results {
  list-style: none;
  margin: 0;
  padding: 0;
  min-height: 120px;
  max-height: 50vh;
  overflow: auto;
}

.results.loading {
  opacity: 0.6;
}

.result {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.result:hover:not(:disabled),
.result.chosen {
  background: var(--primary-soft);
}

.result.excluded {
  opacity: 0.5;
  cursor: default;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 10px;
}
</style>
