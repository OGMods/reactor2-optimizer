/**
 * Whole-board layouts assembled out of per-island ties.
 *
 * Islands never interact, so one island's layout can be swapped for another of
 * its ties and nothing else on the board — least of all the total — moves.
 * That is what lets a solve offer ten answers without searching ten times, and
 * it is the property these cases pin.
 */
import { describe, expect, it } from "vitest";
import { buildSolveVariants } from "./variants";
import { getAnomaly } from "@reactor2/solver";
import type { IslandPlan } from "@reactor2/solver";
import type { IslandSolution } from "@reactor2/solver";
import type { IslandLayout, PlacedBuilding, Tile } from "@reactor2/solver";

const ORIGINAL_WIDTH = 4;

/** One building on an island-local tile, carrying `power` and nothing else. */
function placed(
  buildingId: string,
  x: number,
  y: number,
  power: number,
): PlacedBuilding {
  return {
    x,
    y,
    buildingId,
    baseValue: 1,
    powerGenerated: power,
    heatProduced: 0,
    heatConsumed: 0,
    wasteHeatGenerated: 0,
    coolingProvided: 0,
    coolingReceived: 0,
  };
}

/** A layout of one building, on the island-local tile `x`. */
function layout(buildingId: string, x: number, power: number): IslandLayout {
  return { placements: [placed(buildingId, x, 0, power)], powerOutput: power };
}

/**
 * Two 2×1 islands side by side on a 4-wide grid. Only the fields
 * `buildOptimizationResult` reads are filled in.
 */
function plan(): IslandPlan {
  const island = (offset: number) => ({
    width: 2,
    height: 1,
    grid: [] as Tile[][],
    buildable: Uint8Array.from([1, 1]),
    tileCount: 2,
    originalTileIndices: [offset, offset + 1],
  });
  return {
    islands: [island(0), island(2)],
    effectiveBuildings: [],
    anomaly: getAnomaly(undefined),
    budgetsS: [1, 1],
    seeds: [undefined, undefined],
    originalWidth: ORIGINAL_WIDTH,
    totalGrassTiles: 4,
    theoreticalMaxPower: 1000,
  };
}

/** Which building sits where, in full-grid coordinates. */
const shapeOf = (placements: PlacedBuilding[]) =>
  placements
    .map((p) => `${p.buildingId}@${p.x},${p.y}`)
    .sort()
    .join(" ");

describe("buildSolveVariants", () => {
  it("offers only the primary when no island found a tie", () => {
    const variants = buildSolveVariants(plan(), [
      layout("a", 0, 10),
      layout("b", 0, 20),
    ]);
    expect(variants).toHaveLength(1);
    expect(variants[0].totalPower).toBe(30);
  });

  it("swaps one island at a time, cycling across them", () => {
    const results: IslandSolution[] = [
      {
        ...layout("a", 0, 10),
        alternates: [layout("a", 1, 10), layout("A", 0, 10)],
      },
      { ...layout("b", 0, 20), alternates: [layout("b", 1, 20)] },
    ];

    const variants = buildSolveVariants(plan(), results);

    // Primary, then island 0's first tie, then island 1's, then island 0's
    // second — the second island gets a turn before the first is exhausted.
    // The last one is the fill-up pass: with every single-island swap used and
    // the shortlist still short, both islands move at once.
    expect(variants.map((v) => shapeOf(v.placements))).toEqual([
      "a@0,0 b@2,0",
      "a@1,0 b@2,0",
      "a@0,0 b@3,0",
      "A@0,0 b@2,0",
      "a@1,0 b@3,0",
    ]);
    // The point of the whole exercise: they are all worth the same.
    for (const variant of variants) expect(variant.totalPower).toBe(30);
  });

  it("never repeats a board, however an island reports its ties", () => {
    const results: IslandSolution[] = [
      { ...layout("a", 0, 10), alternates: [layout("a", 0, 10)] },
      layout("b", 0, 20),
    ];
    expect(buildSolveVariants(plan(), results)).toHaveLength(1);
  });

  it("drops a tie that does not actually tie", () => {
    const results: IslandSolution[] = [
      { ...layout("a", 0, 10), alternates: [layout("a", 1, 9)] },
      layout("b", 0, 20),
    ];
    expect(buildSolveVariants(plan(), results)).toHaveLength(1);
  });

  it("stops at the limit", () => {
    const alternates = Array.from({ length: 20 }, (_, i) =>
      layout(`a${i}`, i % 2, 10),
    );
    const results: IslandSolution[] = [
      { ...layout("a", 0, 10), alternates },
      layout("b", 0, 20),
    ];
    expect(buildSolveVariants(plan(), results, 5)).toHaveLength(5);
  });
});
