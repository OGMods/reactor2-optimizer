import { AlternateCollector, powerTies } from "../alternates";
import { EPS } from "../constants";
import type { IslandContext } from "../context";
import { Pacer } from "../pacer";
import { generatorEnergyRatio, wasteIsCovered } from "../physics";
import { Rng } from "../rng";
import { type SimPlacedBuilding, simulateIsland } from "../simulate";
import type { EffectiveBuilding, Placement } from "../types";
import { copyInto, put, ratedFor } from "./placement";
import { islandProgress } from "./repair";
import {
  anyOfflineProducer,
  isUnderFed,
  planHolds,
  stabilize,
} from "./stability";

/**
 * The annealing walk: the one stage that can cross a barrier no single change
 * improves upon.
 */

function randomCandidate(
  pools: EffectiveBuilding[][],
  rng: Rng,
): EffectiveBuilding | null {
  if (pools.length === 0 || rng.random() < 0.15) return null;
  const pool = rng.choice(pools);
  if (pool.length === 1 || rng.random() < 0.7) return pool[0];
  return rng.choice(pool);
}

/**
 * `maxSteps` caps the walk by iteration count and, when set, drives the
 * temperature schedule by `step / maxSteps` instead of elapsed time. With a
 * fixed `Rng` and a `timeBudgetMs` generous enough that the deadline never
 * fires first, the walk is then fully deterministic: same seed, same result,
 * bit for bit. That is what the golden fixtures stand on. The solve pipeline
 * itself never sets it — wall time is the right budget in production, where
 * per-step cost varies by island.
 */
export async function hillClimb(
  seed: Placement,
  ctx: IslandContext,
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  directProducers: EffectiveBuilding[],
  timeBudgetMs: number,
  rng: Rng,
  pacer: Pacer,
  maxSteps?: number,
  collector?: AlternateCollector,
): Promise<Placement> {
  if (timeBudgetMs <= 0 || ctx.n === 0) return seed;

  const current = seed.slice();
  let sim = simulateIsland(current, ctx);
  let currentPower = sim.totalPower;
  let currentPlacements = sim.placements;

  // The walk itself is free to pass through layouts containing overheating
  // buildings — they are often one move away from good ones — but only a STABLE
  // layout may be recorded as the best. Raw power alone would happily settle on
  // a layout that parks heat in a permanently offline generator, which then has
  // to be dismantled at the end, ending up worse than the best stable layout
  // the search already walked past.
  const initial = stabilize(current, ctx);
  let bestPlacement = initial.placement;
  let bestPower = initial.power;
  // The layout the walk starts from is itself an answer at this power, and the
  // shortlist has to hold one before it can recognise a tie with it.
  collector?.offer(initial.power, initial.placement);
  // Highest raw score seen so far, used only to decide when an unstable layout
  // is promising enough to be worth stabilizing and re-scoring.
  let bestRawPower = currentPower;
  let stall = 0;

  const recordIfBest = (
    power: number,
    snapshot: Placement,
    rows: SimPlacedBuilding[],
  ): void => {
    if (power <= bestPower + EPS) {
      // Not an improvement — but a layout that *ties* the best is a second
      // answer worth offering the user, so it goes on the shortlist. The
      // checks are ordered by what they cost: `full` is a size comparison,
      // `accepts` reads the layout's tiles, and only then does the stability
      // test walk every row. A converged walk ties its best constantly and
      // nearly all of those are near copies of a layout already held, so
      // `accepts` is what keeps this off the hot path once the shortlist has
      // stopped growing.
      if (
        collector !== undefined &&
        !collector.full &&
        powerTies(power, collector.power) &&
        collector.accepts(snapshot) &&
        !anyOfflineProducer(snapshot, rows) &&
        planHolds(snapshot, ctx)
      ) {
        collector.offer(power, snapshot);
      }
      return;
    }

    if (!anyOfflineProducer(snapshot, rows) && planHolds(snapshot, ctx)) {
      bestPower = power;
      bestPlacement = snapshot.slice();
      collector?.offer(power, snapshot);
      stall = 0;
      return;
    }

    // Unstable. Only worth the extra simulations when it is a new raw
    // high-water mark — otherwise the walk would re-stabilize the same
    // unreachable peak on every visit.
    if (power > bestRawPower + EPS) {
      bestRawPower = power;
      const stabilized = stabilize(snapshot, ctx);
      if (stabilized.power > bestPower + EPS) {
        bestPower = stabilized.power;
        bestPlacement = stabilized.placement;
        collector?.offer(stabilized.power, stabilized.placement);
        stall = 0;
      }
    }
  };

  const topCooler = coolers.length > 0 ? coolers[0] : null;
  const topGenerator = generators.length > 0 ? generators[0] : null;
  const pools = [reactors, generators, coolers, directProducers].filter(
    (p) => p.length > 0,
  );
  const startMs = performance.now();
  const deadlineMs = startMs + timeBudgetMs;

  // Temperature is scaled to the size of one MOVE, not to the island's total
  // output. Changing a single tile is worth roughly one generator's power
  // wherever it happens, so scaling by total power made large islands run far
  // too hot: on the 67-tile map 1 island, ~23% of moves that each cost 7% of
  // the layout were being accepted, and the walk never climbed back.
  //
  // It is read off the PLAIN roster, so under a rule that rates a tile above it
  // the walk runs colder than this calibration intends — a move on a Tidal
  // shore is worth its `multiplier` times one here. Scaling it by
  // `islandRatingCeiling` was measured: Tidal (the pre-nerf
  // `tidal_ascendancy_legacy`) on map 3 at 15s over three seeds went
  // 176/178/179AC to 179/181/178AC, and Singularity at 30s over five seeds on
  // map 3 142/140/142/142/140AC to
  // 140/139/140/142/142AC and on map 7 274/271/271/271/274AC to
  // 267/271/271/271/274AC — inside run-to-run noise, so the plain figure is kept.
  // Anyone re-measuring should use a longer budget and more seeds than that.
  const moveScale =
    generators.length > 0
      ? generators[0].effectiveValue * generatorEnergyRatio(generators[0])
      : 1.0;
  const tStart = Math.max(moveScale * 0.1, 1.0);
  const tMin = 1e-4;
  let temperature = tStart;

  // Snap back to the best layout after a long run of no improvement. Without
  // this, one unlucky sequence of accepted downhill moves strands the walk in a
  // region it cannot climb out of for the rest of the budget.
  const stallLimit = Math.max(2000, ctx.n * 200);

  let step = 0;
  const batchMask = 127;

  /** Accepts or rolls back a trial move, Metropolis-style. */
  const accept = (power: number, rows: SimPlacedBuilding[]): boolean => {
    const delta = power - currentPower;
    const exponent = temperature > 0 ? delta / temperature : -100.0;
    if (
      delta > EPS ||
      (exponent > -50.0 && rng.random() < Math.exp(exponent))
    ) {
      currentPower = power;
      currentPlacements = rows;
      recordIfBest(power, current, rows);
      return true;
    }
    return false;
  };

  for (;;) {
    if (maxSteps !== undefined && step >= maxSteps) break;

    if ((step & batchMask) === 0) {
      const now = performance.now();
      if (now >= deadlineMs) break;

      if (pacer.due(now)) {
        await pacer.pump(now, () => islandProgress(bestPlacement, ctx));
        if (pacer.stopRequested) break;
      }

      const progress =
        maxSteps !== undefined
          ? Math.min(1.0, step / maxSteps)
          : Math.min(1.0, Math.max(0.0, (now - startMs) / timeBudgetMs));
      temperature = tStart * Math.pow(tMin / tStart, progress);

      if (stall >= stallLimit) {
        copyInto(current, bestPlacement);
        sim = simulateIsland(current, ctx);
        currentPower = sim.totalPower;
        currentPlacements = sim.placements;
        stall = 0;
      }
    }

    step += 1;
    stall += 1;
    const moveType = rng.random();

    if (moveType < 0.15 && currentPlacements.length > 0) {
      const uncooled: SimPlacedBuilding[] = [];
      const wastedReactors: SimPlacedBuilding[] = [];
      for (const p of currentPlacements) {
        if (
          p.wasteHeatGenerated > EPS &&
          !wasteIsCovered(p.wasteHeatGenerated, p.coolingReceived)
        ) {
          uncooled.push(p);
        }
        if (isUnderFed(p)) {
          wastedReactors.push(p);
        }
      }

      if (uncooled.length > 0 && topCooler !== null && rng.random() < 0.6) {
        const target = rng.choice(uncooled);
        const adj = ctx.neighbors[target.idx];
        // Beside the starved producer, which is the only place a cooler can
        // reach it. Under a pool any tile would do and a short pool starves
        // every producer at once, so this writes over a random occupied
        // neighbour there — often the reactor feeding the very producer it
        // means to save. Aiming it at an empty tile instead was measured on
        // maps 3 and 7 at 15s over three seeds and changed nothing, so the one
        // shape is kept.
        if (adj.length > 0) {
          const tile = adj[rng.int(adj.length)];
          const old = current[tile];
          // In the tile's units, or the guard never fires on a rated tile —
          // see `ratedFor`.
          if (ratedFor(ctx, tile, topCooler) !== old) {
            put(current, ctx, tile, topCooler);
            const trial = simulateIsland(current, ctx);
            if (!accept(trial.totalPower, trial.placements))
              put(current, ctx, tile, old);
            continue;
          }
        }
      } else if (
        wastedReactors.length > 0 &&
        topGenerator !== null &&
        rng.random() < 0.6
      ) {
        const target = rng.choice(wastedReactors);
        const adj = ctx.neighbors[target.idx];
        if (adj.length > 0) {
          const tile = adj[rng.int(adj.length)];
          const old = current[tile];
          if (ratedFor(ctx, tile, topGenerator) !== old) {
            put(current, ctx, tile, topGenerator);
            const trial = simulateIsland(current, ctx);
            if (!accept(trial.totalPower, trial.placements))
              put(current, ctx, tile, old);
            continue;
          }
        }
      }
    }

    if (moveType < 0.5 && ctx.n >= 2) {
      const tile1 = rng.int(ctx.n);
      const adj = ctx.neighbors[tile1];
      let tile2: number;
      if (adj.length > 0 && rng.random() < 0.7) {
        tile2 = adj[rng.int(adj.length)];
      } else {
        tile2 = rng.int(ctx.n);
        while (tile2 === tile1) tile2 = rng.int(ctx.n);
      }

      const val1 = current[tile1];
      const val2 = current[tile2];
      // A swap that writes each tile what it already holds. On one scale class
      // that is `val1 === val2`; across two it is not, because the same roster
      // entry is a different object on each — so the test is on what the writes
      // would land, which covers both.
      if (
        ratedFor(ctx, tile1, val2) === val1 &&
        ratedFor(ctx, tile2, val1) === val2
      ) {
        continue;
      }

      put(current, ctx, tile1, val2);
      put(current, ctx, tile2, val1);

      const trial = simulateIsland(current, ctx);
      if (!accept(trial.totalPower, trial.placements)) {
        put(current, ctx, tile1, val1);
        put(current, ctx, tile2, val2);
      }
      continue;
    }

    const tile = rng.int(ctx.n);
    const old = current[tile];
    const replacement = randomCandidate(pools, rng);
    // The commonest move in the walk, and the commonest no-op: `randomCandidate`
    // returns the top tier of a pool with p ~ 0.7, so a packed island proposes
    // the building a tile already holds constantly.
    if (ratedFor(ctx, tile, replacement) === old) continue;

    put(current, ctx, tile, replacement);
    const trial = simulateIsland(current, ctx);
    if (!accept(trial.totalPower, trial.placements)) current[tile] = old;
  }

  return bestPlacement;
}
