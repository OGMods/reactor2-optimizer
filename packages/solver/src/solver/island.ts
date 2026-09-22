import {
  CHEBYSHEV_DIRECTIONS,
  EPS,
  GENERATOR_ENERGY_RATIO,
  GENERATOR_WASTE_RATIO,
} from "./constants";
import { generatorEnergyRatio, generatorWasteRatio } from "./physics";
import { scaleEffectiveBuilding } from "../data/effectiveBuildings";
import type {
  AnomalyDefinition,
  EffectiveBuilding,
  IslandSubGrid,
  TerrainAffinityAnomaly,
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
 * The roster reduced to the figures the bound runs on: the best of each role,
 * with the ratios a generator's power and waste are bounded through.
 *
 * The bound must not sit below a layout the solver actually builds, so it
 * takes the greediest energy ratio and the stingiest waste ratio any unlocked
 * generator can offer -- they need not come from the same tier. A mixed DP
 * roster is likewise bounded by its best net power and its smallest cooling
 * appetite -- each real DP produces no more and cools no less. The sentinels
 * are left in place for the caller to resolve, because the two-class bound
 * below takes its ratios across two rosters before it falls back.
 */
interface RosterFigures {
  cVal: number;
  rVal: number;
  gVal: number;
  dpNet: number;
  /** `Infinity` when the roster has no direct producer. */
  dpWaste: number;
  hasCooler: boolean;
  hasDp: boolean;
  /** `-Infinity` when the roster has no generator. */
  energyRatio: number;
  /** `Infinity` when the roster has no generator. */
  wasteRatio: number;
}

function rosterFigures(roster: EffectiveBuilding[]): RosterFigures {
  const f: RosterFigures = {
    cVal: 0.0,
    rVal: 0.0,
    gVal: 0.0,
    dpNet: 0.0,
    dpWaste: Infinity,
    hasCooler: false,
    hasDp: false,
    energyRatio: -Infinity,
    wasteRatio: Infinity,
  };

  for (const b of roster) {
    if (b.type === "cooler") {
      f.hasCooler = true;
      if (b.effectiveValue > f.cVal) f.cVal = b.effectiveValue;
    } else if (b.type === "generator") {
      if (b.effectiveValue > f.gVal) f.gVal = b.effectiveValue;
      const e = generatorEnergyRatio(b);
      if (e > f.energyRatio) f.energyRatio = e;
      const w = generatorWasteRatio(b);
      if (w < f.wasteRatio) f.wasteRatio = w;
    } else if (b.type === "reactor") {
      if (b.effectiveValue > f.rVal) f.rVal = b.effectiveValue;
    } else {
      f.hasDp = true;
      if (b.energy > f.dpNet) f.dpNet = b.energy;
      if (b.waste < f.dpWaste) f.dpWaste = b.waste;
    }
  }

  return f;
}

/**
 * A TRUE upper bound on a single island's power: no layout on this island can
 * exceed it, so the "layout efficiency" figure it feeds never reads above 100%
 * (the earlier per-hub density estimate ignored cross-hub sharing of reactors
 * and coolers, which real layouts exploit, and was routinely beaten by 3-50%).
 *
 * The bound relaxes adjacency away almost entirely and asks what the tile
 * COUNTS allow — the exception is `neighbourHeatCap`, which is the one place
 * adjacency binds hard enough to matter. For every split of the island into
 * `nEngine` tiles (reactors + generators), `nDp` direct producers and `nCool`
 * coolers, any layout obeys
 *
 *     heat absorbed  H <= min(nReact * R_top, nGen * min(G_top, neighbour cap))
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
  pooledCooling: boolean,
  crowdedRoster: EffectiveBuilding[] | null = null,
): number {
  const buildableTiles = island.tileCount;
  if (buildableTiles <= 0) return 0.0;

  const figures = rosterFigures(roster);
  const { cVal, rVal, gVal, dpNet, hasCooler, hasDp } = figures;
  let { dpWaste, energyRatio, wasteRatio } = figures;

  // The same roster at the *other* rating a role isolation offers, or null
  // under every other rule. Both are real ratings a layout can carry, so the
  // ratios a generator is bounded through are taken across the pair — the
  // argument `estimateMixedIslandMaxPower` makes for its two classes, and for
  // the same reason: a re-derived waste ratio is snapped, so the two are not
  // bit-identical and a bound has to allow the greedier.
  const crowdedFigures =
    crowdedRoster === null ? null : rosterFigures(crowdedRoster);
  if (crowdedFigures !== null) {
    if (crowdedFigures.energyRatio > energyRatio)
      energyRatio = crowdedFigures.energyRatio;
    if (crowdedFigures.wasteRatio < wasteRatio)
      wasteRatio = crowdedFigures.wasteRatio;
  }

  if (!hasCooler || cVal <= 0) return 0.0;
  if (!hasDp) dpWaste = 0.0;
  if (energyRatio === -Infinity) energyRatio = GENERATOR_ENERGY_RATIO;
  if (wasteRatio === Infinity || wasteRatio <= 0)
    wasteRatio = GENERATOR_WASTE_RATIO;

  // What a generator tile is worth to the bound: its tier, or the most its
  // eight neighbours can push through it, whichever is less. Both ratings a
  // role isolation offers are capped, and for the same reason — the bonus one
  // most of all, since it is the one that outruns a neighbourhood.
  const neighbourCap = neighbourHeatCap(
    maxNeighbourTiles(buildableTiles),
    rVal,
    cVal,
    wasteRatio,
    pooledCooling,
  );
  const gTake = Math.min(gVal, neighbourCap);
  const gCrowdedTake =
    crowdedFigures === null
      ? gTake
      : Math.min(crowdedFigures.gVal, neighbourCap);
  const capacities = generatorCapacities(
    buildableTiles,
    gTake,
    gCrowdedTake < gTake
      ? { gTake: gCrowdedTake, room: isolationRoom(island) }
      : null,
  );

  // The same 3-and-2 reasoning `minIslandTiles` owns — a reactor + generator +
  // cooler chain is 3 tiles, a direct producer + cooler pair is 2 — restated
  // here rather than read from it, because that function answers "is this patch
  // worth keeping?" for a whole board and this asks "can this split produce
  // anything?" for one island already kept. They must not be allowed to
  // disagree: raise the floor there and these two numbers have to follow, or the
  // bound goes on allowing a layout the decomposition no longer admits (which is
  // still a bound, so nothing would fail) — or worse, lower it there and the
  // bound becomes one a real layout beats.
  const canHub = rVal > 0 && gTake > 0 && buildableTiles >= 3;
  const canDp = hasDp && buildableTiles >= 2;
  if (!canHub && !canDp) return 0.0;

  let best = 0.0;
  const maxEngine = canHub ? buildableTiles : 0;

  for (let nEngine = 0; nEngine <= maxEngine; nEngine++) {
    const heatCap = bestHeatForEngineTiles(nEngine, rVal, capacities);
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
 * The most heat one generator tile can take in and still run, given how many
 * neighbours it has to take it from.
 *
 * The rest of the bound relaxes adjacency away, and on the base rules that
 * costs almost nothing. This is the one place it cannot: **heat crosses a tile
 * boundary and nothing else**, so a generator's intake is the output of the
 * reactors beside it, and the all-or-nothing cooling rule then says it only
 * counts if the coolers beside it cover the waste that intake makes. Both
 * claims are on the same eight tiles, so one generator absorbing `H` needs
 * `H / rVal` of them as reactors and `wasteRatio * H / cVal` as coolers, and
 * the two together cannot outrun the neighbourhood:
 *
 *     H <= maxNeighbours / (1 / rVal + wasteRatio / cVal)
 *
 * Every term is a *most* — an adjacent reactor may be feeding another
 * generator, an adjacent cooler another producer — so the inequality only ever
 * errs high, which is what a bound needs.
 *
 * It is homogeneous of degree 1 in the roster, exactly as the LP below is, so a
 * rule that scales everything uniformly (a terrain bonus, a research) can never
 * make it bite: the cap rises with the generator it caps. A rule that scales
 * **one role** breaks that, and `role_isolation` is the one that does —
 * Singularity Isolation rates a lone generator's intake x2.5 while leaving the
 * reactors that fill it and the coolers that clear it alone, so the LP bought
 * its extra heat by spending fewer tiles on generators than any arrangement of
 * eight neighbours can serve. That left the shipped maps' bound 5% above
 * anything the board allows, and the efficiency figure reading ~87% for layouts
 * that were not 87% of anything.
 *
 * Under a shared cooling pool the cooler term is gone, because adjacency is:
 * the pool reaches the whole island, so every neighbour may be a reactor.
 */
function neighbourHeatCap(
  maxNeighbours: number,
  rVal: number,
  cVal: number,
  wasteRatio: number,
  pooledCooling: boolean,
): number {
  if (maxNeighbours <= 0 || rVal <= 0) return 0.0;
  const perUnitHeat =
    1 / rVal + (pooledCooling || cVal <= 0 ? 0 : wasteRatio / cVal);
  return maxNeighbours / perUnitHeat;
}

/** How many tiles can touch one building here: eight, or the island if smaller. */
function maxNeighbourTiles(buildableTiles: number): number {
  return Math.min(CHEBYSHEV_DIRECTIONS.length, buildableTiles - 1);
}

/**
 * How much of the `isolated` rating an island can actually carry.
 *
 * `role_isolation` rates a generator with no generator beside it far above one
 * with, and the LP's optimum under Singularity asks for more of them than any
 * board can hold: isolated generators are pairwise non-adjacent by definition,
 * so they are an independent set in the 8-neighbour graph — and on a roster
 * whose generators are the short side, the split wants a third of the island to
 * be generators, every one of them isolated. Gale Hills at generator7 tier 2
 * was asked for 17.4 where the island admits 15, and read 83% layout efficiency
 * for layouts within 3% of the best anything finds.
 *
 * A maximum independent set is NP-hard in general, so this reads the geometry
 * off a **2x2 block partition**, where two facts are free:
 *
 * - All four tiles of a 2x2 block are mutually adjacent, so a block holds at
 *   most one isolated generator — `blocks` is therefore a ceiling on how many
 *   there can be. On the shipped islands it lands within one or two of the
 *   exact figure (16 against 15 on Gale Hills, 21 against 20 on Ash Bay).
 * - A block that holds one holds **no other generator at all**, for the same
 *   reason. So `freeTiles[k]` — the tiles left for crowded generators once `k`
 *   are isolated — is the island less the `k` blocks they sit in, and putting
 *   them in the *smallest* blocks is what leaves the most room.
 *
 * Both are read for each of the four alignments of the block grid and taken at
 * their tightest, pointwise: every alignment states a true constraint, so the
 * strongest of them is true as well. What the partition cannot see is
 * adjacency *across* a block boundary, which is why a crowded generator in a
 * free block is allowed here and often is not on the board — the bound errs
 * high, as it must.
 */
export interface IsolationRoom {
  /** Most generators on this island that can be rated `isolated` at once. */
  readonly maxIsolated: number;
  /** Tiles that may still hold a crowded generator, by isolated count. */
  readonly freeTiles: Int32Array;
}

export function isolationRoom(island: IslandSubGrid): IsolationRoom {
  const tiles = island.tileCount;
  let maxIsolated = tiles;
  const freeTiles = new Int32Array(tiles + 1).fill(tiles);

  for (let ox = 0; ox <= 1; ox++) {
    for (let oy = 0; oy <= 1; oy++) {
      const sizes = new Map<number, number>();
      for (let y = 0; y < island.height; y++) {
        for (let x = 0; x < island.width; x++) {
          if (island.buildable[y * island.width + x] !== 1) continue;
          const block = (((y + oy) >> 1) << 16) + (((x + ox) >> 1) & 0xffff);
          sizes.set(block, (sizes.get(block) ?? 0) + 1);
        }
      }

      const ascending = [...sizes.values()].sort((a, b) => a - b);
      if (ascending.length < maxIsolated) maxIsolated = ascending.length;

      // Tiles the isolated generators' own blocks take with them, smallest
      // blocks first — the arrangement that leaves the most room behind.
      let consumed = 0;
      for (let k = 0; k <= tiles; k++) {
        if (k > 0 && k <= ascending.length) consumed += ascending[k - 1];
        const free = k <= ascending.length ? tiles - consumed : 0;
        if (free < freeTiles[k]) freeTiles[k] = free;
      }
    }
  }

  return { maxIsolated, freeTiles };
}

/**
 * The most heat `nGen` generator tiles can absorb, by count.
 *
 * A table rather than a multiply, because under a rule that rates by isolation
 * capacity is not linear in the tile count. `gTake` is what a generator is
 * worth at the better of the two ratings and `crowded` what it is worth at the
 * other; each generator taking the better rating spends a whole 2x2 block, so
 * past a point one more of them costs more capacity than it brings, and which
 * side of that point an island is on is what the scan settles.
 *
 * `crowded` is null under every other rule, and then this is the multiply it
 * always was.
 */
export function generatorCapacities(
  buildableTiles: number,
  gTake: number,
  crowded: { gTake: number; room: IsolationRoom } | null,
): Float64Array {
  const capacities = new Float64Array(buildableTiles + 1);
  if (crowded === null) {
    for (let nGen = 0; nGen <= buildableTiles; nGen++)
      capacities[nGen] = nGen * gTake;
    return capacities;
  }

  const { room } = crowded;
  for (let nGen = 0; nGen <= buildableTiles; nGen++) {
    let best = 0.0;
    const mostIsolated = Math.min(nGen, room.maxIsolated);
    for (let nIso = 0; nIso <= mostIsolated; nIso++) {
      const rest = nGen - nIso;
      if (rest > room.freeTiles[nIso]) continue;
      const capacity = nIso * gTake + rest * crowded.gTake;
      if (capacity > best) best = capacity;
    }
    capacities[nGen] = best;
  }
  return capacities;
}

/**
 * Most heat `nEngine` tiles of reactors + generators can hand over, cooling
 * ignored: max over nReact of `min(nReact * rVal, capacities[nEngine - nReact])`.
 *
 * Every split is checked rather than the two either side of where the two lines
 * cross. The crossing is only where the peak is while generator capacity is
 * linear in the tile count, and under a rule that rates by isolation it is not
 * — `generatorCapacities` bends once the island runs out of room to keep them
 * apart. The scan is O(tiles) inside a loop that is already O(tiles), on a
 * function called once per solve rather than inside the search.
 */
function bestHeatForEngineTiles(
  nEngine: number,
  rVal: number,
  capacities: Float64Array,
): number {
  if (nEngine < 2 || rVal <= 0) return 0.0;

  let best = 0.0;
  for (let nReact = 1; nReact <= nEngine - 1; nReact++) {
    const heat = Math.min(nReact * rVal, capacities[nEngine - nReact]);
    if (heat > best) best = heat;
  }
  return best;
}

/**
 * `bestHeatForEngineTiles` for engine tiles of two classes: `shoreEngine` of
 * the `nEngine` carry the shore figures, the rest the inland ones.
 *
 * A shore reactor may feed an inland generator and the other way round — the
 * bound relaxes adjacency away, so only the two totals matter — which makes
 * this `max over the split of min(reactor heat, generator intake)` with two
 * integer splits instead of one. For each split of the shore tiles the inland
 * split is the one-line crossing the single-class version already checks, so
 * the search is linear in the shore count rather than quadratic.
 */
function bestHeatForMixedEngineTiles(
  nEngine: number,
  shoreEngine: number,
  inland: RosterFigures,
  shore: RosterFigures,
): number {
  if (nEngine < 2) return 0.0;

  const inlandEngine = nEngine - shoreEngine;
  const slope = inland.rVal + inland.gVal;
  let best = 0.0;
  for (let shoreReact = 0; shoreReact <= shoreEngine; shoreReact++) {
    const shoreHeat = shoreReact * shore.rVal;
    const shoreIntake = (shoreEngine - shoreReact) * shore.gVal;
    // min(shoreHeat + R·x, shoreIntake + G·(inlandEngine − x)) peaks at the
    // crossing; the ends cover a crossing outside the inland range.
    const crossing =
      slope > 0
        ? Math.floor(
            (shoreIntake + inland.gVal * inlandEngine - shoreHeat) / slope,
          )
        : 0;
    for (const inlandReact of [crossing, crossing + 1, 0, inlandEngine]) {
      if (inlandReact < 0 || inlandReact > inlandEngine) continue;
      const heat = Math.min(
        shoreHeat + inlandReact * inland.rVal,
        shoreIntake + (inlandEngine - inlandReact) * inland.gVal,
      );
      if (heat > best) best = heat;
    }
  }
  return best;
}

/**
 * `estimateIslandMaxPower` for an island whose tiles come in two classes: the
 * `shoreTiles` a terrain bonus rates at `multiplier`, and the rest at 1.
 *
 * The single-class bound scaled by the multiplier rates every inland tile as if
 * it stood on the coast, and on the shipped maps the coast is 36-44% of the
 * grass — so the bound ran a quarter loose and Magma Rift's best layouts read
 * 72% of it. This asks the same question with the tile budget split in two: a
 * shore building is a shore-rated building and an inland one is not, and both
 * pay into the one heat and the one cooling total, since the bound relaxes
 * adjacency away and a shore reactor may feed an inland generator.
 *
 * What stays integer and what does not is chosen for cost. The engine —
 * how many tiles of each class, and how each class splits between reactors
 * and generators — is enumerated exactly. The tiles left over on each class go
 * to direct producers or coolers **fractionally**: a producer tile then costs
 * its own waste plus the cooling the cooler it displaced would have given, and
 * the whole remainder is one fractional knapsack over three items (heat, inland
 * producers, shore producers), solved by filling the best power-per-cooling
 * first. Enumerating that split integer too was measured at 250ms on the
 * largest island against under 10ms for this, and the two agree to the last
 * bit on every shipped map — at full unlocks no direct producer competes with
 * an engine, so the relaxed split never moves. It is a relaxation, so still a
 * bound; on a toy roster with a strong producer it sits up to ~1% above the
 * integer figure, and on an island of two or three tiles a fractional cooler
 * can put it above the whole-island figure it exists to tighten — which is why
 * the caller takes the smaller of the two.
 *
 * The ratios a generator is bounded through are taken across **both** rosters:
 * a shore generator's waste is re-derived from its scaled pair and snapped, so
 * its waste ratio is not bit-identical to the inland one, and a bound on the
 * mixed board has to allow the greedier of each.
 */
function estimateMixedIslandMaxPower(
  buildableTiles: number,
  shoreTiles: number,
  roster: EffectiveBuilding[],
  multiplier: number,
  pooledCooling: boolean,
): number {
  if (buildableTiles <= 0) return 0.0;
  const inlandTiles = buildableTiles - shoreTiles;

  const inland = rosterFigures(roster);
  const shore = rosterFigures(
    roster.map((b) => scaleEffectiveBuilding(b, multiplier)),
  );
  if (!inland.hasCooler || inland.cVal <= 0) return 0.0;

  let energyRatio = Math.max(inland.energyRatio, shore.energyRatio);
  let wasteRatio = Math.min(inland.wasteRatio, shore.wasteRatio);
  if (energyRatio === -Infinity) energyRatio = GENERATOR_ENERGY_RATIO;
  if (wasteRatio === Infinity || wasteRatio <= 0)
    wasteRatio = GENERATOR_WASTE_RATIO;
  const inlandDpWaste = inland.hasDp ? inland.dpWaste : 0.0;
  const shoreDpWaste = shore.hasDp ? shore.dpWaste : 0.0;

  // One cap for both classes, on the strongest neighbour either class can
  // offer: which class a tile falls in is a property of *that* tile, and an
  // inland generator is perfectly free to have shore reactors and shore
  // coolers around it. Taking the best of each is the only reading that stays
  // a bound, and it costs nothing — the cap is homogeneous, so a terrain
  // multiplier moves it and the generator it caps by the same factor and it
  // goes on not binding. See `neighbourHeatCap`.
  const gTake = neighbourHeatCap(
    maxNeighbourTiles(buildableTiles),
    Math.max(inland.rVal, shore.rVal),
    Math.max(inland.cVal, shore.cVal),
    wasteRatio,
    pooledCooling,
  );
  inland.gVal = Math.min(inland.gVal, gTake);
  shore.gVal = Math.min(shore.gVal, gTake);

  // The same 3-and-2 floors `estimateIslandMaxPower` states, for the same
  // reason, and they must not be allowed to disagree with it.
  const canHub = inland.rVal > 0 && inland.gVal > 0 && buildableTiles >= 3;
  const canDp = inland.hasDp && buildableTiles >= 2;
  if (!canHub && !canDp) return 0.0;

  // The knapsack's three items in fill order — most power per unit of cooling
  // first, which is optimal for a fractional knapsack. A producer tile's
  // weight includes the cooler it displaces, so the budget is every remaining
  // tile as a cooler. The order is fixed by the roster, so it is settled once.
  const values = [energyRatio, inland.dpNet, shore.dpNet];
  const weights = [
    wasteRatio,
    inlandDpWaste + inland.cVal,
    shoreDpWaste + shore.cVal,
  ];
  const order = [0, 1, 2].sort((a, b) => {
    const ra = weights[a] <= EPS ? Infinity : values[a] / weights[a];
    const rb = weights[b] <= EPS ? Infinity : values[b] / weights[b];
    return rb - ra;
  });
  const caps = [0.0, 0.0, 0.0];

  let best = 0.0;
  const maxEngine = canHub ? buildableTiles : 0;

  for (let nEngine = 0; nEngine <= maxEngine; nEngine++) {
    const minShoreEngine = Math.max(0, nEngine - inlandTiles);
    const maxShoreEngine = Math.min(shoreTiles, nEngine);
    for (
      let shoreEngine = minShoreEngine;
      shoreEngine <= maxShoreEngine;
      shoreEngine++
    ) {
      const heatCap = bestHeatForMixedEngineTiles(
        nEngine,
        shoreEngine,
        inland,
        shore,
      );
      // Engine tiles that can't form a reactor+generator pair.
      if (nEngine > 0 && heatCap <= 0.0) continue;

      const inlandRest = inlandTiles - (nEngine - shoreEngine);
      const shoreRest = shoreTiles - shoreEngine;
      caps[0] = heatCap;
      caps[1] = canDp ? inlandRest : 0;
      caps[2] = canDp ? shoreRest : 0;

      let cooling = inland.cVal * inlandRest + shore.cVal * shoreRest;
      let power = 0.0;
      for (const item of order) {
        const cap = caps[item];
        if (cap <= 0 || values[item] <= 0) continue;
        if (weights[item] <= EPS) {
          power += values[item] * cap;
          continue;
        }
        const taken = Math.min(cap, cooling / weights[item]);
        if (taken <= 0) continue;
        power += values[item] * taken;
        cooling -= taken * weights[item];
      }

      if (power > best) best = power;
    }
  }

  return best;
}

/**
 * The roster as a rule that scales a **whole role** rates it, so the bound
 * below can be computed on the figures the layout actually runs under rather
 * than scaled up afterwards.
 *
 * A role scale is uniform across the island — every cooler under a shared pool
 * is x0.88 wherever it stands, and a search free to keep generators apart rates
 * every one of them at the isolation bonus — so it is a property of the roster
 * and belongs in the roster. Running the LP on that roster is a tighter bound
 * than scaling its result by the largest factor: `islandMaxScale` had to scale
 * the *whole* estimate by 2.5 under Singularity, which rated reactors and
 * coolers up as well and left the bound 2.3x the tight one, so a near-optimal
 * layout read as 40% layout efficiency. Scaling only the generator entries is
 * sound for the same reason as before — any layout under the rule is feasible
 * in this roster with an objective no larger — and it is the roster the bound
 * is entitled to assume.
 *
 * A role isolation takes the larger of its two variants, because which one a
 * tile gets is a function of the layout rather than of the island, and the
 * penalty is the one usually binding while the bonus is the one a layout may
 * reach. A terrain bonus is a property of the tile, not the role, and is not
 * answered here — see `islandMaxScale`.
 *
 * Exhaustive without a `default`, like `islandMaxScale` and for the same
 * reason: a fifth rule shape fails to typecheck here rather than silently
 * leaving the roster plain under a rule that rates something above it.
 */
function roleRatedRoster(
  roster: EffectiveBuilding[],
  anomaly?: AnomalyDefinition,
): EffectiveBuilding[] {
  if (anomaly === undefined) return roster;

  switch (anomaly.rule) {
    case "baseline":
    case "terrain_affinity":
      return roster;

    case "shared_cooling":
      return roster.map((b) =>
        b.type === "cooler"
          ? scaleEffectiveBuilding(b, anomaly.coolerMultiplier)
          : b,
      );

    case "role_isolation": {
      const factor = Math.max(anomaly.isolated, anomaly.crowded);
      return roster.map((b) =>
        b.type === anomaly.role ? scaleEffectiveBuilding(b, factor) : b,
      );
    }
  }
}

/**
 * The same roster at the **lesser** of a role isolation's two ratings, or null
 * when there is no second rating to hold.
 *
 * `roleRatedRoster` above takes the better of the two, which is sound — a
 * search free to keep generators apart rates every one of them at the bonus —
 * and on a generator-bound roster it is also a layout no board can hold:
 * `isolationRoom` is the ceiling on how many may be apart at once, and past it
 * the rest are rated at this. The pair is what lets `estimateIslandMaxPower`
 * bend its generator capacity at that ceiling instead of running the better
 * rating out to the whole island.
 *
 * Only the generator role, deliberately. Generator capacity is the one figure
 * the LP counts per tile, so it is the one a count limit can bend; a reactor,
 * a cooler or a direct producer would each need their own, and none of them
 * ships. Every role stays sound either way — the better rating alone is still
 * an upper bound, which is exactly what the other three keep.
 */
function crowdedRatedRoster(
  roster: EffectiveBuilding[],
  anomaly?: AnomalyDefinition,
): EffectiveBuilding[] | null {
  if (anomaly?.rule !== "role_isolation" || anomaly.role !== "generator")
    return null;

  const factor = Math.min(anomaly.isolated, anomaly.crowded);
  return roster.map((b) =>
    b.type === anomaly.role ? scaleEffectiveBuilding(b, factor) : b,
  );
}

/**
 * How many of the island's tiles a terrain bonus rates, or `null` when the
 * shore mask cannot say.
 *
 * Water is the one terrain that can lie *off* the board, and the shore mask is
 * the only thing that knows it — so the count is exact when water is the whole
 * of the list. A list naming anything else qualifies a tile on a neighbour this
 * window can see but the mask cannot speak for (`terrainScales` tests rock and
 * tree against the grid), and one that mixed the two would need both answers
 * at once. `null` is the honest answer there, and the bound errs high on it: a
 * landlocked island under a `["water", "rock"]` anomaly would otherwise rate
 * its tiles at the multiplier while the bound stayed at 1.
 */
function ratedTileCount(
  island: IslandSubGrid,
  anomaly: TerrainAffinityAnomaly,
): number | null {
  if (anomaly.terrain.length !== 1 || anomaly.terrain[0] !== "water")
    return null;

  let count = 0;
  for (let i = 0; i < island.buildable.length; i++) {
    if (island.buildable[i] === 1 && island.waterAdjacent[i] === 1) count++;
  }
  return count;
}

/**
 * The largest multiplier a **tile** on this island can rate a building at,
 * beyond what `roleRatedRoster` has already put into the roster.
 *
 * One number for the island rather than one per tile, because it is used to
 * keep the bound a bound: `estimateIslandMaxPower` is positively homogeneous of
 * degree 1 in the roster's figures — `hFirst`, `dRest`, `dFirst` and `hRest` all
 * scale by `k` and every ratio in it is invariant — so scaling its *result* by
 * `k` is the same thing as scaling every roster figure by `k`, and rating the
 * whole island at its best tile is an upper bound on rating each tile at its
 * own.
 *
 * It is loose by construction where only part of an island qualifies, and that
 * is the right trade where nothing better can be said: a bound that can be
 * beaten is worthless, while one that is generous only makes the efficiency
 * figure read low. Where the mask *can* say which tiles carry the factor,
 * `estimateIslandBound` goes on to the two-class bound and this is its
 * ceiling. The role-shaped rules answer 1 here because their factor is already
 * in the roster, where it is exact rather than loose.
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
    case "shared_cooling":
    case "role_isolation":
      // Uniform across the island, so carried by `roleRatedRoster` instead.
      return 1;

    case "terrain_affinity": {
      if (anomaly.multiplier <= 1) return 1;
      const rated = ratedTileCount(island, anomaly);
      return rated === null || rated > 0 ? anomaly.multiplier : 1;
    }
  }
}

/**
 * One island's bound under the rules in force, on a roster `roleRatedRoster`
 * has already rated.
 *
 * Three answers, from loose to tight. An island no tile rule reaches is the
 * plain LP. One the mask cannot decide, or every tile of which qualifies, is
 * the plain LP at `islandMaxScale` — for an all-shore island that *is* the
 * two-class figure, and it is spelled this way so the figure is the one it
 * always was. A mixed island is the two-class LP, capped by the whole-island
 * figure: both are bounds, so the smaller is, and the cap is what keeps an
 * island of two or three tiles — where a fractional cooler is worth more than
 * a whole one — from reading looser than it did before the split existed.
 */
function estimateIslandBound(
  island: IslandSubGrid,
  roster: EffectiveBuilding[],
  crowdedRoster: EffectiveBuilding[] | null,
  anomaly?: AnomalyDefinition,
): number {
  // The one rule `neighbourHeatCap` has to be told about: pooled cooling
  // reaches the whole island, so a generator under it needs no cooler beside
  // it and the cap is the reactor term alone.
  const pooledCooling = anomaly?.rule === "shared_cooling";

  const plain = estimateIslandMaxPower(
    island,
    roster,
    pooledCooling,
    crowdedRoster,
  );
  const scale = islandMaxScale(island, anomaly);
  if (scale === 1) return plain;

  // Only a terrain rule answers above 1, and only a water-only list has a mask
  // that can say which tiles carry it.
  const rated =
    anomaly?.rule === "terrain_affinity"
      ? ratedTileCount(island, anomaly)
      : null;
  // `plain` carries the cap on the unrated roster, and the cap is homogeneous,
  // so scaling the whole figure scales the cap with it — the same reason the
  // rest of the LP survives being scaled after the fact.
  if (rated === null || rated >= island.tileCount) return plain * scale;

  return Math.min(
    plain * scale,
    estimateMixedIslandMaxPower(
      island.tileCount,
      rated,
      roster,
      scale,
      pooledCooling,
    ),
  );
}

/**
 * Sum of theoretical max power across all valid island sub-grids.
 *
 * `anomaly` is taken because the bound has to hold under the rules the search
 * is actually running: a terrain bonus rates some tiles above their authored
 * figures, and a bound computed on the plain roster is one a real layout beats.
 * A rule that scales a whole role goes into the roster (`roleRatedRoster`),
 * where the bound is exact in it; one that scales a tile splits the island's
 * tiles by class (`estimateIslandBound`), and scales the result only where the
 * mask cannot say which tiles it reaches.
 * The "layout efficiency" figure this feeds then reads above 100%, which is the
 * visible half of the problem; the invisible half is that nothing else in the
 * solver is entitled to assume the bound holds either.
 */
export function estimateTotalMaxPower(
  islands: IslandSubGrid[],
  roster: EffectiveBuilding[],
  anomaly?: AnomalyDefinition,
): number {
  const rated = roleRatedRoster(roster, anomaly);
  const crowded = crowdedRatedRoster(roster, anomaly);
  let total = 0;
  for (const island of islands)
    total += estimateIslandBound(island, rated, crowded, anomaly);
  return total;
}
