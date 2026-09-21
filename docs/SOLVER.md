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

  **Waste is derived, not scaled, and it is re-derived at every step.** A scaled building's
  waste is `snapToAuthoredPrecision(heat − energy)` recomputed from the pair that was just
  scaled, never the authored waste carried through the same multiply — the snap is a decimal
  rounding applied to the *difference*, so the two disagree in the last digit and the fixtures
  assert exactly. Only the two roles that *have* waste derive one; `heat − energy` over a cooler
  or a reactor would turn its whole output into waste.

  **Research and anomaly are two successive calls, research first, and that is not the same
  double as one combined factor.** The game applies the Time Lab in the ScriptableObject getter
  and the anomaly in the runtime getter, so what a building is rated at is
  `(authored × research) × anomaly` — `scaleEffectiveBuilding` called once by
  `getEffectiveBuildings` as it resolves the roster, and again by whatever applies the anomaly.
  Generator7's first tier under ×5 then ×2.5 is 1.3875000000000001e22 against 1.3875e22 for
  ×12.5, and the *order* is observable too: its fourth tier under ×5 then a ×1.67 shore is
  7.38975e22 where the reverse is 7.389749999999999e22. Each call re-derives the waste, so the
  last one wins. `tests/scaling.test.ts` pins both readings against the shipped catalogue rather
  than round numbers — every divergence here is in the last bit, where a test on tidy figures
  passes under either. Nothing above the roster would notice a reversal: the fixtures pass no
  anomaly, so they cannot see it either. See `docs/game-logic.md`.
- **`role_isolation` depends on the layout, the other shapes do not.** A terrain bonus is fixed
  per tile and can be folded into the board; a generator's isolation multiplier changes every
  time the search moves a neighbour, so a placed building's figures have to be resolved per
  layout — which `simulateIsland` does, below.

**All four shapes are implemented**, `baseline` being the one that has nothing to do. Each is
resolved wherever its inputs are settled and nowhere else: a terrain bonus per tile as the context
is built, a role isolation per layout inside `simulateIsland`, and a shared cooling pool in the
decomposition, before there is an island at all. The three sections below take them in that order.

`terrain_affinity` is resolved by `terrainScales` into a per-tile multiplier when the context is
built — nothing about a layout can change which tiles qualify — and `IslandContext.rate(tile,
building)` is then a lookup, so the rule costs the search nothing.

`uniformRating` is the flag that says `rate` is the **identity**: `ctx.rate(t, b) === b` for every
tile and every building, so a stage may skip the call entirely. It is hoisted out of `rate` so the
common case is one boolean rather than a per-tile array read, and it has to promise the whole of
`rate`'s behaviour rather than only its per-tile half — `rate` carries a per-role factor beside its
per-tile one (see `shared_cooling` below), and a flag reading `tileScale === null` alone was true
under a pool while every cooler was being scaled by 0.88. A stage taking the invitation would then
have rated Cryo coolers at their unscaled figures and returned a layout over-cooled on paper that
the game shuts down board-wide, with nothing failing anywhere. So it is false under a tile scale
*and* under a role scale, and true under `baseline` and under `role_isolation` — which `rate` does
not answer at all, since `simulateIsland` resolves it through `rateIsolated`.

Two things about where it is applied:

- **At the write, not the read.** A step of the walk writes one or two tiles and then simulates the
  island, which reads every occupied tile's three figures — so resolving at the write is some 25x
  less work, and `simulateIsland` stays exactly as it was. `put()` is the only way a building
  enters a placement, so the bonus cannot be missed at one of three dozen sites; a miss would be
  silent, the layout simply being worth less than it is. Resolution is a lookup rather than a
  multiply because a scaled building's waste is `snapToAuthoredPrecision(heat - energy)`, and that
  snap is a string round-trip.
- **`rate` is idempotent.** The search swaps buildings between tiles and restores them when a move
  is rejected, so it hands back objects it was already given; without this a restore would scale a
  scaled building. `downgradeOversized` is the one place that also has to rate a *candidate* before
  comparing it, since the ladder is the plain roster while the building it is replacing and the
  load it measured are both in the tile's units.

**A placement holds rated buildings, so everything compared against one has to be in the tile's
units.** The roster is what every stage reaches for — pools of candidates, a composition's score,
the downgrade ladder — and none of those figures mean the same thing as what is on the board once a
rule rates a tile above or below the roster. Each of the four comparisons that gets this wrong
fails silently, and in a different way:

- **The no-op guards.** A move asks "would writing this change anything?", and the answer has to be
  `ratedFor(ctx, tile, candidate) === current[tile]` rather than a comparison against the plain
  entry, which is never equal on a scaled tile. The guard then stops firing, the move writes back
  an identical object, a full `simulateIsland` runs and `accept` is handed a delta of zero, which
  it accepts. No number moves and the walk spends a slice of its budget on steps per second. The
  comparison is exact because `ctx.rate` caches one object per (scale, roster entry) pair, which is
  also what makes it a lookup rather than a multiply.
- **The under-fed-reactor move** (`isUnderFed`) measures what a supplier actually sent against
  `ratedValue`, the capacity the tile was rated for. Against `baseValue` it compares a scaled
  delivery with an unscaled ceiling and only calls a reactor under-fed below `1/k` fill — 60% on a
  Tidal shore, 20% under a ×5 Stellar Forge — so the move stops firing on nearly everything it
  exists for.
- **The composition retarget's gate** (`targetCanBeat`). A target is scored from the plain roster,
  which is right — which buildings to use is a counting problem over the roster — but `bestPower`
  is a rated layout's power, so the target is scaled by `islandRatingCeiling` before the two are
  compared. The gate is a `break` over a descending list, so answering `false` once ends the stage
  outright: on island3 under Tidal a 0.6s run already returns 1.68e23 against a top target of
  1.49e23, and the stage never ran at any realistic budget. Restoring it took the stage from 1 of 3
  targets attempted to 3 of 3; the power difference sat inside run-to-run noise, so this buys the
  stage back rather than a number.
- **Right-sizing** (`ratedCapacity`) sizes a candidate the way the layout will rate it, which for
  `role_isolation` means asking `rateIsolated` rather than `rate`. An isolated generator authored
  320, rated 800 and absorbing 300 was never offered the authored 120 tier that covers 300 at its
  own rating, so the pass left 500 of intake nobody pays it to have — exactly the money the stage
  exists to hand back. The other direction is caught by the re-simulation, so only the waste
  escaped.

`islandRatingCeiling` is one number for the island, resolved once per solve, and it is asked of the
**context** rather than read off the anomaly — so a rule resolved per tile and one resolved per
layout are both answered by the code that applies them, and a fifth rule shape needs nothing there.
Scaling a plain-roster figure by one island-wide factor is the same move the bound makes, sound for
the same homogeneity reason, and loose in the same place. Loose is the right way to be wrong here:
a ceiling too low skips a stage that would have helped, one too high costs a few arrangement
attempts that fail to beat the layout in hand.

**A terrain bonus is a harder search, not just a bigger number.** A shore generator makes x1.67 the
waste while an inland cooler still covers x1, so a cluster straddling the coast goes offline — a
layout optimised under the base rules scores *lower* re-rated under Tidal, and the search has to
keep each cluster on one side of the shoreline. On Magma Rift at 20s,
`npm run solve -- --map 3 --anomaly tidal_ascendancy` returns 181AC against the baseline's 142AC.
The seeding heuristics pick candidates by unscaled roster figures, and two ways of changing that
were measured: ranking a hub by its fit times the tile's multiplier, and restricting a hub's tiles
to one class so it cannot straddle the coast. **Neither paid for itself** — both landed at or below
the unchanged search across three seeds, because `powerPerTile` orders a greedy claim that the
later stages rewrite, so skewing it toward the coast mostly changes which tiles are claimed first.
Don't re-attempt either without a wider measurement.

`role_isolation` is resolved in `simulateIsland`, the one place a whole layout is in hand. It
copies the placement into `ctx.ratedLayout` — held by the island, not allocated per call — re-rates
the affected role's tiles and reads every figure through that. Two details are load-bearing: the
neighbour scan reads the *original* placement, since the test is on what a neighbour **is** and no
rating changes that, so there is no order to get right; and `ctx.rateIsolated` is a lookup over two
variants per roster entry rather than a multiply, for the same snap-is-a-string-round-trip reason
`rate` is.

**This anomaly is close to power-neutral on the shipped maps, and that is the rule rather than the
search.** x2.5 scales a generator's *intake*, which is a capacity: fed by the reactors it already
had, a bonused generator fills to 40% and produces exactly what it did before. Only the penalty
bites, and the penalty is avoidable by keeping generators apart. Map 3 at 15s comes back 1.4075e23
against a 1.4202e23 baseline, where the baseline layout *re-rated* under the anomaly is 1.2849e23 —
so the search recovers most of the penalty and there is no gain to find. Sizing the composition
retarget from the isolated rating, which is the only stage that can propose the different mix the
bonus would need, was measured and changed nothing. That is a different thing from putting the
stage's *gate* into the layout's units, which is above and is not a tuning choice: targets are
still scored from the plain roster, and nothing in the tree retargets toward the bonus.

**The bound takes the anomaly too, and every rule of it.** `estimateTotalMaxPower` rates each
island at its best tile (`islandMaxScale`), because a bound computed on the plain roster is one a
rated layout walks past — and "no layout may ever beat it" is an invariant the rest of the solver
is entitled to assume, not a presentation detail. Magma Rift reported 119.9% layout efficiency
before the terrain case existed, and a generator-bound roster on a 3×3 under Singularity read
163.8% before the isolation case did; both are now the intended side of 100%, the 3×3 at 65.5%.

`islandMaxScale` is an exhaustive switch with **no `default`**, deliberately: a fifth rule shape
added to `AnomalyDefinition` fails to typecheck here — "function lacks ending return statement" —
rather than silently returning 1, which is what `role_isolation` did while a layout was walking
past the bound by 64%. It answers `max(isolated, crowded, 1)` under a role isolation, because which
of the two variants a tile gets is a function of the layout rather than of the island and a search
free to keep generators apart rates every one of them at the bonus; `max(coolerMultiplier, 1)`
under a shared pool, which is 1 for the shipped ×0.88 and leaves the bound untouched; and the
multiplier under a terrain list it cannot fully decide. It can decide only a list that is exactly
`["water"]`, since the shore mask is the one thing that knows off-board counts as water, while
`terrainScales` tests rock and tree against the grid — so a landlocked island under a
`["water", "rock"]` anomaly errs high rather than staying at 1.

Scaling the estimate's *result* is sound because `estimateIslandMaxPower` is positively homogeneous
of degree 1 in the roster's figures: multiply every one of them by `k` and each of `hFirst`,
`dRest`, `dFirst` and `hRest` scales by `k` while every ratio in it is invariant. That is also what
lets a rule scaling only *some* buildings be answered with one island-wide number — any layout
feasible under the partial scaling is feasible in the all-scaled world with an objective no larger.
It is loose where only part of an island qualifies, or where only part of the roster is scaled,
which is the right way to be wrong: a bound that can be beaten is worthless, one that is generous
only makes the efficiency figure read low.

`shared_cooling` is the odd one out entirely: it is the only shape that changes more than a
building's figures. **Its pool is the whole board** — the game's "island" is the map, Gale Hills
and Ash Bay, and "cooling does not carry over to other islands" means it does not carry to a
different map. So under Cryo Nexus the components `splitGridIntoIslands` produces are **not**
independent, which is the assumption the worker pool, the per-island budget split, `IslandBest` and
`variants.ts` all rest on.

**The resolution is to stop producing them.** `wholeBoardIsland` hands the board over as a single
island, which makes the pool board-wide by construction and leaves every one of those assumptions
true. It costs nothing elsewhere in the simulation: `runDistribution` already scopes its round
budget and its repair to each connected component of the supplier/consumer graph, which is a finer
partition than the island, so heat stays adjacency-bound. It is also what brings in the tiles no
decomposition keeps — every grass tile is on the one island, including the 21 across the shipped
maps that are otherwise dead ground, so `minIslandTiles` has no Cryo case to answer.

The price is per-island parallelism: one island is one pool task, so a board of two large
landmasses searches on one core where it could have used two. On the shipped maps that is small —
most are one landmass and a few scraps, so one island already holds about 95% of the budget — and
it buys the entire board-level problem for nothing. The alternative is to describe each component
by a frontier of power against the net cooling it contributes and combine those frontiers under one
scalar budget, which is a different and much larger machine.

**The pool needs no second code path through the rest of the simulation.** `simulateIsland`
replaces the cooling distribution with the game's `DistributeCryoArea`: total the coolers, total
what the sources are owed, and serve everyone the same fraction. Because the fraction is common, a
short pool leaves *every* source under its waste at once — so the ordinary per-producer online test
below it produces the board-wide all-or-nothing the rule describes, with no board-level flag
anywhere. Each cooler is reported its share of what the pool actually absorbed, which is the game's
own reporting rule.

The x0.88 is not part of that. It is a uniform scale on the cooler role, applied through `ctx.rate`
like any other multiplier, because the game applies it to `CoolerBuilding.CoolingPerSec` — it is
what a cooler is worth and what the game shows for it, not a charge levied at the pool. `rate`
therefore carries a per-role factor beside its per-tile one; only ever one of the two is in force,
since only one anomaly runs at a time.

It is worth real power, and most on a fragmented board, since the x0.88 has to be earned back
first: map 7 at 25s goes 271AC to 294AC, map 3 at 20s 139AC to 145AC, and map 1 — one landmass,
already at 98% of its bound — is unchanged.

**One open question, deliberately left open.** `hillClimb`'s `moveScale` — the figure the annealing
temperature is derived from — is read off the **plain** roster: the top generator's energy at full
fill. Under any rule that rates a tile above the roster the moves the walk is judging are worth
more than that calibration assumes, so the walk runs colder than intended: up to ×1.67 under Tidal
and ×2.5 under Singularity. It is plausible that it costs something and nobody has measured how
much. It is left alone because the previous, *hotter* calibration was itself the bug the comment
above it records — scaling by total power made large islands accept ~23% of moves each costing 7%
of the layout, and the walk never climbed back — and because this repo does not move a tuning
constant on an argument. Settling it means the usual measurement: several seeds at a realistic
budget, on both a shore-heavy map under Tidal and a fragmented one under Singularity, against the
unchanged search. Don't change it blind, and don't assume it is fine because nothing fails.

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
sub-grid carries a copy indexed like `buildable`.

**The copy is translated by the window's own origin, and that is the half worth a test.** The mask
is read at `origY * originalWidth + origX`, and a window clamped against the board on both axes has
a pad origin of (0, 0), so the offset cancels and a mis-indexed read is right by accident — which
is every small hand-built case. On the shipped boards it is not: a mis-indexed copy was measured
against the correct mask at between 28 and 166 mismatched tiles per map, which under Tidal is that
many tiles rated at the wrong multiplier on the boards players actually solve, with nothing
failing. The fixtures pass no anomaly and could not see it, and neither could anything else in the
suite. `island.test.ts` now pins the mask on a board clamped against three edges, on a component
inset from two, and on every island of all eight shipped codes.

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
coolers — and returns rows with every measured field zero, leaving each building's two capacity
figures and nothing else. That is right for a search, which only wants power and is about to throw
the layout away.

**The two capacity figures are `baseValue` and `ratedValue`, and confusing them is silent.**
`baseValue` is the **authored** tier value and never moves, because a placement's tier is resolved
back out of it by matching the catalogue — report a scaled one and it matches a *higher* tier and
gets scaled a second time, which is wrong in the readout's ceilings, the `Lv.` chip and the tier
table of every share code at once. `ratedValue` is what the tile was actually rated for, which is
the figure every other number in the row was measured against; under a terrain bonus or a role
isolation the two differ by the multiplier. A consumer comparing a delivery against the wrong one
reads a full tile as a starved one or the reverse, which is exactly how the under-fed-reactor move
stopped firing. `ratedValue` lives on `SimPlacedBuilding` rather than on `PlacedBuilding`, so it
**does not cross the worker boundary**: it is the island's own units and means nothing to a caller
that does not hold its ratings.

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

The fixtures pin behaviour; the rest of `tests/` pins meaning. These are the ones worth knowing
about before changing anything in the search:

- **`goldenLayouts.test.ts`** — proven optima for islands of 3 to 9 tiles, each confirmed by
  exhaustive brute force rather than by running the solver and writing down what it said. **These
  numbers must never go down.** Each size is checked twice: once against the simulator, pinning
  the exact layout deterministically, and once against the search, which must reproduce it.
- **`anomalies.test.ts`**, **`scaling.test.ts`** and **`placementSearch.rating.test.ts`** — the
  rules, which the fixtures cannot reach at all because every fixture is solved under the base
  ones. Between them they pin each rule reaching the layout the search reports, the search running
  end to end under every one of them, the research-then-anomaly ordering and the re-derived waste
  down to the last bit, a report row's two capacity figures, the island rating ceiling that keeps
  the retarget stage alive, the no-op guards skipping rather than simulating on a rated tile,
  right-sizing a layout whose ratings come from its own shape, and that every building a seed
  writes is already rated for the tile it landed on. A rule that is threaded but never applied
  fails nothing on its own, so this is the layer that notices.
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

**A code states the rules it was found under, and so does the filename.** `codeFor` is the one
code writer all three paths go through and it always passes `blueprintRules`, so the app's preview
rates a CLI layout the way the run did rather than under the reader's own timeline — a
coast-hugging Tidal board would otherwise come back at roughly its baseline figure with nothing
saying why. The research table it writes is **empty rather than absent**, which is a different
claim and a true one: the CLI solves at full unlocks and no Time Lab, and there is no flag for one,
so "the author had no research" is exactly what it knows, where an absent section would mean "rules
unknown". `--anomaly` also tags the filename (`test_4_tidal_ascendancy.txt`) and every header names
the timeline, because a `solves/` directory or a session scrollback holding three timelines is
otherwise unreadable from the outside — the same argument `formatNumberForFilename` makes about the
power figure. The tag is the full id, so a filename pastes straight back into the flag that
produced it, and it is empty under `none`, so existing names are unchanged. `TEST_FILENAME_RE`
matches the optional tail, since that regex is what finds the previous ids: a tagged filename it
could not see would restart numbering at 1 and overwrite an untagged run.

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
