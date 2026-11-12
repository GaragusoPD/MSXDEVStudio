<script setup lang="ts">
/**
 * Spec 17: messages an agent sent the user through the MCP server's
 * `show_message` — what it did, or what it needs. Bottom-right, over the
 * editor, a few at a time; info and warnings fade, errors stay until closed.
 */
import { useMcpStore } from '../stores/mcpStore'
import Icon from './Icon.vue'

const mcpStore = useMcpStore()
const ICONS = { info: 'smart_toy', warning: 'warning', error: 'error' } as const
</script>

<template>
  <div
    v-if="mcpStore.messages.length"
    class="agent-messages"
    role="status"
    aria-live="polite"
  >
    <div
      v-for="message in mcpStore.messages"
      :key="message.id"
      class="message"
      :class="message.level"
    >
      <Icon :name="ICONS[message.level]" />
      <span class="text">{{ message.text }}</span>
      <button
        type="button"
        title="Dismiss"
        @click="mcpStore.dismiss(message.id)"
      >
        <Icon name="close" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.agent-messages {
  position: fixed;
  right: 16px;
  bottom: 36px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 380px;
}

.message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent);
  border-radius: 4px;
  background: var(--color-bg-panel, var(--color-bg-tab-inactive));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  line-height: 1.4;
}

.message.warning {
  border-left-color: #cca700;
}

.message.error {
  border-left-color: var(--color-error, #f14c4c);
}

.text {
  flex: 1;
  white-space: pre-wrap;
}

button {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-muted);
}
</style>
