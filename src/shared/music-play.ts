/**
 * Playing a song the way the game does (Spec 15). Every frame the exported
 * helper runs
 *
 * ```c
 * g_Music_Decode();   // the music's own registers back, then this frame's writes
 * ayFX_Update();      // a sound effect overwrites the channel it borrows
 * PSG_Apply();        // the buffer goes to the chip
 * ```
 *
 * and `stepPlayer` is that, one frame at a time, over a song already rendered
 * to register snapshots. Because `renderSong`'s frames *are* what the lVGM
 * stream decodes to, "restore the copy, decode, save the copy" collapses to
 * "load this frame" — the tests hold that against the real stream.
 *
 * A jingle (`_PlayJingle`) is a song played once on the same player, with the
 * song it interrupted set aside — here the `SongState` fields, in the helper
 * the lVGM player's globals plus its register copy and fade — and put back the
 * frame the jingle ends, which decodes the song's next frame at once.
 *
 * Pure and DOM-free: the editor's audio streams chunks of `stepPlayer` output
 * through `psg.ts`, and Vitest drives the same code.
 */

import { R_MIXER, R_NOISE, R_VOLUME, silentRegisters, type PsgRegisters } from './msx/music'
import type { SfxFrame } from './msx/sfx'

/**
 * One `ayFX_Update` call's writes into the register buffer, from
 * `engine/src/ayfx/ayfx_player.c`:
 *
 *  - volume 0 → `ret z` before anything is written;
 *  - noise on → R#6 (bit 7 of the control byte clear);
 *  - tone and noise both off → `cp #0x90; ret z`, nothing more;
 *  - the channel's two mixer bits are cleared (`and d`) and set again from the
 *    frame (`or c`), then its volume, then its tone — only when tone is on.
 *
 * `channel` is 0–2 for A–C, as `ayFX_SetChannel(PSG_CHANNEL_A…C)` takes it.
 */
export function ayfxUpdate(regs: Uint8Array, channel: number, frame: SfxFrame): void {
  if (frame.volume === 0) return
  if (frame.noiseOn) regs[R_NOISE] = frame.noise
  if (!frame.toneOn && !frame.noiseOn) return
  const toneBit = 1 << channel
  const noiseBit = 8 << channel
  regs[R_MIXER] = (regs[R_MIXER] & ~(toneBit | noiseBit)) | (frame.toneOn ? 0 : toneBit) | (frame.noiseOn ? 0 : noiseBit)
  regs[R_VOLUME + channel] = frame.volume
  if (frame.toneOn) {
    regs[channel * 2] = frame.tone & 0xff
    regs[channel * 2 + 1] = (frame.tone >> 8) & 0xff
  }
}

/**
 * The end-of-stream marker runs `ayFX_Finish`, which is `ayFX_Mute` unless the
 * game changed it: the effect's channel goes to volume 0 *for that frame* —
 * the music's own volume only comes back on the next one.
 */
export function ayfxMute(regs: Uint8Array, channel: number): void {
  regs[R_VOLUME + channel] = 0
}

/** Where a song is: what a jingle sets aside and puts back. */
export interface SongState {
  /** The song, rendered. Replaced in place while playing when the song is edited. */
  frames: PsgRegisters[]
  loopFrame: number
  loop: boolean
  /** The next song frame `stepPlayer` decodes. */
  position: number
  playing: boolean
  /** The helper's fade-out: frames per step (0 = none), its countdown, the steps taken. */
  fade: { speed: number; timer: number; level: number }
}

export interface MusicPlayer extends SongState {
  /**
   * Non-null while a jingle plays — the `SongState` fields are then the
   * jingle's — holding the song it interrupted, or null when none was playing.
   */
  jingle: { held: SongState | null } | null
  /** `g_PSG_Regs`. */
  regs: Uint8Array
  effect: { frames: readonly SfxFrame[]; index: number } | null
  /** `ayFX_Priority`: the sounding effect's, 0 the most important — 0xFF when none is. */
  effectPriority: number
  /** Where effects play, 0–2. ayFX's own default is C. */
  effectChannel: number
}

export function createMusicPlayer(frames: PsgRegisters[], options: { loopFrame: number; loop: boolean; start?: number; effectChannel?: number }): MusicPlayer {
  return {
    frames,
    loopFrame: options.loopFrame,
    loop: options.loop,
    position: Math.min(Math.max(0, options.start ?? 0), Math.max(0, frames.length - 1)),
    playing: frames.length > 0,
    jingle: null,
    regs: silentRegisters(),
    effect: null,
    effectPriority: 0xff,
    effectChannel: options.effectChannel ?? 2,
    fade: { speed: 0, timer: 0, level: 0 }
  }
}

/**
 * `ayFX_PlayBank`: the effect starts on the next `ayFX_Update` unless one that
 * matters more is sounding (`cp c; jr c` — a lower number wins, equal
 * replaces). Returns ayFX's code: 0 played, 1 refused.
 */
export function playEffect(player: MusicPlayer, frames: readonly SfxFrame[], priority = 0): number {
  if (player.effectPriority < priority) return 1
  player.effect = frames.length ? { frames, index: 0 } : null
  player.effectPriority = frames.length ? priority & 0x0f : 0xff
  return 0
}

/** `_Stop()` of the effects helper: `ayFX_Mute`, when something is playing — the channel's volume goes to 0 in the buffer. */
export function stopEffect(player: MusicPlayer): void {
  if (player.effectPriority & 0x80) return
  ayfxMute(player.regs, player.effectChannel)
  player.effect = null
  player.effectPriority = 0xff
}

/**
 * `_FadeOut(speed)`: a volume step every `speed` frames, and the song stops at
 * the fifteenth. During a jingle it fades the jingle, and the end of the fade
 * is `_Stop` — the held song goes with it.
 */
export function fadeOut(player: MusicPlayer, speed: number): void {
  const frames = Math.max(1, speed)
  player.fade = { speed: frames, timer: frames, level: 0 }
}

/**
 * `_PlayJingle(jingle)`: `frames` play once, from the next frame, and the song
 * carries on afterwards from where it stopped — fade and all. A jingle over a
 * jingle replaces it and keeps the song held by the first.
 */
export function playJingle(player: MusicPlayer, frames: PsgRegisters[]): void {
  if (!player.jingle) {
    const { frames: song, loopFrame, loop, position, playing, fade } = player
    player.jingle = { held: playing ? { frames: song, loopFrame, loop, position, playing, fade: { ...fade } } : null }
  }
  player.frames = frames
  player.loopFrame = 0
  player.loop = false
  player.position = 0
  player.playing = frames.length > 0
  player.fade = { speed: 0, timer: 0, level: 0 }
}

/** The song the editor is editing: the one under a jingle while one plays, or null when there is none. */
export function songState(player: MusicPlayer): SongState | null {
  return player.jingle ? player.jingle.held : player
}

/** Swaps in a re-rendered song without losing the place — what makes editing while it loops audible. Reaches under a jingle. */
export function replaceSong(player: MusicPlayer, frames: PsgRegisters[], loopFrame: number, loop?: boolean): void {
  const song = songState(player)
  if (!song) return
  if (loop !== undefined) song.loop = loop
  song.frames = frames
  song.loopFrame = Math.min(loopFrame, Math.max(0, frames.length - 1))
  if (song.position > frames.length) song.position = song.loop ? song.loopFrame : frames.length
}

export interface PlayerFrame {
  /** What `PSG_Apply` writes this frame. */
  regs: PsgRegisters
  /** The song frame that was decoded, or -1 when the song has stopped or a jingle is playing over it. */
  songFrame: number
}

/** The helper's fade, after the song's registers are in and before the effect. */
function applyFade(player: MusicPlayer): void {
  const fade = player.fade
  if (!fade.speed) return
  if (--fade.timer === 0) {
    fade.timer = fade.speed
    if (++fade.level === 15) {
      // _Stop: LVGM_Stop → PSG_Mute, and a jingle's held song is dropped.
      fade.speed = 0
      player.playing = false
      player.jingle = null
      for (let channel = 0; channel < 3; channel++) player.regs[R_VOLUME + channel] = 0
      return
    }
  }
  for (let channel = 0; channel < 3; channel++) {
    const volume = player.regs[R_VOLUME + channel] & 0x0f
    player.regs[R_VOLUME + channel] = volume > fade.level ? volume - fade.level : 0
  }
}

/** The jingle hit its end: the song comes back, to be decoded in the same frame. */
function endJingle(player: MusicPlayer): void {
  const held = player.jingle?.held
  player.jingle = null
  if (held) Object.assign(player, held)
}

/** One frame of the helper: music, then the effect on top, then out. */
export function stepPlayer(player: MusicPlayer): PlayerFrame {
  let songFrame = -1
  if (player.playing && player.position >= player.frames.length) {
    if (player.loop && player.frames.length) player.position = player.loopFrame
    else {
      // LVGM_Stop → PSG_Mute, and g_Music_Decode stops restoring.
      player.playing = false
      for (let channel = 0; channel < 3; channel++) player.regs[R_VOLUME + channel] = 0
      if (player.jingle) endJingle(player)
    }
  }
  if (player.playing) {
    songFrame = player.jingle ? -1 : player.position
    // R#13 is never restored by the helper; the music never writes it anyway.
    player.regs.set(player.frames[player.position].subarray(0, 13))
    player.position++
    applyFade(player)
    if (!player.playing) songFrame = -1
  }
  const effect = player.effect
  if (effect) {
    if (effect.index < effect.frames.length) ayfxUpdate(player.regs, player.effectChannel, effect.frames[effect.index++])
    else {
      ayfxMute(player.regs, player.effectChannel)
      player.effect = null
      player.effectPriority = 0xff
    }
  }
  return { regs: player.regs.slice(), songFrame }
}
