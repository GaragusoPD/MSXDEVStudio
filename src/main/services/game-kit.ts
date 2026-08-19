/**
 * Scaffolds a game-kit project: kit C under src/, stub res/, first export into
 * content/, same launchers / .msxproj as createProject. Electron-free.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  configPatches,
  GAME_SOURCE_DIR,
  isScrollKit,
  isTiledMode,
  isTextMode,
  kitLibModules,
  kitMapSize,
  kitProjModules,
  type NewGameRequest
} from '../../shared/game-kit'
import type { OpenProject } from '../../shared/ipc'
import { createMapDoc } from '../../shared/msx/map'
import { defaultExport, renderResourceFiles, RESOURCE_DIR, serializeResource, type ResourceDoc } from '../../shared/msx/resource'
import { createSfxDoc } from '../../shared/msx/sfx'
import { createSpritesDoc } from '../../shared/msx/sprite'
import { createTilesDoc } from '../../shared/msx/tile'
import { normalizeProject } from '../../shared/msxproj'
import { agentGuideFiles } from './agent-guide'
import { emitGameH, emitMainC, emitPlayC, emitScreensC } from './game-kit-c'
import {
  IDE_STATE_DIR,
  launcherScripts,
  PROJECT_EXT,
  saveProject,
  templateDirFor
} from './project'

/** Replace `#define NAME <old>` with `#define NAME <value>`. Throws if NAME is missing. */
export function patchConfigDefines(source: string, patches: Record<string, string>): string {
  let out = source
  for (const [name, value] of Object.entries(patches)) {
    const re = new RegExp(`^(#define\\s+${name}\\s+)\\S+`, 'm')
    if (!re.test(out)) throw new Error(`msxgl_config.h has no ${name} to patch`)
    out = out.replace(re, `$1${value}`)
  }
  return out
}

export function createGameProject(request: NewGameRequest, msxglPath: string): OpenProject {
  const root = join(request.location, request.name)
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`"${root}" already exists and is not empty`)
  }

  const template = join(msxglPath, 'projects', templateDirFor(request.machine))
  if (!existsSync(join(template, 'template.c'))) {
    throw new Error(`MSXgl template not found at ${template}`)
  }

  mkdirSync(join(root, 'content'), { recursive: true })
  mkdirSync(join(root, RESOURCE_DIR), { recursive: true })
  mkdirSync(join(root, GAME_SOURCE_DIR), { recursive: true })

  const header = readFileSync(join(template, 'msxgl_config.h'), 'utf-8')
  writeFileSync(join(root, 'msxgl_config.h'), patchConfigDefines(header, configPatches(request)), 'utf-8')
  writeFileSync(join(root, '.gitignore'), `out/\nemul/\n${IDE_STATE_DIR}/\n`, 'utf-8')

  for (const script of launcherScripts(msxglPath)) {
    const path = join(root, script.name)
    writeFileSync(path, script.content, 'utf-8')
    if (script.exec) chmodSync(path, 0o755)
  }

  writeFileSync(join(root, 'main.c'), emitMainC(request), 'utf-8')
  writeFileSync(join(root, GAME_SOURCE_DIR, 'game.h'), emitGameH(request), 'utf-8')
  writeFileSync(join(root, GAME_SOURCE_DIR, 'play.c'), emitPlayC(request), 'utf-8')
  writeFileSync(join(root, GAME_SOURCE_DIR, 'screens.c'), emitScreensC(request), 'utf-8')

  writeStubResources(root, request)

  const project = normalizeProject(
    {
      name: request.name,
      machine: request.machine,
      target: request.target,
      romSize: request.romSize,
      libModules: kitLibModules(request),
      projModules: kitProjModules()
    },
    request.name
  )
  for (const file of agentGuideFiles(project, msxglPath, request)) {
    writeFileSync(join(root, file.name), file.content, 'utf-8')
  }
  return saveProject(root, `${request.name}${PROJECT_EXT}`, project)
}

function writeResource(root: string, relative: string, resource: ResourceDoc): void {
  const dest = join(root, ...relative.split('/'))
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, serializeResource(resource), 'utf-8')
  const block = 'doc' in resource ? resource.doc.export ?? defaultExport(relative) : defaultExport(relative)
  const files = renderResourceFiles(resource, relative, block)
  if (files.header) writeFileSync(join(root, block.out), files.header, 'utf-8')
  if (files.source) {
    const cPath = block.out.replace(/\.h$/i, '.c')
    writeFileSync(join(root, cPath), files.source, 'utf-8')
  }
}

function withExport<T extends { export: ResourceDoc['doc']['export'] }>(doc: T, path: string): T {
  return { ...doc, export: defaultExport(path) }
}

/**
 * Editable starting points for the kit: one sprite, and (in a tiled mode) a
 * tileset with a map. Deliberately **no** bitmap-mode picture — a SCREEN 5
 * screen is 27 KB, which does not fit in the 32 KB the ASCII-8 mapper pages in
 * at boot; shipping one means a raw file placed on a segment boundary, the way
 * `demo_msx2` does it. The stub fills the picture area instead and says so.
 */
function writeStubResources(root: string, request: NewGameRequest): void {
  if (request.kit === 'text' || isTextMode(request.displayMode)) return

  const spriteMode = request.displayMode === 'sc1' || request.displayMode === 'sc2' || request.displayMode === 'sc3' ? 1 : 2
  const spritePath = `${RESOURCE_DIR}/player.sprites.json`
  const sprites = withExport(createSpritesDoc(spriteMode, 16), spritePath)
  sprites.sprites[0].name = 'player'
  const pattern = sprites.sprites[0].frames[0].layers[0].pattern
  for (let i = 0; i < pattern.length; i++) pattern[i] = 0xff
  writeResource(root, spritePath, { kind: 'sprites', doc: sprites })

  if (isTiledMode(request.displayMode)) {
    const tilePath = request.kit === 'vn' ? `${RESOURCE_DIR}/scene.tiles.json` : `${RESOURCE_DIR}/tiles.tiles.json`
    const tiles = withExport(
      createTilesDoc(request.displayMode === 'sc1' ? 'sc1' : request.displayMode === 'sc4' ? 'sc4' : 'sc2', 8),
      tilePath
    )
    tiles.tiles[1].pattern = new Array(8).fill(0xff)
    tiles.flags[1] = 0x01
    writeResource(root, tilePath, { kind: 'tiles', doc: tiles })

    const mapPath = request.kit === 'vn' ? `${RESOURCE_DIR}/scene.map.json` : `${RESOURCE_DIR}/level.map.json`
    // The same size `configPatches` tells the scroll module about.
    const { width, height } = kitMapSize(request.kit)
    const map = withExport(createMapDoc(tilePath, width, height), mapPath)
    // The visual novel's map *is* the picture area, so it starts filled — the
    // same placeholder panel a bitmap-mode scene gets. Everything else gets two
    // rows of ground to stand on, and a scrolling kit a grid line every 8 cells,
    // without which a moving camera looks like a still one.
    const grid = isScrollKit(request.kit)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const solid =
          request.kit === 'vn' || y >= height - 2 || (grid && (x % 8 === 0 || y % 8 === 0))
        if (solid) map.layers[0].data[y * width + x] = 1
      }
    }
    writeResource(root, mapPath, { kind: 'map', doc: map })
  }

  if (request.audio === 'ayfx') {
    const path = `${RESOURCE_DIR}/sfx.sfx.json`
    writeResource(root, path, { kind: 'sfx', doc: withExport(createSfxDoc(), path) })
  }
}
