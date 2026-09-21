/**
 * Island decomposition and the theoretical max-power bound.
 *
 * Islands are the solver's parallelism and correctness boundary: if two tiles
 * that CAN interact end up in different islands, the solver silently loses
 * layouts. The coordinate remapping is equally load-bearing — get it wrong and
 * buildings render (and verify) on the wrong tiles.
 *
 * Ported from the reference solver's `tests/test_island.py`. The per-island
 * bound is exercised through `estimateTotalMaxPower([island], roster)` rather
 * than by exporting the private `estimateIslandMaxPower`: the sum over one
 * island is that island's estimate, and the public surface stays the surface.
 */
import { describe, expect, it } from "vitest";
import { EPS } from "../src/solver/constants";
import { buildIslandContext } from "../src/solver/context";
import { makeGrid } from "../src/grid";
import {
  canCoolDirectProducer,
  countGrassTiles,
  estimateTotalMaxPower,
  splitGridIntoIslands,
} from "../src/solver/island";
import { Rng } from "../src/solver/rng";
import { simulateIsland } from "../src/solver/simulate";
import type {
  EffectiveBuilding,
  IslandSubGrid,
  Placement,
} from "../src/solver/types";
import {
  basicRoster,
  cooler,
  directProducer,
  expectClose,
  generator,
  reactor,
} from "./helpers";

/**
 * The first island of an ASCII board.
 *
 * Note `splitGridIntoIslands` takes the *resolved* predicate rather than the
 * roster the reference passed it — the caller already knows whether a direct
 * producer can be cooled and the split runs per board, so working it out again
 * inside the loop bought nothing. Every call here goes through
 * `canCoolDirectProducer` so the tests exercise the same pairing the solver
 * does.
 */
function islandFor(rows: string[], roster = basicRoster()): IslandSubGrid {
  const islands = splitGridIntoIslands(
    makeGrid(rows),
    canCoolDirectProducer(roster),
  );
  if (islands.length === 0) throw new Error("no islands");
  return islands[0];
}

/** One island's theoretical bound. */
function boundFor(island: IslandSubGrid, roster: EffectiveBuilding[]): number {
  return estimateTotalMaxPower([island], roster);
}

describe("splitting a grid into islands", () => {
  const roster = basicRoster();
  const canCool = canCoolDirectProducer(roster);

  it("makes one island of a single connected block", () => {
    const islands = splitGridIntoIslands(makeGrid(["GGG", "GGG"]), canCool);

    expect(islands.length).toBe(1);
    expect([islands[0].width, islands[0].height]).toEqual([3, 2]);
    expect(countGrassTiles(islands[0].grid)).toBe(6);
  });

  it("separates islands with water", () => {
    const islands = splitGridIntoIslands(
      makeGrid(["GGG..GGG", "GGG..GGG"]),
      canCool,
    );

    expect(islands.length).toBe(2);
    for (const island of islands) expect(countGrassTiles(island.grid)).toBe(6);
  });

  it("keeps corner-touching blocks in one island", () => {
    /*
     * Interaction is 8-neighbour, so two blocks touching only at a corner CAN
     * interact and must stay in the same island.
     */
    const islands = splitGridIntoIslands(
      makeGrid(["GGG...", "GGG...", "...GGG", "...GGG"]),
      canCool,
    );

    expect(islands.length, "corner-touching blocks are one island").toBe(1);
    expect(countGrassTiles(islands[0].grid)).toBe(12);
  });

  it("treats every scenery tile as impassable", () => {
    // Rocks, trees, ponds and transformers all block exactly like water.
    const islands = splitGridIntoIslands(makeGrid(["GGGRTUOXGGG"]), canCool);

    expect(islands.length).toBe(2);
    for (const island of islands) expect(countGrassTiles(island.grid)).toBe(3);
  });

  it("drops islands smaller than three tiles", () => {
    /*
     * Without a direct producer, the smallest working chain is
     * reactor + generator + cooler, so 1- and 2-tile components are dead.
     */
    expect(canCool).toBe(false);

    const islands = splitGridIntoIslands(makeGrid(["G.GG.GGG"]), canCool);

    expect(islands.length).toBe(1);
    expect(countGrassTiles(islands[0].grid)).toBe(3);
  });

  it("keeps two-tile islands when a cooler can cover a direct producer", () => {
    const withDp = basicRoster({ dpValue: 100, dpWasteRatio: 0.2 }); // waste 20 <= cooler 100
    expect(canCoolDirectProducer(withDp)).toBe(true);

    const islands = splitGridIntoIslands(
      makeGrid(["G.GG.GGG"]),
      canCoolDirectProducer(withDp),
    );

    expect(
      islands.map((i) => countGrassTiles(i.grid)).sort((a, b) => a - b),
      "the 2-tile component is now viable, the 1-tile one is still not",
    ).toEqual([2, 3]);
  });

  it("returns nothing for an empty or waterlogged grid", () => {
    expect(splitGridIntoIslands([], canCool)).toEqual([]);
    expect(splitGridIntoIslands(makeGrid(["...."]), canCool)).toEqual([]);
  });

  it("masks out tiles belonging to another island", () => {
    /*
     * An island's bounding box can overlap another island. Those foreign tiles
     * must appear as water in the sub-grid, or the solver would build on them.
     */
    const islands = splitGridIntoIslands(
      makeGrid(["GGG.G", "GGG.G", "GGG.G"]),
      canCool,
    );

    expect(islands.length).toBe(2);
    for (const island of islands) {
      // No island may claim more tiles than its own bounding box holds.
      expect(countGrassTiles(island.grid)).toBeLessThanOrEqual(
        island.width * island.height,
      );
    }
    expect(
      islands.map((i) => countGrassTiles(i.grid)).sort((a, b) => a - b),
    ).toEqual([3, 9]);
  });
});

describe("coordinate remapping", () => {
  it("points original tile indices back at the source tiles", () => {
    const grid = makeGrid(["......", "..GGG.", "..GGG."]);
    const originalWidth = grid[0].length;

    const roster = basicRoster();
    const islands = splitGridIntoIslands(grid, canCoolDirectProducer(roster));
    const island = islands[0];

    expect(islands.length).toBe(1);
    for (let localY = 0; localY < island.height; localY++) {
      for (let localX = 0; localX < island.width; localX++) {
        const flat = island.originalTileIndices[localY * island.width + localX];
        const origY = Math.floor(flat / originalWidth);
        const origX = flat % originalWidth;
        expect(
          grid[origY][origX].type,
          `local (${localX},${localY}) should map to original (${origX},${origY})`,
        ).toBe(island.grid[localY][localX].type);
      }
    }
  });

  it("makes local tile coordinates island-relative", () => {
    const island = splitGridIntoIslands(
      makeGrid([".....", ".GGG.", ".GGG."]),
      canCoolDirectProducer(basicRoster()),
    )[0];

    expect(island.grid[0][0].x).toBe(0);
    expect(island.grid[0][0].y).toBe(0);
    // The window is the component's box (x 1-3, y 1-2) padded a tile on every
    // side and clamped to the board, so it holds every neighbour of every
    // island tile — which is what a terrain rule has to be able to read.
    expect([island.width, island.height]).toEqual([5, 3]);
    expect(island.tileCount).toBe(6);
    // Padding brings in tiles that are not this island's, so membership is the
    // mask rather than the terrain.
    expect([...island.buildable]).toEqual([
      0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0,
    ]);
  });
});

describe("canCoolDirectProducer", () => {
  it("is false without coolers", () => {
    expect(canCoolDirectProducer([directProducer(10, 0.2)])).toBe(false);
  });

  it("is false without direct producers", () => {
    expect(canCoolDirectProducer([cooler(100), reactor(100)])).toBe(false);
  });

  it("is true when one cooler covers the whole waste", () => {
    expect(canCoolDirectProducer([cooler(20), directProducer(100, 0.2)])).toBe(
      true,
    );
  });

  it("treats the boundary as inclusive", () => {
    // Waste exactly equal to cooling is enough (the rule is <=).
    expect(canCoolDirectProducer([cooler(20), directProducer(100, 0.2)])).toBe(
      true,
    );
    expect(
      canCoolDirectProducer([cooler(19.9), directProducer(100, 0.2)]),
    ).toBe(false);
  });
});

describe("the theoretical max-power bound", () => {
  /*
   * The bound feeds the "layout efficiency" figure, and it must be a TRUE upper
   * bound: no layout on the island may ever beat it, or the efficiency figure
   * reads above 100% and stops meaning anything. (An earlier per-hub density
   * estimate ignored cross-hub sharing and was routinely exceeded.) Most cases
   * here check the shape of the estimate; the random-layout one checks the
   * bound property itself.
   */

  it("is zero for an island with no buildable tiles", () => {
    const empty: IslandSubGrid = {
      width: 0,
      height: 0,
      grid: [],
      buildable: new Uint8Array(0),
      tileCount: 0,
      originalTileIndices: [],
    };

    expectClose(boundFor(empty, basicRoster()), 0);
  });

  it("is zero without coolers", () => {
    expectClose(
      boundFor(islandFor(["GGGG"]), [reactor(100), generator(100)]),
      0,
    );
  });

  it("grows with island size", () => {
    const roster = basicRoster();

    expect(boundFor(islandFor(["GGG"]), roster)).toBeLessThan(
      boundFor(islandFor(["GGGGGG", "GGGGGG"]), roster),
    );
  });

  it("matches the hand calculation for a three-tile hub", () => {
    // 1 reactor (100) + 1 generator (100) + 1 cooler (25) = 75 power.
    const roster = [reactor(100), generator(100), cooler(25)];

    expectClose(boundFor(islandFor(["GGG"]), roster), 75);
  });

  it("is never beaten by a random layout", () => {
    /*
     * The bound property itself, exercised the only way that generalizes: throw
     * hundreds of arbitrary layouts (including mixed generator + direct producer
     * ones sharing coolers) at a fixed island and check every simulated power
     * lands at or under the estimate.
     */
    const roster = basicRoster({ dpValue: 120, dpWasteRatio: 0.2 });
    const island = islandFor(["GGG", "GGG", "GGG"], roster);
    const bound = boundFor(island, roster);
    const ctx = buildIslandContext(island.grid);

    const rng = new Rng(20260818);
    const options: (EffectiveBuilding | null)[] = [...roster, null];
    for (let attempt = 0; attempt < 300; attempt++) {
      const placement: Placement = Array.from({ length: ctx.n }, () =>
        rng.choice(options),
      );

      const { totalPower } = simulateIsland(placement, ctx);

      expect(
        totalPower,
        `a layout beat the 'upper' bound on attempt ${attempt}`,
      ).toBeLessThanOrEqual(bound + EPS);
    }
  });

  it("totals as the sum over islands", () => {
    const roster = basicRoster();
    const islands = splitGridIntoIslands(
      makeGrid(["GGG..GGG"]),
      canCoolDirectProducer(roster),
    );

    expectClose(
      estimateTotalMaxPower(islands, roster),
      islands.reduce((sum, i) => sum + boundFor(i, roster), 0),
    );
    expect(estimateTotalMaxPower([], roster)).toBe(0);
  });
});
