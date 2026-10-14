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

export interface MusicPlayer {
  /** The song, rendered. Replaced in place while playing when the song is edited. */
  frames: PsgRegisters[]
  loopFrame: number
  loop: boolean
  /** The next song frame `stepPlayer` decodes. */
  position: number
  playing: boolean
  /** `g_PSG_Regs`. */
  regs: Uint8Array
  effect: { frames: readonly SfxFrame[]; index: number } | null
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
    regs: silentRegisters(),
    effect: null,
    effectChannel: options.effectChannel ?? 2
  }
}

/** `ayFX_PlayBank`: an effect of equal priority replaces the one playing, and starts on the next frame. */
export function playEffect(player: MusicPlayer, frames: readonly SfxFrame[]): void {
  player.effect = frames.length ? { frames, index: 0 } : null
}

/** Swaps in a re-rendered song without losing the place — what makes editing while it loops audible. */
export function replaceSong(player: MusicPlayer, frames: PsgRegisters[], loopFrame: number): void {
  player.frames = frames
  player.loopFrame = Math.min(loopFrame, Math.max(0, frames.length - 1))
  if (player.position > frames.length) player.position = player.loop ? player.loopFrame : frames.length
}

export interface PlayerFrame {
  /** What `PSG_Apply` writes this frame. */
  regs: PsgRegisters
  /** The song frame that was decoded, or -1 when the song has stopped. */
  songFrame: number
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
    }
  }
  if (player.playing) {
    songFrame = player.position
    // R#13 is never restored by the helper; the music never writes it anyway.
    player.regs.set(player.frames[player.position].subarray(0, 13))
    player.position++
  }
  const effect = player.effect
  if (effect) {
    if (effect.index < effect.frames.length) ayfxUpdate(player.regs, player.effectChannel, effect.frames[effect.index++])
    else {
      ayfxMute(player.regs, player.effectChannel)
      player.effect = null
    }
  }
  return { regs: player.regs.slice(), songFrame }
}
