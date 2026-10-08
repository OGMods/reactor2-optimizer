import {
  canCoolDirectProducer,
  countGrassTiles,
  estimateTotalMaxPower,
  splitGridIntoIslands,
} from "./island";
import { solveIsland, type IslandSolution } from "./placementSearch";
import { getAnomaly } from "../data/anomalies";
import { getEffectiveBuildings } from "../data/effectiveBuildings";
import type {
  AnomalyDefinition,
  BuildingDefinition,
  EffectiveBuilding,
  PrestigeScales,
  IslandSubGrid,
  OptimizationResult,
  PlacedBuilding,
  SolveOptions,
  Tile,
} from "./types";

/**
 * Top-level solve pipeline: split the grid into islands, solve each one under
 * its own slice of the time budget, then stitch the results back into grid
 * coordinates.
 *
 * This is the single-threaded path. The app runs islands concurrently in a
 * worker pool instead — see `SolverCoordinator`, which shares the helpers
 * below so both paths produce byte-identical result objects.
 */

export const DEFAULT_TIME_BUDGET_S = 10.0;

/**
 * How steeply an island's share of the budget grows with its size: a share is
 * weighted by tile count to this power, not by tile count.
 *
 * Measured, not reasoned (`scripts/gapSurvey.ts` is the instrument). Solving
 * every island of the eight cleared maps at a quarter, half, one and two times
 * its old proportional share: an island of 20 tiles or fewer reached the same
 * figure at a quarter as at double — most hit their bound or the same loose
 * figure in a few hundredths of a second — while every landmass of 67 tiles
 * and up was still climbing at double. Under a linear split those scraps held
 * up to 19% of a run (Entropy Isles); squared, they hold under 2% and the main
 * landmass gets the rest. Shadowspire, the one map with two large landmasses,
 * also gained more per second on its 165-tile one than on its 79-tile one, which
 * is the same direction.
 */
const BUDGET_EXPONENT = 2;

/**
 * The least an island is cut down to, in seconds — or its old proportional
 * share, if that was less. Enough for a scrap's seed and repair to finish on a
 * phone several times slower than the desktop the measurements above ran on;
 * on that desktop they need about a quarter of this.
 */
const MIN_ISLAND_BUDGET_S = 0.25;

/**
 * Each island's slice of `totalS`, by buildable-tile count. The slices sum to
 * `totalS`.
 *
 * Shares grow with tile count to `BUDGET_EXPONENT`, so time goes where it still
 * buys power, but no island drops below the smaller of `MIN_ISLAND_BUDGET_S`
 * and its proportional share. Those floors are filled first and the rest is
 * split by weight, re-pinning any island the split would put under its floor
 * until none would.
 *
 * Exported because the app's run estimate (`taskDurationsMs`) has to model
 * exactly the budgets the coordinator will send; a second copy of this rule is
 * an estimate that quietly describes a different run.
 */
export function islandBudgetsS(
  tileCounts: readonly number[],
  totalS: number,
): number[] {
  const n = tileCounts.length;
  const tiles = tileCounts.reduce((a, b) => a + b, 0);
  if (n === 0) return [];
  // Nothing to search anywhere, so nothing to spend.
  if (tiles === 0) return tileCounts.map(() => 0);

  const floors = tileCounts.map((c) =>
    Math.min(MIN_ISLAND_BUDGET_S, (totalS * c) / tiles),
  );
  const weights = tileCounts.map((c) => c ** BUDGET_EXPONENT);
  const pinned = new Array<boolean>(n).fill(false);
  const budgets = new Array<number>(n).fill(0);

  for (;;) {
    let free = totalS;
    let weight = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) free -= floors[i];
      else weight += weights[i];
    }
    let repinned = false;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      budgets[i] = weight > 0 ? (free * weights[i]) / weight : 0;
      if (budgets[i] < floors[i]) {
        pinned[i] = true;
        repinned = true;
      }
    }
    if (!repinned) break;
  }
  for (let i = 0; i < n; i++) if (pinned[i]) budgets[i] = floors[i];
  return budgets;
}

export interface IslandPlan {
  islands: IslandSubGrid[];
  effectiveBuildings: EffectiveBuilding[];
  /**
   * The rules every island is solved under. Resolved here so both solve paths
   * and the worker pool hand the same object down, and never `undefined` —
   * "no anomaly" is one of them.
   */
  anomaly: AnomalyDefinition;
  /** Per-island time budget — see `islandBudgetsS`. */
  budgetsS: number[];
  /** Per-island RNG seed, or undefined for a fresh stochastic stream. */
  seeds: (number | undefined)[];
  originalWidth: number;
  totalGrassTiles: number;
  theoreticalMaxPower: number;
  /**
   * The upgrade plan's rosters, resolved like `effectiveBuildings` and in the
   * same order as `SolveOptions.upgradePlan` — today's first. Empty without a
   * plan.
   */
  upgradeSteps?: EffectiveBuilding[][];
}

/**
 * Everything both solve paths need before any island is touched: the island
 * decomposition, the roster, and how the time budget is divided.
 *
 * Islands never interact — nothing that happens on one can affect another — so
 * each gets its full share of the budget (`islandBudgetsS`) and they may run
 * in any order, or concurrently.
 */
export function planSolve(
  grid: Tile[][],
  buildings: BuildingDefinition[],
  unlockedUpgrades: Record<string, number>,
  timeBudgetS: number,
  rngSeed?: number,
  anomalyId?: string,
  prestige?: PrestigeScales,
  upgradePlan?: Record<string, number>[],
): IslandPlan | null {
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0)
    return null;

  const totalGrassTiles = countGrassTiles(grid);
  if (totalGrassTiles === 0) return null;

  // Research folds in here, at the one place the roster is resolved, so every
  // island and every attempt is handed the same already-scaled buildings.
  const effectiveBuildings = getEffectiveBuildings(
    buildings,
    unlockedUpgrades,
    prestige,
  );
  if (effectiveBuildings.length === 0) return null;

  // Taken by id rather than as a definition, because that is also the worker
  // protocol's form: an id is a string that survives any boundary, and
  // `getAnomaly` is total, so one from a newer save resolves to the base rules
  // instead of arriving half understood.
  //
  // Resolved before the split because the split reads it: a shared cooling pool
  // changes the smallest patch worth keeping.
  const anomaly = getAnomaly(anomalyId);

  const islands = splitGridIntoIslands(
    grid,
    canCoolDirectProducer(effectiveBuildings),
    anomaly,
  );
  if (islands.length === 0) return null;

  return {
    islands,
    effectiveBuildings,
    anomaly,
    budgetsS: islandBudgetsS(
      islands.map((island) => island.tileCount),
      timeBudgetS,
    ),
    // Each island gets its own random stream, offset from the base seed so a
    // seeded solve is reproducible per island rather than coupled across them.
    seeds: islands.map((_, i) =>
      rngSeed === undefined ? undefined : (rngSeed + i) >>> 0,
    ),
    originalWidth: grid[0].length,
    totalGrassTiles,
    theoreticalMaxPower: estimateTotalMaxPower(
      islands,
      effectiveBuildings,
      anomaly,
    ),
    upgradeSteps: (upgradePlan ?? []).map((unlocks) =>
      getEffectiveBuildings(buildings, unlocks, prestige),
    ),
  };
}

/** Rewrites island-local coordinates back to full-grid coordinates. */
function remapPlacements(
  island: IslandSubGrid,
  localPlacements: PlacedBuilding[],
  originalWidth: number,
): PlacedBuilding[] {
  return localPlacements.map((p) => {
    const originalFlatIndex =
      island.originalTileIndices[p.y * island.width + p.x];
    const origX = originalFlatIndex % originalWidth;
    return {
      ...p,
      x: origX,
      y: (originalFlatIndex - origX) / originalWidth,
    };
  });
}

export function createEmptyResult(totalGrass: number): OptimizationResult {
  return {
    totalPower: 0.0,
    placements: [],
    activeTilesCount: 0,
    unusedTilesCount: totalGrass,
    summary: {
      totalHeatProduced: 0.0,
      totalHeatConsumed: 0.0,
      totalWasteGenerated: 0.0,
      totalCoolingCapacity: 0.0,
    },
    theoreticalMaxPower: 0.0,
  };
}

/**
 * Aggregates per-island results by island index (not completion order), so the
 * output is identical however the islands were scheduled.
 */
export function buildOptimizationResult(
  plan: IslandPlan,
  islandResults: IslandSolution[],
): OptimizationResult {
  const globalPlacements: PlacedBuilding[] = [];
  let totalPower = 0.0;
  let totalHeatProduced = 0.0;
  let totalHeatConsumed = 0.0;
  let totalWasteGenerated = 0.0;
  let totalCoolingCapacity = 0.0;

  for (let i = 0; i < plan.islands.length; i++) {
    const { placements, powerOutput } = islandResults[i];
    totalPower += powerOutput;
    globalPlacements.push(
      ...remapPlacements(plan.islands[i], placements, plan.originalWidth),
    );

    for (const p of placements) {
      totalHeatProduced += p.heatProduced;
      totalHeatConsumed += p.heatConsumed;
      totalWasteGenerated += p.wasteHeatGenerated;
      totalCoolingCapacity += p.coolingProvided;
    }
  }

  return {
    totalPower,
    placements: globalPlacements,
    activeTilesCount: globalPlacements.length,
    unusedTilesCount: plan.totalGrassTiles - globalPlacements.length,
    summary: {
      totalHeatProduced,
      totalHeatConsumed,
      totalWasteGenerated,
      totalCoolingCapacity,
    },
    theoreticalMaxPower: plan.theoreticalMaxPower,
  };
}

/**
 * Solves a whole grid on the calling thread, one island after another.
 *
 * The app uses `SolverWorkerClient` instead, which farms the same islands out
 * to a pool of workers; this path exists for headless use (benchmarks,
 * the CLI, the tests) where there is no worker pool.

 */
export async function solve(
  grid: Tile[][],
  buildings: BuildingDefinition[],
  unlockedUpgrades: Record<string, number>,
  timeBudgetS = DEFAULT_TIME_BUDGET_S,
  options?: SolveOptions,
  rngSeed?: number,
): Promise<OptimizationResult> {
  const plan = planSolve(
    grid,
    buildings,
    unlockedUpgrades,
    timeBudgetS,
    rngSeed,
    options?.anomalyId,
    options?.prestige,
    options?.upgradePlan,
  );
  if (!plan)
    return createEmptyResult(grid?.[0]?.length ? countGrassTiles(grid) : 0);

  const islandResults: IslandSolution[] = plan.islands.map(() => ({
    placements: [],
    powerOutput: 0,
  }));

  for (let i = 0; i < plan.islands.length; i++) {
    islandResults[i] = await solveIsland(
      plan.islands[i],
      plan.effectiveBuildings,
      plan.budgetsS[i],
      {
        reportIntervalMs: options?.reportIntervalMs,
        shouldStop: options?.shouldStop,
        onProgress: (placements, powerOutput) => {
          islandResults[i] = { placements, powerOutput };
          options?.onProgress?.(buildOptimizationResult(plan, islandResults));
        },
      },
      plan.seeds[i],
      plan.anomaly,
      plan.upgradeSteps,
    );
    options?.onProgress?.(buildOptimizationResult(plan, islandResults));
  }

  return buildOptimizationResult(plan, islandResults);
}
