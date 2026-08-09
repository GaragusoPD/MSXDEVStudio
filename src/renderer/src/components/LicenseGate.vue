<script setup lang="ts">
/**
 * The startup licence gate. Shown instead of the workbench whenever the
 * accepted version in `AppState` is not the current `LICENSE_VERSION`, so
 * there is no way into the app without agreeing — declining exits.
 *
 * The full text is the LICENSE file itself, inlined at build time rather than
 * read at runtime: it is the same bytes that ship in the repository, and it
 * cannot go missing from a package. The plain-language summary above it is
 * what most people will actually read.
 */
import { onMounted, ref } from 'vue'
import licenseText from '../../../../LICENSE?raw'
import { LICENSE_SUMMARY } from '../../../shared/license'
import { useAppStore } from '../stores/appStore'

const appStore = useAppStore()
const agreed = ref(false)

// Chromium restores the previous scroll offset when the gate reappears in the
// same session — which for someone who declined means the terms open halfway
// down. A licence starts at the top.
const fullText = ref<HTMLPreElement | null>(null)
onMounted(() => fullText.value?.scrollTo(0, 0))

const SECTIONS = [
  { title: 'You may', kind: 'may', items: LICENSE_SUMMARY.may },
  { title: 'You may not', kind: 'may-not', items: LICENSE_SUMMARY.mayNot },
  { title: 'You must', kind: 'must', items: LICENSE_SUMMARY.must }
] as const
</script>

<template>
  <div class="gate">
    <div class="panel">
      <h1>MSXDEVStudio License</h1>
      <p class="lead">
        Please read and accept the license to continue. MSXDEVStudio is free to use,
        including for the commercial games you make with it.
      </p>

      <div class="columns">
        <div class="column">
          <p class="column-label">
            In short
          </p>
          <div class="summary">
            <section
              v-for="section in SECTIONS"
              :key="section.title"
              :class="section.kind"
            >
              <h2>{{ section.title }}</h2>
              <ul>
                <li
                  v-for="item in section.items"
                  :key="item"
                >
                  {{ item }}
                </li>
              </ul>
            </section>
          </div>
        </div>

        <div class="column">
          <p class="column-label">
            Full license text
          </p>
          <pre
            ref="fullText"
            class="full-text"
          >{{ licenseText }}</pre>
        </div>
      </div>

      <div class="footer">
        <label class="agree">
          <input
            v-model="agreed"
            type="checkbox"
          >
          <span>I have read and accept the license</span>
        </label>

        <div class="actions">
          <button @click="appStore.declineLicense()">
            Decline and quit
          </button>
          <button
            class="primary"
            :disabled="!agreed"
            @click="appStore.acceptLicense()"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gate {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--color-bg-editor);
  z-index: 200;
}

.panel {
  display: flex;
  flex-direction: column;
  width: min(1100px, 100%);
  height: min(760px, 100%);
  padding: 24px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-editor);
  color: var(--color-text);
}

/* Summary and full text side by side, each scrolling in its own column, over
   one shared footer. `min-height: 0` all the way down is what lets the two
   panes scroll instead of stretching the panel past the window. */
.columns {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.column {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Narrow windows can't carry two readable columns; stack them instead. */
@media (max-width: 860px) {
  .columns {
    grid-template-columns: 1fr;
  }
}

h1 {
  margin: 0;
  font-size: 18px;
}

.lead {
  margin: 8px 0 16px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.summary {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding-right: 4px;
}

.summary h2 {
  margin: 0 0 4px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.summary section {
  padding-left: 10px;
  border-left: 3px solid var(--color-border);
}

.summary .may {
  border-left-color: #4caf50;
}

.summary .may-not {
  border-left-color: #e05252;
}

.summary .must {
  border-left-color: var(--color-accent);
}

.summary ul {
  margin: 0;
  padding-left: 18px;
}

.summary li {
  font-size: 12px;
  line-height: 1.5;
}

.column-label {
  margin: 0 0 6px;
  color: var(--color-text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.full-text {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 12px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-tab-inactive);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}

.agree {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}

.actions {
  display: flex;
  gap: 8px;
}

.actions button {
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-hover);
  color: var(--color-text);
  font-size: 12px;
}

.actions button.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #ffffff;
}

.actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
