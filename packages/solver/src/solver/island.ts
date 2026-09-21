import {
  CHEBYSHEV_DIRECTIONS,
  EPS,
  GENERATOR_ENERGY_RATIO,
  GENERATOR_WASTE_RATIO,
} from "./constants";
import { generatorEnergyRatio, generatorWasteRatio } from "./physics";
import type {
  AnomalyDefinition,
  EffectiveBuilding,
  IslandSubGrid,
  Tile,
} from "./types";

/**
 * Island decomposition and per-island upper bounds.
 *
 * A grid's buildable tiles split into 8-neighbor connected components —
 * islands — that cannot influence each other, so each is solved independently.
 */

export function countGrassTiles(grid: Tile[][]): number {
  let count = 0;
  for (const row of grid) {
    for (const tile of row) {
      if (tile.type === "grass") count++;
    }
  }
  return count;
}

/**
 * True if a single cooler can fully absorb some direct producer's waste.
 *
 * This sets the minimum viable island size: a Direct Producer + Cooler pair
 * needs only 2 tiles, whereas a Reactor + Generator + Cooler chain needs 3.
 */
export function canCoolDirectProducer(roster: EffectiveBuilding[]): boolean {
  let maxCooling = -Infinity;
  for (const b of roster) {
    if (b.type === "cooler" && b.effectiveValue > maxCooling)
      maxCooling = b.effectiveValue;
  }
  if (maxCooling === -Infinity) return false;

  for (const b of roster) {
    if (b.type !== "direct_producer") continue;
    if (b.waste <= maxCooling) return true;
  }
  return false;
}

/**
 * The fewest tiles a patch needs before anything on it can be worth building.
 *
 * Both floors exist for one reason: cooling has to cross a tile boundary, so a
 * producer needs a cooler beside it. A reactor + generator + cooler chain is
 * 3 tiles; a direct producer needs no reactor, so it is 2 when one cooler can
 * cover one producer's whole waste.
 *
 * A shared cooling pool removes that reason, and removes the decomposition with
 * it — the board is then one island and there is nothing here to apply. See
 * `wholeBoardIsland`.
 */
export function minIslandTiles(canCoolDp: boolean): number {
  return canCoolDp ? 2 : 3;
}

/**
 * Whether each tile has water among its eight neighbours, **off the board
 * counting as water**. Indexed `y * width + x` over the full grid.
 *
 * Resolved here, on the whole board, because it cannot be resolved anywhere
 * downstream: an `IslandSubGrid`'s padding is clamped to the board, so a tile on
 * the board's own edge has no off-board neighbour inside its window to test.
 *
 * Off the board is water because the game has one global map on which every
 * island sits in open water, and these boards are rectangles cut out of it — so
 * the water past an edge is real water this rectangle does not include. A pond
 * is not water; it is an obstacle, like a rock. See `docs/game-logic.md`.
 */
export function computeWaterAdjacency(grid: Tile[][]): Uint8Array {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const flags = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let shore = false;
      for (const [dx, dy] of CHEBYSHEV_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          shore = true;
          break;
        }
        if (grid[ny][nx]?.type === "water") {
          shore = true;
          break;
        }
      }
      if (shore) flags[y * width + x] = 1;
    }
  }

  return flags;
}

/**
 * The whole board as a single island: every grass tile, with the board itself
 * as the window.
 *
 * Under a shared cooling pool the components `splitGridIntoIslands` would
 * produce are **not** independent — every cooler anywhere pays into one pool
 * that every power source anywhere draws from — so solving them apart is
 * simply wrong. Handing the board over whole makes the pool board-wide by
 * construction, and costs nothing in the rest of the simulation: heat stays
 * adjacency-bound because `runDistribution` already scopes its round budget and
 * its repair to each connected component of the supplier/consumer graph, which
 * is a finer partition than the island. `simulator.test.ts` is where that is
 * pinned, for the whole-board context the readout has always used.
 *
 * The price is per-island parallelism: one island is one pool task, so a board
 * of two large landmasses searches on one core where it could have used two.
 * On the shipped maps that is a small loss — most are one landmass and a few
 * scraps, so one island already holds about 95% of the budget — and it buys the
 * whole board-level problem for nothing. Solving the components separately
 * would mean describing each by a frontier of power against net cooling
 * contributed and combining those under one scalar budget, which is a different
 * and much larger machine.
 *
 * Every grass tile is included, however isolated: a lone tile takes a cooler
 * that pays into the pool, or a direct producer the pool pays for, so there is
 * no minimum size here to apply.
 */
function wholeBoardIsland(grid: Tile[][]): IslandSubGrid {
  const height = grid.length;
  const width = grid[0].length;
  const buildable = new Uint8Array(width * height);
  const originalTileIndices = new Int32Array(width * height);
  const tiles: Tile[][] = [];
  let tileCount = 0;

  for (let y = 0; y < height; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x++) {
      const flat = y * width + x;
      originalTileIndices[flat] = flat;
      if (grid[y][x]?.type === "grass") {
        buildable[flat] = 1;
        tileCount++;
      }
      row.push({ x, y, type: grid[y][x].type });
    }
    tiles.push(row);
  }

  return {
    width,
    height,
    grid: tiles,
    buildable,
    waterAdjacent: computeWaterAdjacency(grid),
    tileCount,
    originalTileIndices,
  };
}

/**
 * Splits the grid into independently solvable sub-grids of buildable tiles.
 * Components too small to ever be worth building on are dropped.
 *
 * `anomaly` is taken because the floor is a property of the rules in force
 * rather than of the grid — see `minIslandTiles`. Under a shared cooling pool
 * the islands this produces are no longer independent either, which is the
 * board-level problem and not this function's.
 */
export function splitGridIntoIslands(
  grid: Tile[][],
  canCoolDp = true,
  anomaly?: AnomalyDefinition,
): IslandSubGrid[] {
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) return [];

  // A shared cooling pool is the one rule that reaches across the whole board,
  // so under it the board is one island and the decomposition does not apply.
  if (anomaly?.rule === "shared_cooling") return [wholeBoardIsland(grid)];

  const originalHeight = grid.length;
  const originalWidth = grid[0].length;
  const minTilesRequired = minIslandTiles(canCoolDp);
  const waterAdjacent = computeWaterAdjacency(grid);

  // 1. Only grass is buildable; everything else is an impassable boundary.
  const buildable = new Uint8Array(originalWidth * originalHeight);
  for (let y = 0; y < originalHeight; y++) {
    for (let x = 0; x < originalWidth; x++) {
      if (grid[y][x]?.type === "grass") buildable[y * originalWidth + x] = 1;
    }
  }

  const visited = new Uint8Array(originalWidth * originalHeight);
  const subGrids: IslandSubGrid[] = [];
  const queue = new Int32Array(originalWidth * originalHeight);

  for (let y = 0; y < originalHeight; y++) {
    for (let x = 0; x < originalWidth; x++) {
      const start = y * originalWidth + x;
      if (visited[start] || !buildable[start]) continue;

      // 2. BFS connected-component search
      const component: number[] = [];
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (head < tail) {
        const flat = queue[head++];
        const cx = flat % originalWidth;
        const cy = (flat - cx) / originalWidth;
        component.push(flat);

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const [dx, dy] of CHEBYSHEV_DIRECTIONS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= originalWidth || ny < 0 || ny >= originalHeight)
            continue;
          const nFlat = ny * originalWidth + nx;
          if (!visited[nFlat] && buildable[nFlat]) {
            visited[nFlat] = 1;
            queue[tail++] = nFlat;
          }
        }
      }

      if (component.length < minTilesRequired) continue;

      // 3. Window the board around the component and build the sub-grid.
      //
      // Padded by one tile on every side so that every neighbour of every
      // island tile is inside the window: a rule that reads terrain (a shore
      // bonus, say) has to be answerable for a building on the island's own
      // edge, and the component's bare bounding box cuts exactly those
      // neighbours off.
      const padMinX = minX > 0 ? minX - 1 : 0;
      const padMinY = minY > 0 ? minY - 1 : 0;
      const padMaxX = maxX < originalWidth - 1 ? maxX + 1 : maxX;
      const padMaxY = maxY < originalHeight - 1 ? maxY + 1 : maxY;

      const subWidth = padMaxX - padMinX + 1;
      const subHeight = padMaxY - padMinY + 1;
      const inComponent = new Uint8Array(subWidth * subHeight);
      for (const flat of component) {
        const cx = flat % originalWidth;
        const cy = (flat - cx) / originalWidth;
        inComponent[(cy - padMinY) * subWidth + (cx - padMinX)] = 1;
      }

      const subGridTiles: Tile[][] = [];
      const originalTileIndices = new Int32Array(subWidth * subHeight);
      const subWaterAdjacent = new Uint8Array(subWidth * subHeight);

      for (let subY = 0; subY < subHeight; subY++) {
        const row: Tile[] = [];
        const origY = padMinY + subY;
        for (let subX = 0; subX < subWidth; subX++) {
          const origX = padMinX + subX;
          const localFlat = subY * subWidth + subX;
          const origFlat = origY * originalWidth + origX;
          originalTileIndices[localFlat] = origFlat;
          // Copied from the full-grid pass rather than recomputed here: this
          // window cannot see off the board. See `computeWaterAdjacency`.
          subWaterAdjacent[localFlat] = waterAdjacent[origFlat];
          // The board's own terrain, not a "mine / not mine" flag — that is
          // what `inComponent` is, and it is carried separately because a
          // neighbouring island's grass is real grass and still not ours.
          row.push({ x: subX, y: subY, type: grid[origY][origX].type });
        }
        subGridTiles.push(row);
      }

      subGrids.push({
        width: subWidth,
        height: subHeight,
        grid: subGridTiles,
        buildable: inComponent,
        waterAdjacent: subWaterAdjacent,
        tileCount: component.length,
        originalTileIndices,
      });
    }
  }

  return subGrids;
}

/**
 * A TRUE upper bound on a single island's power: no layout on this island can
 * exceed it, so the "layout efficiency" figure it feeds never reads above 100%
 * (the earlier per-hub density estimate ignored cross-hub sharing of reactors
 * and coolers, which real layouts exploit, and was routinely beaten by 3-50%).
 *
 * The bound relaxes adjacency away entirely and asks only what the tile COUNTS
 * allow. For every split of the island into `nEngine` tiles (reactors +
 * generators), `nDp` direct producers and `nCool` coolers, any layout obeys
 *
 *     heat absorbed  H <= min(nReact * R_top, nGen * G_top)
 *     online DPs     D <= nDp
 *     total cooling  0.25 * H + wMin * D <= nCool * C_top
 *
 * and produces at most `0.75 * H + netMax * D`, where `netMax` / `wMin` are the
 * best net power and smallest waste any unlocked direct producer can have.
 * Maximizing that tiny LP over all splits gives the bound. On the 67-tile map 1
 * island it lands ~2% above the known optimum, so the efficiency figure it
 * produces is meaningful, not just safe.
 *
 * Anything a real layout must additionally respect — adjacency, the
 * all-or-nothing cooling rule, whole buildings rather than fractional ones —
 * only lowers achievable power below this.
 */
function estimateIslandMaxPower(
  island: IslandSubGrid,
  roster: EffectiveBuilding[],
): number {
  const buildableTiles = island.tileCount;
  if (buildableTiles <= 0) return 0.0;

  let cVal = 0.0;
  let rVal = 0.0;
  let gVal = 0.0;
  let dpNet = 0.0;
  let dpWaste = Infinity;
  let hasCooler = false;
  let hasDp = false;
  // The bound must not sit below a layout the solver actually builds, so it
  // takes the greediest energy ratio and the stingiest waste ratio any unlocked
  // generator can offer -- they need not come from the same tier.
  let energyRatio = -Infinity;
  let wasteRatio = Infinity;

  for (const b of roster) {
    if (b.type === "cooler") {
      hasCooler = true;
      if (b.effectiveValue > cVal) cVal = b.effectiveValue;
    } else if (b.type === "generator") {
      if (b.effectiveValue > gVal) gVal = b.effectiveValue;
      const e = generatorEnergyRatio(b);
      if (e > energyRatio) energyRatio = e;
      const w = generatorWasteRatio(b);
      if (w < wasteRatio) wasteRatio = w;
    } else if (b.type === "reactor") {
      if (b.effectiveValue > rVal) rVal = b.effectiveValue;
    } else {
      // A mixed DP roster is bounded by its best net power and its smallest
      // cooling appetite -- each real DP produces no more and cools no less.
      hasDp = true;
      if (b.energy > dpNet) dpNet = b.energy;
      if (b.waste < dpWaste) dpWaste = b.waste;
    }
  }

  if (!hasCooler || cVal <= 0) return 0.0;
  if (!hasDp) dpWaste = 0.0;
  if (energyRatio === -Infinity) energyRatio = GENERATOR_ENERGY_RATIO;
  if (wasteRatio === Infinity || wasteRatio <= 0)
    wasteRatio = GENERATOR_WASTE_RATIO;

  // The same 3-and-2 reasoning `minIslandTiles` owns — a reactor + generator +
  // cooler chain is 3 tiles, a direct producer + cooler pair is 2 — restated
  // here rather than read from it, because that function answers "is this patch
  // worth keeping?" for a whole board and this asks "can this split produce
  // anything?" for one island already kept. They must not be allowed to
  // disagree: raise the floor there and these two numbers have to follow, or the
  // bound goes on allowing a layout the decomposition no longer admits (which is
  // still a bound, so nothing would fail) — or worse, lower it there and the
  // bound becomes one a real layout beats.
  const canHub = rVal > 0 && gVal > 0 && buildableTiles >= 3;
  const canDp = hasDp && buildableTiles >= 2;
  if (!canHub && !canDp) return 0.0;

  let best = 0.0;
  const maxEngine = canHub ? buildableTiles : 0;

  for (let nEngine = 0; nEngine <= maxEngine; nEngine++) {
    const heatCap = bestHeatForEngineTiles(nEngine, rVal, gVal);
    // Engine tiles that can't form a reactor+generator pair.
    if (nEngine > 0 && heatCap <= 0.0) continue;

    const maxDp = canDp ? buildableTiles - nEngine : 0;
    for (let nDp = 0; nDp <= maxDp; nDp++) {
      const nCool = buildableTiles - nEngine - nDp;
      // Nothing runs on an island with zero coolers.
      if (nCool < 1) continue;
      const cooling = nCool * cVal;

      // Maximize 0.75*H + dpNet*D under the shared cooling budget: a
      // two-variable LP whose optimum sits at one of the two "fill one side
      // first" corners.
      const hFirst = Math.min(heatCap, cooling / wasteRatio);
      const dRest =
        dpWaste <= EPS
          ? nDp
          : Math.min(nDp, (cooling - hFirst * wasteRatio) / dpWaste);
      const pHeatFirst = hFirst * energyRatio + dpNet * dRest;

      const dFirst = dpWaste <= EPS ? nDp : Math.min(nDp, cooling / dpWaste);
      const hRest = Math.min(
        heatCap,
        (cooling - dpWaste * dFirst) / wasteRatio,
      );
      const pDpFirst = hRest * energyRatio + dpNet * dFirst;

      if (pHeatFirst > best) best = pHeatFirst;
      if (pDpFirst > best) best = pDpFirst;
    }
  }

  return best;
}

/**
 * Most heat `nEngine` tiles of reactors + generators can hand over, cooling
 * ignored: max over nReact of `min(nReact * rVal, (nEngine - nReact) * gVal)`.
 * The min of two crossing lines peaks where they intersect, so only the two
 * integer counts around the crossing need checking.
 */
function bestHeatForEngineTiles(
  nEngine: number,
  rVal: number,
  gVal: number,
): number {
  if (nEngine < 2 || rVal <= 0 || gVal <= 0) return 0.0;

  const crossing = (nEngine * gVal) / (rVal + gVal);
  let best = 0.0;
  for (const nReact of [Math.floor(crossing), Math.floor(crossing) + 1]) {
    if (nReact >= 1 && nReact <= nEngine - 1) {
      const heat = Math.min(nReact * rVal, (nEngine - nReact) * gVal);
      if (heat > best) best = heat;
    }
  }
  return best;
}

/**
 * The largest multiplier any building on this island can be rated at.
 *
 * One number for the island rather than one per tile, because it is used to
 * keep the bound a bound: `estimateIslandMaxPower` is positively homogeneous of
 * degree 1 in the roster's figures — `hFirst`, `dRest`, `dFirst` and `hRest` all
 * scale by `k` and every ratio in it is invariant — so scaling its *result* by
 * `k` is the same thing as scaling every roster figure by `k`, and rating the
 * whole island at its best tile is an upper bound on rating each tile at its
 * own.
 *
 * That argument is what lets a rule that scales only *some* buildings be
 * answered with one island-wide number: any layout feasible under the partial
 * scaling is feasible in the all-scaled world with an objective no larger.
 * Under generator-only scaling, say, `H <= min(nReact * rVal, nGen * k * gVal)
 * <= k * heatCap`, the cooling constraint at `k * dpWaste` is implied by the
 * real one since `H / k <= H`, and the objective at `k * dpNet` dominates.
 *
 * It is loose by construction where only part of an island qualifies, or where
 * only part of the roster is scaled, and that is the right trade: a bound that
 * can be beaten is worthless, while one that is generous only makes the
 * efficiency figure read low.
 *
 * The switch is exhaustive without a `default`, deliberately: a fifth rule shape
 * added to `AnomalyDefinition` then fails to typecheck here — "function lacks
 * ending return statement" — rather than silently defaulting to 1, which is what
 * `role_isolation` did until a partial roster walked past the bound by 64%.
 */
function islandMaxScale(
  island: IslandSubGrid,
  anomaly?: AnomalyDefinition,
): number {
  if (anomaly === undefined) return 1;

  switch (anomaly.rule) {
    case "baseline":
      return 1;

    case "shared_cooling":
      // A scale on the cooler role alone. The shipped 0.88 only ever *costs*
      // cooling, so this is 1 today and the bound is untouched; a pool that
      // paid more than it took would raise the cooling budget, and by the
      // homogeneity above that is bounded by scaling the whole roster.
      return Math.max(anomaly.coolerMultiplier, 1);

    case "role_isolation":
      // Both variants, because which one a tile gets is a function of the
      // layout rather than of the island: `simulateIsland` re-rates a generator
      // from what its neighbours are, so a search free to keep generators apart
      // rates every one of them at `isolated`. The bound has to allow that even
      // though it is the *penalty* that is usually binding — a roster whose
      // generator intake is the short side of `min(nReact * rVal, nGen * gVal)`
      // gets x2.5 of its heat cap, and a 3x3 layout beat the "TRUE upper bound"
      // by 64% before this case existed.
      return Math.max(anomaly.isolated, anomaly.crowded, 1);

    case "terrain_affinity": {
      if (anomaly.multiplier <= 1) return 1;
      // Water is the one terrain that can lie *off* the board, and the shore
      // mask is the only thing that knows it — so the scan below answers the
      // question exactly when water is the whole of the list. A list naming
      // anything else qualifies a tile on a neighbour this window can see but
      // the mask cannot speak for (`terrainScales` tests rock and tree against
      // the grid), and one that mixed the two would need both answers at once.
      // Erring high there keeps this a bound; a landlocked island under a
      // `["water", "rock"]` anomaly would otherwise rate its tiles at the
      // multiplier while the bound stayed at 1.
      if (anomaly.terrain.length !== 1 || anomaly.terrain[0] !== "water")
        return anomaly.multiplier;

      for (let i = 0; i < island.buildable.length; i++) {
        if (island.buildable[i] === 1 && island.waterAdjacent[i] === 1)
          return anomaly.multiplier;
      }
      return 1;
    }
  }
}

/**
 * Sum of theoretical max power across all valid island sub-grids.
 *
 * `anomaly` is taken because the bound has to hold under the rules the search
 * is actually running: a terrain bonus rates some tiles above their authored
 * figures, and a bound computed on the plain roster is one a real layout beats.
 * The "layout efficiency" figure this feeds then reads above 100%, which is the
 * visible half of the problem; the invisible half is that nothing else in the
 * solver is entitled to assume the bound holds either.
 */
export function estimateTotalMaxPower(
  islands: IslandSubGrid[],
  roster: EffectiveBuilding[],
  anomaly?: AnomalyDefinition,
): number {
  let total = 0;
  for (const island of islands)
    total +=
      estimateIslandMaxPower(island, roster) * islandMaxScale(island, anomaly);
  return total;
}
