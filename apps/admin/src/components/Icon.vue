<script setup lang="ts">
/** Line icons (24×24, drawn with the current color). */
defineProps<{ name: keyof typeof ICONS; size?: number }>();
</script>

<script lang="ts">
export const ICONS = {
  box: ['M21 8 12 3 3 8v8l9 5 9-5V8z', 'M3 8l9 5 9-5M12 13v8'],
  image: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 21'],
  database: ['M12 8c5 0 9-1.3 9-3s-4-3-9-3-9 1.3-9 3 4 3 9 3z', 'M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5', 'M3 12c0 1.7 4 3 9 3s9-1.3 9-3'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  plus: ['M12 5v14M5 12h14'],
  x: ['M6 6l12 12M18 6 6 18'],
  check: ['M5 12l5 5L20 7'],
  trash: ['M4 7h16M10 11v6M14 11v6', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4'],
  left: ['M15 18l-6-6 6-6'],
  right: ['M9 18l6-6-6-6'],
  down: ['M6 9l6 6 6-6'],
  up: ['M18 15l-6-6-6 6'],
  back: ['M19 12H5M12 19l-7-7 7-7'],
  upload: ['M12 16V4M7 9l5-5 5 5M4 20h16'],
  download: ['M12 4v12M7 11l5 5 5-5M4 20h16'],
  logout: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  replace: ['M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'],
  cloud: ['M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9.3 4.4 4.4 0 0 1 17.5 18z'],
  sliders: ['M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1', 'M15 4v4M9 10v4M17 16v4'],
  arrowUp: ['M12 19V5M5 12l7-7 7 7'],
  arrowDown: ['M12 5v14M19 12l-7 7-7-7'],
  external: ['M14 4h6v6M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  list: ['M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1'],
  grid: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  relation: ['M7 7h4a4 4 0 0 1 4 4v2a4 4 0 0 0 4 4h1', 'M4 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0zM17 17a3 3 0 1 0 6 0 3 3 0 0 0-6 0'],
  users: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4.5-6.5'],
  shield: ['M12 3l8 3v6c0 4.8-3.4 8.3-8 9-4.6-.7-8-4.2-8-9V6z'],
  key: ['M7.5 20a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M10 14l10-10M16 8l3 3M18.5 5.5l2 2'],
  lock: ['M6 11h12v10H6z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z'],
  minus: ['M5 12h14'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
} as const;
</script>

<template>
  <svg
    :width="size ?? 20"
    :height="size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="icon"
  >
    <path v-for="(d, i) in ICONS[name]" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.icon {
  flex: none;
}
</style>
