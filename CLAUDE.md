# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A Svelte 5 + Vite + PixiJS web app for laying out buildings on a grid for a
reactor/power-grid idle game, with a built-in optimizer that computes a
near-optimal placement of reactors/generators/coolers. The game's rules are
specified in `docs/game-logic.md` — read it before touching anything under
`packages/solver/`, and `docs/SOLVER.md` for how that package is put together.

## Commands

The scripts are in `package.json`; `npm run solve -- --help` lists the CLI's flags.

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
  solver's board, the whole of Setup while a run is in flight,
  `PlacementViewToggle` with no solve or during one, the variants row during a
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
the value it was placed at ("what is this one rated for?"). The scorer resolves a
placement through the latter and the board readout takes its ceilings from the
scorer, so the ceilings the card prints are the tier the building actually ran at
— the two diverge the moment an upgrade is bought behind a standing building.
The readout goes through the scorer rather than calling `effectiveAtValue` itself
because a tier is not the whole answer once an anomaly rates the tile as well;
see the readout's own section.

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

Research is a uniform multiplier folded into the roster (`prestigeScales()` →
`getEffectiveBuildings`); an anomaly is a rule threaded through the engine as an
id. Both must reach `planSolve` through `SolveRunOptions`, or a run silently
optimises for a roster the player does not have. The details are in
`packages/solver/CLAUDE.md` (engine) and `src/lib/state/CLAUDE.md` (app).

### The upgrade plan

Beside it sits the **upgrade plan** — on the Buildings tab, not this one,
since it is a statement about buildings: up to three tiers the player is about
to buy, in buying order. A run solves for the tiers at the end of it
while every layout it keeps also runs at today's tiers and after each step, and
comes back at today's tiers. It is not a game screen and not a rule change —
the roster is still the roster. The search side and the measurements behind
"ordered, at most three" are in `docs/SOLVER.md`; the app side in
`src/lib/state/CLAUDE.md`; the readout's plan line in
`src/lib/components/inspector/CLAUDE.md`.

## Architecture

### Folder map

The game's own half — the engine, the building tables, the blueprint codec and
the number ladder — lives in `packages/solver/`; see `docs/SOLVER.md`.

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

### Blueprint is the format

Share codes, saved layouts, the templates and the CLI's output are all blueprints
(`encoding/blueprint.ts` in the solver package); the format and its version byte
are described in `packages/solver/CLAUDE.md`. **Never compare encoded codes to
test whether two layouts match** — use `blueprintKey()`.

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
Two things from that history still bind you: `rng.ts` is mulberry32 with pinned
golden streams, so **don't swap in `Math.random()`** and never re-record those
goldens, and `DistributionScratch` **must never change a number**.

`solver/types.ts` is the **data contract**: `Tile`, `TileType`, `BuildingType`,
`BuildingDefinition`, and everything that crosses the worker boundary. The app
does not redeclare any of it — `src/lib/types/` re-exports from the package, so
there is one definition and nothing to keep in sync.

Solver regressions: `npm test` first. **The golden-layout optima must never go
down**, and after `npm run fixtures` **read the diff**. See
`packages/solver/CLAUDE.md`.

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

## Where the rest lives

Subsystem guidance is in folder-level `CLAUDE.md` files, which load when you
work under that folder. Read the relevant one before changing that area:

- `packages/solver/CLAUDE.md` — Time Lab research and anomalies (engine side),
  the blueprint format, the solver pipeline, the stability rule, verifying a
  solver change.
- `src/lib/state/CLAUDE.md` — each store in detail, the board and terrain rules
  (fixed maps, the transformer, undo, preview mode), hiding the interface, and
  the app side of the Time Lab.
- `src/lib/pixi/CLAUDE.md` — rendering, the status pulse, canvas gestures,
  framing the board (also covers `components/canvas/PixiCanvas.svelte`).
- `src/lib/components/hud/CLAUDE.md`, `sidebar/CLAUDE.md`,
  `inspector/CLAUDE.md` — the HUD, Setup, and the readout.
- `src/CLAUDE.md` — tokens, the colour law, ladders, overflow rules.
