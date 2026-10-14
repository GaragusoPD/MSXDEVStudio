/** What the piano roll reports about the pointer: grid pixels, and the row and pitch under them. */
export interface RollPointer {
  x: number
  y: number
  row: number
  pitch: number
}

/** One colour per channel — the piano roll's notes and the toolbar's channel buttons agree. */
export const CHANNEL_COLORS = ['#4fc1ff', '#89d185', '#e8a33c'] as const
