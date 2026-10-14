# Spec 15 — PSG music editor

**Phase:** 7 · **Depends on:** 07, 11 · **Suggested model:** Opus 5

## Goal

Background music for the PSG that a non-musician can make: a **piano roll** over
the three channels, ready-made **instruments** and **beats**, instant playback in
the IDE — and the game plays it *with* the ayFX sound effects from Spec 11, the way
Konami's MSX games do (music on three channels, an effect borrowing one channel and
handing it back).

Short loops are the target (a few seconds to a minute). Long through-composed
tracks are out of scope: they belong in a tracker.

## Format decision: lVGM, not PT3

The export is **lVGM** (MSXgl's `vgm/lvgm_player`, format in
`engine/src/vgm/lvgm.txt`): a frame-by-frame stream of PSG register writes.

- **What the IDE plays is what the MSX plays.** The editor renders the song to one
  set of PSG registers per frame; the same frames feed the in-app audio and the
  encoder. PT3 would mean re-implementing Vortex Tracker's player in TypeScript and
  keeping it bit-identical to the Z80 one.
- **Instruments are free-form** (per-frame volume / pitch / noise steps, like an
  ayFX effect), not bound to PT3's sample/ornament model.
- **Size is fine for loops.** Real Konami PSG tunes measure 77–139 bytes/second as
  lVGM (`projects/samples/content/lvgm/*.lvm`): an 8-second loop is about 1 KB.
  Busy drums cost more — a kick rewrites its pitch every frame — so the demo's
  6.4 seconds of 16th-note beat come to ~1.5 KB. The editor shows the exported
  size live.
- **Cost:** lVGM only writes registers that *change*. See "Sound effects" below for
  why that matters and how the helper handles it.

## Model — `*.music.json`, a music bank

One file holds every tune of a game plus the instruments they share, the way an
`.sfx.json` holds every effect.

```ts
interface MusicDoc {
  version: 1
  rate: 50 | 60               // frames per second the songs are authored at
  instruments: Instrument[]   // shared by every song in the bank (max 64)
  songs: Song[]               // max 32
  export: ExportBlock | null
}
interface Instrument {
  name: string
  steps: InstrumentStep[]     // one per frame from note-on (1–64)
  loop: number | null         // step the sustain repeats from; null = hold the last step
}
interface InstrumentStep {
  volume: number              // 0–15
  semitones: number           // −48…+48, added to the note (arpeggios, drum drops)
  cents: number               // −100…+100 (vibrato)
  tone: boolean               // square wave on
  noise: number | null        // noise period 0–31, null = noise off
}
interface Song {
  name: string                // C identifier part: g_Music_<Name>
  bars: number                // 1–64; a bar is 16 rows (4 beats of 16th notes)
  speed: number               // frames per row, 1–31 (tempo = rate·60 / (speed·4) BPM)
  loopBar: number             // where a looping song jumps back to (0 = the top)
  channels: [Note[], Note[], Note[]]   // A, B, C — each is monophonic
}
interface Note {
  row: number; length: number // in rows
  pitch: number               // MIDI note, 24 (C1) … 107 (B7)
  instrument: number          // index into instruments
  volume: number              // 0–15, scales the instrument (15 = as designed)
}
```

A channel plays one note at a time: drawing a note over another on the same
channel trims or removes the old one. A new bank starts with the preset
instruments and a short demo song, so there is sound on the first Play.

## Rendering (shared, pure)

`renderSong(doc, song) → frames` — one 14-register snapshot per frame:

- A note sounds from `row·speed` for `length·speed` frames; at frame *k* of the note
  the instrument step is `k`, wrapped into `[loop, steps)` past the end (or held on
  the last step when `loop` is null). Past its length the channel is silent.
- Period = `round(clock / (16·f))`, `f` from the note + `semitones` + `cents/100`
  (A4 = 440 Hz, equal temperament), clamped to 1…4095.
- Volume = `ceil(step.volume · note.volume / 15)` (0 stays 0).
- **Noise is one generator for three channels.** When several channels want it in
  the same frame, the loudest wins its period; ties go to the later channel.
- A silent channel keeps its previous tone and mixer bits — they are inaudible and
  rewriting them would cost bytes.
- Envelope registers 11–13 are never used.

## lVGM encoding

- Header `lVGM`, options (bit 0 = 50 Hz, bit 1 = loop included), the "most common
  byte" (picked from the two-byte writes R#0/2/4/7, which `Dx` then shortens to one
  byte).
- Frame 0 writes R#0–R#10 in full (no assumed PSG state). Each later frame writes
  only what changed, then `En` waits (runs of unchanged frames merge, 16 max).
- **The loop point is a keyframe**: it writes every register that differs from
  *either* frame that can precede it — the one before it on the first pass, or the
  song's last frame when it loops.
- **`FE F0` at the loop point, not `FE`.** `LVGM_Decode` jumps to the byte after
  `FE` and then increments past it (`g_LVGM_Pointer = g_LVGM_LoopAddr; break;` →
  `g_LVGM_Pointer++`), so on every repeat it skips one byte. `F0` ("PSG chunk") is
  a one-byte no-op, so skipping it or running it are the same; a register write
  there would desync the stream. Works with a fixed player too.
- `FF` ends the stream.

`decodeLvgm`/`simulateLvgm` replay a stream exactly as `LVGM_Decode` does
(including that skip); tests hold the encoder to them over two passes of a loop.

## Sound effects with music

ayFX overwrites one channel in `g_PSG_Regs` every frame of an effect
(`AYFX_BUFFER_DEFAULT`), and `PSG_Apply()` writes the buffer out. With PT3 that is
harmless because PT3 rewrites every register every frame. lVGM does not, so after
the effect the channel would keep the effect's pitch and mixer until the music
happened to change them. The helper keeps the music's own R#0–R#12 apart:

```c
void g_Music_Decode(void)            // once per frame
{
	if (!LVGM_IsPlaying()) return;
	Mem_Copy(g_Music_Regs, &g_PSG_Regs, 13);   // drop last frame's effect
	LVGM_Decode();
	Mem_Copy(&g_PSG_Regs, g_Music_Regs, 13);   // remember the music alone
}
// per frame, in this order:
g_Music_Decode(); ayFX_Update(); PSG_Apply();
```

R#13 is left out on purpose: `PSG_Apply` writes R#13 only when bit 7 is clear and
then sets it, and restoring it every frame would retrigger the envelope.

The editor's audition mixes effects in with the same rules (`ayFX_Update`'s
register writes, ported in `shared/music-play.ts`), so a clash heard in the IDE is
the clash the game has. Channel C is the default effect channel (ayFX's own
default), and the demo song keeps its drums there — drums dropping out for an
explosion is the least noticeable loss.

## Export

- Tables: one per song, `g_Music_<Song>` (the bank's export name + `_` + the song
  name in PascalCase). Constants: `_FRAMES`, `_LOOP_FRAME` per song.
- The bank can name the `.sfx.json` the game plays over it (`MusicDoc.effects`,
  the editor's *Sound effects* picker). The editor auditions that bank's effects,
  and the helper's `_Update()` runs `ayFX_Update()` only when one is named — a game
  without effects must not need the ayFX module.
- Helpers (opt-in, `ExportBlock.helpers`): `g_Music_Play(song, loop)`,
  `g_Music_Stop()`, `g_Music_Pause()`, `g_Music_Resume()`, `g_Music_IsPlaying()`,
  `g_Music_FadeOut(speed)`, `g_Music_Update()` (decode → effects → `PSG_Apply`) and
  `g_Music_Decode()` for a game that orders the frame itself.
- The fade attenuates `g_PSG_Regs` **after** the register copy is saved, so the
  copy keeps the song's own volumes; fifteen steps, one per `speed` frames, then
  `LVGM_Stop`. `_Play` resets it — RAM is not cleared at boot.
- The SFX bank's side (Spec 11, extended here): a define per effect
  (`G_SFX_JUMP`, always emitted; a colliding name gets its index appended), a
  per-effect **priority** (0–15, 0 the most important — ayFX's own scale; absent =
  8) and a bank **channel** (absent = C). Helpers: `_Init()` (bank, fixed mode,
  channel, nothing playing), `_Play(id)` at the effect's priority,
  `_PlayPriority(id, p)`, `_Stop()`, `_IsPlaying()`, and `_Update()` for a game
  with no music.
- Needs LibModules `psg`, `vgm/lvgm_player` (+ `ayfx/ayfx_player` for effects), and
  in `msxgl_config.h`: `LVGM_USE_MSXMUSIC`/`MSXAUDIO`/`SCC` FALSE (the template turns
  them on, which links modules a PSG game doesn't have) and `AYFX_BUFFER
  AYFX_BUFFER_DEFAULT` (the template's `AYFX_BUFFER_PT3` points ayFX at PT3's
  buffer, and the link fails on `_PT3_Regs`). The editor has a **Set up project**
  button that applies all of this; `agent-guide.ts` documents it.
- 50/60 Hz: the player does not compensate (it decodes one frame per call). A song
  authored at 60 Hz runs 5/6 speed on a 50 Hz machine. ponytail: tempo
  compensation (skip/double a decode) is a helper-only change if it is ever wanted.

## Editor

- **Left:** the bank's songs (add, duplicate, delete, rename) and instruments
  (pick the drawing instrument, add a preset, rename, delete when unused).
- **Toolbar:** Play/Stop (Space), Loop, Bars, Speed (shows BPM), Loop bar, 50/60 Hz,
  the channel being drawn (A/B/C) with mute toggles, **Beat** (fills a channel with a
  ready-made drum pattern), the effects bank and channel for audition, size.
- **Piano roll:** pitch rows with a keyboard down the side, bars and beats across.
  Drag to draw a note with the current instrument; drag a note to move it, its
  right edge to resize; right-click or Delete removes it. Other channels show
  dimmed. A playhead follows playback; clicking the ruler moves the start point.
- **Live:** edits made while the loop plays are heard on the next audio chunk.
- **Audition with effects:** keys 1–9 fire the bank's first nine effects on the
  chosen channel while the song plays.

Audio streams short chunks rendered by the shared PSG model (`psg.ts`, extended to
three channels and a shared noise generator) and scheduled back to back on
`AudioBufferSourceNode`s — no AudioWorklet, so no worker bundling.

## Presets

Instruments: lead, soft lead, bass, pluck, major chord, minor chord, pad, kick,
snare, closed hat, open hat, tom. Beats (one bar, repeated over the song): rock,
disco, march, gallop, shuffle, half-time, hats only.

## Acceptance

- Encoder round-trip: `simulateLvgm` of an exported song reproduces `renderSong`'s
  frames for two passes of the loop, including through the loop-point skip.
- A song with a held note and an effect on its channel: the simulated per-frame
  helper (restore → decode → save → ayFX → apply) gives the music's registers back
  the frame after the effect ends.
- Built against the real engine and booted in openMSX: the PSG registers logged per
  frame match the render — through the helpers too: priorities, `_Stop`, a fade to
  silence and a song started after it.
- Every helper combination links against the real engine: music with effects,
  effects alone, music alone without the ayFX module (`music-build.test.ts`).
- The demo song plays on first open; editing while it loops is heard.
