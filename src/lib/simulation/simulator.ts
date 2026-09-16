import { buildIslandContext, type IslandContext } from "@reactor2/solver";
import { simulateIsland } from "@reactor2/solver";
import type { Placement } from "@reactor2/solver";
import { effectiveAtValue } from "@reactor2/solver";
import { unscoredPlacement } from "../data/placements";
import type { BuildingDefinition, PlacedBuilding, Tile } from "../types";

/**
 * Scores a hand-placed layout.
 *
 * This does not implement the game's rules — it hands them to `lib/solver/`.
 * The board becomes an `IslandContext`, the placements become a `Placement`,
 * and `simulateIsland` produces the answer, which is then mapped back onto the
 * caller's rows. So the panel the player reads and the layout the optimizer
 * returns are scored by the same code, and cannot drift.
 *
 * Running the whole board through one context is not an approximation of
 * solving each island separately. Distribution already scopes its round budget
 * and its repair to each connected component of the supplier<->consumer graph,
 * which is a finer partition than the island — `simulator.test.ts` pins both
 * halves of that.
 */

/**
 * The island context for the current board, reused across calls.
 *
 * Building one allocates a flow matrix quadratic in the board's buildable tile
 * count — on the largest shipped island, megabytes — and this runs on every
 * placement change. The terrain signature is what invalidates it: `setTile`
 * mutates a tile in place, so the grid array's identity alone would go on
 * matching a board that has changed underneath it.
 */
let cached: { grid: Tile[][]; signature: number; ctx: IslandContext } | null =
  null;

function terrainSignature(grid: Tile[][]): number {
  let h = 0x811c9dc5;
  h = (h ^ grid.length) >>> 0;
  for (const row of grid) {
    h = (Math.imul(h, 0x01000193) ^ row.length) >>> 0;
    for (const tile of row) {
      h = (Math.imul(h, 0x01000193) ^ tile.type.charCodeAt(0)) >>> 0;
      h = (Math.imul(h, 0x01000193) ^ tile.type.length) >>> 0;
    }
  }
  return h;
}

function contextFor(grid: Tile[][]): IslandContext {
  const signature = terrainSignature(grid);
  if (cached && cached.grid === grid && cached.signature === signature) {
    return cached.ctx;
  }
  const ctx = buildIslandContext(grid);
  cached = { grid, signature, ctx };
  return ctx;
}

/**
 * Returns the given placements with every derived figure filled in, in the same
 * order they arrived. A placement on a tile that cannot be built on, or naming
 * a building the catalogue does not have, keeps its zeroes.
 */
export function simulatePlacedBuildings(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  placedBuildings: PlacedBuilding[],
): PlacedBuilding[] {
  // Copies, with every derived figure reset: this returns a fresh set of rows
  // rather than writing through to the caller's, and a figure left over from a
  // previous score would survive on any building the walk below never reaches.
  const results: PlacedBuilding[] = placedBuildings.map((pb) =>
    unscoredPlacement(pb.buildingId, pb.x, pb.y, pb.baseValue),
  );

  if (!grid?.length || !grid[0]?.length || placedBuildings.length === 0) {
    return results;
  }

  const ctx = contextFor(grid);
  if (ctx.n === 0) return results;

  // Tile index by position, so a placement's (x, y) finds its slot.
  const stride = ctx.n > 0 ? Math.max(...ctx.xs) + 1 : 1;
  const tileAt = new Map<number, number>();
  for (let t = 0; t < ctx.n; t++) tileAt.set(ctx.ys[t] * stride + ctx.xs[t], t);

  const placement: Placement = new Array(ctx.n).fill(null);
  // Tile index -> the row that placement came from, so the report maps back.
  const rowOf = new Int32Array(ctx.n).fill(-1);

  for (let i = 0; i < placedBuildings.length; i++) {
    const pb = placedBuildings[i];
    const def = buildings.find((b) => b.id === pb.buildingId);
    if (!def) continue;
    const t = tileAt.get(pb.y * stride + pb.x);
    if (t === undefined) continue;
    // Two placements on one tile is not a state the editor can produce; if a
    // save carries one anyway, the later one stands.
    placement[t] = effectiveAtValue(def, pb.baseValue);
    rowOf[t] = i;
  }

  for (const row of simulateIsland(placement, ctx, true).placements) {
    const i = rowOf[row.idx];
    if (i < 0) continue;
    results[i].powerGenerated = row.powerGenerated;
    results[i].heatProduced = row.heatProduced;
    results[i].heatConsumed = row.heatConsumed;
    results[i].wasteHeatGenerated = row.wasteHeatGenerated;
    results[i].coolingProvided = row.coolingProvided;
    results[i].coolingReceived = row.coolingReceived;
  }

  return results;
}
