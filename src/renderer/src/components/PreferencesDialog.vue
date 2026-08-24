<script setup lang="ts">
/**
 * Application preferences.
 *
 * Built around a **section list** rather than one long form, because this is
 * where every future application option lands and a single scrolling page stops
 * being navigable at about a dozen controls. Adding a page is one entry in
 * `SECTIONS` and one `v-else-if` block below; the store side is one group on
 * `Preferences`.
 *
 * Project settings are deliberately elsewhere (`.msxproj`, the project settings
 * view): these are *this machine's* preferences and travel with the install,
 * not with the code.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { FontSetting, Preferences } from '../../../shared/ipc'
import { useAppStore } from '../stores/appStore'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const appStore = useAppStore()

interface Section {
  id: string
  label: string
}

const SECTIONS: Section[] = [{ id: 'appearance', label: 'Appearance' }]
const active = ref(SECTIONS[0].id)

/**
 * Installed families, asked for once when the dialog opens.
 *
 * Empty is a normal answer — a machine without `fc-list`, a locked-down
 * PowerShell — and the family control is a free-text input with suggestions, so
 * an empty list simply means no suggestions rather than a control that cannot
 * be used.
 */
const fonts = ref<string[]>([])
const loadingFonts = ref(true)

/**
 * Preferences as they were when the dialog opened.
 *
 * Edits apply and persist as they are made — that is what makes the font
 * preview the real editor rather than a mock-up — so **Cancel** means "put back
 * what I found", not "discard a pending form". A plain-data copy, because the
 * live one is a reactive proxy that would follow the edits it is meant to
 * remember.
 */
const original = JSON.parse(JSON.stringify(appStore.preferences)) as Preferences

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') cancel()
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  try {
    fonts.value = await window.api.invoke('app:listFonts', undefined)
  } finally {
    loadingFonts.value = false
  }
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** Already saved on every keystroke; this only dismisses. */
function save(): void {
  emit('close')
}

async function cancel(): Promise<void> {
  for (const group of Object.keys(original) as (keyof Preferences)[]) {
    await appStore.patchPreferences(group, original[group])
  }
  emit('close')
}

const changed = computed(() => JSON.stringify(appStore.preferences) !== JSON.stringify(original))

/** The two surfaces that carry a font today. */
const FONT_GROUPS: { group: keyof Preferences; label: string; hint: string }[] = [
  { group: 'editor', label: 'Editor', hint: 'Code editors and the diff view.' },
  { group: 'terminal', label: 'Terminal', hint: 'The integrated terminal.' }
]

const preferences = computed(() => appStore.preferences)

function setFamily(group: keyof Preferences, value: string): void {
  // Empty means "back to the theme's own", which is what `null` records — a
  // stored empty string would pin the surface to an unnamed family.
  void appStore.patchPreferences(group, { family: value.trim() || null } as Partial<FontSetting>)
}

function setSize(group: keyof Preferences, value: string): void {
  const size = Number(value)
  if (!Number.isFinite(size)) return
  void appStore.patchPreferences(group, { size: Math.max(6, Math.min(48, Math.round(size))) } as Partial<FontSetting>)
}

function reset(group: keyof Preferences): void {
  void appStore.patchPreferences(group, { family: null, size: 13 } as Partial<FontSetting>)
}
</script>

<template>
  <Modal
    title="Preferences"
    wide
    @close="cancel"
  >
    <div class="prefs">
      <nav class="sections">
        <button
          v-for="section in SECTIONS"
          :key="section.id"
          type="button"
          :class="{ active: section.id === active }"
          @click="active = section.id"
        >
          {{ section.label }}
        </button>
      </nav>

      <div class="panel">
        <template v-if="active === 'appearance'">
          <p class="hint">
            Fonts apply to open editors and terminals as you type. Leave a family blank to use the
            theme's own.
          </p>

          <section
            v-for="entry in FONT_GROUPS"
            :key="entry.group"
            class="group"
          >
            <h3>{{ entry.label }}</h3>
            <p class="hint">
              {{ entry.hint }}
            </p>
            <div class="row">
              <label class="grow">
                <span>Font family</span>
                <input
                  type="text"
                  list="installed-fonts"
                  spellcheck="false"
                  :placeholder="loadingFonts ? 'Reading installed fonts…' : 'Theme default'"
                  :value="preferences[entry.group].family ?? ''"
                  @change="setFamily(entry.group, ($event.target as HTMLInputElement).value)"
                >
              </label>
              <label>
                <span>Size</span>
                <input
                  type="number"
                  min="6"
                  max="48"
                  :value="preferences[entry.group].size"
                  @change="setSize(entry.group, ($event.target as HTMLInputElement).value)"
                >
              </label>
              <button
                type="button"
                class="reset"
                title="Back to the theme's font at 13px"
                @click="reset(entry.group)"
              >
                Reset
              </button>
            </div>
            <p
              class="preview"
              :style="{
                fontFamily: preferences[entry.group].family ?? 'var(--font-mono)',
                fontSize: `${preferences[entry.group].size}px`
              }"
            >
              for (u8 i = 0; i &lt; 8; ++i) VDP_Poke(0x1800 + i, tile);
            </p>
          </section>

          <!-- Shared by both inputs; empty when the platform cannot enumerate. -->
          <datalist id="installed-fonts">
            <option
              v-for="family in fonts"
              :key="family"
              :value="family"
            />
          </datalist>
        </template>
      </div>
    </div>

    <footer class="actions">
      <p class="saved-note">
        <template v-if="changed">
          Changes preview live and are already saved. <strong>Cancel</strong> puts back what you
          had when you opened this.
        </template>
        <template v-else>
          Saved with the application, not with the project — they follow this machine.
        </template>
      </p>
      <button
        type="button"
        @click="cancel"
      >
        Cancel
      </button>
      <button
        type="button"
        class="primary"
        @click="save"
      >
        Save
      </button>
    </footer>
  </Modal>
</template>

<style scoped>
.prefs {
  display: flex;
  gap: 16px;
  min-height: 320px;
}

.sections {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  width: 140px;
  padding-right: 12px;
  border-right: 1px solid var(--color-border);
}

.sections button {
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--color-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.sections button:hover {
  background: var(--color-bg-hover);
}

.sections button.active {
  background: var(--color-bg-active-item);
}

.panel {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.group {
  margin-bottom: 20px;
}

h3 {
  margin: 0 0 2px;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: 6px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--color-text-muted);
}

label.grow {
  flex: 1;
  min-width: 0;
}

input[type='number'] {
  width: 64px;
}

.reset {
  padding: 3px 10px;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* Shows the chosen face at the chosen size, so the choice is visible here. */
.preview {
  margin: 8px 0 0;
  padding: 8px;
  background: var(--color-bg-editor);
  border: 1px solid var(--color-border);
  border-radius: 3px;
  overflow-x: auto;
  white-space: nowrap;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}

/* Takes the slack, so the buttons stay right-aligned. */
.saved-note {
  flex: 1;
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}

.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #000;
  font-weight: 600;
}
</style>
