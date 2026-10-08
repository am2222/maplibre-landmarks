<script setup lang="ts">
import { withBase } from 'vitepress';

const props = defineProps<{ src: string; title: string }>();
const url = withBase(props.src);
</script>

<template>
  <div class="demo-frame">
    <iframe :src="url" :title="title" loading="lazy" allow="fullscreen"></iframe>
    <a :href="url" target="_blank" rel="noopener">Open full screen ↗</a>
  </div>
</template>

<style scoped>
.demo-frame {
  margin: 16px 0 24px;
}
.demo-frame iframe {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
.demo-frame a {
  display: inline-block;
  margin-top: 6px;
  font-size: 14px;
}
</style>
