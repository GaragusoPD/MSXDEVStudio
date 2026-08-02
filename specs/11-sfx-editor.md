# Spec 11 — PSG Sound Effect Editor

**Phase:** 5 · **Depends on:** 01, 05 · **Suggested model:** Opus 5 (PSG emulation +
format fidelity), UI portions Sonnet 5

## Goal

An ayFX-style sound-effect editor: frame-by-frame AY-3-8910 envelopes with instant
audition in the app and export to the ayFX bank format MSXgl's `ayfx` driver plays.
Music is explicitly out of scope — tunes come from external trackers (Arkos etc.),
the app only stores/imports their files (Spec 03/07 handle inclusion).

## Model

An effect = a sequence of frames (played at 50/60 Hz), each frame:

- `tone`: on/off, `period` (12-bit) — edited as a pitch curve
- `noise`: on/off, `period` (5-bit)
- `volume`: 0–15

Serialized as `*.sfx.json` (list of effects, each with name + frames). Export writes
the **ayFX bank** format (`.afb`) byte-compatible with the reference ayFX player
used by MSXgl (verify against `engine/src` ayfx player sources in the MSXgl clone —
frame flags byte layout: volume bits 0–3, tone-off bit 4, noise-off bit 5,
change-tone bit 5/6 semantics must match the player exactly; write a decoder test
against a known `.afb` file from an MSXgl sample if one exists). Also import `.afx`
/ `.afb` files produced by AYFX Editor.

## Audition (in-app playback)

Minimal AY-3-8910 emulation as an `AudioWorklet` (~150 lines: square tone via
period counters, LFSR noise, 16-step volume table, no envelope generator — ayFX
doesn't use hardware envelopes). One channel is enough (effects are mono).
`// ponytail:` note the simplification in code.

## UI

- **Effect list** (left): effects in the bank, add/duplicate/delete/reorder.
- **Frame grid** (center): three stacked lanes — pitch curve (drag to draw), noise
  period lane, volume lane — over a shared frame axis. Click-drag paints values;
  right-drag erases (tone/noise off). Frame count adjustable; scrub plays.
- **Toolbar:** play (space), loop toggle, 50/60 Hz toggle, presets: laser, jump,
  explosion, pickup, hit (5 hardcoded frame sequences — good starting points).
- Live keyboard audition: press P to play current effect from frame 0.

## Acceptance

- Decoder unit test: exported bank re-parsed equals the in-memory model; an effect
  authored in AYFX Editor imports and re-exports byte-identical.
- Presets sound recognizably like their names (manual check).
- Playback timing at 50 Hz is stable (no audible jitter) on Linux and Windows.
