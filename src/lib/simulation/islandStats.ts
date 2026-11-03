import {
  buildPrice,
  computeWaterAdjacency,
  countsSpend,
  findBuilding,
  timeLabLevels,
  timeLabResearch,
  type BuildingCounts,
  type PriceRules,
  type Tile,
} from "@reactor2/solver";

/**
 * What a board holds and what its buildings cost — the figures the island
 * stats and the building ribbon print.
 *
 * Pure functions over a board, so the timeline store can memo them per saved
 * code and the board on screen can derive them live from the same code.
 */

// Counting is the package's, so the counts these figures read are the ones
// its prices are computed over.
export { countBuildings, type BuildingCounts } from "@reactor2/solver";

/** `into` plus `from`, per building, written into `into`. */
export function addCounts(into: BuildingCounts, from: BuildingCounts): void {
  for (const [id, n] of Object.entries(from)) into[id] = (into[id] ?? 0) + n;
}

export interface TerrainStats {
  /** Tiles a building can stand on. */
  grass: number;
  /**
   * Grass beside water, corners included — what Tidal Ascendancy rates. Off
   * the board counts as water, as it does in the solver: the shipped maps are
   * trimmed from one ocean (`computeWaterAdjacency`).
   */
  shore: number;
  /** Obstacles still standing, by kind. */
  rocks: number;
  trees: number;
  /** A pond is an obstacle, not water: it grants no shore. */
  ponds: number;
}

export function terrainStats(grid: Tile[][]): TerrainStats {
  const stats: TerrainStats = {
    grass: 0,
    shore: 0,
    rocks: 0,
    trees: 0,
    ponds: 0,
  };
  const width = grid[0]?.length ?? 0;
  const shore = computeWaterAdjacency(grid);
  grid.forEach((row, y) =>
    row.forEach((tile, x) => {
      switch (tile.type) {
        case "grass":
          stats.grass++;
          if (shore[y * width + x] === 1) stats.shore++;
          break;
        case "rock":
          stats.rocks++;
          break;
        case "tree1":
        case "tree2":
          stats.trees++;
          break;
        case "pond":
          stats.ponds++;
          break;
      }
    }),
  );
  return stats;
}

export interface BuildingPricing {
  /** The catalogue's price, before copies and research. */
  base: number;
  /** Copies standing across every island — what the price climbs with. */
  built: number;
  /** What the next copy costs, research included. */
  next: number;
  /**
   * What the standing copies cost to buy again from none, at today's
   * research. Not what the player paid: research bought since, and copies
   * sold and rebought, both make that differ.
   */
  rebuild: number;
}

export function buildingPricing(
  id: string,
  built: number,
  rules: PriceRules,
): BuildingPricing {
  const base = findBuilding(id)?.price ?? 0;
  let rebuild = 0;
  for (let k = 0; k < built; k++) rebuild += buildPrice(base, k, rules);
  return { base, built, next: buildPrice(base, built, rules), rebuild };
}

/** Obstacles of every kind still standing. */
export function obstacleCount(t: TerrainStats): number {
  return t.rocks + t.trees + t.ponds;
}

/**
 * How long clearing an obstacle takes, from the extractor's progression record
 * (`tools/data/progression.json`): five minutes, ×1.025 for every obstacle
 * cleared before it, less Clearance Crews (city research) and Phase Breaker
 * (Time Lab), which multiply. Erased from Time then finishes a clear for free
 * once what is left of it fits its window, so a clear no longer than the
 * window costs no wait at all.
 *
 * "Every obstacle cleared before it" is read as the whole save's count, the way
 * a building's price counts copies on every island.
 */
const REMOVAL_BASE_SECONDS = 5 * 60;
const REMOVAL_GROWTH = 1.025;

/** Clearance Crews: the share of removal time taken off, by level from 1. */
const CLEARANCE_CREWS = [0.2, 0.38, 0.53, 0.65, 0.74, 0.8, 0.85];

/** The research id a game export spells Clearance Crews with. */
const CLEARANCE_CREWS_ID = "ObstacleRemovalTimeResearchSO";

export interface ObstacleClearing {
  /** Obstacles cleared so far, on every island. */
  removed: number;
  /** How long the next clear takes, in seconds. */
  nextSeconds: number;
  /** Erased from Time's free-finish window, in seconds; 0 without it. */
  freeWindow: number;
  /** Obstacles left to clear. */
  left: number;
  /**
   * The wait to clear every one left, one after another, each finished free
   * once it fits the window. Clears can run side by side in the game, so
   * this is the sum of the waits rather than a date.
   */
  allSeconds: number;
}

/** What one clear waits after the free finish: its length less the window. */
export const clearWait = (c: { nextSeconds: number; freeWindow: number }) =>
  Math.max(0, c.nextSeconds - c.freeWindow);

/** A level's share off, 0 at level 0 and clamped past the table. */
const levelShare = (table: readonly number[], level: number) =>
  level > 0 ? table[Math.min(level, table.length) - 1] : 0;

export function nextRemoval(
  removed: number,
  research: Readonly<Record<string, number>>,
  left = 0,
): ObstacleClearing {
  const lab = timeLabLevels(research);
  const crews = levelShare(CLEARANCE_CREWS, research[CLEARANCE_CREWS_ID] ?? 0);
  const breaker = levelShare(
    timeLabResearch("phase_breaker").values!,
    lab.phase_breaker,
  );
  const seconds = (cleared: number) =>
    REMOVAL_BASE_SECONDS *
    REMOVAL_GROWTH ** cleared *
    (1 - crews) *
    (1 - breaker);
  const freeWindow = levelShare(
    timeLabResearch("erased_from_time").values!,
    lab.erased_from_time,
  );
  let allSeconds = 0;
  for (let k = 0; k < left; k++)
    allSeconds += Math.max(0, seconds(removed + k) - freeWindow);
  return {
    removed,
    nextSeconds: seconds(removed),
    freeWindow,
    left,
    allSeconds,
  };
}

/**
 * What changing a board holding `before` into one holding `after` costs, net
 * of the sales, `elsewhere` copies on other islands counting towards every
 * price. The package's `countsSpend` — the rule `netSpend` and a cash limit
 * are computed by — so the figure printed is the one a run is held to.
 */
export function changeSpend(
  after: BuildingCounts,
  before: BuildingCounts,
  elsewhere: BuildingCounts,
  rules: PriceRules,
): number {
  return countsSpend(after, before, elsewhere, rules);
}

/**
 * What each island costs to buy, by the game's area id — transcribed from the
 * extractor's progression record, like the clearing figures above. The
 * research that would discount it ships unused.
 */
const ISLAND_PRICES: Record<string, number> = {
  area_1: 0,
  area_2: 2e6,
  area_3: 1e10,
  area_4: 5e13,
  area_5: 2.5e17,
  area_6: 1.25e21,
  area_7: 6.25e24,
  area_8: 3.13e28,
};

/** An island's price by area id, or null for one the record does not list. */
export function islandPrice(areaId: string): number | null {
  return ISLAND_PRICES[areaId] ?? null;
}
