# Reactor 2 Optimizer

A layout planner for **Reactor 2: Nuclear Tycoon**: paint a board, tell it
which buildings you have unlocked, and it works out where to put reactors,
generators and coolers to get the most power out of the tiles you have.

**[Open the optimizer →](https://ogmods.github.io/reactor2-optimizer/)**

It is a browser app — Svelte 5, Vite and PixiJS — with the search running in Web
Workers so the board stays interactive while it thinks.

## What it does

- **Eight shipped islands** — Gale Hills, Ash Bay, Magma Rift, Core Island,
  Mirror Expanse, Event Horizon, Entropy Isles and Shadowspire — plus up to five
  custom boards of your own.
- **Terrain editing** on your own islands; the shipped ones are fixed, because a
  fixed island _is_ the puzzle. You can still clear an obstacle on them, and put
  it back.
- **An unlock roster.** The solver only places what you have unlocked, at the
  tier you own, so its answer is a layout you can actually build.
- **A solve is a shortlist, not a layout.** A search almost never finds a single
  best arrangement, so it keeps up to ten boards that tie on power and lets you
  cycle them and apply the one you like. Which tie is nicest to build is the one
  judgement the solver cannot make.
- **Share codes and links.** Any board — hand-built or solved — compresses to a
  short code, or a `?bp=` URL. Opening someone's link is a read-only preview
  until you choose to adopt it.
- **Save as image.** The board on screen, whole and at full resolution, as a
  PNG — for the places a code cannot go. The power is in the filename
  (`reactor2-island-3-12AA-345T.png`), so a folder of them sorts and compares
  without opening any. Zoom and pan do not affect the picture.
- **Live figures for your own board too**, not just for solves: power, and a
  count of the buildings that are idle or overheating, which on the map look
  exactly like the ones that work.

Buildings are laid out on an isometric grid drawn with PixiJS. Pan, zoom and
pinch work on desktop and touch; the layout collapses to a bottom sheet and a
thumb-reachable toolbar on phones.

## How the solver works

The rules being solved — adjacency, the heat and cooling flow model, the
all-or-nothing cooling threshold — are specified in
[`docs/game-logic.md`](docs/game-logic.md).

Placement is searched **heuristically** under a time budget. For any layout it
considers, though, the heat and cooling **flow allocation is solved exactly** —
it is a port of the game's own flow solver, not an approximation of it. So the
only source of suboptimality is _which layouts get tried_, never _how well a
given layout is scored_.

1. **Island decomposition.** The grid splits into 8-neighbour connected
   components of buildable tiles. Placement in one island cannot affect another,
   so each is solved independently and the budget is divided between them by
   tile count.
2. **Placement search**, per island: seed construction, repair, composition
   retargeting, simulated annealing, pruning, and a right-sizing pass that swaps
   an oversized cooler down to the tier the tile actually needs — same power,
   less of your money spent on capacity that never runs.
3. **Simulation** scores one fixed layout, millions of times per solve, routing
   heat and cooling through a port of the game's "FairShare + Augmenting Repair".

Every returned layout is **stable**: every generator it places actually runs. A
layout can score higher by parking reactor heat in a generator that is never
cooled, and that is still the wrong answer.

**The search is bounded by wall-clock time, not by convergence**, which is why
the run length is a choice you make:

| Mode  | Shape    | For                                                      |
| ----- | -------- | -------------------------------------------------------- |
| Quick | 1 × 30s  | A board you are still changing                           |
| Deep  | 10 × 10s | The usual answer — ten short walks beat one long one     |
| Max   | 50 × 10s | Settling a board; mostly buys a fuller shortlist of ties |

Ten short attempts usually beat one long one because past the first few seconds
the annealing temperature has fallen far enough that a long walk mostly polishes
the basin it is already in. Attempts run as independent tasks across a worker
pool, so the wall-clock cost of "10 × 10s" depends on how many cores the browser
gives you — the control prints the estimate.

## Quick start

```bash
npm install
npm run dev
```

| Command            | What it does                                                          |
| ------------------ | --------------------------------------------------------------------- |
| `npm run dev`      | Vite dev server                                                       |
| `npm run build`    | Production build into `dist/`                                         |
| `npm run preview`  | Serve the built output                                                |
| `npm run check`    | `svelte-check` + `tsc` over the app, the configs and both test suites |
| `npm test`         | Vitest — the app's tests and the solver package's                     |
| `npm run knip`     | Report unused files, exports and dependencies                         |
| `npm run solve`    | Solve a board from the terminal (`-- --help` for the flags)           |
| `npm run fixtures` | Regenerate the solver's golden fixtures                               |

## Repository layout

```
packages/solver/  @reactor2/solver — the engine, the roster, the codec, the CLI
src/lib/
  worker/       the Web Worker boundary: coordinator, pool, client, solve modes
  state/        Svelte 5 runes singletons (layout, config, solver, ui, ...)
  components/   UI, grouped by region (canvas, header, hud, inspector, sidebar)
  pixi/         atlas, isometric renderer, viewport controls
  simulation/   scores a hand-placed board, by delegating to the solver
  encoding/     share links
  data/         the app's own record of a placed building
docs/           the game rules, and how the solver package is put together
public/         static assets served as-is; reach them via `asset()`, not `/...`
.github/        CI and the GitHub Pages deployment
```

## The solver is a package

[`packages/solver/`](packages/solver/) is `@reactor2/solver`, an npm workspace
with **no runtime dependencies**: the game's rules, its building tables, the
blueprint codec and the placement search. The app imports it like any other
dependency and runs it inside a Web Worker, so nothing in it may reach for the
DOM, Svelte, Pixi or an npm package — a test enforces that boundary rather than
trusting it.

It also runs on its own. `npm run solve` solves a board from the terminal and
prints a blueprint code you can paste into the app's Import dialog.

[`docs/SOLVER.md`](docs/SOLVER.md) explains how it is put together, what the
golden fixtures pin and why, and what must never be changed casually.

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first — it is the architecture document, and it
explains not just what the code does but why several non-obvious decisions are
the way they are. Before touching the solver, read
[`docs/game-logic.md`](docs/game-logic.md) and
[`docs/SOLVER.md`](docs/SOLVER.md).

Keep `npm run check` at zero and `npm test` green. If you change solver
behaviour, regenerate the golden fixtures (`npm run fixtures`) and read the diff
before committing it — it is the clearest statement of what your change actually
did.

## License

Copyright (C) 2026 OGMods. The source code is GPL-3.0-or-later; see
[`LICENSE`](LICENSE).

**The game assets are not.** Everything under `public/` — the icons, logo,
favicons, sprite atlas and tile art — along with the building statistics tables,
belongs to **RSG Apps**, the developer of _Reactor 2: Nuclear Tycoon_, and is
included with their permission — which is not sublicensable, so
**if you fork this project you must remove those files or seek your own
permission.** [`NOTICE`](NOTICE) lists exactly which files those are.

This is an unofficial, fan-made tool, not affiliated with or endorsed by RSG
Apps beyond that permission.
