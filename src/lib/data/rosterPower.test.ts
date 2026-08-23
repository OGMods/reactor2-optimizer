import { describe, expect, it } from "vitest";
import { rosterCanProducePower } from "./effectiveBuildings";
import type { EffectiveBuilding } from "../solver/types";

/**
 * The rule behind the Run button's refusal. Every branch here is a way the
 * guard could fail open (a run that spends its whole budget to return a blank
 * board) or fail closed (a refusal on a roster that would have worked), and
 * neither is visible from the app until someone presses Run.
 *
 * The figures are the shape of the catalogue rather than its values: what
 * matters is which fields are non-zero, since that is all the rule reads.
 */
const cooler: EffectiveBuilding = {
  id: "cooler1",
  type: "cooler",
  effectiveValue: 100,
  energy: 0,
  waste: 0,
};
const reactor: EffectiveBuilding = {
  id: "reactor1",
  type: "reactor",
  effectiveValue: 100,
  energy: 0,
  waste: 0,
};
const generator: EffectiveBuilding = {
  id: "generator1",
  type: "generator",
  effectiveValue: 100,
  energy: 75,
  waste: 25,
};
const turbine: EffectiveBuilding = {
  id: "windturbine1",
  type: "direct_producer",
  effectiveValue: 10,
  energy: 7,
  waste: 3,
};

describe("rosterCanProducePower", () => {
  it("refuses an empty roster", () => {
    expect(rosterCanProducePower([])).toBe(false);
  });

  it("refuses a roster with no producer in it", () => {
    expect(rosterCanProducePower([cooler, reactor])).toBe(false);
  });

  it("refuses a generator with no reactor to feed it", () => {
    // Heat comes only from reactors — a direct producer sends none.
    expect(rosterCanProducePower([generator, cooler])).toBe(false);
    expect(rosterCanProducePower([generator, cooler, turbine])).toBe(true);
  });

  it("refuses a producer whose waste has nowhere to go", () => {
    expect(rosterCanProducePower([reactor, generator])).toBe(false);
    expect(rosterCanProducePower([turbine])).toBe(false);
  });

  it("accepts the reactor / generator / cooler chain", () => {
    expect(rosterCanProducePower([reactor, generator, cooler])).toBe(true);
  });

  it("accepts a cooled direct producer on its own", () => {
    // It never touches the heat side, so it needs no reactor.
    expect(rosterCanProducePower([turbine, cooler])).toBe(true);
  });

  it("accepts a producer that makes no waste, with no cooler at all", () => {
    expect(rosterCanProducePower([{ ...turbine, waste: 0 }])).toBe(true);
  });

  it("refuses a generator that can absorb no heat", () => {
    // `generatorPowerAndWaste` returns zero on a cap of zero, whatever the
    // authored energy says.
    const empty = { ...generator, effectiveValue: 0 };
    expect(rosterCanProducePower([reactor, empty, cooler])).toBe(false);
  });

  it("refuses when the only cooler cools nothing", () => {
    const dead = { ...cooler, effectiveValue: 0 };
    expect(rosterCanProducePower([reactor, generator, dead])).toBe(false);
  });

  it("refuses when the only reactor makes no heat", () => {
    const dead = { ...reactor, effectiveValue: 0 };
    expect(rosterCanProducePower([dead, generator, cooler])).toBe(false);
  });
});
