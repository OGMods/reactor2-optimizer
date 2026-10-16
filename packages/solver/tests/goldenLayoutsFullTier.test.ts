/**
 * Known-best-layout regression tests for a player holding EVERY building at its
 * top tier.
 *
 * `goldenLayouts.test.ts` pins the same ladder of islands against a mid-game
 * roster, where cooling is the binding constraint. At full tier it is not: one
 * cooler8 carries the waste of fourteen fully loaded generator7s, while a single
 * ecto_compressor overflows one generator7 twice over. So the question each
 * island asks turns around — not "how much heat can I afford to cool" but "how
 * many generators can my reactors fill" — and the answers below are a different
 * ladder, not the old one scaled up.
 *
 *     tiles  shape       layout                          power
 *     -----  ----------  ------------------------------  -----------
 *       3    row         ecto + gen7 + cooler8           1.0600e23
 *       4    2x2         ecto + 2 gen7 + cooler8         2.1200e23
 *       5    3x3 - 4     ecto + 3 gen7 + cooler8         2.1499e23
 *       6    2x3         2 ecto + 3 gen7 + cooler8       3.1800e23
 *       7    3x3 - 2     2 ecto + 4 gen7 + cooler8       4.2400e23
 *       8    3x3 - 1     2 ecto + 5 gen7 + cooler8       4.2997e23
 *       9    3x3         3 ecto + 5 gen7 + cooler8       5.3000e23
 *
 * Every one was confirmed by exhaustive brute force through `simulateIsland`,
 * not by running the solver and writing down what it said: over {empty, gen7,
 * cooler8, ecto, precursor_pyramid, doomStar} on every shape; over that set plus
 * generator6, cooler7 and flux_reactor up to eight tiles; over the entire
 * 42-building roster on the 3- and 4-tile boards; and each optimum against every
 * 1- and 2-tile substitution from the entire roster. No lower tier appears in any
 * of them.
 *
 * Unlike the mid-game ladder, the highest-scoring layout on every one of these
 * islands is also stable — with cooling this plentiful there is no overheating
 * trap to fall into — and the search finds the exact optimum every time, the
 * full 3x3 included, so every case is asserted as an equality.
 *
 * THESE NUMBERS MUST NEVER GO DOWN.
 */
import { describe, expect, it } from "vitest";
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { makeGrid } from "../src/grid";
import { buildIslandContext, type IslandContext } from "../src/solver/context";
import {
  canCoolDirectProducer,
  splitGridIntoIslands,
} from "../src/solver/island";
import {
  generatorEnergyRatio,
  generatorWasteRatio,
} from "../src/solver/physics";
import { internals, solveIsland } from "../src/solver/placementSearch";
import { simulateIsland } from "../src/solver/simulate";
import type {
  EffectiveBuilding,
  PlacedBuilding,
  Placement,
} from "../src/solver/types";
import { expectClose } from "./helpers";

const { offlineProducers } = internals;

/** See `goldenLayouts.test.ts`: retries absorb an unlucky anneal, not a regression. */
const ATTEMPTS = 3;
const TIME_BUDGET_S = 0.4;

/** ASCII shorthand used by every pinned layout below. */
const LEGEND: Record<string, string> = {
  C: "cooler8",
  G: "generator7",
  X: "ecto_compressor",
};

const ROSTER = getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked());
const BY_ID = new Map(ROSTER.map((b) => [b.id, b]));

function building(id: string): EffectiveBuilding {
  return BY_ID.get(id)!;
}

const GEN = () => building("generator7");
const COOLER = () => building("cooler8");
const ECTO = () => building("ecto_compressor");

/** Power when `generators` generator7s share `reactors` ectos' heat. */
function sharedOutput(reactors: number, generators: number): number {
  const absorbed = Math.min(
    reactors * ECTO().effectiveValue,
    generators * GEN().effectiveValue,
  );
  return absorbed * generatorEnergyRatio(GEN());
}

function layoutFrom(rows: string[]): {
  ctx: IslandContext;
  placement: Placement;
} {
  const ctx = buildIslandContext(
    makeGrid(
      rows.map((row) =>
        [...row].map((char) => (char === "." ? "." : "G")).join(""),
      ),
    ),
  );
  const placement: Placement = new Array(ctx.n).fill(null);
  for (let i = 0; i < ctx.n; i++) {
    const char = rows[ctx.ys[i]][ctx.xs[i]];
    if (char !== ".") placement[i] = building(LEGEND[char]);
  }
  return { ctx, placement };
}

function compositionOf(
  items: { buildingId: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.buildingId] = (counts[item.buildingId] ?? 0) + 1;
  }
  return counts;
}

function scoreOf(rows: string[]): number {
  const { ctx, placement } = layoutFrom(rows);
  return simulateIsland(placement, ctx).totalPower;
}

/**
 * Both halves of a golden check: the pinned layout scores the optimum with
 * nothing overheating, and the search reproduces it from a blank island.
 */
function golden(
  layout: string[],
  composition: Record<string, number>,
  optimum: () => number,
): void {
  it("scores the known best layout", () => {
    const { ctx, placement } = layoutFrom(layout);
    const { totalPower, placements } = simulateIsland(placement, ctx);

    expect(
      compositionOf(
        placement
          .filter((b): b is EffectiveBuilding => b !== null)
          .map((b) => ({ buildingId: b.id })),
      ),
    ).toEqual(composition);
    expectClose(totalPower, optimum());
    expect(
      offlineProducers(placement, placements),
      "the known-best layout must not contain an overheating building",
    ).toEqual([]);
  });

  it("is found by the solver", async () => {
    const islands = splitGridIntoIslands(
      makeGrid(layout.map((row) => row.replace(/[^.]/g, "G"))),
      canCoolDirectProducer(ROSTER),
    );
    expect(islands.length, "test grid should be a single island").toBe(1);

    let best: PlacedBuilding[] = [];
    let bestPower = -1;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { placements, powerOutput } = await solveIsland(
        islands[0],
        ROSTER,
        TIME_BUDGET_S,
      );
      if (powerOutput > bestPower) {
        best = placements;
        bestPower = powerOutput;
      }
      if (bestPower >= optimum() * (1 - 1e-9)) break;
    }

    expect(compositionOf(best)).toEqual(composition);
    expectClose(bestPower, optimum());
  }, 20_000);
}

describe("the roster these layouts assume", () => {
  /*
   * If one of THESE fails, the building catalogue changed — the solver is not
   * at fault, and the expected layouts below need brute-forcing again.
   */

  it("tops out at the buildings the layouts name", () => {
    const bestOf = (type: string) =>
      ROSTER.filter((b) => b.type === type).reduce((best, b) =>
        b.effectiveValue > best.effectiveValue ? b : best,
      );

    expect(bestOf("generator").id).toBe("generator7");
    expect(bestOf("cooler").id).toBe("cooler8");
    expect(bestOf("reactor").id).toBe("ecto_compressor");
  });

  it("does the arithmetic that shapes every layout here", () => {
    const fullWaste = GEN().effectiveValue * generatorWasteRatio(GEN());

    // One cooler never runs out: it carries more generators than nine tiles hold.
    expect(COOLER().effectiveValue / fullWaste).toBeGreaterThan(9);

    // One ecto overflows one generator, and fills two with a sliver to spare —
    // which is the whole of what a third generator beside it can collect.
    expect(ECTO().effectiveValue).toBeGreaterThan(2 * GEN().effectiveValue);
    expect(ECTO().effectiveValue).toBeLessThan(3 * GEN().effectiveValue);
  });
});

describe("a three-tile row", () => {
  /*
   *     G G G      ->    X G C
   *
   * The generator has to sit in the middle to touch both. It takes 1.42e23 of
   * the ecto's 2.88e23 and the rest goes nowhere; the cooler is idling at 7%.
   * Power is the generator's full rated 1.06e23.
   */
  golden(["XGC"], { ecto_compressor: 1, generator7: 1, cooler8: 1 }, () =>
    sharedOutput(1, 1),
  );
});

describe("a four-tile square", () => {
  /*
   *     G G      ->    G C
   *     G G            X G
   *
   * The fourth tile goes to a second generator, not a second reactor: the
   * first ecto was already spilling more than a whole generator's worth.
   */
  golden(["GC", "XG"], { ecto_compressor: 1, generator7: 2, cooler8: 1 }, () =>
    sharedOutput(1, 2),
  );

  it("doubles the three-tile row exactly", () => {
    expectClose(scoreOf(["GC", "XG"]), 2 * scoreOf(["XGC"]));
  });
});

describe("a five-tile island", () => {
  /*
   *     G G G      ->    G C G
   *     G G .            G X .
   *
   * A second ecto would need a third generator to be worth anything, and five
   * tiles cannot hold both. So the fifth tile is a third generator collecting
   * the 4e21 that two generators leave on the table: the ecto's whole output,
   * converted, is 2.1499e23 against 2.12e23.
   */
  const LAYOUT = ["GCG", "GX."];
  golden(LAYOUT, { ecto_compressor: 1, generator7: 3, cooler8: 1 }, () =>
    sharedOutput(1, 3),
  );

  it("beats the four-tile square by only the ecto's overflow", () => {
    expect(scoreOf(LAYOUT)).toBeGreaterThan(scoreOf(["GC", "XG"]));
    expectClose(
      scoreOf(LAYOUT) - scoreOf(["GC", "XG"]),
      (ECTO().effectiveValue - 2 * GEN().effectiveValue) *
        generatorEnergyRatio(GEN()),
    );
  });
});

describe("a six-tile island", () => {
  /*
   *     G G G      ->    G C G
   *     G G G            X X G
   *
   * Two ectos make 5.76e23 of heat, more than three generators accept
   * (4.26e23), so all three run at full rating: 3.18e23.
   */
  golden(
    ["GCG", "XXG"],
    { ecto_compressor: 2, generator7: 3, cooler8: 1 },
    () => sharedOutput(2, 3),
  );
});

describe("a seven-tile island", () => {
  /*
   *     G G G      ->    G X G
   *     G G G            X C G
   *     G . .            G . .
   *
   * Two ectos (5.76e23) fill four generators (5.68e23) almost exactly. Every
   * generator touches an ecto and the cooler.
   */
  golden(
    ["GXG", "XCG", "G.."],
    { ecto_compressor: 2, generator7: 4, cooler8: 1 },
    () => sharedOutput(2, 4),
  );
});

describe("an eight-tile island", () => {
  /*
   *     G G G      ->    G X G
   *     G G G            X C G
   *     G G .            G G .
   *
   * The five-tile story again: a third ecto would need generators there is no
   * room for, so the eighth tile is a fifth generator catching the two ectos'
   * last 8e21 — 4.2997e23, beating 3 ectos + 4 generators' 4.24e23.
   */
  const LAYOUT = ["GXG", "XCG", "GG."];
  golden(LAYOUT, { ecto_compressor: 2, generator7: 5, cooler8: 1 }, () =>
    sharedOutput(2, 5),
  );

  it("prefers a fifth generator to a third reactor", () => {
    expect(sharedOutput(2, 5)).toBeGreaterThan(sharedOutput(3, 4));
  });
});

describe("a full three by three", () => {
  /*
   *     G G G      ->    G X G
   *     G G G            G C G
   *     G G G            X X G
   *
   * Three ectos (8.64e23) fill five generators (7.10e23) with heat to spare;
   * the centre cooler touches all five and carries their 1.8e23 of waste at a
   * third of its capacity. 5.30e23.
   */
  golden(
    ["GXG", "GCG", "XXG"],
    { ecto_compressor: 3, generator7: 5, cooler8: 1 },
    () => sharedOutput(3, 5),
  );
});
