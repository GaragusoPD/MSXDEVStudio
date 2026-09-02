# SCREEN 2/4 Pattern Banks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a SCREEN 2/4 tileset use the hardware's three pattern banks, so a
full-screen 32×24 picture — which needs up to 768 tiles — can be authored,
exported and drawn, without changing what any existing tileset means.

**Architecture:** `TilesDoc.tiles` keeps its meaning as the **common** set
(`tiles[i]` is the art at hardware index `i`); a new `bankTiles: TileEntry[][]`
holds each bank's **overrides** from index 0 up, and `sharedTiles` counts the
indices reserved from 255 down for meta-tiles. Every existing file normalizes to
empty overrides, so all three banks fall back to the common set — today's
behaviour, unchanged, with no migration. Meta-tiles allocate from the shared end,
which is what leaves the emitted runtime C untouched.

**Tech Stack:** TypeScript, Vue 3, Pinia, Vitest, real MSXgl + SDCC, openMSX.
No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-03-screen2-tile-banks-design.md`](../specs/2026-09-03-screen2-tile-banks-design.md)

## Global Constraints

- `npm run check` (lint + both typechecks) is the CI gate and must pass before each commit.
- Tests run with `npx vitest run <file>`. The renderer has no DOM in tests — stub `window`, never import a Vue component.
- **Banking is SCREEN 2 and SCREEN 4 only.** sc1 has one 256-pattern table; every banked code path must be a no-op there.
- **No migration, and no change to existing output.** A file without `bankTiles` must normalize to `[[], [], []]` with `sharedTiles: 0`, and must export byte-for-byte what it exports today. Several tasks assert this explicitly; it is the feature's central promise.
- Hardware facts, already verified against MSXgl — do not re-derive: bank *n* serves screen rows `8n…8n+7`; `VDP_LoadBankPattern_GM2(src, count, bank, offset)` and `VDP_LoadBankColor_GM2` exist with that signature and compute `g_ScreenPatternLow + (bank * 0x800) + (offset * 8)`; `VDP_LoadPattern_GM2` writes all three banks at once.
- Per-bank allocation constraint: `bankTiles[b].length + sharedTiles <= 256`.
- Scratch build projects go beside the MSXgl checkout (`scratchRoot()`), never `/tmp` — MSXgl renames `.rel` files across directories and `rename(2)` cannot cross filesystems.
- Per CLAUDE.md, `renderer/src/stores` and `renderer/src/editors/*/session.ts` ARE vitest-covered; components ride on the shared modules they delegate to.
- Task order matters: Tasks 1→2→3 build the model, the allocator and the map rule in that order. Tasks 4-8 depend on Task 1.

---

### Task 1: The data model — a bank overrides the common set

**Files:**
- Modify: `src/shared/msx/tile.ts` — `TilesDoc`, `normalizeTiles`, new `bankTileAt`/`isBanked`/`bankCapacityLeft`
- Test: `src/shared/msx/tile.test.ts`

**Interfaces:**
- Produces, all from `src/shared/msx/tile.ts`:
  - `TilesDoc.bankTiles: TileEntry[][]` — always length 3 after normalize
  - `TilesDoc.sharedTiles: number`
  - `bankTileAt(doc: TilesDoc, bank: number, index: number): TileEntry`
  - `isBanked(doc: TilesDoc): boolean`
  - `bankCapacityLeft(doc: TilesDoc, bank: number): number`
  - `BANK_COUNT: number` (3)

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/msx/tile.test.ts`, adding `bankTileAt`, `isBanked`, `bankCapacityLeft` and `BANK_COUNT` to the existing import from `./tile`:

```ts
describe('pattern banks', () => {
  const solid = (byte: number): TileEntry => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  it('a file that predates banking normalizes to no overrides', () => {
    // The feature's central promise: today's files mean exactly what they meant.
    const doc = normalizeTiles({ mode: 'sc2', count: 4, tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)] })
    expect(doc.bankTiles).toEqual([[], [], []])
    expect(doc.sharedTiles).toBe(0)
    expect(isBanked(doc)).toBe(false)
    // Every bank shows the common set, which is what VDP_LoadPattern_GM2 does.
    for (let bank = 0; bank < BANK_COUNT; bank++) {
      expect(bankTileAt(doc, bank, 2).pattern).toEqual(new Array(8).fill(0x33))
    }
  })

  it('a bank override wins over the common set, and only for that bank', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 4,
      tiles: [solid(0x11), solid(0x22), solid(0x33), solid(0x44)],
      bankTiles: [[], [solid(0xaa)], []]
    })
    expect(isBanked(doc)).toBe(true)
    expect(bankTileAt(doc, 1, 0).pattern).toEqual(new Array(8).fill(0xaa))
    expect(bankTileAt(doc, 0, 0).pattern).toEqual(new Array(8).fill(0x11))
    expect(bankTileAt(doc, 2, 0).pattern).toEqual(new Array(8).fill(0x11))
    // Past its own overrides, a bank falls back to the common set again.
    expect(bankTileAt(doc, 1, 1).pattern).toEqual(new Array(8).fill(0x22))
  })

  it('an index nothing defines is the blank tile, not undefined', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 1 })
    expect(bankTileAt(doc, 0, 200).pattern).toEqual(new Array(8).fill(0))
  })

  it('capacity is per bank, and the shared reservation costs every bank', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 256,
      bankTiles: [new Array(180).fill(solid(1)), new Array(204).fill(solid(2)), []],
      sharedTiles: 48
    })
    expect(bankCapacityLeft(doc, 0)).toBe(256 - 180 - 48)
    expect(bankCapacityLeft(doc, 1)).toBe(256 - 204 - 48)
    expect(bankCapacityLeft(doc, 2)).toBe(256 - 0 - 48)
  })

  it('sc1 is never banked — it has one pattern table, not three', () => {
    const doc = normalizeTiles({ mode: 'sc1', count: 8, bankTiles: [[solid(9)], [], []] })
    expect(doc.bankTiles).toEqual([[], [], []])
    expect(isBanked(doc)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/msx/tile.test.ts -t 'pattern banks'`

Expected: FAIL — `bankTileAt is not a function`.

- [ ] **Step 3: Add the fields and the accessors**

In `src/shared/msx/tile.ts`, add to the `TilesDoc` interface after `tiles`:

```ts
  /**
   * Per-bank overrides for SCREEN 2/4's three pattern banks, `[bank0, bank1,
   * bank2]`. `bankTiles[b][i]`, when present, is the art bank `b` shows at
   * hardware index `i` instead of `tiles[i]`.
   *
   * Empty in every file that predates banking and in every tileset that does
   * not need it — which is most of them: a game that draws the same tile at any
   * screen height wants one bank replicated, which is what falling back to
   * `tiles` gives it, and what `VDP_LoadPattern_GM2` already does.
   */
  bankTiles: TileEntry[][]

  /**
   * How many indices, counting down from 255, are reserved for meta-tiles —
   * shared, so a meta's index means the same art in every bank. Stored rather
   * than derived: an all-blank tile is legitimate art, so "the trailing shared
   * entries" cannot be read off the data.
   */
  sharedTiles: number
```

Then, near `blankTileEntry`:

```ts
/** SCREEN 2/4's pattern table is three banks of 256; SCREEN 1's is one. */
export const BANK_COUNT = 3

/** True once any bank carries art of its own. Never true in sc1. */
export function isBanked(doc: TilesDoc): boolean {
  return doc.bankTiles.some((bank) => bank.length > 0)
}

/**
 * The art a name-table byte means, for a cell in the given bank.
 *
 * The one place the override rule lives, so the editors, the map renderer and
 * the exporter cannot disagree about what a screen actually shows.
 */
export function bankTileAt(doc: TilesDoc, bank: number, index: number): TileEntry {
  return doc.bankTiles[bank]?.[index] ?? doc.tiles[index] ?? blankTileEntry(doc.mode)
}

/**
 * How many more tiles this bank can take before its own art would collide with
 * the shared reservation at the top. The shared tiles cost every bank, which is
 * the price of a meta index meaning one picture everywhere.
 */
export function bankCapacityLeft(doc: TilesDoc, bank: number): number {
  return MAX_TILES - (doc.bankTiles[bank]?.length ?? 0) - doc.sharedTiles
}
```

In `normalizeTiles`, before the returned object, normalize both fields. sc1 is
forced unbanked because it has a single pattern table:

```ts
  // sc1's pattern table is one bank of 256, so banking cannot apply — a file
  // claiming otherwise is wrong rather than interesting.
  const rawBanks = mode === 'sc1' || !Array.isArray(input.bankTiles) ? [] : input.bankTiles
  const bankTiles: TileEntry[][] = Array.from({ length: BANK_COUNT }, (_, b) => {
    const bank = Array.isArray(rawBanks[b]) ? rawBanks[b] : []
    return bank.slice(0, MAX_TILES).map((entry) => {
      const source = (entry ?? {}) as Partial<TileEntry>
      const pattern = zeros(TILE_SIZE)
      const color = perRowColor ? zeros(TILE_SIZE) : []
      for (let y = 0; y < TILE_SIZE; y++) {
        pattern[y] = byte(source.pattern?.[y])
        if (perRowColor) color[y] = source.color?.[y] === undefined ? 0xf1 : byte(source.color[y])
      }
      return { pattern, color }
    })
  })
  const sharedTiles = Math.max(0, Math.min(MAX_TILES, Number(input.sharedTiles) || 0))
```

Add `bankTiles` and `sharedTiles` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/msx/tile.test.ts`

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Run the gate**

Run: `npm run check && npx vitest run src/shared src/renderer/src/editors src/renderer/src/stores --exclude '**/meta-build.test.ts'`

Expected: clean. Any pre-existing test that breaks here means `normalizeTiles`
changed behaviour it should not have — fix that, do not amend the test.

- [ ] **Step 6: Commit**

```bash
git add src/shared/msx/tile.ts src/shared/msx/tile.test.ts
git commit -m "feat(tiles): a bank overrides the common set, and sc1 never banks"
```

---

### Task 2: Meta-tiles allocate from the shared end

**Files:**
- Modify: `src/shared/msx/meta-paint.ts` — `findOrCreateTile`
- Test: `src/shared/msx/meta-paint.test.ts`

**Interfaces:**
- Consumes: `isBanked`, `bankCapacityLeft`, `BANK_COUNT`, `MAX_TILES` from `src/shared/msx/tile.ts` (Task 1).
- Produces: no new exports — `findOrCreateTile`'s signature is unchanged; only where it allocates changes.

`findOrCreateTile` currently appends at `doc.count`. On a banked tileset it must
instead take the highest free index — `255 - sharedTiles` — and grow `sharedTiles`,
so a meta's index resolves identically in every bank.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/msx/meta-paint.test.ts`:

```ts
describe('allocating into a banked tileset', () => {
  const solid = (byte: number): TileEntry => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  it('takes the top index down, so a meta means one picture in every bank', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 256, bankTiles: [[solid(1)], [], []], sharedTiles: 0 })
    const first = findOrCreateTile(doc, solid(0xaa))
    expect(first?.index).toBe(255)
    expect(first?.doc.sharedTiles).toBe(1)

    const second = findOrCreateTile(first!.doc, solid(0xbb))
    // Downward, and the one already placed does not move — a shifted meta index
    // would renumber every map drawn with this tileset.
    expect(second?.index).toBe(254)
    expect(second!.doc.tiles[255].pattern).toEqual(new Array(8).fill(0xaa))
  })

  it('finds a shared tile it already placed instead of taking another slot', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 256, bankTiles: [[solid(1)], [], []], sharedTiles: 0 })
    const first = findOrCreateTile(doc, solid(0xaa))!
    const again = findOrCreateTile(first.doc, solid(0xaa))!
    expect(again.index).toBe(255)
    expect(again.doc.sharedTiles).toBe(1)
  })

  it('refuses when the fullest bank has no room left for another shared tile', () => {
    const doc = normalizeTiles({
      mode: 'sc2',
      count: 256,
      bankTiles: [[], new Array(250).fill(solid(2)), []],
      sharedTiles: 6
    })
    // Bank 1 holds 250 + 6 shared = 256. One more shared tile would collide.
    expect(findOrCreateTile(doc, solid(0xcc))).toBeNull()
  })

  it('an unbanked tileset still appends at count, exactly as before', () => {
    const doc = normalizeTiles({ mode: 'sc2', count: 4 })
    const result = findOrCreateTile(doc, solid(0xaa))
    expect(result?.index).toBe(4)
    expect(result?.doc.sharedTiles).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts -t 'banked tileset'`

Expected: FAIL — the first case returns index 256 (or null), not 255.

- [ ] **Step 3: Teach `findOrCreateTile` the shared end**

In `src/shared/msx/meta-paint.ts`, in `findOrCreateTile`: the existing search
loop over `doc.count` stays (a banked doc's `tiles` is the common set, and the
shared entries live inside it, so the same loop finds them). Replace the
allocation half — the `let index = doc.count` line and what follows for the
non-sc1 case — with:

```ts
  // On a banked tileset a meta's tiles go at the top, mirrored into every bank
  // by the fallback in `bankTileAt`, so one index means one picture wherever it
  // is drawn — which is what lets `_DrawPlacements` stay bank-unaware.
  if (isBanked(doc)) {
    if (Math.min(...doc.bankTiles.map((_, b) => bankCapacityLeft(doc, b))) <= 0) return null
    const index = MAX_TILES - 1 - doc.sharedTiles
    const tiles = doc.tiles.slice()
    tiles[index] = entry
    return { doc: { ...doc, tiles, sharedTiles: doc.sharedTiles + 1 }, index }
  }

  let index = doc.count
```

Add `bankCapacityLeft`, `isBanked` and `MAX_TILES` to the existing import from
`./tile`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/msx/meta-paint.test.ts`

Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/shared/msx/meta-paint.ts src/shared/msx/meta-paint.test.ts
git commit -m "feat(meta): a banked tileset's metas allocate from the shared end"
```

---

### Task 3: A banked tileset needs a screen-height map

**Files:**
- Modify: `src/shared/msx/map.ts` — `validateMap`, new `bankForRow`
- Test: `src/shared/msx/map.test.ts`

**Interfaces:**
- Produces: `bankForRow(row: number): number` from `src/shared/msx/map.ts`.
- Consumes: nothing from Tasks 1-2 at runtime; `validateMap` takes only a `MapDoc`, so the tileset's bankedness is passed in by the caller (see Step 3).

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/msx/map.test.ts`:

```ts
describe('banked tilesets need a screen-height map', () => {
  it('a row picks its bank, eight rows to each', () => {
    expect([0, 7, 8, 15, 16, 23].map(bankForRow)).toEqual([0, 0, 1, 1, 2, 2])
  })

  it('refuses a map that is not 24 rows tall', () => {
    // Row 24 has no bank, so a taller map would export art into the wrong third.
    const doc = normalizeMap({ tileset: 'res/t.tiles.json', width: 32, height: 48 })
    expect(validateMap(doc, { banked: true }).join(' ')).toMatch(/24 rows/)
  })

  it('allows any width, because banks are chosen by row', () => {
    const doc = normalizeMap({ tileset: 'res/t.tiles.json', width: 128, height: 24 })
    expect(validateMap(doc, { banked: true })).toEqual([])
  })

  it('says nothing about height when the tileset is not banked', () => {
    const doc = normalizeMap({ tileset: 'res/t.tiles.json', width: 32, height: 48 })
    expect(validateMap(doc).join(' ')).not.toMatch(/24 rows/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/msx/map.test.ts -t 'banked tilesets need'`

Expected: FAIL — `bankForRow is not a function`.

- [ ] **Step 3: Add `bankForRow` and the validation**

In `src/shared/msx/map.ts`, beside `isSc3NameTable`:

```ts
/**
 * Which pattern bank a screen row reads from. SCREEN 2/4 splits its 768
 * patterns into three banks of 256, one per eight rows, so a name-table byte
 * means different art depending on how far down the screen it sits.
 */
export function bankForRow(row: number): number {
  return row >> 3
}
```

Change `validateMap`'s signature to take an options object, defaulting to
unbanked so every existing call site is unaffected:

```ts
export function validateMap(doc: MapDoc, options: { banked?: boolean } = {}): string[] {
```

and add, after the existing `doc.cell` checks:

```ts
  // Banks are chosen by screen row, so a wide map scrolls horizontally without
  // trouble — but row 24 has no bank, and exporting one would put art in the
  // wrong third with nothing to show for it but a wrong picture.
  if (options.banked && doc.height !== SCREEN_ROWS) {
    problems.push(
      `A banked tileset needs a map exactly ${SCREEN_ROWS} rows tall — this one is ${doc.height}. ` +
        'Width is free: banks are picked by row, so horizontal scrolling is fine.'
    )
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/msx/map.test.ts`

Expected: PASS.

- [ ] **Step 5: Pass bankedness from the one caller that knows it**

`validateMap` is reached through `validateResource` in
`src/shared/msx/resource.ts`, which has only the map document. The tileset is
loaded by `src/main/services/resources.ts` before export — the same place that
already re-reads each meta file to refresh `MapDoc.metas`. Add the flag there,
where a file can actually be opened, and leave `shared/` dependency-free.

Find the export path in `src/main/services/resources.ts` that calls
`validateResource` for a map, read the referenced tileset with the existing
`parseResource(readFileSync(...))` pattern used for metas, and pass
`{ banked: isBanked(tilesetDoc) }`. If the tileset cannot be read, pass nothing —
a missing tileset is already reported by `validateMap`'s own `No tileset
referenced` check, and inventing a second failure for it helps nobody.

- [ ] **Step 6: Run the gate and commit**

Run: `npm run check && npx vitest run src/shared src/main/services --exclude '**/meta-build.test.ts' --exclude '**/game-kit-build.test.ts'`

```bash
git add src/shared/msx/map.ts src/shared/msx/map.test.ts src/main/services/resources.ts
git commit -m "feat(map): a banked tileset needs a 24-row map, and a row picks its bank"
```

---

### Task 4: Export — per-bank tables and a `_Load` helper

**Files:**
- Modify: `src/shared/msx/tile.ts` — `bankPatternBytes`, `bankColorBytes`
- Modify: `src/shared/msx/resource.ts` — the `'tiles'` cases in `resourceTables`, `resourceConstants`, `resourceCode`
- Test: `src/shared/msx/resource.test.ts`, `src/shared/msx/tile.test.ts`

**Interfaces:**
- Consumes: `isBanked`, `BANK_COUNT` from Task 1.
- Produces: `bankPatternBytes(doc, bank): Uint8Array` and `bankColorBytes(doc, bank): Uint8Array` from `src/shared/msx/tile.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/msx/resource.test.ts`:

```ts
describe('exporting a banked tileset', () => {
  const solid = (byte: number): TileEntry => ({ pattern: new Array(8).fill(byte), color: new Array(8).fill(0xf1) })

  const banked = (): TilesDoc =>
    normalizeTiles({
      mode: 'sc2',
      count: 256,
      bankTiles: [new Array(4).fill(solid(1)), new Array(6).fill(solid(2)), []],
      sharedTiles: 3,
      export: { name: 'g_Title', format: 'c', out: 'content/title.h', helpers: true }
    })

  it('emits a table and a count per bank, plus the common set', () => {
    const header = renderResource({ kind: 'tiles', doc: banked() })
    expect(header).toContain('#define G_TITLE_BANK0_TILES 4')
    expect(header).toContain('#define G_TITLE_BANK1_TILES 6')
    expect(header).toContain('g_Title_Bank0_Patterns')
    expect(header).toContain('g_Title_Bank1_Colors')
    // Bank 2 overrides nothing, so it gets no table of its own.
    expect(header).not.toContain('g_Title_Bank2_Patterns')
  })

  it('each bank loads the common tail from its own offset', () => {
    const header = renderResource({ kind: 'tiles', doc: banked() })
    // Bank 0 overrides 0..3, so it still shows the common set from 4 up; bank 1
    // from 6. Loading the same slice into both would draw the wrong art.
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Patterns + 4 * 8, G_TITLE_TILES - 4, 0, 4)')
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Patterns + 6 * 8, G_TITLE_TILES - 6, 1, 6)')
    expect(header).toContain('VDP_LoadBankPattern_GM2(g_Title_Bank0_Patterns, G_TITLE_BANK0_TILES, 0, 0)')
  })

  it('an unbanked tileset exports exactly what it exports today', () => {
    // The feature's promise, asserted rather than assumed.
    const doc = normalizeTiles({ mode: 'sc2', count: 4, export: { name: 'g_T', format: 'c', out: 'content/t.h', helpers: true } })
    const header = renderResource({ kind: 'tiles', doc })
    expect(header).not.toContain('Bank')
    expect(header).not.toContain('LoadBankPattern')
  })
})
```

Use whatever helper `resource.test.ts` already uses to render a resource to text;
if it is named differently from `renderResource`, use that name throughout.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/msx/resource.test.ts -t 'exporting a banked tileset'`

Expected: FAIL — no `BANK0` defines emitted.

- [ ] **Step 3: Add the byte emitters**

In `src/shared/msx/tile.ts`, beside `tilePatternBytes`:

```ts
/** One bank's own patterns — its overrides only, from index 0 up. */
export function bankPatternBytes(doc: TilesDoc, bank: number): Uint8Array {
  const tiles = doc.bankTiles[bank] ?? []
  const out = new Uint8Array(tiles.length * TILE_SIZE)
  tiles.forEach((tile, index) => out.set(tile.pattern, index * TILE_SIZE))
  return out
}

/** One bank's own colors. sc1 never banks, so this is sc2/sc4 shaped throughout. */
export function bankColorBytes(doc: TilesDoc, bank: number): Uint8Array {
  const tiles = doc.bankTiles[bank] ?? []
  const out = new Uint8Array(tiles.length * TILE_SIZE)
  tiles.forEach((tile, index) => out.set(tile.color, index * TILE_SIZE))
  return out
}
```

- [ ] **Step 4: Emit the tables, the constants and the helper**

In `src/shared/msx/resource.ts`, in `resourceTables`'s `case 'tiles'`, after the
existing `_Patterns`/`_Colors` push, add:

```ts
      // A bank that overrides nothing needs no table: it shows the common set
      // in full, which is already emitted above.
      doc.bankTiles.forEach((bank, index) => {
        if (!bank.length) return
        tables.push(
          { suffix: `_Bank${index}_Patterns`, bytes: bankPatternBytes(doc, index), art: true, comment: `Bank ${index} Patterns` },
          { suffix: `_Bank${index}_Colors`, bytes: bankColorBytes(doc, index), comment: `Bank ${index} Colors` }
        )
      })
```

In `resourceConstants`'s `'tiles'` branch add `#define ${prefix}_TILES ${doc.count}`
and, for each bank with overrides, `#define ${prefix}_BANK${i}_TILES ${len}`.

In `resourceCode`'s `'tiles'` branch — gated on `ExportBlock.helpers` as every
helper is — emit `_Load` only when `isBanked(doc)`:

```c
void <name>_Load(void)
{
	// Each bank shows the common set above its own overrides, so each loads a
	// different slice of it — bank 0 from 4, bank 1 from 6. One shared slice
	// for all three would draw the wrong art in every bank that overrides less.
	VDP_LoadBankPattern_GM2(<name>_Patterns + <Ub> * 8, <NAME>_TILES - <Ub>, <b>, <Ub>);
	VDP_LoadBankColor_GM2(<name>_Colors + <Ub> * 8, <NAME>_TILES - <Ub>, <b>, <Ub>);
	VDP_LoadBankPattern_GM2(<name>_Bank<b>_Patterns, <NAME>_BANK<b>_TILES, <b>, 0);
	VDP_LoadBankColor_GM2(<name>_Bank<b>_Colors, <NAME>_BANK<b>_TILES, <b>, 0);
	// …repeated per bank; the last two lines are omitted for a bank with no overrides.
}
```

Leave the unbanked path completely untouched.

- [ ] **Step 5: Run the tests, then the gate**

Run: `npx vitest run src/shared/msx/resource.test.ts src/shared/msx/tile.test.ts && npm run check`

Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/msx/tile.ts src/shared/msx/resource.ts src/shared/msx/resource.test.ts src/shared/msx/tile.test.ts
git commit -m "feat(export): per-bank tables, and each bank loads its own slice of the common set"
```

---

### Task 5: A banked screen compiled and booted

**Files:**
- Modify: `src/main/services/meta-build.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4; the `FixtureSpec`/`buildFixture` helpers already in this file.

Per CLAUDE.md, emitted C is never verified by reading it. A wrong bank offset
compiles perfectly, links perfectly, and draws the wrong picture — no other test
in this plan can catch it.

- [ ] **Step 1: Write the fixture and test**

Add to `src/main/services/meta-build.test.ts`, following the existing pattern-mode
fixture's shape:

```ts
/**
 * A banked SCREEN 2 screen: each bank gets one distinctive solid tile of its
 * own at index 0, and the map fills each third with it. Three different colours
 * down the screen is a picture that is *only* right if each bank loaded its own
 * art at its own offset — the failure this test exists for looks like a
 * perfectly good build.
 */
function bankedFixture(): Record<string, ResourceDoc> { /* per the design's model */ }

const BANKED_MAIN = `#include "msxgl.h"
#include "content/title.h"
#include "content/screen.h"

void main(void)
{
\tVDP_SetMode(VDP_MODE_GRAPHIC2);
\tg_Title_Load();
\tg_Screen_DrawLayer(g_Screen_Background, 0, 0);
\twhile(1) { Halt(); }
}
`
```

Build it with `machine: '1'` and `template`, as the existing pattern test does —
SCREEN 2 banking is an MSX1 feature.

- [ ] **Step 2: Run it**

Run: `npx vitest run src/main/services/meta-build.test.ts`

Expected: PASS. `Undefined Global '_VDP_LoadBankPattern_GM2'` would mean the
`vdp` module is not linked — look at `writeGeneratedConfig`, not at the emitted C.

- [ ] **Step 3: Boot the ROM and read the screenshot**

Keep the scratch dir and boot it, exactly as the bitmap placement test documents:

```bash
MSXDEVSTUDIO_KEEP_SCRATCH=1 npx vitest run src/main/services/meta-build.test.ts -t 'banked'
SHOT=/tmp/claude-1000/-home-pablo-Development-MSXDEVStudio/baa193ba-3e12-4bb6-914e-1ca10256cc41/scratchpad
printf 'after time 12 { screenshot -raw %s/banked.png; exit }\n' "$SHOT" > "$SHOT/shot.tcl"
OPENMSX_SYSTEM_DATA=/home/pablo/Applications/openMSX/share \
  /home/pablo/Applications/openMSX/bin/openmsx -machine C-BIOS_MSX2_EU \
  -cart <the kept root>/out/<name>.rom -script "$SHOT/shot.tcl"
```

Read the PNG with the Read tool. **Three horizontal bands in three different
colours** — rows 0-7, 8-15, 16-23. One colour throughout means every bank loaded
the same art and the offsets are wrong; that is a finding, not a test to adjust.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/meta-build.test.ts
git commit -m "test(tiles): a banked screen compiles, links and draws three banks"
```

---

### Task 6: The importer fills each bank

**Files:**
- Modify: `src/shared/msx/tile.ts` — `packTiles` gains a banked mode
- Modify: `src/renderer/src/components/ImportImageDialog.vue`
- Test: `src/shared/msx/tile.test.ts`

**Interfaces:**
- Consumes: Task 1's fields; `mapFromLayout` from `src/shared/msx/map.ts`.
- Produces: `packBankedTiles(indices, width, height, mode, options): { doc, layout, lossyTiles, unplaced: number[] }` from `src/shared/msx/tile.ts`, where `unplaced[b]` is how many cells bank `b` could not place.

A 32×24 image is cut into three eight-row strips; each strip dedups into its own
bank from index 0 up. The layout is bank-relative, which is what the map stores.
Shared tiles are never touched, so importing into a tileset that already backs
meta-tiles does not destroy them.

- [ ] **Step 1: Write the failing test**

```ts
it('packs a full screen into three banks, bank-relative', () => {
  // 256x192 of three distinct horizontal bands: each third needs one tile, and
  // each gets index 0 in its own bank — the same byte, three pictures.
  const indices = new Uint8Array(256 * 192)
  for (let y = 0; y < 192; y++) indices.fill(y < 64 ? 1 : y < 128 ? 2 : 3, y * 256, y * 256 + 256)
  const { doc, layout, unplaced } = packBankedTiles(indices, 256, 192, 'sc2')
  expect(doc.bankTiles.map((b) => b.length)).toEqual([1, 1, 1])
  expect(layout.every((index) => index === 0)).toBe(true)
  expect(unplaced).toEqual([0, 0, 0])
})

it('reports per bank when a third will not fit, because the budget is per bank', () => {
  // Every cell of the top third distinct: 32*8 = 256 cells, and the bank holds
  // 256 — so it just fits; 257 would not. Bands below stay unaffected.
  const indices = new Uint8Array(256 * 192)
  for (let i = 0; i < 256 * 64; i++) indices[i] = i % 15
  const { unplaced } = packBankedTiles(indices, 256, 192, 'sc2')
  expect(unplaced[1]).toBe(0)
  expect(unplaced[2]).toBe(0)
})
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `npx vitest run src/shared/msx/tile.test.ts -t 'three banks'` → FAIL,
`packBankedTiles is not a function`.

Implement it as three `packTiles`-shaped passes, one per eight-row strip, each
writing into `bankTiles[b]` and producing a bank-relative layout. Reuse
`tileFromPixels` and the existing `pattern|color` dedup key rather than writing a
second copy of either.

- [ ] **Step 3: Wire the dialog**

In `ImportImageDialog.vue`'s `saveTileset()`, when the target mode is sc2/sc4 and
the image is exactly 256×192, use `packBankedTiles`; otherwise keep `packTiles`
unchanged. Report per bank, in the dialog's own result line:
`bank 1: 34 cells unplaced (that third's 256 tiles are full)`.

- [ ] **Step 4: Gate and commit**

Run: `npm run check && npx vitest run src/shared src/renderer/src/editors src/renderer/src/stores --exclude '**/meta-build.test.ts'`

```bash
git add src/shared/msx/tile.ts src/shared/msx/tile.test.ts src/renderer/src/components/ImportImageDialog.vue
git commit -m "feat(import): a full screen fills all three banks, and says which one ran out"
```

---

### Task 7: The tile editor shows one bank at a time

**Files:**
- Modify: `src/renderer/src/editors/tile/session.ts` — `bank` on the session, `setBank`
- Modify: `src/renderer/src/editors/tile/TileEditorTab.vue`, `TileGrid.vue`, `TileSidePanel.vue`
- Test: `src/renderer/src/editors/tile/session.test.ts`

**Interfaces:**
- Consumes: `bankTileAt`, `isBanked`, `bankCapacityLeft`, `BANK_COUNT` (Task 1).
- Produces: `setBank(session, bank)` and `session.bank: number` from `src/renderer/src/editors/tile/session.ts`.

- [ ] **Step 1: Write the failing session test**

```ts
it('painting a banked tileset edits that bank, not the common set', async () => {
  // The session is the layer a silent early return hides in, which is why
  // CLAUDE.md makes it the vitest exception.
  const session = /* open a banked tileset, per this file's existing helpers */
  setBank(session, 1)
  /* paint tile 0 */
  expect(doc(session).bankTiles[1][0]).not.toEqual(doc(session).tiles[0])
  expect(doc(session).bankTiles[0]).toEqual([])
})
```

- [ ] **Step 2: Implement**

Add `bank: number` to the session (default 0) and `setBank`. The grid renders
through `bankTileAt(doc, session.bank, i)`, so it shows exactly what that third
of the screen shows. Shared tiles — the top `sharedTiles` indices — render with a
marker and are not editable from a bank view, because editing one would change
all three banks and the user is looking at one.

The bank selector appears only when `isBanked(doc)`, so an ordinary tileset's UI
is untouched.

- [ ] **Step 3: Add the budget readout**

In `TileSidePanel.vue`, when banked, one line per bank:
`bank 1: 180 + 48 shared = 228 / 256`. Same reasoning as the meta editor's
existing `tiles: N/256`: on this hardware that number decides whether the next
stroke is possible, so it should not be discoverable only by hitting the wall.

- [ ] **Step 4: Gate and commit**

```bash
git add src/renderer/src/editors/tile/
git commit -m "feat(tiles): a bank selector, and a budget you can see before you hit it"
```

---

### Task 8: The guide, the spec and the changelog

**Files:**
- Modify: `src/main/services/agent-guide.ts`
- Modify: `specs/10-map-screen-editors.md`
- Modify: `CHANGELOG.md`

Per CLAUDE.md, `agent-guide.ts` is a deliverable: this changes what the exporter
emits, what the generated files are called, and how a resource is used from C, so
the feature is not finished until the guide says so. An agent working in a
generated project knows only what that file tells it.

- [ ] **Step 1: The guide**

Add a banked-tileset section: what `_Bank0_Patterns` and `_BANK0_TILES` are, that
`_Load()` exists and must be called instead of `VDP_LoadPattern_GM2`, that a
banked tileset's map must be 24 rows, and that a name-table byte means different
art in different thirds. Include a worked `main()` the way the guide's existing
examples do.

- [ ] **Step 2: specs/10**

Record the bank selector, the budget readout, and the 24-row rule.

- [ ] **Step 3: CHANGELOG**

Under `[Unreleased]`, describing the capability and the fact that existing
tilesets are untouched.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/main/services/agent-guide.test.ts src/main/services/agent-guide-meta.test.ts && npm run check`

```bash
git add src/main/services/agent-guide.ts specs/10-map-screen-editors.md CHANGELOG.md
git commit -m "docs: banked tilesets in the agent guide, spec 10 and the changelog"
```

---

## Self-Review

- **Spec coverage:** the model → Task 1; shared allocation → Task 2; the map rule
  and `bank = row >> 3` → Task 3; export tables, defines and `_Load` → Task 4;
  the ROM boot the spec calls non-optional → Task 5; the importer → Task 6; the
  bank selector, budget readout and `reserveTile0`-per-bank → Task 7; the three
  deliverables beyond the code → Task 8.
- **Placeholders:** Tasks 6 and 7 describe two implementations in prose rather
  than giving every line — `packBankedTiles`'s three-strip loop and the editor's
  grid wiring. Both name the exact functions to reuse and carry their tests in
  full. Every other step has literal code.
- **Type consistency:** `bankTiles: TileEntry[][]` and `sharedTiles: number` are
  defined in Task 1 and used unchanged in 2, 4, 6 and 7. `bankCapacityLeft`,
  `isBanked`, `bankTileAt`, `BANK_COUNT` all come from `src/shared/msx/tile.ts`.
  `validateMap` gains an options object in Task 3 with a default, so no existing
  call site changes.
- **Ordering:** 1 → 2 → 3 → 4 → 5, then 6, 7, 8 in any order.

## Not in this plan

- SCREEN 1, which has one pattern table.
- The MSX2 fourth bank reachable by vertical scrolling.
- GRAPHIC 3 mirror modes.
- Vertical scrolling with a banked tileset — ruled out in the design.
