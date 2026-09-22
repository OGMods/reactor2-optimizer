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
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import {
  getEffectiveBuildings,
  scaleEffectiveBuilding,
} from "../src/data/effectiveBuildings";
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
  RoleIsolationAnomaly,
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
    const at = flagsOf(["RRRRRRR", "RG.GORG", "RGGGGRG", "RRRRRRR"]);

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
    const islands = splitGridIntoIslands(
      makeGrid(["GGGRRRR", "GGGRRRR", "GGGRRRR"]),
    );

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
    const [island] = splitGridIntoIslands(
      makeGrid(["RRRRR", "RGGGR", "RRRRR"]),
    );

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
     * The board is bare grass, so every tile but the centre is on the board's
     * edge and eight of the nine buildings are bonused — close to the worst
     * case for the bound, and the one where being loose is no excuse. The
     * mixed-board case, where the two-class bound has real work to do, is
     * `the two-class bound under a terrain bonus` below.
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
    const placement = placeOn(ctx, ["GRG", "RCR", "GRG"], {
      G: roster[1],
      R: roster[0],
      C: roster[2],
    });

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

  describe("the neighbourhood cap on a generator's intake", () => {
    /*
     * The other half of allowing the isolated rating, and the half that costs
     * something. Heat crosses a tile boundary and nothing else, so a
     * generator's intake is the output of the reactors *beside* it, and the
     * all-or-nothing cooling rule wants coolers beside it too — out of the same
     * eight tiles. That ceiling is the one piece of adjacency the bound does
     * not relax away, because it is the one that binds.
     *
     * It is homogeneous in the roster, so no rule that scales everything at
     * once can make it bite. A rule that scales a single role is exactly what
     * it takes, and `role_isolation` is that rule: rating a lone generator x2.5
     * while leaving the reactors that fill it alone let the LP spend fewer
     * tiles on generators than eight neighbours apiece can serve, and the
     * shipped maps' bound sat ~5% above anything the board allows.
     *
     * Ten tiles by four so the split settles: on a small island the integer
     * `nReact` lands short of eight reactors per generator by itself, and the
     * cap has nothing to say.
     */
    const singularity = getAnomaly(
      "singularity_isolation",
    ) as RoleIsolationAnomaly;
    const board = ["GGGGGGGGGG", "GGGGGGGGGG", "GGGGGGGGGG", "GGGGGGGGGG"];

    /** Eight neighbours of 100-heat reactors, less what the coolers among them cost. */
    const cap = 8 / (1 / 100 + 0.25 / 100);

    it("stops the bound rising with a generator eight reactors cannot fill", () => {
      /*
       * Two rosters four tiers apart in generator, both rated past the cap:
       * the bound has to answer the same number for each, because what a
       * generator tile is worth is settled by its neighbours and not by its
       * tier once the tier outruns them.
       */
      const small = basicRoster({ generatorValue: 400 });
      const large = basicRoster({ generatorValue: 4000 });
      const island = islandFor(board, small);

      expect(400 * singularity.isolated).toBeGreaterThan(cap);
      expectClose(
        estimateTotalMaxPower([island], small, singularity),
        estimateTotalMaxPower([island], large, singularity),
      );
    });

    it("is the same ceiling whatever rated a generator past it", () => {
      /*
       * A generator authored at 4000 and one rated there by the anomaly are
       * the same building to the cap, so the plain bound on the first is the
       * anomaly's bound on the second. Which is also why the anomaly buys so
       * much less than its x2.5 suggests: past eight reactors it buys nothing.
       */
      const island = islandFor(board, basicRoster());

      expectClose(
        estimateTotalMaxPower(
          [island],
          basicRoster({ generatorValue: 400 }),
          singularity,
        ),
        boundFor(island, basicRoster({ generatorValue: 4000 })),
      );
    });

    it("leaves a generator its neighbours can fill alone", () => {
      // Under the cap the tier still decides, so the bound still rises with it
      // — the ceiling is a ceiling, not a clamp on everything.
      const island = islandFor(board, basicRoster());

      expect(
        boundFor(island, basicRoster({ generatorValue: 100 })),
      ).toBeLessThan(boundFor(island, basicRoster({ generatorValue: 400 })));
    });

    it("is not beaten by a layout built to the cap's own shape", () => {
      /*
       * The arrangement the cap describes, built by hand: a generator alone in
       * the middle of its own 3x3 — so it rates `isolated` — with its eight
       * neighbours split between the reactors that fill it and the coolers
       * that keep it online. Six reactors is the most this roster can cool
       * (6 x 25 of waste against 2 x 100 of cooling), and 600 of intake is
       * what the cap allows for.
       */
      const roster = basicRoster({ generatorValue: 400 });
      const island = islandFor(["GGG", "GGG", "GGG"], roster);
      const ctx = buildIslandContext(
        island.grid,
        island.buildable,
        singularity,
        island.waterAdjacent,
      );
      const placement = placeOn(ctx, ["RRR", "RGR", "CCR"], {
        R: roster[0],
        G: roster[1],
        C: roster[2],
      });

      const { totalPower } = simulateIsland(placement, ctx);

      // 600 of intake at 0.75, against a 640 ceiling the tier alone would have
      // put at 1000.
      expectClose(totalPower, 450);
      expect(600).toBeLessThan(cap);
      expect(totalPower).toBeLessThanOrEqual(
        estimateTotalMaxPower([island], roster, singularity) + EPS,
      );
    });

    it.each([
      ["under role isolation", 400, singularity],
      // The cap applies under the base rules too, and a partial roster is
      // where it bites there: a strong generator behind a weak reactor is an
      // ordinary way to be part-way through the catalogue. Nothing rates this
      // one — 4000 of intake simply outruns what eight 100-heat reactors can
      // deliver, which is the same ceiling by a different route.
      ["on a plain roster the cap reaches", 4000, undefined],
    ])(
      "is never beaten by a random layout %s",
      (_name, generatorValue, rules) => {
        const roster = basicRoster({ generatorValue, dpValue: 120 });
        const island = islandFor(["GGGG", "GGGG", "GGGG", "GGGG"], roster);
        const bound = estimateTotalMaxPower([island], roster, rules);
        const ctx = buildIslandContext(
          island.grid,
          island.buildable,
          rules,
          island.waterAdjacent,
        );

        const rng = new Rng(20260922);
        const options: (EffectiveBuilding | null)[] = [...roster, null];
        for (let attempt = 0; attempt < 400; attempt++) {
          const placement: Placement = Array.from({ length: ctx.n }, () =>
            rng.choice(options),
          );

          const { totalPower } = simulateIsland(placement, ctx);

          expect(
            totalPower,
            `a layout beat the 'upper' bound on attempt ${attempt}`,
          ).toBeLessThanOrEqual(bound + EPS);
        }
      },
    );
  });

  describe("the room an island has to keep generators apart", () => {
    /*
     * The other half of the same argument, and the half a *generator-bound*
     * roster runs into. `roleRatedRoster` rates every generator at the bonus,
     * which a search free to spread them out can reach — until the roster is
     * one where the generators are the short side. Then the split wants a
     * third of the island to be generators, every one of them isolated, and
     * isolated generators are pairwise non-adjacent by definition: an
     * independent set in the 8-neighbour graph, which no board can make a
     * third of itself.
     *
     * `isolationRoom` reads the ceiling off a 2x2 block partition — four
     * mutually adjacent tiles, so one isolated generator between them, and no
     * other generator at all in that block. Gale Hills at generator7 tier 2
     * asked for 17.4 isolated generators where the island admits 15, and read
     * 83% layout efficiency for layouts within 3% of the best anything finds.
     */
    const singularity = getAnomaly(
      "singularity_isolation",
    ) as RoleIsolationAnomaly;

    /** The roster the bound used to run on: every generator at the bonus. */
    function allIsolated(roster: EffectiveBuilding[]): EffectiveBuilding[] {
      return roster.map((b) =>
        b.type === "generator"
          ? scaleEffectiveBuilding(b, singularity.isolated)
          : b,
      );
    }

    it("comes in under rating every generator at the bonus", () => {
      /*
       * Generators are the short side here — one isolated generator takes
       * half a reactor's heat — so the split wants more of them than a 4x4
       * has room to keep apart, and the bound has to say so.
       */
      const roster = basicRoster({ generatorValue: 40 });
      const island = islandFor(["GGGG", "GGGG", "GGGG", "GGGG"], roster);

      expect(estimateTotalMaxPower([island], roster, singularity)).toBeLessThan(
        boundFor(island, allIsolated(roster)),
      );
    });

    it("leaves a roster with room to spare exactly where it was", () => {
      // A generator worth four reactors needs few tiles, and few is well
      // inside what a board can keep apart — so the ceiling is not reached
      // and the figure is the one it always was, bit for bit.
      const roster = basicRoster({ generatorValue: 400 });
      const island = islandFor(["GGGG", "GGGG", "GGGG", "GGGG"], roster);

      expect(estimateTotalMaxPower([island], roster, singularity)).toBe(
        boundFor(island, allIsolated(roster)),
      );
    });

    it("counts the room a shape has, not the tiles it has", () => {
      /*
       * Two islands of eight tiles, and the bound reads them 50% apart. A 2x4
       * block is four 2x2 blocks of two tiles each, and every tile in it is
       * next to six others; a row of eight is four blocks too, but a
       * generator on it only ever has two neighbours, so the row can keep
       * three apart and still have tiles left for what feeds them. Tile count
       * is what the rest of the LP runs on and it cannot tell these apart.
       */
      const roster = basicRoster({ generatorValue: 40 });
      const block = islandFor(["GGGG", "GGGG"], roster);
      const row = islandFor(["GGGGGGGG"], roster);

      expect(block.tileCount).toBe(row.tileCount);
      expect(estimateTotalMaxPower([row], roster, singularity)).toBeGreaterThan(
        estimateTotalMaxPower([block], roster, singularity),
      );
    });

    it("is not beaten by any layout a small board can hold", () => {
      /*
       * Exhaustive rather than sampled, which is what this rule needs: a
       * random layout almost never isolates several generators at once, and
       * an isolated one is worth 3.1x a crowded one. Every arrangement of
       * four options over nine tiles is 262144 boards, and the bound has to
       * stand over all of them.
       */
      const roster = basicRoster({ generatorValue: 40 });
      const island = islandFor(["GGG", "GGG", "GGG"], roster);
      const bound = estimateTotalMaxPower([island], roster, singularity);
      const ctx = buildIslandContext(
        island.grid,
        island.buildable,
        singularity,
        island.waterAdjacent,
      );

      const options: (EffectiveBuilding | null)[] = [...roster, null];
      const total = options.length ** ctx.n;
      // The best layout is tracked and asserted once rather than per board:
      // 262144 assertions cost seconds where the simulations cost
      // milliseconds, and one is all the property needs.
      let reached = 0;
      let reachedBy = -1;
      for (let code = 0; code < total; code++) {
        let rest = code;
        const placement: Placement = new Array(ctx.n);
        for (let t = 0; t < ctx.n; t++) {
          placement[t] = options[rest % options.length];
          rest = (rest - (rest % options.length)) / options.length;
        }

        const { totalPower } = simulateIsland(placement, ctx);
        if (totalPower > reached) {
          reached = totalPower;
          reachedBy = code;
        }
      }

      expect(
        reached,
        `layout ${reachedBy} beat the 'upper' bound`,
      ).toBeLessThanOrEqual(bound + EPS);
      // And it is a bound worth having: something on this board reaches it.
      expect(reached / bound).toBeGreaterThan(0.9);
    });
  });

  it("is never beaten by a random layout under a shared cooling pool", () => {
    /*
     * Pooling is the rule most likely to walk past a bound that assumed
     * adjacency — a cooler on the far side of the board now cools everything —
     * and the bound is safe because it never assumed any: it relaxes adjacency
     * away and asks only what the tile counts allow. The 0.88 on every cooler
     * goes into the roster the bound is run on, so it is the plain bound over a
     * roster whose coolers are worth 0.88 of their tier — below the plain one,
     * never above it.
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

    expectClose(
      bound,
      boundFor(
        island,
        roster.map((b) =>
          b.type === "cooler" ? scaleEffectiveBuilding(b, 0.88) : b,
        ),
      ),
    );
    // Equal here rather than below: this roster is bound by its direct
    // producers, not by cooling, so the rated coolers move nothing.
    expect(bound).toBeLessThanOrEqual(boundFor(island, roster));

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
    // Two rows of bare grass: every tile is on the board's edge, so the whole
    // island is shore and the bound is the plain one scaled by the multiplier
    // — the two-class figure has one class, and it is spelled as the figure it
    // always was. (A bare 3x3 is *not* this: its centre tile has all eight
    // neighbours on the board, and that one inland tile is enough for the
    // two-class bound to come in under the scaled one.)
    const shore = islandFor(["GGGG", "GGGG"], roster);
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

  describe("the two-class bound under a terrain bonus", () => {
    /*
     * Rating a whole island at its best tile is a bound, and on the shipped
     * maps it is a quarter loose: the coast is 36-44% of the grass, and the
     * scaled figure rates every inland tile as if it stood on it. The
     * two-class bound splits the tile budget by class instead — a shore
     * building is worth its shore figures, an inland one its plain ones, and
     * both pay into the one heat and the one cooling total. These pin that it
     * is still a bound, that it is tighter, and that it collapses to the old
     * figure at either end.
     */
    const tidal = getAnomaly("tidal_ascendancy");

    /** The figure the two-class bound replaced: the plain LP at the multiplier. */
    const wholeIslandFigure = (
      island: IslandSubGrid,
      roster: EffectiveBuilding[],
    ): number => estimateTotalMaxPower([island], roster) * 1.67;

    it("is never beaten by a random layout on a mixed board", () => {
      /*
       * A 5x5 of bare grass: a ring of sixteen shore tiles round nine inland
       * ones, so a random layout straddles the coast every time. The roster
       * has a direct producer because the producer/cooler split is the one
       * part of the bound that is relaxed to fractions, and a board with no
       * producers would never exercise it.
       */
      const roster = basicRoster({ dpValue: 120, dpWasteRatio: 0.2 });
      const island = islandFor(
        ["GGGGG", "GGGGG", "GGGGG", "GGGGG", "GGGGG"],
        roster,
      );
      const bound = estimateTotalMaxPower([island], roster, tidal);
      expect(bound).toBeLessThan(wholeIslandFigure(island, roster));

      const ctx = buildIslandContext(
        island.grid,
        island.buildable,
        tidal,
        island.waterAdjacent,
      );
      let shore = 0;
      let inland = 0;
      for (let t = 0; t < ctx.n; t++) {
        if (ctx.rate(t, roster[0]) === roster[0]) inland++;
        else shore++;
      }
      expect([shore, inland], "the board is mixed").toEqual([16, 9]);

      const rng = new Rng(20260922);
      const options: (EffectiveBuilding | null)[] = [...roster, null];
      for (let attempt = 0; attempt < 500; attempt++) {
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

    it("is not beaten by a layout built to the bound's own shape", () => {
      /*
       * Random placement rarely comes near the bound, so this layout is built
       * by hand to lean the way the LP's optimum leans — every reactor and
       * generator on the coast, the coolers inland, no cluster straddling the
       * shoreline — which is the shape a real search converges on. A bound
       * this layout beat would be one the search beats too.
       *
       *     R G R G      the top and bottom rows and the two ends are shore;
       *     G C C G      the inner 2x2 is inland and takes the coolers. The
       *     R G R G      generators straddle nothing: each touches a shore
       *                  reactor and an inland cooler.
       */
      const roster = basicRoster({ reactorValue: 100, generatorValue: 50 });
      const island = islandFor(["GGGG", "GGGG", "GGGG"], roster);
      const bound = estimateTotalMaxPower([island], roster, tidal);
      expect(bound).toBeLessThan(wholeIslandFigure(island, roster));

      const ctx = buildIslandContext(
        island.grid,
        island.buildable,
        tidal,
        island.waterAdjacent,
      );
      const shape = placeOn(ctx, ["RGRG", "GCCG", "RGRG"], {
        R: roster[0],
        G: roster[1],
        C: roster[2],
      });
      const placement: Placement = shape.map((b, t) =>
        b === null ? null : ctx.rate(t, b),
      );

      const { totalPower } = simulateIsland(placement, ctx);
      expect(totalPower).toBeLessThanOrEqual(bound + EPS);
      expect(totalPower).toBeGreaterThan(0);
    });

    it("comes in under the whole-island figure once an island has inland tiles", () => {
      const roster = basicRoster();
      // The bare 3x3's centre is the only inland tile, and it is enough.
      const nearlyShore = islandFor(["GGG", "GGG", "GGG"], roster);
      const half = islandFor(
        ["RRRRRRR", "RGGGGGR", "RGGGGGR", "RGGGGGR", "R.....R"],
        roster,
      );

      for (const island of [nearlyShore, half]) {
        const bound = estimateTotalMaxPower([island], roster, tidal);
        expect(bound).toBeLessThan(wholeIslandFigure(island, roster));
        // And never below what the plain rules allow: a bonus cannot make a
        // layout worth less than it is without one.
        expect(bound).toBeGreaterThanOrEqual(
          estimateTotalMaxPower([island], roster),
        );
      }
    });

    it("never reads looser than the whole-island figure, however small the island", () => {
      /*
       * The producer/cooler split is fractional, and on an island of a few
       * tiles a fractional cooler is worth more than a whole one — enough to
       * put the two-class figure *above* the whole-island one it exists to
       * tighten. The smaller of the two is taken, so the bound is never worse
       * than it was.
       */
      const roster = basicRoster({ dpValue: 120, dpWasteRatio: 0.2 });
      // Three grass tiles walled in by rock, one of them beside water: two
      // inland, one shore.
      const island = islandFor(["RRRRR", "RGGG.", "RRRRR"], roster);

      expect(
        estimateTotalMaxPower([island], roster, tidal),
      ).toBeLessThanOrEqual(wholeIslandFigure(island, roster) + EPS);
    });

    it("tightens the shipped maps by about a quarter", async () => {
      /*
       * The measurement that justified the construction: at full unlocks the
       * two-class bound sits at 0.758-0.771 of the whole-island figure on
       * every shipped map, and Magma Rift's best 15s layout reads 93% of it
       * where it read 72% before. Pinned against the codes the app ships, so a
       * re-authored map that changed its coastline would move this on purpose.
       */
      const roster = getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked());
      for (const template of ISLAND_TEMPLATES) {
        const { grid } = await decodeBlueprint(template.code);
        const islands = splitGridIntoIslands(
          grid,
          canCoolDirectProducer(roster),
          tidal,
        );
        const bound = estimateTotalMaxPower(islands, roster, tidal);
        const whole = islands.reduce(
          (sum, island) => sum + wholeIslandFigure(island, roster),
          0,
        );
        const base = estimateTotalMaxPower(islands, roster);

        expect(bound, template.id).toBeLessThanOrEqual(0.8 * whole);
        expect(bound, template.id).toBeGreaterThanOrEqual(base);
      }
    });
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
