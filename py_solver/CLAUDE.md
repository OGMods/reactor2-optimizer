# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A standalone, dependency-light Python implementation of a reactor/power-grid
building-placement optimizer: given a grid and a roster of
reactors/generators/coolers, lay out buildings to maximize power output
subject to heat/cooling flow rules. It includes a Pillow-based isometric PNG
renderer for visually inspecting results. It consumes the web app's sprite
atlas (`public/data/web_atlas.json` + `.webp`, read directly from the repo root
rather than copied in) and reads maps as blueprint codes (`blueprint.py`), the
same format the TypeScript app uses for its maps, saved layouts and share codes.

The authoritative rules for the game model this solver implements — grid,
adjacency, heat/cooling distribution via "FairShare + Augmenting Repair",
the placement/simulation model — are in `../docs/game-logic.md`. Read it before
touching `solver/`.

## Commands

```bash
pip install -r requirements.txt      # only dependency: Pillow

python3 main.py                      # one 30s run on the default map
python3 main.py --map 3 --time 60    # one 60s run on map 3
python3 main.py --all --runs 3       # 3 runs on every map, best-of comparison
python3 main.py --map 1 --seed 7     # fix the search's random stream (see below)

python3 -m unittest discover          # run the test suite (~35s)
python3 -m unittest tests.test_distribution -v   # one module, verbose

python3 -m parity.export_fixtures    # regenerate the TS parity fixtures (to ../parity/)
```

Output PNGs land in `solves/`. There is no linter or formatter
configured (no pyproject.toml, ruff/black config); `python3 -m pyflakes .` is
clean and is the cheapest check that an edit left no unused import behind.

`README.md` is the human-facing version of this section — commands, the map
list and a short tour of the pipeline. Keep the two in agreement.

## Tests

`tests/` uses stdlib `unittest` — no test dependency to install. It also runs
under pytest unchanged if you'd rather (`pip install pytest && pytest`).

The suite is organized by layer, and the important thing to know is what each
layer is protecting:

- **`test_distribution.py`** — the highest-value file. Every worked example in
  `../docs/game-logic.md` is a test here: FairShare's sequential (never evenly
  re-split) leftover handling, both repair walkthroughs, and the fact that
  processing order changes the result. It also checks total
  delivery against an independent Edmonds-Karp oracle, so "repair repeats until
  no further reclaim helps" is verified rather than assumed.
- **`test_simulate.py`** — the authored per-tier conversion (and that it is not
  the 0.75 fallback), that a partly-filled generator scales both figures, the
  all-or-nothing cooling rule (including that the boundary is `<=` and that its
  tolerance is relative), and that cooling never feeds back into heat.
- **`test_island.py`** — 8-neighbor connectivity (corner-touching blocks are ONE
  island), the 2-vs-3 minimum island size, and the local→original coordinate
  mapping.
- **`test_search.py`** / **`test_pipeline.py`** — structural contracts (one
  building per tile, grass only, reported power equals a fresh simulation of the
  returned layout) plus quality floors on real maps, since the search is
  stochastic and can't be asserted exactly.
- **`test_golden_layouts.py`** — known-best-layout regressions across a ladder
  of island sizes (3, 4, 5, 6, 7, 8 and 9 tiles), with everything unlocked
  except generator7/cooler7/flux_reactor/doomStar_reactor. Every expected
  layout was verified by exhaustive brute force, not by recording solver
  output; each size is pinned twice, once against the simulator and once
  against the search. These power figures are proven optima and must never go
  down. Two cases are worth knowing: the 6-tile island is the most
  search-sensitive (greedy seeding only reaches 5.19e19, so 5.28e19 depends on
  annealing), and the full 3x3 asserts power as a floor because the search
  lands the best arrangement only about half the time.

  When brute-forcing a new case, keep the candidate set lean — top generator,
  top cooler, top three reactors, plus "leave empty". Generators and coolers
  jump 400x–4100x per tier so lower tiers can never appear in an optimum, while
  reactors jump only ~8x, which is why a third-tier reactor legitimately shows
  up in the 7-tile answer as a cooling top-up. Widening the set past that
  multiplies runtime by N^tiles for no benefit.

- **`test_grid.py`**, **`test_buildings.py`**, **`test_formatter.py`**,
  **`test_report.py`** — decoding, roster integrity, number formatting, and the
  placement validator.

When changing solver behaviour deliberately, expect to update the quality floors
in `test_search.py` / `test_pipeline.py`; the rule-derived tests in
`test_distribution.py` and `test_simulate.py` should NOT need changing — if one
of them fails, the change contradicts the spec.

`tests/helpers.py` has the fixtures worth knowing: `reactor()`/`generator()`/
`cooler()`/`direct_producer()` factories, `make_grid([...])` for ASCII grids, and
`place([...], legend)` for ASCII layouts.

## Architecture

File names are kept aligned with the TypeScript tree they are ported to; see
`../docs/PARITY.md` for the mapping and for every intentional divergence.

Dependency direction is strictly one-way: `solver/types.py` → everything else.
Nothing imports back up, and no module re-exports another module's types.

### Shared

- **`blueprint.py`** — the layout codec: `encode_blueprint()` /
  `decode_blueprint()` (one byte per tile, deflate, base64url; buildings and
  terrain in one payload) and `blueprint_key()`. Peer:
  `lib/encoding/blueprint.ts`, and the byte tables **must** match it —
  `tests/test_blueprint.py` pins them against the TypeScript source. Compare
  layouts with `blueprint_key()`, never with the encoded string: DEFLATE only
  guarantees a round-trip, and CPython and the browser demonstrably emit
  different bytes for the same payload.
- **`grid.py`** — tile predicates (`count_grass_tiles`, `is_island_tile`) and
  the `TILE_CHAR_MAP` alphabet tests are written in.
- **`formatters.py`** — the game's compact suffix notation (K/M/B/T, then
  AA…ZZ): `format_number`, `parse_huge_number`, and `format_for_filename`.
- **`main.py`** — CLI entry point: decode map → `solve()` → render → `verify()`
  → `print_summary()`. Handles run comparison and output file naming only.

### `data/` — static game data

- **`buildings.py`** — `BUILDINGS` (the full game roster, one role class per
  building, each carrying one record per upgrade tier) and `UNLOCKED_UPGRADES`
  (`building_id -> level index`; buildings absent from this map are locked).
  `UNLOCKED_UPGRADES` is derived rather than hand-listed — every building at its
  top tier, `len(levels) - 1` — so nothing is locked and the search sees the
  whole catalogue.
  The figures are the exact ScriptableObject values from `Assets/3.Data/Buildings`,
  not the 3-significant-figure numbers the UI shows and not
  the extractor's rounded JSON extract: cooler2 tier 3 is 18662, not 1.86e4. Generators
  and the wind turbine additionally carry authored `EnergyPerTick` and
  `WasteHeatPerTick` per tier. It is this checkout's own
  progression, not game data — the TypeScript peer holds the player's actual
  unlocks and the two are not expected to match.
  `BUILDINGS` is **generated** by an external extraction script (not in this
  repo), which emits this block and its TypeScript peer from one roster, so the
  two cannot disagree about a number — don't hand-edit either table.
  `UNLOCKED_UPGRADES` is hand-owned and survives regeneration.
- **`effective_buildings.py`** — `get_effective_buildings()`, which collapses
  those two into the flat roster the solver and renderer consume.
- **`maps.py`** — the island maps as `GameMap(num, name, code)` records, where
  `code` is a blueprint. The code carries the grid's dimensions, so there is no
  separate width to drift out of sync. Map `0` is the small "custom" board; `1`-`8`
  are the shipped islands, numbered to match `island1`..`island8` in
  `lib/data/maps.ts` — but **the boards are deliberately different**. The app
  ships each island as the game hands it out; these carry the obstacles this
  player has already cleared, because this tree exists to produce solves for
  that save. 1-10% of tiles differ per island. Do not "fix" that, and do not
  compare the two by their codes — DEFLATE output differs between CPython and
  the browser for identical payloads, so use `blueprint_key()`.

### `render/` — isometric PNG output

- **`atlas.py`** — `TextureAtlas` loads the atlas JSON+PNG and crops per-frame
  sprites with Pillow. Owns the atlas file paths, which resolve to the repo's
  `public/data/` — the same files the web app loads, deliberately not a second
  copy, so a repack cannot leave the two renderers drawing different sprites.
- **`isometric.py`** — projection constants, `grid_to_iso()`, the sprite frame
  lookups, and the bitmask auto-tiling frame keys for ground/shoreline tiles.
- **`renderer.py`** — `IsometricRenderer.render()` draws a grid + placements in
  three painter's-algorithm passes (ground/water, grid outline,
  buildings/props), using a fixed scale/anchor formula (see the "Exact Scale
  Formula" comment in `_draw_sprite`).

### `solver/` — the optimizer

- **`types.py`** — every dataclass crossing a module boundary: `Tile`,
  `BuildingDefinition`, `EffectiveBuilding`, `IslandSubGrid`,
  `PlacedBuilding`, `OptimizationSummary`, `OptimizationResult`. Import these
  from here and nowhere else.

  `BuildingDefinition` is a tagged union of four role classes — cooler,
  reactor, generator, direct producer — so `type` names the role outright.
  A flat class over the game's three categories instead makes telling a reactor
  from a direct producer a matter of `type == "heat_producer" and waste_ratio is
  None`. Per-level numbers are one record per level, not parallel lists, so a
  level cannot exist with half its numbers missing.
  `EffectiveBuilding` stays flat and role-agnostic: `effective_value`, `energy`
  and `waste`, with the role's waste rule already applied by
  `data/effective_buildings.py`.

- **`constants.py`** — `CHEBYSHEV_DIRECTIONS`, `EPS` (Unity's
  `HeatFlowTolerance.Floor`, `1e-6`) and `spatial_key`, the game's fixed
  processing order. `GENERATOR_ENERGY_RATIO` / `GENERATOR_WASTE_RATIO` also live
  here but are **not** a game rule — see `physics.py`. Search _tuning_ constants
  stay private to `placement_search.py`.
- **`physics.py`** — the generator conversion and the cooling threshold, in the
  game's own terms. A generator does not convert at a fixed ratio: each tier
  authors `HeatPerTick` / `EnergyPerTick` / `WasteHeatPerTick` and scales the
  latter two by how full it is, which puts `energy / heat` near 0.75 without
  landing on it. `waste_is_covered()` is the online test and its tolerance is
  **relative** (`max(1e-6, magnitude * 1e-9)`) — at 1e18 one ULP is already
  ~1e2, so an absolute epsilon would shut down buildings the game keeps
  running. `snap_to_authored_precision()` mirrors `NumbersTools`, and is how
  `WasteHeatPerTick` is derived when a source does not author one.
- **`rules.py`** — the grid adjacency primitives derived from those constants:
  `TileId`, `is_adjacent`, `build_neighbor_map`.
- **`__init__.py`** — re-exports `solve`, `verify`, `print_summary` lazily via
  PEP 562 `__getattr__`. `grid.py` imports from `solver/types.py` while
  `solver/solver.py` imports from `grid.py`, so an eager re-export here is a
  circular import that only fires when `grid` is imported first. Attribute
  access is unchanged; don't convert these back to plain imports.
- **`island.py`** — `split_grid_into_islands()` (8-neighbor connected-component
  decomposition into independently solvable sub-grids), `can_cool_direct_producer()`
  (which sets the 2-vs-3 minimum island size), and the theoretical max-power
  bound used to report layout efficiency. The bound is a TRUE upper bound (an
  adjacency-free LP over tile-count splits, shared cooling included): no
  layout may ever beat it, and `test_island.py` checks that property against
  random layouts. On map 1 it sits ~2% above the known optimum, so efficiency
  figures just under 100% are expected and meaningful.
- **`distribution.py`** — `Node` and `run_distribution()`: FairShare followed by
  an Edmonds-Karp Augmenting Repair, run identically for heat
  (reactor → generator) and cooling (cooler → generator/direct producer).
  It is a port of Unity's `FlowNetwork.cs` down to the node numbering
  (`[suppliers][consumers][source][sink]`) and the flat `edge_flow` +
  `supplier_edges` / `consumer_edges` adjacency of `FlowNetwork.BuildIsland`.
  Total max flow was never in question; the **split** is, and the split is what
  decides which buildings clear their cooling threshold.

  Two shapes matter and neither is arbitrary. A supplier does not jump straight
  to the sink on finding a consumer with room — it enqueues the consumer and
  lets the consumer connect to the sink, because the shortcut marks later
  consumers visited and can select a different equal-length augmenting path.
  And each component's suppliers **must** stay in ascending index order: the
  BFS expands them in that order, and when several augmenting paths tie, the
  first one reached wins, so grouping them in discovery order silently yields a
  different maximum flow. `test_component_order_decides_the_split_not_just_the_total`
  pins a case where the two orderings diverge.

  Augmenting Repair runs per connected component, and is skipped entirely
  when either every supplier is exhausted or every consumer is full — which
  fires on ~47% of distributions in a dense solve. Both are exact no-ops
  semantically; the suite is built so those mutations _survive_.

- **`simulate.py`** — `simulate_island()`: evaluates a fixed placement and
  returns total online power plus one `PlacedBuilding` per occupied tile. This
  is the hot path — the search calls it millions of times per solve. Note it is
  _not_ the bottleneck it looks like: a power-only variant and a lazy per-tile
  report were tried and bought 2–13% more evaluations per second with **no**
  change in solve quality, because the search converges well before it runs out
  of evaluations. Both were reverted. Don't re-attempt this without first
  showing that a map is actually evaluation-starved.
- **`placement_search.py`** — `solve_island()`, a six-stage pipeline:
  `seed → repair → composition retarget → (annealing → repair)* → pruning →
  right-sizing`.
  The starred pair repeats until the deadline, because repair's slice is
  reserved before the layout exists and it converges long before its cap;
  what it hands back becomes another short walk instead of idle time.
  Enforces the stability rule below via `_offline_producers()` / `_stabilize()`.

  Seed construction builds **self-sufficient hubs** — one generator plus the
  reactors and coolers it needs alone — so it can never produce a layout where
  neighbouring hubs share a cooler or a reactor, which is what the best layouts
  do. On the 67-tile map 1 island that caps it 7% below the best known layout.
  The other stages exist to cover that:

  - **`_greedy_polish`** — steepest ascent over single-tile changes. Annealing
    was meant to find these but on a large packed island nearly every
    single-tile change costs several percent, so the walk drifts downhill and
    rarely returns: only 1 evaluation in 26,000 beat its own starting layout
    there, while 20 stable improving moves sat one move away.
  - **`_target_compositions` / `_arrange_composition`** — deciding _what_ to
    build is a counting problem with an exact answer (maximize
    `0.75·min(heat, n_gen·H_max, n_cool·C/0.25)` over tile counts), so it is
    computed directly instead of searched for, and the search is left with the
    genuinely hard part: where to put it. `_arrange_composition` then moves
    only via swaps, which preserve the composition.

    Each tile split is scored with _two_ reactor fills, and both are needed.
    Packing every reactor tile with the top tier maximizes heat — overshooting
    the budget is free, since surplus heat is simply never absorbed and power
    stays capped — and wins when generator or cooling capacity is the limit.
    Stepping down tiers to land just under the budget wins when COOLING is the
    limit, because the all-or-nothing rule shuts a generator down entirely if
    its waste outruns the cooling reaching it. Keeping only the second fill
    made the returned figure _lower than layouts the solver actually builds_,
    which matters because it is used as an upper bound: with both, no island
    on any map exceeds it, and 14 of 25 land exactly on it — i.e. are provably
    optimal.

  - **annealing** keeps its place between them for moves neither can make —
    crossing a barrier no single change improves on. Its temperature is scaled
    to the size of one _move_, not to the island's total output; scaling by
    total power made large islands run far too hot. It also snaps back to the
    best layout after a long stall.

  Together these took map 1 from 682AB to its known optimum of 693AB on every
  run, and every map improved or held. If you replace the seeding or annealing,
  re-measure map 1 specifically — it is the case that exposes all of this.

  **`_downgrade_oversized` is not part of the search.** It runs once, on the
  finished layout, and cannot find a better one — it re-tiers what is already
  there. The search maximizes power, and power cannot tell a cooler running
  flat out from one running at 2%: both keep the same generators online, so
  both score identically and nothing in the walk prefers either. The result is
  that the roster's top cooler lands on a tile needing a twentieth of it, which
  is real money the player spends on capacity that never runs. On the shipped
  maps this is worth a `cooler7 → cooler1` on every wind-turbine island and a
  spare `cooler7 → cooler1` on most large ones, at **identical** power.

  Covering a tile's current load is what makes a candidate plausible, not what
  makes it safe — shrinking a supplier changes the FairShare split, and the
  split is what decides which producers clear their cooling. So each swap is
  re-simulated and accepted only under `_prune_dead_weight`'s test: no power
  lost against the layout handed in, and no producer left offline. Power is
  defended against the figure the pass _started_ from rather than the running
  total, so a run of swaps cannot drift down one tolerance at a time. The sweep
  repeats to a fixpoint, because shrinking a generator changes the waste its
  cooler has to absorb and can free a cooler the sweep already walked past.

  Direct producers are deliberately excluded: one always runs flat out, so it
  has no slack to give back and a smaller tier is simply less power.

- **`solver.py`** — `solve()`: splits the grid, hands each island a
  proportional slice of the time budget (in worker processes when there is
  more than one island), and stitches results back into grid coordinates.
- **`report.py`** — `verify()` (post-hoc placement sanity checks) and
  `print_summary()`.

### `parity/` — golden fixtures for the TypeScript port

- **`export_fixtures.py`** — writes one JSON file per case to
  `parity/fixtures/` at the **repo root** (committed), which is the only copy:
  the TypeScript suite reads that directory, and this tree deliberately keeps
  none of its own, because two committed directories are equal only for as long
  as someone remembers to sync them. Terrain is stored as a blueprint code, which
  the TS suite decodes; it never re-encodes and compares strings. It does NOT call `solve()`: every stage of
  `solve_island` is wall-clock gated, so a seeded `solve()` is not
  byte-reproducible. It replays the deterministic core instead — seed
  construction, then `_hill_climb` with a fixed `Rng` and `max_steps`, then
  pruning and remapping — with every deadline set far enough out that it can
  never fire. Composition-retarget and greedy-polish are omitted because they
  are deadline loops with no step cap.

  Each fixture records **two** results. `expected` is replayed with annealing
  OFF (`max_steps=0`) and is asserted exactly by the TypeScript suite;
  `annealed` runs the walk and is tolerance-checked only. The split is forced:
  the walk is the one place the solver calls `pow`/`exp`, and CPython's libm
  and V8 disagree by 1 ULP on values it actually hits, which is enough to flip
  an acceptance and diverge the walk permanently. Everything else is pure
  arithmetic and is bit-identical. See `../docs/PARITY.md` divergence 5.

## The stability rule

**A solved layout must be fully stable: every generator and direct producer it
places has to actually run.** A building that overheats (waste above the cooling
routed to it) or that never receives heat produces nothing, and must not appear
in the result at all.

This is a constraint on top of "maximize power", and the two genuinely conflict:
a layout can score higher by parking reactor heat in a generator that is never
cooled, because nothing then has to cool that share of the waste. On a 3x3
island that trick is worth 7.04e19 against 6.60e19 for the best stable layout —
and it is still the wrong answer.

Consequences worth knowing before touching `placement_search.py`:

- `_stabilize()` drops zero-power producers **unconditionally**, and repeats:
  removing one hands its heat to its neighbours and can push them over their
  cooling budget in turn. Power may legitimately fall as a result.
- The annealing walk may pass _through_ unstable layouts, but only a stable one
  may be recorded as the best result. Ranking candidates on raw power alone
  makes the search settle on peaks that then collapse when stabilized.
- So "pruning never reduces power" is NOT a valid invariant. The valid ones are
  "the returned layout is stable" and "pruning a stable layout never reduces
  power".

## Conventions

- All dataclass fields are `snake_case`.
- The solver is stochastic: repeated runs on the same map give different
  results. Only seed construction and `simulate_island` are deterministic, so
  those are what to compare against when refactoring.
- All randomness in the search flows through `solver/rng.py`, a mulberry32
  PRNG chosen because it is bit-identical to a four-line JS implementation
  (`lib/solver/rng.ts` in the shipped web-worker port, where `Math.random()` is
  not seedable). `--seed` / `solve(seed=...)` fix the stream — same seed, same
  move sequence — but stage deadlines are wall-clock, so seeding narrows
  run-to-run variance rather than making runs bit-identical. For bit-identical
  replay (the cross-language oracle for the JS port), call `_hill_climb` with
  `max_steps` and a fixed `Rng`: the temperature schedule then runs on step
  count and the walk is fully deterministic.
  `tests/test_rng.py` pins the stream to Node-generated golden values; if it
  fails, fix the code — never re-record the values from Python output.
