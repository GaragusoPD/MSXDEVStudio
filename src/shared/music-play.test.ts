import { describe, expect, it } from 'vitest'
import {
  createMusicDoc,
  exportSong,
  loopFrame,
  lvgmDecoder,
  maskRegisters,
  normalizeMusic,
  renderSong,
  type Instrument,
  type PsgRegisters
} from './msx/music'
import { ayfxMute, ayfxUpdate, createMusicPlayer, fadeOut, playEffect, replaceSong, stepPlayer } from './music-play'
import type { SfxFrame } from './msx/sfx'

const fx = (volume: number, tone: number, fields: Partial<SfxFrame> = {}): SfxFrame => ({ toneOn: true, tone, noiseOn: false, noise: 0, volume, ...fields })
const audible = (regs: PsgRegisters): number[] => [...maskRegisters(regs)].slice(0, 11)

describe('ayfxUpdate', () => {
  it('writes nothing for a volume-0 frame — the player returns before touching AYREGS', () => {
    const regs = new Uint8Array(14).fill(0x55)
    ayfxUpdate(regs, 2, fx(0, 100, { noiseOn: true, noise: 9 }))
    expect([...regs]).toEqual(new Array(14).fill(0x55))
  })

  it('takes over one channel: its mixer bits, volume and tone', () => {
    const regs = new Uint8Array(14)
    regs[7] = 0b10111000 // music: tone on everywhere, noise off everywhere
    ayfxUpdate(regs, 2, fx(12, 0x123, { noiseOn: true, noise: 5 }))
    expect(regs[6]).toBe(5)
    // Channel C: tone on (bit 2 clear), noise on (bit 5 clear); A and B untouched.
    expect(regs[7]).toBe(0b10011000)
    expect(regs[10]).toBe(12)
    expect([regs[4], regs[5]]).toEqual([0x23, 0x01])
  })

  it('leaves the tone registers alone on a noise-only frame', () => {
    const regs = new Uint8Array(14)
    regs[2] = 0x77
    ayfxUpdate(regs, 1, fx(9, 0x200, { toneOn: false, noiseOn: true, noise: 3 }))
    expect(regs[2]).toBe(0x77)
    expect(regs[7] & 0b010010).toBe(0b000010)
  })

  it('stops after the noise write when both tone and noise are off', () => {
    const regs = new Uint8Array(14)
    ayfxUpdate(regs, 0, fx(15, 300, { toneOn: false }))
    expect([...regs]).toEqual(new Array(14).fill(0))
  })

  it('mutes its channel when the stream ends', () => {
    const regs = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 0, 0, 0])
    ayfxMute(regs, 0)
    expect([...regs.subarray(8, 11)]).toEqual([0, 9, 9])
  })
})

describe('stepPlayer', () => {
  it('plays the rendered frames in order and loops back to the loop bar', () => {
    const doc = createMusicDoc()
    const song = { ...doc.songs[0], loopBar: 1 }
    const frames = renderSong(doc, song)
    const player = createMusicPlayer(frames, { loopFrame: loopFrame(song), loop: true })
    const out = Array.from({ length: frames.length + 5 }, () => stepPlayer(player))
    expect(out[0].songFrame).toBe(0)
    expect(out[frames.length - 1].songFrame).toBe(frames.length - 1)
    expect(out[frames.length].songFrame).toBe(loopFrame(song))
    expect(audible(out[frames.length].regs)).toEqual(audible(frames[loopFrame(song)]))
  })

  it('stops and mutes after the last frame when not looping', () => {
    const doc = createMusicDoc()
    const frames = renderSong(doc, doc.songs[0])
    const player = createMusicPlayer(frames, { loopFrame: 0, loop: false })
    for (let i = 0; i < frames.length; i++) stepPlayer(player)
    const after = stepPlayer(player)
    expect(after.songFrame).toBe(-1)
    expect([...after.regs.subarray(8, 11)]).toEqual([0, 0, 0])
  })

  it('keeps its place when the song is edited under it', () => {
    const doc = createMusicDoc()
    const frames = renderSong(doc, doc.songs[0])
    const player = createMusicPlayer(frames, { loopFrame: 0, loop: true })
    for (let i = 0; i < 40; i++) stepPlayer(player)
    replaceSong(player, renderSong(doc, doc.songs[0], [true, false, false]), 0)
    const next = stepPlayer(player)
    expect(next.songFrame).toBe(40)
    expect(next.regs[8]).toBe(0)
  })
})

/**
 * The acceptance test for the helper's register copy: a channel holding one
 * long note while an effect plays on it. The real lVGM stream never rewrites
 * that note's tone, so whether the music comes back after the effect depends
 * entirely on the copy.
 */
describe('music with a sound effect on its channel', () => {
  const organ: Instrument = { name: 'organ', steps: [{ volume: 13, semitones: 0, cents: 0, tone: true, noise: null }], loop: null }
  const doc = normalizeMusic({
    rate: 50,
    instruments: [organ],
    songs: [{ name: 'held', bars: 2, speed: 4, loopBar: 0, channels: [[{ row: 0, length: 32, pitch: 60 }], [], [{ row: 0, length: 32, pitch: 48 }]] }]
  })
  const song = doc.songs[0]
  const frames = renderSong(doc, song)
  const { bytes } = exportSong(doc, song)
  const effect = Array.from({ length: 6 }, (_, i) => fx(15 - i, 90 + i * 10, { noiseOn: i < 2, noise: 4 }))
  const START = 20

  /** `g_Music_Decode(); ayFX_Update(); PSG_Apply();` over the real stream, with or without the copy. */
  function game(withCopy: boolean, calls: number): PsgRegisters[] {
    const decoder = lvgmDecoder(bytes, true)
    const regs = new Uint8Array(14) // g_PSG_Regs, muted by LVGM_Play
    const copy = regs.slice(0, 13) // g_Music_Regs, taken in g_Music_Play
    let effectIndex = -1
    const out: PsgRegisters[] = []
    for (let call = 0; call < calls; call++) {
      if (call === START) effectIndex = 0
      if (withCopy) regs.set(copy)
      decoder.decode(regs)
      if (withCopy) copy.set(regs.subarray(0, 13))
      if (effectIndex >= 0) {
        if (effectIndex < effect.length) ayfxUpdate(regs, 2, effect[effectIndex++])
        else {
          ayfxMute(regs, 2)
          effectIndex = -1
        }
      }
      out.push(regs.slice())
    }
    return out
  }

  it('the editor hears exactly what the game plays', () => {
    const player = createMusicPlayer(frames, { loopFrame: 0, loop: true })
    const heard: PsgRegisters[] = []
    for (let call = 0; call < 80; call++) {
      if (call === START) playEffect(player, effect)
      heard.push(stepPlayer(player).regs)
    }
    const played = game(true, 80)
    for (let call = 0; call < 80; call++) expect(audible(heard[call]), `frame ${call}`).toEqual(audible(played[call]))
  })

  it('gives the channel back the frame after the effect’s mute', () => {
    const played = game(true, 80)
    const back = START + effect.length + 1
    expect(audible(played[back])).toEqual(audible(frames[back]))
    // The effect's own frames really did take channel C over.
    expect(played[START][4]).toBe(90)
  })

  it('without the copy, the held note stays at the effect’s pitch — the bug the copy exists for', () => {
    const played = game(false, 80)
    const back = START + effect.length + 1
    expect(played[back][4]).not.toBe(frames[back][4])
    expect(played[back][10]).not.toBe(frames[back][10])
  })
})

describe('effect priorities', () => {
  const blip = Array.from({ length: 4 }, (_, i) => fx(12, 100 + i))

  it('lets an equal or more important effect cut one off, and refuses a less important one', () => {
    const player = createMusicPlayer([], { loopFrame: 0, loop: false })
    expect(playEffect(player, blip, 3)).toBe(0)
    expect(playEffect(player, blip, 9)).toBe(1)
    expect(playEffect(player, blip, 3)).toBe(0)
    expect(playEffect(player, blip, 0)).toBe(0)
    expect(player.effectPriority).toBe(0)
  })

  it('takes anything again once the effect has ended', () => {
    const player = createMusicPlayer([], { loopFrame: 0, loop: false })
    playEffect(player, blip, 0)
    for (let i = 0; i <= blip.length; i++) stepPlayer(player)
    expect(player.effect).toBeNull()
    expect(playEffect(player, blip, 15)).toBe(0)
  })
})

describe('fadeOut', () => {
  const doc = normalizeMusic({
    rate: 50,
    instruments: [{ name: 'organ', steps: [{ volume: 15 }], loop: null }],
    songs: [{ name: 'held', bars: 4, speed: 4, channels: [[{ row: 0, length: 64, pitch: 60 }], [], []] }]
  })
  const frames = renderSong(doc, doc.songs[0])

  it('takes one volume step every `speed` frames and stops the song at the fifteenth', () => {
    const player = createMusicPlayer(frames, { loopFrame: 0, loop: true })
    fadeOut(player, 2)
    const volumes: number[] = []
    for (let i = 0; i < 40; i++) volumes.push(stepPlayer(player).regs[8])
    expect(volumes.slice(0, 6)).toEqual([15, 14, 14, 13, 13, 12])
    // Step 14 lands on frame 27 and holds for two frames; step 15 (frame 29) stops it.
    expect(volumes.slice(27, 30)).toEqual([1, 1, 0])
    expect(player.playing).toBe(false)
    expect(volumes.slice(29).every((volume) => volume === 0)).toBe(true)
  })

  it('leaves the effect channel to the effect at full volume', () => {
    const player = createMusicPlayer(frames, { loopFrame: 0, loop: true, effectChannel: 0 })
    fadeOut(player, 1)
    for (let i = 0; i < 6; i++) stepPlayer(player)
    playEffect(player, [fx(13, 300)], 0)
    expect(stepPlayer(player).regs[8]).toBe(13)
  })
})
