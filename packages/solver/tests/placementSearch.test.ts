/**
 * The per-island placement search.
 *
 * The search is stochastic, so these assert invariants and quality FLOORS
 * rather than exact layouts. The one deterministic path — seed construction,
 * then a step-capped walk — is pinned separately, because it is what every
 * annealing run starts from and a regression there quietly costs power on every
 * solve.
 *
 * Ported from the reference solver's `tests/test_search.py`, minus its
 * `DowngradeOversizedTests`, which are in `placementSearch.downgrade.test.ts`.
 * Two shapes differ:
 *
 * - The reference reached into `_construct_multi_start_seed` and `_hill_climb`
 *   directly. Here both are behind `replayIslandDeterministic`, which is the
 *   same pair with the deadlines pushed out of reach — and is the function the
 *   fixtures already depend on, so testing through it tests what is actually
 *   replayed. `maxSteps = 0` is seed construction alone.
 * - There is no `_buildable_tiles`: the island's buildable tiles are indexed
 *   once into an `IslandContext`, and ascending tile index *is* the game's
 *   spatial order, which is what that function existed to guarantee.
 */
import { describe, expect, it } from "vitest";
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { decodeBlueprint } from "../src/encoding/blueprint";
import { ISLAND_TEMPLATES } from "../src/data/maps";
import { makeGrid } from "../src/grid";
import {
  GENERATOR_ENERGY_RATIO,
  GENERATOR_WASTE_RATIO,
} from "../src/solver/constants";
import { buildIslandContext } from "../src/solver/context";
import {
  canCoolDirectProducer,
  estimateTotalMaxPower,
  splitGridIntoIslands,
} from "../src/solver/island";
import {
  downgradeOversized,
  internals,
  replayIslandDeterministic,
  solveIsland,
} from "../src/solver/placementSearch";
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
  grassGrid,
  placeOn,
  placementsByPos,
  reactor,
} from "./helpers";

const { pruneDeadWeight, targetCompositions, tileLoad, downgradeTiers } =
  internals;

function islandFrom(rows: string[], roster = basicRoster()): IslandSubGrid {
  const islands = splitGridIntoIslands(
    makeGrid(rows),
    canCoolDirectProducer(roster),
  );
  if (islands.length === 0) throw new Error("test grid produced no islands");
  return islands[0];
}

/** The four building pools in the order `solveIsland` builds them. */
function sortedPools(roster: EffectiveBuilding[]) {
  const by =
    (pick: (b: EffectiveBuilding) => number) =>
    (a: EffectiveBuilding, b: EffectiveBuilding) =>
      pick(b) - pick(a);
  return {
    reactors: roster
      .filter((b) => b.type === "reactor")
      .sort(by((b) => b.effectiveValue)),
    generators: roster
      .filter((b) => b.type === "generator")
      .sort(by((b) => b.effectiveValue)),
    coolers: roster
      .filter((b) => b.type === "cooler")
      .sort(by((b) => b.effectiveValue)),
    directProducers: roster
      .filter((b) => b.type === "direct_producer")
      .sort(by((b) => b.energy)),
  };
}

/** A layout key that ignores object identity: which building id on which tile. */
function layoutKey(placements: { x: number; y: number; buildingId: string }[]) {
  return placements
    .map((p) => `${p.x},${p.y}:${p.buildingId}`)
    .sort()
    .join("|");
}

describe("the solveIsland contract", () => {
  // Whatever the search decides, the result must be structurally valid.

  it("returns nothing for an island with no buildable tiles", async () => {
    // Which tiles are this island's is the mask, not the terrain — an island
    // window carries the board's real terrain and a neighbour's grass with it.
    const island = islandFrom(["GGG"]);
    island.buildable.fill(0);

    const { placements, powerOutput } = await solveIsland(
      island,
      basicRoster(),
      0.1,
    );

    expect(placements).toEqual([]);
    expectClose(powerOutput, 0);
  });

  it("returns nothing without coolers", async () => {
    const { placements, powerOutput } = await solveIsland(
      islandFrom(["GGGG"]),
      [reactor(100), generator(100)],
      0.2,
    );

    expect(placements).toEqual([]);
    expectClose(powerOutput, 0);
  });

  it("returns nothing without any producer", async () => {
    const { placements, powerOutput } = await solveIsland(
      islandFrom(["GGGG"]),
      [cooler(100), reactor(100)],
      0.2,
    );

    expect(placements).toEqual([]);
    expectClose(powerOutput, 0);
  });

  it("places at most one building per tile, inside the island", async () => {
    const island = islandFrom(["GGGG", "GGGG"]);

    const { placements } = await solveIsland(island, basicRoster(), 0.5);

    const positions = placements.map((p) => `${p.x},${p.y}`);
    expect(new Set(positions).size, "duplicate tile used").toBe(
      positions.length,
    );

    const buildable = new Set(
      island.grid.flatMap((row) =>
        row.filter((t) => t.type === "grass").map((t) => `${t.x},${t.y}`),
      ),
    );
    for (const pos of positions) {
      expect(buildable.has(pos), "building placed off the island's grass").toBe(
        true,
      );
    }
  });

  it("only uses buildings from the roster", async () => {
    const roster = basicRoster({ dpValue: 10, dpWasteRatio: 0.2 });

    const { placements } = await solveIsland(
      islandFrom(["GGGG", "GGGG"], roster),
      roster,
      0.5,
    );

    const available = new Set(roster.map((b) => b.id));
    for (const p of placements) expect(available.has(p.buildingId)).toBe(true);
  });

  it("never places a producer that generates no power", async () => {
    /*
     * The core stability requirement: the answer is a board where everything
     * placed actually runs. A generator or direct producer that overheats — or
     * that never receives heat — must not appear in the result at all.
     */
    const roster = basicRoster({ dpValue: 100, dpWasteRatio: 0.2 });
    const island = islandFrom(["GGGGG", "GGGGG", "GGGGG"], roster);
    const byId = new Map(roster.map((b) => [b.id, b]));

    for (let attempt = 0; attempt < 5; attempt++) {
      const { placements } = await solveIsland(island, roster, 0.3);

      for (const p of placements) {
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
    }
  }, 20_000);

  it("reports the power a fresh simulation of its layout finds", async () => {
    /*
     * The search caches simulation results as it goes; this checks the number it
     * finally reports still matches what the layout actually scores.
     */
    const island = islandFrom(["GGGGG", "GGGGG", "GGGGG"]);
    const roster = basicRoster();
    const byId = new Map(roster.map((b) => [b.id, b]));

    const { placements, powerOutput } = await solveIsland(island, roster, 1.0);

    const ctx = buildIslandContext(island.grid);
    const layout: Placement = new Array(ctx.n).fill(null);
    for (const p of placements) {
      for (let i = 0; i < ctx.n; i++) {
        if (ctx.xs[i] === p.x && ctx.ys[i] === p.y) {
          layout[i] = byId.get(p.buildingId)!;
          break;
        }
      }
    }

    expectClose(simulateIsland(layout, ctx).totalPower, powerOutput);
  });

  it("finds the obvious three-tile solution", async () => {
    const { placements, powerOutput } = await solveIsland(
      islandFrom(["GGG"]),
      [reactor(100), generator(100), cooler(25)],
      0.5,
    );

    expectClose(powerOutput, 75); // one reactor + generator + cooler
    expect(placements.length).toBe(3);
  });

  it("uses a direct producer when only two tiles are available", async () => {
    const roster = basicRoster({ dpValue: 100, dpWasteRatio: 0.2 });

    const { placements, powerOutput } = await solveIsland(
      islandFrom(["GG"], roster),
      roster,
      0.5,
    );

    expectClose(powerOutput, 80); // direct producer + cooler is the only viable pair
    expect(new Set(placements.map((p) => p.buildingId))).toEqual(
      new Set(["dp", "cooler"]),
    );
  });

  it("respects its time budget", async () => {
    const island = islandFrom(Array(6).fill("GGGGGG"));

    const started = Date.now();
    await solveIsland(island, basicRoster(), 0.5);

    expect(
      Date.now() - started,
      "solveIsland overran its 0.5s budget badly",
    ).toBeLessThan(3000);
  });

  it("still returns a valid result on a zero budget", async () => {
    const { placements, powerOutput } = await solveIsland(
      islandFrom(["GGGG", "GGGG"]),
      basicRoster(),
      0.0,
    );

    expect(powerOutput).toBeGreaterThanOrEqual(0);
    const positions = placements.map((p) => `${p.x},${p.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe("seed construction", () => {
  // Deterministic, and it must stay that way.

  it("seeds the same island and roster identically every time", async () => {
    const island = islandFrom(["GGGGG", "GGGGG", "GGGGG"]);
    const roster = basicRoster();

    const first = await replayIslandDeterministic(island, roster, 1, 0);
    const second = await replayIslandDeterministic(island, roster, 1, 0);

    expect(
      layoutKey(second.placements),
      "the same island and roster must always seed identically",
    ).toBe(layoutKey(first.placements));
    expectClose(second.powerOutput, first.powerOutput);
  });

  it("indexes buildable tiles in the game's spatial order", () => {
    // Ascending X then descending Y — which is ascending tile index.
    const ctx = buildIslandContext(makeGrid(["GGG", "GGG"]));

    const keys = Array.from({ length: ctx.n }, (_, i) => [
      ctx.xs[i],
      ctx.ys[i],
    ]);
    const sorted = [...keys].sort((a, b) =>
      a[0] !== b[0] ? a[0] - b[0] : b[1] - a[1],
    );

    expect(keys).toEqual(sorted);
  });

  it("reaches a high fraction of the theoretical bound on a real map", async () => {
    /*
     * A quality floor on the real game roster and a real map. The seed normally
     * lands within a few percent of the (loose) upper bound; this fails loudly
     * if a change to the construction heuristic guts it.
     */
    const roster = getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked());
    const grid = (await decodeBlueprint(ISLAND_TEMPLATES[0].code)).grid;
    const island = splitGridIntoIslands(grid, canCoolDirectProducer(roster))[0];

    const { powerOutput } = await replayIslandDeterministic(
      island,
      roster,
      1,
      0,
    );
    const bound = estimateTotalMaxPower([island], roster);

    expect(
      powerOutput,
      `seed power ${powerOutput.toExponential(3)} is far below the ` +
        `${bound.toExponential(3)} bound`,
    ).toBeGreaterThan(0.75 * bound);
  }, 20_000);
});

describe("pruning dead weight", () => {
  /** Prunes an ASCII layout on an all-grass board of its own size. */
  function prune(rows: string[], legend: Record<string, EffectiveBuilding>) {
    const ctx = buildIslandContext(grassGrid(rows[0].length, rows.length));
    const placement = placeOn(ctx, rows, legend);
    const before = simulateIsland(placement, ctx);
    const after = pruneDeadWeight(placement, ctx);
    return {
      ctx,
      placement,
      before,
      after,
      byPos: placementsByPos(after.rows),
    };
  }

  it("never reduces the power of an already-stable layout", () => {
    /*
     * Pruning may only lose power by removing an overheating building. Once a
     * layout is already stable, the remaining sweep over support buildings is
     * strictly guarded and can never cost anything.
     */
    const { before, after, placement } = prune(["RGC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    expect(
      internals.offlineProducers(placement, before.placements),
      "precondition: this layout is already stable",
    ).toEqual([]);
    expect(after.power).toBeGreaterThanOrEqual(before.totalPower - 1e-9);
  });

  it("removes a generator that produces nothing", () => {
    // A generator with no reactor and no cooling is pure dead weight.
    const { after, byPos } = prune(["RGC.G"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(after.power, 75);
    expect(byPos.has("4,0"), "offline generator was kept").toBe(false);
  });

  it("removes redundant support buildings", () => {
    // Two coolers where one suffices: the spare should be pruned away.
    const { after } = prune(["RGCC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(after.power, 75);
    expect(
      after.rows.length,
      "the second cooler contributes nothing and should go",
    ).toBe(3);
  });

  it("removes an offline producer even when it costs power", () => {
    /*
     * The goal is a fully stable layout: every placed producer must run. An
     * overheating building is never acceptable, even when keeping it would score
     * higher.
     *
     * Here the reactor (200) splits 100/100 between two generators, and only the
     * big one has cooling. Keeping the offline generator scores 75, because it
     * parks half the reactor's heat where nothing has to cool it. Dropping it
     * hands all 200 heat to the big generator, whose waste (50) then exceeds its
     * cooler (25) — so it goes offline too and gets removed in turn. The stable
     * answer for this layout is nothing at all.
     */
    const { before, after, byPos } = prune(["ARB", "C.."], {
      A: generator(200, "gen_big"),
      R: reactor(200),
      B: generator(100, "gen_small"),
      C: cooler(25),
    });

    expectClose(
      before.totalPower,
      75, // precondition: the unstable layout scores 75 before pruning
    );
    expect(
      byPos.has("2,0"),
      "the overheating generator must not survive pruning",
    ).toBe(false);
    expectClose(after.power, 0); // removal cascades: the big generator overheats too
    /*
     * The cascade is the point: removing one offline producer can push another
     * one offline, so a single unchecked pass is not enough.
     */
    expect(
      after.rows
        .filter((p) => p.buildingId.startsWith("gen"))
        .map((p) => p.buildingId),
    ).toEqual([]);
  });

  it("never leaves a producer generating no power", () => {
    const { after } = prune(["RGCR", "GCRG", "CGRC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    for (const p of after.rows) {
      if (p.buildingId === "generator" || p.buildingId === "dp") {
        expect(
          p.powerGenerated,
          `idle producer left at (${p.x},${p.y})`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keeps a cooler that is actually needed", () => {
    const { after } = prune(["RGC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(after.power, 75);
    expect(after.rows.length).toBe(3);
  });

  it("handles an empty layout", () => {
    const { after } = prune(["..."], {});

    expect(after.rows).toEqual([]);
    expectClose(after.power, 0);
  });
});

describe("target compositions", () => {
  /*
   * `targetCompositions` answers "what should be built" exactly, by counting
   * rather than searching. It ignores placement, so it is an upper bound on any
   * arrangement — but a tight and very cheap one.
   */

  function countById(composition: EffectiveBuilding[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const b of composition) counts[b.id] = (counts[b.id] ?? 0) + 1;
    return counts;
  }

  it("derives the hand-calculable three-tile answer", () => {
    const { reactors, generators, coolers } = sortedPools([
      reactor(100),
      generator(100),
      cooler(25),
    ]);

    const targets = targetCompositions(3, reactors, generators, coolers, null);

    expect(targets.length).toBeGreaterThan(0);
    expect(countById(targets[0].composition)).toEqual({
      reactor: 1,
      generator: 1,
      cooler: 1,
    });
    expectClose(targets[0].power, 75); // 100 heat converted at 0.75
  });

  it("spends extra tiles on whichever resource is binding", () => {
    /*
     * With cooling scarce relative to reactor output, tiles have to go to
     * coolers — extra reactors beyond what the coolers can carry add nothing.
     */
    const { reactors, generators, coolers } = sortedPools([
      reactor(100),
      generator(100),
      cooler(5),
    ]);

    const [best] = targetCompositions(10, reactors, generators, coolers, null);
    const counts = countById(best.composition);

    expect(best.composition.length, "every tile is allocated").toBe(10);
    expect(counts["cooler"], "cooling is the scarce resource").toBeGreaterThan(
      counts["reactor"] ?? 0,
    );
    // Power is bounded by what the coolers can carry, whatever the reactors make.
    expect(best.power).toBeLessThanOrEqual(
      ((counts["cooler"] * 5) / GENERATOR_WASTE_RATIO) *
        GENERATOR_ENERGY_RATIO +
        1e-9,
    );
  });

  it("allows surplus reactor heat when capacity is the limit", () => {
    /*
     * Regression: overshooting the heat budget is free, because the surplus is
     * simply never absorbed and power stays capped.
     *
     * These are real values from a 7-tile island. Stepping down tiers to stay
     * under the budget gives 4 doomStar + 1 flux = 7.92e21 of heat and 5.94e21
     * of power; packing all five tiles with doomStar makes 9.20e21, of which
     * only the generator's 8.85e21 is absorbed — for 6.64e21 of power. The
     * ceiling has to cover the layout the solver can actually build, or it is
     * not a ceiling.
     */
    const { reactors, generators, coolers } = sortedPools([
      reactor(1.84e21, "doomStar_reactor"),
      reactor(5.63e20, "flux_reactor"),
      generator(8.85e21, "generator7"),
      cooler(2.35e21, "cooler7"),
    ]);

    const [best] = targetCompositions(7, reactors, generators, coolers, null);

    expect(
      best.power,
      "ceiling must not fall below an achievable 5-reactor layout",
    ).toBeGreaterThanOrEqual(6.637e21 - 1e15);
  });

  it("returns only compositions that can cool themselves", () => {
    const { reactors, generators, coolers } = sortedPools([
      reactor(100),
      reactor(12, "small_reactor"),
      generator(100),
      cooler(25),
    ]);

    for (const tileCount of [3, 5, 8, 13, 21]) {
      for (const { power, composition } of targetCompositions(
        tileCount,
        reactors,
        generators,
        coolers,
        null,
      )) {
        expect(composition.length).toBe(tileCount);

        const sumOf = (type: string, pick: (b: EffectiveBuilding) => number) =>
          composition
            .filter((b) => b.type === type)
            .reduce((s, b) => s + pick(b), 0);
        const heat = sumOf("reactor", (b) => b.effectiveValue);
        const genCap = sumOf("generator", (b) => b.effectiveValue);
        const cooling = sumOf("cooler", (b) => b.effectiveValue);

        /*
         * Surplus reactor heat is allowed: it is simply never absorbed. What
         * must hold is that the cooling covers the waste of the heat that IS
         * absorbed.
         */
        const absorbed = Math.min(
          heat,
          genCap,
          cooling / GENERATOR_WASTE_RATIO,
        );
        expect(
          cooling,
          `${JSON.stringify(countById(composition))} cannot cool the heat it absorbs`,
        ).toBeGreaterThanOrEqual(absorbed * GENERATOR_WASTE_RATIO - 1e-9);
        expectClose(power, absorbed * GENERATOR_ENERGY_RATIO);
      }
    }
  });

  it("orders its results best first", () => {
    const { reactors, generators, coolers } = sortedPools([
      reactor(100),
      generator(100),
      cooler(25),
    ]);

    const ceilings = targetCompositions(
      12,
      reactors,
      generators,
      coolers,
      null,
    ).map((c) => c.power);

    expect(ceilings).toEqual([...ceilings].sort((a, b) => b - a));
  });

  it("returns nothing for an island too small to work", () => {
    const { reactors, generators, coolers } = sortedPools([
      reactor(100),
      generator(100),
      cooler(25),
    ]);

    expect(targetCompositions(2, reactors, generators, coolers, null)).toEqual(
      [],
    );
    expect(targetCompositions(3, [], generators, coolers, null)).toEqual([]);
  });

  it("is never beaten by a real layout", async () => {
    /*
     * The composition ceiling ignores adjacency, so a real solve must always
     * land at or below it. If this ever fails, the bound is wrong.
     */
    const island = islandFrom(["GGGGG", "GGGGG", "GGGGG"]);
    const roster = basicRoster();
    const { reactors, generators, coolers } = sortedPools(roster);
    const tiles = buildIslandContext(island.grid).n;

    const ceiling = targetCompositions(
      tiles,
      reactors,
      generators,
      coolers,
      null,
    )[0].power;
    const { powerOutput } = await solveIsland(island, roster, 0.5);

    expect(
      powerOutput,
      `solve returned ${powerOutput.toExponential(4)}, above the ` +
        `${ceiling.toExponential(4)} composition ceiling`,
    ).toBeLessThanOrEqual(ceiling * (1 + 1e-9));
  });
});

describe("the annealing walk replays", () => {
  /*
   * With a fixed rng and a step budget, the walk must be fully deterministic.
   * This is the property the golden fixtures stand on; wall-clock budgets cannot
   * give it, because the deadline cuts each run at a different step.
   */

  it("replays identically for the same seed and step budget", async () => {
    const island = islandFrom(["GGGG", "GGGG", "GGGG"]);
    const roster = basicRoster();

    const first = await replayIslandDeterministic(island, roster, 1234, 20_000);
    const second = await replayIslandDeterministic(
      island,
      roster,
      1234,
      20_000,
    );

    expect(
      layoutKey(second.placements),
      "two walks with the same seed and step budget diverged",
    ).toBe(layoutKey(first.placements));
    expect(second.powerOutput).toBe(first.powerOutput);
  }, 30_000);

  it("is allowed to diverge for different seeds", async () => {
    /*
     * Not a strict requirement — two seeds MAY collide on the same layout — but
     * on a barely-constrained island the walk should visit seed-dependent
     * states, so identical results for many distinct seeds would mean the rng is
     * being ignored.
     */
    const island = islandFrom(["GGGG", "GGGG", "GGGG"]);
    const roster = basicRoster();

    const results = new Set<string>();
    for (let seed = 0; seed < 6; seed++) {
      const { placements } = await replayIslandDeterministic(
        island,
        roster,
        seed,
        300,
      );
      results.add(layoutKey(placements));
    }

    expect(
      results.size,
      "six different seeds all produced the same layout; the walk does not " +
        "appear to consume the rng it was given",
    ).toBeGreaterThan(1);
  }, 30_000);
});

describe("the downgrade tier ladders", () => {
  it("ascend, and exclude direct producers", () => {
    const tiers = downgradeTiers([
      cooler(1000, "cooler_l"),
      cooler(25),
      reactor(100),
      generator(100),
      directProducer(100, 0.2),
    ]);

    expect(tiers.get("cooler")!.map((b) => b.id)).toEqual([
      "cooler",
      "cooler_l",
    ]);
    expect(tiers.has("direct_producer")).toBe(false);
    expect([...internals.DOWNGRADE_ROLES].sort()).toEqual([
      "cooler",
      "generator",
      "reactor",
    ]);
  });

  it("leaves every returned tier able to carry its own load", () => {
    // The property the pass is selling: no tier is left doing more than it can.
    const roster = [
      reactor(100),
      reactor(400, "reactor_l"),
      generator(100),
      generator(400, "generator_l"),
      cooler(25),
      cooler(4000, "cooler_xl"),
    ];
    const ctx = buildIslandContext(grassGrid(4, 3));
    const placement = placeOn(ctx, ["RGCR", "GCRG", "CGRC"], {
      R: roster[1],
      G: roster[3],
      C: roster[5],
    });
    const before = simulateIsland(placement, ctx);

    const after = downgradeOversized(
      before.placements,
      before.totalPower,
      roster,
      ctx,
    );

    const byId = new Map(roster.map((b) => [b.id, b]));
    for (const row of after.rows) {
      const building = byId.get(row.buildingId)!;
      if (!internals.DOWNGRADE_ROLES.has(building.type)) continue;
      expect(
        building.effectiveValue,
        `${building.id} at (${row.x},${row.y}) cannot carry its own load`,
      ).toBeGreaterThanOrEqual(tileLoad(building, row) - 1e-9);
    }
  });
});
