/**
 * The anomaly catalogue and the one primitive every stat anomaly goes through.
 *
 * Two things here can fail silently rather than loudly. `getAnomaly` is the
 * only resolution path and it takes a bare string off `localStorage` and off
 * the worker boundary, so an id this build has never heard of must land on the
 * base rules rather than on `undefined` — the app would otherwise solve a board
 * with no rules at all. And `scaleEffectiveBuilding` is what makes a bonus mean
 * the same thing for all four roles: scale only the figure a role "produces"
 * and a generator's bonus becomes free power, because its cooling appetite
 * would not have grown with it.
 */
import { describe, expect, it } from "vitest";
import {
  ANOMALIES,
  DEFAULT_ANOMALY_ID,
  getAnomaly,
} from "../src/data/anomalies";
import { scaleEffectiveBuilding } from "../src/data/effectiveBuildings";
import { wasteIsCovered } from "../src/solver/physics";
import type { EffectiveBuilding } from "../src/solver/types";

const generator: EffectiveBuilding = {
  id: "gen",
  type: "generator",
  effectiveValue: 400,
  energy: 300,
  waste: 100,
  baseValue: 400,
};

describe("the anomaly catalogue", () => {
  it("has a unique id per entry", () => {
    const ids = ANOMALIES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every id it ships", () => {
    for (const anomaly of ANOMALIES) {
      expect(getAnomaly(anomaly.id)).toBe(anomaly);
    }
  });

  it("falls back to the base rules for an id it does not know", () => {
    // A save from a later build, most likely. Running the base rules is the
    // honest answer, and it is what the unknown id would have meant anyway.
    for (const id of ["cascade_flux", "", undefined]) {
      expect(getAnomaly(id).rule).toBe("baseline");
    }
  });

  it("defaults to no anomaly", () => {
    expect(getAnomaly(DEFAULT_ANOMALY_ID).rule).toBe("baseline");
  });
});

describe("scaling a resolved building", () => {
  it("scales all three figures by the same factor", () => {
    expect(scaleEffectiveBuilding(generator, 2.5)).toEqual({
      id: "gen",
      type: "generator",
      effectiveValue: 1000,
      energy: 750,
      waste: 250,
      // Untouched — see below.
      baseValue: 400,
    });
  });

  it("leaves the authored tier value alone", () => {
    // The one field that must NOT scale. It is what a placement records and
    // what `effectiveAtValue` resolves the tier back out of, so scaling it
    // matches a higher tier and then applies the factor a second time: an
    // authored 400 under x2 would report 800, match the authored 800 tier, and
    // come back 1600 at one level too high.
    const scaled = scaleEffectiveBuilding(generator, 2);
    expect(scaled.baseValue).toBe(generator.baseValue);
    expect(scaled.effectiveValue).toBe(800);
  });

  it("is identity at a factor of one", () => {
    // By reference: the unscaled case is most of every board and must allocate
    // nothing.
    expect(scaleEffectiveBuilding(generator, 1)).toBe(generator);
  });

  it("leaves a bonus needing proportionally more cooling", () => {
    // The point of scaling uniformly. Cooling that exactly covered the base
    // building must not still cover the bonused one, or a multiplier would be
    // free power rather than a bigger bet.
    const scaled = scaleEffectiveBuilding(generator, 1.67);
    expect(wasteIsCovered(generator.waste, generator.waste)).toBe(true);
    expect(wasteIsCovered(scaled.waste, generator.waste)).toBe(false);
    expect(wasteIsCovered(scaled.waste, scaled.waste)).toBe(true);
  });

  it("keeps a penalised building's figures in the same proportion", () => {
    const scaled = scaleEffectiveBuilding(generator, 0.8);
    expect(scaled.energy / scaled.effectiveValue).toBeCloseTo(
      generator.energy / generator.effectiveValue,
      12,
    );
  });
});
