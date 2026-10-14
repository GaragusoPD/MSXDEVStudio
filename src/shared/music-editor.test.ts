import { describe, expect, it } from 'vitest'
import { BEAT_PITCH, createMusicDoc, normalizeMusic, ROWS_PER_BAR, type Note, type Song } from './msx/music'
import {
  addInstrument,
  addSong,
  applyBeat,
  blankSong,
  copyBar,
  deleteInstrument,
  deleteSong,
  dragSong,
  duplicateSong,
  hitAnyChannel,
  hitNote,
  KEY_H,
  pitchAtY,
  yOfPitch,
  ensureInstrument,
  instrumentInUse,
  noteAt,
  placeNote,
  removeNote,
  renameSong,
  replaceNote,
  setBars,
  setLoopBar,
  setSpeed,
  uniqueName
} from './music-editor'

const note = (row: number, length: number, pitch = 60, instrument = 0): Note => ({ row, length, pitch, instrument, volume: 15 })
const song = (a: Note[] = [], bars = 2): Song => ({ ...blankSong('s'), bars, channels: [a, [], []] })

describe('placeNote', () => {
  it('adds a note, kept in row order', () => {
    const next = placeNote(placeNote(song(), 0, note(8, 2)), 0, note(0, 2))
    expect(next.channels[0].map((one) => one.row)).toEqual([0, 8])
  })

  it('cuts short a note already sounding, and removes one that would start underneath', () => {
    const next = placeNote(song([note(0, 8, 60), note(6, 4, 62), note(12, 2, 64)]), 0, note(4, 4, 67))
    expect(next.channels[0]).toEqual([note(0, 4, 60), note(4, 4, 67), note(12, 2, 64)])
  })

  it('only touches its own channel', () => {
    const start: Song = { ...song(), channels: [[], [note(0, 8)], []] }
    expect(placeNote(start, 0, note(0, 4)).channels[1]).toEqual([note(0, 8)])
  })

  it('clamps a note into the song and the PSG range', () => {
    const next = placeNote(song([], 1), 0, { row: 14, length: 9, pitch: 300, instrument: 0, volume: 20 })
    expect(next.channels[0]).toEqual([{ row: 14, length: 2, pitch: 107, instrument: 0, volume: 15 }])
  })
})

describe('moving and removing', () => {
  it('finds a note by row and pitch', () => {
    const notes = [note(4, 4, 60)]
    expect(noteAt(notes, 6, 60)).toBe(0)
    expect(noteAt(notes, 6, 61)).toBe(-1)
    expect(noteAt(notes, 8, 60)).toBe(-1)
  })

  it('moves a note under the same rules as drawing one', () => {
    const start = song([note(0, 4, 60), note(8, 8, 62)])
    const moved = replaceNote(start, 0, 0, note(10, 4, 65))
    expect(moved.channels[0]).toEqual([note(8, 2, 62), note(10, 4, 65)])
  })

  it('returns the same song when nothing changed', () => {
    const start = song([note(0, 4)])
    expect(replaceNote(start, 0, 0, note(0, 4))).toBe(start)
    expect(removeNote(start, 0, 5)).toBe(start)
  })

  it('removes a note', () => {
    expect(removeNote(song([note(0, 4), note(4, 4)]), 0, 0).channels[0]).toEqual([note(4, 4)])
  })
})

describe('song settings', () => {
  it('shortening drops notes past the end and cuts the ones that run over', () => {
    const next = setBars(song([note(10, 10), note(20, 2)], 2), 1)
    expect(next.channels[0]).toEqual([note(10, 6)])
  })

  it('keeps the loop bar inside a shortened song', () => {
    expect(setBars({ ...song([], 4), loopBar: 3 }, 2).loopBar).toBe(1)
  })

  it('clamps speed and loop bar, and no-ops on the same value', () => {
    const start = song()
    expect(setSpeed(start, 99).speed).toBe(31)
    expect(setSpeed(start, start.speed)).toBe(start)
    expect(setLoopBar(start, 5).loopBar).toBe(1)
  })

  it('copies one bar over another on every channel', () => {
    const start: Song = { ...song([note(0, 4, 60), note(4, 20, 62)], 2), channels: [[note(0, 4, 60), note(4, 20, 62)], [note(2, 2, 40)], []] }
    const next = copyBar(start, 0, 1)
    // The long note is cut at the end of the bar it was copied from, and the
    // original's tail through bar 1 gives way to the copy.
    expect(next.channels[0]).toEqual([note(0, 4, 60), note(4, 12, 62), note(16, 4, 60), note(20, 12, 62)])
    expect(next.channels[1]).toEqual([note(2, 2, 40), note(18, 2, 40)])
  })
})

describe('the song list', () => {
  it('names new and duplicated songs uniquely', () => {
    expect(uniqueName('song', ['song', 'song2'])).toBe('song3')
    const doc = addSong(createMusicDoc())
    expect(doc.songs.map((one) => one.name)).toEqual(['theme', 'song'])
    expect(duplicateSong(doc, 0).songs.map((one) => one.name)).toEqual(['theme', 'theme2', 'song'])
  })

  it('always keeps one song', () => {
    const doc = createMusicDoc()
    expect(deleteSong(doc, 0)).toBe(doc)
    expect(deleteSong(addSong(doc), 0).songs.map((one) => one.name)).toEqual(['song'])
  })

  it('ignores a blank rename', () => {
    const doc = createMusicDoc()
    expect(renameSong(doc, 0, '  ')).toBe(doc)
    expect(renameSong(doc, 0, 'title').songs[0].name).toBe('title')
  })
})

describe('instruments', () => {
  it('will not delete an instrument a note plays', () => {
    const doc = createMusicDoc()
    expect(instrumentInUse(doc, 0)).toBe(true)
    expect(deleteInstrument(doc, 0)).toBe(doc)
  })

  it('shifts every note down when an earlier, unused instrument goes', () => {
    const doc = normalizeMusic({
      instruments: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      songs: [{ name: 's', channels: [[{ row: 0, length: 1, pitch: 60, instrument: 2 }], [], []] }]
    })
    const next = deleteInstrument(doc, 1)
    expect(next.instruments.map((one) => one.name)).toEqual(['a', 'c'])
    expect(next.songs[0].channels[0][0].instrument).toBe(1)
  })

  it('adds a preset under a unique name, and finds an existing one by name', () => {
    const doc = createMusicDoc()
    const added = addInstrument(doc, doc.instruments[0])
    expect(added.doc.instruments[added.index].name).toBe('lead2')
    expect(ensureInstrument(doc, 'snare')).toEqual({ doc, index: doc.instruments.findIndex((one) => one.name === 'snare') })
  })
})

describe('applyBeat', () => {
  it('fills the channel with the pattern, every bar, replacing what was there', () => {
    const doc = createMusicDoc()
    const next = applyBeat(doc, 0, 2, 'disco')
    const drums = next.songs[0].channels[2]
    expect(drums).toHaveLength(8 * doc.songs[0].bars)
    expect(drums[0].row).toBe(0)
    expect(drums[8].row).toBe(ROWS_PER_BAR)
    expect(drums.filter((one) => one.pitch === BEAT_PITCH['open hat'])).toHaveLength(4 * doc.songs[0].bars)
    expect(next.songs[0].channels[0]).toBe(doc.songs[0].channels[0])
  })

  it('brings in the drums the bank is missing', () => {
    const doc = normalizeMusic({ instruments: [{ name: 'lead' }], songs: [{ name: 's' }] })
    const next = applyBeat(doc, 0, 1, 'rock')
    expect(next.instruments.map((one) => one.name)).toEqual(['lead', 'kick', 'hat', 'snare'])
    const kick = next.songs[0].channels[1][0]
    expect(next.instruments[kick.instrument].name).toBe('kick')
  })

  it('ignores an unknown beat', () => {
    const doc = createMusicDoc()
    expect(applyBeat(doc, 0, 0, 'polka')).toBe(doc)
  })
})

describe('piano roll', () => {
  const W = 10
  const y = (pitch: number): number => yOfPitch(pitch) + KEY_H / 2

  it('puts the highest pitch at the top', () => {
    expect(pitchAtY(0)).toBe(107)
    expect(pitchAtY(y(60))).toBe(60)
    expect(pitchAtY(-50)).toBe(107)
  })

  it('tells a note\'s body from its resize grip', () => {
    const start = song([note(2, 4, 60)])
    expect(hitNote(start, 0, 25, y(60), W)).toEqual({ channel: 0, index: 0, part: 'body' })
    expect(hitNote(start, 0, 58, y(60), W)).toEqual({ channel: 0, index: 0, part: 'end' })
    expect(hitNote(start, 0, 25, y(61), W)).toBeNull()
  })

  it('prefers the channel being edited, and finds another channel\'s note otherwise', () => {
    const start: Song = { ...song([note(0, 4, 60)]), channels: [[note(0, 4, 60)], [note(0, 4, 60)], [note(8, 4, 50)]] }
    expect(hitAnyChannel(start, 1, 5, y(60), W)?.channel).toBe(1)
    expect(hitAnyChannel(start, 0, 85, y(50), W)?.channel).toBe(2)
  })

  it('draws a note as long as the drag, at least one row — or the default length for a click', () => {
    const drag = { kind: 'draw' as const, channel: 0, origin: note(4, 2, 62) }
    expect(dragSong(song(), drag, 7, 70).channels[0]).toEqual([note(4, 4, 62)])
    expect(dragSong(song(), drag, 1, 62).channels[0]).toEqual([note(4, 1, 62)])
    expect(dragSong(song(), drag, 4, 62).channels[0]).toEqual([note(4, 2, 62)])
    expect(dragSong(song(), drag, 5, 62).channels[0]).toEqual([note(4, 2, 62)])
    expect(dragSong(song(), drag, 6, 62).channels[0]).toEqual([note(4, 3, 62)])
  })

  it('moves by the distance dragged from where the note was grabbed', () => {
    const start = song([note(4, 2, 60)])
    const drag = { kind: 'move' as const, channel: 0, index: 0, original: note(4, 2, 60), grabRow: 5, grabPitch: 60 }
    expect(dragSong(start, drag, 9, 63).channels[0]).toEqual([note(8, 2, 63)])
    // Back where it started: no change at all.
    expect(dragSong(start, drag, 5, 60)).toBe(start)
  })

  it('resizes from the note\'s start', () => {
    const start = song([note(4, 2, 60)])
    const drag = { kind: 'resize' as const, channel: 0, index: 0, original: note(4, 2, 60) }
    expect(dragSong(start, drag, 11, 99).channels[0]).toEqual([note(4, 8, 60)])
  })

  it('erases whatever the drag crosses', () => {
    const drag = { kind: 'erase' as const, channel: 0 }
    let next = song([note(0, 2, 60), note(2, 2, 62)])
    next = dragSong(next, drag, 1, 60)
    next = dragSong(next, drag, 3, 62)
    expect(next.channels[0]).toEqual([])
  })
})
