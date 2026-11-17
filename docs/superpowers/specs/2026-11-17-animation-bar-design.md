# One animation bar for sprites, pattern meta-tiles and bitmap meta-tiles

Date: 2026-11-17 · Branch: `fix/ancient-horrors-bugs` (phase 2, after the bug fixes are committed)

## Intent

Pablo: "the sprites' animation UI works very well, with a preview and thumbnails of each
frame, etc. in a bottom bar… We need the same experience for animated meta-tiles as well."
Asked which meta-tiles: **both** — pattern meta-tiles (`.meta-tiles.json`, the pose editor,
which also edits animated tiles `.anim-tiles.json`) and bitmap meta-tiles
(`.meta-btiles.json`, MSX2).

Success: opening any of the three editors shows the same bottom bar, behaving the same
way, and the timing it previews is the timing the game gets.

## Today

| | Sprite editor (`editors/sprite`) | Pose editor (`editors/anim`) | Bitmap meta editor (`editors/meta`) |
|---|---|---|---|
| Bar | `SpriteAnimationBar.vue` | `AnimFrameBar.vue` | `MetaFrameBar.vue` |
| Live preview pane | yes, in the bar | **side panel** (`AnimSidePanel.vue` "Preview" + Play) | **none** — Play cycles the *editing* frame on the main canvas |
| Background toggle | checkered / solid | no | no |
| Thumbnails | yes | yes | yes (drag to reorder) |
| Per-frame duration | yes (VBlanks, saved — added on this branch) | yes (saved) | **no** — an fps box, not saved |
| Add / duplicate / delete / move | buttons | buttons | buttons + drag |
| Onion skin | yes (`SpriteCanvas.vue`) | **no** | yes (`MetaCanvas.vue:172`) |
| Loop mode | always loops | loop / ping-pong / once (side panel; `poseAtTick` in `anim/session.ts:648`) | none |
| Timing code | `tickPlayback(state, delta, durations)` in `shared/sprite-editor.ts`, `VBLANK_MS = 20` | `poseAtTick(anim, ticks)` + 20 ms `setInterval` | `setInterval(1000/fps)` |

## Goals

1. One bar component used by all three editors: preview pane (background checkered /
   solid), filmstrip of thumbnails with each frame's index and editable duration, add /
   duplicate / delete / move earlier / move later (and drag to reorder), play / pause,
   onion skin toggle.
2. One timing function, in `src/shared`, tested: given the frames' durations, a loop mode
   and elapsed time, which frame shows. Used by every preview. 20 ms per VBlank (PAL, 50 Hz),
   which is what the pose editor and the sprite editor already use.
3. Bitmap meta-tiles get a saved duration per frame, exported, so their preview means
   something in the game.
4. Pose editor gets onion skin; its preview and Play move from the side panel into the bar.

## Non-goals

- The software-sprite editor and the bitmap-tileset animation preview
  (`SwSpriteEditorTab.vue`, `BitmapTileAnimation.vue`) keep their fps boxes. Same idea could
  follow later; not asked for.
- A 50/60 Hz switch for the preview. 50 Hz everywhere, as today.
- Loop modes for sprites or bitmap meta-tiles. Only the pose editor has one, and keeps it.

## Anti-goals

- A preview that plays at a different speed or order than the game will (the reason
  durations are saved and exported, and the reason the pose editor's ping-pong/once must
  survive the move).
- Any change in what a sprite sheet, an animation or a pattern meta exports. (Bitmap metas
  gain a table — below — and nothing else changes for them either.)
- The sprite editor getting worse: it is the reference Pablo likes.

## Approaches

1. **One shared bar component for all three editors** — *chosen by Pablo.* Same experience
   by construction; a later change lands everywhere. Costs touching the sprite editor again
   and the largest diff.
2. Bring each meta bar up to the sprite bar separately — least risk per editor, but three
   copies drift (it already happened: `MetaFrameBar.vue` says it is "modelled on"
   the sprite bar and lacks durations and a preview).
3. Share the timing logic only — layout and controls could still diverge, which is what a
   user notices.

## Design

### The component
`src/renderer/src/components/AnimationBar.vue` (beside the other shared components).
It owns layout, the preview's playback loop (`requestAnimationFrame`, as the sprite bar
does), and the controls. It knows nothing about sprites, poses or tiles. The editor gives it:

- the frame count, the selected frame, the durations, the loop mode (`'loop'` when the
  editor has none);
- a way to draw frame *i* into a canvas box (the editors already have one each:
  `compositeFrame` + `drawIndices` for sprites, `posePixels` for poses, `metaThumbnail` for
  bitmap metas), and something that changes whenever the art changes so thumbnails redraw;
- `v-model`s for `playing`, `onionSkin`, `background` (session state, as in the sprite
  session today);
- and it emits: select frame, add (blank, at end), duplicate (after the selected one),
  delete, move from→to (buttons and drag), set duration of frame *i*.
- A slot for editor-specific controls that are not about animation (the bitmap editor's
  Grid toggle lives there).

Each editor's handlers are the session/shared functions it already has (sprite:
`addFrame`/`cloneFrame`/`removeFrame`/`reorderFrame`/`setFrameDuration` through `mutate`;
pose: `addFrame`/`removeFrame`/`moveFrame`/`setDuration`; bitmap: `addFrame`/`removeFrame`/
`reorderFrames` + a new `setDuration`). Every edit stays one undo step in that editor's own
history.

`SpriteAnimationBar.vue`, `AnimFrameBar.vue` and `MetaFrameBar.vue` become thin wrappers that
map their session onto the component — or go away if the tab can bind the component
directly. Builder's call.

### Timing
`src/shared/animation-playback.ts` (name is the builder's): one pure function, frame at
elapsed VBlanks for `durations` and `loop` (`loop` | `pingpong` | `once`). `poseAtTick`
already encodes the pose editor's rules (ping-pong does not repeat the end poses; once holds
the last pose) — it moves here and the sprite bar's `tickPlayback` becomes a use of it (or
is replaced by it).

Where Play starts (decided by Claude while Pablo was offline, after the builder check):
- **`loop`** (sprites, bitmap metas, a pose file set to Loop): from the selected frame, as the
  sprite bar does today — the bar starts elapsed time at the sum of the durations before the
  selected frame, so the timing function needs no start parameter.
- **`pingpong` and `once`**: always from frame 0, going forward — the order the game plays
  (`_AnimRestart` sets frame 0, tick 0, forward), and what the pose preview does today. Starting
  mid-cycle would leave ping-pong's direction undefined, and "once" with the last pose selected
  would show a still picture.

### Preview behaviour (same in all three)
Playing plays in the **preview pane only**; the main canvas stays on the frame being edited.
This is a change for the bitmap meta editor, whose Play currently steps the editing frame.
Background: checkered or solid black, as in the sprite bar; colour 0 / an empty cell shows
the background. A big meta (up to 16×16 tiles) is scaled to fit the pane.

### Pose editor specifics
- The side panel's "Preview" section and its Play button go; the bar has them. The loop
  setting and the "All" durations box stay in the side panel (they are settings of the
  file, not of the preview).
- Onion skin on `AnimCanvas.vue`: the previous pose drawn faintly under the current one, as
  `MetaCanvas.vue:172` does (alpha 0.3), beneath the see-through hatching and the float.
- New session state: `onionSkin`, `background`.

### Bitmap meta-tiles: saved durations
- `.meta-btiles.json` frames gain `duration` (VBlanks, 1..255, default 8, the same rule and
  default as sprite frames and poses — `DEFAULT_ANIM_DURATION`). Old files read as 8.
  Required in `MetaFrame`'s type so the compiler finds every place that builds a frame.
- Export (`resource.ts` `metabtiles`): a `_Durations` table, one byte per frame, **after** the
  existing frames table so `bin` offsets do not move — only when the meta has more than one
  frame. A one-frame meta exports byte-for-byte as before.
- **No new helper C** (decided by Claude while Pablo was offline, after the builder check):
  a step helper was considered and struck. The map's `_DrawPlacements(frames, …)` takes one
  frame byte **per meta slot** (`frames[slot]`, `map.ts` `bitmapPlacementHelperC` /
  `sc3PlacementHelperC`), not per copy, so a sprite-style two-byte stepper would not fill it
  directly, and per-copy timing would be a map-export change this design rules out. The
  `_Durations` table is enough for a game to time `frames[slot]`; the agent guide shows how
  (one tick counter per animated meta, advance `frames[slot]` when it reaches
  `_Durations[frames[slot]]`). Possible follow-up, not this branch.
- Session: `setDuration(session, frame, value)`; the fps box goes.
- Agent guide and `docs/resources.md` say so.

### Tests
- The timing function: loop, ping-pong (ends not repeated), once (holds last), one frame,
  zero/huge elapsed — including the cases `poseAtTick` is tested on today.
- Sessions (pose, bitmap meta): duration edits are undoable steps; onion/background state.
- `meta-tile.ts`: normalize default, round-trip, `_Durations` table and its absence for one
  frame, `bin` offsets unchanged; an existing real-MSXgl build that exports a bitmap meta
  (`meta-build.test.ts`) still links with the new table.
- The timing function: the start rule above (loop from the selected frame; ping-pong/once
  from 0).
- The `.vue` files have no vitest coverage: drive the app over CDP for each editor (play,
  pause, set a duration, onion skin, background, reorder by drag) against a scratch copy of a
  demo, and Pablo clicks through.

## Left to the builder
File names; whether the old bars become wrappers or disappear; thumbnail size and preview
pane size (fit the largest of the three); keyboard shortcuts (none today — don't add);
exact styling, matching the sprite bar.
