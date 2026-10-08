# CLAUDE.md — @reactor2/solver

Loaded when working under `packages/solver/`. The root `CLAUDE.md` holds the
project-wide rules; `docs/SOLVER.md` is the authority on how this package is
put together and `docs/game-logic.md` on the game's rules.

## The Time Lab: research and anomalies (engine side)

The app-side half — how `layoutState`, `configState`, `AnomalySelector` and
`App.svelte` hold and push these — is in `src/lib/state/CLAUDE.md`.

### Time Lab research

`PRESTIGE_UPGRADES` (`data/prestige.ts`) carries **three** of the game's eleven
researches: Absolute Zero (cooler cooling), Infinite Grid (generator and wind
turbine stats) and Stellar Forge (reactor heat). The other eight move research
income, research time, chronons, obstacle-removal, energy sale price and
building prices — all
decided _before_ the solver is handed a board, so none can change which layout
is best. The file names them so it is clear they were read and dismissed.

Three things bind:

- **Each is a uniform multiplier on the roles it names**, the same shape the
  stat anomalies turned out to have, so both go through
  `scaleEffectiveBuilding`. That is what keeps it from being free power: waste
  is re-derived as `snap(heat - energy)` from the pair that was just scaled, so
  a generator rated ×2 makes ×2 the waste and needs ×2 the cooling to stay
  online. The overheat threshold Infinite Grid also names is **not** the reason
  — it sizes a waste-heat _store_ rather than the waste itself, and a
  sustainable layout never fills it, so per `docs/game-logic.md` it is never the
  binding constraint and `EffectiveBuilding` does not model it at all.
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
  and it matches a _higher_ tier and gets scaled a second time. A generator at
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

**Stellar Forge does not cover wind turbines.** The game's `heat_producer`
category holds reactors _and_ direct producers, so "all Heat Producers" read
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
- **The figures are written once**, as the arguments of one builder per rule
  in `data/anomalies.ts`, and every card string is filled from them. Docs,
  comments and tests name them by field — `coolerMultiplier`, `multiplier`,
  `isolated`, `crowded` — and tests read them through `anomalyOfRule` in
  `tests/helpers.ts`. A rebalance keeps the old build as a `variantOf` entry
  (Tidal's pre-nerf figure is `tidal_ascendancy_legacy`), since a save keeps the
  figure it jumped in under; every Tidal measurement in these docs, and every
  test pinning an exact Tidal double, is of that frozen entry.
- `"none"` is an entry, not an absence, and `getAnomaly` is total: an id it does
  not know resolves to the baseline, because the id arrives off `localStorage`
  and the worker boundary.
- Every stat anomaly is a **uniform** scale on a building's three figures
  (`scaleEffectiveBuilding`), so a bonus is never free power — the cooling it
  needs grows with it. **Waste is derived rather than scaled**:
  `scaleEffectiveBuilding` recomputes `snapToAuthoredPrecision(heat - energy)`
  from the pair it just scaled, because that is the game's runtime getter and
  carrying the authored waste through the same multiply disagrees in the last
  digit, where the fixtures assert exactly. Only the two roles that _have_ waste
  derive one — `heat - energy` over a cooler or a reactor would turn its whole
  output into waste.

  **Research and anomaly arrive as two successive calls, in that order**, which
  is how the game applies them (the Time Lab in the SO getter, the anomaly in
  the runtime getter) and is not the same double as one combined factor:
  generator7's fourth tier under Infinite Grid level 4 (x1.7) then a crowded
  penalty differs in the last bit from one combined factor, and the order
  shows too — x1.25 then a shore bonus differs from the reverse.
  `scaling.test.ts` pins both, at two fixed factors of its own (`SHORE`,
  `CROWDED`) and against the shipped catalogue rather than round numbers — every divergence
  here is in the last bit, so a test on tidy figures passes under either
  reading.

- **Cryo Nexus pools across the whole board, so under it the board is one
  island.** The game's "island" is the map, so the components
  `splitGridIntoIslands` produces **do** interact — against the assumption the
  worker pool, the budget split, `IslandBest` and `variants.ts` all rest on. The
  answer is to stop producing them: `wholeBoardIsland` hands the board over
  entire, which makes the pool board-wide by construction and leaves every one
  of those assumptions true.

  It costs nothing in the rest of the simulation, because `runDistribution`
  already scopes its round budget and its repair to each connected component of
  the supplier/consumer graph — a finer partition than the island — so heat
  stays adjacency-bound. It is also what brings the unbuildable scraps in: every
  grass tile is on the one island, including the 21 tiles across the shipped
  maps that no decomposition keeps. `minIslandTiles` therefore has no Cryo case;
  there is nothing to apply a floor to.

  **The price is per-island parallelism** — one island is one pool task, so a
  board of two large landmasses searches on one core where it could use two. A
  small loss on the shipped maps, where one landmass already holds ~95% of the
  budget, and it buys the whole board-level problem for nothing: the alternative
  is describing each component by a frontier of power against net cooling
  contributed and combining those under one scalar budget.

  **The pool itself is in `simulateIsland` and needs no second code path.** It
  serves every source the same fraction of what it is owed, so a short pool
  leaves _all_ of them under their waste and the ordinary per-producer online
  test turns that into the board-wide all-or-nothing the rule describes. The
  `coolerMultiplier` is a uniform scale on the cooler role, applied through `ctx.rate` like
  any other multiplier, because the game applies it to `CoolerBuilding.
CoolingPerSec` — it is what a cooler is worth and what the game shows for it,
  not a charge levied at the pool.

  It is worth real power, and most on a fragmented board: map 7 at 25s goes
  271AC to 294AC, map 3 at 20s 139AC to 145AC, and map 1 — one landmass, already
  at 98% of its bound — is unchanged. The `coolerMultiplier` has to be earned
  back before any of that shows.

  **The seed is the one stage that branches on the rule.** Under a pool
  `constructSeed` builds every hub engine-first — a phantom cooler sizes the
  fit, so the neighbour slots all go to reactors — charges the cooling as a
  board-wide debt in each candidate's rank, reserves the tiles for it, and pays
  it off onto the least-connected free tiles, scraps first; the base seed spent
  a hub's best-connected tiles on coolers and never filled a scrap. The seed
  goes from ~76% of the bound to ~99% on maps 3, 7 and 8 and map 7 now returns
  its bound at 5s; `docs/SOLVER.md` has the tables.

  **The finished layout gathers its coolers** (`gatherPooledCoolers`, after
  right-sizing, on the primary and on its alternates). Power cannot see where a
  pooled cooler stands, so the walk leaves them in whatever gap a hub had. The
  pass moves each one nearer the densest patch of coolers. Empty scraps on
  landmasses with no producer count as nearest of all. A move onto an empty
  tile is exact. A swap with a producer is re-simulated and kept only if power,
  every producer and the upgrade plan all hold, so the pass cannot cost a watt.
  It is capped at 150ms for the primary and 150ms shared across the
  alternates; on the shipped maps one layout takes 15-110ms. Map 1 goes from
  five cooler clusters to one.

  **Before the sweep, hubs leave the smaller landmasses**
  (`evacuateMinorLandmasses`). One tile at a time cannot move a hub: a
  generator taken from its reactors loses power at every step, so a hub on a
  second landmass kept its coolers there. Each smaller landmass that holds
  producers, smallest first, has all of them moved onto the landmass holding
  the most. A greedy placement puts them on that landmass's cooler or empty
  tiles, and each displaced cooler crosses to the tile its producer left, so
  composition and pool are unchanged. A swap descent over the main landmass
  then restores power. The move is kept only on the same three tests as a swap,
  and the emptied landmass then fills with coolers like any scrap. It has its
  own 1s cap on top of the sweep's (`EVACUATE_BUDGET_MS`), sized for a phone; a
  15-producer hub takes about 170ms on a desktop. On the eight maps with
  obstacles cleared it brings seven to a single producing landmass at the same
  power. Shadowspire keeps two, because its 29-producer second landmass does
  not fit in the main one's coolers.

- **Off the board counts as water**, which is a fact about our data rather than
  about the game: the game has one global map with open water between islands,
  and our eight boards are rectangles cut out of it, so the water past an edge is
  real and simply not in the blueprint. It barely moves the shipped maps (+4 on
  island3, +2 on island7, the rest unchanged) and is the whole of the anomaly on
  a custom island, whose blank 10x10 of grass has no water in it at all.

  `IslandSubGrid`'s one-tile padding is **clamped to the board**, so it cannot
  tell an off-board neighbour from the window's own edge — which is why
  `computeWaterAdjacency` runs on the full grid before the split and each
  sub-grid carries a `waterAdjacent` mask indexed like `buildable`.

- **`ANOMALIES` is transcribed by hand from the same extractor's output**, which
  emits an anomaly record alongside the roster and drops the icons into
  `public/icons/anomaly_<id>.webp`. Unlike `BUILDING_TABLE`, **nothing splices
  this table** — the extractor writes its record and stops — so a new anomaly is
  brought across by hand. The game's `{0}`-templated strings land in a builder
  per rule that fills them from the same arguments the rule fields take, so the
  wording and the numbers the solver runs on cannot disagree.

  **What catches a half-finished job is the codec's byte maps.** They are keyed
  on the closed id unions — `Record<AnomalyId, number>` and `PrestigeUpgradeId`,
  the same shape and for the same reason — so an anomaly or a research added to
  its table without a byte here fails to compile. Both failures are otherwise
  silent in both directions: an anomaly would be written as 0 and a research
  dropped altogether, and the recipient rates the board under rules its author
  never ran with a perfectly confident figure printed for it. A compile error is
  the only check that arrives before the code is shared. The encode-side
  `?? none` fallback survives that and now covers only one case — a string that
  is not an anomaly id at all, arriving off `localStorage` or the worker
  boundary — which is the same total reading `getAnomaly` makes. Decode stays
  tolerant: an unknown byte reads as no anomaly.

- **All four entries are implemented**, `none` being the one with nothing to do
  — it is an entry rather than an absence. The anomaly is threaded the whole way
  — `SolveOptions.anomalyId` / `SolveRunOptions.anomalyId`, the worker request,
  and `IslandContext.anomaly` — and each rule is resolved wherever its inputs
  are settled: a terrain bonus per tile when the context is built, a role
  isolation per layout inside `simulateIsland`, and a shared cooling pool in the
  decomposition, before there is an island at all.

  **Singularity is resolved per layout, in `simulateIsland`, and it has to be.**
  A generator's rating is a function of what its neighbours _are_, so placing
  one re-rates up to eight other tiles — it cannot be folded into a tile like a
  terrain bonus, and it cannot be settled at the write. `simulateIsland` copies
  the layout into `ctx.ratedLayout` (held by the island, not allocated per
  call), re-rates the affected role's tiles, and reads its figures through that.
  The neighbour scan reads the _original_ placement, since the test is on what a
  neighbour is and no rating changes that — so there is no order to get right.

  **The bonus is on a capacity, which is why the rule is close to power-neutral
  at full unlocks.** `isolated` scales a generator's _intake_, and a generator
  fed by the reactors it already had simply fills to `1/isolated` and produces
  exactly what it did before; the bonus is worth something only alongside more adjacent reactor
  heat. The penalty is real and avoidable, so the search's job under this
  anomaly is mostly to keep generators apart. Map 3 at 15s over three seeds:
  1.420e23 at best under both, where the one baseline layout whose generators
  touch re-rates to 1.182e23 — so the search recovers the whole penalty and
  finds no gain. Map 1 comes back identical to three significant figures either
  way.

  **On a generator-bound roster it is not neutral, and the count is what the
  search gets wrong.** `targetCompositions` is the one stage that decides _what_
  to build, and how many generators are worth their tile depends on what a
  generator is worth — two numbers under this rule, neither of them in the pool
  the stage draws on (`rateRole` is the identity here, since which one a tile
  gets is the layout's business). With everything unlocked but generator7 at
  tier 1, Gale Hills plateaued at 43.2-45.2AC from 5s to **150s**. Sizing at the
  bonus alone does not fix it — it asks for 20 generators where the island can
  keep 15 apart. `generatorCapacityTable` builds `island.ts`'s own
  `generatorCapacities` over `isolationRoom` — the same table the bound runs on,
  imported rather than restated — and the target asks for 16: the mean of ten
  runs goes 44.6AC to **46.2AC**, against a best of 49.8AC (fifteen generators,
  every one isolated) that either reaches only occasionally. It pays most on
  the largest boards (+12-14% on maps 7 and 8) and costs 1-4% on maps 2, 5 and
  6, over three seeds — a net gain, not a uniform one.
  `islandRatingCeiling` takes `sizedByIsolation` so a target sized through the
  table is not scaled by the rating a second time. Null under every other rule,
  so the fixtures reproduce byte for byte.

  **A terrain bonus is resolved per tile, once, when the context is built.**
  Nothing about a layout can change which tiles qualify, so `terrainScales`
  settles it at construction and `ctx.rate(tile, building)` is a lookup — which
  is why the rule costs the search nothing. `uniformRating` is the flag that
  says `rate` is the **identity** — `ctx.rate(t, b) === b` for every tile and
  every building — so a stage may skip the call entirely, and it therefore has
  to promise the whole of `rate` rather than only its per-tile half: `rate`
  carries a per-role factor beside its per-tile one, so the flag is false under
  a terrain bonus _and_ under a cooling pool's `coolerMultiplier`, and true under `none` and
  under Singularity, which `rate` does not answer at all.

  It is called where a building is **written onto a tile**, never where its
  figures are read: a step of the walk writes one or two tiles and then
  simulates the island, which reads every occupied tile, so the write is some
  25x less work and `simulateIsland` stays untouched. `put()` in
  `placementSearch.ts` is the only way a building enters a placement, so the
  bonus cannot be missed at one of three dozen sites — and a miss would be
  silent, since the layout would simply be worth less than it is.

  **`rate` is idempotent**, which is what makes that safe: the search swaps
  buildings between tiles and restores them when a move is rejected, handing
  back objects it was already given. Without it a restore would scale a scaled
  building and the layout would quietly be worth 2.8x.

  **A placement holds rated buildings, so anything compared against one has to
  be in the tile's units.** The roster is what every stage reaches for — the
  candidate pools, a composition's score, the downgrade ladder — and none of
  those figures mean what is on the board once a rule rates a tile above or
  below the roster. Four comparisons turn on it and each fails silently: the
  no-op guards (`ratedFor`, so a move that would write a tile what it already
  holds is skipped rather than simulated for a delta of zero), the under-fed
  reactor test (`isUnderFed`, against `ratedValue` — against the authored value
  it only fires below 1/k fill and stops firing on almost everything it exists
  for), the composition retarget's gate (`targetCanBeat`, which scales the
  target by an island-wide `islandRatingCeiling`; the gate is a `break`, so
  getting it wrong throws the whole stage away, and on island3 under Tidal it
  never ran at any realistic budget), and right-sizing (`ratedCapacity`, which
  has to ask `rateIsolated` rather than `rate`, or an isolated generator is
  never offered the smaller tier that covers what it actually absorbs).
  `docs/SOLVER.md` has the measurements; the retarget fix restored the stage
  from 1 of 3 targets attempted to 3 of 3 with the power difference inside
  run-to-run noise, so it buys back a stage rather than a number.

  **A bonus is genuinely not free power here.** A shore generator makes
  `multiplier` times the waste while an inland cooler still covers x1, so a cluster straddling the
  shoreline goes offline — a layout optimised under the base rules scores
  _lower_ re-rated under Tidal. The search has to keep a cluster on one side of
  the coast, which is a harder problem than the uniform one. On Magma Rift at
  20s, `--anomaly tidal_ascendancy_legacy` returns 181AC against the baseline's 142AC.
  The seeding heuristics pick candidates by unscaled roster figures. Two ways of
  making them tile-aware were measured and **neither paid for itself**: ranking
  a candidate hub by its fit times the tile's multiplier, and restricting a
  hub's tiles to one class so it cannot straddle the coast. Both came back at or
  below the unchanged search over three seeds. `powerPerTile` orders a greedy
  claim that later stages rewrite, so skewing it toward the coast mostly moves
  which tiles get claimed first. Don't re-attempt either without a wider
  measurement than three seeds at 15s.

  **`estimateTotalMaxPower` takes the anomaly, and every rule of it.** Any rule
  that rates a tile above the roster makes a bound computed on the plain roster
  one a real layout walks past, and "no layout may ever beat it" is an invariant
  the rest of the solver is entitled to assume: Magma Rift reported 119.9%
  layout efficiency before the terrain case existed, and the generator-bound
  3x3 in `island.test.ts` reads 267% against a bound that ignores Singularity.
  A rule that scales a whole role goes **into the roster** the bound is run on
  (`roleRatedRoster`: coolers by `coolerMultiplier` under a pool, generators
  by `isolated` under Singularity), where the bound is exact in it; scaling the LP's result by the
  largest factor instead rates reactors and coolers up too and would leave the
  Singularity bound 3.8x the tight one, so a near-optimal layout reads 25%. A
  rule that scales a _tile_ splits the island's tile budget by class
  (`estimateIslandBound`, `estimateMixedIslandMaxPower`): a shore building is
  worth the shore-scaled roster, an inland one the plain roster, and both pay
  into the one heat and the one cooling total, since the bound relaxes
  adjacency away. Rating the whole island at its best tile (`islandMaxScale`,
  kept as the ceiling) had every inland tile standing on the coast, and the
  coast is 36-44% of the shipped grass — a quarter loose, with Magma Rift's
  best 15s layout reading 72% of it against 93% now. The engine side is
  enumerated integer and the producer/cooler remainder is a fractional
  knapsack, which is what keeps it under 10ms; a mixed island takes the
  smaller of that and the whole-island figure — both are bounds, so the
  minimum is, and a two-tile island's fractional cooler cannot make it looser
  than it was. An all-shore island is the plain LP at the multiplier, bit for
  bit; an all-inland one the plain LP. Scaling a result is sound because the
  estimate is positively homogeneous of degree 1 in the roster's figures, and
  that is still what the ceiling rests on where the mask cannot say which
  tiles it reaches.

  **The one adjacency the bound does not relax away is `neighbourHeatCap`.**
  Heat crosses a tile boundary and nothing else, so a generator's intake is
  whatever the reactors beside it make, and the all-or-nothing cooling rule
  wants coolers beside it too — out of the same eight tiles. So
  `estimateIslandMaxPower` runs on `min(gVal, 8 / (1 / rVal + wasteRatio /
cVal))`, and the cooler term goes under a pool, where cooling reaches the
  whole island. The cap is homogeneous like the LP, so a rule that scales
  everything at once can never make it bite; a rule that scales **one role**
  is what it takes, and Singularity's shipped `isolated` puts the top generator at 290% of
  it — without the cap the bound sits 6-9% above anything the board allows,
  reading 83-87% efficiency for layouts that are not 83-87% of anything. With
  it the maps read 89.4-95.0%, and the base, Cryo and Tidal figures do not move
  a digit.

  **The second half of that is `isolationRoom`: how many generators an island
  can keep apart.** Isolated generators are pairwise non-adjacent, so they are
  an independent set in the 8-neighbour graph — and on a roster where the
  generators are the short side, the split wants a third of the island to be
  one. Maximum independent set is NP-hard, so the ceiling is read off a 2x2
  block partition: four mutually adjacent tiles, so one isolated generator
  between them and no other generator in that block at all. `crowdedRatedRoster`
  is the pair to `roleRatedRoster` that lets `generatorCapacities` bend there
  rather than running the bonus out to the whole island. Only the generator
  role — it is the one figure the LP counts per tile — and every other role
  keeps the better rating alone, which stays sound and loose.

  **Both switches are exhaustive with no `default`**, so a fifth rule shape
  fails to typecheck rather than silently returning 1 or the plain roster —
  which is precisely what `role_isolation` did while a layout beat the bound by
  64%. The roster allows both variants of an isolation multiplier, since which
  one a tile gets is a function of the layout and a search free to keep
  generators apart rates every one of them at the bonus; and under a terrain
  list the tile half errs high wherever the shore mask cannot decide the
  question, which is any list that is not exactly `["water"]`.

  The anomaly crosses the worker boundary **as an id**, resolved again on the
  far side, so the message stays a string rather than a table entry that has to
  survive structured cloning. `replayIslandDeterministic` passes none and never
  will: the fixtures are a determinism harness for the search, and a rule change
  is a different question asked of it.

**Three Time Lab upgrades scale building stats too**, and they are not anomalies:
they are bought with Chronons, survive a Time Jump, and stack with whatever
anomaly is running — **multiplicatively**, so a generator under Singularity
Isolation with Infinite Grid maxed is rated x8. The extractor's record covers
all eleven Time Lab upgrades; the three a layout can see are **Stellar Forge**
(every heat producer, so reactors), **Infinite Grid** (generators _and_ wind
turbines), and **Absolute Zero** (every cooler), each five levels of
`BonusPercentage`. Absolute Zero and Infinite Grid share one curve, 0.1 to 1.0;
Stellar Forge a shallower one, 0.1 to 0.5. That field is a fraction rather than
a percent -- the same field is 0.05 on Chronon Reactor, which the game shows as
+5% -- so the levels are worth x1.1 to x2 (Absolute Zero, Infinite Grid) and
x1.1 to x1.5 (Stellar Forge). Like an anomaly's, the scale is uniform, so the
cooling a boosted producer needs grows with it. Their badges ship as
`public/icons/prestige_<id>.webp`.

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
  it began with the width instead, so the two are told apart by _value_ — a
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
×2-cooling timeline is not the board a reader without that research would get.

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

**The CLI writes share codes, so it states rules too.** `codeFor` is the one code
writer all three of its paths go through and it always passes
`blueprintRules(anomalyId, {})` — an **empty** research table, which is a
statement and a true one rather than an omission: the CLI solves at full unlocks
and no Time Lab, and there is no flag for one, so "the author had no research" is
exactly what it knows, where leaving the section out would say "rules unknown"
and hand the reader their own timeline. `--anomaly` also tags the output filename
and every header names it (`docs/SOLVER.md` has the reasoning); `TEST_FILENAME_RE`
had to widen to match the tag, because that regex is what finds the previous ids
and a tagged file it could not see would restart numbering at 1 and overwrite an
untagged run.

**Two consequences of the version byte are worth knowing before a release, and
neither is fixable in code.**

- **It is a one-way break.** A reader written before the byte existed takes
  `data[0]` as the width, so a new code's version byte of `1` makes a 13x13 board
  decode as 1x13 — and the truncation guard passes, so nothing throws and a board
  simply comes back wrong. That reaches a stale browser tab, a recipient on an
  older deploy, and `localStorage` written by the new build and read by the old.
  The other direction is the one that is right: a new reader **refuses** a version
  it does not know rather than guessing, because the tiles are positional and a
  misread produces a different board rather than an error.
- **Every stored solve is invalidated once, on upgrade.** `blueprintKey` now
  includes the version byte and `solveSignature` gained the anomaly and the
  research, so a record written before either stops matching. `restore()` clears
  on a mismatch and says nothing, so a player who had a five-minute run saved per
  island loses all of them at this release with no message. That is the correct
  behaviour for a signature that cannot vouch for the board — but it happens once
  and it happens silently, which is worth knowing rather than discovering.

**A share code has a second form: a link.** `encoding/shareLink.ts` owns the
`?bp=` parameter's name so nothing else knows it, builds the URL from the live
`location` (this app ships to a GitHub Pages subpath _and_ to localhost, so a
configured base would be wrong in one), and strips the parameter on the way out
via `replaceState`. The dialog offers both forms and **copies neither on open**:
there is no way to guess which the user came for, and taking their clipboard to
hand them the wrong one destroys what was on it. Opening a link is preview mode —
see the state layer.

### History: the retired Python reference

Until recently the shipped solver was a line-for-line port of a Python reference
in `py_solver/`, which was upstream. That tree is **retired** — the port had
become about 9x faster at the thing that decides solve quality, since every
stage is wall-clock budgeted and V8 simply fits more annealing steps into the
same 30 seconds. Its whole test suite and its CLI's argument surface moved here
with it. Comments that mention "the retired Python reference" are explaining why
something is shaped the way it is, not pointing at code you can go and read.

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

It answers two questions and both go through one `layoutFor`: what every building
is doing (`simulatePlacedBuildings`) and what one of them was rated for
(`ratedPlacementAt`, which the readout's ceilings come from). A second copy of
that loop is precisely how the two would come to rate the same board differently.
The tiers it resolves are interned per (definition, tier value), because
`effectiveAtValue` mints a fresh record every call while the context's rating memo is
keyed on object identity — a guaranteed miss on a context kept alive for the
whole session, growing two dead entries per placement change.

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

**Under an upgrade plan (`SolveOptions.upgradePlan`) "stable" means stable at
every step.** Every gate that admits a layout also asks `planHolds`, and the
first plan roster must be today's, because the search seeds from it too — see
`docs/SOLVER.md`. Without a plan the check returns at once and the fixtures do
not move.

### Verifying a solver change

Start with `npm test`. Four parts of it are what actually catch a regression:

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
- **The anomaly suite** — `tests/anomalies.test.ts`, `tests/scaling.test.ts`,
  `tests/placementSearch.rating.test.ts` and the water-adjacency block in
  `tests/island.test.ts` — is the only thing that can catch a rule regression at
  all, because **every fixture is solved under the base rules**. Between them
  they pin each rule reaching the layout the search reports and the search
  running end to end under every one of them; the research-then-anomaly ordering
  and the waste re-derived at each step, down to the last bit; a report row's two
  capacity figures; the rating ceiling that keeps the composition retarget alive;
  the no-op guards skipping rather than simulating on a rated tile; right-sizing
  a layout whose ratings come from its own shape; that every building a seed
  writes is already rated for the tile it landed on; and that each island's
  `waterAdjacent` mask is translated by its window's own origin, checked against
  all eight shipped codes. That last one is the shape of the whole problem: a
  mis-indexed read passed the **entire** suite while mismatching between 28 and
  166 tiles per map, because a rule that is threaded but misapplied produces a
  layout that is merely worth less than it says.

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

**For a change to what a real run finds, use the survey before and after.** It
solves every map (obstacles cleared) under every anomaly, island by island:

```bash
npm run survey -- --runs 5 --json solves/base.json     # on the old code
npm run survey -- --runs 5 --compare solves/base.json  # on the new
```

`--compare` judges each island on the mean of its runs, against a noise band
the width of the wider side's run spread, and exits 1 if any island fell below
it. Same `--time`, `--runs` and `--seed` on both sides, same machine, same load —
it warns if the first three differ. Expect about ±0.8% per map at 15s × 5 runs,
so a gain smaller than that needs more runs to show; "no island got worse" is
the claim it can make at any size.
