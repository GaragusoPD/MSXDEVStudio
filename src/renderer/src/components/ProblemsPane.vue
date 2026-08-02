<script setup lang="ts">
import { useProblemsStore, type Problem } from '../stores/problemsStore'
import { useTabsStore } from '../stores/tabsStore'

const problemsStore = useProblemsStore()
const tabsStore = useTabsStore()

function jump(problem: Problem): void {
  if (!problem.file) return
  const name = problem.file.split('/').pop() ?? problem.file
  tabsStore.openFile(problem.file, name, { line: problem.line })
}
</script>

<template>
  <div class="problems-pane">
    <p
      v-if="!problemsStore.problems.length"
      class="empty"
    >
      No problems.
    </p>
    <ul v-else>
      <li
        v-for="problem in problemsStore.problems"
        :key="problem.id"
        :class="problem.severity"
      >
        <span class="severity">{{ problem.severity }}</span>
        <span>{{ problem.message }}</span>
        <span
          v-if="problem.file"
          class="location clickable"
          @click="jump(problem)"
        >
          {{ problem.file }}<template v-if="problem.line">:{{ problem.line }}</template>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.problems-pane {
  height: 100%;
  overflow-y: auto;
  padding: 8px 12px;
  font-size: 12px;
}

.problems-pane ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.problems-pane li {
  display: flex;
  gap: 8px;
  padding: 2px 0;
}

.severity {
  text-transform: uppercase;
  font-size: 10px;
  color: var(--color-text-muted);
}

.location {
  color: var(--color-text-muted);
}

.location.clickable {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
}

.location.clickable:hover {
  color: var(--color-accent);
}

.empty {
  color: var(--color-text-muted);
}
</style>
