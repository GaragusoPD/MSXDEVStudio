<script setup lang="ts">
/**
 * "New tiled screen": one name, one button. Opened from File ▸ New Tiled
 * Screen… and from the Resources panel through `resourcesStore.newScreenVisible`,
 * and mounted in `App.vue` so the menu reaches it from any view.
 *
 * Holds nothing but the field: `createTiledScreen` (`commands.ts`) writes the
 * pair, opens the map and enters paint mode. Its failure — the name is taken,
 * a write fails — stays here beside the field, where the user can change the
 * name and try again, rather than going to the Output panel behind the dialog.
 */
import { onMounted, ref } from 'vue'
import { RESOURCE_DIR } from '../../../shared/msx/resource'
import { createTiledScreen } from '../commands'
import { useResourcesStore } from '../stores/resourcesStore'
import Modal from './Modal.vue'

const resourcesStore = useResourcesStore()
const name = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const field = ref<HTMLInputElement | null>(null)

/** The file stem the name becomes — the same reduction the Resources panel applies. */
const stem = (): string => name.value.replace(/[^A-Za-z0-9_-]/g, '')

function close(): void {
  resourcesStore.newScreenVisible = false
}

async function create(): Promise<void> {
  if (!stem() || busy.value) return
  busy.value = true
  error.value = null
  try {
    await createTiledScreen(name.value)
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
    title="New tiled screen"
    @close="close"
  >
    <form
      class="new-screen"
      @submit.prevent="create"
    >
      <p class="hint">
        A SCREEN 2 tileset and a 32×24 map over it, opened ready to paint. Pixels you draw
        become tiles in the tileset; the map places them.
      </p>
      <label class="field">
        <span>Name</span>
        <input
          ref="field"
          v-model="name"
          type="text"
          placeholder="title"
          spellcheck="false"
        >
      </label>
      <p class="hint">
        Creates <code>{{ RESOURCE_DIR }}/{{ stem() || 'name' }}.tiles.json</code> and
        <code>{{ RESOURCE_DIR }}/{{ stem() || 'name' }}.map.json</code>.
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
          :disabled="!stem() || busy"
        >
          Create
        </button>
      </div>
    </form>
  </Modal>
</template>

<style scoped>
.new-screen {
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
  flex: 0 0 6.5rem;
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
