# Python ↔ TypeScript Parity

The Python tree (`py_solver/`) is where solver changes are prototyped. The TypeScript tree
(`src/lib/`) is the shipped implementation. Changes flow **Python → TypeScript**, never the
other way.

`py_solver/` sits inside this repo and **is committed**. It is not part of the app — nothing in it
is installed by `npm install` or emitted into `dist/` — but it is the reference the shipped solver
is judged against, so it travels with the repo. It needs Python 3; `requirements.txt` pulls in
Pillow for the debug renderer, and the solver and its tests are otherwise pure stdlib. Its
generated output stays ignored: `solves/` (rendered PNGs) and `__pycache__/`.

The parity fixtures live at `parity/fixtures/`, the repo root, and the Python exporter writes
straight to them — there is no second copy under `py_solver/`. See "Where the fixtures live" below.

**This page is the only copy**, and it is the one `lib/solver/index.ts` points at. There is no
mirrored file under `py_solver/` -- for the same reason there is no second fixtures directory: a
duplicate is only equal for as long as someone remembers to copy it. `py_solver/CLAUDE.md` links
here rather than restating it.

The two trees are deliberately kept name-aligned so that porting a change is a 1:1 file diff.
Where they diverge, it is on purpose, and every divergence is listed below. **If you find a
mismatch that is not on this page, it is a bug or a missing port — not an intentional
difference.**

---

## File mapping

### Solver core

| Python                       | TypeScript                      | Notes                                                                                                 |
| ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `solver/__init__.py`         | `lib/solver/index.ts`           | Public surface; Python's re-exports are lazy (PEP 562) — see divergences                              |
| `solver/types.py`            | `lib/solver/types.ts`           | Was `domain.py`. Also holds `SearchHooks` / `IslandProgress` contract on the TS side                  |
| `solver/constants.py`        | `lib/solver/constants.ts`       | Direction vectors, spatial ordering, weights, limits. Split out of `rules.py`, not `domain.py`        |
| `solver/physics.py`          | `lib/solver/physics.ts`         | Authored per-tier generator conversion, `snapToAuthoredPrecision`, and the relative cooling tolerance |
| `solver/rng.py`              | `lib/solver/rng.ts`             | **Must stay algorithmically identical** — see below                                                   |
| `solver/rules.py`            | _(absorbed — see divergences)_  | Adjacency geometry only; no direct TS peer                                                            |
| `solver/island.py`           | `lib/solver/island.ts`          | Partitioning, cooling feasibility, power estimates                                                    |
| `solver/distribution.py`     | `lib/solver/distribution.ts`    | FairShare + Augmenting Repair, run for power and heat                                                 |
| `solver/simulate.py`         | `lib/solver/simulate.ts`        | Scores one candidate placement. TS takes an extra `fullReport` flag — see divergences                 |
| `solver/placement_search.py` | `lib/solver/placementSearch.ts` | Seeds → hill-climb → stabilize → composition → polish → prune → right-size                            |
| `solver/solver.py`           | `lib/solver/solver.ts`          | Serial orchestrator; `planSolve`/`buildOptimizationResult` are shared with the coordinator            |
| `solver/report.py`           | `lib/solver/report.ts`          | `verify()` is shared; `print_summary` is CLI-only                                                     |
| —                            | `lib/solver/context.ts`         | TS-only — see divergences                                                                             |
| —                            | `lib/solver/pacer.ts`           | TS-only — see divergences                                                                             |
| —                            | `lib/solver/alternates.ts`      | TS-only — see divergences                                                                             |

`lib/solver/index.ts` re-exports only solver-owned modules. `worker/` and `data/` are left out on
purpose — see divergence 2 for why the solver barrel must not pull worker code back in.

### Data

| Python                        | TypeScript                       | Notes                                                                                                                                                                                   |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/buildings.py`           | `lib/data/buildings.ts`          | Static component definitions. All 38 ids match exactly                                                                                                                                  |
| `data/effective_buildings.py` | `lib/data/effectiveBuildings.ts` | Resolves definitions + unlocked levels → effective buildings                                                                                                                            |
| `data/maps.py`                | `lib/data/maps.ts`               | Same maps, same format: blueprint codes carrying their own dimensions. Python numbers them `0`-`8` (`GameMap.num`); TS names them `custom` + `island1`-`island8`. **Map 0 is `custom`** |

The two trees now hold the **same map data** in the **same format** — this used to be a
divergence (Python carried small RLE benchmark grids, TS carried the shipped islands) and is not
one any more. Python indexes by `GameMap.num`, TS by string id, and map `0` is the small board TS
calls `custom`.

Because the codes are the shared artefact, changing a map means changing it in both trees. Encode
once and paste the same string into both; do **not** re-encode per tree, since the two zlib
implementations emit different bytes for identical input (which is fine for decoding, but makes a
pointless diff).

### Shared utilities

| Python          | TypeScript                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blueprint.py`  | `lib/encoding/blueprint.ts` | The layout codec — maps, saves, share codes and the parity fixtures. **The byte tables must match exactly**; `tests/test_blueprint.py` pins the Python tables against the TypeScript source, since a drifted table decodes as the wrong building instead of failing. The optional tier table after the tiles is pinned the other way — by one byte-exact assertion on each side for the same board (`test_the_table_is_appended_after_the_tiles` / `appends the table after the tiles, count first`), because a table written in a different order decodes as a different roster rather than raising |
| `grid.py`       | _(no peer — see notes)_     | Retains `count_grass_tiles` / `is_island_tile`, whose TS equivalents live in `lib/solver/island.ts` (the solver needs them and `lib/grid/` was not worker-safe territory), plus the `TILE_CHAR_MAP` alphabet used for test-grid authoring and for the fixture character table. **`lib/grid/` has been deleted on the TS side, and the Python RLE decoder with it** — nothing on either side reads RLE any more                                                                                                                                                                                       |
| `formatters.py` | `lib/utils/formatters.ts`   | Was `format.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### No peer (by design)

| Python    | Why it has no TS peer                                             |
| --------- | ----------------------------------------------------------------- |
| `main.py` | CLI entry point; the TS app entry is `src/main.ts` + `App.svelte` |
| `render/` | CLI visualization; PixiJS (`lib/pixi/`) does this in the app      |
| `parity/` | Fixture export harness; consumed by the TS test suite             |

| TypeScript                            | Why it has no Python peer                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/worker/islandWorker.ts`          | Web Worker entry; Python has no worker model                                                                                                        |
| `lib/worker/solverCoordinator.ts`     | Parallel per-island orchestration; Python's `solver.py` is serial                                                                                   |
| `lib/worker/workerClient.ts`          | Main-thread API surface (`solveProgressive`)                                                                                                        |
| `lib/worker/variants.ts`              | Combines per-island ties into whole-board layouts — see divergence 7                                                                                |
| `lib/simulation/simulator.ts`         | Live hover/inspector stats; shares logic with `simulate.ts`, distinct fast path                                                                     |
| _(none — `blueprint.py` is the peer)_ | `lib/encoding/blueprint.ts` has a Python peer now; see the mapping table above. Listed here only because this row used to say it did not            |
| `lib/pixi/`, `lib/storage/`           | Rendering and persistence; browser-only                                                                                                             |
| `lib/states/`, `lib/components/`      | Svelte state and UI                                                                                                                                 |
| `lib/types/`                          | App-facing type layer. Re-exports the solver's `PlacedBuilding` / `OptimizationResult` rather than redeclaring them; Python has no equivalent split |
| `lib/solver/parity.test.ts`           | Replays the fixtures `py_solver/parity/` exports — the TS half of the harness, so it cannot have a Python peer                                      |
| `lib/solver/rng.parity.test.ts`       | Pins the same golden RNG streams as `tests/test_rng.py`                                                                                             |
| `lib/solver/workerSafety.test.ts`     | Enforces divergence 2 (worker safety). A browser-only concern                                                                                       |
| `lib/solver/typeContract.test.ts`     | Pins `lib/solver/types.ts` against `lib/types/` — the TS tree keeps two copies on purpose; Python has one                                           |
| `lib/solver/alternates.test.ts`       | Pins divergence 7 — the tied-layout shortlist and its distance rule, which Python does not collect                                                  |

The `*.test.ts` files above are **exempt from the worker-safety scan** (they use `node:fs`
and vitest, and nothing imports them, so they never reach the worker bundle).

---

## Intentional divergences

### 1. `context.ts` has no Python peer, and it absorbs `rules.py`

`lib/solver/context.ts` defines `IslandContext` and `DistributionScratch`. It does two things
Python does not need:

- **Tiles are indexed in the game's spatial processing order** (ascending X, then descending Y),
  so "ascending tile index" _is_ the spatial order the distribution rules require. Supplier and
  consumer lists arrive pre-sorted; no stage re-sorts or re-derives adjacency.
- **All hot-path buffers are allocated once per island and reused** (flow matrix, BFS arrays,
  stamp-validated index maps). The distribution runs twice per simulation and a solve runs
  millions of simulations, so per-call allocation was the single biggest avoidable cost.
- **`distribution.ts` keeps a dense `flow[s * numConsumers + c]` matrix and CSR adjacency**
  where Python (following `FlowNetwork.BuildIsland`) keeps a flat edge list with
  `supplier_edges` / `consumer_edges`. Python's `via_edge` is derived here from the
  node/parent pair instead, which identifies the same edge because a supplier and a consumer
  share at most one. What must NOT differ is the traversal: suppliers expand every unvisited
  adjacent consumer without shortcutting to the sink, each component's suppliers stay in
  ascending index order, and supply/demand are counted **down** rather than accumulated up —
  `cap - sent` is not bit-identical to a decremented remainder, and the `expected` fixture
  layer is asserted exactly.

As a consequence, Python's `rules.py` has no file-level peer. It retains only the adjacency
geometry (`TileId`, `is_adjacent`, `build_neighbor_map`), whose TS equivalent is built inside
`buildIslandContext()`. The rule _values_ it used to hold — `GENERATOR_ENERGY_RATIO`,
`GENERATOR_WASTE_RATIO`, `CHEBYSHEV_DIRECTIONS`, `EPS` — and `spatial_key` now live in
`solver/constants.py`, so `spatial_key` does have a direct peer: `spatialKeyCompare` in
`constants.ts`.

**When porting a change to `rules.py`, look in `context.ts`.**

Search _tuning_ constants (`_SWAP_RADIUS`, `_POLISH_SHARE`, and the rest) deliberately stay
private to `placement_search.py` rather than moving to `constants.py`: they are meaningless
apart from the stage they tune, and both trees keep them next to that stage.

### 2. `pacer.ts` has no Python peer

Python runs each island to its deadline in one uninterrupted block. A Web Worker cannot: it has
to return to its event loop so a STOP message can be delivered and progress can be reported.
`pacer.ts` provides `due()` (a cheap clock comparison the search calls in its existing time
checks) and `pump()` (which does the actual `MessageChannel` yield), so the search runs flat out
between yields rather than paying an event-loop round trip every few hundred steps.

This means **`lib/solver/` is worker-safe, not environment-free**. `pacer.ts` touches
`MessageChannel`, `setTimeout`, and `performance.now()`. Everything else in `lib/solver/` must
stay free of DOM, Worker, Svelte, and Pixi imports.

`lib/solver/workerSafety.test.ts` enforces this mechanically: it scans every non-test module in
`lib/solver/` and fails on any import that is not either solver-local or from `lib/data/` (pure
definition tables). Bare package specifiers and `.svelte` imports are rejected outright, so the
solver keeps zero runtime dependencies. `pacer.ts` is scanned like everything else and passes —
the globals it uses are not imports. If a legitimately worker-safe folder is added later, put it
in `ALLOWED_SIBLING_FOLDERS` there rather than deleting the assertion.

### 3. Python is serial; TypeScript is parallel

`solver/solver.py` solves every island in one process. The TS tree has both:

- `lib/solver/solver.ts` — the serial equivalent, kept as the reference implementation
- `lib/worker/solverCoordinator.ts` — spawns one worker per island, derives per-island seeds
  from a single root seed, merges results, and remaps island-local coordinates back to
  full-grid space

Both paths share `planSolve` (which derives the per-island seeds) and `buildOptimizationResult`
(which merges and remaps). The coordinator adds only worker dispatch. The parity test exercises
that shared surface directly rather than spinning up workers: it asserts `plan.seeds` equals
`(root + i) >>> 0` — matching Python's `(seed + i) & 0xFFFFFFFF` — and that feeding island
results into `buildOptimizationResult` back-to-front produces a byte-identical result, which is
the out-of-order completion a worker pool actually causes.

### 4. `solver/__init__.py` resolves its re-exports lazily

`grid.py` imports `Tile` from `solver/types.py`, and `solver/solver.py` imports
`count_grass_tiles` from `grid.py`. In TypeScript that is not a cycle, because importing
`solver/types.ts` pulls in exactly that file. In Python, importing any `solver.*` submodule first
executes the package `__init__.py`, so an eager `from solver.solver import solve` there turns the
pair into a genuine circular import — one that only raises when `grid` happens to be imported
first, which makes it easy to miss.

`solver/__init__.py` therefore resolves `solve`, `verify`, `print_summary` and
`DEFAULT_TIME_BUDGET_S` through a module-level `__getattr__` (PEP 562). `from solver import solve`
behaves exactly as before; the orchestrator is simply not imported until something asks for it.

This has no TS counterpart and nothing to port — `lib/solver/index.ts` can re-export normally.
It is listed here so the indirection is not mistaken for an incomplete port.

### 5. Floating point puts a hard ceiling on cross-language replay

The annealing walk is the **only** part of the solver that calls transcendental functions:
`(t_min / t_start) ** progress` for the temperature schedule, and `exp(exponent)` in the
Metropolis acceptance test. IEEE-754 does not require `pow` or `exp` to be correctly rounded, and
CPython's libm and V8 **measurably disagree by 1 ULP** on values this solver actually reaches.

One ULP of temperature is enough to flip a single acceptance, and from there the two walks
diverge permanently. This was measured, not assumed: on a 3×3 island the Python and TypeScript
walks agree step-for-step through 1024 steps and first diverge at 1280 — exactly at a batch
boundary, where the temperature is recomputed.

Everything else — seed construction, `simulate_island`, `run_distribution`, `_stabilize`,
`_prune_dead_weight`, island splitting, placement remapping — is pure `+ - * /` and comparison on
doubles, which **is** bit-identical across the two languages.

Consequences:

- A seeded annealing run **cannot** be replayed bit-for-bit across the two languages. Do not add
  a test that expects it to be; it will pass on your machine and fail on someone else's.
- The parity harness therefore pins two layers — an exact one with annealing off, and a
  tolerance-checked one with it on. See _Parity harness_ below.
- If you ever need bit-identical annealing, the fix is to stop depending on the platform's
  `pow`/`exp` — quantize both (e.g. round to float32) on both sides in the same commit. That
  changes which moves the search accepts, so it is a solver behaviour change, not a refactor:
  re-measure map 1 before and after.

---

### 6. `simulateIsland` takes a `fullReport` flag the Python side has no use for

`simulate_island` short-circuits a layout that cannot bring anything online — no producers, or
no coolers — and returns rows carrying nothing but each building's base value. That is right for
a search, which only wants power and is about to throw the layout away.

The TypeScript side has a caller Python does not: `lib/simulation/simulator.ts` scores the
board a player is looking at, and a board with no coolers on it yet still has heat moving
through it that the inspector should show. `simulateIsland(placement, ctx, true)` skips the two
short-circuits for that caller alone.

It changes no number a short-circuited layout would otherwise have reported — every producer on
such a board is still offline, and total power is still zero. It only fills in the intermediate
heat and cooling figures the search had no reason to compute. The default is `false`, so the
search path and the parity fixtures are untouched.

---

### 7. The TypeScript search keeps the layouts it ties with; Python keeps one

`solve_island` returns the best layout it found. The app needs more than that: a search almost
never finds a single best arrangement — several usually tie at the top — and which of them is
nicest to actually build is a judgement the solver cannot make, so the ties are handed back to
the player to cycle through.

`lib/solver/alternates.ts` (`AlternateCollector`) is a **passive observer** of the annealing
walk. `hillClimb` offers it the layout it starts from, every stable layout it records as a new
best, and every stable layout that ties the best. Nothing it holds is ever read back into the
search:

- It cannot change a number. It only reads layouts the walk was already producing, and the search
  never consults it.
- It cannot change _timing_ enough to matter. A tie costs one boolean (`full`) once the shortlist
  is full; while it is not, it costs `AlternateCollector.accepts` — a key lookup and a distance
  scan against at most ten held layouts, each of which stops at the first five disagreeing tiles
  — and only a layout that clears _that_ pays for an `anyOfflineProducer` scan. The order matters
  because the distance rule below means the shortlist often never reaches `full`, so `full` alone
  no longer keeps this off the hot path.
- The deterministic replay path (`replayIslandDeterministic`, which is what the parity fixtures
  run) passes **no** collector, so the fixture layer is untouched by this in every sense.

`solveIsland` prunes each collected layout exactly as it prunes the primary, **right-sizes it the
same way**, drops any that no longer ties afterwards, and returns them as
`IslandSolution.alternates`. Right-sizing them is not optional politeness: the shortlist exists so
the player can compare boards that tie on power, and two entries agreeing on power while
disagreeing on cost would make that comparison meaningless. It also collapses entries that
differed only in an oversized tier, which were never two boards to choose between.
`lib/worker/variants.ts` then combines them: islands never interact, so swapping one island's
layout for one of its ties leaves the rest of the board and the total untouched, which is how a
handful of per-island ties becomes up to ten whole-board answers.

**A tie also has to be a materially different board.** An entry joins a shortlist only if it is
`MIN_ALTERNATE_DISTANCE` (five) tiles from every layout already kept — the count of tiles whose
occupant differs, an empty tile included, so one substituted building is 1 apart and one
relocated building is 2. Deduplicating by shape alone is what a `Set` of keys does and it is not
what the player asked of the list: a converged walk ties its own best constantly, nearly always
with the layout it is already holding minus one cooler, and the shortlist filled with copies of
one board. The same rule is applied at every gate that admits a layout — the collector,
`finalizeAlternates` (pruning and right-sizing move the boards, so the distances have to be
re-measured after them), `lib/worker/islandBest.ts` across attempts, and `chooseSolveVariants`
across runs. A layout that _beats_ the shortlist is exempt, because it empties it first: the bar
is on being a second answer, not on being an answer. Islands smaller than the bar simply come
back with no alternates, which is the honest answer for a board with nowhere else to put
anything.

**When porting `placement_search.py`, ignore the collector.** It is app furniture that happens to
live inside the search because that is the only place the tied layouts pass through. If a change
to the walk conflicts with it, the walk wins — the shortlist may come back shorter, and that is
all that happens.

## The RNG contract

`solver/rng.py` and `lib/solver/rng.ts` must produce **identical sequences from identical
seeds**. This is what makes the golden-fixture harness possible, and it is the easiest thing in
the codebase to break without noticing.

Rules:

- Any change to the RNG algorithm — the generator itself, `random()`, `choice()`, or
  `shuffle()` — **must be ported in the same commit** as the Python change.
- Do not "improve" one side's RNG independently. A better shuffle that changes the output
  sequence invalidates every fixture.
- After any RNG change, regenerate all fixtures, re-copy them to the TS repo, and confirm the TS
  side still matches. If it does not, the port is wrong.
- `tests/test_rng.py` and `src/lib/solver/rng.parity.test.ts` pin the same golden streams from
  both sides. They are the cheapest possible check that this contract still holds — run them
  first when a fixture starts failing for no obvious reason.
- Nothing in the solve path may depend on `hash()`, set iteration order, or dict ordering as a
  source of randomness. Python and JS will not agree.

---

## Parity harness

`parity/export_fixtures.py` writes one JSON file per case to `parity/fixtures/` at the repo root.

```
cd py_solver && python3 -m parity.export_fixtures   # regenerate, in place
cd .. && npm test
```

**Where the fixtures live, and why there.** One directory, `parity/fixtures/`, written by the
Python exporter and read by the TypeScript suite. There is deliberately no copy under
`py_solver/`: two committed directories are equal only while someone remembers to sync them, and
a stale one is indistinguishable from a real parity failure.

The root — rather than inside `py_solver/` — is what keeps the TypeScript suite from importing
across the tree boundary. An `npm test` that read `py_solver/parity/fixtures/` would make a
Python checkout a build dependency of the web app, and would break for anyone who has the repo
but not Python. The exporter reaches _out_ to write; the web app never reaches _in_ to read.

The TypeScript side reads them from `parity/fixtures/`:

- `src/lib/solver/parity.test.ts` — replays the fixtures
- `src/lib/solver/rng.parity.test.ts` — pins the RNG stream to the same goldens as
  `py_solver/tests/test_rng.py`

### The two expectation layers

Each fixture carries two recorded results, because only one of them can be pinned exactly (see
divergence 5):

| Layer      | Replayed with                           | Asserted                                                                                   |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `expected` | `maxSteps = 0` — annealing OFF          | **Exactly.** Placements must match element for element; power to a 1e-9 relative tolerance |
| `annealed` | the fixture's `maxSteps` — annealing ON | Invariants only: stability, tile bounds, and power within 5%                               |

`expected` covers seed construction, simulation, distribution, stabilize, prune, island splitting,
seed derivation and remapping — all pure arithmetic, all bit-identical. That is the layer that
catches mis-ports. **If you find yourself loosening an `expected` assertion, stop:** it has no
floating-point excuse, so a failure there is a real defect.

`annealed` exists to catch a grossly mis-ported walk (wrong move mix, wrong temperature curve,
wrong acceptance rule) while tolerating the 1-ULP drift that is genuinely unfixable.

### What the fixtures replay — and why it is not `solve()`

**`solve()` is not reproducible, even with a fixed seed.** Every stage of `solve_island` is
gated on wall-clock deadlines, so the number of steps that fit in a budget varies between runs
on the same machine. A fixed seed narrows run-to-run variance; it does not eliminate it. Exporting
`solve()` output would produce fixtures that fail at random.

So the fixtures replay the deterministic core instead — the cross-language oracle described in
`CLAUDE.md`:

1. `split_grid_into_islands` (already deterministic)
2. per-island seed `(root_seed + island_index) & 0xFFFFFFFF`
3. `_construct_multi_start_seed` (deterministic; its internal `Rng(42)` is fixed)
4. `_hill_climb` with a fixed `Rng` and **`max_steps`**, which drives the temperature schedule
   off step count instead of elapsed time
5. `_prune_dead_weight`
6. `_remap_placements` back to grid coordinates

Every deadline passed into that path is set 1e6 seconds out, so none can fire and step count
alone decides where the walk stops.

**The composition-retarget and greedy-polish stages are deliberately omitted.** They are
`while time.time() < deadline` loops with no step cap, so there is no way to replay them
deterministically without changing the solver. **The TS parity test replays this same reduced
pipeline** via `replayIslandDeterministic()` in `placementSearch.ts` — running `solver.ts` end to
end will not match the fixtures, and is not supposed to. If you change which stages the replay
covers, change it on both sides in the same commit.

`hillClimb`'s `maxSteps` parameter exists on both sides purely for this: when set, the temperature
schedule runs off step count instead of elapsed time. Production never sets it.

### Determinism rules

- Placements are serialized in canonical order — ascending flat tile index (`y * width + x`) —
  never in the order the search produced them.
- Floats are rounded to 9 decimals before serialization. Note this is a no-op at the magnitudes
  the solver reaches (~1e22): **compare `power_output` with a relative tolerance, not an absolute
  `1e-9`**, which is far below one ULP there.
- No timing data (durations, iteration counts) is recorded — it is not reproducible.
- Nothing in the replayed path may depend on `hash()`, set iteration order, or dict ordering.

Re-running the exporter against an unchanged solver reproduces every file byte for byte. If it
does not, something in the solve path has become non-deterministic, and that is a bug in its own
right.

### Cases

| Name                  | Why it exists                                                       |
| --------------------- | ------------------------------------------------------------------- |
| `single_tile`         | Degenerate island; catches empty-result and off-by-one handling     |
| `small_grid_seed42`   | Baseline; one island, small enough to diff by hand                  |
| `two_island_seed7`    | Exercises `_remap_placements` — the highest-risk port surface       |
| `three_island_uneven` | Islands of very different sizes; catches per-island seed derivation |
| `no_buildable_tiles`  | All-water grid; must produce the empty result, not an error         |
| `full_upgrades_seed1` | Largest single island and longest walk; pins max level explicitly   |

Every case now exports against the same max-level roster, because `UNLOCKED_UPGRADES` unlocks
the whole catalogue. `full_upgrades_seed1` still asks for max level explicitly rather than
inheriting it, so it stays the widest-search-space case if that progression is ever narrowed.

**Regenerate fixtures when** the solve output legitimately changes — a new search stage, a
tuning-constant change, a scoring fix. **Do not** regenerate to make a failing test pass without
first confirming the change was intentional; that is the harness doing its job.

Fixture files are committed. Diffing them in a PR is often the fastest way to see what a solver
change actually did.

---

## Porting checklist

When a solver change is prototyped in Python:

1. Find the peer file in the table above. If there is no peer, check the divergences section
   before assuming one is missing.
2. Port the change. Keep function and variable names aligned where the language allows
   (`snake_case` ↔ `camelCase` is expected; different _words_ are not).
3. If the change touches `rng.py`, port it in the same commit.
4. If the change alters solve output, regenerate the fixtures (they are written straight to
   `parity/fixtures/`) and confirm `npm test` still passes.
5. If the change adds a file, add it to the mapping table above.
6. If the change creates a deliberate divergence, document it in the divergences section. An
   undocumented divergence is indistinguishable from a bug.
