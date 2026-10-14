import { describe, expect, it } from 'vitest'
import {
  beatHits,
  BEAT_PRESETS,
  createMusicDoc,
  defaultInstruments,
  encodeLvgm,
  exportSong,
  frameWrites,
  INSTRUMENT_PRESETS,
  LVGM_END,
  LVGM_LOOP,
  LVGM_PSG,
  loopFrame,
  maskRegisters,
  monophonic,
  normalizeMusic,
  noteName,
  notePeriod,
  renderSong,
  ROWS_PER_BAR,
  simulateLvgm,
  songFrames,
  songSymbol,
  stepIndex,
  tempoBpm,
  validateMusic,
  type Instrument,
  type MusicDoc,
  type Note,
  type PsgRegisters,
  type Song
} from './music'

const steady = (volume = 15): Instrument => ({ name: 'steady', steps: [{ volume, semitones: 0, cents: 0, tone: true, noise: null }], loop: null })

function docWith(song: Partial<Song>, instruments: Instrument[] = [steady()]): MusicDoc {
  return normalizeMusic({
    rate: 50,
    instruments,
    songs: [{ name: 'test', bars: 1, speed: 2, loopBar: 0, channels: [[], [], []], ...song }]
  })
}

const note = (row: number, length: number, pitch: number, instrument = 0, volume = 15): Note => ({ row, length, pitch, instrument, volume })

/** The frame the player is on after `call` calls, looping from `loopAt`. */
function expectedFrame(frames: readonly PsgRegisters[], loopAt: number, call: number): PsgRegisters {
  const n = frames.length
  return frames[call < n ? call : loopAt + ((call - n) % (n - loopAt))]
}

/** The music-written registers (R#0–R#10), masked as the chip keeps them. */
const audible = (regs: PsgRegisters): number[] => [...maskRegisters(regs)].slice(0, 11)

function expectRoundTrip(doc: MusicDoc, song: Song): void {
  const frames = renderSong(doc, song)
  const loopAt = loopFrame(song)
  const bytes = encodeLvgm(frames, { rate: doc.rate, loopFrame: loopAt })
  const passes = frames.length * 2 + 3
  const played = simulateLvgm(bytes, passes)
  for (let call = 0; call < passes; call++) {
    expect(audible(played.frames[call]), `frame ${call}`).toEqual(audible(expectedFrame(frames, loopAt, call)))
  }
}

/** Where each opcode starts — a `0xFE` can just as well be a register value. */
function opcodes(bytes: Uint8Array): number[] {
  const out: number[] = []
  for (let at = 6; at < bytes.length; at++) {
    out.push(at)
    if ([0x00, 0x02, 0x04, 0x07, 0x0b, 0x0c].includes(bytes[at])) at++
  }
  return out
}

/** A small deterministic PRNG, so the property tests are reproducible. */
function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x80000000
  }
}

describe('pitch and timing', () => {
  it('tunes A4 to 440 Hz: period 254 on the 1.79 MHz PSG', () => {
    expect(notePeriod(69)).toBe(254)
    expect(notePeriod(57)).toBe(508)
  })

  it('names notes the MIDI way', () => {
    expect(noteName(60)).toBe('C4')
    expect(noteName(69)).toBe('A4')
    expect(noteName(61)).toBe('C#4')
    expect(noteName(24)).toBe('C1')
  })

  it('works out the tempo from rate and speed', () => {
    expect(tempoBpm(50, 5)).toBe(150)
    expect(tempoBpm(60, 6)).toBe(150)
  })

  it('holds the last step without a loop, and wraps into the loop with one', () => {
    const held: Instrument = { ...steady(), steps: [1, 2, 3].map((volume) => ({ volume, semitones: 0, cents: 0, tone: true, noise: null })) }
    expect([0, 1, 2, 3, 9].map((frame) => stepIndex(held, frame))).toEqual([0, 1, 2, 2, 2])
    const looped = { ...held, loop: 1 }
    expect([0, 1, 2, 3, 4, 5].map((frame) => stepIndex(looped, frame))).toEqual([0, 1, 2, 1, 2, 1])
  })
})

describe('normalizeMusic', () => {
  it('starts a bank with every preset instrument and a demo song that validates', () => {
    const doc = createMusicDoc()
    expect(doc.instruments.map((one) => one.name)).toEqual(INSTRUMENT_PRESETS.map((one) => one.name))
    expect(doc.songs).toHaveLength(1)
    expect(doc.songs[0].channels.every((notes) => notes.length > 0)).toBe(true)
    expect(validateMusic(doc)).toEqual([])
  })

  it('makes overlapping notes on one channel take turns', () => {
    expect(monophonic([note(0, 8, 60), note(4, 2, 62), note(4, 2, 64)])).toEqual([note(0, 4, 60), note(4, 2, 64)])
  })

  it('drops notes outside the song and clamps the rest', () => {
    const doc = docWith({ channels: [[note(14, 10, 200), note(40, 1, 60)], [], []] })
    expect(doc.songs[0].channels[0]).toEqual([{ row: 14, length: 2, pitch: 107, instrument: 0, volume: 15 }])
  })

  it('keeps the loop bar inside the song', () => {
    expect(docWith({ bars: 2, loopBar: 7 }).songs[0].loopBar).toBe(1)
  })
})

describe('validateMusic', () => {
  it('rejects two songs exporting the same table name', () => {
    const doc = normalizeMusic({ songs: [{ name: 'stage one' }, { name: 'stage_one' }] })
    expect(validateMusic(doc).join('\n')).toContain('both export as _StageOne')
  })

  it('rejects a song named after a helper', () => {
    expect(validateMusic(normalizeMusic({ songs: [{ name: 'play' }] })).join('\n')).toContain('the helpers use _Play')
  })

  it('names tables in PascalCase', () => {
    expect(songSymbol('title theme')).toBe('TitleTheme')
    expect(songSymbol('boss-2')).toBe('Boss2')
  })
})

describe('renderSong', () => {
  it('renders one frame per frame of the song', () => {
    const doc = createMusicDoc()
    expect(renderSong(doc, doc.songs[0])).toHaveLength(songFrames(doc.songs[0]))
  })

  it('plays a note for its length in rows times the speed, then goes silent', () => {
    const doc = docWith({ channels: [[note(0, 2, 69)], [], []] })
    const frames = renderSong(doc, doc.songs[0])
    expect(frames.slice(0, 5).map((regs) => regs[8])).toEqual([15, 15, 15, 15, 0])
    expect([frames[0][0], frames[0][1]]).toEqual([254, 0])
    // Tone A on, noise A off; the other channels untouched (all off).
    expect(frames[0][7]).toBe(0b10111110)
  })

  it('scales the instrument by the note volume, keeping quiet notes audible', () => {
    const doc = docWith({ channels: [[note(0, 1, 60, 0, 1)], [note(0, 1, 60, 0, 0)], []] }, [steady(14)])
    const [first] = renderSong(doc, doc.songs[0])
    expect([first[8], first[9]]).toEqual([1, 0])
  })

  it('leaves a silent channel its old tone and mixer bits — they cost bytes and nobody hears them', () => {
    const doc = docWith({ channels: [[note(0, 1, 69), note(2, 1, 72)], [], []] })
    const frames = renderSong(doc, doc.songs[0])
    // Rows 1 (frames 2–3) is a rest: volume 0, but A's period and mixer bits stay.
    expect(frames[2][8]).toBe(0)
    expect([frames[2][0], frames[2][7]]).toEqual([frames[1][0], frames[1][7]])
  })

  it('gives the one noise generator to the loudest channel, and a tie to the later one', () => {
    const hiss = (volume: number, noise: number): Instrument => ({ name: 'n', steps: [{ volume, semitones: 0, cents: 0, tone: false, noise }], loop: null })
    const doc = docWith({ channels: [[note(0, 1, 60, 0)], [note(0, 1, 60, 1)], [note(0, 1, 60, 2)]] }, [hiss(15, 3), hiss(9, 20), hiss(15, 7)])
    const [first] = renderSong(doc, doc.songs[0])
    expect(first[6]).toBe(7)
    // Noise on, tone off on all three.
    expect(first[7] & 0x3f).toBe(0b000111)
  })

  it('mutes channels on request', () => {
    const doc = createMusicDoc()
    const frames = renderSong(doc, doc.songs[0], [true, false, true])
    expect(frames.every((regs) => regs[8] === 0 && regs[10] === 0)).toBe(true)
    expect(frames.some((regs) => regs[9] > 0)).toBe(true)
  })
})

describe('encodeLvgm', () => {
  it('writes the header MSXgl checks: ident, options, most common byte', () => {
    const doc = createMusicDoc()
    const { bytes } = exportSong(doc, doc.songs[0])
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('lVGM')
    // 50 Hz + loop included, PSG only (no device byte).
    expect(bytes[4]).toBe(0b011)
    expect(bytes[bytes.length - 1]).toBe(LVGM_END)
  })

  it('pads the loop marker with F0, the byte the player skips on every repeat', () => {
    const doc = createMusicDoc()
    const song = { ...doc.songs[0], loopBar: 1 }
    const { bytes } = exportSong(doc, song)
    const ops = opcodes(bytes)
    const markers = ops.filter((at) => bytes[at] === LVGM_LOOP)
    expect(markers).toHaveLength(1)
    expect(markers[0]).toBeGreaterThan(6)
    expect(bytes[markers[0] + 1]).toBe(LVGM_PSG)
  })

  it('round-trips the demo song through two passes of its loop', () => {
    const doc = createMusicDoc()
    expectRoundTrip(doc, doc.songs[0])
  })

  it('round-trips a loop that does not start at the top', () => {
    const doc = createMusicDoc()
    expectRoundTrip(doc, { ...doc.songs[0], loopBar: 2 })
  })

  it('makes the loop frame a keyframe against the song’s last frame as well', () => {
    // Bar 0 rests on A, bar 1 holds a note on A; looping to bar 1 from the end
    // of bar 1 needs no write, but looping to bar 0 must silence A again.
    const doc = docWith({ bars: 2, loopBar: 0, channels: [[note(16, 16, 69)], [], []] })
    const frames = renderSong(doc, doc.songs[0])
    const writes = frameWrites(frames, 0)
    expect(writes[0]).toHaveLength(11)
    expectRoundTrip(doc, doc.songs[0])
    const later = docWith({ bars: 2, loopBar: 1, channels: [[note(0, 8, 60), note(16, 16, 69)], [], []] })
    expectRoundTrip(later, later.songs[0])
  })

  it('splits long rests into waits of at most 16 frames', () => {
    const doc = docWith({ bars: 2, speed: 10, channels: [[note(0, 1, 60), note(31, 1, 60)], [], []] })
    const { bytes } = exportSong(doc, doc.songs[0])
    const waits = [...bytes.subarray(6)].filter((byte) => (byte & 0xf0) === 0xe0)
    expect(waits.length).toBeGreaterThan(2)
    expectRoundTrip(doc, doc.songs[0])
  })

  it('stops and mutes at the end when played without looping', () => {
    const doc = createMusicDoc()
    const song = doc.songs[0]
    const { bytes, frames } = exportSong(doc, song)
    const played = simulateLvgm(bytes, frames + 2, false)
    expect(played.playing[frames - 1]).toBe(true)
    expect(played.playing[frames]).toBe(false)
    expect([...played.frames[frames + 1].subarray(8, 11)]).toEqual([0, 0, 0])
  })

  it('stays compact: the 6.4-second demo loop, 16th-note drums and all, is under 2 KB', () => {
    // Real Konami PSG tunes measure 77–139 bytes/second; a busy beat costs more
    // (a kick rewrites its pitch every frame). Here as a budget, not a target.
    const doc = createMusicDoc()
    const { bytes, frames } = exportSong(doc, doc.songs[0])
    expect(frames).toBe(320)
    expect(bytes.length).toBeLessThan(2048)
  })

  it('uses the one-byte Dr form for the most common two-byte value', () => {
    const doc = createMusicDoc()
    const { bytes } = exportSong(doc, doc.songs[0])
    expect(opcodes(bytes).some((at) => (bytes[at] & 0xf0) === 0xd0)).toBe(true)
  })

  it('round-trips random songs over every instrument preset', () => {
    const random = rng(7)
    const instruments = defaultInstruments()
    for (let trial = 0; trial < 12; trial++) {
      const bars = 1 + Math.floor(random() * 3)
      const channels = [0, 1, 2].map(() =>
        Array.from({ length: 10 }, () => {
          const row = Math.floor(random() * bars * ROWS_PER_BAR)
          return note(row, 1 + Math.floor(random() * 6), 36 + Math.floor(random() * 48), Math.floor(random() * instruments.length), 1 + Math.floor(random() * 15))
        })
      )
      const doc = normalizeMusic({
        rate: trial % 2 ? 60 : 50,
        instruments,
        songs: [{ name: 'r', bars, speed: 1 + Math.floor(random() * 8), loopBar: Math.floor(random() * bars), channels }]
      })
      expectRoundTrip(doc, doc.songs[0])
    }
  })
})

describe('beats', () => {
  it('lets each hit ring until the next one', () => {
    expect(beatHits('K.H.S...........')).toEqual([
      { row: 0, length: 2, drum: 'kick' },
      { row: 2, length: 2, drum: 'hat' },
      { row: 4, length: 12, drum: 'snare' }
    ])
  })

  it('only uses drums the presets define, one bar long', () => {
    for (const beat of BEAT_PRESETS) {
      expect(beat.pattern).toHaveLength(ROWS_PER_BAR)
      for (const hit of beatHits(beat.pattern)) expect(INSTRUMENT_PRESETS.some((one) => one.name === hit.drum)).toBe(true)
    }
  })
})
