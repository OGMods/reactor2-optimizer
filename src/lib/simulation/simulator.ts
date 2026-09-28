import { buildIslandContext, type IslandContext } from "@reactor2/solver";
import { simulateIsland } from "@reactor2/solver";
import type { Placement } from "@reactor2/solver";
import {
  effectiveAtValue,
  getAnomaly,
  type AnomalyDefinition,
  type EffectiveBuilding,
  type PrestigeScales,
} from "@reactor2/solver";
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
let cached: {
  grid: Tile[][];
  signature: number;
  anomaly: AnomalyDefinition;
  ctx: IslandContext;
} | null = null;

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

function contextFor(
  grid: Tile[][],
  anomaly: AnomalyDefinition,
): IslandContext {
  const signature = terrainSignature(grid);
  if (
    cached &&
    cached.grid === grid &&
    cached.signature === signature &&
    // Part of the key, not a detail: a terrain bonus is resolved per tile when
    // the context is built, so a cached one carries the rules it was built
    // under and would go on rating the board under a timeline it has left.
    cached.anomaly === anomaly
  ) {
    return cached.ctx;
  }
  // No shore mask: this is the whole board, so its window has no edge the board
  // does not, and `buildIslandContext` resolves one that treats off the board
  // as water. See `computeWaterAdjacency`.
  const ctx = buildIslandContext(grid, undefined, anomaly);
  cached = { grid, signature, anomaly, ctx };
  return ctx;
}

/**
 * Every tier the session has resolved, so `ctx.rate` is handed the *same*
 * object for a given (definition, tier) pair every time.
 *
 * `effectiveAtValue` mints a fresh record on every call — it has to, since it
 * derives waste — and the context's rating memo is keyed on the base object's
 * identity, which is exactly right for a solve (one roster, resolved once) and
 * a guaranteed miss here: this runs on every placement change against a context
 * kept alive for the whole session, so under a rule that scales anything each
 * call inserted two more entries nothing would ever look up again. Interning the
 * pair on this side makes those memos hit and bounds them by the catalogue —
 * some 300 tiers — rather than by how long the player has been editing.
 *
 * Keyed on the definition object rather than its id, so a caller holding a
 * different catalogue (the tests do) cannot collide with the shipped one, and
 * weakly so a definition that goes away takes its tiers with it. The research
 * is folded into the numbers, so a change of scales invalidates the lot.
 */
let ratedTiers = new WeakMap<
  BuildingDefinition,
  Map<number, EffectiveBuilding>
>();
let ratedTiersPrestige: PrestigeScales | undefined;

function tierAtValue(
  def: BuildingDefinition,
  baseValue: number,
  prestige: PrestigeScales | undefined,
): EffectiveBuilding {
  if (prestige !== ratedTiersPrestige) {
    ratedTiers = new WeakMap();
    ratedTiersPrestige = prestige;
  }
  let byValue = ratedTiers.get(def);
  if (byValue === undefined) {
    byValue = new Map();
    ratedTiers.set(def, byValue);
  }
  let tier = byValue.get(baseValue);
  if (tier === undefined) {
    tier = effectiveAtValue(def, baseValue, prestige);
    byValue.set(baseValue, tier);
  }
  return tier;
}

/** A board turned into something `simulateIsland` can score. */
interface BoardLayout {
  placement: Placement;
  /** Tile index -> the row that placement came from, or -1. */
  rowOf: Int32Array;
  /** `(x, y)` -> tile index, for the placements that landed on one. */
  tileOf: (x: number, y: number) => number | undefined;
}

/**
 * Lays the given placements onto an island's tiles, each rated for the tile it
 * sits on.
 *
 * Shared by the two things that read a board: scoring it, and asking what one
 * building on it was rated for. Both have to rate identically, and a second
 * copy of this loop is how they would stop: the readout measured its figures
 * against the plain roster for a while and printed a shore cooler as
 * `8.35AC / 8AC`, a used figure larger than the total it was measured against.
 */
function layoutFor(
  ctx: IslandContext,
  buildings: readonly BuildingDefinition[],
  placedBuildings: readonly PlacedBuilding[],
  prestige: PrestigeScales | undefined,
): BoardLayout {
  // Tile index by position, so a placement's (x, y) finds its slot.
  const stride = ctx.n > 0 ? Math.max(...ctx.xs) + 1 : 1;
  const tileAt = new Map<number, number>();
  for (let t = 0; t < ctx.n; t++) tileAt.set(ctx.ys[t] * stride + ctx.xs[t], t);

  const placement: Placement = new Array(ctx.n).fill(null);
  const rowOf = new Int32Array(ctx.n).fill(-1);

  for (let i = 0; i < placedBuildings.length; i++) {
    const pb = placedBuildings[i];
    const def = buildings.find((b) => b.id === pb.buildingId);
    if (!def) continue;
    const t = tileAt.get(pb.y * stride + pb.x);
    if (t === undefined) continue;
    // Two placements on one tile is not a state the editor can produce; if a
    // save carries one anyway, the later one stands.
    // Rated for the tile it sits on, the same way the search rates what it
    // places: under a shore bonus the two would otherwise print different
    // figures for the identical board.
    placement[t] = ctx.rate(t, tierAtValue(def, pb.baseValue, prestige));
    rowOf[t] = i;
  }

  return {
    placement,
    rowOf,
    tileOf: (x, y) => tileAt.get(y * stride + x),
  };
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
  prestige?: PrestigeScales,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
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

  const ctx = contextFor(grid, anomaly);
  if (ctx.n === 0) return results;

  const { placement, rowOf } = layoutFor(
    ctx,
    buildings,
    placedBuildings,
    prestige,
  );

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

/**
 * What the building on `(x, y)` was **rated for** on the board around it: the
 * three ceilings every figure in its scored row was measured against. Null on a
 * tile nothing buildable stands on.
 *
 * The readout needs this and cannot get it off the row. A `PlacedBuilding`
 * carries `baseValue`, which is the *authored* tier value and deliberately never
 * rewritten — a placement's tier is resolved back out of it by matching the
 * catalogue, so a scaled value there would resolve as a higher tier and be
 * scaled twice. And `effectiveAtValue` on its own answers a question with no
 * tile in it, so under a rule that rates a tile above the roster the card's
 * "used" figure walks straight past its own total.
 *
 * So the ceiling is resolved here, by the module that scored the row, from the
 * same `layoutFor` — rather than in the component, which would be a second
 * reading of the rules with nothing to keep the two in step. It is keyed on the
 * *tile and the board* rather than carried on the row because the rows the card
 * reads arrive from two places: `simulatePlacedBuildings` above, and a finished
 * solve straight off the worker, whose protocol has no field for this and wants
 * none (the rating is the island's own units).
 *
 * `placedBuildings` must be the whole board, not the one building: a
 * role-isolation rule rates a building by *what its neighbours are*, so the
 * answer for one tile is a function of every other. That rule is the reason for
 * the `simulateIsland` call below — it is resolved per layout, into
 * `ctx.ratedLayout`, and this asks for it exactly the way the scorer does rather
 * than re-deriving a neighbour scan up here. Under every other rule
 * `ratedLayout` is never written and the tile's own rating is the answer.
 */
export function ratedPlacementAt(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  placedBuildings: readonly PlacedBuilding[],
  x: number,
  y: number,
  prestige?: PrestigeScales,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
): EffectiveBuilding | null {
  if (!grid?.length || !grid[0]?.length || placedBuildings.length === 0) {
    return null;
  }

  const ctx = contextFor(grid, anomaly);
  if (ctx.n === 0) return null;

  const { placement, tileOf } = layoutFor(
    ctx,
    buildings,
    placedBuildings,
    prestige,
  );
  const t = tileOf(x, y);
  if (t === undefined) return null;

  const rated = placement[t];
  if (rated === null) return null;
  if (ctx.isolation === null) return rated;

  simulateIsland(placement, ctx, true);
  return ctx.ratedLayout[t] ?? rated;
}
