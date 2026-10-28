import { EPS } from "../constants";
import type { IslandContext } from "../context";
import { type IslandProgress, Pacer } from "../pacer";
import { type SimPlacedBuilding, simulateIsland } from "../simulate";
import type { EffectiveBuilding, Placement } from "../types";
import {
  chebyshev,
  isReactor,
  put,
  ratedFor,
  toPlacedBuildings,
} from "./placement";
import { anyOfflineProducer, planHolds, stabilize } from "./stability";

/**
 * Local repair and pruning: steepest ascent over single-tile changes, and the
 * closing sweep that drops dead weight from a finished layout.
 */

/** How many reactor tiers the local-repair pass considers per tile. */
export const POLISH_REACTOR_TIERS = 3;
/**
 * How far from an applied repair move the cached gains are re-measured. A
 * change on a tile is felt through its neighbours' supply and demand, so a
 * tile two steps away shares a neighbour with it and one three steps away
 * shares nothing — see `greedyPolish`.
 */
const POLISH_DIRTY_RADIUS = 2;

/**
 * The lean set of buildings worth trying on a tile during local repair.
 *
 * Generators and coolers jump 400x-4100x per tier, so only their top tier can
 * ever appear in a good layout. Reactors only jump ~8x, which is small enough
 * that a weaker one is genuinely useful for topping up a generator's spare heat
 * capacity when there is leftover cooling, so a few reactor tiers are kept.
 * Every extra candidate costs another full pass over the island.
 */
export function polishCandidates(
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  directProducers: EffectiveBuilding[],
): (EffectiveBuilding | null)[] {
  const candidates: (EffectiveBuilding | null)[] = reactors.slice(
    0,
    POLISH_REACTOR_TIERS,
  );
  if (generators.length > 0) candidates.push(generators[0]);
  if (coolers.length > 0) candidates.push(coolers[0]);
  if (directProducers.length > 0) candidates.push(directProducers[0]);
  // Leaving the tile empty is a real option.
  candidates.push(null);
  return candidates;
}

/**
 * Steepest-ascent repair: repeatedly applies the single-tile change that raises
 * power the most, considering only stable layouts, until no single change
 * helps.
 *
 * The annealing walk handles small islands well, but on a large, fully packed
 * one nearly every single-tile change costs several percent, so the walk drifts
 * downhill and rarely climbs back: measured on a 67-tile island, only 1
 * evaluation in 26,000 beat its own starting layout, while 20 stable improving
 * moves sat a single move away. A full sweep here costs |tiles| x |candidates|
 * simulations and finds them directly.
 */
export async function greedyPolish(
  placement: Placement,
  ctx: IslandContext,
  candidates: (EffectiveBuilding | null)[],
  deadlineMs: number,
  pacer: Pacer,
): Promise<{ placement: Placement; power: number }> {
  let current = placement.slice();
  const sim = simulateIsland(current, ctx);
  let bestPower = sim.totalPower;
  if (anyOfflineProducer(current, sim.placements) || !planHolds(current, ctx)) {
    const stabilized = stabilize(current, ctx);
    current = stabilized.placement;
    bestPower = stabilized.power;
  }

  // The gain of every (tile, candidate) change, measured against the layout
  // as it stood when that tile was last swept. A full sweep after every
  // accepted move was the whole cost of this stage — |tiles| x |candidates|
  // simulations per move, 2-3s for one repair on the largest shipped islands
  // — and nearly all of it re-measured changes far from the move, whose gain
  // the move cannot have touched: a single-tile change is felt through its
  // neighbours' supply and demand, so only tiles within `POLISH_DIRTY_RADIUS`
  // of an applied move are swept again. The rest keep their figure, which is
  // approximate once anything nearby has moved, so a cached winner is always
  // re-simulated before it is applied and dropped back into the sweep if it
  // no longer holds. Every applied change is therefore verified exactly;
  // only the order the changes are found in can differ from a full sweep.
  //
  // Measured with the survey (`--runs 3 --seed 1`, every map and anomaly):
  // at 15s per map it is a wash, every map inside the noise band; at 5s —
  // where the polish share binds, as it does on a phone at any budget — Tidal
  // gains 5-9% on six of the eight maps and Shadowspire under Singularity
  // 16%, against one 83-tile island down 0.7%. One repair on the seed of the
  // largest island went from 950ms to 180ms (`npm run profile`).
  const nCandidates = candidates.length;
  const gains = new Float64Array(ctx.n * nCandidates).fill(-Infinity);
  const dirty = new Uint8Array(ctx.n).fill(1);

  while (performance.now() < deadlineMs && !pacer.stopRequested) {
    let cut = false;
    for (let tile = 0; tile < ctx.n; tile++) {
      if (dirty[tile] === 0) continue;
      const now = performance.now();
      if (now >= deadlineMs) {
        cut = true;
        break;
      }
      if (pacer.due(now)) {
        await pacer.pump(now, () => islandProgress(current, ctx));
        if (pacer.stopRequested) {
          cut = true;
          break;
        }
      }

      dirty[tile] = 0;
      const held = current[tile];
      for (let k = 0; k < nCandidates; k++) {
        const building = candidates[k];
        let gain = -Infinity;
        // The candidate list is the plain roster, `held` is rated for this tile:
        // asked the wrong way round, a scaled tile re-simulates its own layout
        // once per sweep for nothing. See `ratedFor`.
        if (ratedFor(ctx, tile, building) !== held) {
          put(current, ctx, tile, building);
          const trial = simulateIsland(current, ctx);
          if (
            trial.totalPower - bestPower > 0 &&
            !anyOfflineProducer(current, trial.placements) &&
            planHolds(current, ctx)
          ) {
            gain = trial.totalPower - bestPower;
          }
          put(current, ctx, tile, held);
        }
        gains[tile * nCandidates + k] = gain;
      }
    }
    if (cut) break;

    let bestGain = 0.0;
    let bestTile = -1;
    let bestCandidate = -1;
    for (let i = 0; i < gains.length; i++) {
      if (gains[i] > bestGain) {
        bestGain = gains[i];
        bestTile = (i / nCandidates) | 0;
        bestCandidate = i - bestTile * nCandidates;
      }
    }
    if (bestTile < 0) break;

    // Exact, whether the figure was fresh or cached: the one simulation that
    // decides what this stage hands on.
    const held = current[bestTile];
    put(current, ctx, bestTile, candidates[bestCandidate]);
    const trial = simulateIsland(current, ctx);
    if (
      trial.totalPower - bestPower > 0 &&
      !anyOfflineProducer(current, trial.placements) &&
      planHolds(current, ctx)
    ) {
      bestPower = trial.totalPower;
      for (let tile = 0; tile < ctx.n; tile++) {
        if (chebyshev(ctx, tile, bestTile) <= POLISH_DIRTY_RADIUS)
          dirty[tile] = 1;
      }
    } else {
      // Stale: the layout moved under it. Back to the sweep for a fresh figure.
      put(current, ctx, bestTile, held);
      dirty[bestTile] = 1;
    }
  }

  return { placement: current, power: bestPower };
}

/**
 * Post-search cleanup:
 * 1. Drops every producer generating 0 power, repeating until none remain.
 * 2. Sequentially tests removing reactors/coolers to eliminate redundant
 *    support structures, and direct producers whose output the island's
 *    total is too large to register.
 * 3. Guarantees a stable layout — every returned producer is online — with a
 *    minimal active tile footprint.
 *
 * Step 1 is unconditional: an overheating building is never acceptable, even
 * when keeping it would score higher (see `stabilize`). Step 2 is guarded,
 * since removing support can only ever cost power.
 */
export function pruneDeadWeight(
  placement: Placement,
  ctx: IslandContext,
): { rows: SimPlacedBuilding[]; power: number } {
  let anyOccupied = false;
  for (let tile = 0; tile < ctx.n; tile++) {
    if (placement[tile] !== null) {
      anyOccupied = true;
      break;
    }
  }
  if (!anyOccupied) return { rows: [], power: 0.0 };

  // 1. Remove producers that generate no power (cascading).
  const stabilized = stabilize(placement, ctx);
  const current = stabilized.placement;
  let bestPower = stabilized.power;
  let rows = stabilized.rows;

  // 2. Greedy backward sweep: test removing support buildings (reactors &
  // coolers), and direct producers too.
  //
  // A direct producer earns its tile on a small island, where a wind turbine
  // beside a cooler is the most two tiles can make. On a large one its output
  // is below the resolution of the island's total: 7 added to 1.5e25 is
  // 1.5e25 exactly, since a double's last place there is around 2e9. Every
  // comparison the search makes then reads it as worth nothing, so the walk
  // drifts turbines in as neutral moves (a zero delta is always accepted) and
  // nothing ever has a reason to take them out. Measured on Shadowspire under
  // Singularity: five turbines across its two main islands on one run, none on
  // the next. Removing one is accepted on the same guard as any support
  // building — total power not lower — so a turbine whose 7 registers stays.
  const support: number[] = [];
  for (let tile = 0; tile < ctx.n; tile++) {
    const b = current[tile];
    if (b === null) continue;
    if (b.type === "cooler" || b.type === "direct_producer" || isReactor(b))
      support.push(tile);
  }

  for (const tile of support) {
    const held = current[tile];
    if (held === null) continue;

    current[tile] = null;
    const trial = simulateIsland(current, ctx);

    // Power alone is not enough to accept a removal. Dropping a reactor can
    // starve one generator to zero while handing its heat to another that had
    // spare capacity, leaving total power unchanged but stranding an idle
    // generator on the board.
    if (
      trial.totalPower >= bestPower - EPS &&
      !anyOfflineProducer(current, trial.placements) &&
      planHolds(current, ctx)
    ) {
      bestPower = trial.totalPower;
      rows = trial.placements;
    } else {
      put(current, ctx, tile, held);
    }
  }

  return { rows, power: bestPower };
}

export function islandProgress(
  placement: Placement,
  ctx: IslandContext,
): IslandProgress {
  const pruned = pruneDeadWeight(placement, ctx);
  return {
    placements: toPlacedBuildings(pruned.rows),
    powerOutput: pruned.power,
  };
}
