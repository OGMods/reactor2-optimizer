/**
 * `scaleEffectiveBuilding` — the one place a multiplier reaches a building.
 *
 * Time Lab research and every stat anomaly go through it, so its arithmetic is
 * the arithmetic of the whole prestige feature. Nothing in it can fail loudly:
 * a slip here produces a board that is simply rated wrong, with no crash and no
 * layout that looks odd, and the golden fixtures assert to the last digit.
 *
 * Three rules, each pinned below against the shipped catalogue rather than
 * against round synthetic numbers — the divergences are in the last bit, so a
 * test built on tidy figures would pass under either reading.
 */
import { describe, expect, it } from "vitest";
import { BUILDINGS } from "../src/data/buildings";
import { scaleEffectiveBuilding } from "../src/data/effectiveBuildings";
import { snapToAuthoredPrecision } from "../src/solver/physics";
import type { EffectiveBuilding } from "../src/solver/types";

/** The authored tiers of the roster's top generator, the sharpest case here. */
const G7 = BUILDINGS.find((b) => b.id === "generator7")!;
if (G7.type !== "generator") throw new Error("generator7 is not a generator");

/** A resolved building at an authored tier, the way the roster produces one. */
const atTier = (tier: number): EffectiveBuilding => {
  const level = G7.levels[tier];
  return {
    id: G7.id,
    type: "generator",
    effectiveValue: level.heat,
    energy: level.energy,
    waste: level.waste ?? snapToAuthoredPrecision(level.heat - level.energy),
    baseValue: level.heat,
  };
};

describe("waste is derived from the scaled pair, not scaled itself", () => {
  it("differs from the scaled authored waste, and takes the derived value", () => {
    // generator7 at tier 4 under Tidal Ascendancy. The game's runtime getter is
    // `(HeatPerTick - EnergyPerTick).SnapToAuthoredPrecision()` over the scaled
    // pair, so this is 3.6907e21 — carrying the authored 2.21e21 through the
    // same multiply gives 3.6906999999999996e21, half a million short.
    const scaled = scaleEffectiveBuilding(atTier(3), 1.67);

    expect(scaled.waste).toBe(3.6907e21);
    expect(scaled.waste).not.toBe(2.21e21 * 1.67);
    expect(scaled.waste).toBe(
      snapToAuthoredPrecision(scaled.effectiveValue - scaled.energy),
    );
  });

  it("holds for a producer the other way up, at single-digit magnitudes", () => {
    // The wind turbine's 3.75/3/0.75 goes the opposite way at x0.8: derived is
    // exactly 0.6, scaled authored is 0.6000000000000001. Both directions have
    // to be wrong for the identity to be an accident.
    const turbine = BUILDINGS.find((b) => b.id === "wind_turbine")!;
    if (turbine.type !== "direct_producer") throw new Error("not a producer");
    const level = turbine.levels[2];

    const scaled = scaleEffectiveBuilding(
      {
        id: turbine.id,
        type: "direct_producer",
        effectiveValue: level.heat,
        energy: level.energy,
        waste: level.waste!,
        baseValue: level.heat,
      },
      0.8,
    );

    expect(scaled.waste).toBe(0.6);
    expect(scaled.waste).not.toBe(0.75 * 0.8);
  });

  it("leaves a cooler's and a reactor's waste at zero", () => {
    // The roles with no energy figure. Deriving `heat - energy` for them would
    // turn a reactor's entire output into waste it then has to have cooled,
    // and a cooler's entire cooling into waste — silently, since both fields
    // are plain numbers and nothing downstream range-checks them.
    const cooler = scaleEffectiveBuilding(
      {
        id: "c",
        type: "cooler",
        effectiveValue: 100,
        energy: 0,
        waste: 0,
        baseValue: 100,
      },
      2.5,
    );
    const reactor = scaleEffectiveBuilding(
      {
        id: "r",
        type: "reactor",
        effectiveValue: 200,
        energy: 0,
        waste: 0,
        baseValue: 200,
      },
      2.5,
    );

    expect([cooler.effectiveValue, cooler.waste]).toEqual([250, 0]);
    expect([reactor.effectiveValue, reactor.waste]).toEqual([500, 0]);
  });
});

describe("two multipliers compose as two calls, not as one product", () => {
  it("applies research and anomaly successively, as the game's getters do", () => {
    // The game multiplies the authored figure by the Time Lab bonus in the SO
    // getter and by the anomaly in the runtime getter, so what a building is
    // rated at is `(authored x research) x anomaly`. That is not the same
    // double as `authored x (research x anomaly)`: Infinite Grid maxed (x5) and
    // Singularity Isolation isolated (x2.5) over generator7's first tier give
    // 1.3875000000000001e22 one way and 1.3875e22 the other.
    const researched = scaleEffectiveBuilding(atTier(0), 5);
    const both = scaleEffectiveBuilding(researched, 2.5);

    expect(both.effectiveValue).toBe(1.11e21 * 5 * 2.5);
    expect(both.effectiveValue).toBe(1.3875000000000001e22);
    expect(both.effectiveValue).not.toBe(1.11e21 * (5 * 2.5));
  });

  it("re-derives waste at each step, so the last one wins", () => {
    // Waste after two calls is the snapped difference of the twice-scaled pair,
    // never the once-derived waste carried through a second multiply.
    const both = scaleEffectiveBuilding(scaleEffectiveBuilding(atTier(1), 5), 1.67);

    expect(both.waste).toBe(
      snapToAuthoredPrecision(both.effectiveValue - both.energy),
    );
  });
});

describe("what a multiplier must not touch", () => {
  it("carries baseValue through untouched", () => {
    // It identifies the tier, and a tier does not change because something
    // scaled what it is worth. `effectiveAtValue` matches the catalogue on this
    // number, so a scaled one resolves to a higher tier and scales twice.
    const scaled = scaleEffectiveBuilding(atTier(2), 1.67);

    expect(scaled.baseValue).toBe(4.43e21);
    expect(scaled.effectiveValue).not.toBe(scaled.baseValue);
  });

  it("returns the building itself at a factor of one", () => {
    // By reference: the unmodified roster is the common case, and every solve
    // resolves one.
    const building = atTier(0);

    expect(scaleEffectiveBuilding(building, 1)).toBe(building);
  });
});
