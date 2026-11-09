/**
 * Known-best-layout regression tests for a player holding every building of
 * the 1.1.16 roster at its top tier.
 *
 * `goldenLayoutsFullTier.test.ts` is the same ladder of islands on the 1.1.14
 * roster, where one cooler8 carried fourteen generator7s and the only question
 * was how many generators the reactors could fill. 1.1.16 turns that around
 * again: Heat Sink #8 cools 5.35e24, less than the 9.1e24 of waste a full
 * Generator #8 makes, so cooling binds once more — and a Pixel Core fills just
 * over half a Generator #8, so a generator is rarely the short side. Every
 * answer below is "turn as much reactor heat into power as the coolers can
 * carry", and on the boards where the coolers have room left over, a Kaiju Bio
 * Reactor — an eighth of a Pixel Core — is what fills it.
 *
 *     tiles  shape       layout                                power
 *     -----  ----------  ------------------------------------  -----------
 *       3    row         pixel + gen8 + cooler8                1.3787e25
 *       4    2x2         pixel + kaiju + gen8 + cooler8        1.5518e25
 *       5    3x3 - 4     2 pixel + gen8 + 2 cooler8            2.7200e25
 *       6    2x3         2 pixel + 2 gen8 + 2 cooler8          2.7575e25
 *       7    3x3 - 2     2 pixel + kaiju + 2 gen8 + 2 cooler8  2.9306e25
 *       8    3x3 - 1     3 pixel + 2 gen8 + 3 cooler8          4.1362e25
 *       9    3x3         3 pixel + kaiju + 2 gen8 + 3 cooler8  4.3093e25
 *
 * Every one was confirmed by exhaustive brute force through `simulateIsland`,
 * keeping only stable layouts, not by running the solver and writing down what
 * it said: over {empty, gen8, cooler8, pixel, kaiju, ecto} on every shape;
 * over that set plus generator7, cooler7 and precursor_pyramid on every shape;
 * over the entire 44-building roster on the 3- and 4-tile boards; and each
 * optimum against every 1- and 2-tile substitution from the entire roster.
 *
 * Like the 1.1.14 ladder, the search finds the exact optimum on every island,
 * so every case is asserted as an equality.
 *
 * THESE NUMBERS MUST NEVER GO DOWN. If "the roster these layouts assume" fails,
 * the game changed the catalogue: pin this file to the 1.1.16 roster the way
 * `goldenLayoutsFullTier.test.ts` is pinned to 1.1.14, and brute-force a new
 * ladder for the new one.
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
  G: "generator8",
  P: "pixel_core",
  K: "kaiju_bio_reactor",
};

const ROSTER = getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked());
const BY_ID = new Map(ROSTER.map((b) => [b.id, b]));

function building(id: string): EffectiveBuilding {
  return BY_ID.get(id)!;
}

const GEN = () => building("generator8");
const COOLER = () => building("cooler8");
const PIXEL = () => building("pixel_core");
const KAIJU = () => building("kaiju_bio_reactor");

/**
 * Power when every unit of these reactors' heat is absorbed by generators
 * that stay online — which is the shape of every optimum here. The fill
 * scales energy linearly, so the conversion ratio is the generator's own.
 */
function converted(pixels: number, kaijus = 0): number {
  return (
    (pixels * PIXEL().effectiveValue + kaijus * KAIJU().effectiveValue) *
    generatorEnergyRatio(GEN())
  );
}

/** Waste a generator makes absorbing `heat`. */
function wasteOf(heat: number): number {
  return heat * generatorWasteRatio(GEN());
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

    expect(bestOf("generator").id).toBe("generator8");
    expect(bestOf("cooler").id).toBe("cooler8");
    expect(bestOf("reactor").id).toBe("pixel_core");
  });

  it("is the 1.1.16 catalogue, so a new building fails here first", () => {
    // A building that is not the top of its role would otherwise show up as
    // a composition mismatch in "is found by the solver" — read as a solver
    // regression rather than a catalogue change.
    expect(ROSTER.length).toBe(44);
  });

  it("does the arithmetic that shapes every layout here", () => {
    // One cooler cannot carry one full generator: cooling binds again.
    expect(COOLER().effectiveValue).toBeLessThan(wasteOf(GEN().effectiveValue));

    // A Pixel Core fills just over half a generator, so two overflow one.
    expect(PIXEL().effectiveValue).toBeLessThan(GEN().effectiveValue);
    expect(2 * PIXEL().effectiveValue).toBeGreaterThan(GEN().effectiveValue);

    // The Kaiju is an eighth of a Pixel Core — small enough to fit in what a
    // cooler has left after the Pixel Cores' waste.
    expectClose(
      PIXEL().effectiveValue / KAIJU().effectiveValue,
      1.84e25 / 2.31e24,
    );
  });
});

describe("a three-tile row", () => {
  /*
   *     G G G      ->    C G P
   *
   * The generator in the middle takes all of the Pixel Core's 1.84e25, half
   * its intake, and the cooler covers the 4.6e24 of waste that makes.
   */
  golden(["CGP"], { pixel_core: 1, generator8: 1, cooler8: 1 }, () =>
    converted(1),
  );
});

describe("a four-tile square", () => {
  /*
   *     G G      ->    C G
   *     G G            K P
   *
   * A second Pixel Core would need a second cooler. A Kaiju's 2.31e24 is what
   * the one cooler can still carry: 2.07e25 of heat makes 5.19e24 of waste
   * against its 5.35e24.
   */
  golden(
    ["CG", "KP"],
    { pixel_core: 1, kaiju_bio_reactor: 1, generator8: 1, cooler8: 1 },
    () => converted(1, 1),
  );

  it("is cooling-bound: the cooler is nearly full", () => {
    const heat = PIXEL().effectiveValue + KAIJU().effectiveValue;
    expect(wasteOf(heat)).toBeLessThan(COOLER().effectiveValue);
    expect(wasteOf(heat + KAIJU().effectiveValue)).toBeGreaterThan(
      COOLER().effectiveValue,
    );
  });
});

describe("a five-tile island", () => {
  /*
   *     G G G      ->    C C P
   *     G G .            P G .
   *
   * Two Pixel Cores make 3.68e25, just over the generator's 3.63e25 intake,
   * so it runs at full rating — 2.72e25 — and its 9.1e24 of waste needs both
   * coolers.
   */
  golden(
    ["CCP", "PG."],
    { pixel_core: 2, generator8: 1, cooler8: 2 },
    () => GEN().energy,
  );
});

describe("a six-tile island", () => {
  /*
   *     G G G      ->    C C G
   *     P G P            P G P
   *
   * The five-tile story with the overflow caught: a second generator takes
   * the 5e23 the first could not, so all of both Pixel Cores' heat is turned
   * into power.
   */
  const LAYOUT = ["CCG", "PGP"];
  golden(LAYOUT, { pixel_core: 2, generator8: 2, cooler8: 2 }, () =>
    converted(2),
  );

  it("beats the five-tile island by only the Pixel Cores' overflow", () => {
    expectClose(
      scoreOf(LAYOUT) - scoreOf(["CCP", "PG."]),
      (2 * PIXEL().effectiveValue - GEN().effectiveValue) *
        generatorEnergyRatio(GEN()),
    );
  });
});

describe("a seven-tile island", () => {
  /*
   *     G G G      ->    C C G
   *     G G G            G K P
   *     G . .            P . .
   *
   * The two coolers have room for a Kaiju on top of two Pixel Cores — 9.8e24
   * of waste against 1.07e25 — but not for a third Pixel Core.
   */
  golden(
    ["CCG", "GKP", "P.."],
    { pixel_core: 2, kaiju_bio_reactor: 1, generator8: 2, cooler8: 2 },
    () => converted(2, 1),
  );
});

describe("an eight-tile island", () => {
  /*
   *     G G G      ->    C C C
   *     G G G            G G P
   *     G G .            P P .
   *
   * A third cooler pays for a third Pixel Core: 5.52e25 of heat across two
   * generators, 1.38e25 of waste against 1.61e25 of cooling.
   */
  const LAYOUT = ["CCC", "GGP", "PP."];
  golden(LAYOUT, { pixel_core: 3, generator8: 2, cooler8: 3 }, () =>
    converted(3),
  );

  it("prefers a third cooler and Pixel Core to a Kaiju", () => {
    expect(converted(3)).toBeGreaterThan(converted(2, 1));
  });
});

describe("a full three by three", () => {
  /*
   *     G G G      ->    C C C
   *     G G G            G G K
   *     G G G            P P P
   *
   * The eight-tile layout with its spare cooling spent on a Kaiju: 5.75e25 of
   * heat, 1.44e25 of waste against 1.61e25 of cooling. 4.31e25.
   */
  golden(
    ["CCC", "GGK", "PPP"],
    { pixel_core: 3, kaiju_bio_reactor: 1, generator8: 2, cooler8: 3 },
    () => converted(3, 1),
  );
});
