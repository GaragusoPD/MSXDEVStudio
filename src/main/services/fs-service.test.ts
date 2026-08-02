import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FsService } from './fs-service'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fs-service-'))
  tmpDirs.push(dir)
  return dir
}

describe('FsService binary read/write (Spec 10 source images)', () => {
  it('round-trips arbitrary bytes untouched — text read/write would corrupt these', async () => {
    const root = scratch()
    const service = new FsService(() => null)
    await service.setRoot(root)

    // Every byte value, including ones that are invalid/lossy through a UTF-8 round-trip.
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    await service.writeBinary('art.png', bytes.buffer)

    const back = new Uint8Array(await service.readBinary('art.png'))
    expect(back).toEqual(bytes)

    await service.dispose()
  })
})
