# Export to Optimizer — the game's export code

Reactor 2's **Export to Optimizer** button produces one text code holding the
player's whole current state; the player pastes it into the optimizer's
**Import code** dialog, which loads every unlocked island (and resets the locked
ones to their untouched maps), the roster, the Time Lab, the anomaly and any
research in progress.

This is the format's specification. It was written for the game's developer to
implement from, against game 1.1.10, and the game now ships it; every type,
order and encoding rule below is exact. Where something is a recommendation
rather than a rule, it says so.

- **Writer:** the game.
- **Reader:** `packages/solver/src/encoding/gameExport.ts` decodes a code, and
  `packages/solver/src/data/gameImport.ts` maps it onto the optimizer's islands,
  roster and plan.
- **Samples:** `packages/solver/tests/gameExports/` holds real codes the game
  produced, and `tests/gameExport.test.ts` pins the reader against them.

The format follows the style of the optimizer's own layout codes ("blueprints"):
one byte per tile, a building implying grass beneath it, deflate + base64url.
Their codec is
[`blueprint.ts`](https://github.com/OGMods/reactor2-optimizer/blob/main/packages/solver/src/encoding/blueprint.ts),
for reference only — this export does **not** reuse its fixed byte tables; it
uses a palette instead (section 3).

## 1. What the game does

- A button (suggested: in Settings) labelled **Export to Optimizer**.
- On press: build the code (section 4), copy it to the clipboard
  (`GUIUtility.systemCopyBuffer`), show a toast such as
  "Code copied — paste it into the optimizer."
- Optional fallback: open the native Share sheet with the same text.
- The export is **read-only and one-way**. It never modifies the save, and the
  game never imports anything back.
- No personal data: no player id, account name or device data.

## 2. Game facts this spec relies on

Read from the 1.1.10 build, and confirmed against the first real exports: every
coordinate, island boundary, obstacle and transformer in them matches the scene.

- **One scene, one grid.** Scene `level1` has a single isometric `Grid`
  (cell size 0.82 × 0.48). All islands are on it.
- **Three terrain tilemaps** on that grid:
  - `Map Tilemap` — `TileGrass` or `TileWater` per cell.
  - `Trees Tilemap` — obstacles. Four `ObstacleSO`s: `Map_Forest_Coniferous`,
    `Map_Forest_Deciduous`, `Map_Pond`, `Map_Rock`.
  - `CantBuildHere Tilemap` — the transformers (one per island). Its three
    other cells are decorations outside the islands; ignore them.
- **Islands are `Area`s.** Each `Area` has an `AreaSO` id and a
  `PolygonCollider2D` outlining it. Every land cell is inside exactly one
  polygon.

  | Area id  | Scene object     | Land cells |
  | -------- | ---------------- | ---------- |
  | `area_1` | Island Left - 1  | 74         |
  | `area_2` | Island Right - 1 | 90         |
  | `area_3` | Island Left - 2  | 115        |
  | `area_4` | Island Right - 2 | 162        |
  | `area_5` | Island Left - 3  | 180        |
  | `area_6` | Island Right - 3 | 200        |
  | `area_7` | Island Left - 4  | 230        |
  | `area_8` | Island Right - 4 | 265        |

  `area_city` holds no player buildings. **Do not export it.**

- **Player changes live in the save:** cleared obstacles in
  `RemovedObstaclePositions`, clears in progress in `OngoingRemovals`, placed
  buildings in `BuildingSaves`.
- **All upgrades are research.** 76 `ResearchSO`s across domains: 39 building
  nodes (unlocks and tiers, e.g. `research_building_cooler1`), 25 economy, 11
  Time Lab, 1 city. Research in progress is `ResearchManagerSO`'s
  `OngoingResearchData`; several can run at once.
- **Placed buildings have no tier of their own.** They run at the building's
  current research level, so the code does not store a tier per building.
- **Buildings only stand on grass** — never on water, an obstacle or a
  transformer. The format depends on this (section 4.3).

## 3. Definitions

- **Cell** — one Tilemap cell on the shared grid, addressed by integer `(x, y)`
  exactly as `Tilemap.WorldToCell` returns it. If the save stores world
  positions, convert them to cells before writing.
- **Cell's area** — the `Area` whose `PolygonCollider2D` contains the cell's
  centre (`Tilemap.GetCellCenterWorld`). This rule assigns every land cell to
  exactly one area on the 1.1.10 map. If the game already has a cell-to-area
  lookup, use that instead.
- **Palette** — a list of string ids written once near the start of the code.
  Each cell is then stored as **one byte: its index in the palette**. This keeps
  the code short (one byte per cell instead of a name) and means there is no
  fixed number-per-building table to maintain: the ids are the game's own
  strings, and a building added in a future update just appears in the list.
  The palette is part of this format, not something that exists in the game.
- **Level** — the number of levels purchased; `0` means none. Never write a
  0-based index. A building research node at level 0 is a building not yet
  unlocked.
- **Seconds left** — remaining time at the moment of export, as
  `GetRemainingTimeSeconds` (or the equivalent) returns it, rounded down to a
  whole number.

## 4. The code

### 4.1 Envelope

```
R2X1.<payload>
```

- `R2X1.` — literal prefix. `1` is the format version (section 5).
- `<payload>` = base64url( raw deflate( payload bytes ) ).
  - **Raw deflate**: `System.IO.Compression.DeflateStream`, which the 1.1.10
    build already ships. It writes raw deflate (no zlib or gzip header). Use
    `CompressionLevel.Optimal`.
  - **base64url**: standard base64, then replace `+` → `-`, `/` → `_`, and strip
    trailing `=`.
- No checksum. A truncated paste fails to decompress, which is how the importer
  detects it.

### 4.2 Payload bytes

Primitive encodings (what .NET's `BinaryWriter` writes, UTF-8):

| Type     | Bytes                                                     |
| -------- | --------------------------------------------------------- |
| `byte`   | 1                                                         |
| `int16`  | 2, little-endian, signed                                  |
| `uint16` | 2, little-endian                                          |
| `int32`  | 4, little-endian, signed                                  |
| `int64`  | 8, little-endian, signed                                  |
| `double` | 8, IEEE 754, little-endian                                |
| `string` | 7-bit-encoded length (LEB128), then that many UTF-8 bytes |

Seven sections, always present, always in this order (section 7 since game
1.1.11; an older code ends after section 6):

| #   | Section                 | Contents                                                                                                                |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Header                  | `string` game version (`Application.version`) · `string` anomaly id (`"none"` if none) · `byte` anomaly balance version |
| 2   | Palette                 | `byte` count · count × `string` id                                                                                      |
| 3   | Islands                 | `byte` count · per island: see 4.3                                                                                      |
| 4   | Research                | `uint16` count · per `ResearchSO`, all domains: `string` research id · `uint16` level                                   |
| 5   | Research in progress    | `uint16` count · per entry: `string` research id · `uint16` level it will reach · `int32` seconds left                  |
| 6   | Obstacles being cleared | `uint16` count · per entry: `int16` x · `int16` y · `int32` seconds left                                                |
| 7   | Timeline                | see 4.5                                                                                                                 |

Rules:

- **Palette order.** Entries 0–6 are always the terrain, in exactly this order:
  `TileWater`, `TileGrass`, `Map_Rock`, `Map_Forest_Coniferous`,
  `Map_Forest_Deciduous`, `Map_Pond`, `CantBuildHere`. After them, one entry for
  each distinct building id that appears on any exported island, in any order.
  Building ids are the ids the game saves buildings under.
- **Research ids** are the ids the game saves research under (`ResearchId`).
  Write **every** `ResearchSO`, including those at level 0, so a missing id
  always means "this build did not have it".
- **Anomaly balance version** says which balance figures this save's anomaly
  runs under, for anomalies rebalanced after saves already used them (as
  Tidal Ascendancy was). Write `0` if the game keeps no such distinction.

### 4.3 One island

```
string  area id            e.g. "area_3"
byte    flags              bit 0 = unlocked; other bits 0
int16   minX               bounding box of the area's cells
int16   minY
byte    width              maxX - minX + 1
byte    height             maxY - minY + 1
byte[width*height] cells
```

Write all eight areas, `area_1` to `area_8`, locked ones included (their
obstacles matter for planning).

Cell bytes run row by row: outer loop `y` from `minY` to `minY + height - 1`,
inner loop `x` from `minX` to `minX + width - 1`. For each `(x, y)`, the byte is
the palette index of:

1. `TileWater` if the cell's area is not this island;
2. else the building's id, if a building stands on the cell;
3. else the obstacle on `Trees Tilemap`, unless `(x, y)` is in
   `RemovedObstaclePositions`;
4. else `CantBuildHere` if `CantBuildHere Tilemap` has a transformer there;
5. else `TileGrass` or `TileWater` from `Map Tilemap` (no tile = `TileWater`).

A building cell implies grass beneath it, so terrain and buildings share one
grid.

### 4.4 Worked example

A palette of `TileWater, TileGrass, Map_Rock, Map_Forest_Coniferous,
Map_Forest_Deciduous, Map_Pond, CantBuildHere, cooler2, generator7` and this
3 × 2 island:

```
y = minY     : water  grass   rock
y = minY + 1 : grass  cooler2 generator7
```

has the cell bytes `00 01 02 01 07 08`.

### 4.5 Timeline

Where the player's timeline stands, for the optimizer's Chronon tools. In this
order:

| Field               | Type                              | Meaning                                                                                                                                  |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Exported at         | `int64`                           | Moment of export, Unix seconds, UTC: server time once the game has synced, the device clock otherwise                                    |
| Chronon balance     | `int64`                           | Chronons held, unspent                                                                                                                   |
| Timeline energy     | `double`                          | `TimelineEnergyProduced`, online + offline: the `E` of the award                                                                         |
| Timeline elapsed    | `int64`                           | Seconds since the timeline began, on the game's internal clock                                                                           |
| Jump award now      | `int64`                           | The game's own award for a jump now, **without** the first-entry bonus; 0 at zero energy                                                 |
| Anomalies entered   | `uint16` count · count × `string` | Anomalies whose first-entry bonus is spent. Always `tidal_ascendancy`, never `tidal_ascendancy_legacy`: the bonus belongs to the anomaly |
| Timeline generation | `int32`                           | Time Jumps completed, 0 before the first                                                                                                 |
| Cash                | `double`                          | The raw signed balance: negative while building on credit                                                                                |
| Research points     | `double`                          | Research points held                                                                                                                     |
| Stamp source        | `byte`                            | Which clock wrote "Exported at": 0 server time, 1 the device clock (the game had not synced)                                             |

Cash and research points were appended after the first samples, and the stamp
source after them, so a code that ends at any of those fields is a valid, older
section 7. Cash goes **below zero** on
build credit: a purchase is allowed while `cash − cost ≥ −limit`, the limit set by
the Build Credit research in section 4. The caps on both balances also come from
research, and are multiplied while Rush Hour runs.

The award, as the developer gave it:

```
Chronons = max(1, floor(97.34 × (E / 2.82e16)^0.135 × M)) + B
```

`M` is the Chronon Reactor multiplier (its level is in section 4), `B` is 88
on the first entry into an anomaly and 0 otherwise. A jump is allowed once the
award without `B` reaches `min(5000, round(88 × 1.15^generation))`, midpoint
rounded away from zero.

For a save older than the Time Jump feature that has not jumped yet, timeline
energy and elapsed are counted from its first launch after that update; the
two still agree, so energy per second is right.

## 5. Versioning

- The format version is the digit in the `R2X1.` prefix.
- **Appending a new section at the end: no version bump.** The importer reads
  the sections it knows and ignores trailing bytes.
- **Changing, reordering or removing anything: bump the version** (`R2X2.`).
  The importer refuses versions it does not know.
- The game version string in the header tells the importer which building and
  balance tables to use, so an old code still reads correctly.
- **Ids are permanent.** Never reuse or rename a building, research, anomaly
  or area id; add new ids instead.

## 6. Expected size

Measured by encoding the real 1.1.10 map:

| Save                                    | Code length (characters) |
| --------------------------------------- | ------------------------ |
| Fresh save, no buildings                | 2,342                    |
| Mid game, 60% of grass built on         | 2,852                    |
| Late game, boards full                  | 2,985                    |
| Worst case, 42 building kinds at random | 3,342                    |

About 1,100 characters of each code are id strings; the rest is tiles. The
first three real exports came to 2,347–2,460 characters.

## 7. Notes from the first exports

- **The two forests are named the other way round from our tiles.**
  `Map_Forest_Deciduous` is the optimizer's `tree1` and
  `Map_Forest_Coniferous` its `tree2`. Nothing for the game to change; the
  reader maps them.
- **Research ids are the game's, verbatim.** Gas plant's node is
  `research_gas_plant`, not `research_building_gas_plant`, and two economy ids
  end in a space (`DepositsSlotsResearchSO `, `IslandPriceReductionResearchSO `).
  The roster also lists `research_building_tidal_plant`, a building the
  optimizer does not carry yet. The reader matches ids exactly and skips unknown
  ones.
- **The 1.1.11 timeline samples** are in `tests/gameExports/` as
  `gen<jumps>_<anomaly>_city<level>.txt`, the third round, ending with the
  clock byte. A `_server` file is the same save stamped by server time (the
  editor's sync fed from an NTP clock), the rest by the device clock.
  `owner_editor_save` is kept from the second round as the one real code that
  ends at research points. Each one's jump award matches the formula in 4.5.
  One of them, `gen1_cryo_city41`, has a building on the transformer cell of
  areas 6, 7 and 8; the importer drops those three.
- **The power is right to under 100 parts per million.** `gen2_city52_9c43e4b7`
  is a player's save, exported repeatedly with the same boards. The energy the
  game added between two exports, over the time between, is its real rate, and
  the simulator's power for those boards, as energy per 3-second tick, lands
  within 25–66 ppm of it whenever the gap was offline. `editor_current_save`,
  the same save after some play in the editor, comes out 229 ppm slower: the
  online tick drift below, measured.
- **An editor export runs about 10 s ahead.** On that same save the projected
  next Chronon arrived 10–11 s before the game's, with the browser's clock
  correct. The code came from the developer's Unity editor, which loaded the
  save and credited its offline income by its own game clock — and the game's
  anti-tampering can hold that clock off real time. So the editor's copy was 10
  s ahead of the player's phone, and the projection was right for the copy it
  was given. A player's own export has energy and stamp from one copy, so the
  stamp should stay **server time**: that is the real moment the energy
  describes, where a game-clock stamp would carry the anti-tampering offset into
  every projection. The weak spot is the unsynced fallback to the device clock.
- **The game runs slow while it is open (a game bug, being fixed).** Its
  production tick waits 3 s after the previous one and the wait ends on the next
  frame, so each tick runs a few milliseconds long: about 0.3% slow at 60 fps
  (~10 s an hour), 0.5% at 30 fps, and more on frame hitches. Offline time is
  counted in real time. So a projection on the real clock pulls ahead of the game
  by that fraction of the time it has been open since the export — the
  projection is right and the game drifts. The developer also suspects a short
  focus loss credits the gap since the last autosave (every 15 s) rather than
  since the pause. Neither is modelled here: both are the game's to fix.
- **A code can pick up stray characters when pasted.** One sample ended in a
  stray `ś`. The reader drops anything outside the base64url alphabet before
  decoding; a code damaged in the middle still fails, at the inflate.
- **Open question:** one sample reported a research in progress with 0 seconds
  left. Either it had finished but was not collected, or the seconds are not
  being read from the running timer.
