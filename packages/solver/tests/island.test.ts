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
import { getAnomaly } from "../src/data/anomalies";
import { ISLAND_TEMPLATES } from "../src/data/maps";
import { decodeBlueprint } from "../src/encoding/blueprint";
import {
  canCoolDirectProducer,
  computeWaterAdjacency,
  countGrassTiles,
  estimateTotalMaxPower,
  minIslandTiles,
  splitGridIntoIslands,
} from "../src/solver/island";
import { Rng } from "../src/solver/rng";
import { simulateIsland } from "../src/solver/simulate";
import type {
  EffectiveBuilding,
  IslandSubGrid,
  Placement,
  TerrainAffinityAnomaly,
} from "../src/solver/types";
import {
  basicRoster,
  cooler,
  directProducer,
  expectClose,
  generator,
  placeOn,
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

describe("the smallest patch worth keeping", () => {
  const cryo = getAnomaly("cryo_nexus");

  it("is 3 tiles, or 2 when one cooler can cover a direct producer", () => {
    expect(minIslandTiles(false)).toBe(3);
    expect(minIslandTiles(true)).toBe(2);
  });

  it("does not apply under a shared cooling pool — the board is one island", () => {
    /*
     * The floors exist because cooling has to cross a tile boundary. Pooled it
     * does not, and the components stop being independent at all, so the whole
     * board is handed over as one island and every grass tile comes with it —
     * including the ones a decomposition drops. 21 tiles across the shipped
     * maps that no other rule in the game can use.
     */
    const board = makeGrid(["G.GG.GGG"]);

    expect(splitGridIntoIslands(board, false).map((i) => i.tileCount)).toEqual([
      3,
    ]);

    const pooled = splitGridIntoIslands(board, false, cryo);
    expect(pooled.length, "one island, whatever the terrain").toBe(1);
    expect(pooled[0].tileCount, "every grass tile, 1 + 2 + 3").toBe(6);
  });

  it("hands over the board's own dimensions and an identity remap", () => {
    // The window is the board, so a placement needs no coordinate translation
    // on the way back out.
    const board = makeGrid(["GG.G", "GG.G"]);
    const [island] = splitGridIntoIslands(board, false, cryo);

    expect([island.width, island.height]).toEqual([4, 2]);
    expect(island.tileCount).toBe(6);
    expect([...island.originalTileIndices]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Water is still not buildable — one island is not one usable island.
    expect([...island.buildable]).toEqual([1, 1, 0, 1, 1, 1, 0, 1]);
  });
});

describe("water adjacency", () => {
  /*
   * Off the board counts as water: the game has one global map on which every
   * island sits in open water, and these boards are rectangles cut out of it.
   * The flag has to be resolved on the full grid, because an island's window is
   * padded *clamped to the board* — so a tile on the board's own edge has no
   * off-board neighbour inside its window to test, and the natural
   * bounds-check-and-skip would read it as inland.
   */
  const flagsOf = (rows: string[]) => {
    const grid = makeGrid(rows);
    const width = grid[0].length;
    const flags = computeWaterAdjacency(grid);
    return (x: number, y: number) => flags[y * width + x];
  };

  it("flags every tile on the board's edge", () => {
    const at = flagsOf(["GGGGG", "GGGGG", "GGGGG"]);

    // The middle row's interior: eight in-board neighbours, none of them water.
    // (1, 1) and (3, 1) qualify too on a board this wide; one is enough to show
    // the flag is not simply set everywhere.
    expect(at(2, 1)).toBe(0);
    for (const [x, y] of [
      [0, 0],
      [2, 0],
      [4, 2],
      [0, 1],
      [4, 1],
    ] as const) {
      expect(at(x, y), `(${x}, ${y}) is on the board's edge`).toBe(1);
    }
  });

  it("flags a tile beside water, and not one beside a pond or a rock", () => {
    // A pond looks wet and is filed with the rocks and the trees: an obstacle,
    // and no shore bonus. Only the water tile proper counts.
    const at = flagsOf([
      "RRRRRRR",
      "RG.GORG",
      "RGGGGRG",
      "RRRRRRR",
    ]);

    expect(at(1, 2), "diagonally below the water at (2, 1)").toBe(1);
    expect(at(3, 2), "diagonally below the water at (2, 1)").toBe(1);
    expect(at(4, 2), "beside the pond at (4, 1), which is not water").toBe(0);
  });

  it("carries the board-edge flag into a window that cannot see the edge", () => {
    /*
     * The trap, concretely. This island is clamped against the board's left,
     * top and bottom edges, so in its own window those tiles sit at coordinate
     * 0 — indistinguishable from the window boundary that padding creates
     * everywhere else. Resolved from the window, every one of them would read
     * as inland.
     */
    const islands = splitGridIntoIslands(makeGrid(["GGGRRRR", "GGGRRRR", "GGGRRRR"]));

    expect(islands.length).toBe(1);
    const island = islands[0];
    const at = (x: number, y: number) =>
      island.waterAdjacent[y * island.width + x];

    // The window is padded one tile to the right only — the other three sides
    // are the board's, so sub coordinates match original ones for this island.
    expect(island.width).toBe(4);
    expect([at(0, 0), at(1, 0), at(0, 1), at(1, 2)]).toEqual([1, 1, 1, 1]);
    // The two interior tiles: eight in-board neighbours, none of them water.
    expect([at(1, 1), at(2, 1)]).toEqual([0, 0]);
  });

  it("indexes like `buildable`, over the same window", () => {
    const [island] = splitGridIntoIslands(makeGrid(["RRRRR", "RGGGR", "RRRRR"]));

    expect(island.waterAdjacent.length).toBe(island.buildable.length);
    expect(island.waterAdjacent.length).toBe(island.width * island.height);
  });

  it("translates the mask by the window's own origin", () => {
    /*
     * The mask is copied out of the full-grid pass at `origY * originalWidth +
     * origX`, and forgetting either half of that origin is the one natural
     * mistake in the loop. Every case above has a window whose pad origin is
     * (0, 0) — clamped against the board on both axes — so the offset cancels
     * and a mis-indexed read is the right answer by accident.
     *
     * This component is inset from the left and the top, so `padMinX` is 2 and
     * `padMinY` is 1, and the only water on the board sits on one side of it.
     * The mask is therefore asymmetric: read at the wrong origin it describes a
     * different neighbourhood, and under a terrain bonus that is the wrong tiles
     * rated x1.67 with nothing failing.
     */
    const rows = [
      "RRRRRRRR",
      "RRRRRRRR",
      "RR.GGGRR",
      "RRRGGGRR",
      "RRRGGGRR",
      "RRRRRRRR",
      "RRRRRRRR",
    ];
    const grid = makeGrid(rows);
    const [island] = splitGridIntoIslands(grid, false);
    const full = computeWaterAdjacency(grid);
    const originalWidth = grid[0].length;

    // The window: the component's box (x 3-5, y 2-4) padded a tile on every
    // side, so its origin is genuinely off the board's.
    expect([island.width, island.height]).toEqual([5, 5]);
    expect(island.originalTileIndices[0]).toBe(1 * originalWidth + 2);

    // Read through the window's own remap, which is the translation spelled out
    // a second and independent way.
    for (let localY = 0; localY < island.height; localY++) {
      for (let localX = 0; localX < island.width; localX++) {
        const localFlat = localY * island.width + localX;
        expect(
          island.waterAdjacent[localFlat],
          `local (${localX},${localY})`,
        ).toBe(full[island.originalTileIndices[localFlat]]);
      }
    }

    // And as literal values, so the two spellings cannot be wrong together.
    // Only the water at (2, 2) and the board's own edges flag anything, and
    // neither reaches this component's interior: local (1,1) and (1,2) are the
    // grass beside the water, and the rest of the island is inland.
    const at = (x: number, y: number) =>
      island.waterAdjacent[y * island.width + x];
    expect([at(1, 1), at(1, 2)], "the grass beside the water").toEqual([1, 1]);
    expect(
      [at(2, 1), at(3, 1), at(2, 2), at(1, 3), at(3, 3)],
      "every other tile of the island is inland",
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it("carries the right mask on every island of every shipped map", async () => {
    /*
     * Where the real divergence lives. Every one of the eight shipped boards has
     * islands whose window is off the origin, and a mis-indexed copy was measured
     * against the correct mask at between 28 and 166 mismatched tiles per map —
     * which under Tidal Ascendancy is that many tiles rated at the wrong
     * multiplier, on the boards players actually solve. The fixtures pass no
     * anomaly, so nothing else in the suite can see it.
     */
    let offOriginWindows = 0;

    for (const template of ISLAND_TEMPLATES) {
      const { grid } = await decodeBlueprint(template.code);
      const originalWidth = grid[0].length;
      const full = computeWaterAdjacency(grid);

      for (const island of splitGridIntoIslands(grid, false)) {
        const origin = island.originalTileIndices[0];
        if (origin % originalWidth > 0 || origin >= originalWidth)
          offOriginWindows++;

        for (let i = 0; i < island.waterAdjacent.length; i++) {
          expect(
            island.waterAdjacent[i],
            `${template.id}, window tile ${i}`,
          ).toBe(full[island.originalTileIndices[i]]);
        }
      }
    }

    expect(offOriginWindows, "the case this is here for").toBeGreaterThan(0);
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
      waterAdjacent: new Uint8Array(0),
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

  it("is never beaten by a random layout under a terrain bonus", () => {
    /*
     * The same property under the one anomaly the search acts on, and the case
     * that actually broke it: a shore tile rates its building above the roster,
     * so a bound computed on the plain roster is one a real layout walks past.
     * A CLI run on Magma Rift reported 119.9% layout efficiency before the
     * bound learned about the anomaly.
     *
     * The board is bare grass, so every tile of it is on the board's edge and
     * every building is bonused — the worst case for the bound, and the one
     * where being loose is no excuse.
     */
    const tidal = getAnomaly("tidal_ascendancy");
    const roster = basicRoster({ dpValue: 120, dpWasteRatio: 0.2 });
    const island = islandFor(["GGG", "GGG", "GGG"], roster);
    const bound = estimateTotalMaxPower([island], roster, tidal);
    const ctx = buildIslandContext(
      island.grid,
      island.buildable,
      tidal,
      island.waterAdjacent,
    );
    expect(ctx.uniformRating, "every tile here is shore").toBe(false);

    const rng = new Rng(20260921);
    const options: (EffectiveBuilding | null)[] = [...roster, null];
    for (let attempt = 0; attempt < 300; attempt++) {
      const placement: Placement = Array.from({ length: ctx.n }, (_, t) => {
        const pick = rng.choice(options);
        return pick === null ? null : ctx.rate(t, pick);
      });

      const { totalPower } = simulateIsland(placement, ctx);

      expect(
        totalPower,
        `a layout beat the 'upper' bound on attempt ${attempt}`,
      ).toBeLessThanOrEqual(bound + EPS);
    }
  });

  it("is not beaten by a deliberately isolated generator layout", () => {
    /*
     * The case a random-layout test cannot find, and the one that shipped
     * broken. `role_isolation` scales an isolated generator's heat *intake* by
     * 2.5, so wherever generator intake is the short side of
     * `min(nReact * rVal, nGen * gVal)` a layout that keeps its generators apart
     * absorbs up to 2.5x the heat the bound allowed. Random placement almost
     * never isolates four generators, so this layout is built by hand:
     *
     *     G R G      four generators on the corners, which on a 3x3 are
     *     R C R      mutually non-adjacent (Chebyshev 2 apart), so every one of
     *     G R G      them rates `isolated`; one cooler in the middle reaches all
     *                four, and each generator touches two reactors.
     *
     * The roster is generator-bound on purpose — 100 of reactor heat against 20
     * of generator intake — which is an ordinary mid-game partial roster rather
     * than a contrivance: the full catalogue's top reactor has 3.9x the headroom
     * over its top generator, so the shipped maps were safe only by accident.
     */
    const singularity = getAnomaly("singularity_isolation");
    const roster = [reactor(100), generator(20), cooler(100)];
    const island = islandFor(["GGG", "GGG", "GGG"], roster);
    const ctx = buildIslandContext(
      island.grid,
      island.buildable,
      singularity,
      island.waterAdjacent,
    );
    const placement = placeOn(
      ctx,
      ["GRG", "RCR", "GRG"],
      { G: roster[1], R: roster[0], C: roster[2] },
    );

    const { totalPower } = simulateIsland(placement, ctx);

    // 4 generators x (20 x 2.5) of intake against 400 of reactor heat, at 0.75
    // energy, with 50 of waste against 100 of cooling.
    expectClose(totalPower, 150);
    // The bound that ignored the anomaly: 8 engine tiles + 1 cooler, capped at
    // 2 reactors feeding 6 generators, so 120 of heat and 90 of power.
    expectClose(boundFor(island, roster), 90);
    expect(
      totalPower,
      "the layout beats the bound computed on the plain roster",
    ).toBeGreaterThan(boundFor(island, roster));
    // Which is the whole point: the bound has to allow the isolated rating.
    expect(totalPower).toBeLessThanOrEqual(
      estimateTotalMaxPower([island], roster, singularity) + EPS,
    );
  });

  it("is never beaten by a random layout under a shared cooling pool", () => {
    /*
     * Pooling is the rule most likely to walk past a bound that assumed
     * adjacency — a cooler on the far side of the board now cools everything —
     * and the bound is safe because it never assumed any: it relaxes adjacency
     * away and asks only what the tile counts allow. The 0.88 on every cooler
     * only ever costs cooling, so the island scale stays 1 and the bound is the
     * plain one.
     *
     * The board is handed over whole here, as `wholeBoardIsland` does, because
     * that is what the pool is defined over.
     */
    const cryo = getAnomaly("cryo_nexus");
    const roster = basicRoster({ dpValue: 120, dpWasteRatio: 0.2 });
    const [island] = splitGridIntoIslands(
      makeGrid(["GGG", "GGG", "GGG"]),
      canCoolDirectProducer(roster),
      cryo,
    );
    const bound = estimateTotalMaxPower([island], roster, cryo);
    const ctx = buildIslandContext(
      island.grid,
      island.buildable,
      cryo,
      island.waterAdjacent,
    );

    expectClose(bound, boundFor(island, roster));

    const rng = new Rng(20260921);
    const options: (EffectiveBuilding | null)[] = [...roster, null];
    for (let attempt = 0; attempt < 300; attempt++) {
      const placement: Placement = Array.from({ length: ctx.n }, (_, t) => {
        const pick = rng.choice(options);
        return pick === null ? null : ctx.rate(t, pick);
      });

      const { totalPower } = simulateIsland(placement, ctx);

      expect(
        totalPower,
        `a layout beat the 'upper' bound on attempt ${attempt}`,
      ).toBeLessThanOrEqual(bound + EPS);
    }
  });

  it("rises with a terrain bonus only where a tile qualifies", () => {
    const tidal = getAnomaly("tidal_ascendancy");
    const roster = basicRoster();
    // Bare grass: every tile is on the board's edge, so the whole island is
    // shore and the bound is the plain one scaled by the multiplier.
    const shore = islandFor(["GGG", "GGG", "GGG"], roster);
    // Walled in and away from every edge: nothing qualifies, so the bound is
    // untouched and stays as tight as it was.
    const inland = islandFor(
      ["RRRRR", "RGGGR", "RGGGR", "RGGGR", "RRRRR"],
      roster,
    );

    expectClose(
      estimateTotalMaxPower([shore], roster, tidal),
      estimateTotalMaxPower([shore], roster) * 1.67,
    );
    expectClose(
      estimateTotalMaxPower([inland], roster, tidal),
      estimateTotalMaxPower([inland], roster),
    );
  });

  it("errs high for a terrain list the shore mask cannot decide", () => {
    /*
     * The shore mask is the only thing that knows off-board counts as water, so
     * the water-adjacency scan answers a `["water"]` anomaly exactly — and
     * nothing else. `terrainScales` qualifies a tile on *any* listed terrain, so
     * a hand-added anomaly naming rock as well would rate a landlocked island's
     * tiles at the multiplier while a bound that scanned only for water stayed
     * at 1, and be beatable again with nothing on screen saying so.
     *
     * `ANOMALIES` is hand-owned and documented as expected to grow, so the rule
     * is tested against a definition of the shape a new entry could take rather
     * than against a shipped one.
     */
    const mixed: TerrainAffinityAnomaly = {
      // Tidal's own identity, because `AnomalyId` is a closed union and this is
      // a shape a future entry could take rather than one that ships. Only the
      // terrain list is the point.
      ...(getAnomaly("tidal_ascendancy") as TerrainAffinityAnomaly),
      terrain: ["water", "rock"],
      multiplier: 2,
    };
    const roster = basicRoster();
    // Walled in by rock and well away from the board's edge: no water anywhere
    // near it, and every tile of it beside rock.
    const inland = islandFor(
      ["RRRRR", "RGGGR", "RGGGR", "RGGGR", "RRRRR"],
      roster,
    );

    expectClose(
      estimateTotalMaxPower([inland], roster, mixed),
      boundFor(inland, roster) * 2,
    );
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
