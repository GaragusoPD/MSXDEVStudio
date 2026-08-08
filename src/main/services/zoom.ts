/**
 * Interface zoom — the `Ctrl +` / `Ctrl -` / `Ctrl 0` bindings.
 *
 * Electron has `zoomIn`/`zoomOut`/`resetZoom` menu roles, and the View menu
 * used them. Their *click* handlers work, but the accelerators they register
 * do not reach most keyboards: `zoomIn` defaults to `CommandOrControl+Plus`,
 * and on a US, UK or Spanish layout `+` is a shifted `=`, so pressing what
 * everyone thinks of as "Ctrl plus" produces `Ctrl+=` and matches nothing. A
 * menu item carries exactly one accelerator, so the alternates cannot be
 * expressed there either.
 *
 * So the keys are matched here instead, from the raw key event, and the menu
 * items route through the same two functions — one implementation, and the
 * accelerators in the menu stay labels (`registerAccelerator: false`) like
 * every other item in `menu.ts`. Registering them there as well would zoom
 * twice per keypress.
 */

export type ZoomAction = 'in' | 'out' | 'reset'

/**
 * Chromium's own limits are wider, but past these the interface is unusable in
 * one direction and unreadable in the other. Each step is a factor of ~1.2.
 */
export const ZOOM_MIN = -4
export const ZOOM_MAX = 5
export const ZOOM_STEP = 0.5

/** The subset of Electron's `Input` this needs, so tests need no Electron. */
export interface ZoomKeyInput {
  type: string
  key: string
  /** `code` is the physical key, which is how the numeric keypad is identified. */
  code?: string
  control: boolean
  meta: boolean
  alt: boolean
}

/**
 * The zoom action a key event asks for, or `null` if it is not a zoom binding.
 *
 * Both the main row and the keypad are accepted, and `+`/`=` are treated as the
 * same request because which one you get depends on the layout and on whether
 * Shift happened to be down. `shift` is deliberately not examined for that
 * reason. `alt` is, because `Ctrl+Alt+-` is a different gesture.
 */
export function zoomActionFor(input: ZoomKeyInput): ZoomAction | null {
  if (input.type !== 'keyDown') return null
  // `meta` covers macOS, where Command is the modifier, should it ever be built.
  if (!(input.control || input.meta) || input.alt) return null

  switch (input.code) {
    case 'NumpadAdd':
      return 'in'
    case 'NumpadSubtract':
      return 'out'
    case 'Numpad0':
      return 'reset'
  }

  switch (input.key) {
    case '+':
    case '=':
      return 'in'
    case '-':
    case '_':
      return 'out'
    case '0':
      return 'reset'
    default:
      return null
  }
}

/** The zoom level `action` moves to from `current`, clamped to the limits. */
export function nextZoomLevel(current: number, action: ZoomAction): number {
  if (action === 'reset') return 0
  const moved = action === 'in' ? current + ZOOM_STEP : current - ZOOM_STEP
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, moved))
}
