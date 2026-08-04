<script setup lang="ts">
/**
 * One icon from Material Symbols (Apache-2.0, bundled — see `icons.css`).
 *
 * The font is a ligature font: the element's *text* is the icon name, and the
 * font substitutes the glyph. That is why `name` is typed against the package's
 * own union of every symbol — a typo would otherwise render as the literal word
 * `delte` rather than failing anywhere.
 *
 * Decorative by default: every icon here sits on a control that already has a
 * `title` or visible label, so the icon is hidden from screen readers rather
 * than read out as its ligature text. Pass `label` when the icon is the only
 * thing identifying the control.
 */
import type { MaterialSymbol } from '@material-symbols/font-400'

withDefaults(defineProps<{ name: MaterialSymbol; size?: number; label?: string }>(), {
  size: 18,
  label: undefined
})
</script>

<template>
  <span
    class="icon"
    :style="{ fontSize: `${size}px` }"
    :aria-hidden="label ? undefined : true"
    :aria-label="label"
    :role="label ? 'img' : undefined"
  >{{ name }}</span>
</template>

<style scoped>
.icon {
  /* Optical alignment: the glyphs sit on the text baseline, which reads low
     next to a label, and dead-centre in an icon-only button. */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  line-height: 1;
  user-select: none;
}
</style>
