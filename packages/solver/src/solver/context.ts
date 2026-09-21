import { getAnomaly } from "../data/anomalies";
import { CHEBYSHEV_DIRECTIONS, spatialKeyCompare } from "./constants";
import type { AnomalyDefinition, Tile } from "./types";

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
   * **Nothing reads it yet.** The rules are not implemented — see
   * `docs/game-logic.md`. It is threaded so that implementing them is a change
   * to the stages and not to every signature between here and the worker.
   */
  readonly anomaly: AnomalyDefinition;
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

/**
 * Builds the tile index and adjacency for one island's buildable tiles.
 *
 * `buildable` is an `IslandSubGrid`'s mask, indexed `y * width + x` over the
 * same window. Pass it whenever the grid is an island window: the window holds
 * the board's real terrain, so a *neighbouring* island's grass sits inside it
 * and is grass, and without the mask those tiles would join this island's
 * index. Omitted, every grass tile counts — which is what a caller handing over
 * a whole grid of its own means.
 */
export function buildIslandContext(
  localGrid: Tile[][],
  buildable?: Uint8Array,
  anomaly: AnomalyDefinition = getAnomaly(undefined),
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

  return {
    n,
    anomaly,
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
