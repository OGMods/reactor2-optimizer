/**
 * `solve()`: the whole-grid pipeline.
 *
 * The pipeline's own job is small — split, budget, delegate, remap — but the
 * remapping step is the one that turns island-local coordinates back into grid
 * coordinates, and a mistake there produces a plausible-looking result that
 * renders and scores against the wrong tiles.
 *
 * Ported from the reference solver's `tests/test_pipeline.py`. Its
 * `ParallelSolveTests` are not ported: they drove a `ProcessPoolExecutor` that
 * this tree does not have, and the thing they were really testing — that
 * farming islands out to workers loses neither a tile nor a board — is what
 * `src/lib/worker/solverCoordinator.test.ts` covers on this side, against the
 * actual pool.
 *
 * Every budget below is deliberately short. These are contract tests: they ask
 * whether the answer is well-formed, not whether it is good. The two that do
 * ask about quality say so.
 */
import { describe, expect, it } from "vitest";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { decodeBlueprint } from "../src/encoding/blueprint";
import { ISLAND_TEMPLATES } from "../src/data/maps";
import { makeGrid } from "../src/grid";
import { buildIslandContext } from "../src/solver/context";
import {
  canCoolDirectProducer,
  countGrassTiles,
  splitGridIntoIslands,
} from "../src/solver/island";
import { simulateIsland } from "../src/solver/simulate";
import { solve } from "../src/solver/solver";
import type { Placement, Tile } from "../src/solver/types";
import { basicCatalogue, basicRoster, expectClose } from "./helpers";

const { buildings, unlocks } = basicCatalogue();

/** The first shipped island, decoded — the "real map" these cases run on. */
async function realMap(): Promise<Tile[][]> {
  return (await decodeBlueprint(ISLAND_TEMPLATES[0].code)).grid;
}

describe("the solve contract", () => {
  it("handles an empty grid", async () => {
    const result = await solve([], buildings, unlocks, 0.1);

    expectClose(result.totalPower, 0);
    expect(result.placements).toEqual([]);
    expect(result.activeTilesCount).toBe(0);
  });

  it("handles a grid with no buildable tiles", async () => {
    const grid = makeGrid(["....", ".RR."]);

    const result = await solve(grid, buildings, unlocks, 0.1);

    expectClose(result.totalPower, 0);
    expect(result.placements).toEqual([]);
    expect(result.unusedTilesCount).toBe(0);
  });

  it("handles a roster that cannot build anything", async () => {
    const grid = makeGrid(["GGGG"]);
    const coolersOnly = buildings.filter((b) => b.type !== "generator");

    const result = await solve(grid, coolersOnly, unlocks, 0.2);

    expectClose(result.totalPower, 0);
    expect(result.placements).toEqual([]);
    expect(
      result.unusedTilesCount,
      "all four grass tiles are still counted",
    ).toBe(4);
  });

  it("adds its tile accounting up", async () => {
    const grid = makeGrid(["GGGG", "GG.G", "GGGG"]);

    const result = await solve(grid, buildings, unlocks, 0.5);

    expect(result.activeTilesCount + result.unusedTilesCount).toBe(
      countGrassTiles(grid),
    );
    expect(result.activeTilesCount).toBe(result.placements.length);
  });

  it("lands every placement on grass at original grid coordinates", async () => {
    // Guards the island-local -> grid coordinate remapping.
    const grid = makeGrid(["........", "..GGGG..", "..GGGG..", "........"]);

    const result = await solve(grid, buildings, unlocks, 0.5);

    expect(result.placements.length).toBeGreaterThan(0);
    for (const p of result.placements) {
      expect(
        grid[p.y][p.x].type,
        `placement at (${p.x},${p.y}) is not on grass`,
      ).toBe("grass");
    }
  });

  it("never uses a tile twice", async () => {
    const grid = makeGrid(["GGGG..GGGG", "GGGG..GGGG"]);

    const result = await solve(grid, buildings, unlocks, 0.5);

    const positions = result.placements.map((p) => `${p.x},${p.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("reports the power a fresh simulation of the whole grid finds", async () => {
    /*
     * Islands are 8-connected components, so no two islands can interact and
     * simulating every placement together must reproduce the summed total.
     */
    const grid = makeGrid(["GGGG..GGGG", "GGGG..GGGG"]);
    const byId = new Map(basicRoster().map((b) => [b.id, b]));

    const result = await solve(grid, buildings, unlocks, 0.6);

    const ctx = buildIslandContext(grid);
    const layout: Placement = new Array(ctx.n).fill(null);
    for (const p of result.placements) {
      for (let i = 0; i < ctx.n; i++) {
        if (ctx.xs[i] === p.x && ctx.ys[i] === p.y) {
          layout[i] = byId.get(p.buildingId)!;
          break;
        }
      }
    }

    expectClose(simulateIsland(layout, ctx).totalPower, result.totalPower);
  });

  it("works on every island", async () => {
    const grid = makeGrid(["GGGG..GGGG..GGGG"]);
    const roster = basicRoster();
    expect(
      splitGridIntoIslands(grid, canCoolDirectProducer(roster)).length,
    ).toBe(3);

    const result = await solve(grid, buildings, unlocks, 1.2);

    const usedColumns = new Set(result.placements.map((p) => p.x));
    expect(
      [...usedColumns].some((x) => x < 4),
      "first island unused",
    ).toBe(true);
    expect(
      [...usedColumns].some((x) => x >= 6 && x < 10),
      "second island unused",
    ).toBe(true);
    expect(
      [...usedColumns].some((x) => x >= 12),
      "third island unused",
    ).toBe(true);
  });

  it("never places a producer that generates no power", async () => {
    /*
     * Grid-level version of the stability requirement: no overheating or idle
     * generator/direct producer may survive into the final result.
     */
    const roster = getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked());
    const byId = new Map(roster.map((b) => [b.id, b]));
    const grid = await realMap();

    const result = await solve(
      grid,
      [...BUILDINGS],
      allUpgradesUnlocked(),
      1.5,
    );

    expect(result.placements.length).toBeGreaterThan(0);
    for (const p of result.placements) {
      const building = byId.get(p.buildingId)!;
      if (
        building.type === "generator" ||
        building.type === "direct_producer"
      ) {
        expect(
          p.powerGenerated,
          `${p.buildingId} at (${p.x},${p.y}) is placed but generates nothing`,
        ).toBeGreaterThan(0);
      }
    }
  }, 20_000);

  it("totals its summary from the placements it returned", async () => {
    const grid = makeGrid(["GGGG", "GGGG"]);

    const result = await solve(grid, buildings, unlocks, 0.5);
    const { summary, placements } = result;
    const sum = (pick: (p: (typeof placements)[number]) => number) =>
      placements.reduce((total, p) => total + pick(p), 0);

    expectClose(
      summary.totalHeatProduced,
      sum((p) => p.heatProduced),
    );
    expectClose(
      summary.totalCoolingCapacity,
      sum((p) => p.coolingProvided),
    );
    expectClose(
      summary.totalWasteGenerated,
      sum((p) => p.wasteHeatGenerated),
    );
  });

  it("reports a theoretical maximum", async () => {
    const grid = makeGrid(["GGGG", "GGGG"]);

    const result = await solve(grid, buildings, unlocks, 0.3);

    expect(
      result.theoreticalMaxPower,
      "the efficiency figure in the summary depends on this",
    ).toBeGreaterThan(0);
  });
});

describe("solve quality", () => {
  // A floor on real-map results, so a broken heuristic cannot pass silently.

  it("reaches a reasonable fraction of the bound on a real map", async () => {
    const grid = await realMap();

    const result = await solve(
      grid,
      [...BUILDINGS],
      allUpgradesUnlocked(),
      2.0,
    );

    expect(
      result.totalPower,
      `solve produced ${result.totalPower.toExponential(3)} against a ` +
        `${result.theoreticalMaxPower.toExponential(3)} bound`,
    ).toBeGreaterThan(0.75 * result.theoreticalMaxPower);
  }, 20_000);

  it("does not come back materially worse for a longer budget", async () => {
    /*
     * Not a strict guarantee — the search is stochastic — but a long budget
     * repeatedly falling below a very short one would mean annealing is
     * actively destroying the seed.
     */
    const grid = makeGrid(["GGGG", "GGGG", "GGGG"]);

    const quick = (await solve(grid, buildings, unlocks, 0.2)).totalPower;
    const longer = (await solve(grid, buildings, unlocks, 1.5)).totalPower;

    expect(
      longer,
      "a longer search came back materially worse than a short one",
    ).toBeGreaterThanOrEqual(quick * 0.9);
  }, 20_000);
});
