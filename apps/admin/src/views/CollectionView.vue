<script setup lang="ts">
import { deleteItems } from '@directus/sdk';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readPage, request } from '../api.ts';
import CellValue from '../components/CellValue.vue';
import ContentNav from '../components/ContentNav.vue';
import Icon from '../components/Icon.vue';
import ItemEditor from '../components/ItemEditor.vue';
import PageLayout from '../components/PageLayout.vue';
import { valueAt } from '../lib/display.ts';
import { titleOf } from '../lib/schema.ts';
import { columnPaths, listColumns } from '../stores/model.ts';
import { confirm, notify, notifyError } from '../stores/notify.ts';
import { can, collectionOf, primaryKeyOf } from '../stores/schema.ts';

/** A collection's items: a table with search, sorting and paging (or a singleton's form). */
const route = useRoute();
const router = useRouter();

const PAGE = 25;
const name = computed(() => String(route.params.collection));
const collection = computed(() => collectionOf(name.value));
const singleton = computed(() => collection.value?.meta?.singleton === true);
const columns = computed(() => listColumns(name.value));
const pk = computed(() => primaryKeyOf(name.value));

const search = ref('');
const sort = ref<string | null>(null);
const page = ref(1);
const items = ref<Array<Record<string, unknown>>>([]);
const total = ref(0);
const loading = ref(false);
const selected = ref<Set<string | number>>(new Set());
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE)));

async function load() {
  if (!collection.value || singleton.value || !can(name.value, 'read')) return;
  loading.value = true;
  try {
    const res = await readPage(`/items/${name.value}`, {
      fields: columnPaths(name.value, columns.value),
      search: search.value || undefined,
      sort: sort.value ?? undefined,
      limit: PAGE,
      page: page.value,
    });
    items.value = res.data;
    total.value = res.total;
    selected.value = new Set();
  } catch (e) {
    notifyError(e);
  } finally {
    loading.value = false;
  }
}

watch(
  name,
  () => {
    search.value = '';
    sort.value = null;
    page.value = 1;
    items.value = [];
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

function sortBy(field: string) {
  sort.value = sort.value === field ? `-${field}` : sort.value === `-${field}` ? null : field;
  page.value = 1;
  void load();
}

function go(delta: number) {
  page.value = Math.min(pages.value, Math.max(1, page.value + delta));
  void load();
}

const keyOf = (item: Record<string, unknown>) => item[pk.value] as string | number;

function toggle(item: Record<string, unknown>) {
  const next = new Set(selected.value);
  if (next.has(keyOf(item))) next.delete(keyOf(item));
  else next.add(keyOf(item));
  selected.value = next;
}

const allSelected = computed(() => items.value.length > 0 && items.value.every((i) => selected.value.has(keyOf(i))));
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(items.value.map(keyOf));
}

async function removeSelected() {
  const keys = [...selected.value] as string[];
  if (!(await confirm(`Delete ${keys.length} item${keys.length === 1 ? '' : 's'}? This can't be undone.`, { action: 'Delete', danger: true }))) return;
  try {
    await request(deleteItems(name.value, keys));
    notify(`Deleted ${keys.length} item${keys.length === 1 ? '' : 's'}.`);
    await load();
  } catch (e) {
    notifyError(e);
  }
}

const range = computed(() => (total.value === 0 ? '0' : `${(page.value - 1) * PAGE + 1}–${Math.min(page.value * PAGE, total.value)}`));
</script>

<template>
  <ItemEditor v-if="collection && singleton" :collection="name" :id="null" />
  <PageLayout v-else :title="collection ? titleOf(name) : 'Not found'" :subtitle="collection?.meta?.note ?? undefined">
    <template #nav><ContentNav :active="name" /></template>
    <template v-if="collection" #actions>
      <label class="search">
        <Icon name="search" :size="18" />
        <input v-model="search" class="input" type="search" placeholder="Search…" aria-label="Search items" />
      </label>
      <button v-if="selected.size && can(name, 'delete')" type="button" class="btn danger" @click="removeSelected">
        <Icon name="trash" :size="18" />Delete {{ selected.size }}
      </button>
      <RouterLink v-if="can(name, 'create')" :to="`/content/${name}/+`" class="btn primary"><Icon name="plus" :size="18" />Create item</RouterLink>
    </template>

    <div v-if="!collection" class="empty card">
      <p>This collection doesn't exist, or you may not read it.</p>
      <RouterLink to="/content" class="btn">Back to content</RouterLink>
    </div>
    <div v-else class="card">
      <div class="table-wrap">
        <table class="table" :class="{ loading }">
          <thead>
            <tr>
              <th class="check"><input type="checkbox" :checked="allSelected" aria-label="Select all" @change="toggleAll" /></th>
              <th v-for="f in columns" :key="f.field">
                <button type="button" @click="sortBy(f.field)">
                  {{ titleOf(f.field) }}
                  <Icon v-if="sort === f.field" name="arrowUp" :size="14" />
                  <Icon v-else-if="sort === `-${f.field}`" name="arrowDown" :size="14" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="String(keyOf(item))" @click="router.push(`/content/${name}/${keyOf(item)}`)">
              <td class="check" @click.stop><input type="checkbox" :checked="selected.has(keyOf(item))" aria-label="Select" @change="toggle(item)" /></td>
              <td v-for="f in columns" :key="f.field"><CellValue :field="f" :value="valueAt(item, f.field)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!loading && !items.length" class="empty">
        <p>{{ search ? 'No items match your search.' : 'No items yet.' }}</p>
        <RouterLink v-if="!search && can(name, 'create')" :to="`/content/${name}/+`" class="btn primary">Create the first item</RouterLink>
      </div>
      <div class="pagination">
        <span>{{ range }} of {{ total }}</span>
        <span class="spacer" />
        <button type="button" class="icon-btn" :disabled="page <= 1" aria-label="Previous page" @click="go(-1)"><Icon name="left" /></button>
        <span>{{ page }} / {{ pages }}</span>
        <button type="button" class="icon-btn" :disabled="page >= pages" aria-label="Next page" @click="go(1)"><Icon name="right" /></button>
      </div>
    </div>
  </PageLayout>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-subtle);
}

.search .input {
  width: 220px;
}

table.loading {
  opacity: 0.6;
}
</style>
