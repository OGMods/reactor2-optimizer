import { cheapestFirst } from "../data/buildingPrices";
import { AlternateCollector, isDistinctLayout, powerTies } from "./alternates";
import { EPS } from "./constants";
import { buildIslandContext, type IslandContext } from "./context";
import { Pacer } from "./pacer";
import { randomSeed, Rng } from "./rng";
import type {
  AnomalyDefinition,
  EffectiveBuilding,
  IslandLayout,
  IslandSubGrid,
  PlacedBuilding,
  Placement,
  SearchHooks,
} from "./types";
import { hillClimb } from "./search/anneal";
import {
  arrangeComposition,
  generatorCapacityTable,
  islandRatingCeiling,
  targetCanBeat,
  targetCompositions,
} from "./search/composition";
import { EMPTY_GATHER_BUDGET_MS, gatherEmptyTiles } from "./search/emptyTiles";
import {
  emptyPlacement,
  isDirectProducer,
  isReactor,
  put,
  toPlacedBuildings,
} from "./search/placement";
import {
  EVACUATE_BUDGET_MS,
  GATHER_BUDGET_MS,
  gatherPooledCoolers,
} from "./search/pooledCoolers";
import {
  greedyPolish,
  polishCandidates,
  pruneDeadWeight,
} from "./search/repair";
import {
  DOWNGRADE_ROLES,
  downgradeOversized,
  downgradeTiers,
  tileLoad,
} from "./search/rightSize";
import { constructMultiStartSeed } from "./search/seed";
import {
  isUnderFed,
  offlineProducers,
  stabilize,
  upgradePlans,
} from "./search/stability";

// The stages live in `./search/`, one file each; this module is still the one
// entry point, so what it exported before the split it exports now.
export { downgradeOversized } from "./search/rightSize";

/**
 * Placement search for a single island:
 *
 *   seed -> repair -> composition retarget -> (annealing -> repair)* -> pruning
 *     -> right-sizing
 *
 * The `annealing -> repair` pair repeats until the deadline. Repair's slice is
 * reserved before the layout it will run on exists, and on a post-anneal layout
 * it almost always converges in one fruitless sweep, so whatever it hands back
 * becomes another short walk rather than idle time at the end of the budget.
 *
 * Seed construction lays out self-sufficient "hubs" — one generator plus
 * exactly the reactors and coolers it needs on its own. That is a good starting
 * shape but a systematically incomplete one: real layouts do better by letting
 * neighbouring hubs SHARE, one cooler absorbing waste from two generators or
 * one reactor feeding two, which frees tiles for more producers. Nothing in
 * seed construction can express that, and on the 67-tile map 1 island it caps
 * out 7% below the best known layout.
 *
 * The two stages around it exist to cover that blind spot from different sides:
 *
 * - `greedyPolish` is steepest ascent over single-tile changes. Annealing alone
 *   was supposed to find these, and does on small islands, but on a large
 *   packed island almost every single-tile change costs several percent, so the
 *   walk drifts downhill and rarely climbs back — measured there, only 1
 *   evaluation in 26,000 beat its own starting layout while 20 stable improving
 *   moves sat a single move away.
 * - `targetCompositions` / `arrangeComposition` attack the other half. Deciding
 *   WHAT to build is a counting problem with an exact answer, so it is computed
 *   directly rather than searched for; the search is then left with the
 *   genuinely hard part, which is where to put it.
 *
 * Annealing keeps its place between them for the moves neither can make: it can
 * cross a barrier that no single change improves upon.
 *
 * Right-sizing is the odd one out: it is not part of the search and cannot find
 * a better layout. It runs once the layout is final and swaps each building for
 * the smallest tier that still carries the load that layout gives it, because
 * power is blind to the difference between a cooler running flat out and one
 * running at 2% — and the player is not.
 *
 * **The stability rule.** A solved layout must be fully stable: every generator
 * and direct producer it places has to actually run. A layout can score higher
 * by parking reactor heat in a generator that is never cooled — nothing then
 * has to cool that share of the waste — and it is still the wrong answer, so
 * only stable layouts are ever recorded as best. "Pruning never reduces power"
 * is NOT a valid invariant here; "the returned layout is stable" is.
 *
 * **Under an upgrade plan "stable" means stable at every step.** The search
 * scores at the plan's target, but every gate that admits a layout — the best
 * record, repair, the composition swaps, pruning, right-sizing, the tie
 * shortlist and `stabilize` itself — also asks `planHolds`, so a layout that
 * overheats at any tier on the way is never kept. Without a plan that call
 * returns at once and nothing here changes.
 */

/** Share of the time budget reserved for repair before and after annealing. */
const POLISH_SHARE = 0.3;
/**
 * The least time the plain-sized seed's repair is given under a role
 * isolation, when the sized seed's own repair took less (see `solveIsland`).
 * A 20-tile island repairs in 3ms, and a cap that tight would be timer noise.
 */
const PLAIN_SEED_POLISH_MIN_MS = 20;

/** Share of the time budget spent arranging those compositions. */
const COMPOSITION_SHARE = 0.2;

/**
 * The closing repair is reserved a share of the budget up front, then handed
 * back whatever it does not use (see `solveIsland`). These bound the handback:
 * the repair is left twice its measured cost as headroom, but never more than
 * half of what is left — on a big island one sweep costs seconds, and reserving
 * twice that would strand more time than it protects. A reclaimed round shorter
 * than the floor is not worth its own setup.
 */
const RECLAIM_POLISH_MARGIN = 2.0;
const RECLAIM_MAX_RESERVE_FRACTION = 0.5;
const RECLAIM_MIN_ROUND_SHARE = 0.01;
const RECLAIM_MIN_ROUND_MS = 50;

export interface IslandSolution extends IslandLayout {
  /**
   * Other layouts this island's search finished tied with, best-power-first
   * and never including the primary. Empty when the search found no second
   * arrangement at the same power. See `alternates.ts` — they are gathered by
   * watching the walk, and every one of them is stable and pruned exactly as
   * the primary is.
   */
  alternates?: IslandLayout[];
}

/**
 * Turns the walk's shortlist into finished alternates.
 *
 * Every collected layout goes through the same closing prune the primary does,
 * because an alternate the user can pick has to be the same *kind* of answer:
 * stable, with nothing dead left on the board. Pruning can move a layout's
 * power, so anything that no longer ties afterwards is dropped rather than
 * offered as an equal — and so is anything that pruned down to the primary's
 * own shape, which is not an alternative to anything.
 *
 * They are right-sized the same way too, and for a reason the primary does not
 * have: the shortlist exists so the player can compare layouts that tie on
 * power, and two entries agreeing on power while disagreeing on cost would make
 * that comparison meaningless. It also collapses entries that differed only in
 * an oversized tier, which were never two boards to choose between.
 *
 * The distance rule is re-applied here rather than trusted from the collector,
 * because both of those passes rewrite the board: pruning and right-sizing can
 * pull two layouts that were `MIN_ALTERNATE_DISTANCE` apart during the walk
 * onto the same handful of tiles. This is the gate that actually holds — it is
 * the last place the layouts change shape.
 */
async function finalizeAlternates(
  collector: AlternateCollector,
  primaryRows: PlacedBuilding[],
  primaryPower: number,
  effectiveBuildings: EffectiveBuilding[],
  ctx: IslandContext,
  pacer: Pacer,
): Promise<IslandLayout[]> {
  const kept: PlacedBuilding[][] = [primaryRows];
  const out: IslandLayout[] = [];
  // One gathering budget for the whole shortlist rather than one each, so a
  // long shortlist cannot add a second to the run. An alternate the deadline
  // cuts short is still valid, only less gathered.
  const gatherDeadlineMs =
    performance.now() + EVACUATE_BUDGET_MS + GATHER_BUDGET_MS;
  // And one for the holes, counted in time actually spent: the coolers' pass
  // is a no-op under every rule but a pool, and its unused budget is not this
  // one's to take.
  let emptyLeftMs = EMPTY_GATHER_BUDGET_MS;

  for (const layout of collector.layouts()) {
    // This runs after the search's deadline, and each alternate is a few
    // hundred simulations — up to a second under a cooling pool — so come up
    // for air between them: a STOP that arrives here ends the shortlist where
    // it stands rather than waiting for ten more layouts to be finished.
    const now = performance.now();
    if (pacer.due(now)) {
      await pacer.pump(now);
      if (pacer.stopRequested) break;
    }

    const pruned = pruneDeadWeight(layout, ctx);
    const downsized = downgradeOversized(
      pruned.rows,
      pruned.power,
      effectiveBuildings,
      ctx,
    );
    const sized = gatherPooledCoolers(
      downsized.rows,
      downsized.power,
      effectiveBuildings,
      ctx,
      gatherDeadlineMs,
    );
    const emptyStartedMs = performance.now();
    const tidied = gatherEmptyTiles(
      sized.rows,
      sized.power,
      effectiveBuildings,
      ctx,
      emptyStartedMs + emptyLeftMs,
    );
    emptyLeftMs -= performance.now() - emptyStartedMs;
    if (!powerTies(tidied.power, primaryPower)) continue;

    const rows = toPlacedBuildings(tidied.rows);
    if (!isDistinctLayout(rows, kept)) continue;
    kept.push(rows);
    out.push({ placements: rows, powerOutput: tidied.power });
  }

  return out;
}

/**
 * Deterministic replay of `solveIsland`'s reproducible stages, for the golden
 * fixture harness. Not used in production.
 *
 * `solveIsland` is wall-clock budgeted at every stage, so a fixed seed narrows
 * run-to-run variance without eliminating it — it can never reproduce a golden
 * fixture. This runs the subset that CAN be replayed step-for-step: seed
 * construction, `hillClimb` driven by `maxSteps` rather than a deadline, then
 * pruning. Every deadline handed to that path is set far enough out that it
 * cannot fire, so step count alone decides where the walk stops.
 *
 * The composition-retarget and greedy-polish stages are deliberately omitted:
 * they are deadline loops with no step cap, so there is no deterministic way to
 * replay them. `scripts/exportFixtures.ts` writes the fixtures through this
 * same function, so the two cannot disagree about which stages ran.
 */
export async function replayIslandDeterministic(
  island: IslandSubGrid,
  effectiveBuildings: EffectiveBuilding[],
  rngSeed: number,
  maxSteps: number,
): Promise<IslandSolution> {
  // No anomaly, and never one: the fixtures are a determinism harness for the
  // search itself, and a rule change is a different question asked of it.
  const ctx = buildIslandContext(
    island.grid,
    island.buildable,
    undefined,
    island.waterAdjacent,
  );
  if (ctx.n === 0) return { placements: [], powerOutput: 0.0 };

  const reactors = effectiveBuildings
    .filter(isReactor)
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const generators = effectiveBuildings
    .filter((b) => b.type === "generator")
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const coolers = effectiveBuildings
    .filter((b) => b.type === "cooler")
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const directProducers = effectiveBuildings
    .filter(isDirectProducer)
    .sort((a, b) => b.energy - a.energy);

  const canHub = reactors.length > 0 && generators.length > 0;
  const canDp = directProducers.length > 0;
  if (coolers.length === 0 || !(canHub || canDp)) {
    return { placements: [], powerOutput: 0.0 };
  }

  // Far enough out that no deadline can fire: step count alone stops the walk.
  const unreachableMs = 1e9;
  const pacer = new Pacer();

  const seed = constructMultiStartSeed(
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    performance.now() + unreachableMs,
  );

  const placement = await hillClimb(
    seed,
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    unreachableMs,
    new Rng(rngSeed),
    pacer,
    maxSteps,
  );

  const pruned = pruneDeadWeight(placement, ctx);
  return {
    placements: toPlacedBuildings(pruned.rows),
    powerOutput: pruned.power,
  };
}

/**
 * How much one reactor tier is worth over the one below it. Every reactor in
 * the catalogue steps by this factor, give or take the authored rounding, so
 * dividing by it is "one tier down" without a second lookup into the table.
 */
const TIER_STEP = 1.25;

/**
 * Solves one island.
 *
 * `rngSeed` fixes the random stream of the annealing walk. Same seed, same move
 * sequence — but stage deadlines are wall-clock, so where each stage stops (and
 * the temperature at a given step) still varies slightly between runs; seeding
 * narrows run-to-run variance rather than eliminating it. Omitting it draws a
 * fresh seed, preserving the stochastic default.
 */
export async function solveIsland(
  island: IslandSubGrid,
  effectiveBuildings: EffectiveBuilding[],
  timeBudgetS: number,
  hooks?: SearchHooks,
  rngSeed?: number,
  anomaly?: AnomalyDefinition,
  upgradeSteps?: EffectiveBuilding[][],
): Promise<IslandSolution> {
  const ctx = buildIslandContext(
    island.grid,
    island.buildable,
    anomaly,
    island.waterAdjacent,
  );
  if (ctx.n === 0) return { placements: [], powerOutput: 0.0 };
  // The rosters the layout must also run under — see `UpgradePlan`. The search
  // still scores at `effectiveBuildings`; these only narrow what it may keep.
  // `upgradeSteps[0]` is today's roster, which the seed below relies on.
  if (upgradeSteps !== undefined && upgradeSteps.length > 0) {
    upgradePlans.set(ctx, {
      steps: upgradeSteps.map(
        (roster) => new Map(roster.map((b) => [b.id, b])),
      ),
      buffer: emptyPlacement(ctx.n),
    });
  }

  // The pools every stage draws on, in the units the board will hold: a rule
  // that scales a whole role (a cooling pool's `coolerMultiplier`) is folded in here, so the
  // stages that count from the roster rather than place on a tile count the
  // right figure. `rate` is idempotent, so a pool entry that already carries
  // its role's rating is handed straight back at the write.
  const pool = (b: EffectiveBuilding) => ctx.rateRole(b);
  const reactors = effectiveBuildings
    .filter(isReactor)
    .map(pool)
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const generators = effectiveBuildings
    .filter((b) => b.type === "generator")
    .map(pool)
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const coolers = effectiveBuildings
    .filter((b) => b.type === "cooler")
    .map(pool)
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const directProducers = effectiveBuildings
    .filter(isDirectProducer)
    .map(pool)
    .sort((a, b) => b.energy - a.energy);

  const canHub = reactors.length > 0 && generators.length > 0;
  const canDp = directProducers.length > 0;
  if (coolers.length === 0 || !(canHub || canDp)) {
    return { placements: [], powerOutput: 0.0 };
  }

  const pacer = new Pacer(hooks);
  // Watches the walk for layouts that tie its best. Passive — see
  // `alternates.ts`; nothing it holds can change what the search does.
  const collector = new AlternateCollector();
  const timeBudgetMs = timeBudgetS * 1000;
  const deadlineMs = performance.now() + timeBudgetMs;

  let seed = constructMultiStartSeed(
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    deadlineMs,
  );

  // A seed built from a roster other than the one being scored, rewritten in
  // the scored roster's buildings by id, replaces the seed when it runs better.
  const targetById = new Map(effectiveBuildings.map((b) => [b.id, b]));
  const adoptIfBetter = (altSeed: Placement) => {
    const remapped = emptyPlacement(ctx.n);
    for (let t = 0; t < ctx.n; t++) {
      const b = altSeed[t];
      const target = b === null ? undefined : targetById.get(b.id);
      if (target !== undefined) put(remapped, ctx, t, target);
    }
    if (stabilize(remapped, ctx).power > stabilize(seed, ctx).power) {
      seed = remapped;
    }
  };

  // Under a plan, a seed built from the target roster is sized for buildings
  // the player does not have yet: fewer coolers than today's tiers need, so
  // stabilizing it strips it bare — and nothing downstream puts the cooling
  // back, since a cooler that only today needs never raises target power. So
  // seed from the first step (today's tiers) as well, written in target
  // buildings, and start from whichever runs better across the plan.
  //
  // Under a terrain bonus without a plan, seed as well from the roster with
  // its top reactor one tier down: the shore multiplies a hub's heat, so a
  // seed sized for the full reactor is short of cooling there, the same way a
  // target-sized seed is under a plan. See `docs/SOLVER.md`.
  const plan = upgradePlans.get(ctx);
  if (plan !== undefined) {
    const today = plan.steps[0];
    const byRole = (type: string, key: "effectiveValue" | "energy") =>
      [...today.values()]
        .filter((b) => b.type === type)
        .map(pool)
        .sort((a, b) => b[key] - a[key]);
    adoptIfBetter(
      constructMultiStartSeed(
        ctx,
        byRole("reactor", "effectiveValue"),
        byRole("generator", "effectiveValue"),
        byRole("cooler", "effectiveValue"),
        byRole("direct_producer", "energy"),
        deadlineMs,
      ),
    );
  } else if (
    ctx.anomaly.rule === "terrain_affinity" &&
    !ctx.uniformRating &&
    reactors.length > 0
  ) {
    const top = reactors[0];
    const weaker = reactors
      .map((b) =>
        b === top ? { ...b, effectiveValue: b.effectiveValue / TIER_STEP } : b,
      )
      .sort((a, b) => b.effectiveValue - a.effectiveValue);
    adoptIfBetter(
      constructMultiStartSeed(
        ctx,
        weaker,
        generators,
        coolers,
        directProducers,
        deadlineMs,
      ),
    );
  }

  // Repair the seed before annealing, and again afterwards. Seed construction
  // lays out self-sufficient hubs, so it systematically misses layouts where
  // neighbouring hubs share a cooler or a reactor; repair finds those directly
  // instead of hoping the walk stumbles into them. Both passes stop as soon as
  // nothing improves, so on small islands they cost almost nothing.
  const candidates = polishCandidates(
    reactors,
    generators,
    coolers,
    directProducers,
  );
  const polishBudgetMs = timeBudgetMs * POLISH_SHARE;

  const polishStartedMs = performance.now();
  let polished = await greedyPolish(
    seed,
    ctx,
    candidates,
    Math.min(deadlineMs, polishStartedMs + polishBudgetMs),
    pacer,
  );
  // How long a full repair actually took here, used below to reserve just
  // enough for the closing pass instead of a fixed (over-generous) share.
  const polishElapsedMs = performance.now() - polishStartedMs;

  // Under a role isolation the seed above was sized for it (`constructSeed`),
  // and the plain-sized seed is built and repaired as well; the search starts
  // from whichever repairs higher, the plain one on a tie. Judged after the
  // repair rather than before it, because the raw figure picks wrong: on
  // Entropy Isles' 20-tile island both seeds repair to five full hubs at the
  // same power, and from the sized one — 20 tiles of 20 used, every
  // generator already full — the later stages never reach the six-generator
  // optimum the plain one leads them to (2.36AD against 2.54AD at its 0.3s
  // budget). On every large shipped island the sized seed repairs to 78-88%
  // of the bound against the plain one's 50-64%, so the tie rule only
  // decides where the sizing did not help, and there the search starts where
  // every other rule starts. The plain repair gets the time the sized one
  // took, so this costs at most one more repair; cut short it only reads
  // lower, and the sized seed wins as it should.
  if (ctx.isolation !== null) {
    const plainSeed = constructMultiStartSeed(
      ctx,
      reactors,
      generators,
      coolers,
      directProducers,
      deadlineMs,
      false,
    );
    const plainPolished = await greedyPolish(
      plainSeed,
      ctx,
      candidates,
      Math.min(
        deadlineMs,
        performance.now() + Math.max(polishElapsedMs, PLAIN_SEED_POLISH_MIN_MS),
      ),
      pacer,
    );
    if (plainPolished.power + EPS >= polished.power) polished = plainPolished;
  }
  let placement = polished.placement;
  let bestPower = polished.power;

  // Composition-first attempt, BEFORE annealing so its result becomes the
  // walk's starting point rather than competing with it for time. What to build
  // is a counting problem with an exact answer, so solve that directly instead
  // of hoping the walk stumbles onto the right multiset. A target whose
  // perfect-arrangement power cannot beat the layout already in hand is
  // skipped, which costs nothing on islands where the search is already at the
  // bound.
  const compositionDeadlineMs = Math.min(
    deadlineMs,
    performance.now() + timeBudgetMs * COMPOSITION_SHARE,
  );
  // A target is scored from the plain roster and `bestPower` is a rated layout's
  // power, so the skip test needs the two in the same units or it throws the
  // whole stage away — see `islandRatingCeiling`. One number for the island,
  // resolved once: the loop below runs three times.
  const generatorCapacity = generatorCapacityTable(island, ctx, generators[0]);
  const ratingCeiling = islandRatingCeiling(
    ctx,
    [reactors[0], generators[0], coolers[0]].filter((b) => b !== undefined),
    generatorCapacity !== null,
  );
  for (const target of targetCompositions(
    ctx.n,
    reactors,
    generators,
    coolers,
    generatorCapacity,
  )) {
    if (
      performance.now() >= compositionDeadlineMs ||
      pacer.stopRequested ||
      !targetCanBeat(target, bestPower, ratingCeiling)
    ) {
      break;
    }

    const arranged = await arrangeComposition(
      target.composition,
      placement,
      ctx,
      compositionDeadlineMs,
      pacer,
    );
    if (arranged === null) continue;

    const repaired = await greedyPolish(
      arranged,
      ctx,
      candidates,
      compositionDeadlineMs,
      pacer,
    );
    if (repaired.power > bestPower + EPS) {
      placement = repaired.placement;
      bestPower = repaired.power;
    }
  }

  // Give the walk everything except what the closing repair needs. Reserving
  // the full polish share left roughly a quarter of the budget unspent, since
  // repair converges long before its cap.
  const finalReserveMs = Math.min(
    polishBudgetMs,
    Math.max(polishElapsedMs, timeBudgetMs * 0.05),
  );
  let annealMs = deadlineMs - performance.now() - finalReserveMs;
  const rng = new Rng(rngSeed ?? randomSeed());

  // ...and then hand back whatever that repair did not use, as another round of
  // walk-then-repair. The reserve above is a guess made before the layout
  // exists; on a post-anneal layout the closing repair is usually one fruitless
  // sweep, so the guess left the tail of the budget unspent — a 30s solve
  // returned at 28.5s. Each further round is a fresh short anneal from the
  // layout in hand, which cannot lose power: `hillClimb` starts its best from
  // the (stabilized) layout it is given and only ever returns a stable layout
  // at least as good, and repair on a stable layout only climbs.
  //
  // The rounds shrink — each is what the previous round's repair handed back —
  // so this converges on the deadline rather than looping indefinitely.
  const minRoundMs = Math.max(
    RECLAIM_MIN_ROUND_MS,
    timeBudgetMs * RECLAIM_MIN_ROUND_SHARE,
  );
  //
  // Each round reheats to the walk's full starting temperature. Starting the
  // reclaimed rounds at a tenth of it — on the reasoning that a short round
  // from a repaired layout spends most of itself wandering off a layout it
  // then hands straight back — was measured with the survey at 15s over three
  // runs on every map and anomaly: every map inside the noise band, so the
  // one schedule is kept.
  for (;;) {
    if (annealMs > 0 && !pacer.stopRequested) {
      placement = await hillClimb(
        placement,
        ctx,
        reactors,
        generators,
        coolers,
        directProducers,
        annealMs,
        rng,
        pacer,
        undefined,
        collector,
      );
    }

    const closingStartedMs = performance.now();
    polished = await greedyPolish(
      placement,
      ctx,
      candidates,
      deadlineMs,
      pacer,
    );
    placement = polished.placement;
    const closingElapsedMs = performance.now() - closingStartedMs;

    if (annealMs <= 0 || pacer.stopRequested) break;

    // The repair is capped by the deadline, so being cut mid-sweep costs it
    // improvements but never validity — every move it applies was checked for
    // stability first. The reserve is therefore a tuning choice, not a
    // correctness one, which is why it may be squeezed.
    const remainingMs = deadlineMs - performance.now();
    const reserveMs = Math.min(
      Math.max(closingElapsedMs * RECLAIM_POLISH_MARGIN, RECLAIM_MIN_ROUND_MS),
      remainingMs * RECLAIM_MAX_RESERVE_FRACTION,
    );
    annealMs = remainingMs - reserveMs;
    if (annealMs < minRoundMs) break;
  }

  // Everything from here runs past the deadline and none of it yields on its
  // own, so yield once before it: the walk's last pump may be most of a yield
  // interval ago, and the cleanup below is a second of work under a pool.
  {
    const now = performance.now();
    if (pacer.due(now)) await pacer.pump(now);
  }

  // Post-search cleanup pass...
  const pruned = pruneDeadWeight(placement, ctx);
  // ...and then right-size what survived. The search had no reason to prefer
  // the tier a tile actually needs over the biggest one in the roster, because
  // both score the same.
  const downsized = downgradeOversized(
    pruned.rows,
    pruned.power,
    effectiveBuildings,
    ctx,
  );
  // Under a cooling pool, last of all, gather the coolers the search left
  // wherever a hub had a gap. A no-op under every other rule.
  const sized = gatherPooledCoolers(
    downsized.rows,
    downsized.power,
    effectiveBuildings,
    ctx,
    performance.now() + EVACUATE_BUDGET_MS + GATHER_BUDGET_MS,
  );
  // Then push the holes the layout leaves out to the shore and the corners.
  const tidied = gatherEmptyTiles(
    sized.rows,
    sized.power,
    effectiveBuildings,
    ctx,
    performance.now() + EMPTY_GATHER_BUDGET_MS,
  );
  const placements = toPlacedBuildings(tidied.rows);
  const alternates = await finalizeAlternates(
    collector,
    placements,
    tidied.power,
    effectiveBuildings,
    ctx,
    pacer,
  );
  // Every one of these ties on power, so the cheapest to build goes first and
  // is the one the island shows. Stable, so equal costs keep the walk's order.
  const [best, ...rest] = cheapestFirst(
    [{ placements, powerOutput: tidied.power }, ...alternates],
    (l) => l.placements,
  );
  return { ...best, alternates: rest };
}

/**
 * The stages the public entry points compose, exposed for the test suite.
 *
 * Every one of these is an internal step of `solveIsland`, and none of them is
 * safe to call from application code: they take an `IslandContext` the caller
 * would have to build correctly, they assume roster pools already sorted the
 * way `solveIsland` sorts them, and their contracts are the ones documented
 * beside each function rather than anything this module promises to keep.
 *
 * They are reachable at all because the reference solver's suite tested them
 * directly and those cases are worth keeping — `pruneDeadWeight`'s cascade and
 * `targetCompositions`' ceiling are exactly the kind of thing that breaks
 * quietly and shows up two stages later as "the solver got a bit worse". One
 * named export says that plainly; nine loose ones would read as API.

 */
export const internals = {
  DOWNGRADE_ROLES,
  constructMultiStartSeed,
  downgradeTiers,
  gatherEmptyTiles,
  gatherPooledCoolers,
  greedyPolish,
  hillClimb,
  generatorCapacityTable,
  islandRatingCeiling,
  isUnderFed,
  targetCanBeat,
  offlineProducers,
  pruneDeadWeight,
  targetCompositions,
  tileLoad,
} as const;
