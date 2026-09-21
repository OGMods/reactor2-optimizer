/**
 * Time Lab research, and the one thing about it that can fail quietly.
 *
 * These are plain multipliers, so an arithmetic slip shows up as a board that
 * is simply worth more or less than it should be — no crash, no wrong-looking
 * layout, just every figure off by a factor. Two things could cause that and
 * neither would announce itself: the **presence rule** (a key's presence is
 * what "researched" means, exactly as in `buildingUpgrades`, so an upgrade at
 * index 0 is researched at its *first* level, not absent), and the derivation
 * of the factor from the game's authored bonus.
 */
import { describe, expect, it } from "vitest";
import {
  PRESTIGE_UPGRADES,
  prestigeMultiplier,
  prestigeScales,
} from "../src/data/prestige";
import {
  effectiveAtValue,
  getEffectiveBuildings,
} from "../src/data/effectiveBuildings";
import { planSolve } from "../src/solver/solver";
import { makeGrid } from "../src/grid";
import type { BuildingDefinition } from "../src/solver/types";

const DEFS: readonly BuildingDefinition[] = [
  {
    id: "c",
    name: "C",
    price: 0,
    displayIndex: 0,
    type: "cooler",
    levels: [{ cooling: 100 }],
  },
  {
    id: "r",
    name: "R",
    price: 0,
    displayIndex: 1,
    type: "reactor",
    levels: [{ heat: 200 }],
  },
  {
    id: "g",
    name: "G",
    price: 0,
    displayIndex: 2,
    type: "generator",
    levels: [{ heat: 400, energy: 300, waste: 100 }],
  },
];
const ALL = { c: 0, r: 0, g: 0 };

describe("resolving research levels", () => {
  it("is the identity when nothing is researched", () => {
    // By reference: every roster resolution asks for this, and the unresearched
    // case is the common one.
    expect(prestigeScales({})).toBe(prestigeScales(undefined));
    expect(prestigeScales(undefined).cooler).toBe(1);
  });

  it("treats index 0 as researched at the first level, not as absent", () => {
    // The presence rule, and the one that would silently under-rate a board:
    // `buildingUpgrades` spells "unlocked at tier 1" as `{id: 0}`, and this
    // record follows it.
    const first = PRESTIGE_UPGRADES[0];
    expect(prestigeScales({ [first.id]: 0 })[first.roles[0]]).toBe(
      prestigeMultiplier(first.bonuses[0]),
    );
    expect(prestigeScales({})[first.roles[0]]).toBe(1);
  });

  it("reads the top level from the end of the table", () => {
    const first = PRESTIGE_UPGRADES[0];
    const top = first.bonuses.length - 1;
    expect(prestigeScales({ [first.id]: top })[first.roles[0]]).toBe(
      prestigeMultiplier(first.bonuses[top]),
    );
  });

  it("clamps an index past the table rather than reading past its end", () => {
    // The index arrives from `localStorage`, so a later build's save can name a
    // sixth level this one does not have.
    const first = PRESTIGE_UPGRADES[0];
    expect(prestigeScales({ [first.id]: 99 })[first.roles[0]]).toBe(
      prestigeMultiplier(first.bonuses[first.bonuses.length - 1]),
    );
  });

  it("derives the factor as 1 + the game's authored bonus", () => {
    // The game prints "+100%" and means ×2. Getting this backwards would halve
    // or double every board without anything looking wrong.
    expect(prestigeMultiplier(1.0)).toBe(2);
    expect(prestigeMultiplier(2.25)).toBe(3.25);
  });

  it("leaves roles no researched upgrade names untouched", () => {
    const scales = prestigeScales({ absolute_zero: 4 });
    expect(scales.cooler).toBeGreaterThan(1);
    expect([scales.reactor, scales.generator, scales.direct_producer]).toEqual([
      1, 1, 1,
    ]);
  });
});

describe("research reaching the roster", () => {
  it("scales a cooler's cooling and nothing else's", () => {
    const roster = getEffectiveBuildings(
      DEFS,
      ALL,
      prestigeScales({ absolute_zero: 0 }),
    );
    const by = (id: string) => roster.find((b) => b.id === id)!;
    expect(by("c").effectiveValue).toBe(100 * 2);
    expect(by("r").effectiveValue).toBe(200);
    expect(by("g").effectiveValue).toBe(400);
  });

  it("scales a generator uniformly, so its waste grows with its output", () => {
    // The point of the shape. `infinite_grid` raises the overheat threshold as
    // well as the energy, so a researched generator needs proportionally more
    // cooling — it is a bigger bet, not free power.
    const roster = getEffectiveBuildings(
      DEFS,
      ALL,
      prestigeScales({ infinite_grid: 0 }),
    );
    const g = roster.find((b) => b.id === "g")!;
    expect([g.effectiveValue, g.energy, g.waste]).toEqual([800, 600, 200]);
  });

  it("scales a reactor's heat for Stellar Forge", () => {
    const roster = getEffectiveBuildings(
      DEFS,
      ALL,
      prestigeScales({ stellar_forge: 4 }),
    );
    expect(roster.find((b) => b.id === "r")!.effectiveValue).toBe(200 * 5);
  });

  it("changes nothing when passed no research", () => {
    const roster = getEffectiveBuildings(DEFS, ALL);
    expect(roster.map((b) => b.effectiveValue)).toEqual([100, 200, 400]);
  });
});

describe("research reaching a solve", () => {
  /*
   * The gap this closes: a run hands the solver `buildings` and
   * `unlockedUpgrades` and lets `planSolve` resolve the roster, so research
   * applied anywhere *else* — the board readout, the run estimate — never
   * reached the search at all. The symptom was invisible: a perfectly valid
   * layout, optimised for a roster the player does not have.
   */
  const GRID = makeGrid(["GGGGG", "GGGGG", "GGGGG"]);
  const DEFS_ARR = DEFS as BuildingDefinition[];

  it("resolves the plan's roster under the research it is given", () => {
    const plan = planSolve(
      GRID,
      DEFS_ARR,
      ALL,
      1,
      undefined,
      undefined,
      prestigeScales({ absolute_zero: 0 }),
    );
    const cooler = plan!.effectiveBuildings.find((b) => b.id === "c")!;
    expect(cooler.effectiveValue).toBe(200);
  });

  it("resolves it unresearched when given none", () => {
    const plan = planSolve(GRID, DEFS_ARR, ALL, 1);
    expect(
      plan!.effectiveBuildings.find((b) => b.id === "c")!.effectiveValue,
    ).toBe(100);
  });

  it("raises the bound research raises", () => {
    // The upper bound is computed from the same roster, so if research reached
    // one and not the other the efficiency figure would read past 100%.
    const plain = planSolve(GRID, DEFS_ARR, ALL, 1)!;
    const boosted = planSolve(
      GRID,
      DEFS_ARR,
      ALL,
      1,
      undefined,
      undefined,
      prestigeScales({ infinite_grid: 4 }),
    )!;
    expect(boosted.theoreticalMaxPower).toBeGreaterThan(
      plain.theoreticalMaxPower,
    );
  });

  it("carries the anomaly it is given, defaulting to none", () => {
    expect(planSolve(GRID, DEFS_ARR, ALL, 1)!.anomaly.rule).toBe("baseline");
    expect(
      planSolve(GRID, DEFS_ARR, ALL, 1, undefined, "cryo_nexus")!.anomaly.id,
    ).toBe("cryo_nexus");
    // Total, like `getAnomaly`: an id from a newer save is the base rules.
    expect(
      planSolve(GRID, DEFS_ARR, ALL, 1, undefined, "not_a_thing")!.anomaly.rule,
    ).toBe("baseline");
  });
});

describe("what a solved placement reports under research", () => {
  /*
   * The round trip that breaks if a scaled value is reported as the placement's
   * base value. `effectiveAtValue` resolves a tier by *matching* that number
   * against the catalogue, so a scaled one matches a higher tier and is then
   * scaled again — a valid-looking board rated one level too high, with no
   * error anywhere.
   */
  it("reports the authored tier value, not the scaled one", () => {
    const scales = prestigeScales({ absolute_zero: 0 }); // level 1, x2
    const roster = getEffectiveBuildings(
      DEFS as BuildingDefinition[],
      ALL,
      scales,
    );
    const cooler = roster.find((b) => b.id === "c")!;

    expect(cooler.effectiveValue).toBe(200); // what the search works with
    expect(cooler.baseValue).toBe(100); // what a placement records
  });

  it("round-trips a scored placement back to the same rating", () => {
    const scales = prestigeScales({ infinite_grid: 0 }); // level 1, x2
    const roster = getEffectiveBuildings(
      DEFS as BuildingDefinition[],
      ALL,
      scales,
    );
    const gen = roster.find((b) => b.id === "g")!;
    const def = (DEFS as BuildingDefinition[]).find((d) => d.id === "g")!;

    // `simulateIsland` writes `baseValue` into every row it reports; resolving
    // that row again must give back the building the search actually used.
    const resolved = effectiveAtValue(def, gen.baseValue, scales);
    expect(resolved.effectiveValue).toBe(gen.effectiveValue);
    expect(resolved.energy).toBe(gen.energy);
    expect(resolved.waste).toBe(gen.waste);
  });
});
