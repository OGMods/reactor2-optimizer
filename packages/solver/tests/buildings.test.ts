/**
 * Resolving the building catalogue against unlocked upgrade levels, and the
 * integrity of the catalogue itself.
 *
 * Ported from the reference solver's `tests/test_buildings.py`. The second half
 * is the one that earns its keep: `BUILDING_TABLE` is machine-generated from
 * the game's own files, so nobody reads it, and a number that came out wrong
 * would otherwise surface as a solve that is quietly worse than it should be.
 */
import { describe, expect, it } from "vitest";
import {
  BUILDINGS,
  allUpgradesUnlocked,
  buildingCategory,
  findBuilding,
  levelIndexForValue,
  levelValue,
} from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { snapToAuthoredPrecision } from "../src/solver/physics";
import type {
  BuildingDefinition,
  DirectProducerLevel,
  GeneratorLevel,
  UpgradeLevel,
} from "../src/solver/types";
import { expectClose } from "./helpers";

/** A cooler, for the cases that only care about level selection. */
function definition(
  id = "thing",
  values: number[] = [1, 2, 3],
): BuildingDefinition {
  return {
    id,
    name: id,
    price: 1,
    displayIndex: 0,
    type: "cooler",
    levels: values.map((cooling) => ({ cooling })),
  };
}

function oneLevel(
  type: BuildingDefinition["type"],
  level: UpgradeLevel,
  id: string,
): BuildingDefinition {
  return {
    id,
    name: id,
    price: 1,
    displayIndex: 0,
    type,
    levels: [level],
  } as BuildingDefinition;
}

/** Generators and direct producers are the only roles with an energy figure. */
function isProducerLevel(
  level: UpgradeLevel,
): level is GeneratorLevel | DirectProducerLevel {
  return "energy" in level;
}

describe("getEffectiveBuildings", () => {
  it("picks the value at the unlocked level", () => {
    const roster = getEffectiveBuildings([definition("thing", [10, 20, 30])], {
      thing: 1,
    });

    expect(roster.length).toBe(1);
    expectClose(roster[0].effectiveValue, 20);
  });

  it("locks out buildings absent from the unlock map", () => {
    const roster = getEffectiveBuildings([definition("a"), definition("b")], {
      a: 0,
    });

    expect(roster.map((b) => b.id)).toEqual(["a"]);
  });

  it("clamps the level into range", () => {
    const defs = [definition("high", [10, 20]), definition("low", [10, 20])];

    const byId = new Map(
      getEffectiveBuildings(defs, { high: 99, low: -5 }).map((b) => [b.id, b]),
    );

    expectClose(byId.get("high")!.effectiveValue, 20); // clamped to the last tier
    expectClose(byId.get("low")!.effectiveValue, 10); // clamped to the first
  });

  it("skips buildings with no upgrade tiers", () => {
    expect(
      getEffectiveBuildings([definition("thing", [])], { thing: 0 }),
    ).toEqual([]);
  });

  it("resolves energy and waste per role", () => {
    const defs = [
      oneLevel("generator", { heat: 100, energy: 75 }, "gen"),
      oneLevel("direct_producer", { heat: 10, energy: 8 }, "dp"),
      oneLevel("reactor", { heat: 50 }, "reactor"),
      oneLevel("cooler", { cooling: 30 }, "cooler"),
    ];

    const byId = new Map(
      getEffectiveBuildings(defs, {
        gen: 0,
        dp: 0,
        reactor: 0,
        cooler: 0,
      }).map((b) => [b.id, b]),
    );

    expectClose(byId.get("gen")!.energy, 75);
    // A generator wastes the heat it does not convert.
    expectClose(byId.get("gen")!.waste, 25);
    expectClose(byId.get("dp")!.energy, 8);
    expectClose(byId.get("dp")!.waste, 2);

    for (const support of ["reactor", "cooler"]) {
      expectClose(byId.get(support)!.energy, 0); // makes no power of its own
      expectClose(byId.get(support)!.waste, 0); // has nothing to cool
    }
  });

  it("prefers the authored waste over the subtraction", () => {
    /*
     * The game authors WasteHeatPerTick; it is not `heat - energy` evaluated in
     * floating point. At generator 7's tiers the two differ in the last few
     * digits, and the authored figure is the one the game uses.
     */
    const defs = [
      oneLevel(
        "generator",
        { heat: 8.85e21, energy: 6.64e21, waste: 2.21e21 },
        "gen7",
      ),
    ];

    const gen = getEffectiveBuildings(defs, { gen7: 0 })[0];

    expect(gen.waste).toBe(2.21e21);
    expect(8.85e21 - 6.64e21, "the subtraction does not land there").not.toBe(
      2.21e21,
    );
  });

  it("falls back to the game's own derivation when no waste is authored", () => {
    // snap(heat - energy), not the raw subtraction — which is how the game
    // computes the authored value in the first place.
    const defs = [
      oneLevel("generator", { heat: 8.85e21, energy: 6.64e21 }, "gen7"),
    ];

    expect(getEffectiveBuildings(defs, { gen7: 0 })[0].waste).toBe(2.21e21);
  });

  it("resolves the whole shipped catalogue at full unlocks", () => {
    const roster = getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked());

    expect(roster.length).toBe(BUILDINGS.length);
  });
});

describe("the shipped catalogue", () => {
  it("gives every building a unique id", () => {
    const ids = BUILDINGS.map((b) => b.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points allUpgradesUnlocked at real buildings only", () => {
    const known = new Set(BUILDINGS.map((b) => b.id));

    expect(
      Object.keys(allUpgradesUnlocked()).filter((id) => !known.has(id)),
    ).toEqual([]);
  });

  it.each(BUILDINGS.map((b) => [b.id, b] as const))(
    "%s has a known role and positive tiers",
    (_id, building) => {
      expect(["cooler", "reactor", "generator", "direct_producer"]).toContain(
        building.type,
      );
      expect(building.levels.length).toBeGreaterThan(0);
      for (const level of building.levels as readonly UpgradeLevel[]) {
        expect(levelValue(level)).toBeGreaterThan(0);
      }
    },
  );

  it.each(BUILDINGS.map((b) => [b.id, b] as const))(
    "%s never gets worse with a later tier",
    (_id, building) => {
      const values = (building.levels as readonly UpgradeLevel[]).map(
        levelValue,
      );

      expect(values).toEqual([...values].sort((a, b) => a - b));
    },
  );

  it.each(BUILDINGS.map((b) => [b.id, b] as const))(
    "%s converts heat into power only if it is a producer",
    (_id, building) => {
      const levels = building.levels as readonly UpgradeLevel[];

      if (
        building.type !== "generator" &&
        building.type !== "direct_producer"
      ) {
        // Coolers and reactors have no energy figure at all.
        expect(levels.some(isProducerLevel)).toBe(false);
        return;
      }

      for (const level of levels) {
        expect(isProducerLevel(level)).toBe(true);
        const producer = level as GeneratorLevel;
        expect(producer.energy).toBeGreaterThan(0);
        // Some of the heat always has to be wasted.
        expect(producer.energy).toBeLessThan(producer.heat);
      }
    },
  );

  it.each(BUILDINGS.map((b) => [b.id, b] as const))(
    "%s authors the waste the game would have derived",
    (_id, building) => {
      if (
        building.type !== "generator" &&
        building.type !== "direct_producer"
      ) {
        return;
      }
      for (const level of building.levels as readonly GeneratorLevel[]) {
        // The catalogue authors every waste figure.
        expect(level.waste).toBeDefined();
        expect(level.waste).toBe(
          snapToAuthoredPrecision(level.heat - level.energy),
        );
      }
    },
  );

  it("carries cooler2's authored values, not the ones the UI shows", () => {
    const cooler2 = findBuilding("cooler2")!;

    expect((cooler2.levels as readonly UpgradeLevel[]).map(levelValue)).toEqual(
      [3200, 5760, 10368, 18662, 33592, 60466],
    );
  });

  it("gives generator 1 seven heat tiers ending in 5120", () => {
    const generator = findBuilding("generator")!;

    expect(
      (generator.levels as readonly UpgradeLevel[]).map(levelValue),
    ).toEqual([80, 160, 320, 640, 1280, 2560, 5120]);
    expect(allUpgradesUnlocked()["generator"]).toBe(6);
  });

  it("carries the game's authored conversion", () => {
    const roster = new Map(
      getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked()).map((b) => [
        b.id,
        b,
      ]),
    );

    expect(roster.get("generator")!.energy).toBe(3840);
    expect(roster.get("generator")!.waste).toBe(1280);
    expect(roster.get("wind_turbine")!.energy).toBe(7);
    expect(roster.get("wind_turbine")!.waste).toBe(1.75);
  });

  it("can actually build something", () => {
    const types = new Set(
      getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked()).map(
        (b) => b.type,
      ),
    );

    expect(types).toContain("cooler");
    expect(types).toContain("generator");
    expect(types).toContain("reactor");
  });
});

describe("the three UI groups", () => {
  it("files reactors and direct producers together, as the game does", () => {
    expect(buildingCategory("reactor")).toBe("heat_producer");
    expect(buildingCategory("direct_producer")).toBe("heat_producer");
    expect(buildingCategory("cooler")).toBe("cooler");
    expect(buildingCategory("generator")).toBe("generator");
  });
});

describe("levelIndexForValue", () => {
  it("recovers the tier a placed building was rated at", () => {
    const generator = findBuilding("generator")!;

    expect(levelIndexForValue(generator, 80)).toBe(0);
    expect(levelIndexForValue(generator, 2560)).toBe(5);
  });

  it("resolves a value the catalogue does not author to the top tier", () => {
    // A hand-edited save. `effectiveAtValue` rates it the same way, so the
    // readout and the scorer cannot disagree about it.
    const generator = findBuilding("generator")!;

    expect(levelIndexForValue(generator, 12345)).toBe(
      generator.levels.length - 1,
    );
  });
});
