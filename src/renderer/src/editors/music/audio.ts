/**
 * Playback glue for the music editor (Spec 15): streams `stepPlayer` frames
 * through the three-channel PSG model in `shared/psg.ts`. All the DSP and the
 * frame logic are over there and unit-tested; this file only owns the
 * `AudioContext` and the clock, which is why it has no tests of its own.
 *
 * ponytail: **short chunks scheduled back to back on AudioBufferSourceNodes**,
 * not an AudioWorklet. A worklet would need its own bundle (Vite serves dev
 * workers classic-style, with `importScripts`, which a worklet doesn't have),
 * and the editor needs only what this gives it: edits and effects heard within
 * one lookahead (~0.1 s), while the oscillators keep their phase from one chunk
 * to the next because one `PsgChip` renders them all. Main-thread stalls longer
 * than the lookahead will gap the audio — acceptable in an editor.
 */

import type { PsgRegisters } from '../../../../shared/msx/music'
import type { SfxFrame } from '../../../../shared/msx/sfx'
import { createMusicPlayer, playEffect, replaceSong, stepPlayer, type MusicPlayer } from '../../../../shared/music-play'
import { createPsgChip, renderChip, renderPsgFrames, samplesPerFrame, type PsgChip } from '../../../../shared/psg'

const LOOKAHEAD = 0.12
const CHUNK_FRAMES = 2
const TICK_MS = 25
const GAIN = 0.5

let context: AudioContext | null = null
let player: MusicPlayer | null = null
let chip: PsgChip | null = null
let rate = 50
let nextTime = 0
let timer: ReturnType<typeof setInterval> | null = null
let ticker = 0
let preview: AudioBufferSourceNode | null = null
let onFrame: ((frame: number) => void) | null = null
/** When each scheduled frame starts sounding, for the playhead. */
let schedule: { time: number; frame: number }[] = []
/** Chunks queued but not yet finished, so Stop can cut them. */
const queued = new Set<AudioBufferSourceNode>()

function audio(): AudioContext {
  context ??= new AudioContext()
  // Browsers start the context suspended until a user gesture; every call here is one.
  if (context.state === 'suspended') void context.resume()
  return context
}

/** Renders and queues frames until the queue reaches the lookahead; stops when there is nothing left to play. */
function pump(): void {
  const ctx = context
  if (!ctx || !player || !chip) return
  if (nextTime < ctx.currentTime + 0.02) nextTime = ctx.currentTime + 0.02
  const block = samplesPerFrame(ctx.sampleRate, rate)
  while (nextTime < ctx.currentTime + LOOKAHEAD) {
    if (!player.playing && !player.effect) {
      finish()
      return
    }
    const samples = new Float32Array(block * CHUNK_FRAMES)
    for (let i = 0; i < CHUNK_FRAMES; i++) {
      const { regs, songFrame } = stepPlayer(player)
      chip.regs.set(regs)
      renderChip(chip, samples, i * block, block, { sampleRate: ctx.sampleRate, gain: GAIN })
      schedule.push({ time: nextTime + (i * block) / ctx.sampleRate, frame: songFrame })
    }
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = (): void => {
      queued.delete(source)
    }
    queued.add(source)
    source.start(nextTime)
    nextTime += samples.length / ctx.sampleRate
  }
}

/** Reports the frame under the playhead once per animation frame. */
function follow(): void {
  const ctx = context
  if (!ctx || !timer) return
  const now = ctx.currentTime
  let current: number | null = null
  while (schedule.length && schedule[0].time <= now) current = schedule.shift()!.frame
  if (current !== null) onFrame?.(current)
  ticker = requestAnimationFrame(follow)
}

/** Lets what is already queued play out, then reports the end. */
function finish(): void {
  if (timer) clearInterval(timer)
  timer = null
  cancelAnimationFrame(ticker)
  const ctx = context
  const done = onFrame
  const left = ctx ? Math.max(0, nextTime - ctx.currentTime) : 0
  setTimeout(() => {
    if (!timer) done?.(-1)
  }, left * 1000)
  player = null
  schedule = []
}

function start(): void {
  if (timer) return
  timer = setInterval(pump, TICK_MS)
  pump()
  ticker = requestAnimationFrame(follow)
}

export interface MusicPlayOptions {
  rate: number
  loopFrame: number
  loop: boolean
  /** Song frame to start from. */
  start: number
  effectChannel: number
  /** Called with the song frame under the playhead (-1 between songs), and -1 once playback ends. */
  onFrame: (frame: number) => void
}

/** Plays `frames` (a rendered song). Anything already playing stops. */
export function playMusic(frames: PsgRegisters[], options: MusicPlayOptions): void {
  stopMusic()
  audio()
  rate = options.rate
  chip = createPsgChip()
  player = createMusicPlayer(frames, { loopFrame: options.loopFrame, loop: options.loop, start: options.start, effectChannel: options.effectChannel })
  onFrame = options.onFrame
  start()
}

/** Swaps in a re-rendered song while it plays — the next chunk is the new one. */
export function updateMusic(frames: PsgRegisters[], loopFrame: number, loop: boolean, effectChannel: number): void {
  if (!player) return
  replaceSong(player, frames, loopFrame)
  player.loop = loop
  player.effectChannel = effectChannel
}

export function stopMusic(): void {
  if (timer) clearInterval(timer)
  timer = null
  cancelAnimationFrame(ticker)
  player = null
  schedule = []
  for (const source of queued) {
    try {
      source.stop()
    } catch {
      // Already finished.
    }
  }
  queued.clear()
  nextTime = 0
}

export function isMusicPlaying(): boolean {
  return timer !== null
}

/**
 * Fires an effect the way `ayFX_PlayBank` does: on the effect channel, from
 * the next frame, over the music if it is playing — or on its own if not.
 */
export function fireEffect(frames: readonly SfxFrame[], options: { rate: number; channel: number; onFrame?: (frame: number) => void }): void {
  audio()
  if (!player) {
    rate = options.rate
    chip = createPsgChip()
    player = createMusicPlayer([], { loopFrame: 0, loop: false, effectChannel: options.channel })
    onFrame = options.onFrame ?? null
  }
  player.effectChannel = options.channel
  playEffect(player, frames)
  start()
}

/** A short one-off — the note under the pointer, a key on the keyboard. Doesn't touch playback. */
export function previewFrames(frames: PsgRegisters[], frameRate: number): void {
  const ctx = audio()
  if (preview) {
    try {
      preview.stop()
    } catch {
      // Already finished.
    }
  }
  const samples = renderPsgFrames(frames, { sampleRate: ctx.sampleRate, rate: frameRate, gain: GAIN })
  if (!samples.length) return
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
  buffer.getChannelData(0).set(samples)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
  preview = source
}
