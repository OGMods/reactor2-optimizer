# The solver package

`@reactor2/solver` (`packages/solver/`) is the game's rules, its building roster, and a
near-optimal placement search over them. It is a plain npm workspace with **no runtime
dependencies**, consumed by the web app through the workspace link and runnable on its own from
the terminal.

```
packages/solver/
  src/solver/     the engine: types, island split, simulation, distribution, search
  src/data/       the authored building tables, the shipped island codes, unlock resolution
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
