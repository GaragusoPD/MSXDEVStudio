import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { defaultProject } from '../../shared/msxproj'
import {
  commandXml,
  launchArgs,
  matrixKey,
  OpenMsxSession,
  openmsxMachine,
  parseControlOutput,
  peekCommand,
  tclNumbers
} from './emulator'

describe('the openMSX control protocol', () => {
  it('escapes a command and reads replies, logs and updates out of a stream', () => {
    expect(commandXml('vpeek 0x1800 & <x>')).toBe('<command>vpeek 0x1800 &amp; &lt;x&gt;</command>\n')
    const stream =
      '<openmsx-output>\n<update type="status" name="cpu">on</update>' +
      '<reply result="ok">12 34</reply><log level="warning">no &quot;ROM&quot;</log>' +
      '<reply result="nok">invalid command name &quot;foo&quot;</reply><reply result="ok"/><reply res'
    const { replies, logs, rest } = parseControlOutput(stream)
    expect(replies).toEqual([
      { ok: true, text: '12 34' },
      { ok: false, text: 'invalid command name "foo"' },
      { ok: true, text: '' }
    ])
    expect(logs).toEqual(['no "ROM"'])
    // An element cut off mid-read is kept for the next chunk.
    expect(rest).toBe('<reply res')
  })

  it('picks the machine MSXgl’s own run step would', () => {
    const project = defaultProject('g')
    expect(openmsxMachine(project)).toBe('C-BIOS_MSX1_EU')
    expect(openmsxMachine({ ...project, machine: '2' as never })).toBe('C-BIOS_MSX2_EU')
    expect(openmsxMachine({ ...project, machine: '2P' as never, emulator: { ...project.emulator, hz60: true } })).toBe('C-BIOS_MSX2+_JP')
    expect(openmsxMachine({ ...project, emulator: { ...project.emulator, openmsxMachine: 'Panasonic_FS-A1GT' } })).toBe('Panasonic_FS-A1GT')
  })

  it('launches a ROM in the cartridge slot and a disk in drive A, with the project’s extensions, under stdio control', () => {
    const project = { ...defaultProject('g'), emulator: { ...defaultProject('g').emulator, ext: { ...defaultProject('g').emulator.ext, scc: true } } }
    expect(launchArgs(project, '/p/out/g.rom')).toEqual(['-machine', 'C-BIOS_MSX1_EU', '-ext', 'scc', '-cart', '/p/out/g.rom', '-control', 'stdio'])
    expect(launchArgs(defaultProject('g'), '/p/out/g.dsk')).toContain('-diska')
  })

  it('reads bytes with a Tcl loop and names keys by their matrix position', () => {
    expect(peekCommand('vram', 0x1800, 4)).toContain('[vpeek [expr {6144 + $i}]]')
    expect(peekCommand('memory', 0xc000, 2)).toContain('[peek [expr {49152 + $i}]]')
    expect(tclNumbers(' 1 22 255\n')).toEqual([1, 22, 255])
    expect(matrixKey('space')).toEqual([8, 0x01])
    expect(matrixKey('Right')).toEqual([8, 0x80])
    expect(matrixKey('nope')).toBeNull()
  })
})

/** A stand-in openMSX: reads commands from stdin, answers from a script. */
function fakeOpenmsx(answer: (command: string) => string): { spawn: () => ChildProcess; child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } } {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => child.emit('exit', null) })
  let input = ''
  child.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString()
    for (let match = /<command>([\s\S]*?)<\/command>/.exec(input); match; match = /<command>([\s\S]*?)<\/command>/.exec(input)) {
      input = input.slice(match.index + match[0].length)
      const reply = answer(match[1])
      // Split across two writes, the way a pipe may deliver it.
      child.stdout.write(reply.slice(0, 5))
      child.stdout.write(reply.slice(5))
    }
  })
  return { spawn: () => child as unknown as ChildProcess, child }
}

describe('an openMSX session', () => {
  it('answers commands in order, and turns a refusal into an error with openMSX’s words', async () => {
    const fake = fakeOpenmsx((command) =>
      command.startsWith('bad') ? '<reply result="nok">invalid command name "bad"</reply>' : `<reply result="ok">${command.length}</reply>`
    )
    const session = new OpenMsxSession(fake.spawn)
    session.start('openmsx', [], {}, { machine: 'C-BIOS_MSX1_EU', media: 'out/g.rom' })
    expect(session.current).toEqual({ running: true, machine: 'C-BIOS_MSX1_EU', media: 'out/g.rom' })
    const [a, b] = await Promise.all([session.command('abc'), session.command('abcdef')])
    expect([a, b]).toEqual(['3', '6'])
    await expect(session.command('bad')).rejects.toThrow('invalid command name "bad"')
  })

  it('fails waiting commands when openMSX exits, and refuses new ones', async () => {
    const fake = fakeOpenmsx(() => '')
    const session = new OpenMsxSession(fake.spawn)
    session.start('openmsx', [], {}, { machine: 'm', media: 'r' })
    const waiting = session.command('screenshot')
    fake.child.emit('exit', 1)
    await expect(waiting).rejects.toThrow('openMSX exited (code 1)')
    expect(session.current.running).toBe(false)
    await expect(session.command('reset')).rejects.toThrow('not running')
  })
})
