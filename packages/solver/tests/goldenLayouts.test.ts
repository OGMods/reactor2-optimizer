/**
 * Known-best-layout regression tests.
 *
 * Unlike the rest of the suite, these pin the solver to a specific, verified
 * OPTIMAL answer on small islands, so that any change in solver behaviour shows
 * up as a failure here rather than as a quietly worse number on a big map.
 *
 * A ladder of island sizes, each with its verified optimum:
 *
 *     tiles  shape       layout                                       power
 *     -----  ----------  -------------------------------------------  --------
 *       3    row         eye + gen6 + cooler6                         6.60e18
 *       4    2x2         2 eye + gen6 + cooler6                       1.32e19
 *       5    3x3 - 4     neuro + gen6 + 3 cooler6                     5.19e19
 *       6    2x3         neuro + 2 gen6 + 3 cooler6                   5.28e19
 *       7    3x3 - 2     neuro + psionic + 2 gen6 + 3 cooler6         5.36e19
 *       8    3x3 - 1     neuro + eye + 2 gen6 + 4 cooler6             5.94e19
 *       9    3x3         neuro + 2 eye + 2 gen6 + 4 cooler6           6.60e19
 *
 * Every one was confirmed by exhaustive brute force, not by running the solver
 * and writing down what it said. The candidate set is deliberately lean — the
 * top generator, the top cooler, the top three reactors, and "leave empty" —
 * because generators and coolers jump 400x-4100x per tier, so no lower tier of
 * either can ever appear in an optimal layout (see `docs/game-logic.md`,
 * "Building Tiers Matter A Lot"). Reactors are kept three tiers deep because
 * their 8x steps ARE small enough to matter: the 7-tile optimum spends its last
 * tile on a psionic_tower purely to soak up leftover cooling capacity. The 3-
 * and 4-tile boards were small enough to brute force against the entire
 * 34-building roster, and agree.
 *
 * A layout only counts as a valid answer if it is STABLE: every generator and
 * direct producer placed must actually run. Layouts that score higher by parking
 * heat in a permanently overheating building are rejected — see the 3x3 cases.
 *
 * Each size is checked twice: once against the SIMULATOR, pinning the exact
 * layout and score deterministically, and once against the SEARCH, which must
 * reproduce that answer. The one exception is the full 3x3, where the search
 * reliably finds the right composition but only lands the best arrangement of
 * it about half the time, so power there is asserted as a floor. Tightening
 * that into an equality is a fair goal for a search improvement.
 *
 * Ported from the reference solver's `tests/test_golden_layouts.py`. THESE
 * NUMBERS MUST NEVER GO DOWN.
 */
import { describe, expect, it } from "vitest";
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { makeGrid } from "../src/grid";
import {
  GENERATOR_ENERGY_RATIO,
  GENERATOR_WASTE_RATIO,
} from "../src/solver/constants";
import { buildIslandContext, type IslandContext } from "../src/solver/context";
import {
  canCoolDirectProducer,
  splitGridIntoIslands,
} from "../src/solver/island";
import { Pacer } from "../src/solver/pacer";
import { internals, solveIsland } from "../src/solver/placementSearch";
import { Rng } from "../src/solver/rng";
import { simulateIsland } from "../src/solver/simulate";
import type {
  EffectiveBuilding,
  IslandSubGrid,
  PlacedBuilding,
  Placement,
} from "../src/solver/types";
import { expectClose, placementsByPos } from "./helpers";

const { hillClimb, offlineProducers, pruneDeadWeight } = internals;

/** The scenario: everything unlocked EXCEPT these four. */
const EXCLUDED_BUILDINGS = new Set([
  "generator7",
  "cooler7",
  "flux_reactor",
  "doomStar_reactor",
]);

/**
 * Attempts allowed before a golden case is called a failure.
 *
 * The search is stochastic; a single unlucky anneal should not fail the build,
 * but a solver that has genuinely regressed will miss on every attempt. In
 * practice the first attempt succeeds, so the extra attempts only cost time
 * when something is actually wrong.
 */
const ATTEMPTS = 3;
const TIME_BUDGET_S = 0.4;

/** ASCII shorthand used by every pinned layout below. */
const LEGEND: Record<string, string> = {
  C: "cooler6",
  G: "generator6",
  N: "neuro_grid_reactor",
  E: "sauron_eye",
  P: "psionic_tower",
};

function restrictedRoster(): EffectiveBuilding[] {
  const unlocks = Object.fromEntries(
    Object.entries(allUpgradesUnlocked()).filter(
      ([id]) => !EXCLUDED_BUILDINGS.has(id),
    ),
  );
  return getEffectiveBuildings(BUILDINGS, unlocks);
}

const ROSTER = restrictedRoster();
const BY_ID = new Map(ROSTER.map((b) => [b.id, b]));

/** The value of a building in the restricted roster, by id. */
function valueOf(id: string): number {
  return BY_ID.get(id)!.effectiveValue;
}

/**
 * Power for a layout whose generators absorb their reactors' full output.
 *
 * Every known-best layout in this file has that shape: the generators between
 * them can accept everything the reactors make, so the score is simply the
 * reactors' combined output times the 0.75 conversion.
 */
function convertedReactorOutput(...reactorIds: string[]): number {
  return (
    reactorIds.reduce((sum, id) => sum + valueOf(id), 0) *
    GENERATOR_ENERGY_RATIO
  );
}

function islandFrom(rows: string[]): IslandSubGrid {
  const islands = splitGridIntoIslands(
    makeGrid(rows),
    canCoolDirectProducer(ROSTER),
  );
  expect(islands.length, "test grid should be a single island").toBe(1);
  return islands[0];
}

/** A placement from an ASCII picture, on an island context of the same shape. */
function layoutFrom(
  rows: string[],
  legend: Record<string, string> = LEGEND,
): { ctx: IslandContext; placement: Placement } {
  const gridRows = rows.map((row) =>
    [...row].map((char) => (char === "." ? "." : "G")).join(""),
  );
  const ctx = buildIslandContext(makeGrid(gridRows));
  const placement: Placement = new Array(ctx.n).fill(null);

  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      if (char === ".") return;
      for (let i = 0; i < ctx.n; i++) {
        if (ctx.xs[i] === x && ctx.ys[i] === y) {
          placement[i] = BY_ID.get(legend[char])!;
          return;
        }
      }
      throw new Error(`no tile at ${x},${y}`);
    });
  });

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

function placementComposition(placement: Placement): Record<string, number> {
  return compositionOf(
    placement
      .filter((b): b is EffectiveBuilding => b !== null)
      .map((b) => ({
        buildingId: b.id,
      })),
  );
}

/**
 * Runs the search until it reaches the known optimum, up to `ATTEMPTS` times,
 * so an unlucky anneal does not fail the build. Returns the best result seen; a
 * genuinely regressed solver misses on every attempt.
 */
async function solveToOptimum(
  island: IslandSubGrid,
  optimum: number,
): Promise<{ placements: PlacedBuilding[]; power: number }> {
  let best: PlacedBuilding[] = [];
  let bestPower = -1;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { placements, powerOutput } = await solveIsland(
      island,
      ROSTER,
      TIME_BUDGET_S,
    );
    if (powerOutput > bestPower) {
      best = placements;
      bestPower = powerOutput;
    }
    if (bestPower >= optimum - Math.abs(optimum) * 1e-9) break;
  }

  return { placements: best, power: bestPower };
}

/**
 * Deterministic half of a golden check: the named layout has the expected
 * composition, scores the expected power, and is stable.
 */
function assertLayoutScores(
  rows: string[],
  composition: Record<string, number>,
  expectedPower: number,
): void {
  const { ctx, placement } = layoutFrom(rows);
  const { totalPower, placements } = simulateIsland(placement, ctx);

  expect(
    placementComposition(placement),
    "the pinned layout does not have the expected composition",
  ).toEqual(composition);
  expectClose(totalPower, expectedPower);
  expect(
    offlineProducers(placement, placements),
    "the known-best layout must not contain an overheating building",
  ).toEqual([]);
}

/** Search half of a golden check: the solver reproduces that answer. */
async function assertSolverFinds(
  islandRows: string[],
  composition: Record<string, number>,
  expectedPower: number,
): Promise<PlacedBuilding[]> {
  const { placements, power } = await solveToOptimum(
    islandFrom(islandRows),
    expectedPower,
  );

  expect(compositionOf(placements)).toEqual(composition);
  expectClose(power, expectedPower);
  return placements;
}

describe("the roster these layouts assume", () => {
  /*
   * Guards the assumptions the golden layouts rest on. If one of THESE fails,
   * the building catalogue changed — the solver is not at fault, and the
   * expected layouts below need recomputing.
   */

  it("excludes exactly the four buildings the scenario names", () => {
    /*
     * Written so it holds whether or not the full roster currently unlocks these
     * four — the scenario is "everything the player has, minus these", not "the
     * default roster is exactly four bigger".
     */
    const available = new Set(ROSTER.map((b) => b.id));
    const full = new Set(
      getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked()).map((b) => b.id),
    );

    for (const id of EXCLUDED_BUILDINGS) expect(available.has(id)).toBe(false);
    expect([...available].sort()).toEqual(
      [...full].filter((id) => !EXCLUDED_BUILDINGS.has(id)).sort(),
    );
  });

  it("tops out at the buildings the layouts name", () => {
    const bestOf = (type: string) =>
      ROSTER.filter((b) => b.type === type).reduce((best, b) =>
        b.effectiveValue > best.effectiveValue ? b : best,
      );

    expect(bestOf("generator").id).toBe("generator6");
    expect(bestOf("cooler").id).toBe("cooler6");
    expect(bestOf("reactor").id).toBe("neuro_grid_reactor");
  });

  it("does the arithmetic that makes these layouts optimal", () => {
    const reactor = valueOf("neuro_grid_reactor"); // 7.04e19
    const gen = valueOf("generator6"); // 6.92e19
    const cool = valueOf("cooler6"); // 6.03e18

    // One generator cannot absorb the whole reactor — hence two generators beat
    // one as soon as a sixth tile is available.
    expect(reactor, "a single generator would cap the reactor").toBeGreaterThan(
      gen,
    );
    expect(2 * gen, "two generators can take all of it").toBeGreaterThan(
      reactor,
    );

    // Three coolers cover the waste in both layouts; two never do.
    expect(3 * cool).toBeGreaterThanOrEqual(reactor * GENERATOR_WASTE_RATIO);
    expect(2 * cool).toBeLessThan(gen * GENERATOR_WASTE_RATIO);
  });
});

describe("a three-tile row", () => {
  /*
   *     G G G      ->    C G E
   *
   * Known best: sauron_eye + generator6 + cooler6 = 6.60e18.
   *
   * Only one cooler fits, and that is what picks the reactor. The best reactor,
   * neuro_grid_reactor, would push 6.92e19 into the generator and make 1.73e19
   * of waste — nearly three coolers' worth — so it can never run here. The
   * 8x-weaker sauron_eye makes only 2.20e18 of waste, which one cooler6
   * (6.03e18) covers easily. A weaker reactor wins outright because cooling,
   * not heat, is the binding constraint.
   */
  const ROWS = ["GGG"];
  const LAYOUT = ["CGE"];
  const COMPOSITION = { sauron_eye: 1, generator6: 1, cooler6: 1 };
  const optimum = () => convertedReactorOutput("sauron_eye");

  it("scores the known best layout at 6.60e18", () => {
    assertLayoutScores(LAYOUT, COMPOSITION, optimum());
  });

  it("is found by the solver", async () => {
    await assertSolverFinds(ROWS, COMPOSITION, optimum());
  }, 20_000);

  it("cannot cool the top reactor here", () => {
    // The reason a weaker reactor wins: one cooler cannot cover the big one.
    const cooling = valueOf("cooler6");
    const neuroWaste = valueOf("neuro_grid_reactor") * GENERATOR_WASTE_RATIO;
    const eyeWaste = valueOf("sauron_eye") * GENERATOR_WASTE_RATIO;

    expect(
      neuroWaste,
      "the top reactor needs more than one cooler",
    ).toBeGreaterThan(cooling);
    expect(eyeWaste, "the weaker reactor fits in one").toBeLessThanOrEqual(
      cooling,
    );

    const { ctx, placement } = layoutFrom(["CGN"]);
    const { totalPower, placements } = simulateIsland(placement, ctx);

    expectClose(totalPower, 0); // swapping in the top reactor kills the layout
    expect(offlineProducers(placement, placements).length).toBe(1);
  });
});

describe("a four-tile square", () => {
  /*
   *     G G      ->    C E
   *     G G            G E
   *
   * Known best: 2x sauron_eye + generator6 + cooler6 = 1.32e19.
   *
   * The fourth tile goes to a second eye rather than a second cooler: two eyes
   * make 1.76e19 of heat and only 4.40e18 of waste, still inside one cooler6's
   * 6.03e18. The generator has capacity to spare (6.92e19), so the extra reactor
   * is pure profit — it exactly doubles the three-tile answer.
   */
  const ROWS = ["GG", "GG"];
  const LAYOUT = ["CE", "GE"];
  const COMPOSITION = { sauron_eye: 2, generator6: 1, cooler6: 1 };
  const optimum = () => convertedReactorOutput("sauron_eye", "sauron_eye");

  it("scores the known best layout at 1.32e19", () => {
    assertLayoutScores(LAYOUT, COMPOSITION, optimum());
  });

  it("is found by the solver", async () => {
    await assertSolverFinds(ROWS, COMPOSITION, optimum());
  }, 20_000);

  it("spends its spare tile on a second reactor, not a second cooler", () => {
    // One cooler still covers the waste, so the spare tile should make heat.
    const twoEyes = (() => {
      const { ctx, placement } = layoutFrom(LAYOUT);
      return simulateIsland(placement, ctx).totalPower;
    })();
    const eyeAndCooler = (() => {
      const { ctx, placement } = layoutFrom(["CE", "GC"]);
      return simulateIsland(placement, ctx).totalPower;
    })();

    expect(twoEyes).toBeGreaterThan(eyeAndCooler);
    expectClose(
      twoEyes,
      2 * eyeAndCooler, // the second eye should exactly double the output
    );
  });
});

describe("a five-tile island", () => {
  /*
   *     G G G
   *     G G .
   *
   * Known best: 1x generator6 + 1x neuro_grid_reactor + 3x cooler6.
   *
   * With only five tiles there is no room for a second generator alongside the
   * three coolers the waste requires, so the single generator caps the reactor
   * at its own 6.92e19 capacity: power = 6.92e19 * 0.75 = 5.19e19. The 1.73e19
   * of waste again needs all three coolers.
   */
  const ROWS = ["GGG", "GG."];
  const EXPECTED = { generator6: 1, neuro_grid_reactor: 1, cooler6: 3 };
  // The lone generator's capacity is the binding constraint.
  const optimum = () => valueOf("generator6") * GENERATOR_ENERGY_RATIO;

  it("finds the known best layout", async () => {
    const { placements, power } = await solveToOptimum(
      islandFrom(ROWS),
      optimum(),
    );

    expect(compositionOf(placements)).toEqual(EXPECTED);
    expect(placements.length, "every tile should be used").toBe(5);
    expect(
      power,
      "brute force proves 5.19e19 is achievable on this island",
    ).toBeGreaterThanOrEqual(optimum() - Math.abs(optimum()) * 1e-9);
    expectClose(power, optimum());
  }, 20_000);
});

describe("a six-tile island", () => {
  /*
   *     G G G
   *     G G G
   *
   * Known best: 2x generator6 + 1x neuro_grid_reactor + 3x cooler6.
   *
   * The reactor produces 7.04e19, more than one generator6 can accept
   * (6.92e19), so two generators split it and NOTHING is wasted:
   * power = 7.04e19 * 0.75 = 5.28e19. The resulting 1.76e19 of waste is just
   * under the three coolers' 1.809e19.
   *
   * Note this layout is NOT found by greedy seed construction, which builds a
   * single-generator hub worth 5.19e19 and leaves a tile idle — reaching 5.28e19
   * depends on the annealing stage. That makes this the most sensitive case in
   * the suite to search-quality changes.
   */
  const ROWS = ["GGG", "GGG"];
  const EXPECTED = { generator6: 2, neuro_grid_reactor: 1, cooler6: 3 };
  // Both generators together absorb the reactor's full output.
  const optimum = () => valueOf("neuro_grid_reactor") * GENERATOR_ENERGY_RATIO;

  it("finds the known best layout", async () => {
    const { placements, power } = await solveToOptimum(
      islandFrom(ROWS),
      optimum(),
    );

    expect(compositionOf(placements)).toEqual(EXPECTED);
    expect(placements.length, "every tile should be used").toBe(6);
    expect(
      power,
      "brute force proves 5.28e19 is achievable on this island",
    ).toBeGreaterThanOrEqual(optimum() - Math.abs(optimum()) * 1e-9);
    expectClose(power, optimum());
  }, 20_000);

  it("beats the five-tile island by the heat that generator was wasting", async () => {
    /*
     * Ties the two golden cases together: the 6-tile island must beat the 5-tile
     * one, and by exactly the reactor output the lone generator was forced to
     * waste.
     */
    const fiveOptimum = valueOf("generator6") * GENERATOR_ENERGY_RATIO;

    const five = await solveToOptimum(islandFrom(["GGG", "GG."]), fiveOptimum);
    const six = await solveToOptimum(islandFrom(ROWS), optimum());

    expect(six.power).toBeGreaterThan(five.power);
    expectClose(
      six.power - five.power,
      (valueOf("neuro_grid_reactor") - valueOf("generator6")) *
        GENERATOR_ENERGY_RATIO,
    );
  }, 30_000);
});

describe("a seven-tile island", () => {
  /*
   *     G G G      ->    C N P
   *     G G G            G G C
   *     G . .            C . .
   *
   * Known best: psionic_tower + neuro_grid_reactor + 2x generator6 +
   * 3x cooler6 = 5.3625e19.
   *
   * This is the spec's "topping up a Generator's spare heat-input capacity"
   * case, and the only golden layout that uses a third-tier reactor. The two
   * generators can accept 1.384e20 between them but neuro only supplies 7.04e19,
   * so heat — not generator capacity — is the limit. Three coolers absorb
   * 1.809e19 of waste, and neuro alone only makes 1.76e19, leaving 5.0e17 of
   * cooling headroom. psionic_tower (1.10e18, another 8x step down) fits into
   * that gap almost exactly: total heat 7.15e19, total waste 1.7875e19, just
   * inside the coolers' 1.809e19.
   */
  const ROWS = ["GGG", "GGG", "G.."];
  const LAYOUT = ["CNP", "GGC", "C.."];
  const COMPOSITION = {
    neuro_grid_reactor: 1,
    psionic_tower: 1,
    generator6: 2,
    cooler6: 3,
  };
  const optimum = () =>
    convertedReactorOutput("neuro_grid_reactor", "psionic_tower");

  it("scores the known best layout at 5.36e19", () => {
    assertLayoutScores(LAYOUT, COMPOSITION, optimum());
  });

  it("is found by the solver", async () => {
    await assertSolverFinds(ROWS, COMPOSITION, optimum());
  }, 20_000);

  it("uses the small reactor to spend the spare cooling", () => {
    /*
     * Without the top-up the coolers sit partly idle; with it they are almost
     * exactly saturated. Adding it must not tip the layout into overheating.
     */
    const cooling = 3 * valueOf("cooler6");
    const neuroWaste = valueOf("neuro_grid_reactor") * GENERATOR_WASTE_RATIO;
    const toppedUpWaste =
      (valueOf("neuro_grid_reactor") + valueOf("psionic_tower")) *
      GENERATOR_WASTE_RATIO;

    expect(neuroWaste, "the big reactor alone leaves headroom").toBeLessThan(
      cooling,
    );
    expect(toppedUpWaste, "the top-up must still fit").toBeLessThanOrEqual(
      cooling,
    );

    const score = (rows: string[]) => {
      const { ctx, placement } = layoutFrom(rows);
      return simulateIsland(placement, ctx).totalPower;
    };

    expect(
      score(LAYOUT),
      "spending the spare tile on a small reactor should beat a fourth cooler",
    ).toBeGreaterThan(score(["CNC", "GGC", "C.."]));
  });
});

describe("an eight-tile island", () => {
  /*
   *     G G G      ->    C G E
   *     G G G            C N C
   *     G G .            G C .
   *
   * Known best: sauron_eye + neuro_grid_reactor + 2x generator6 +
   * 4x cooler6 = 5.94e19.
   *
   * The eighth tile buys a fourth cooler, which lifts the cooling ceiling from
   * 1.809e19 to 2.412e19. That is enough headroom for a full sauron_eye
   * (8.80e18) rather than the psionic top-up the 7-tile island could afford:
   * total heat 7.92e19, waste 1.98e19, comfortably inside 2.412e19.
   *
   * A third reactor would fit the cooling budget too (waste 2.0075e19) but not
   * the island — 3 reactors + 2 generators + 4 coolers needs nine tiles, which
   * is the full 3x3 case.
   */
  const ROWS = ["GGG", "GGG", "GG."];
  const LAYOUT = ["CGE", "CNC", "GC."];
  const COMPOSITION = {
    neuro_grid_reactor: 1,
    sauron_eye: 1,
    generator6: 2,
    cooler6: 4,
  };
  const optimum = () =>
    convertedReactorOutput("neuro_grid_reactor", "sauron_eye");

  it("scores the known best layout at 5.94e19", () => {
    assertLayoutScores(LAYOUT, COMPOSITION, optimum());
  });

  it("is found by the solver", async () => {
    await assertSolverFinds(ROWS, COMPOSITION, optimum());
  }, 20_000);

  it("pays for the bigger reactor with its fourth cooler", () => {
    /*
     * Against the 7-tile island: one more cooler upgrades the top-up reactor
     * from psionic_tower to the 8x larger sauron_eye.
     */
    const sevenTileCooling = 3 * valueOf("cooler6");
    const eightTileCooling = 4 * valueOf("cooler6");
    const waste =
      (valueOf("neuro_grid_reactor") + valueOf("sauron_eye")) *
      GENERATOR_WASTE_RATIO;

    expect(waste, "three coolers could not carry this").toBeGreaterThan(
      sevenTileCooling,
    );
    expect(waste, "four coolers can").toBeLessThanOrEqual(eightTileCooling);
    expect(optimum()).toBeGreaterThan(
      convertedReactorOutput("neuro_grid_reactor", "psionic_tower"),
    );
  });
});

describe("a full three by three", () => {
  /*
   * Known best STABLE layout: 2x sauron_eye + 1x neuro_grid_reactor +
   * 2x generator6 + 4x cooler6 = 6.60e19, e.g.
   *
   *     C N E
   *     G G E
   *     C C C
   *
   * The three reactors supply 7.04e19 + 2 x 8.8e18 = 8.80e19, which two
   * generator6 (capacity 1.384e20 between them) absorb in full:
   * 8.80e19 * 0.75 = 6.60e19. The 2.20e19 of waste fits inside the four coolers'
   * 2.41e19.
   *
   * A higher-scoring arrangement exists — 2 reactors + 3 generators + 4 coolers
   * scores 7.04e19 — but it is NOT a valid answer: it only works by parking heat
   * in a third generator that never comes online, i.e. a permanently overheating
   * building.
   *
   * Both figures come from exhaustive search over
   * {empty, generator6, cooler6, neuro_grid_reactor, sauron_eye}^9 (1,953,125
   * layouts), with the stable optimum additionally checked against every 1- and
   * 2-tile substitution from the full 34-building roster.
   */
  const ROWS = ["GGG", "GGG", "GGG"];
  const STABLE_ROWS = ["CNE", "GGE", "CCC"];
  const STABLE_POWER = 6.6e19;
  const STABLE_COMPOSITION = {
    sauron_eye: 2,
    neuro_grid_reactor: 1,
    generator6: 2,
    cooler6: 4,
  };

  // Scores higher but leaves a generator permanently overheating.
  const UNSTABLE_ROWS = ["CCC", "GNG", "GNC"];
  const UNSTABLE_POWER = 7.04e19;

  it("scores the known best stable layout at 6.60e19", () => {
    // Deterministic: pins the layout and its score, independent of search.
    const { ctx, placement } = layoutFrom(STABLE_ROWS);

    const { totalPower, placements } = simulateIsland(placement, ctx);

    expect(placementComposition(placement)).toEqual(STABLE_COMPOSITION);
    expectClose(totalPower, STABLE_POWER);
    expect(
      placement.filter((b) => b !== null).length,
      "every tile is used",
    ).toBe(9);
    expect(
      offlineProducers(placement, placements),
      "every generator in the known-best layout must run",
    ).toEqual([]);
  });

  it("runs both generators on the reactors' full output", () => {
    // The whole point of the layout: nothing overheats and nothing is wasted.
    const { ctx, placement } = layoutFrom(STABLE_ROWS);
    const reactorOutput =
      valueOf("neuro_grid_reactor") + 2 * valueOf("sauron_eye");

    const { totalPower, placements } = simulateIsland(placement, ctx);
    const generators = placements.filter((p) => p.buildingId === "generator6");

    expect(generators.length).toBe(2);
    expectClose(
      generators.reduce((sum, g) => sum + g.heatConsumed, 0),
      reactorOutput,
    );
    expectClose(totalPower, reactorOutput * GENERATOR_ENERGY_RATIO);
    for (const gen of generators) {
      expect(
        gen.coolingReceived,
        "each generator must be fully cooled",
      ).toBeGreaterThanOrEqual(gen.wasteHeatGenerated - 1e3);
    }
  });

  it("rejects the higher-scoring layout for overheating", () => {
    /*
     * The 2-reactor / 3-generator layout scores 7.04e19, beating the stable
     * optimum by 6.7%, but only because a third generator absorbs heat it can
     * never cool. Pruning must dismantle it even though that costs power — an
     * overheating building is not an acceptable answer.
     */
    const { ctx, placement } = layoutFrom(UNSTABLE_ROWS);

    const { totalPower, placements } = simulateIsland(placement, ctx);
    const offline = offlineProducers(placement, placements);

    expectClose(totalPower, UNSTABLE_POWER);
    expect(totalPower, "precondition: it scores higher").toBeGreaterThan(
      STABLE_POWER,
    );
    expect(offline.length, "exactly one generator is permanently offline").toBe(
      1,
    );

    const pruned = pruneDeadWeight(placement.slice(), ctx);

    expect(
      pruned.power,
      "stabilizing this layout collapses it, which is why the search must not " +
        "settle for it in the first place",
    ).toBeLessThan(STABLE_POWER);
    for (const row of pruned.rows) {
      expect(row.idx, "the overheating generator survived pruning").not.toBe(
        offline[0],
      );
    }
  });

  it("never settles on an overheating layout", async () => {
    /*
     * Handed the unstable 7.04e19 layout as its starting point, the search must
     * not simply keep it: 7.04e19 is the highest score anything on this island
     * can reach, so a search that ranks candidates on raw power alone can never
     * improve on it and will return an overheating board.
     *
     * Starting from that layout makes the failure deterministic, which a normal
     * solve does not — the search only stumbles onto this peak occasionally.
     */
    const { ctx, placement } = layoutFrom(UNSTABLE_ROWS);
    const pools = {
      reactors: ROSTER.filter((b) => b.type === "reactor").sort(
        (a, b) => b.effectiveValue - a.effectiveValue,
      ),
      generators: ROSTER.filter((b) => b.type === "generator").sort(
        (a, b) => b.effectiveValue - a.effectiveValue,
      ),
      coolers: ROSTER.filter((b) => b.type === "cooler").sort(
        (a, b) => b.effectiveValue - a.effectiveValue,
      ),
      directProducers: ROSTER.filter((b) => b.type === "direct_producer").sort(
        (a, b) => b.energy - a.energy,
      ),
    };

    const result = await hillClimb(
      placement,
      ctx,
      pools.reactors,
      pools.generators,
      pools.coolers,
      pools.directProducers,
      300,
      new Rng(7),
      new Pacer(),
    );

    const { placements } = simulateIsland(result, ctx);
    expect(
      offlineProducers(result, placements),
      "the search returned a layout containing an overheating building",
    ).toEqual([]);
  }, 20_000);

  it("overheats a generator when the eyes are shared asymmetrically", () => {
    /*
     * Why eye placement matters so much. Here one eye feeds both generators and
     * the other feeds only one, so the heat lands unevenly: the generator that
     * gets 6.92e19 needs 1.73e19 of cooling but can only reach 1.51e19, and the
     * all-or-nothing rule takes it offline. The other generator, starved to
     * 1.76e19 of heat, cannot reach its cooling either. Both shut down and the
     * island produces nothing.
     */
    const { ctx, placement } = layoutFrom(["CEG", "NEC", "CGC"]);

    const { totalPower, placements } = simulateIsland(placement, ctx);
    const byPos = placementsByPos(placements);
    const starved = byPos.get("2,0")!;
    const flooded = byPos.get("1,2")!;

    expect(
      flooded.heatConsumed,
      "precondition: this arrangement should distribute heat unevenly",
    ).toBeGreaterThan(starved.heatConsumed * 3);
    expect(
      flooded.coolingReceived,
      "the flooded generator cannot reach enough cooling",
    ).toBeLessThan(flooded.wasteHeatGenerated);
    expectClose(totalPower, 0); // all-or-nothing means both generators shut down
  });

  it("builds the known best composition", async () => {
    /*
     * The composition is the reliable signal here: every run returns 2 eyes +
     * 1 neuro + 2 generators + 4 coolers. The exact arrangement varies — roughly
     * half the runs find the 6.60e19 optimum and the rest land on a 6.51e19
     * variant — so power is asserted as a floor. Tightening this to equality is
     * a fair goal for a search improvement.
     */
    const floor = 6.5e19;

    const { placements, power } = await solveToOptimum(
      islandFrom(ROWS),
      STABLE_POWER,
    );

    expect(compositionOf(placements)).toEqual(STABLE_COMPOSITION);
    expect(placements.length, "every tile should be used").toBe(9);
    expect(
      power,
      `solver returned only ${power.toExponential(4)}`,
    ).toBeGreaterThan(floor);
    expect(
      power,
      "solver beat the stable optimum — it may be leaving something overheating",
    ).toBeLessThanOrEqual(STABLE_POWER * (1 + 1e-9));
  }, 20_000);
});
