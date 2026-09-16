/**
 * The post-solve checks.
 *
 * `verify` is the last thing between a search bug and a layout that cannot be
 * built: two buildings on one tile, a building on water, a building the player
 * has not unlocked. Ported from the reference solver's `tests/test_report.py`.
 * Its console-summary half went with the summary itself, which now lives in the
 * CLI (`bin/solve.ts`) rather than in the engine — printing is not the library's
 * job, and a solver that imports a number formatter has acquired a reason to
 * care how a number looks.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { verify } from "../src/solver/report";
import type {
  EffectiveBuilding,
  OptimizationResult,
  PlacedBuilding,
  Tile,
} from "../src/solver/types";
import { basicRoster, makeGrid } from "./helpers";

function placed(x: number, y: number, buildingId = "reactor"): PlacedBuilding {
  return {
    x,
    y,
    buildingId,
    baseValue: 0,
    powerGenerated: 0,
    heatProduced: 0,
    heatConsumed: 0,
    wasteHeatGenerated: 0,
    coolingProvided: 0,
    coolingReceived: 0,
  };
}

function resultWith(
  placements: PlacedBuilding[],
  totalPower = 100,
  maxPower = 200,
): OptimizationResult {
  return {
    totalPower,
    placements,
    activeTilesCount: placements.length,
    unusedTilesCount: 0,
    summary: {
      totalHeatProduced: 0,
      totalHeatConsumed: 0,
      totalWasteGenerated: 0,
      totalCoolingCapacity: 0,
    },
    theoreticalMaxPower: maxPower,
  };
}

describe("verify", () => {
  let grid: Tile[][];
  let roster: EffectiveBuilding[];

  beforeEach(() => {
    grid = makeGrid(["GGG", "G.R"]);
    roster = basicRoster();
  });

  it("accepts a valid layout", () => {
    const result = resultWith([
      placed(0, 0),
      placed(1, 0, "generator"),
      placed(2, 0, "cooler"),
    ]);

    expect(() => verify(grid, roster, result)).not.toThrow();
  });

  it("rejects two buildings on the same tile", () => {
    const result = resultWith([placed(0, 0), placed(0, 0, "cooler")]);

    expect(() => verify(grid, roster, result)).toThrow(/Duplicate tile/);
  });

  it("rejects a building on water", () => {
    expect(() => verify(grid, roster, resultWith([placed(1, 1)]))).toThrow(
      /non-grass/,
    );
  });

  it("rejects a building on scenery", () => {
    expect(() => verify(grid, roster, resultWith([placed(2, 1)]))).toThrow(
      /non-grass/,
    );
  });

  it("rejects a building that is not in the roster", () => {
    const result = resultWith([placed(0, 0, "not_unlocked")]);

    expect(() => verify(grid, roster, result)).toThrow(/Unavailable\/locked/);
  });

  it("allows the same building id on many tiles", () => {
    // There is no per-id quantity limit — only tile availability.
    const result = resultWith([placed(0, 0), placed(1, 0), placed(2, 0)]);

    expect(() => verify(grid, roster, result)).not.toThrow();
  });

  it("accepts an empty layout", () => {
    expect(() => verify(grid, roster, resultWith([]))).not.toThrow();
  });

  it("rejects a placement off the edge of the board", () => {
    // The reference indexed the grid directly and raised an IndexError here;
    // optional chaining makes this a normal rejection rather than a crash.
    expect(() => verify(grid, roster, resultWith([placed(9, 9)]))).toThrow(
      /non-grass/,
    );
  });
});
