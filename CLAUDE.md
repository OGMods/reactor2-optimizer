# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A Svelte 5 + Vite + PixiJS web app for laying out buildings on a grid for a
reactor/power-grid idle game, with a built-in optimizer that computes a
near-optimal placement of reactors/generators/coolers. The game's rules are
specified in `docs/game-logic.md` — read it before touching anything under
`packages/solver/`, and `docs/SOLVER.md` for how that package is put together.

## Commands

```bash
npm run dev      # start Vite dev server
npm run build    # production build to dist/
npm run preview  # preview the production build
npm run check    # svelte-check (app) + tsc (config, app tests, solver package)
npm run knip     # find unused files/exports/deps
npm test         # vitest: the app's tests and the solver package's
npm run solve    # solve a board from the terminal (`-- --help`)
npm run fixtures # regenerate the solver's golden fixtures
npm run build:solver  # build the publishable @reactor2/solver dist/
```

**The solver is a separate npm workspace**, `@reactor2/solver` in
`packages/solver/`. It has no runtime dependencies, the app imports it by name,
and `exports` points at its TypeScript source — so `npm run dev` needs no build
step and `npm run build:solver` exists only so the package stays publishable
(CI runs it). `docs/SOLVER.md` is the authority on what is inside it.

`npm run check` and `npm run knip` are both clean — **keep them that way**.
`check` fails on unused locals and parameters as well as type errors.

Three things worth knowing when either starts complaining:

- **`BUILDING_TABLE` is `as const`**, so its element type is a union of 38
  literal object types and `.find()` over that union hides any property some
  member lacks. `packages/solver/src/data/buildings.ts` exports it through a
  `readonly BuildingDefinition[]` annotation so consumers get the uniform
  four-variant union and narrow on `type`.
- **`knip.json` declares an entry point per workspace** — the app's `main.ts`
  and `index.html`, the package's `src/index.ts` plus its `bin/`, `scripts/` and
  `tests/`, none of which anything imports. `@lintignore` in a doc comment
  excuses a single deliberately-public export with no in-app caller. Anything
  else knip reports is real.
- **Test files are excluded from `tsconfig.app.json`** (so Node globals stay out
  of browser code) and typechecked via `tsconfig.test.json`. The package has the
  same split twice over: `tsconfig.json` covers `src/` with `types: []`, so the
  engine cannot pick up a Node global and fail inside a worker, and
  `tsconfig.tools.json` covers `bin/`, `scripts/` and `tests/`, which do get
  Node.

## Project conventions

Three rules recur across the UI. They are stated here once; the sections below
assume them.

- **Hidden, not disabled.** A control that cannot act in the current mode is not
  rendered — the grid steppers on a shipped island, the terrain brushes over the
  solver's board, `PlacementViewToggle` with no solve, the variants row during a
  run. Screen space on a phone is scarce and a row of inert buttons explains
  nothing. The one exception is `BoardActions`' Undo/Redo, which are _disabled_:
  they must stay findable before there is anything to undo, and a control that
  comes and goes would move Run out from under the user's thumb.
- **Measured, not assumed.** Every piece of chrome the canvas has to work around
  publishes its real size — `uiState.headerBottom`, `hudHeight`, `sidebarWidth`,
  `sheetPeekHeight` (`ConfigSidebar` binds `clientHeight` on its `.sheet-top`,
  which _is_ what peek shows; `SHEET_PEEK_FALLBACK_PX` covers the one frame
  before the measurement lands). All of them change at runtime, so any
  hard-coded guess is wrong on some device.
- **Two presses for anything that destroys unrecoverable work.** See
  `components/confirmArm.svelte.ts`.

## The building model

A building is one of **four roles** — `cooler`, `reactor`, `generator`,
`direct_producer` — and `BuildingDefinition` is a tagged union with one variant
each, carrying one record per upgrade tier. The game's own catalogue files
reactors and direct producers under a single `heat_producer` category and the
sidebar still shows them on one tab, so `buildingCategory()` in
`data/buildings.ts` in the solver package maps the four roles back to the three
UI groups — the
only place that three-way grouping is used.

**A generator does not convert heat at a fixed ratio.** Each tier authors its
own `HeatPerTick` / `EnergyPerTick` / `WasteHeatPerTick`, and the generator
scales the latter two by how full it is. `energy / heat` lands near 0.75 without
being 0.75, because the three fields are rounded to 3 significant figures
independently. `solver/physics.ts` owns that conversion, the relative
cooling tolerance (`wasteIsCovered`) and `snapToAuthoredPrecision`;
`GENERATOR_ENERGY_RATIO` / `GENERATOR_WASTE_RATIO` survive in `constants.ts`
only as the fallback for a roster that authors neither.

`EffectiveBuilding` — what crosses the worker boundary — is where the role's
waste rule has already been applied, leaving three plain numbers:
`effectiveValue`, `energy`, `waste`. `data/effectiveBuildings.ts` is the one
place that resolves them, so a panel cannot disagree with the layout it
describes. It answers two questions that must not be confused:
`getEffectiveBuildings` reads the player's _unlock level_ ("what may the solver
build?"), while `effectiveAtValue` resolves a **placed** building's tier from
the value it was placed at ("what is this one rated for?"). The scorer and the
board readout both use the latter, so the ceilings the card prints are the tier
the building actually ran at — the two diverge the moment an upgrade is bought
behind a standing building.

**The catalogue is generated, so don't hand-edit it.** An external extraction
script — it reads the game's own files and is not part of this repo — emits the
`BUILDING_TABLE` block in `packages/solver/src/data/buildings.ts` from the
extracted roster. It splices only that declaration; the prose and the helpers
around it are hand-owned and survive regeneration.

The tables carry the game's **authored ScriptableObject doubles**, not the
3-significant-figure numbers its UI shows and not the extractor's rounded JSON
(which loses 22 of the roster's 301 numbers): cooler2 tier 3 is 18662, not
1.86e4.

## The Time Lab: research and anomalies

Prestiging ("Time Jump") does two things to the numbers, and Setup's third tab —
named **Time Lab** after the game's own screen — holds both.

### Time Lab research

`PRESTIGE_UPGRADES` (`data/prestige.ts`) carries **three** of the game's ten
researches: Absolute Zero (cooler cooling), Infinite Grid (generator and wind
turbine stats) and Stellar Forge (reactor heat). The other seven move research
income, research time, chronons, obstacle-removal and building prices — all
decided *before* the solver is handed a board, so none can change which layout
is best. The file names them so it is clear they were read and dismissed.

Three things bind:

- **Each is a uniform multiplier on the roles it names**, the same shape the
  stat anomalies turned out to have, so both go through
  `scaleEffectiveBuilding`. Infinite Grid raises the overheat threshold as well
  as the energy, which is what keeps it a bigger bet rather than free power.
- **It folds into the roster, not into the solver.** `prestigeScales()` resolves
  levels to one factor per role and `getEffectiveBuildings` applies it, so by the
  time an `EffectiveBuilding` crosses the worker boundary the research is already
  in its three numbers and nothing in the engine knows a Time Lab exists — which
  is why the worker protocol has no field for it.

  **That means the scales have to reach `planSolve`, and a run does not resolve
  its own roster.** `solveProgressive` hands over `buildings` and
  `unlockedUpgrades` and the coordinator resolves from those, so research
  applied anywhere else — the readout, the run estimate — reaches the search
  only if `SolveRunOptions.prestige` carries it there. Omit it and the run comes
  back with a perfectly valid layout optimised for a roster the player does not
  have, which nothing on screen would contradict. `prestige.test.ts` pins the
  plan's roster and its upper bound against exactly that.
  `effectiveAtValue` takes it too, and must: a placement stores the **authored**
  tier value, which identifies the tier and is deliberately never rewritten, so
  the research is applied on the way out every time.
- **A multiplier breaks what `effectiveValue` used to mean, so
  `EffectiveBuilding` carries `baseValue` beside it** — the authored tier value,
  which every scaling helper passes through **untouched**. `simulateIsland`
  reports that, never `effectiveValue`, because a placement's tier is resolved
  back out of the reported number by matching the catalogue: report a scaled one
  and it matches a *higher* tier and gets scaled a second time. A generator at
  authored 320 under a x2 research reported 640, resolved as the authored 640
  tier, and came back 1280 at one level too high — in the readout's ceilings,
  the `Lv.` chip, `copySolveToBoard` and the tier table of every share code, with
  nothing failing anywhere.
- **It follows `buildingUpgrades`' convention exactly** — presence of the key is
  what "researched" means, the value is a 0-based level index the UI numbers from
  1, and un-researching deletes the key. Same control, same gesture, so a second
  convention would only be a way to rate a board at the wrong level without
  failing. `PrestigeUpgrades` is `BuildingUnlockCard`'s idiom down to the edge
  stripe and the tier row disabling when off.
- **The table authors the game's `BonusPercentage`, not the multiplier.** The
  game works and reads in bonuses — its UI says "+100%", never "×2" — so
  `bonuses` is what is carried and `prestigeMultiplier` (`1 + bonus`) is the one
  place the factor comes from. Carrying both would be two spellings of one number
  to keep in step; the card prints the bonus and puts the factor in the tier
  button's tooltip.

`layoutState` cannot read `configState`, so it **holds** the scales
(`setPrestige`) rather than taking them per call — `recalculate()` runs from a
dozen internal places that cannot all grow an argument. `hydrateState` seeds it
before the board exists; `App.svelte`'s effect pushes changes. A previewed board
sits it out, the same as `rebasePlacements`: it is the author's board at the
author's research, and a blueprint does not record what that was.

**Stellar Forge does not cover wind turbines.** The game's `heat_producer`
category holds reactors *and* direct producers, so "all Heat Producers" read
literally would take the turbine — but a turbine's SO inherits
`PowerSourceBuildingSO` and reads Infinite Grid, while Stellar Forge is read only
by `HeatProducerBuildingSO`. That is why Infinite Grid goes out of its way to
name turbines. The rule is "every heat producer", and a reactor is the only one
the game ships, so it is modelled as reactors.

### Anomalies

Prestiging also picks an **anomaly** that changes the rules for the whole next
timeline. `docs/game-logic.md` is the authority on what each one does and
`docs/SOLVER.md` on how the table is shaped; the short version:

- `AnomalyDefinition` (`solver/types.ts`) is a tagged union over the **rule
  shape**, not the anomaly's name, and `ANOMALIES` (`data/anomalies.ts`) is
  **hand-owned** — unlike `BUILDING_TABLE` beside it, what the extractor can
  read is the text and the multipliers, never the rule shape those numbers plug
  into.
- `"none"` is an entry, not an absence, and `getAnomaly` is total: an id it does
  not know resolves to the baseline, because the id arrives off `localStorage`
  and the worker boundary.
- Every stat anomaly is a **uniform** scale on a building's three figures
  (`scaleEffectiveBuilding`), so a bonus is never free power — the cooling it
  needs grows with it. **Waste is derived rather than scaled**:
  `scaleEffectiveBuilding` recomputes `snapToAuthoredPrecision(heat - energy)`
  from the pair it just scaled, because that is the game's runtime getter and
  carrying the authored waste through the same multiply disagrees in the last
  digit, where the fixtures assert exactly. Only the two roles that *have* waste
  derive one — `heat - energy` over a cooler or a reactor would turn its whole
  output into waste.

  **Research and anomaly arrive as two successive calls, in that order**, which
  is how the game applies them (the Time Lab in the SO getter, the anomaly in
  the runtime getter) and is not the same double as one combined factor:
  generator7's first tier under x5 then x2.5 is 1.3875000000000001e22, against
  1.3875e22 for x12.5. `scaling.test.ts` pins both, against the shipped
  catalogue rather than round numbers — every divergence here is in the last bit,
  so a test on tidy figures passes under either reading.
- `configState.anomalyId` is the live choice, persisted under its own key rather
  than in `ui_prefs` because it is a **solve input** like the roster, not a
  preference about the app — which is also why `solveSignature()` counts it and
  a solve found under another anomaly restores as stale.
- **Cryo Nexus pools across the whole board.** The game's "island" is the map,
  so under it the islands `splitGridIntoIslands` produces **do** interact —
  against the assumption the worker pool, the budget split, `IslandBest` and
  `variants.ts` are built on. Heat stays adjacency-bound, so an island is still
  solvable alone; it is just no longer described by its best power but by a
  frontier of power against net cooling contributed, with the board combining
  those under one scalar budget. See `docs/SOLVER.md`.

  It also **drops `splitGridIntoIslands`' minimum island size to one tile**. The
  2-and-3-tile floors exist only because cooling has to cross a tile boundary; a
  lone tile under Cryo takes a heat sink that pays into the pool, or a direct
  producer the pool pays for. That is 21 tiles across the shipped maps which no
  other rule in the game can use, arriving as degenerate one-tile islands that
  must not be handed a real share of the time budget. The anomaly therefore has
  to reach the split, not be consulted after it.
- **Off the board counts as water**, which is a fact about our data rather than
  about the game: the game has one global map with open water between islands,
  and our eight boards are rectangles cut out of it, so the water past an edge is
  real and simply not in the blueprint. It barely moves the shipped maps (+4 on
  island3, +2 on island7, the rest unchanged) and is the whole of the anomaly on
  a custom island, whose blank 10x10 of grass has no water in it at all.

  The trap is that `IslandSubGrid`'s one-tile padding is **clamped to the board**,
  so it cannot tell an off-board neighbour from the window's own edge. Water
  adjacency has to be resolved once on the full grid and carried in.
- **`ANOMALIES` is transcribed by hand from the same extractor's output**, which
  emits an anomaly record alongside the roster and drops the icons into
  `public/icons/anomaly_<id>.webp`. Unlike `BUILDING_TABLE`, **nothing splices
  this table** — the extractor writes its record and stops — so a new anomaly is
  brought across by hand. The game's `{0}`-templated strings land here with their
  `values` resolved, so the wording and the numbers the solver runs on cannot
  disagree.
- **`sidebar/AnomalySelector` is the only place it is chosen**, under the
  research on Setup's Time Lab tab. It mirrors a choice already made in the game rather than making one, so
  it is built to be recognised rather than shopped: icon and name first, the
  game's benefit/drawback pair beside them, and the full rule only under the
  selected card — four rules at once is a wall of text on a phone describing
  three timelines nobody is in.
- **Changing it re-scores both boards** through the same `$effect` in
  `App.svelte` a roster change goes through, and for the same reason. It is
  tracked separately there because the two ask for different work: a bought tier
  changes which tier a *placement* resolves to (`rebasePlacements`), while an
  anomaly changes none of them — the same building at the same tier is simply
  rated differently — so it needs the re-score alone.
- **The solver accepts an anomaly and does not yet act on one.** It is threaded
  the whole way — `SolveOptions.anomalyId` / `SolveRunOptions.anomalyId`, the
  worker request, and `IslandContext.anomaly`, which is where the stages will
  read it because every stage already holds a context. The model, the board
  window the rules need, the catalogue and the UI are in; the rules are not, and
  nothing on screen says a solve ignored one.

  The anomaly crosses the worker boundary **as an id**, resolved again on the
  far side, so the message stays a string rather than a table entry that has to
  survive structured cloning. `replayIslandDeterministic` passes none and never
  will: the fixtures are a determinism harness for the search, and a rule change
  is a different question asked of it.

**Three Time Lab upgrades scale building stats too**, and they are not anomalies:
they are bought with Chronons, survive a Time Jump, and stack with whatever
anomaly is running — **multiplicatively**, so a generator under Singularity
Isolation with Infinite Grid maxed is rated x12.5. The extractor's record covers
all ten Time Lab upgrades; the three a layout can see are **Stellar Forge**
(every heat producer, so reactors), **Infinite Grid** (generators *and* wind
turbines), and **Absolute Zero** (every cooler), each five levels of
`BonusPercentage` 1.0 to 4.0. That field is a fraction rather than a percent --
the same field is 0.05 on Chronon Reactor, which the game shows as +5% -- so the
levels are worth x2 to x5. Like an anomaly's, the scale is uniform, so the
cooling a boosted producer needs grows with it. Their badges ship as
`public/icons/prestige_<id>.webp`.

## Architecture

### Folder map

The game's own half — the engine, the building tables, the blueprint codec and
the number ladder — lives in `packages/solver/`; see `docs/SOLVER.md`.

`src/lib/` is the app around it: `worker/` (the boundary), `types/`, `pixi/`,
`utils/`, `storage/`, `simulation/`, `encoding/` (share links), `data/` (the
app's own record of a placed building), `state/` and `components/` — the last
grouped by region (`canvas/`, `header/`, `hud/`, `inspector/`, `sidebar/`,
`modals/`), plus two shared modules at its root: `confirmArm.svelte.ts` and
`statIcons.ts`.

`components/index.ts` exports only what `App.svelte` mounts; a component only
ever rendered by a sibling is imported directly by its parent. Each folder's
`index.ts` re-exports **only that folder** — a barrel that re-exported a
neighbour is what makes `lib/pixi/` reachable through `../utils`, hiding a Pixi
dependency behind a name that promises none.

**The two shared idioms**, both shared because a copy each is what drifts:

- **`confirmArm.svelte.ts`** — the two-press confirmation. Armed state is a
  _key_ rather than a boolean, because callers hold more than one at a time and
  arming one must disarm the other; that makes "only one live confirmation" a
  property of the type. `confirmArm.test.ts` pins it — every rule in it is a way
  the guard could fail open.
- **`statIcons.ts`** — the three figures a building is stated in and the icon for
  each, so `BoardStatsCard` and `BuildingUnlockCard` cannot drift apart.
  `statForType` is a `Record` over `BuildingCategory` rather than a switch, so a
  fourth group fails to typecheck instead of showing the wrong unit.
  `headlineValue` is its companion: `statForType` says what the figure is
  _called_, this says what it _is_ (a generator's authored energy, everything
  else's `levelValue`). `BuildingUnlockCard` prints it and `hud/BuildingPalette`
  **sorts by it**, strongest-first — the catalogue is authored weakest-first and
  the ribbon scrolls, so the best unlocked building was the one furthest along a
  row the player had to drag. Sorted by the figure rather than reversed, because
  "reverse the table" only reads as strongest-first while the table stays in tier
  order, and the table is generated.

**One CSS caveat in `hud/`.** The `.tool-btn` / `.toolbar-divider` /
`.mode-icon` / `.tool-label` base rules live in `HudToolbar.svelte` as
`:global(...)`, because `TerrainPalette` renders buttons into the same row and
Svelte's scoped CSS does not cross a component boundary. They are deliberately
left at single-class specificity so per-tool modifiers (`.grass-btn.active`, …)
still outrank them. Raise that specificity and active states silently lose the
cascade.

### Blueprint is the format

`encoding/blueprint.ts` in the solver package is deflate + base64url, one byte
per tile, carrying terrain **and** buildings in a single payload behind a
version byte and the grid's dimensions. The shipped island templates (`data/maps.ts`),
the user's saved edits (`localStorage`), the Share button and the CLI's output
all use it. It needs
`CompressionStream`, so encode and decode are **async** — which is why loading a
grid is an awaited step rather than something a constructor can do.

- **Never compare encoded codes to test whether two layouts match.** DEFLATE is
  only required to round-trip; two engines may emit different bytes for the same
  input. Use `blueprintKey()`, which compares the uncompressed payload.
- **A code says which format it is, and an old one is recognised by its
  width.** `BLUEPRINT_VERSION` is byte 0 of every new code; codes written before
  it began with the width instead, so the two are told apart by *value* — a
  board is at least `MIN_GRID_DIM` (5) on a side, so a first byte below that
  cannot be a width. Which is why that constant now lives in the codec rather
  than in the size stepper that enforces it, and why lowering it would not
  shrink a board but would make some old codes unreadable. It constrains old
  codes only: a versioned code states its width where no value is ambiguous, so
  the 4x4 fixtures encode fine. An unknown version is **refused**, never
  guessed at — the tiles are positional, so misreading one produces a different
  board rather than an error.
- **`IslandTemplate` has no `width`/`height`.** The code carries them, so there
  is nothing to drift out of sync with the terrain. To author a new island, build
  it in the app and press Share.
- **A tile byte says which building, not what it is rated for**, and the same
  layout at tier 1 and tier 8 is two different boards. So a code may carry one
  more section after the tiles: a count byte, then a
  `[building byte][upgrade index]` pair per building **id** — one entry per id,
  not per tile, which is lossless because every placement of a building shares a
  tier (`rebasePlacements` re-reads them together).

That section is **optional in both directions**: a code written before it existed
ends after the tiles, and a reader that predates it stops there too. An **empty**
table means "tiers unknown", never "everything at tier 0", and the caller
resolves them from its own unlocks.

**A third section carries the rules the board was built under** — the anomaly
byte, then a count and one `[research byte][level index]` pair per Time Lab
upgrade. Tiers say what the buildings were, and that stopped being the whole
story once research changed what a tier is worth: a board shared out of a
×5-cooling timeline is not the board a reader without that research would get.

Two things about it:

- **Rules are read only after the tier table, so a code carrying them carries a
  tier count byte first, even a zero one.** A byte for a strictly sequential
  parse, and zero there is not a contradiction — an empty table already meant
  "tiers unknown".
- **`rules` decodes to `null` when the code does not say**, which is not the
  same as a code that states "no anomaly, no research". A reader that confused
  the two would rate someone else's board at nothing and still print a figure.
  `loadPreview` uses the author's research where the code names it and **no**
  research where it does not — never the reader's own, for the same reason it
  uses the author's tiers.

Two rules follow, and they are not symmetric:

- **`encodeBlueprint` takes tiers; `blueprintKey` never does.** The key answers
  "is this the same layout?", and its callers — `persist()` against the pristine
  template, the solver's board signature — mean the arrangement, not what the
  roster currently rates it at. Fold tiers in and buying an upgrade reads as a
  repainted board.
- **Share codes carry tiers and rules, saved layouts carry neither.** A save is the player's own
  board and is meant to pick up upgrades bought since (`#applySaved` on load,
  `rebasePlacements` live). Freezing tiers into the save would put those two in
  permanent disagreement, so `persist()` calls `encodeBlueprint` directly while
  `exportBlueprint` (the share path) adds `placementTiers(placements)`.

**A share code has a second form: a link.** `encoding/shareLink.ts` owns the
`?bp=` parameter's name so nothing else knows it, builds the URL from the live
`location` (this app ships to a GitHub Pages subpath _and_ to localhost, so a
configured base would be wrong in one), and strips the parameter on the way out
via `replaceState`. The dialog offers both forms and **copies neither on open**:
there is no way to guess which the user came for, and taking their clipboard to
hand them the wrong one destroys what was on it. Opening a link is preview mode —
see the state layer.

### Two halves: UI shell and solver engine

- **UI shell** — Svelte 5 components + runes state classes: paint a grid, manage
  a catalog of unlocked buildings.
- **Solver engine** (`@reactor2/solver`) — a framework-agnostic package that
  takes a grid + roster and returns an optimized layout. In the app it never
  runs on the main thread.

They talk **only** through `SolverWorkerClient` (`worker/workerClient.ts`), which
owns a `SolverCoordinator`, which owns a pool of `islandWorker.ts` workers, one
island per worker. All three live in `worker/` so the solver stays liftable.
`uiState` holds the one client instance.

`worker/solverCoordinator.ts` **must** construct workers with
`new Worker(new URL("./islandWorker.ts", import.meta.url), { type: "module" })`
written literally inline — Vite statically detects that exact pattern. Don't
refactor the URL into a variable.

### Solver: a package, not a folder

`packages/solver/` is `@reactor2/solver` — the engine, the authored building
tables, the blueprint codec, the number ladder, a CLI and its own test suite. It
declares **no runtime dependencies** and the app consumes it through the
workspace link. `docs/SOLVER.md` is the authority on how it is put together and
what must not be changed casually; don't reproduce that here.

Until recently the shipped solver was a line-for-line port of a Python reference
in `py_solver/`, which was upstream. That tree is **retired** — the port had
become about 9x faster at the thing that decides solve quality, since every
stage is wall-clock budgeted and V8 simply fits more annealing steps into the
same 30 seconds. Its whole test suite and its CLI's argument surface moved here
with it. Comments that mention "the retired Python reference" are explaining why
something is shaped the way it is, not pointing at code you can go and read.

Two things from that history still bind you: `rng.ts` is mulberry32 with pinned
golden streams, so **don't swap in `Math.random()`** and never re-record those
goldens, and `DistributionScratch` **must never change a number**.

`solver/types.ts` is the **data contract**: `Tile`, `TileType`, `BuildingType`,
`BuildingDefinition`, and everything that crosses the worker boundary. The app
does not redeclare any of it — `src/lib/types/` re-exports from the package, so
there is one definition and nothing to keep in sync.

### The worker-safety boundary

Everything under `packages/solver/src/` must stay importable into a Web Worker:
no npm package (the manifest declares none) and no `.svelte`. Inside it, a
second rule keeps the layering one-way — `src/solver/` may reach only into
itself and `src/data/`, never into the codec or the formatters.
`tests/workerSafety.test.ts` enforces both by scanning imports, so the boundary
survives without an ESLint toolchain (the project has none).

The rule is _worker-safe_, not _environment-free_: `pacer.ts` uses
`MessageChannel`, `setTimeout` and `performance.now()` on purpose — those are
globals, not imports.

### Solver pipeline

`solve()` in `solver.ts` (or `SolverCoordinator.solve()`, the worker-pool path)
is the entry point. `planSolve()` does the shared setup:

1. `data/effectiveBuildings.ts` resolves each building's stats at its unlocked
   level. It is the one module outside `solver/` the solver may import.
2. `island.ts` decomposes the grid into 8-neighbour connected components of
   buildable tiles, solved separately with the budget split by tile count.
   `estimateTotalMaxPower` computes a TRUE upper bound — no layout may ever beat
   it.
3. `placementSearch.ts` (`solveIsland`) runs six stages per island:
   **seed → repair → composition retarget → (annealing → repair)\* → pruning →
   right-sizing**. The starred pair repeats until the deadline: repair's slice is
   reserved before the layout exists and converges long before its cap, so what
   it hands back becomes another short walk rather than idle time. The reasoning
   for each stage is in the file header and `docs/SOLVER.md`; the short
   version is that seeding builds self-sufficient hubs and systematically misses
   layouts where hubs _share_ a cooler or reactor, and the other stages cover
   that from different directions.
4. `simulate.ts` evaluates a fixed placement — the hot path, called millions of
   times per solve — using `distribution.ts` (FairShare + an Edmonds-Karp
   "Augmenting Repair") for both heat and cooling flow, and `physics.ts` for the
   conversion and the online test.

**Ties.** A search almost never finds a single best arrangement, and which tie is
nicest to build is a judgement the solver cannot make, so `alternates.ts` watches
the walk and collects stable layouts matching its best power. The collector is a
passive observer — nothing in it feeds back into the search — and
`replayIslandDeterministic` (the fixture path) passes none, so the goldens are
untouched. `docs/SOLVER.md` is the authority.

**A tie has to be a different board, not a different string.** An entry joins the
shortlist only if it is `MIN_ALTERNATE_DISTANCE` tiles — five — from every layout
already kept, counting an empty tile as an occupant of its own, so one
substituted building is 1 apart and one relocated building is 2. Deduplicating by
shape alone let a converged walk fill the list with near-copies of itself, and
cycling through them looked like nothing was happening. The bar is on being a
_second_ answer, never on being an answer — a layout that beats the shortlist
empties it first, so it is always kept whatever it looks like. Every gate that
admits a layout applies the same rule: the collector during the walk,
`finalizeAlternates` (pruning and right-sizing rewrite the board, so distances
change under it), `worker/islandBest.ts`, and `chooseSolveVariants`.
`worker/variants.ts` inherits it rather than re-testing — every whole-board
variant differs by at least one island's rearrangement — and combines per-island
shortlists into whole-board ones, which is sound because islands never interact.

**`downgradeOversized` is the one stage that is not part of the search.** It runs
once on the finished layout and cannot find a better one — it re-tiers what is
there. Power is blind to the difference between a cooler running flat out and one
at 2%, so nothing in the walk prefers the tier a tile actually needs, and the
roster's top cooler lands where a twentieth of it would do — real money the
player spends on capacity that never runs. Each swap is re-simulated and kept
only if power holds and every producer stays online, so it can change which
building sits on a tile and nothing else. Tied layouts go through it too.

**`distribution.ts` is a port of Unity's `FlowNetwork.cs`.** Two shapes in it are
load-bearing and look like details:

- A supplier expands **every** unvisited adjacent consumer instead of
  shortcutting to the sink when it finds one with room. The shortcut marks later
  consumers visited and can pick a different equal-length augmenting path — same
  maximum flow, different split, and the split decides which buildings clear
  their cooling.
- Supply and demand are counted **down** rather than accumulated up, because
  `cap - sent` is not bit-identical to a decremented remainder and the golden
  fixtures assert exactly.

**`simulation/simulator.ts` implements none of the rules.** It scores hand-placed
layouts on the main thread by turning the board into an `IslandContext` and the
placements into a `Placement`, calling `simulateIsland`, and mapping the report
back, so agreement with the solver is true by construction rather than
something a test defends. `simulator.test.ts` pins the adapter, the figures measured from the live game,
and the assumption the delegation rests on: handing the **whole board** to one
context equals solving each island separately, which holds because distribution
scopes its round budget and its repair to each connected component of the
supplier↔consumer graph — a finer partition than the island.

Two details there are easy to trip over. `simulateIsland`'s `fullReport` argument
turns off its "nothing can come online" short-circuits: the search wants power
and stops early, but a player looking at a coolerless board still wants to see
the heat being moved. And a placement records the value it was placed at rather
than a level index, so the scorer resolves the authored tier by matching that
value — exact for anything the app produces, since `data/placements.ts` reads
it from the catalogue.

The island context is cached keyed on a **terrain signature**, not the grid's
identity: building one allocates a flow matrix quadratic in buildable tile count,
this runs on every placement change, and `setTile` mutates a tile in place — so
the array reference alone would go on matching a board that had changed
underneath it.

### The stability rule

A solved layout must be fully stable: every generator and direct producer it
places has to actually run. `stabilize()` drops zero-power producers
unconditionally and repeats, since removing one hands its heat to its neighbours.

The part that binds you when editing the search: the annealing walk may pass
_through_ unstable layouts but records only stable ones as best, and **"pruning
never reduces power" is not a valid invariant**. The valid ones are "the returned
layout is stable" and "pruning a _stable_ layout never reduces power".

### Verifying a solver change

Start with `npm test`. Three parts of it are what actually catch a regression:

- **`tests/fixtures.test.ts`** replays the golden fixtures in
  `packages/solver/fixtures/`. Two layers: `expected` (annealing off) is
  asserted **exactly** and has no floating-point excuse, while `annealed` is
  tolerance-checked because `Math.pow`/`Math.exp` are not required to be
  correctly rounded and a V8 upgrade can move one by an ULP — enough to diverge
  the walk permanently.
- **`tests/goldenLayouts.test.ts`** pins the proven optima for islands of 3–9
  tiles. **These numbers must never go down.**
- **`tests/distribution.test.ts`** pins the flow rules against measurements from
  the live game and against an independent max-flow oracle.

Regenerate the fixtures with `npm run fixtures` and **read the diff** — it is the
clearest statement of what a solver change actually did. Re-running against an
unchanged solver reproduces every file byte for byte; CI checks that, so a
non-deterministic solve path fails there rather than becoming folklore.

Only seed construction and `simulateIsland` are deterministic, so those are what
to compare when refactoring. `rngSeed` pins the annealing walk's move sequence,
but stage deadlines are wall-clock, so seeding narrows run-to-run variance
rather than eliminating it. For a whole-board check use the CLI
(`npm run solve -- --map 1 --attempts 10 --time 20`): the search is stochastic
and map 1 swings ~2% run to run, so compare several runs, not one.

## State layer (`src/lib/state/`, Svelte 5 runes)

Six singleton classes, each exported as a ready-made instance, split by what the
state **is** rather than by which component reads it. They reference each other
directly rather than through events/props — this is a small enough app that
singletons + direct calls are the whole store layer. What keeps that from
becoming a knot is that the references form a **strict DAG**:

```
layout   -> (nothing)         config   -> (nothing)
viewport -> (nothing)         editor   -> layout
solver   -> config, layout    ui       -> config, layout, solver, viewport
```

**`layoutState` imports nothing from the rest of the state layer.** It is the
model, constructed first, and everything else reads from it. Three things used to
violate that: it wrote `activeTemplateId` onto `uiState`, it recentered the canvas
on template load, and `paintTile` read the brush off the editor. The first two
made the grid and UI singletons mutually dependent _during construction_, which
worked only because module import order happened to cooperate. Now the template
id lives in `layoutState`, recentering is the caller's job, and the editing verbs
live on `editorState`, which calls `layoutState.setTile()`. `layoutState` exposes
`setTile`/`tileAt` and applies no editing rules of its own.

### `editorState` (`editor.svelte.ts`)

The paintbrush: `activeTool`, `selectedBuildingId`, and the editing verbs
`paintTile` / `eraseTile`, which — like `placeAt` and `eraseAt` in the canvas —
**report whether they wrote** so a brush dragged
across a board it may not edit cannot buzz once per refused tile. Transient;
never persisted.

### `layoutState` (`layout.svelte.ts`)

The document: `grid`, `width`/`height`, `activeTemplateId`, per-template saved
edits, and hand `placements`. Saved to `localStorage` as a blueprint code, one
per template, and that same code is the share code.

Because both templates and saves are blueprints, **the constructor cannot build a
grid at all** — it only restores which template was selected. `hydrateState()`,
awaited in `main.ts` before mount, decodes the template and then the user's saved
layout over it, so the first paint is the real board. Writes go the other way:
`persist()` returns immediately and the encode lands in the background, with a
sequence number so a burst of paints cannot land out of order.

### `configState` (`config.svelte.ts`)

The roster: which buildings are unlocked and to what level. **Presence of a key
in `buildingUpgrades` is what "unlocked" means**; locking deletes the key rather
than storing a flag. The building _catalog_ is not here — it is static data, so
import `BUILDINGS` from `@reactor2/solver`.

### `solverState` (`solver.svelte.ts`)

The optimizer run: status, streaming `optimizationResult`, `estimatedMaxPower`,
the elapsed clock and the stop handle. The only place that drives
`SolverWorkerClient`.

**A run is bounded by a budget, and the budget is the whole shape of it.** The
search has no natural end, so the coordinator divides the budget across islands
and every stage's deadline is carved out of it. It is short on purpose, because
that is what makes "run it again" cheap rather than a five-minute commitment.
`#startWatchdog` is a backstop, not the mechanism — the workers honour the budget
themselves, and it only fires (with a grace period, via the graceful
`stopOptimizer`) if an island's pass overruns its slice. It is set against the
run's **serial** cost, not the parallel estimate: a machine that reports eight
cores and gives two must not have its run cut short.

**How the budget is spent is the player's choice** — `SOLVE_MODES` in
`worker/solveModes.ts`, persisted as `solveModeId` (README states what the three
modes buy). Ties from different attempts are pooled, which is where a deep run's
fuller shortlist comes from.

Attempts are ordinary pool tasks: `attempts × islands` go into the same queue
that runs one island per worker, so extra searches cost wall-clock only once the
pool is full. That is why `estimatedRunMs` exists and why the control prints it —
"10 × 10s" is not a duration until you know how many workers the browser gives
you. `estimateMakespanMs` replays the coordinator's own greedy dispatch over the
task durations rather than guessing.

Two properties of that queue are load-bearing. Tasks are ordered
**attempt-major**, so every island is solved once before any island is solved
twice — island-major would leave the last island of a large board empty if the
user pressed Stop early. And when Stop is signalled the still-queued tasks are
struck off the outstanding count on the spot: they will never run, so they will
never report, and a run that kept counting on them would wait forever.

**The best attempt is taken per island, not per board** (`IslandBest`). Islands
never interact, so the maximum over attempts for each island composes into a
board at least as good as the best whole-board attempt. Ties across attempts are
pooled rather than discarded. Finished attempts only: a progress report is a
snapshot of a search still moving, so the coordinator streams those to the screen
on a separate, monotonic track and never files them as answers.

**A re-run has to earn its place.** `runOptimizer({ keepBest })` captures the
shortlist on screen and puts the new result back only if it scores higher; a
defended layout keeps its _own_ run's duration and timestamp, because it is still
that solve and the card prints both. The search is stochastic and the budget
short, so a second run genuinely can come back worse — which is why the choice is
put to the user (`uiState.requestSolve`) rather than assumed.

Two things about "the layout on screen" are load-bearing:

- **The bar is the _best_ layout held, not the one being previewed.**
  `variantIndex` is wherever the user's eye happens to be, and a shortlist is not
  always level: `rescoreResult` re-rates fixed shapes at a new roster and can rank
  them apart. Measured against the previewed entry, a run that beats only _that_
  one replaces the whole shortlist, higher layouts included. The _selection_
  still stays where the user put it.
- **A run that comes back with nothing puts the held layout back.** What is on
  screen at that moment is the last thing the dead run _streamed_ — a search still
  moving, usually a fraction of the power it was drawn over. `runOptimizer`'s
  `finally` re-hangs `variants[variantIndex]` with the clock that came with it, or
  empties the panel if there was never one. `previousVariants` is likewise only
  taken when there _is_ a shortlist behind the result: a bare streamed snapshot is
  not something to defend, and defending it would hand the next run a bar of
  nearly zero.

**A solve is a shortlist, not a layout.** `variants` holds up to
`MAX_SOLVE_VARIANTS` (ten) boards at the _same_ power, and `variantIndex` is the
one the canvas draws. Cycling (`showVariant`, which wraps both ways) only
previews and writes nothing; `applyVariant` is the commitment and
`appliedVariant` is what a reload returns to. Thumbing through ten layouts must
not quietly overwrite the one already chosen.

The list is filled from two directions: one run usually fills it on the shipped
islands, and `chooseSolveVariants` pools further runs that **tie** into it (a
fresh layout joins only if it clears `MIN_ALTERNATE_DISTANCE`; held layouts go in
unfiltered and stay in front, so the user's pick keeps its index). A run that
beats it replaces the list; one that comes back lower is defended against. That
policy is exported and pinned by `state/solveVariants.test.ts` rather than buried
in `runOptimizer`, because it is the whole meaning of "ten layouts at the same
power".

Only the **applied** variant is stored scored; the rest are stored as bare shape
(`StoredPlacement` — building, tile, tier) and re-scored through
`simulatePlacedBuildings` on the way back in. Ten scored boards across eight
islands is megabytes of `localStorage` for figures that take a millisecond to
recompute. A record written before variants existed restores as a shortlist of
one, which is what it was.

**Completed solves are persisted per island** (`solverStorage`, key
`solver_result`: one record per template id, oldest evicted past
`MAX_STORED_SOLVES`) and re-hung by `restore()`, which `hydrateState()` awaits
_after_ `layoutState.hydrate()` — deciding whether a stored result is still valid
means reading the board it was solved against. Validity is a stored signature:
the terrain (`blueprintKey(grid)`, no placements) and the roster. Hand-placed
buildings are deliberately outside it because the solver ignores them, so
building by hand does not invalidate a solve; clearing an obstacle or changing an
unlock does.

A run can take five minutes, which is what makes losing one expensive.
**Switching islands is a change of view, not a deletion**: `TemplateSelector`
calls `restore()`, which is total — it hangs the new island's solve or empties the
panel. Only a real discard goes through `clearResult()`: the card's Reset, and
resetting a template. `forgetSolve(id)` drops the record for an island being
deleted.

**A tier bought after a building is down re-scores it.** The roster is an input to
both boards' figures, not just to the next solve, so an `$effect` in `App.svelte`
— the one always-mounted place allowed to see all three singletons, since
`configState` is the bottom of the DAG — calls `layoutState.rebasePlacements()`
and `solverState.rescoreResult()`. The first re-reads each placement's tier and
re-scores, applying live the rule `#applySaved` has always applied on load, so a
board on screen and the same board reloaded cannot disagree. The second re-runs
the scorer over the solve's fixed shape and writes the result back under the new
signature. It deliberately does **not** re-optimise: that layout was chosen for
the old roster and may no longer be the best shape, or a stable one, so what it
reports is the honest output of those buildings at their new tiers. Re-running is
the player's call.

A run also outlives the switch that interrupts it, so it is **bound to the island
it was started on**: `#runTemplateId` / `#runSignature` are captured before the
first await, progress reports are dropped once that island is off screen, and the
finished layout is filed under the captured id. Switching stops the run, because
the board it is solving is no longer the one being looked at.

`elapsedMs` ticks every 100ms while a run is in flight and holds the final
duration afterwards (`lastRunDurationMs`, `finishedAt`). The solve has a
five-minute ceiling, streams its result and shows no progress bar, so without a
clock nothing separates "four seconds in" from "about to time out".

### `viewportState` (`viewport.svelte.ts`)

The device, from `matchMedia`: `isCompact` (< 1024px — bottom sheet instead of
docked sidebar), `isPhone` (< 768px — the header sheds secondary controls into
`OverflowMenu`), `isCoarse` (`pointer: coarse` — tap to inspect instead of
hover), `prefersReducedMotion`, and the live viewport `height` the sheet's detent
maths reads.

**Width and pointer are independent axes and must stay that way**: a touchscreen
laptop at 1400px gets the docked sidebar _and_ tap-to-inspect, and deriving
either from the other hands it the wrong half of each. Motion is a third,
independent of both, and unlike the others it only ever sets a _default_ — see
`uiState.animations`.

### `uiState` (`ui.svelte.ts`)

The interface: sidebar/catalog tab, the inspected tile, the share dialog, canvas
ref, `sheetDetent`, the measured `hudHeight`, `activeModal`, `placementView`, and
the getters `BoardStatsCard` reads. `activeModal` is one field rather than a
boolean per dialog, so "only one modal at a time" is a property of the type.

Two fields cover the inspector because the two pointer types cannot share one:
`hoveredTile` is transient and fine-pointer only, `pinnedTile` survives until
dismissed and is what touch sets. `inspectedTile` picks between them, so there is
only ever one inspector on screen.

**`animations` is three states, not two, and the third is the point.**
`#animations` is `true | false | null`, and `null` — nobody has chosen — is what a
fresh install has. The getter resolves it against
`viewportState.prefersReducedMotion`, so until someone opens Settings the system
answers for them _and keeps answering_ if they change it at the OS level. An
explicit choice then wins for good, which is the standard reading of a system
preference: a default, not a veto. `UiPrefs.animations` is optional in storage for
the same reason — absent is not `false`.

**`haptics` is a plain boolean**, and the asymmetry is the point: there is no
`prefers-reduced-motion` for touch, so there is no system answer to defer to and
no third state to preserve. `UiPrefs.haptics` is required and defaults to `true`.
It is best-effort in a way the rest of the app is not — **iOS Safari implements
none of the Vibration API** — so nothing is ever confirmed by touch alone, and
`SettingsModal`'s hint says so on a device that cannot do it rather than leaving
the user to conclude the app is broken.

**`analyticsDisabled` is the third row, and the only one that is not about how
the app behaves for the user.** Google Analytics is opt-_out_: the stored field
is the refusal, matching gtag's own `ga-disable-<id>` switch, and the row is
presented as the affirmative — lit when collecting — because every switch in
that column means "this is happening".

**It is three states, like `animations`.** Absent means nobody has chosen, and
then the browser answers: `doNotTrackRequested()` reads Global Privacy Control
as well as `doNotTrack`, because DNT is gone from Safari and never had a UI in
Chrome. Both are compared to `"1"` rather than coerced — `"0"` means _yes, you
may_, and it is truthy. An explicit choice then wins in both directions.
`analyticsOptedOut(choice)` holds that rule for the two callers that resolve it,
`main.ts` at boot and `uiState` for the switch.

Three things in `utils/analytics.ts` are what make the opt-out real: the tag is
**not in `index.html`** (a `<head>` script sends its `page_view` before any
preference has been read), it is fetched **on idle** after mount so it never
competes with the atlas, and switching off sets the disable flag on a tag
**already in the page**. `setAnalyticsEnabled` is idempotent and fetches at most
once, which is what lets one function serve both the boot path and the switch.
The measurement id is a constant, since it ships in the bundle anyway.
`utils/analytics.test.ts` pins every branch — each fails either open (a page
view for someone who said no) or closed (the tag off for everyone), and neither
is visible in the app.

**Four events beyond `page_view`**, each fired from the one place that knows
the answer: `solve_run` and `solve_done` in `runOptimizer` (paired, so a status
other than `ok` is countable rather than inferred from a run that never
reported), `share_copy` in `copyShare`, and `board_failed` in `PixiCanvas`'s
init catch — one event for both halves, since an atlas that never arrives and a
WebGL context that never starts are the same empty board. `trackEvent` buffers
until the tag lands, because it is fetched on idle and the app is usable well
before that; nothing buffered before an opt-out is ever sent. A param is not
reportable until it is registered as a custom dimension or metric in GA.

Those three are the **only** preferences in a Settings dialog, deliberately:
every other setting — run length, which board is drawn, whether the readout is
folded — sits beside the thing it changes, because choosing it is part of doing
the task. These are about the app rather than the board.

**Settings and Setup are two things.** The panel is named **SETUP**, never
_Configuration_ — a synonym for _Settings_ offers two differently-named doors and
no way to guess which holds what. The split is real: the panel holds the **solve's inputs** (which island, which buildings, how
long a run may take), all of which change what comes back from a run, while
Settings holds preferences about **the app** that no solve can see.

**Sharing follows the board on screen.** `shareLayout()` encodes
`visiblePlacements`, so the solve is shareable. `copyShare(form)` is the only
write to the clipboard and is always a direct response to a press, which is also
what makes it land: some mobile browsers refuse a clipboard write not tied to a
user gesture.

**The bottom line of the screen is `uiState.showToast`, and it is general** —
not hard-wired to any one caller. `tone` is not decoration: `ok` confirms something that
happened, `warn` says something did _not_ and why. A second call replaces the
first rather than queueing — this is the bottom line of a phone, and a backlog
there is a backlog nobody reads.

Its first `warn` caller is **`requestSolve` refusing a roster that cannot produce
power.** The test is `configState.canProducePower`, not "is anything unlocked": a
roster of coolers, or of reactors with no generator, is not empty and still
cannot come back with a number — the run would spend its whole budget and hand
back a blank board with nothing on screen saying why. `rosterCanProducePower` in
`data/effectiveBuildings.ts` restates `docs/game-logic.md` over the resolved
roster: a direct producer is self-contained and needs only cooling; a generator
needs a reactor, because heat comes from nowhere else; and either counts only if
its waste has a cooler to go to. It tests `waste <= 0` rather than
`wasteIsCovered`, because the question is whether cooling _exists_, not whether a
given layout covers a given building — that needs a board and is
`simulateIsland`'s job. `data/rosterPower.test.ts` pins every branch, since each
is a way the guard fails open (a wasted five-minute run) or closed (a refusal on
a roster that would have worked).

There are two messages, because the two failures want different things done about
them: nothing unlocked at all, versus a roster with a part missing. Both name
Setup, because on a phone that is behind a button and a closed sheet. The guard
sits _after_ the stop branch — pressing STOP must work whatever the roster says —
and Run stays live rather than going disabled, since a dead primary action
explains nothing.

**A layout leaves the app a third way: as a picture.** `saveLayoutImage()` (the
overflow menu's _Save as image_) downloads the board as a PNG. A share code and a
link both need this app to read them, which is no use for a forum post; a picture
travels anywhere. It follows the same board Share does, and it is allowed in
preview because it writes nothing the visitor owns.

**The power is in the filename** — `reactor2-island-3-12AA-345T.png`, from
`layoutImageFilename`. A picture is the one form of a layout that carries no
figures inside it, so a folder of these sorts and compares without opening any.
`formatNumberForFilename` comes from `@reactor2/solver`, which is what the CLI
names its own output with, so a board saved from the app and one solved from the
terminal spell the same figure the same way — dots turned into a second whole
tier after a hyphen, because a dot in a filename reads as an extension. The board is named by its **id** (`island3`, `custom2`)
rather than its title: the id is already the "which island", and unlike the title
it survives a rename.

The capture is `PixiCanvas.exportBoardImage()`, and it takes the **grid
container**, not the visible canvas. `getLocalBounds()` ignores the container's
own transform, so what comes out is the whole board at its authored sprite scale
— not the part the window happens to be showing, and not whatever zoom was last
pinched to. `clearColor` is the board's own green, so the margin is board rather
than a transparent halo that most viewers render black.

**The scale is a Settings preference** (`uiState.imageScale`) and is **passed
in** rather than read by the renderer — the same split `setAnimated` makes. 2x
is where the export used to be fixed, and it is now the _ceiling_: it puts a
large board past 5MB, so 1x is the default and the reason the setting exists. `EXPORT_MAX_SIDE_PX` in `pixi/boardExport.ts` still
wins outright over it, and is not floored at 1x: a render texture past the GPU's
cap comes back blank rather than large, so the scale is backed off rather than
the picture cropped. Settings names that cap in its hint, which is why the two
constants live in a module of their own instead of inside `PixiCanvas`.

**Two boards can exist at once** — the user's hand-placed buildings and the last
solve's — and `visiblePlacements` is the single answer to which is on screen.
`PixiCanvas` renders it and `inspectedBuilding` reads it, so the card cannot
describe a building the board is not drawing. `placementView` (`"user"` |
`"solver"`) is the user's choice, persisted in `ui_prefs` so a reload lands on the
same board as the restored solve; `showingSolver` falls back to the user's board
when there is no solve.

Placing a building by hand switches the view and **keeps** the solve — it must
never delete a five-minute run to show a one-building board; starting a solve switches it back (an `$effect` in
`PixiCanvas`, on the edge of `isOptimizing` — `solverState` cannot reach `uiState`
without breaking the DAG).

## The readout (`inspector/BoardStatsCard`)

The app's only readout, and one component with two panels (`uiState.statsPanel`
picks between them): the solve's figures
while the solver's board is up, the live simulation of the player's own buildings
while theirs is, and nothing at all on an empty board of their own rather than a
card full of zeroes. A run in flight outranks both, because it must stay stoppable
before it has a first result.

It carries three figures — power, the bound it is measured against, and how long
the solve took — and the inspected tile at its foot: bare ground is one line, name
left and position right, while a building adds its sprite, a `Lv. n` chip and its
figures as labelled rows in `BuildingUnlockCard`'s idiom, so a building reads the
same wherever it appears.

**The level chip is 1-based**, matching the sidebar's tier buttons, which number
themselves `idx + 1` — the two must agree or the same building reads as two
different tiers in two places. It resolves through `levelIndexForValue` (the
inverse of `placementBaseValue`) from the placement's own `baseValue` rather than
from the roster, the same rule the figures beneath it follow: it names the tier
the building was _placed_ at and the scorer ran it at. Reading the roster instead
would print a level the ceilings under it contradict. It sits under the name
rather than beside it because on one line the two competed for a phone's width
and the name had to ellipsize; stacked as a column (`.tile-id`), neither yields —
and that column is what pays for the sprite beside it being 40px rather than 30px.

Each figure row is **used / total** — `10.1AC / 13.3AC` — because the live figure
alone cannot distinguish a building doing nothing from one with little to do. The
ceiling comes from `effectiveAtValue`, so it is the tier the building was placed
at. **Cooling is the exception**: it is measured against the waste the building is
actually making, not the tier's full-tilt waste, because what it needs falls with
its fill — against the ceiling a half-fed generator would read as starved while
being perfectly covered. That row turns **red** when cooling does not cover waste,
and the test is `placementStatus` — the solver's own `wasteIsCovered` tolerance,
not a bare `<`, which would paint running buildings red.

**Failure counts.** What the card reports beyond power is the buildings that are
**not working**, split in two because the fixes differ: **Idle** (every figure
zero — a generator with no reactor beside it, a cooler nobody draws from; it needs
a neighbour) and **Overheating** (`placementStatus`'s `starved` — more waste than
the cooling routed to it covers, so the game shuts it down; it needs a cooler).
Both are numbers a player acts on, and neither has anywhere else to be said: on
the map a building doing nothing looks exactly like one that works. Each row
renders only when non-zero, so a board where everything runs says nothing at all.

They are counted for **both** panels: "a solved layout is stable by
construction" holds only for a layout the solver has _just_ returned, and
`rescoreResult` deliberately does not re-optimise, so a tier bought or locked
behind a standing solve can leave it unstable, and the card has to say so rather
than printing a power figure whose buildings have quietly shut down.

**Amber is idle, red is overheating, and that is the whole app's language rather
than this card's.** The status pad under every building says the same in the same
colours (`STATUS_FRAME` in `pixi/gridPainter.ts`), the building above it breathes
at a rate ranking the two the same way (`STATUS_PULSE`), and so does the Cooling
chip. A player who learns one reading has learnt all four, and they cannot drift
because every one is `placementStatus` over an already-scored row. Red goes to the
more urgent: an idle building is wasted money, an overheating one is shut down and
taking its cluster's output with it.

**When the solve has ties, the card grows a Layout row** — arrows, `n / total`,
and Apply. It renders only above one variant and never while a run is in flight:
the shortlist that run will produce does not exist yet, and the layout streaming
into the panel is not one of its entries.

**Reset asks twice** and acts on whichever board is showing: the solve, or every
hand-placed building. Switching panels disarms it, otherwise a press aimed at one
board would land on the other.

**Layout rules.** Everything under the head is a single `.card-scroll` —
figures and inspected tile together — capped by `.corner-cards` at the viewport
less header and HUD, with `min-height: 0` so it can shrink into that cap.

_One_ scroller, not two. Splitting them was the first attempt, so that "what did I
just tap" would not scroll away — but flexbox takes the whole shortfall out of
whatever can shrink, so a fixed tile section (~120px) crushed the figures to a few
pixels, and a scrollbar a few pixels tall is unusable. The head stays out of the
scroller because it is one line naming the board, and a scrolled card that no
longer says which of the two layouts it describes is worse than one line shorter.

`flex: 1 1 auto` on that scroller, and the `auto` basis is load-bearing: `flex: 1`
means a basis of **0**, and since the card's height is content-driven the card
would collapse to its head. `.scroll-body` in the sidebar can take the `0` basis
because its parent has a definite height; this one does not.

On a compact viewport the card **folds to one line** (title, power, the two
controls), because there it lies across the map being played. The state is a
persisted preference (`statsCardCollapsed`), and folding never hides the inspected
tile — that section is outside the fold — nor the failure counts: the collapsed
header carries a pill with the combined count ahead of the power figure, red as
soon as anything is overheating and amber otherwise. Folding puts the _figures_
away, not the fact that the board has a problem. A pill rather than bare text
because two numbers side by side with nothing between them read as one.

**Inspecting a tile folds it too** on a compact viewport, whatever the preference
says: a tile brings a sprite, a name, a chip and up to three stat rows, and
unfolded under a solve's figures that is most of a phone spent covering the board
whose tile was just tapped. It is **derived, never written** — dismissing the tile
puts the card back exactly as the player left it, where folding _by_ setting
`statsCardCollapsed` would have rewritten their preference on the way past.

Player-facing coordinates are flipped: `formatTileCoords` prints
`[x, height - y]`, because the grid indexes rows downward and the game counts them
upward from the bottom. That flip lives in the formatter and nowhere else, so the
two conventions never mix inside the model.

## Rendering (`components/canvas/PixiCanvas.svelte`, `pixi/gridPainter.ts`)

Grid rendering uses PixiJS (not DOM/CSS) via `GridRenderer`, built once an atlas
is loaded (`pixi/atlas.ts` loads `public/data/web_atlas.json`/`.webp`, packed by
an external script not in this repo; the atlas itself is committed). Isometric
projection math is in `utils/isoMath.ts`; pan/zoom/multi-touch is isolated in
`pixi/viewportControls.ts`.

**Every raster on the path to the first frame is lossless WebP** — the sheet, the
building icons, `hex.webp` and `logo.webp`. The sheet is the single largest
download, so its size is most of the cold start (1540KB as PNG against 1017KB
here; icons 382KB → 296KB). Lossless rather than lossy, which would have been far
smaller (471KB), because this is a sprite sheet packed with **2px of padding**:
lossy WebP smears colour across an alpha edge and at that padding the smear from
one frame lands inside the next, compositing as a halo on an unrelated sprite.
Lossless is pixel-exact on every visible pixel.

`meta.image` in the atlas JSON names the sheet, so `atlas.ts` follows it rather
than knowing the extension; the hard-coded name beside it is only a fallback.
**Icon URLs are the other half, and no data file carries them**: they are built as
`icons/<building id>.webp` at four call sites, so a roster re-exported in another
format means editing those four by hand.

**Three rasters stay PNG**, each because something refused the format ahead of it:
the favicon fallback and the apple-touch icon (Safari has never taken a WebP
favicon; iOS takes only PNG for Add to Home Screen), and the board's image export
(PNG is what every viewer and chat client takes without question). None is on the
path to the first frame.

**The status pads come from the atlas, all four of them.** `FRAME_KEYS` in
`atlas.ts` names `indicator_grid` / `indicator_normal` / `indicator_overheat` /
`indicator_idle`, and `STATUS_FRAME` in `gridPainter.ts` maps a
`PlacementStatus` onto the last three.

**A building that is not working breathes.** The pad says _what_ is wrong in
colour; the pulse says _that_ something is, and motion is what the eye finds
without being told where to look. `STATUS_PULSE` and the raised-cosine
`pulseAlpha` live in `pixi/statusPulse.ts`, split out so `statusPulse.test.ts` can
pin them without dragging PixiJS into a test. Four things are load-bearing:

- **`active` is absent from the table, not mapped to a no-op.** A board where
  everything works is _completely_ still, which is what makes movement mean
  something — and it keeps the ticker free, since the registry is empty.
- **Overheating pulses faster and deeper than idle** (900ms to 0.35 alpha, against
  2200ms to 0.55) — the same ranking the colours carry.
- **The curve starts at 1 and falls**, so a building that has just appeared fades
  in from full opacity rather than blinking on at its dimmest, which reads as a
  glitch. Every sprite is given the _same_ elapsed time rather than its own phase,
  so the board dips in step; staggered phases read as decoration.
- **The registry is keyed by tile and cleared in `renderTileVisuals`.** That
  method destroys and rebuilds a tile's sprites, so an entry left behind is a
  `tick` writing alpha into a destroyed sprite.

The clock is the app's own Pixi ticker, wired in `PixiCanvas` — Pixi is already
drawing every frame, so a second `requestAnimationFrame` loop would buy nothing.

**The renderer does not decide whether to animate; it is told.** `GridRenderer`
has `setAnimated(on)` and no media query of its own, because the effective answer
is the user's Settings choice _or_ `prefers-reduced-motion` when they have made
none, and picking between those is the state layer's job. An `$effect` in
`PixiCanvas` pushes it — an effect rather than a one-time call, because both
halves are live and a board already on screen has to settle or start breathing
without being rebuilt. That effect gates on `isAtlasLoaded` rather than on
`gridRenderer`: the renderer is a plain `let`, so assigning it re-runs nothing.

Two details of "off" are load-bearing: failing sprites **stay in the registry**
and are held at the floor of the breath they would otherwise take (no movement,
but the state is still visible, and they can start again without rebuilding the
board), and `setAnimated(false)` **settles them explicitly** rather than freezing
them wherever the last frame left them — mid-breath is an arbitrary opacity that
says nothing, the floor is the animation's resting point.

## Canvas gestures (`pixi/viewportControls.ts`)

`ViewportControls` owns pan, pinch, wheel, the glide after a flick, the bounce at
the edges and the double-tap zoom. It imports **only** the `Container` type from
PixiJS, which is what lets `viewportControls.test.ts` drive it through hand-rolled
stand-ins, firing at the listeners `attach()` registered exactly as a browser
does. Keep it that way.

**Two clocks feed it, and neither is its own.** `PixiCanvas` drives `tick()` from
the app's Pixi ticker in the same callback as the status pulse, and pushes
`uiState.animations` in through `setAnimated`. With animation off the glide, the
bounce and the double-tap all still reach the same place; they just do not travel
there.

**A board at rest costs the ticker nothing.** `tick()` returns immediately unless
something is in flight, and whether the board owes a bounce is a tracked flag
(`outOfBounds`) rather than a test — the test would mean reading
`getLocalBounds()` sixty times a second, which is cached in Pixi v8 but still
walks every tile node to find out whether the cache holds. Only a resisted gesture
and a glide can put the board out of range, and both set the flag.

Eight rules are invisible until they are wrong. Each is pinned by a test in
`viewportControls.test.ts` — read the test before changing the behaviour:

- **A pinch that ends with one finger down re-anchors on it** (`syncPinchAnchors`
  does the same when a third finger lands or leaves), or the next move resolves
  against a stale origin and the board snaps back by everything the pinch did.
- **A pinch anchors on the world point under the _previous_ midpoint.** The
  current one cancels algebraically, so the board zooms without panning.
- **`pointerdown` takes `setPointerCapture` on the wrapper**, or a drag onto the
  floating chrome leaks a pointer into `activePointers` forever and the next
  touch reads as half a pinch. It is also what makes `endStroke()` land on a
  gesture that finishes off-canvas.
- **Both zoom limits are relative to the fit, not flat** — `MIN_ZOOM_FACTOR` of
  the framed scale as the floor, `Math.max` against the fit as the ceiling, so a
  three-tile island can still reach its own framing.
- **Overscroll resists rather than stopping dead** (`setPositionResisted`,
  `settle`), applied to an absolute position rather than an increment so the
  damping is re-derived each frame rather than compounded.
- **The double-tap is armed in `startPan`, not `pointerdown`** (`armDoubleTap:
false` on a writing press), and commits on the second tap's _up_.
- **`hasOtherPointer(id)` must be asked by id.** Pixi's handler runs a bubble
  earlier, so a count reads the state before this finger landed, and the second
  finger of a pinch places a building.
- **A vertical-only wheel still zooms**, this board's existing convention; a
  `ctrlKey` or a `deltaX` pans instead, and `deltaMode` is normalised through
  `WHEEL_LINE_PX` (Firefox reports lines, ~3 against Chrome's ~100).

### A finger writes on lift, or after a hold; a mouse writes on contact

**On a touch screen one finger is the only way to move the board**, so a press
that writes on contact takes panning away for as long as a tool is held — which on
a phone is most of the time. Dragging with a building selected laid a row of
buildings instead of moving the map, and a pinch buzzed, placed something and
_then_ zoomed.

`plannedAction(button)` is the shape of the fix: it returns the write a press
performs as **a function of the tile** (`TileAction`, `true` if it wrote), or
`null` when the press writes nothing and is therefore a pan. _When_ and _how
often_ that runs is the gesture's business, and there are three answers:

- **A tap writes on the lift.** A touch press arms the action (`pendingEdit`) and
  starts a pan; the write lands if the finger comes up within `TAP_SLOP_PX` of
  where it went down, and is dropped the moment the gesture turns out to be
  something else — past the slop, a second finger, a `pointercancel`.
- **A hold turns the finger into a brush.** `HOLD_TO_EDIT_MS` (350ms) of stillness
  calls `lockEdit`, which takes the pan back (`cancelPan`) and hangs the action on
  `dragAction`, so every tile the drag crosses is written. Deferring to the lift
  alone would have cost the drag — a painted row became a tap each — and a hold is
  the standard way to say "no, I meant this one". It costs the pan nothing,
  because a pan begins by _moving_.
- **A mouse or a pen runs it on contact**, and drags from there. Those pointers
  have a middle-button drag and a wheel to navigate with, and cannot pinch.

**The haptic marks the decision, not the tile.** It fires on the tap that placed
something, and once at the lock — the moment the press stops being a pan is the
only thing that tells the user which of the two it became, and with the finger
still down a buzz reads as the board taking hold rather than as an after-the-fact
report. The drag that follows writes in silence: a buzz per tile across a painted
row is a rattle, and says nothing the first has not.

Two consequences. `TileAction` is what lets a press capture _its own_ action
rather than the hover handler re-deciding — a right-button erase-drag would
otherwise come back as whatever the left button paints. And because a touch press
has written nothing when a second finger lands, the pinch case needs no undo at
all: dropping `pendingEdit` is the whole of it.

**The grace window survives for the press this cannot cover.** A pen or a mouse
writes on contact, and on a hybrid machine a touch can arrive beside one — so
`PixiCanvas`'s wrapper-level `pointerdown` still calls `layoutState.cancelStroke()`
if a second finger lands within `PINCH_GRACE_MS`. `cancelStroke` restores the
board as it stood when the stroke opened and leaves **no entry in either stack**,
which is the whole difference from `undo()`: undo is a move the user made and Redo
can reach back through it, this is the removal of a write they never asked for. It
restores the Redo branch `#record` cleared, too. The second finger is identified
by `isPrimary`, so the rule does not depend on listener registration order.

**The stroke is still opened at `pointerdown`**, on every non-read-only press, and
both a deferred edit and a held drag write into the one their own press opened —
so one gesture is one undo entry whichever pointer made it and however many tiles
it crossed. That is also why `plannedAction` holds _every_ branch that can change
the board: it keeps the enclosing `beginStroke` a guarantee by construction rather
than a list to keep up to date.

**A tap on the green beside the board dismisses the pinned card.** A pin outlives
the tap that made it, so without this the only ways to be rid of one are to tap the
same tile again — on a board that has probably since been panned away — or to open
the sheet. Three rules keep it from firing on gestures that are not that tap, and
all three live on `pendingDismiss` being a _position_ rather than a boolean: it is
committed on the lift within `TAP_SLOP_PX` (the empty green is _the_ place to grab
the board and pan it); a second finger disarms it; and it arms only when there is a
card, so on a board with nothing pinned this is inert and the double-tap zoom on
the empty green is untouched.

Whether the press hit a tile is `pressHitTile`, written by the tile handler and
read by the wrapper's own `pointerdown`. Pixi dispatches from a listener on the
canvas — a _child_ of the wrapper — so the tile handler has always run by then.
That ordering is bubbling rather than registration order, which is what makes it
safe to depend on; `ViewportControls` keeps its own `handledByTile` for the same
question because it asks from a wrapper listener, where the order against this
component's would be a coin toss.

## The board is framed in what the chrome leaves free

`ViewportControls.recenter()` takes an `inset` — the header along the top, the HUD
along the bottom, the docked sidebar down the left — and both fits _and_ centres
the board inside the band those leave. The canvas is full-bleed and everything
else floats over it, so without the inset the board was sized against, and centred
in, the whole window.

The margin is `0.92` of the **band**, not of the window. It can be that tight
because the room it leaves is real room, rather than room the HUD was already
standing in.

Four things about this are easy to get wrong:

- **All three insets are measured** by the components that own them (see project
  conventions). The header's edge is `uiState.headerBottom`; before it was
  measured, everything under it used a hard-coded `4.5rem`, which overlapped the
  bar on desktop — and `--z-sheet` outranks `--z-header`, so the sidebar drew
  over it.
- **`PixiCanvas` re-frames once at startup**, when those measurements first land,
  because the effects publishing them need not have run before the atlas finishes
  loading. It does _not_ re-frame when the HUD grows a palette row — that would
  yank the board out from under a player mid-tap.
- **It does re-frame when the docked panel folds**, because folding hands 380px
  back and the HUD row tracks the same edge. But only while the framing is still
  the app's: `isUserAdjusted` goes true the first time anyone pans or zooms, and
  after that nothing but Center View may move the view. Re-framing someone's
  chosen view because a side panel folded is the app overruling a deliberate act.
  `recenter()` clears the flag, which is what hands control back.
- **`recenter` ignores an inset that would leave less than 40% of the axis.** A
  board framed inside a sliver is worse than one framed in the whole window, and a
  phone in landscape with a ribbon open can leave very little.

**The readout is an inset only when it is a band.** On a phone it goes full-bleed
under the header, so it is chrome over the board: excluded from the inset,
Center View frames the board _behind_ it. On a wide screen the same card is 250px
in the top-right corner, where the board may happily run underneath it.

Three things about how it is read:

- **Which of the two it is, is measured, not looked up.** `PixiCanvas.readoutInset`
  compares its rect to the document width rather than repeating the `640px`
  breakpoint that decides it in `App.svelte`'s CSS. A second copy of that number in
  a second language is a thing to get wrong later.
- **It is read from the DOM at the moment of framing**, not published as a
  measurement — hence `uiState.statsRef` being an element and not a number. The
  card changes height as the board does (a solve lands, a row appears, the user
  folds it), so as `$state` every framing effect would depend on it and the board
  would jump each time the card grew a line. `recenterGrid` reads all four insets
  inside `untrack` for the same reason.
- **A readout past `MAX_READOUT_INSET` of the viewport is ignored.** `recenter`'s
  own `MIN_BAND` guard is against the total; this one is against the readout alone,
  because on a short landscape phone an unfolded card can be most of the screen.

## Board and terrain rules

### Shipped islands are fixed maps

`layoutState.canEditTerrain` is true **only for the user's own custom islands**.
On a shipped template the terrain is read-only and the controls for it are not
rendered. `editorState.paintTile` and `layoutState.resize` both refuse anyway, as
the backstop for a tool that survives a template switch
(`editorState.clearHand()` is what normally prevents that).

Two things stay open, because they are the player's actual moves rather than
terrain authoring: **placing and removing buildings**, and **erasing an
obstacle** — `eraseTile` only ever writes grass over a rock/tree/pond, so it
cannot reshape a map.

The reason to keep this rule is that a shipped island _is_ the puzzle. If it can
be repainted, "solve island 3" becomes "draw an easier island 3", and a share code
for `island3` can describe a board no other player can reach.

**Clearing an obstacle is reversible.** `layoutState` keeps the loaded template's
pristine tile types (`#pristineTypes`) alongside `#pristineKey` — the key is a
one-way hash that can say _that_ the board changed but not _what_ used to be on a
tile, and restoring needs the original type. `restorableObstacles` is every tile
whose pristine type was an obstacle and which is now bare grass;
`restoreObstacle()` puts one back and refuses anything else, so a stale click
cannot invent terrain. The HUD's Restore toggle appears only when that list is
non-empty, and while it is on the renderer ghosts those tiles
(`GridRenderer.setGhosts`). Without this, clearing was a one-way trap on a fixed
map whose only undo was Reset — which also discards every building placed.
`state/terrainRules.test.ts` pins the round-trip and both refusals.

Ghosts live in their own Pixi container rather than in the per-tile prop nodes,
because `renderTileVisuals` clears those whenever a tile's state changes.

**Importing therefore always creates a new custom island**
(`layoutState.importBlueprint`). It cannot land on a shipped template, and
deliberately does not overwrite the current custom island, since that would be a
destructive act with no undo behind a button marked "Import". At
`MAX_CUSTOM_ISLANDS` it refuses and says so.

### The transformer is special

Two rules the other tile types do not have, both enforced in `editorState`:

- **It cannot be erased.** `eraseTile` refuses it — it is the board's power
  hookup, not scenery. A consequence: it can never become a cleared obstacle, so
  it never appears in `restorableObstacles`.
- **A board carries at most one.** Painting one when the board already has a
  transformer **moves** it rather than adding a second.

Moving, rather than refusing the second placement, is the only reading of the two
rules that works together: it cannot be erased, so a refusal would make a
misplaced transformer permanent on a custom island, with no way back short of
deleting the island.

`layoutState.findTransformer()` is the query the rules read; the rules live in
`editorState`, because `layoutState` applies no editing rules of its own.
`importBlueprint` also rejects a code carrying more than one — the editor cannot
produce such a board, so one that exists was hand-edited, and accepting it would
hand the user a layout they can neither reproduce nor repair.

All eight shipped maps carry exactly one transformer despite having 4–12 separate
landmasses, which settles "one per **map**" rather than one per connected
component. `state/terrainRules.test.ts` pins that against the shipped codes.

### The board has an undo

`layoutState` keeps a bounded stack of whole-board snapshots (`BoardSnapshot`,
`MAX_HISTORY` of 30) and every verb that writes the board — `setTile`,
`addPlacement`, `removePlacement`, `clearPlacements`, `resize` — records the board
as it stood _before_ the change. The only other way back from a mis-tapped
building is the readout's Reset, which throws away every other building with it:
a larger mistake offered as the cure for a small one. It earns
its keep on a phone, where the board is isometric, the tiles are small and a thumb
covers several at once.

Four rules, each pinned by `state/boardHistory.test.ts`:

- **Snapshots, not deltas.** A board is a few hundred tile types and a handful of
  placements. Thirty cost little, and the whole class of bug where an inverse
  operation turns out not to be the inverse cannot arise, because nothing is
  inverted.
- **A gesture is one undo.** `beginStroke()` / `endStroke()` open a coalescing
  window that `PixiCanvas` wraps around every press, so a drag across twelve tiles
  is one entry, and a tap that replaces a building (a remove _and_ an add) is also
  one. Opened for every press rather than at each writing branch, so each way a
  press can change the board is covered by construction; a stroke that writes
  nothing records nothing.
- **History never crosses a board.** `#clearHistory()` runs in
  `#applyBaseTemplate` and `loadPreview` — the two places a board arrives from. An
  undo that survived a template switch would paint one island's terrain onto
  another.
- **A restored board is re-scored, not un-scored.** `#restore` calls
  `recalculate()` rather than trusting the figures in the snapshot.

Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y are wired in `App.svelte` and deliberately sit out
three cases: a modal being open, focus in a text field (the browser's own undo is
the right one there, and Import is a textarea), and a previewed board.

### A shared link is a preview, not a board you own

Arriving with `?bp=<code>` puts the app in **preview**: someone else's layout on
screen, `layoutState.isPreview` true, and nothing the visitor owns disturbed.
`hydrateState()` still hydrates their own board first — so `exitPreview()` is a
plain re-hydrate with somewhere to return to — and then overlays the shared one;
an unreadable code just leaves them where they were.

It is **fully read-only**, and that is one rule with a lot of surfaces:

- `canEditTerrain` is false, `editorState.eraseTile` refuses (`paintTile` already
  reads `canEditTerrain`), and `PixiCanvas` drops to pan-and-inspect.
- `persist()` and `#saveState()` return early, so no island, no saved grid and no
  preference moves. `importBlueprint` throws outright — it claims an island slot
  that `#saveState` would then refuse to write.
- `rebasePlacements` sits it out. A previewed board is rated at **the author's**
  tiers, read from the code's tier table, and it is the one board the reader's
  roster does not speak for. This is the reason the tier table exists.
- The HUD and the config panel are not rendered at all, so there is no Run button
  and no roster.

Two ways out, both of which clear the parameter so a reload does not drop the
visitor back in: `adoptPreview()` takes the board as a new custom island — and
re-bases it to the visitor's own unlocks on the way in, because once the board is
theirs it is their roster that rates it — or `exitPreview()` simply leaves. An
adoption that is refused (island cap, two transformers) puts the flag back and
leaves them reading. `state/previewMode.test.ts` pins every refusal.

The state lives on `layoutState` rather than `uiState` because it is a property of
the _document_: this board is not saved, not editable, and not the player's.

### Grid data model

Tiles are typed `water | grass | rock | tree1 | tree2 | pond | transformer` — only
`grass` is buildable; all others are obstacles.

## The HUD and the panels

### Run lives in the HUD, not in the config panel

`hud/BoardActions.svelte` carries Undo, Redo and Run/Stop, and it is the only Run
button in the app. It cannot live in the config panel, because a `pointerdown`
anywhere in the HUD **dismisses that panel** — which would make the loop the app
exists for, paint then run, cost two extra taps every time round, and on a phone
would put Run behind a closed sheet.

What stays in the panel is `SolveModeSelector`: how long a run may take is a
setting chosen rarely and belongs beside the roster; starting the run is not a
setting.

**`BoardActions` stops `pointerdown` from bubbling**, so pressing Run does not
dismiss the panel. Not a matter of taste: at the sheet's `peek` detent the HUD is
lifted above the sheet, so dismissing it drops the row by 176px between
`pointerdown` and `pointerup` — the button slides out from under the finger and
the click never lands.

### The HUD dismisses the config panel

A `pointerdown` anywhere in the HUD stack closes the mobile sheet and folds the
docked sidebar (`uiState.collapseSidebar()`, idempotent so repeated calls do not
churn storage). Reaching for a tool means the user is done with the panel. Both
presentations need it for the same reason — the panel is sitting on top of the
thing being used. On a phone the sheet at `peek` holds the bottom
`sheetPeekHeight`; on a wide screen the sidebar is 380px pinned left while the HUD
centres across the full width, so below roughly 1200px they overlap and
`--z-sheet` outranks `--z-hud`.

**The sheet starts `closed`.** With Run in the HUD, peek would buy a strip of
_setup_ — none of which is the first move, and all of which costs the map about
150px.

**And the HUD stands down for as long as the sheet is open** — `App.svelte`
unmounts the whole stack while `sheetDetent !== "closed"` on a compact viewport.
They are both bottom-anchored, so otherwise both sit on screen at once: two
stacked bands of chrome over the board at the one moment neither is in use.

Three things follow: `sheetLift` is gone (`.hud` is simply `bottom: 0`);
`hudHeight` is **cleared when the stack unmounts** (the `$effect` returns a
teardown), since a stale inset reserves room for a bar that is not there; and
Escape and the scrim close outright rather than back to `peek`, which would leave
a sliver of Setup with every tool gone — dismissed, but not back to the board.

### The HUD's category buttons are toggles

Pressing the open one closes its ribbon (`activeBuildingCategory` is nullable),
which is what every other mode button in the stack already does
(`editorState.selectTool`, `selectBuilding`).
The ribbon is ~62px of chrome over a board the player is trying to see, and Back
is not an answer because it leaves buildings mode altogether. Closing **puts the
brush down too**: a building selected from a palette that is not on screen is a
hand nothing shows you are holding, and a tap would still place it.

### The solver's board is a result, not a canvas

`uiState.showingSolver` makes the board read-only, and the difference is not
cosmetic — a tap must never place a building and silently switch you to your own
board to do it, so `PixiCanvas` drops to pan-and-inspect there.

Everything that edits goes with it: `HudToolbar` renders no palettes and no tool
row, which takes the HUD from 180px to 118px. An `$effect` there also calls
`editorState.clearHand()`, because a brush held from a moment earlier would be
invisible _and_ still selected, with `PixiCanvas` refusing its taps for reasons
nothing on screen explains. **Undo and Redo are absent** too — they act on the
board the _user_ builds, so on the solver's an undo would land silently on the
other board while the press read as broken. Gone rather than greyed, because this
is a mode rather than a momentarily empty history.

**The way off that board is `uiState.copySolveToBoard()`**, offered as a Copy
button in the readout's head. A solve is as often a starting point as an answer —
a player wants what the search found, with one cooler moved, without rebuilding
forty buildings by hand. Three things about it: it
copies the layout **on screen**, not the applied one (`visiblePlacements` follows
the previewed variant); it is **one undo entry** (`adoptPlacements` records before
writing), which is what lets it overwrite an existing board without being a
one-way door, and it deep-copies so the two boards go on existing side by side;
and it **only asks twice when there is something to lose** — making the common
first use a two-press ceremony teaches people to double-tap without reading, the
habit that makes a confirmation useless on the day it matters.

**The toggle's left half says `Edit`, not `Yours`.** Ownership is the wrong axis
when the other half is read-only: both layouts are the player's, and the
difference that matters is that only one can be built on. It is **right-aligned,
not centred**, sharing an edge with the action pill so the two read as one stack
of board controls rather than three pills in a triangle.

**The way back into Setup is a sibling of Run, not a pill above it** — two
bottom-right pills on two lines read as one control that has grown a second head.
It is a button inside the action row, with `margin-right: auto` pushing Run to
the far end — Run takes the right, being the primary action and the easier
thumb reach. The view toggle cannot join them: Setup + toggle + actions is 425px
of pills in 374px of phone, so on a compact viewport it takes its own centred line
above (the paired `{#if viewportState.isCompact}` blocks).

**On a wide screen the collapse handle names itself.** Collapsed, it is a 28px
chevron against the left edge with nothing to say what is behind it, so it carries
a vertical `SETUP`; expanded, it drops back to a plain chevron. The collapsed
transform is `translateX(calc(-100% - var(--safe-left) - 0.75rem))`, matching the
panel's own `left` exactly so its right edge lands on 0.

One more thing about that row on a phone: it is full-bleed and centres its tools
with `justify-content: safe center` rather than packing them left, because on a
shipped island the terrain brushes are not rendered and the row can be as few as
three buttons. The `safe` keyword is what makes centring usable instead of a trap
— when the row _does_ overflow, plain `center` spills it equally off both ends and
the first tool becomes unreachable, since a scroll container cannot scroll back
past its start edge. `safe center` falls back to `flex-start` in exactly that
case, and a browser too old to parse it drops the declaration and gets the old
left-packed behaviour.

One listener on the container covers every control inside it, because events from
descendants still bubble through an element with `pointer-events: none` — that
property only stops the element being a hit target itself, which is what keeps
canvas drags working through the HUD's empty margins.

### Setup is three tasks, and it shows one at a time

The panel holds three unrelated jobs — **which island**, **which buildings** and
**the Time Lab** (research, then anomaly). Stacked in one scroller with the islands on top, the roster is
never on screen when Setup opens on a 390x844 phone, and the Reactors tab behind
it is 24 cards.

The Time Lab is a tab rather than a row somewhere because it is a third input of
the same kind, not a qualifier on either of the other two: it changes what a run
comes back with, it is set once and then tried against island after island, and
it needs room — four cards, each with the game's own icon and wording. Three
labels do fit a 374px phone, but only because each may ellipsize (`min-width: 0`
on the buttons).

`uiState.setupTab` picks between them and `ConfigSidebar` renders the switch and
the body as **snippets**, used by both shells: a sheet and a docked column differ
in their chrome and their gesture, never in this. Four things about it:

- **It defaults to `islands`, and is not persisted.** The roster and the Time Lab
  are set once; both are then tried against one island after another, so the
  island list is the recurring task. This is view state, not a preference.
- **The switch sits between the fixed top region and the scroller.** Inside
  `.sheet-top` it would inflate the measured `peekHeight`; inside `.scroll-body`
  it would scroll away, and the one control that says where you are is the last
  thing that should leave the screen.
- **The inactive half is unmounted, not hidden.** They share one scroller, so a
  hidden section shares its scroll offset — landing the roster halfway down
  because the island list is scrolled there.
- **It is an underline, where the category tabs inside the roster are filled
  pills.** Two rows of identical tabs stacked on each other read as one confusing
  row of five. Both take `--neon` for the active one, because the colour law has a
  single meaning for "this is selected"; the hierarchy is carried by shape.

Two things follow. The roster's category tab bar is **sticky** at the top of the
scroller, since it otherwise scrolls off after the third card and changing
category means scrolling back the length of the list. It is the only thing pinned: Unlock/Lock All sit just below it and
scroll away with the cards, because pinning is for the control you reach for
_while_ reading a list and those two are a bulk edit made once. Its background must
be **opaque** (`--surface-panel-solid`): the sheet is 97% and the panel 88%, so
either would leave cards faintly legible through the bar.

**That bar's `z-index: 1` only holds because `.building-card` isolates.** The card
stacks three things internally, and `position: relative` with `z-index: auto`
creates no stacking context, so those 1/2/3 were never local: they competed in the
same context as the sticky bar and every card scrolled straight over it.
`isolation: isolate` on the card is the fix, because the ordering it wants is the
default one and only the containment was missing. Raising the bar instead would
have papered over it until the next card gained a layer.

Both controls also drop a rung off the `--tap` floor — `--ctl` for the category
tabs, `--ctl-sm` for Unlock/Lock. A row you scroll past once is charged to the
list once; pinned, it is charged against every screen, and 44 + 44 of permanent
chrome was most of what pinning was meant to hand back. That puts both under the
44px touch guideline, and **"Lock All" is armed** to pay for it: it empties the
whole roster and `configState` keeps no history, so it is the one control in the
panel that destroys work with nothing behind it. "Unlock All" is not armed — it
only ever adds, and the way back is the button beside it.

**The HUD's Setup button opens the sheet at `full`, not `half`.** Half kept the
top of the board visible at a cost of 340px of list — but the HUD and every tool
unmount for as long as the sheet is open at _any_ detent, so what that bought was
a view of a board nothing could touch. Setup is a task you finish and leave; the
grabber still drags it back down.

### The interface can be put away

`uiState.uiHidden` takes every pixel that is not the board off the screen —
header, banner, readout, HUD, panel and scrim — and leaves one small button in the
corner. The board is what this app is about and everything else is chrome standing
on it; there are moments when none of it is wanted, reading a finished layout most
of all.

Five things about it, each a way it would otherwise leave the app with no way out:

- **`App.svelte` gates the chrome as one block**, not per component, so a layer
  added later is hidden by default rather than being the one thing left floating
  over a bare board.
- **Not persisted**, unlike every other preference on `uiState`. A reload that came
  back with the whole interface gone would read as the app being broken, and one
  unlabelled button is too thin a thread to hang a returning session on.
- **`setUiHidden` closes the menu, the sheet and any dialog** on the way in — all
  three live in the layer being hidden. Coming back restores none of them: it is a
  return to the board, not a resumption of what was open.
- **Escape brings it back**, wired in the shell. The button is the only other
  route, and a player who misses it is looking at an app that appears to have lost
  its controls.
- **It puts the brush down** (`editorState.clearHand`). The palette that shows
  what is in hand goes with the chrome, and so does undo.

`recenterGrid` reads `uiHidden` and frames the board against the whole window when
it is set, rather than against the published insets — those do not all reset on
unmount (`hudHeight` clears itself, `headerBottom` and `sidebarWidth` keep their
last measurement), so a rotate with the interface away would otherwise frame the
board into a band reserved for bars that are not there. Toggling it also re-frames,
on the same terms as folding the docked panel: only while `isUserAdjusted` is
false.

## Assets and the deployed base

The app ships to **GitHub Pages**, which serves a project repository from a
subpath (`/reactor2-optimizer/`). `vite.config.ts` sets `base: './'` so one bundle
works there, on a custom domain and on localhost without knowing the deployment
URL at build time.

That covers every reference Vite can see — imported modules, and `url()` in
component CSS, which it rebases on its own. It does **not** cover a URL assembled
as a string at runtime: Vite cannot see it, so a literal `"/icons/x.webp"` ships
with the leading slash and resolves against the _domain_ root. On a subpath that is
a 404, and for `/data/web_atlas.json` it meant no sprite atlas and therefore a
blank board — the whole app broken on the only host it is deployed to, while
`npm run dev` looked perfect because a dev server is served from `/`.

So runtime asset paths go through `asset()` in `lib/utils/assetUrl.ts`, which
prefixes `import.meta.env.BASE_URL`. **Anything under `public/` is reached with
`asset("icons/x.webp")`, never a hard-coded leading `/`.** Component CSS may go on
using `url("/hex.webp")`.

The trap is that this class of bug is invisible in development and invisible in
the test suite, so it surfaces only on the deployed site. Grep for `"/` in `src/`
if a deploy comes back with missing art.

## Styling and the mobile shell

`src/app.css` is the token layer: the z-index scale, the colour law below, four
ladders (radius, type and control heights, the last including the `--tap`
floor), the
`env(safe-area-inset-*)` aliases, and the `.ribbon` / `.thin-scroll` / `.sr-only`
helpers.

**Never hard-code a z-index** — every layer has a token, and before they existed
the header, HUD, palettes and inspector all sat at `10` and stacked by whatever
order `App.svelte` happened to mount them in. Two layers sit at a token minus one,
and both are the same lesson. `PreviewBanner` is `calc(var(--z-header) - 1)`: it is
header chrome and shares the token, but it mounts _after_ the header, and at an
equal z-index DOM order decides — which put a status line over everything the
header opens. The overflow menu is a plain absolutely-positioned child of a bar
with a z-index of its own, so it is sealed inside that stacking context and cannot
climb out to reach a sibling; the bar underneath has to yield instead — which is
also the honest reading, since the header's controls belong over a status line.

Note `--z-sheet` deliberately outranks `--z-header`: the mobile sheet is 90dvh at
its `full` detent, so it has to cover a top-anchored header.

**A floating menu needs a bound.** `OverflowMenu` caps itself at
`100dvh - var(--header-clearance) - var(--safe-bottom) - 1.5rem` and scrolls
inside it. That list only grows, and unbounded it simply ran off the bottom of the
screen — and since the page cannot scroll (`html, body { overflow: hidden }`) and
the menu is absolutely positioned, rows past the fold were not awkward to reach but
_unreachable_.

### The ladders

Three scales in `app.css`, because the same kind of thing was otherwise sized a
different way by each author: **radius** (`xs` chips, `sm` buttons/rows,
`--radius` panels, `md` ribbon items, `lg` the sheet, `pill` for anything whose
radius is half its height), **type** (seven steps), and **control heights**
(`--ctl-sm` 32px inline steppers, `--ctl` 36px secondary, `--tap` 44px for
anything a thumb must hit). The audit is
`grep -rn "font-size: [0-9]" src/lib/components`, which should stay empty of
`rem`.

Two values are deliberately **off** the ladders, and both say so in place: the
Import textarea is pinned at `16px` because iOS Safari zooms the page in on a
focused field under that, and `BuildingUnlockCard`'s stat rows are a px-based
sub-layout of their own.

`--text-dim` is `#7d8da4` rather than the `#64748b` it looks like it wants to be:
it is the colour of nineteen small labels, and the darker value is 3.4:1 against a
panel — under WCAG AA. Measure against the _lightest_ backdrop a panel makes
(roughly `#112226`), not `--surface-void`, because light text loses contrast on
the lighter one.

### The colour law

The law lives at the top of `app.css`, one line each. Without it the palette
drifts to twelve-odd hues — a Share button wearing the colour the board uses for
"idle", grass painted the green that means "working":

|                 | means                                                       |
| --------------- | ----------------------------------------------------------- |
| `--neon`        | this control is selected / active. Nothing else.            |
| `--status-ok`   | the board only: this building is working.                   |
| `--status-idle` | the board only: this building is doing nothing.             |
| `--danger`      | the board: overheating. In the UI: this destroys something. |
| `--warn`        | a limit is reached, or this board is not yours to edit.     |
| `--anomaly-*`   | Setup's Anomaly tab only, and nowhere else.                 |

**The two board readings are reserved, and that is the whole point.** The pad under
every building, the pulse that breathes it and the readout in the corner all speak
them, so a player who has learnt that language must not meet it again on a button
that has nothing to do with it. `--status-idle` is `#facc15`, matched to the
`indicator_idle` pad so the tile and the card describing it are one yellow rather
than two. A control earns colour by being selected, or
destructive, or neither — and _neither_ is most of the header.

Two things follow in the CSS. `:global(.tool-btn.active)` in `HudToolbar` is the
single active rule for every tool button — `.erase-btn.active` is the one
override, two classes so it outranks, and red because it is the one tool that
destroys. And a control earns colour by being selected or destructive; _neither_
is most of the header.

One hue sits outside the law and says so in the file: `--heart`, for the donate
button, because a donate heart is pink everywhere on the web and `--danger` would
tell the user the button breaks something.

**The anomaly cards' green/red pair is the second exception, and it is a
narrower one.** `--benefit-*` and `--drawback-*` are sampled from the game's own
"Choose an anomaly" screen — both stripe fills and the text on each — because
that is the one screen in the app mirroring a screen in the game: the player has
just chosen there and is confirming here, so the pairing they read a moment ago
is worth more than a palette of our own. They are **not** `--status-ok` and
`--danger`, which stay reserved to the board, and reusing those would not even
have looked right: the board speaks as a saturated accent on a dark ground, these
are muted fills carrying near-white text. A player meets them as panels, not as
status lights, which is what keeps the reservation honest.

**`--anomaly-selected` is the sharper half of that exception**, because `--neon`
means selected everywhere else and on this list it does not: the chosen card is
ringed in the game's own green. Two selection colours is a real cost, and it is
taken for the same reason and stretches no further — showing a player their own
choice in a colour they will not recognise from the screen they made it on is the
larger one. Nothing outside `AnomalySelector` may take it.

**Three surfaces go purple while an anomaly is selected** — Setup on *every*
tab, the readout, and Run in the HUD — all reading `configState.hasAnomaly`, so
it is one signal rather than three effects. Keyed on the selection and not on
the Anomaly tab, because that is what it says: this timeline is not running the
ordinary rules, and the island list, the roster and the board's figures are all
read under them. Nothing selected puts every one of them back to navy, which is
the common case. Each surface keeps **its own alpha** — sheet 0.97, docked panel
0.88, readout 0.94 — which is why `--anomaly-panel-rgb` is a bare triplet rather
than a colour: one decision, not three tokens.

The type and chrome follow by **re-pointing the inherited tokens** on each container — `ConfigSidebar`
and `BoardStatsCard` re-point `--text`, `--text-muted`, `--text-dim` and
`--border` at the `--anomaly-*` values, plus `--border-neon`, `--neon-faint` and
`--surface-panel-solid` on Setup, so every hairline and the roster's sticky bar
go along too — and no component learns that anomalies exist.

Setup re-points the **whole `--neon` family** on top of that, so every mark
inside it that means "selected" goes purple with the ground: the SETUP heading,
the active tab's label and underline, the chosen island's row, the roster's
category pills. The `--anomaly-neon-*` tokens mirror the `--neon-*` ones name for
name so the mapping reads straight down. They are a **lighter** purple than
`--anomaly-accent`, and that is forced: cyan earns its prominence by contrast,
and the badge purple reads 3.3:1 against this panel — right as a stroke on the
dark collapse handle, unreadable as a heading. `#c9a5f0` puts back the 6.5:1 the
cyan had.

That leaves two purples meaning "selected" inside the panel, which is deliberate:
the lavender is the **app** saying which tab or row you are on, while the green
ring on an anomaly card is the **game's**, and the card is a second view of the
game's own chooser.

One thing is deliberately **not** re-pointed: the **board's own reds and ambers**
in the readout. They mean the same thing under every anomaly, and an anomaly is
precisely when a player most needs them to.

Two of the three text values are **lifted** off what the game uses — its
secondary lavender measures 3.8:1 on this panel, under AA, the same trap
`--text-dim` was lifted out of once already. The cards on it are the game's, so the ground
under them goes along rather than leaving them floating on a navy belonging to
the rest of the panel. Each shell keeps its **own** alpha — the sheet 0.97, the
docked panel 0.88 — so the hue changes and how much board shows through does
not; and the docked foot darkens rather than keeping its navy tint, which would
fight the purple. It is a view, not a mode: nothing else in the app reads it.

**Run in the HUD takes the colour too**, and Stop is untouched: a stop is
destructive of the run in progress whatever rules it began under. The docked panel's collapse handle takes it on the
same condition, which is what keeps it from ever sitting purple against a navy
panel.

Run and the handle take **different purples**, and that is a contrast rule rather than a
taste one: `--anomaly-accent` is the game's badge purple for strokes and glyphs
on a dark ground, where brighter is more legible, while `--anomaly-action` is a
fill behind white text, where brighter is less — the badge purple carries white
at 4.0:1, so the filled pair sits two steps down the same ramp.

That list also **stays compact until a card is chosen** — the unselected size is
the default and `.active` is what loosens it (a larger icon, roomier panels, and
the full rule). Three of the four describe a timeline nobody is in, and sizing it
this way makes the selected card obvious by shape as well as by colour, which is
the reading that survives a colourblind viewer.

### Overflow and viewport rules

Two overflow rules look like formatting and are not. Both were found by driving the
built app in a real browser, and neither shows up until a player unlocks a full
roster — which is to say, in normal play but never in a quick smoke test:

- **`.scroll-body` needs `min-height: 0`.** A flex item's automatic minimum size is
  its _content_ size, so `flex: 1` alone cannot shrink a list below the height of
  every card in it. Without it a full 38-building roster refuses to shrink and
  overflows the sheet. `.sidebar-panel` clips its own overflow, which is why only
  the phone ever showed it.
- **`.app-shell` uses `overflow: clip`, not `overflow: hidden`.** The mobile sheet
  is hidden by translating it a full sheet-height down, and a transformed element
  still contributes **scrollable overflow**. `hidden` makes a box unscrollable _by
  the user_ but leaves it a scroll container, and the browser will scroll one itself
  to bring a focused element into view — so tapping a control in the roster slid
  the whole app up with no scrollbar to put it back. `clip` creates no scroll
  container at all. The `hidden` declaration stays above it as the
  fallback.

Two more the layout depends on:

- **`100dvh`, not `100vh`.** `vh` freezes at the viewport's _largest_ size, so on
  iOS Safari the HUD sat under the collapsed URL bar.
- **`index.html` asks for `viewport-fit=cover`.** Without it every
  `env(safe-area-inset-*)` resolves to `0px` and the safe-area padding silently does
  nothing.

Touch-target bumps are keyed on `@media (pointer: coarse)`, not a width breakpoint,
for the same reason `viewportState` splits the two axes.
