import { buildIslandContext, type IslandContext } from "@reactor2/solver";
import { simulateIsland } from "@reactor2/solver";
import type { Placement } from "@reactor2/solver";
import {
  effectiveAtValue,
  getAnomaly,
  levelValue,
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

function contextFor(grid: Tile[][], anomaly: AnomalyDefinition): IslandContext {
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

  return { placement, rowOf };
}

/**
 * The total power of a board that is not on screen — one of the islands the
 * header adds up, or a game board as it was imported.
 *
 * Its own context rather than `contextFor`'s: that cache holds one board, the
 * one being edited, and walking eight islands through it would evict it eight
 * times over and make the next edit pay to rebuild it. Callers here run on a
 * change of island or roster, not on every edit, and memoise the answer.
 */
export function boardPower(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  placedBuildings: readonly PlacedBuilding[],
  prestige?: PrestigeScales,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
): number {
  if (!grid?.length || !grid[0]?.length || placedBuildings.length === 0) {
    return 0;
  }
  const ctx = buildIslandContext(grid, undefined, anomaly);
  if (ctx.n === 0) return 0;
  const { placement } = layoutFor(ctx, buildings, placedBuildings, prestige);
  return simulateIsland(placement, ctx).totalPower;
}

/**
 * Scores many versions of one board fast: the island context is built once,
 * and each building's rating on each tile is resolved once and reused.
 *
 * For the move-step planner, which scores the board after every candidate
 * action at every step — thousands of layouts of one island, differing by a
 * building or two. `score` takes the board as tile key (`"x,y"`) to building
 * id, at the tiers `unlocks` gives, and returns its power; a building on a
 * tile the island cannot build on, or not in the catalogue, counts for nothing.
 */
export function createBoardScorer(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  unlocks: Record<string, number>,
  prestige?: PrestigeScales,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
): (board: ReadonlyMap<string, string>) => number {
  if (!grid?.length || !grid[0]?.length) return () => 0;
  const ctx = buildIslandContext(grid, undefined, anomaly);
  const tileOf = new Map<string, number>();
  for (let t = 0; t < ctx.n; t++) tileOf.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);

  const rated = new Map<string, EffectiveBuilding | null>();
  const ratedAt = (t: number, buildingId: string) => {
    const key = `${t}|${buildingId}`;
    let r = rated.get(key);
    if (r === undefined) {
      const def = buildings.find((b) => b.id === buildingId);
      if (def) {
        const level = unlocks[buildingId] ?? 0;
        const baseValue = levelValue(
          def.levels[Math.min(level, def.levels.length - 1)],
        );
        r = ctx.rate(t, tierAtValue(def, baseValue, prestige));
      } else {
        r = null;
      }
      rated.set(key, r);
    }
    return r;
  };

  const placement: Placement = new Array(ctx.n).fill(null);
  return (board) => {
    placement.fill(null);
    for (const [key, buildingId] of board) {
      const t = tileOf.get(key);
      if (t === undefined) continue;
      placement[t] = ratedAt(t, buildingId);
    }
    return simulateIsland(placement, ctx).totalPower;
  };
}

/**
 * `boardPower` under several sets of research at once: one total per entry of
 * `prestiges`, in order.
 *
 * Research only changes what a tile is rated at, not the island context, so
 * the context — the expensive part — is built once and every set is scored on
 * it. This is what lets the Time Lab planner price a level of each stat
 * research across every island without rebuilding eight contexts per level.
 */
export function boardPowers(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  placedBuildings: readonly PlacedBuilding[],
  prestiges: readonly (PrestigeScales | undefined)[],
  anomaly: AnomalyDefinition = getAnomaly(undefined),
): number[] {
  if (!grid?.length || !grid[0]?.length || placedBuildings.length === 0) {
    return prestiges.map(() => 0);
  }
  const ctx = buildIslandContext(grid, undefined, anomaly);
  if (ctx.n === 0) return prestiges.map(() => 0);
  return prestiges.map((prestige) => {
    const { placement } = layoutFor(ctx, buildings, placedBuildings, prestige);
    return simulateIsland(placement, ctx).totalPower;
  });
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

/** One line on the board: `from` supplies `to`, both as tile coordinates. */
export interface Flow {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** A `Flow` as the board draws it: `direct` when it touches the focus itself. */
export interface BoardLink extends Flow {
  direct: boolean;
}

/**
 * The flows to draw for the building on `focus`: the ones touching it, and
 * with `chain` every flow reachable from it through linked buildings — the
 * whole network it is part of, so a reactor shows the coolers that keep its
 * generators running. Direction is ignored for reach (a generator's cooler is
 * as much part of the reactor's chain as the generator), and each flow appears
 * once.
 */
export function linksFrom(
  flows: readonly Flow[],
  focus: { x: number; y: number },
  chain: boolean,
): BoardLink[] {
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const start = key(focus);
  const reached = new Set([start]);
  const queue = [start];
  const taken = new Set<number>();
  const links: BoardLink[] = [];

  while (queue.length > 0) {
    const at = queue.shift()!;
    flows.forEach((f, i) => {
      if (taken.has(i)) return;
      const a = key(f.from);
      const b = key(f.to);
      if (a !== at && b !== at) return;
      taken.add(i);
      links.push({ ...f, direct: at === start });
      if (!chain) return;
      for (const next of [a, b]) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    });
  }
  return links;
}

/**
 * Every pair of buildings on the board that actually moved something on the
 * last tick: a reactor's heat into a generator, a cooler's cooling into a power
 * source. The board draws the ones touching the building under the pointer.
 *
 * Read off the same distribution that scores the board, not re-derived from
 * adjacency, because being *beside* a partner is not using it: a reactor whose
 * generators are already full sends nothing, and neither does a cooler beside a
 * source another cooler has covered. Under Cryo Nexus every working cooler
 * feeds every source the pool served, which is what the pool does.
 */
export function placementFlows(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  placedBuildings: PlacedBuilding[],
  prestige?: PrestigeScales,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
): Flow[] {
  if (!grid?.length || !grid[0]?.length || placedBuildings.length === 0) {
    return [];
  }
  const ctx = contextFor(grid, anomaly);
  if (ctx.n === 0) return [];

  const { placement } = layoutFor(ctx, buildings, placedBuildings, prestige);
  const pairs: number[] = [];
  simulateIsland(placement, ctx, true, pairs);

  const flows: Flow[] = [];
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k];
    const b = pairs[k + 1];
    flows.push({
      from: { x: ctx.xs[a], y: ctx.ys[a] },
      to: { x: ctx.xs[b], y: ctx.ys[b] },
    });
  }
  return flows;
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
  const rated = ratedPlacements(
    grid,
    buildings,
    placedBuildings,
    prestige,
    anomaly,
  );
  // The later of two placements on one tile is the one that stands — the same
  // tie-break `layoutFor` applies.
  for (let i = placedBuildings.length - 1; i >= 0; i--) {
    const p = placedBuildings[i];
    if (p.x === x && p.y === y) return rated[i];
  }
  return null;
}

/**
 * `ratedPlacementAt` for every building at once: what each row of
 * `placedBuildings` was rated for, in the same order, or null where nothing
 * buildable stands.
 *
 * The canvas needs every ceiling on the board each time it changes — the status
 * badges are a fill against it — and asking tile by tile would lay the board
 * out and score it once per building. This lays it out once, and resolves a
 * role isolation with the one `simulateIsland` call it costs, which is the
 * single reading of the rules `ratedPlacementAt` itself now goes through.
 */
export function ratedPlacements(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  placedBuildings: readonly PlacedBuilding[],
  prestige?: PrestigeScales,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
): (EffectiveBuilding | null)[] {
  const out: (EffectiveBuilding | null)[] = new Array(
    placedBuildings.length,
  ).fill(null);
  if (!grid?.length || !grid[0]?.length || placedBuildings.length === 0) {
    return out;
  }

  const ctx = contextFor(grid, anomaly);
  if (ctx.n === 0) return out;

  const { placement, rowOf } = layoutFor(
    ctx,
    buildings,
    placedBuildings,
    prestige,
  );
  if (ctx.isolation !== null) simulateIsland(placement, ctx, true);

  for (let t = 0; t < ctx.n; t++) {
    const i = rowOf[t];
    const rated = placement[t];
    if (i < 0 || rated === null) continue;
    out[i] = ctx.isolation === null ? rated : (ctx.ratedLayout[t] ?? rated);
  }
  return out;
}

/** Which way the board's rules moved a building off its plain tier. */
export type RatingShift = "up" | "down";

/**
 * For each row of `placedBuildings`, whether the tile it stands on rates it
 * above or below its plain tier — the question the game answers with the
 * anomaly icon at a building's foot — or null where nothing moved it.
 *
 * Read off the scorer rather than off the anomaly's rule, so the icon can only
 * appear where the figures it explains actually changed: a waterside bonus, an
 * isolated or crowded generator, a pooled cooler's scale. Research is in both
 * sides of the comparison and so cancels; what is left is the tile and the
 * board around it.
 *
 * Compared on the building's headline figure — energy for a direct producer,
 * whose `effectiveValue` is not what it is rated by, and `effectiveValue` for
 * every other role — with a relative tolerance, so float noise in a scale that
 * comes out at exactly 1 never paints an icon.
 */
export function ratingShifts(
  grid: Tile[][],
  buildings: readonly BuildingDefinition[],
  placedBuildings: readonly PlacedBuilding[],
  prestige?: PrestigeScales,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
): (RatingShift | null)[] {
  const rated = ratedPlacements(
    grid,
    buildings,
    placedBuildings,
    prestige,
    anomaly,
  );
  return placedBuildings.map((pb, i) => {
    const r = rated[i];
    if (r === null) return null;
    const def = buildings.find((b) => b.id === pb.buildingId);
    if (!def) return null;
    const plain = tierAtValue(def, pb.baseValue, prestige);
    const figure = (b: EffectiveBuilding) =>
      b.type === "direct_producer" ? b.energy : b.effectiveValue;
    const was = figure(plain);
    const now = figure(r);
    if (!(was > 0)) return null;
    const ratio = now / was;
    if (Math.abs(ratio - 1) < 1e-9) return null;
    return ratio > 1 ? "up" : "down";
  });
}
