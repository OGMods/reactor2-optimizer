# The solver package

`@reactor2/solver` (`packages/solver/`) is the game's rules, its building roster, and a
near-optimal placement search over them. It is a plain npm workspace with **no runtime
dependencies**, consumed by the web app through the workspace link and runnable on its own from
the terminal.

```
packages/solver/
  src/solver/     the engine: types, island split, simulation, distribution, search
  src/data/       the authored building tables, the anomaly table, the shipped island codes,
                  unlock resolution
  src/encoding/   the blueprint wire format
  src/utils/      the game's number ladder
  src/grid.ts     tile predicates and the ASCII alphabet the tests are written in
  bin/            the CLI (`npm run solve`)
  scripts/        the fixture exporter (`npm run fixtures`)
  tests/          vitest, run by the repo's `npm test`
  fixtures/       golden fixtures, committed
```

The app imports one specifier, `@reactor2/solver`. `exports` points at `src/index.ts`, so
`npm run dev` needs no build step; `npm run build:solver` produces the publishable `dist/`
(Vite for the JavaScript, `tsc` for the declarations) and CI runs it so the claim does not rot.

---

## The one boundary that matters

**Everything under `src/` must be importable into a Web Worker.** The app runs the search inside
one, so no module there may import a bare package specifier or a `.svelte` file, and the package
declares no dependencies at all.

`tests/workerSafety.test.ts` enforces this mechanically rather than by convention: it scans every
module under `src/` and fails on any import that breaks the rule. It also enforces a second,
narrower layering rule — **`src/solver/` may reach only into itself and `src/data/`**. The engine
works in resolved `EffectiveBuilding`s and tile indices; it has no business knowing the wire
format a board arrived in or how a number is spelled for a filename, and keeping that one-way
lets the codec and the formatters change without anyone having to think about the search.

Worker-safe is **not** environment-free. `pacer.ts` uses `MessageChannel`, `setTimeout` and
`performance.now()`, and `encoding/blueprint.ts` uses `CompressionStream`, `Blob` and `btoa`.
Those are platform globals that Node and the browser both have — not imports — and they are
scanned like everything else.

---

## Design notes

These were once listed as divergences from a Python reference (see _History_). The reference is
gone; the reasoning is not.

### `context.ts` — the tile index and the scratch buffers

`IslandContext` does two things that shape every stage above it:

- **Tiles are indexed in the game's spatial processing order** (ascending X, then descending Y),
  so "ascending tile index" _is_ the order the distribution rules require. Supplier and consumer
  lists arrive pre-sorted; no stage re-sorts or re-derives adjacency.
- **All hot-path buffers are allocated once per island and reused** — the flow matrix, the BFS
  arrays, the stamp-validated index maps. The distribution runs twice per simulation and a solve
  runs millions of simulations, so per-call allocation was the single biggest avoidable cost.

`DistributionScratch` **must never change a number.** It is an allocation optimization and
nothing else.

Search _tuning_ constants (`SWAP_RADIUS`, `POLISH_SHARE`, and the rest) deliberately stay private
to `placementSearch.ts` rather than moving to `constants.ts`: they are meaningless apart from the
stage they tune.

### `anomalies.ts` — the prestige rule changes

A timeline runs under exactly one anomaly, and `"none"` is one of them rather than an absence, so
every consumer branches on a field instead of on `undefined`. `AnomalyDefinition` is a tagged
union over the **rule shape** (`baseline`, `shared_cooling`, `terrain_affinity`,
`role_isolation`), not over the anomaly's identity: the game ships these in batches and most of a
batch is an existing rule with different numbers, which this makes a table entry — while a
genuinely new rule is a variant the solver fails to compile without handling.

Unlike `BUILDING_TABLE` beside it, the table is **hand-owned**. The game does ship an
`*AnomalySO` per anomaly and the external extractor dumps them alongside the roster — but all one
of those records carries is an id, four localized terms and the multipliers. Which *rule* a
multiplier belongs to is not in the data at all: a shared cooling pool and a shoreline bonus are
both "one double" to it. So the extract is what each entry's numbers and its quoted `description`
are checked against, and the `rule` tag stays a human's reading of the text.

What each rule *means*, though, is read off the game's own source — the three anomaly classes, the
getters that apply them, `CoolingNetwork.cs` and `GeneratorBuilding.TickGeneratingEnergy` — and
`docs/game-logic.md` is where that lands. Two of those rules are not what the description text
reads like and are worth naming here: off-board counts as water, and nothing in the runtime
performs a full-cooling admission test.

Two things about the shapes are load-bearing:

- **Every stat anomaly is a _uniform_ scale.** "Energy, Heat, Cooling, and overheat capacity" is
  four names for one field each across the four roles, so a bonus is a building whose whole tier
  is worth more — `scaleEffectiveBuilding` is the one place that applies it, and one function
  covers every such anomaly there will be. It is not free power: a scaled producer needs
  proportionally more cooling and goes offline just as readily.

  **Waste is derived, not scaled, and every factor has to be in hand before it is.** The game
  recomputes `snapToAuthoredPrecision(heat − energy)` from the *fully scaled* heat and energy, so
  the snap must happen once, after research and anomaly have both been applied — scaling the
  authored waste instead disagrees in the last digit, and the fixtures assert exactly. That is
  why an anomaly cannot simply be a second `scaleEffectiveBuilding` call layered on the prestige
  one: the two factors have to arrive at a single multiply. See `docs/game-logic.md`.
- **`role_isolation` depends on the layout, the other shapes do not.** A terrain bonus is fixed
  per tile and can be folded into the board; a generator's isolation multiplier changes every
  time the search moves a neighbour, so a placed building's figures have to be resolved per
  layout.

`shared_cooling` is the odd one out entirely, and it is the one that costs this package
something. **Its pool is the whole board** — the game's "island" is the map, Gale Hills and Ash
Bay, and "cooling does not carry over to other islands" means it does not carry to a different
map. So under Cryo Nexus the islands `splitGridIntoIslands` produces are **not independent**,
which is the assumption the worker pool, the per-island budget split, `IslandBest` and
`variants.ts` all rest on.

What survives is more than it sounds. Heat stays adjacency-bound, so how much power an island can
make is still a question about that island alone; the islands are coupled by exactly two scalars,
the cooling they contribute and the waste they generate, and the board runs only if the first sums
over the second. An island is therefore no longer described by "its best power" but by a frontier —
power against net cooling it puts into or takes out of the pool — and the board-level problem is to
combine those frontiers under one scalar budget. That keeps the per-island parallelism; it changes
what a worker is asked for.

Two smaller effects. The board is sustainable **together** — every power source is served the same
fraction, so either the pool covers the board's whole waste or no part of it holds — which is what
makes one scalar budget the right shape for the board-level problem. And **`minIslandTiles` returns
1**: the 2-and-3-tile floors hold only because cooling has to cross a tile boundary, and under Cryo
it does not. A lone tile takes a heat sink that pays into the pool, or a direct producer the pool
pays for; a lone generator or reactor stays worthless, heat being adjacency-bound either way, and
the search leaves that tile empty. The shipped maps have 21 such tiles between them, 0 to 6 each —
small, but they are ground no other rule in the game can use. They arrive as degenerate one-tile
islands; the budget split is proportional to tile count, so each draws a share to match.

`docs/game-logic.md` has the rules. Two are worth repeating here because they decide how much of a
board this package has to look at: a pond is an obstacle and grants no shore bonus, while **off the
board counts as water** — the shipped maps are rectangles cut from one global map that is open
water between islands. The Tidal bonus lands on 36-45% of the grass of every shipped map, and on
the whole perimeter of a custom one.

### `island.ts` — the window an island is solved in

An `IslandSubGrid` is the component's bounding box **padded by one tile on every side**, carrying
the board's **real terrain** rather than a flattened "not mine" marker, plus a `buildable` mask.

All three are for terrain rules. A rule can care what a building stands next to, a rock is not a
lake, and a building on the island's own edge has neighbours outside the component's bare box.
Real terrain in a padded window means a *neighbouring* island's grass falls inside it, so **which
tiles are this island's is the mask, never `type === "grass"`** — `buildIslandContext` takes it
and `tileCount` is the count that goes with it.

The padding changes tile coordinates uniformly, so it changes no result: the fixtures reproduce
byte for byte across it.

**The padding cannot answer the shore question, which is why `waterAdjacent` rides along.** The
window is clamped to the board, so for a tile on the board's own edge the off-board neighbour is
not in it — and an absent cell there is indistinguishable from the window's own boundary. Since
off-board counts as water, a shore flag resolved from inside an `IslandSubGrid` reads every border
tile as inland, which on a custom island is the entire perimeter and the whole of the anomaly's
effect. So `computeWaterAdjacency` runs **once on the full grid** before decomposition and each
sub-grid carries a copy indexed like `buildable`. `island.test.ts` pins it on a board where the
window is clamped against three edges.

`splitGridIntoIslands` takes the anomaly for the same class of reason: `minIslandTiles` is a
property of the rules in force rather than of the grid, so it cannot be applied after the split.

### `distribution.ts` — a port of Unity's `FlowNetwork.cs`

Two shapes in it are load-bearing and look like details:

- A supplier expands **every** unvisited adjacent consumer instead of shortcutting to the sink
  when it finds one with room. The shortcut marks later consumers visited and can pick a
  different equal-length augmenting path — same maximum flow, different split, and the split
  decides which buildings clear their cooling.
- Supply and demand are counted **down** rather than accumulated up, because `cap - sent` is not
  bit-identical to a decremented remainder and the fixtures assert exactly.

Each component's suppliers must also stay in ascending index order. Grouping them in discovery
order produces a different maximal flow: same total delivered, split across suppliers
differently. `tests/distribution.test.ts` pins that case explicitly.

### `pacer.ts` — yielding without paying for it

A Web Worker has to return to its event loop so a STOP message can be delivered and progress can
be reported. `pacer.ts` provides `due()` — a cheap clock comparison the search folds into its
existing time checks — and `pump()`, which does the actual `MessageChannel` yield, so the search
runs flat out between yields rather than paying an event-loop round trip every few hundred steps.

### Serial and parallel are both real entry points

- `src/solver/solver.ts` — `solve()`, the serial orchestrator. The CLI, the tests and any
  headless caller use it.
- `src/lib/worker/solverCoordinator.ts` (in the **app**) — one worker per island, per-island
  seeds derived from one root seed, results merged and remapped.

Both share `planSolve` (which derives the per-island seeds, `(root + i) >>> 0`) and
`buildOptimizationResult` (which merges and remaps). The coordinator adds only worker dispatch,
which is why `tests/fixtures.test.ts` can exercise the shared surface directly: it asserts the
seed derivation, and that feeding island results into `buildOptimizationResult` back-to-front
produces an identical result — the out-of-order completion a worker pool actually causes.

### `simulateIsland`'s `fullReport` flag

`simulateIsland` short-circuits a layout that cannot bring anything online — no producers, or no
coolers — and returns rows carrying nothing but each building's base value. That is right for a
search, which only wants power and is about to throw the layout away.

The app has a caller that wants more: `lib/simulation/simulator.ts` scores the board a player is
looking at, and a board with no coolers on it still has heat moving through it that the inspector
should show. `simulateIsland(placement, ctx, true)` skips the two short-circuits for that caller
alone. It changes no number a short-circuited layout would otherwise have reported — every
producer on such a board is still offline, and total power is still zero — so the search path and
the fixtures are untouched.

### `alternates.ts` — the layouts the search ties with

A search almost never finds a single best arrangement, and which tie is nicest to build is a
judgement the solver cannot make, so the ties are handed back to the player to cycle through.

`AlternateCollector` is a **passive observer** of the annealing walk. Nothing it holds is ever
read back into the search, it cannot change a number, and `replayIslandDeterministic` — the
fixture path — passes no collector at all, so the fixtures are untouched by it in every sense.

**A tie has to be a materially different board, not a different string.** An entry joins a
shortlist only if it is `MIN_ALTERNATE_DISTANCE` (five) tiles from every layout already kept —
counting an empty tile as an occupant of its own, so one substituted building is 1 apart and one
relocated building is 2. Deduplicating by shape alone let a converged walk fill the list with
near-copies of itself. Every gate that admits a layout applies the same rule: the collector,
`finalizeAlternates` (pruning and right-sizing move the boards, so distances are re-measured
after them), the app's `worker/islandBest.ts` across attempts, and `chooseSolveVariants` across
runs. A layout that _beats_ the shortlist is exempt, because it empties it first: the bar is on
being a second answer, never on being an answer.

---

## The RNG contract

`src/solver/rng.ts` is mulberry32, and `tests/rng.test.ts` pins the first outputs of five seeds
as exact doubles. This is the easiest thing in the package to break without noticing, and every
golden fixture is downstream of it.

Rules:

- If one of those goldens fails, the drift is in `rng.ts`. **Fix the implementation; never
  re-record the goldens** from what the code now produces.
- Do not "improve" the shuffle. A better shuffle that changes the output sequence invalidates
  every fixture at once, and the failures surface somewhere far less obvious than here.
- After any deliberate RNG change, regenerate the fixtures and read the diff.
- Nothing in the solve path may depend on `Math.random()`, on object key order, or on `Set`
  iteration order as a source of randomness.

---

## The golden-fixture harness

`scripts/exportFixtures.ts` writes one JSON file per case into `fixtures/`.

```bash
npm run fixtures     # regenerate, in place
npm test             # replay them
```

Re-running the exporter against an unchanged solver reproduces every file **byte for byte**. That
property is the whole point: it makes a diff in `fixtures/` a trustworthy signal that solver
behaviour moved, rather than noise to squint at. If it stops holding, something in the solve path
has become non-deterministic, and that is a bug in its own right.

### What the fixtures replay — and why it is not `solve()`

**`solve()` is not reproducible, even with a fixed seed.** Every stage is gated on a wall-clock
deadline, so the number of steps that fit in a budget varies between runs on the same machine. A
fixed seed narrows run-to-run variance; it does not eliminate it. Exporting `solve()` output
would produce fixtures that fail at random.

So both the exporter and the test replay the deterministic core through
`replayIslandDeterministic`:

1. `splitGridIntoIslands` (already deterministic)
2. per-island seed `(rootSeed + islandIndex) >>> 0`
3. `constructMultiStartSeed` (deterministic)
4. `hillClimb` with a fixed `Rng` and **`maxSteps`**, which drives the temperature schedule off
   step count instead of elapsed time
5. `pruneDeadWeight`
6. remapping back to grid coordinates

Every deadline handed to that path is set far enough out that none can fire, so step count alone
decides where the walk stops.

**The composition-retarget and greedy-polish stages are deliberately omitted.** They are deadline
loops with no step cap, so there is no deterministic way to replay them. Running `solve()` end to
end will not match the fixtures, and is not supposed to. Because the exporter and the test go
through the same function, the two cannot disagree about which stages ran.

`hillClimb`'s `maxSteps` exists purely for this. Production never sets it.

### The two expectation layers

| Layer      | Replayed with                           | Asserted                                                                        |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `expected` | `maxSteps = 0` — annealing OFF          | **Exactly.** Placements element for element; power to a 1e-9 relative tolerance |
| `annealed` | the fixture's `maxSteps` — annealing ON | Invariants only: stability, tile bounds, and power within 5%                    |

`expected` covers seed construction, simulation, distribution, stabilize, prune, island splitting,
seed derivation and remapping — all pure arithmetic on doubles, all bit-identical anywhere. That
is the layer that catches regressions. **If you find yourself loosening an `expected` assertion,
stop:** it has no floating-point excuse.

`annealed` is tolerance-checked because the walk is the only part of the solver that calls
transcendental functions — `(tMin / tStart) ** progress` for the temperature and `Math.exp` in
the Metropolis test — and IEEE-754 does not require `pow` or `exp` to be correctly rounded. One
ULP of temperature is enough to flip a single acceptance, after which the walk diverges
permanently, and a V8 upgrade is free to move one. The layer still catches a grossly broken walk:
wrong move mix, wrong temperature curve, wrong acceptance rule.

### Determinism rules

- Placements are serialized in canonical order — ascending flat tile index (`y * width + x`) —
  never in the order the search produced them.
- Floats are rounded to 9 decimals before serialization. This is a no-op at the magnitudes the
  solver reaches (~1e22), so **compare `power_output` with a relative tolerance**, never an
  absolute `1e-9`, which is far below one ULP there.
- No timing data is recorded — it is not reproducible.
- Terrain is carried as a blueprint code. The suite decodes it and never re-encodes to compare
  strings: DEFLATE is only required to round-trip, so equal boards can have unequal codes.

### Cases

| Name                  | Why it exists                                                       |
| --------------------- | ------------------------------------------------------------------- |
| `single_tile`         | Degenerate island; catches empty-result and off-by-one handling     |
| `small_grid_seed42`   | Baseline; one island, small enough to diff by hand                  |
| `two_island_seed7`    | Exercises placement remapping — the highest-risk surface            |
| `three_island_uneven` | Islands of very different sizes; catches per-island seed derivation |
| `no_buildable_tiles`  | All-water grid; must produce the empty result, not an error         |
| `full_upgrades_seed1` | Largest single island and longest walk; pins max level explicitly   |

**Regenerate when** the solve output legitimately changes — a new search stage, a tuning-constant
change, a scoring fix. **Do not** regenerate to make a failing test pass without first confirming
the change was intentional; that is the harness doing its job.

---

## The rest of the suite

The fixtures pin behaviour; the rest of `tests/` pins meaning. Two files are worth knowing about
before changing anything in the search:

- **`goldenLayouts.test.ts`** — proven optima for islands of 3 to 9 tiles, each confirmed by
  exhaustive brute force rather than by running the solver and writing down what it said. **These
  numbers must never go down.** Each size is checked twice: once against the simulator, pinning
  the exact layout deterministically, and once against the search, which must reproduce it.
- **`distribution.test.ts`** — the worked examples from `docs/game-logic.md`, plus layouts built
  in the live game with per-building power read off the screen. Those are observations, not
  derivations: the spec was wrong about leftover handling until those runs corrected it. It also
  checks the implementation against an independent Edmonds-Karp oracle over several hundred
  random layouts.

---

## The CLI

```bash
npm run solve                          # one 30s run on island 1
npm run solve -- --map 3 --time 60
npm run solve -- --all --runs 3
npm run solve -- --map 7 --attempts 100 --time 20
npm run solve -- --help
```

It renders no picture — the app draws boards far better, and a picture is the one form of a
layout you cannot paste back into anything. Each run writes its **blueprint code** to `solves/`
instead, named after what it found (`3_island_7_2_91AC-296AB.txt`); paste one into the app's
Import dialog to see the board.

`--attempts` runs a batch session: N whole solves through a worker pool, with a leaderboard of
distinct layouts at the end. Ctrl-C stops it and still prints the report.

Cores are spent on two axes and the flags pick which. A **run** farms its islands out to the pool
— the same search either way, since each island still gets its own proportional slice of the
budget, so only wall clock changes. A **session** runs whole attempts in the pool with islands
serial inside each; the pool already owns the cores, and a nested pool per island would
oversubscribe the machine.

---

## History

Until this package existed, the shipped solver was a line-for-line TypeScript port of a
standalone Python reference that lived in `py_solver/`. That tree was upstream: algorithm changes
happened there first and were re-ported, and the fixtures were evidence precisely because two
independent implementations agreed on them bit for bit.

It was retired because the port had become strictly faster at the thing that decides solve
quality. Both trees gate every search stage on wall-clock rather than on step count, so "30
seconds" buys whatever number of annealing steps the runtime can fit — and measured on the same
board and the same deterministic replay path, V8 fit about **9x** more than CPython 3.13 (74k
steps/s against 8.4k). Nothing about the algorithm changed.

What moved here when it went: its whole test suite, ported module for module; its CLI's argument
surface; and the fixtures, which now pin this solver against its own recorded past rather than
against a second implementation. The `expected` layer's numbers are unchanged — they were
bit-identical across the two languages for the life of that tree, and they still are.

Comments that mention "the retired Python reference" are pointing at this. They are kept where
the history explains why the code is shaped the way it is, and dropped everywhere it was only a
file pointer.
