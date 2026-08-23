/**
 * Right-sizing the finished layout.
 *
 * The pass runs once the search has stopped moving and re-tiers what is on the
 * board: each cooler, reactor and generator becomes the smallest tier in the
 * roster that still carries the load that layout gives it. Power is blind to
 * the difference between a cooler running flat out and one running at 2%, so
 * nothing in the search prefers the tier the tile actually needs — and the
 * player pays for the difference.
 *
 * What it may change is narrow, and that is what these pin: the tier on a tile,
 * never which tiles are occupied, and never the power.
 *
 * Peer: `DowngradeOversizedTests` in `py_solver/tests/test_search.py`.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_ENERGY_RATIO, GENERATOR_WASTE_RATIO } from "./constants";
import { buildIslandContext } from "./context";
import { canCoolDirectProducer, splitGridIntoIslands } from "./island";
import { downgradeOversized, solveIsland } from "./placementSearch";
import { simulateIsland, type SimPlacedBuilding } from "./simulate";
import type { EffectiveBuilding, Placement, Tile } from "./types";

// --- Building factories, matching `py_solver/tests/helpers.py` -------------

function reactor(value: number, id = "reactor"): EffectiveBuilding {
  return { id, type: "reactor", effectiveValue: value, energy: 0, waste: 0 };
}

function generator(value: number, id = "generator"): EffectiveBuilding {
  return {
    id,
    type: "generator",
    effectiveValue: value,
    energy: value * GENERATOR_ENERGY_RATIO,
    waste: value * GENERATOR_WASTE_RATIO,
  };
}

function cooler(value: number, id = "cooler"): EffectiveBuilding {
  return { id, type: "cooler", effectiveValue: value, energy: 0, waste: 0 };
}

function directProducer(
  value: number,
  wasteRatio: number,
  id = "dp",
): EffectiveBuilding {
  return {
    id,
    type: "direct_producer",
    effectiveValue: value,
    energy: value * (1 - wasteRatio),
    waste: value * wasteRatio,
  };
}

// --- Grid and layout builders ---------------------------------------------

/** One row of grass, `width` tiles wide. Tile index == x, which is spatial order. */
function grassRow(width: number): Tile[][] {
  return [
    Array.from({ length: width }, (_, x): Tile => ({ x, y: 0, type: "grass" })),
  ];
}

function byTile(rows: SimPlacedBuilding[]): Map<number, SimPlacedBuilding> {
  return new Map(rows.map((r) => [r.idx, r]));
}

/** Simulates a layout and hands the pass exactly what `pruneDeadWeight` would. */
function sizeUp(placement: Placement, roster: EffectiveBuilding[]) {
  const ctx = buildIslandContext(grassRow(placement.length));
  const sim = simulateIsland(placement, ctx);
  const sized = downgradeOversized(sim.placements, sim.totalPower, roster, ctx);
  return { before: sim, after: sized, ids: byTile(sized.rows) };
}

describe("downgradeOversized", () => {
  it("swaps an oversized cooler for the smallest tier that covers it", () => {
    // The scenario the pass exists for: a cooler running at 2.5%.
    const roster = [
      reactor(100),
      generator(100),
      cooler(10, "cooler_s"),
      cooler(25, "cooler_m"),
      cooler(1000, "cooler_l"),
    ];
    const { before, after, ids } = sizeUp(
      [roster[0], roster[1], roster[4]],
      roster,
    );

    expect(after.power).toBeCloseTo(before.totalPower, 9);
    // The generator wastes 25, so the 25 tier is the smallest that covers it.
    expect(ids.get(2)!.buildingId).toBe("cooler_m");
  });

  it("downgrades a reactor to the heat it actually sends", () => {
    // The generator caps at 100, so 900 of the reactor's 1000 heat is never
    // absorbed and the tier producing it is paid for and idle.
    const roster = [
      reactor(50, "reactor_s"),
      reactor(100, "reactor_m"),
      reactor(1000, "reactor_l"),
      generator(100),
      cooler(25),
    ];
    const { before, after, ids } = sizeUp(
      [roster[2], roster[3], roster[4]],
      roster,
    );

    expect(after.power).toBeCloseTo(before.totalPower, 9);
    // The 50 tier would starve the generator, so 100 is the floor here.
    expect(ids.get(0)!.buildingId).toBe("reactor_m");
  });

  it("downgrades a generator to its settled intake", () => {
    // A generator filled to 10% makes the same power on a tier ten times smaller.
    const roster = [
      reactor(100),
      generator(100, "generator_s"),
      generator(1000, "generator_l"),
      cooler(25),
    ];
    const { before, after, ids } = sizeUp(
      [roster[0], roster[2], roster[3]],
      roster,
    );

    expect(after.power).toBeCloseTo(before.totalPower, 9);
    expect(ids.get(1)!.buildingId).toBe("generator_s");
  });

  it("leaves a direct producer alone", () => {
    // A direct producer runs flat out by definition, so it has no slack to give
    // back — a smaller tier is simply less power.
    const roster = [
      directProducer(100, 0.2, "dp_s"),
      directProducer(1000, 0.2, "dp_l"),
      cooler(200),
    ];
    const { before, after, ids } = sizeUp([roster[1], roster[2]], roster);

    expect(after.power).toBeCloseTo(before.totalPower, 9);
    expect(ids.get(0)!.buildingId).toBe("dp_l");
  });

  it("keeps a tier that is exactly used", () => {
    const roster = [
      reactor(100),
      generator(100),
      cooler(10, "cooler_s"),
      cooler(25),
    ];
    const { before, after, ids } = sizeUp(
      [roster[0], roster[1], roster[3]],
      roster,
    );

    expect(after.power).toBeCloseTo(before.totalPower, 9);
    expect(ids.get(2)!.buildingId).toBe("cooler");
  });

  it("sweeps again after a downgrade frees another one", () => {
    // One sweep is not enough. Shrinking the generator cuts the waste its cooler
    // has to absorb, which frees a cooler tier the sweep has already walked past
    // — the cooler sits on tile 0 and is visited first.
    //
    // The two generator tiers deliberately do NOT share a waste ratio, which is
    // what makes the second sweep observable: the big one wastes 40 at the fill
    // this layout gives it, the small one 25 at the same intake.
    const genL: EffectiveBuilding = {
      id: "generator_l",
      type: "generator",
      effectiveValue: 1000,
      energy: 750,
      waste: 400,
    };
    const genS: EffectiveBuilding = {
      id: "generator_s",
      type: "generator",
      effectiveValue: 100,
      energy: 75,
      waste: 25,
    };
    const roster = [
      reactor(100),
      genS,
      genL,
      cooler(25, "cooler_s"),
      cooler(40, "cooler_m"),
      cooler(1000, "cooler_l"),
    ];
    const { before, after, ids } = sizeUp([roster[5], genL, roster[0]], roster);

    expect(before.totalPower).toBeCloseTo(75.0, 9); // 10% fill of a 750-energy tier
    expect(after.power).toBeCloseTo(before.totalPower, 9);
    expect(ids.get(1)!.buildingId).toBe("generator_s");
    // The first sweep can only reach cooler_m (40); cooler_s needs a second.
    expect(ids.get(0)!.buildingId).toBe("cooler_s");
  });

  it("never returns an offline producer, and never loses power", () => {
    // Covering a tile's current load is what makes a candidate plausible, not
    // what makes it safe: a smaller supplier splits its output differently.
    // Every swap is re-simulated, so the stability rule survives the pass.
    const roster = [
      reactor(100),
      reactor(400, "reactor_l"),
      generator(100),
      generator(400, "generator_l"),
      cooler(25),
      cooler(100, "cooler_l"),
      cooler(4000, "cooler_xl"),
    ];
    const grid: Tile[][] = ["RGCR", "GCRG", "CGRC"].map((row, y) =>
      [...row].map((_, x): Tile => ({ x, y, type: "grass" })),
    );
    const legend: Record<string, EffectiveBuilding> = {
      R: roster[1],
      G: roster[3],
      C: roster[6],
    };
    const ctx = buildIslandContext(grid);
    const placement: Placement = new Array<EffectiveBuilding | null>(
      ctx.n,
    ).fill(null);
    for (let t = 0; t < ctx.n; t++) {
      placement[t] = legend[["RGCR", "GCRG", "CGRC"][ctx.ys[t]][ctx.xs[t]]];
    }

    const before = simulateIsland(placement, ctx);
    const after = downgradeOversized(
      before.placements,
      before.totalPower,
      roster,
      ctx,
    );

    expect(after.power).toBeGreaterThanOrEqual(
      before.totalPower - Math.abs(before.totalPower) * 1e-9,
    );
    for (const row of after.rows) {
      const building = roster.find((b) => b.id === row.buildingId)!;
      if (
        building.type === "generator" ||
        building.type === "direct_producer"
      ) {
        expect(row.powerGenerated).toBeGreaterThan(0);
      }
    }
  });

  it("occupies exactly the same tiles", () => {
    // Right-sizing re-tiers; removing dead weight is `pruneDeadWeight`'s job.
    const roster = [
      reactor(100),
      generator(100),
      cooler(25),
      cooler(1000, "cooler_l"),
    ];
    const { before, after } = sizeUp([roster[0], roster[1], roster[3]], roster);

    expect(after.rows.map((r) => r.idx).sort()).toEqual(
      before.placements.map((r) => r.idx).sort(),
    );
  });

  it("leaves an empty layout alone", () => {
    const ctx = buildIslandContext(grassRow(3));
    const result = downgradeOversized([], 0.0, [cooler(25)], ctx);

    expect(result.rows).toEqual([]);
    expect(result.power).toBe(0.0);
  });
});

describe("solveIsland right-sizes what it returns", () => {
  const roster = [
    directProducer(100, 0.2, "dp"),
    cooler(20, "cooler_s"),
    cooler(10000, "cooler_l"),
  ];

  it("does not hand back the biggest cooler in the roster", async () => {
    const grid: Tile[][] = [
      [
        { x: 0, y: 0, type: "grass" },
        { x: 1, y: 0, type: "grass" },
      ],
    ];
    const island = splitGridIntoIslands(grid, canCoolDirectProducer(roster))[0];

    const solution = await solveIsland(island, roster, 0.2);

    expect(solution.powerOutput).toBeCloseTo(80.0, 9);
    // A 10000 cooler for 20 of waste is capacity the player never uses.
    expect(solution.placements.map((p) => p.buildingId).sort()).toEqual([
      "cooler_s",
      "dp",
    ]);
  });

  it("right-sizes the tied layouts too, not just the primary", async () => {
    // The shortlist exists so the player can compare boards that tie on power.
    // Two entries agreeing on power and disagreeing on cost would make that
    // comparison meaningless, so alternates go through the same pass.
    //
    // A 4x4 is the smallest board that reliably produces a shortlist at all:
    // an alternate has to be MIN_ALTERNATE_DISTANCE tiles from every layout
    // already kept, and on a board of four tiles there is nowhere that far to
    // go. Here a cooler covers its eight neighbours with room to spare, so
    // twelve producers stay online however the four coolers are spread, and
    // the arrangements that manage it are genuinely different boards.
    const tiedRoster = [
      directProducer(100, 0.2, "dp"),
      cooler(180, "cooler_m"),
      cooler(10000, "cooler_l"),
    ];
    const grid: Tile[][] = Array.from({ length: 4 }, (_, y) =>
      Array.from({ length: 4 }, (_, x): Tile => ({ x, y, type: "grass" })),
    );
    const island = splitGridIntoIslands(
      grid,
      canCoolDirectProducer(tiedRoster),
    )[0];

    const solution = await solveIsland(island, tiedRoster, 0.3);
    const layouts = [solution, ...(solution.alternates ?? [])];

    expect(solution.powerOutput).toBeCloseTo(960.0, 9); // twelve producers online
    expect(layouts.length).toBeGreaterThan(1); // a shortlist to check, not one board
    for (const layout of layouts) {
      expect(layout.placements.map((p) => p.buildingId)).not.toContain(
        "cooler_l",
      );
    }
  });
});
