import type { IslandContext } from "../context";
import { type SimPlacedBuilding, simulateIsland } from "../simulate";
import type { EffectiveBuilding, Placement } from "../types";
import { chebyshev, emptyPlacement, put } from "./placement";
import { covers } from "./rightSize";
import { anyOfflineProducer, planHolds } from "./stability";

/**
 * Pushing the tiles a finished layout leaves empty out to the edge of the land
 * and into its corners.
 */

/**
 * How long `gatherEmptyTiles` may spend, per solve on the primary layout and
 * once more shared across its alternates. It runs after the search's deadline,
 * so this is time added to a run; out of time, the holes stay where the sweep
 * left them. On a desktop the largest shipped island under Singularity takes
 * 105-145ms and the rest 0-60ms, so this leaves a phone room to finish.
 */
export const EMPTY_GATHER_BUDGET_MS = 300;

/** A tile's 8-neighbourhood is complete when every neighbour is buildable. */
const FULL_NEIGHBOURHOOD = 8;

/**
 * How far inside the land each tile sits, as one sortable figure: lower is
 * nearer an edge, and on the edge itself, nearer a corner.
 *
 * Depth is the 8-neighbour step count from the nearest tile with a
 * non-buildable neighbour — water, an obstacle or the board's edge — and the
 * buildable-neighbour count breaks ties within a ring, which is what puts a
 * corner (three) ahead of a straight edge (five).
 */
function interiority(ctx: IslandContext): Int32Array {
  const depth = new Int32Array(ctx.n).fill(-1);
  const queue: number[] = [];
  for (let t = 0; t < ctx.n; t++) {
    if (ctx.neighbors[t].length < FULL_NEIGHBOURHOOD) {
      depth[t] = 0;
      queue.push(t);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head];
    for (const u of ctx.neighbors[t]) {
      if (depth[u] < 0) {
        depth[u] = depth[t] + 1;
        queue.push(u);
      }
    }
  }
  const score = new Int32Array(ctx.n);
  for (let t = 0; t < ctx.n; t++)
    score[t] = depth[t] * (FULL_NEIGHBOURHOOD + 1) + ctx.neighbors[t].length;
  return score;
}

/** Buildings on the board doing nothing at all, as the readout would call them idle. */
function idleCount(placement: Placement, rows: SimPlacedBuilding[]): number {
  let n = 0;
  for (const r of rows) {
    if (placement[r.idx] === null) continue;
    if (
      r.powerGenerated <= 0 &&
      r.heatProduced <= 0 &&
      r.heatConsumed <= 0 &&
      r.coolingProvided <= 0
    )
      n++;
  }
  return n;
}

/**
 * Moves the empty tiles a finished layout leaves inside the land out towards
 * its shore and corners.
 *
 * The search places by power and nothing else, so wherever a building did not
 * pay for its tile there is a hole, and the holes land wherever the walk
 * stopped — often in the middle of the hubs, where the player has to build
 * around them and wonders whether the solver forgot a tile. A hole on the
 * shore or in a corner reads as what it is.
 *
 * Like `downgradeOversized`, this cannot find a better layout. A hole moves by
 * a building nearer the edge stepping into it, which leaves the hole on the
 * building's old tile. That changes what the building stands beside, so every
 * move is re-simulated and kept only if power holds against the layout handed
 * in, every producer stays online, nothing new goes idle and the upgrade plan
 * still runs. Any building nearer the edge may be offered, nearest first: a
 * radius of two left 7 of 24 interior holes standing across the eight shipped
 * maps under Singularity (a player's 160s solves), and no radius left none,
 * at no power.
 *
 * Under a cooling pool coolers are not moved, since `gatherPooledCoolers` has
 * just put them where they are. Every accepted move strictly lowers the holes'
 * summed `interiority`, so the sweep terminates; the deadline only bounds how
 * far it gets.
 */
export function gatherEmptyTiles(
  rows: SimPlacedBuilding[],
  power: number,
  effectiveBuildings: EffectiveBuilding[],
  ctx: IslandContext,
  deadlineMs: number,
): { rows: SimPlacedBuilding[]; power: number } {
  if (rows.length === 0 || rows.length >= ctx.n) return { rows, power };

  const byId = new Map(effectiveBuildings.map((b) => [b.id, b]));
  const current = emptyPlacement(ctx.n);
  for (const row of rows) {
    const building = byId.get(row.buildingId);
    if (building === undefined) return { rows, power };
    put(current, ctx, row.idx, building);
  }

  const score = interiority(ctx);
  const pooled = ctx.anomaly.rule === "shared_cooling";
  const floor = power;
  const idleFloor = idleCount(current, rows);
  let moved = false;

  let changed = true;
  while (changed && performance.now() < deadlineMs) {
    changed = false;
    // Deepest hole first: it has the furthest to go.
    const holes: number[] = [];
    for (let t = 0; t < ctx.n; t++)
      if (current[t] === null && score[t] > 0) holes.push(t);
    holes.sort((a, b) => score[b] - score[a] || a - b);

    for (const hole of holes) {
      if (performance.now() >= deadlineMs) break;
      // Nearest the hole first, since a building that moves a step keeps most
      // of its neighbours; then nearest the edge, then ascending index, so the
      // result depends only on the board.
      const sources: number[] = [];
      for (let t = 0; t < ctx.n; t++) {
        const b = current[t];
        if (b === null || score[t] >= score[hole]) continue;
        if (pooled && b.type === "cooler") continue;
        sources.push(t);
      }
      sources.sort(
        (a, b) =>
          chebyshev(ctx, a, hole) - chebyshev(ctx, b, hole) ||
          score[a] - score[b] ||
          a - b,
      );

      for (const from of sources) {
        const building = current[from]!;
        put(current, ctx, hole, building);
        current[from] = null;
        const trial = simulateIsland(current, ctx);
        if (
          covers(trial.totalPower, floor) &&
          !anyOfflineProducer(current, trial.placements) &&
          idleCount(current, trial.placements) <= idleFloor &&
          planHolds(current, ctx)
        ) {
          changed = true;
          moved = true;
          break;
        }
        current[hole] = null;
        put(current, ctx, from, building);
        if (performance.now() >= deadlineMs) break;
      }
    }
  }

  if (!moved) return { rows, power };
  const final = simulateIsland(current, ctx);
  // Every kept move held the floor, so a shortfall here would be a bug rather
  // than a trade. Give the input back.
  if (!covers(final.totalPower, floor)) return { rows, power };
  return { rows: final.placements, power: final.totalPower };
}
