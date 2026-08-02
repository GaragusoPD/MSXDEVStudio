<template>
  <aside class="side-panel">
    <router-view />
  </aside>
</template>

<style scoped>
.side-panel {
  background: var(--color-bg-sidebar);
  overflow-y: auto;
  min-width: 0;
}
</style>
