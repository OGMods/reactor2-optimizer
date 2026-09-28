import { getAnomaly } from "../data/anomalies";
import { scaleEffectiveBuilding } from "../data/effectiveBuildings";
import { CHEBYSHEV_DIRECTIONS, spatialKeyCompare } from "./constants";
import { computeWaterAdjacency } from "./island";
import type {
  AnomalyDefinition,
  BuildingType,
  EffectiveBuilding,
  Tile,
  TileType,
} from "./types";

/**
 * Scratch buffers reused by every `runDistribution` call on one island.
 *
 * The distribution runs twice per simulation and a solve runs millions of
 * simulations, so allocating the flow matrix and the BFS arrays per call is
 * the single biggest avoidable cost in the hot path. They are sized once from
 * the island's tile count and reused; nothing survives across calls, so this
 * is a pure allocation optimization with no effect on any number produced.
 *
 * @lintignore named only so `IslandContext.dist` has a nameable type
 */
export class DistributionScratch {
  /** tile index -> supplier/consumer index, validated by a stamp so no clearing is needed. */
  readonly supIdxOf: Int32Array;
  readonly supIdxStamp: Int32Array;
  readonly conIdxOf: Int32Array;
  readonly conIdxStamp: Int32Array;
  stamp = 0;

  /** flow[sIdx * numConsumers + cIdx] */
  readonly flow: Float64Array;

  readonly supplierCap: Float64Array;
  readonly supplierSent: Float64Array;
  readonly consumerCap: Float64Array;
  readonly consumerReceived: Float64Array;
  /** Counted DOWN as the distribution runs: `cap - remaining` is not
   *  bit-identical to a separately accumulated sum, and the fixtures assert
   *  exactly. */
  readonly remSupplierCap: Float64Array;
  readonly remConsumerCap: Float64Array;
  readonly eligible: Int32Array;

  /** CSR-style adjacency: items[start[i] .. start[i + 1]) */
  readonly supAdjStart: Int32Array;
  readonly supAdjItems: Int32Array;
  readonly conAdjStart: Int32Array;
  readonly conAdjItems: Int32Array;

  readonly visitedToken: Int32Array;
  readonly parentNode: Int32Array;
  readonly queue: Int32Array;

  /**
   * Per-supplier FairShare round budget: the number of suppliers sharing that
   * supplier's connected component. Filled only when a solve actually needs a
   * second round.
   */
  readonly supRoundBudget: Int32Array;
  readonly componentOf: Int32Array;
  readonly componentMembers: Int32Array;
  readonly componentStart: Int32Array;
  readonly conSeen: Int32Array;
  readonly stack: Int32Array;

  constructor(n: number) {
    const totalNodes = n + n + 2;
    const maxAdj = n * CHEBYSHEV_DIRECTIONS.length;

    this.supIdxOf = new Int32Array(n);
    this.supIdxStamp = new Int32Array(n);
    this.conIdxOf = new Int32Array(n);
    this.conIdxStamp = new Int32Array(n);
    this.flow = new Float64Array(n * n);
    this.supplierCap = new Float64Array(n);
    this.supplierSent = new Float64Array(n);
    this.consumerCap = new Float64Array(n);
    this.consumerReceived = new Float64Array(n);
    this.remSupplierCap = new Float64Array(n);
    this.remConsumerCap = new Float64Array(n);
    this.eligible = new Int32Array(n);
    this.supAdjStart = new Int32Array(n + 1);
    this.supAdjItems = new Int32Array(maxAdj);
    this.conAdjStart = new Int32Array(n + 1);
    this.conAdjItems = new Int32Array(maxAdj);
    this.visitedToken = new Int32Array(totalNodes);
    this.parentNode = new Int32Array(totalNodes);
    this.queue = new Int32Array(totalNodes);
    this.supRoundBudget = new Int32Array(n);
    this.componentOf = new Int32Array(n);
    this.componentMembers = new Int32Array(n);
    this.componentStart = new Int32Array(n + 1);
    this.conSeen = new Int32Array(n);
    this.stack = new Int32Array(n);
  }
}

/**
 * One island's buildable tiles, indexed in the game's spatial processing order
 * (ascending X, then descending Y).
 *
 * Every solver stage addresses tiles by that index rather than by an (x, y)
 * pair: "ascending tile index" IS the spatial order the distribution rules
 * require, so supplier/consumer lists arrive pre-sorted and no stage ever has
 * to re-sort or re-derive adjacency.
 */
export interface IslandContext {
  /** Number of buildable (grass) tiles. */
  readonly n: number;
  /**
   * The rules this island is being solved under. Always present — `"none"` is
   * an anomaly like any other, so no stage has to branch on `undefined`.
   *
   * It rides on the context rather than being passed down the stages because
   * every stage already has one, and the two anomalies that will need a board
   * to answer (a shore bonus, a shared cooling pool) will want it exactly here,
   * beside the tile index and the adjacency they are defined over.
   *
   * The per-tile half of it is already resolved into `rate`; the rules that
   * depend on a layout rather than a tile read it here.
   */
  readonly anomaly: AnomalyDefinition;
  /**
   * True when `rate` is the identity: no tile and no role on this island rates a
   * building as anything but itself, so `ctx.rate(t, b) === b` for every pair.
   *
   * Hoisted out of `rate` so the common case is a single boolean rather than a
   * per-tile array read, and so a stage can skip the call entirely where that
   * reads better — which is exactly why the flag has to promise `rate`'s whole
   * behaviour rather than only its per-tile half. It read `tileScale === null`
   * once, which was true under a shared cooling pool while every cooler was
   * being scaled by 0.88: a stage taking the invitation above would have rated
   * Cryo coolers at their unscaled figures and returned a layout over-cooled on
   * paper that the game shuts down board-wide, with nothing failing anywhere.
   *
   * So it is false under a terrain bonus (a per-tile scale) *and* under a role
   * scale, and true under the rules that leave the roster alone — including
   * `role_isolation`, which is resolved by `simulateIsland` through
   * `rateIsolated` rather than by `rate`.
   */
  readonly uniformRating: boolean;
  /**
   * What `building` is worth **on this tile**, which is the building itself
   * unless a terrain bonus applies to it.
   *
   * Called where a building is written onto a tile rather than where its
   * figures are read, and that is the whole performance argument: a step of the
   * walk writes one or two tiles and then simulates the island, which reads
   * every occupied tile's three figures. Resolving at the write is some
   * twenty-five times less work, and it leaves `simulateIsland` — the hot path,
   * and the definition of what a layout scores — untouched.
   *
   * Scaling has to be resolved rather than computed here because a scaled
   * building's waste is `snapToAuthoredPrecision(heat - energy)`, and that snap
   * is a string round-trip. Each distinct (tile class, building) pair is built
   * once and then handed back.
   */
  rate(tile: number, building: EffectiveBuilding): EffectiveBuilding;
  /**
   * The per-role half of `rate` alone: `building` at whatever a rule scales its
   * whole role by, on every tile alike, and the building itself where no rule
   * does.
   *
   * For the stages that count rather than place — hub fits, composition
   * targets, the polish candidates — which have no tile to ask `rate` about and
   * yet must reason in the units the board will hold. Under a shared cooling
   * pool every cooler is worth x0.88 wherever it stands, and a count made from
   * the plain figure under-provisions cooling by exactly that: every target the
   * retarget proposed was short by 8-14%, and under a pool a short board is an
   * offline board.
   */
  rateRole(building: EffectiveBuilding): EffectiveBuilding;
  /**
   * The role-isolation rule in force, or `null` under every other anomaly.
   *
   * This one cannot be folded into a tile the way a terrain bonus can: a
   * building's rating is a function of *what its neighbours are*, so placing
   * one re-rates up to eight other tiles and the answer changes with every move
   * the search makes. It is resolved per layout instead, by `simulateIsland`,
   * which is the one place a whole layout is in hand.
   */
  readonly isolation: RoleIsolation | null;
  /**
   * `building` rated for a tile that does, or does not, touch another building
   * of the isolated role.
   *
   * A lookup rather than a multiply, for the reason `rate` is: the scaled
   * waste is a snapped difference and the snap is a string round-trip. There
   * are only two variants of each roster entry, so they are built once per
   * island and handed back for the rest of the solve.
   */
  rateIsolated(building: EffectiveBuilding, crowded: boolean): EffectiveBuilding;
  /**
   * A whole-layout scratch buffer, reused by `simulateIsland` when a rule has
   * to resolve a layout before scoring it.
   *
   * One array per island rather than one per call: the search runs millions of
   * simulations, and this is the same argument every other buffer here is held
   * for.
   */
  readonly ratedLayout: (EffectiveBuilding | null)[];
  readonly xs: Int32Array;
  readonly ys: Int32Array;
  /** Chebyshev-adjacent buildable tiles of each tile, ascending index order. */
  readonly neighbors: Int32Array[];
  /** All tile indices, ascending — handed to stages that iterate the island. */
  readonly tiles: Int32Array;
  readonly dist: DistributionScratch;
  /** Per-tile scratch used by `simulateIsland`. */
  readonly heatIn: Float64Array;
  readonly wasteOf: Float64Array;
  readonly coolingIn: Float64Array;
  readonly heatOut: Float64Array;
  readonly powerOf: Float64Array;
  /** Per-role tile lists rebuilt by each `simulateIsland` call. */
  readonly reactorTiles: Int32Array;
  readonly generatorTiles: Int32Array;
  readonly dpTiles: Int32Array;
  readonly coolerTiles: Int32Array;
  readonly wasteTiles: Int32Array;
}

/** The resolved `role_isolation` rule: which role, and its two multipliers. */
export interface RoleIsolation {
  readonly role: BuildingType;
  readonly isolated: number;
  readonly crowded: number;
}

/**
 * The per-tile stat multiplier a terrain bonus produces, or `null` when every
 * tile on this island rates the same.
 *
 * Indexed by context tile index, so it lines up with `xs` / `ys` and with the
 * placement array rather than with the window.
 *
 * Resolved once per island because nothing about a layout can change it: which
 * tiles qualify is decided by terrain alone. It is the cheapest possible shape
 * for the rule and the reason a terrain bonus costs the search nothing.
 *
 * `null` rather than an array of ones so the common case — every anomaly but
 * this one — is a single check instead of a per-tile read.
 */
function terrainScales(
  localGrid: Tile[][],
  anomaly: AnomalyDefinition,
  xs: Int32Array,
  ys: Int32Array,
  n: number,
  waterAdjacent?: Uint8Array,
): Float64Array | null {
  if (anomaly.rule !== "terrain_affinity") return null;

  const height = localGrid.length;
  const width = localGrid[0]?.length ?? 0;
  // Off the board counts as water, so the shore mask answers the water half and
  // is the only half that can see past the window. Computed here when the
  // caller handed over a whole board rather than an island window.
  const shore = anomaly.terrain.includes("water")
    ? (waterAdjacent ?? computeWaterAdjacency(localGrid))
    : undefined;
  // Everything else is ordinary terrain, which cannot lie outside the window:
  // no rock or tree exists off the board.
  const other = new Set<TileType>(
    anomaly.terrain.filter((type) => type !== "water"),
  );

  const scales = new Float64Array(n);
  let anyScaled = false;

  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    let qualifies = shore !== undefined && shore[y * width + x] === 1;

    if (!qualifies && other.size > 0) {
      for (const [dx, dy] of CHEBYSHEV_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (other.has(localGrid[ny][nx].type)) {
          qualifies = true;
          break;
        }
      }
    }

    scales[i] = qualifies ? anomaly.multiplier : 1;
    if (qualifies) anyScaled = true;
  }

  // An island wholly inland under a shore bonus rates like any other: say so,
  // and every tile of it skips the lookup.
  return anyScaled ? scales : null;
}

/**
 * Builds the tile index and adjacency for one island's buildable tiles.
 *
 * `buildable` is an `IslandSubGrid`'s mask, indexed `y * width + x` over the
 * same window. Pass it whenever the grid is an island window: the window holds
 * the board's real terrain, so a *neighbouring* island's grass sits inside it
 * and is grass, and without the mask those tiles would join this island's
 * index. Omitted, every grass tile counts — which is what a caller handing over
 * a whole grid of its own means.
 *
 * `waterAdjacent` is the same window's shore mask, and a terrain bonus needs
 * it: off the board counts as water, and an island window is clamped to the
 * board, so a tile on the board's own edge has no off-board neighbour inside
 * the window to find. Omitted, it is computed from `localGrid` with everything
 * outside it treated as water — which is exactly right for a caller handing
 * over the whole board, and too generous for one handing over an island window,
 * so `IslandSubGrid` carries a mask and both island callers pass it.
 */
export function buildIslandContext(
  localGrid: Tile[][],
  buildable?: Uint8Array,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
  waterAdjacent?: Uint8Array,
): IslandContext {
  const gridWidth = localGrid[0]?.length ?? 0;
  const coords: [number, number][] = [];
  for (const row of localGrid) {
    for (const tile of row) {
      const mine = buildable
        ? buildable[tile.y * gridWidth + tile.x] === 1
        : tile.type === "grass";
      if (mine) coords.push([tile.x, tile.y]);
    }
  }
  coords.sort(spatialKeyCompare);

  const n = coords.length;
  const xs = new Int32Array(n);
  const ys = new Int32Array(n);
  const tiles = new Int32Array(n);
  const byPos = new Map<number, number>();
  let maxX = 0;
  for (const [x] of coords) if (x > maxX) maxX = x;
  const stride = maxX + 2;

  for (let i = 0; i < n; i++) {
    xs[i] = coords[i][0];
    ys[i] = coords[i][1];
    tiles[i] = i;
    byPos.set(coords[i][1] * stride + coords[i][0], i);
  }

  const neighbors: Int32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const found: number[] = [];
    for (const [dx, dy] of CHEBYSHEV_DIRECTIONS) {
      const nx = xs[i] + dx;
      const ny = ys[i] + dy;
      if (nx < 0 || ny < 0) continue;
      const idx = byPos.get(ny * stride + nx);
      if (idx !== undefined) found.push(idx);
    }
    // Ascending index == ascending spatial key, which is the order the
    // distribution rules process neighbors in.
    found.sort((a, b) => a - b);
    neighbors[i] = Int32Array.from(found);
  }

  const tileScale = terrainScales(
    localGrid,
    anomaly,
    xs,
    ys,
    n,
    waterAdjacent,
  );
  // A uniform scale on one role, which is what Cryo Nexus does to coolers: the
  // game applies its 0.88 to `CoolerBuilding.CoolingPerSec`, so it is what a
  // cooler is worth rather than a charge levied at the pool.
  //
  // Only ever one of these two is in force, because only one anomaly runs at a
  // time — so the product below is always a multiply by exactly 1.0 on one
  // side, and never the two-factor rounding `scaleEffectiveBuilding` guards
  // against.
  const roleScale: Partial<Record<BuildingType, number>> | null =
    anomaly.rule === "shared_cooling"
      ? { cooler: anomaly.coolerMultiplier }
      : null;
  // Exactly `rate`'s own early-out below, so the flag cannot promise more than
  // the call it stands in for delivers.
  const uniformRating = tileScale === null && roleScale === null;
  // One cache per distinct scale, so a building is built at a given rating
  // once per island rather than once per placement. Keyed on the base object
  // because the roster is shared by every tile and its entries are stable for
  // the whole solve.
  const isolation: RoleIsolation | null =
    anomaly.rule === "role_isolation"
      ? {
          role: anomaly.role,
          isolated: anomaly.isolated,
          crowded: anomaly.crowded,
        }
      : null;
  const rated = new Map<number, Map<EffectiveBuilding, EffectiveBuilding>>();
  // Every scaled variant back to the roster entry it came from, so `rate` can
  // be applied to a building that already carries a rating. The search swaps
  // buildings between tiles and restores them afterwards, so it hands back
  // objects it was given — without this, a swap would scale a scaled building
  // and the layout would quietly be worth 2.8x.
  const baseOf = new Map<EffectiveBuilding, EffectiveBuilding>();

  /**
   * `building` at `scale`, built once per distinct pair.
   *
   * Idempotent: a building arriving with a rating already on it is taken back
   * to its roster entry first, so this is a function of the scale rather than
   * of how many times it has been applied. The search swaps buildings between
   * tiles and restores them when a move is rejected, so it hands back objects
   * it was given — without this, a restore would scale a scaled building.
   */
  const scaledBy = (
    building: EffectiveBuilding,
    scale: number,
  ): EffectiveBuilding => {
    const base = baseOf.get(building) ?? building;
    if (scale === 1) return base;

    let byBuilding = rated.get(scale);
    if (byBuilding === undefined) {
      byBuilding = new Map();
      rated.set(scale, byBuilding);
    }
    let scaled = byBuilding.get(base);
    if (scaled === undefined) {
      scaled = scaleEffectiveBuilding(base, scale);
      byBuilding.set(base, scaled);
      baseOf.set(scaled, base);
    }
    return scaled;
  };

  return {
    n,
    anomaly,
    uniformRating,
    isolation,
    ratedLayout: new Array<EffectiveBuilding | null>(n).fill(null),
    rateIsolated(
      building: EffectiveBuilding,
      crowded: boolean,
    ): EffectiveBuilding {
      if (isolation === null) return building;
      return scaledBy(
        building,
        crowded ? isolation.crowded : isolation.isolated,
      );
    },
    rateRole(building: EffectiveBuilding): EffectiveBuilding {
      if (roleScale === null) return building;
      return scaledBy(building, roleScale[building.type] ?? 1);
    },
    rate(tile: number, building: EffectiveBuilding): EffectiveBuilding {
      if (tileScale === null && roleScale === null) return building;
      // Idempotent: a building arriving with another tile's rating is taken
      // back to its roster entry first, so this is a function of the tile and
      // the role rather than of how many times it has been applied.
      const byTile = tileScale === null ? 1 : tileScale[tile];
      const byRole = roleScale?.[building.type] ?? 1;
      return scaledBy(building, byTile * byRole);
    },
    xs,
    ys,
    neighbors,
    tiles,
    dist: new DistributionScratch(n),
    heatIn: new Float64Array(n),
    wasteOf: new Float64Array(n),
    coolingIn: new Float64Array(n),
    heatOut: new Float64Array(n),
    powerOf: new Float64Array(n),
    reactorTiles: new Int32Array(n),
    generatorTiles: new Int32Array(n),
    dpTiles: new Int32Array(n),
    coolerTiles: new Int32Array(n),
    wasteTiles: new Int32Array(n),
  };
}
