<script setup lang="ts">
/**
 * "Clone repository": a URL, then the folder picker.
 *
 * This exists because **`window.prompt` throws in Electron** ("prompt() is not
 * supported"), which it does synchronously inside an async handler — so the old
 * `GitPanel.vue` button raised an unhandled rejection and did nothing at all.
 * Same reason `NewTiledScreenDialog.vue` exists; same `Modal` underneath.
 *
 * The picker stays a second step rather than a field: it is a native dialog, and
 * the clone target is the parent folder plus the repository's own name, which the
 * hint below previews from the URL as it is typed.
 */
import { computed, onMounted, ref } from 'vue'
import { repoNameFromUrl, useGitStore } from '../stores/gitStore'
import { useProjectStore } from '../stores/projectStore'
import { useToolchainStore } from '../stores/toolchainStore'
import Modal from './Modal.vue'

const gitStore = useGitStore()
const projectStore = useProjectStore()
const toolchainStore = useToolchainStore()

const url = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const field = ref<HTMLInputElement | null>(null)

const folder = computed(() => (url.value.trim() ? repoNameFromUrl(url.value) : 'repository'))

function close(): void {
  gitStore.cloneVisible = false
}

async function clone(): Promise<void> {
  const target = url.value.trim()
  if (!target || busy.value) return
  error.value = null
  const parent = await toolchainStore.pickFolder()
  // A cancelled picker is not a failure — leave the dialog open with the URL intact.
  if (!parent) return
  busy.value = true
  try {
    const ok = await gitStore.cloneRepo(target, `${parent}/${repoNameFromUrl(target)}`)
    if (!ok) {
      // The clone's own reason is already in the Output panel, which sits behind
      // this modal — say enough here that the user knows where to look.
      error.value = 'Clone failed — see the Output panel for git’s reason.'
      return
    }
    await projectStore.openProject(`${parent}/${repoNameFromUrl(target)}`)
    close()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = false
  }
}

onMounted(() => field.value?.focus())
</script>

<template>
  <Modal
    title="Clone repository"
    @close="close"
  >
    <form
      class="clone-repo"
      @submit.prevent="clone"
    >
      <label class="field">
        <span>URL</span>
        <input
          ref="field"
          v-model="url"
          type="text"
          placeholder="https://github.com/user/project.git"
          spellcheck="false"
        >
      </label>
      <p class="hint">
        You will pick a parent folder next; the clone lands in
        <code>{{ folder }}</code> inside it, and opens as the current project.
      </p>
      <p
        v-if="error"
        class="hint error"
      >
        {{ error }}
      </p>
      <div class="modal-actions">
        <button
          type="button"
          @click="close"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="primary"
          :disabled="!url.trim() || busy"
        >
          Choose folder…
        </button>
      </div>
    </form>
  </Modal>
</template>

<style scoped>
.clone-repo {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.field > span {
  flex: 0 0 3rem;
}

.field > input {
  flex: 1;
  min-width: 0;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.hint.error {
  color: var(--color-error, #f14c4c);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.4rem;
}
</style>
