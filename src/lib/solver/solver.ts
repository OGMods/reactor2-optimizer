import {
  canCoolDirectProducer,
  countGrassTiles,
  estimateTotalMaxPower,
  splitGridIntoIslands,
} from "./island";
import { solveIsland, type IslandSolution } from "./placementSearch";
import { getEffectiveBuildings } from "../data/effectiveBuildings";
import type {
  BuildingDefinition,
  EffectiveBuilding,
  IslandSubGrid,
  OptimizationResult,
  PlacedBuilding,
  SolveOptions,
  Tile,
} from "./types";

/**
 * Top-level solve pipeline: split the grid into islands, solve each one under
 * its own slice of the time budget, then stitch the results back into grid
 * coordinates. Port of `solver/solver.py`.
 *
 * This is the single-threaded path. The app runs islands concurrently in a
 * worker pool instead — see `SolverCoordinator`, which shares the helpers
 * below so both paths produce byte-identical result objects.
 */

export const DEFAULT_TIME_BUDGET_S = 10.0;

export interface IslandPlan {
  islands: IslandSubGrid[];
  effectiveBuildings: EffectiveBuilding[];
  /** Per-island time budget, proportional to buildable-tile count. */
  budgetsS: number[];
  /** Per-island RNG seed, or undefined for a fresh stochastic stream. */
  seeds: (number | undefined)[];
  originalWidth: number;
  totalGrassTiles: number;
  theoreticalMaxPower: number;
}

/**
 * Everything both solve paths need before any island is touched: the island
 * decomposition, the roster, and how the time budget is divided.
 *
 * Islands never interact — nothing that happens on one can affect another — so
 * each gets its full proportional share of the budget and they may run in any
 * order, or concurrently.
 */
export function planSolve(
  grid: Tile[][],
  buildings: BuildingDefinition[],
  unlockedUpgrades: Record<string, number>,
  timeBudgetS: number,
  rngSeed?: number,
): IslandPlan | null {
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0)
    return null;

  const totalGrassTiles = countGrassTiles(grid);
  if (totalGrassTiles === 0) return null;

  const effectiveBuildings = getEffectiveBuildings(buildings, unlockedUpgrades);
  if (effectiveBuildings.length === 0) return null;

  const islands = splitGridIntoIslands(
    grid,
    canCoolDirectProducer(effectiveBuildings),
  );
  if (islands.length === 0) return null;

  const grassCounts = islands.map((island) => countGrassTiles(island.grid));
  const totalIslandGrass = grassCounts.reduce((a, b) => a + b, 0) || 1;

  return {
    islands,
    effectiveBuildings,
    budgetsS: grassCounts.map(
      (count) => timeBudgetS * (count / totalIslandGrass),
    ),
    // Each island gets its own random stream, offset from the base seed so a
    // seeded solve is reproducible per island rather than coupled across them.
    seeds: islands.map((_, i) =>
      rngSeed === undefined ? undefined : (rngSeed + i) >>> 0,
    ),
    originalWidth: grid[0].length,
    totalGrassTiles,
    theoreticalMaxPower: estimateTotalMaxPower(islands, effectiveBuildings),
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
 * cross-checks against the Python reference) where there is no worker pool.
 *
 * @lintignore deliberate public entry point with no in-app caller
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
    );
    options?.onProgress?.(buildOptimizationResult(plan, islandResults));
  }

  return buildOptimizationResult(plan, islandResults);
}
