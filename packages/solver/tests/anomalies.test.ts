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
import { buildIslandContext } from "../src/solver/context";
import { simulateIsland } from "../src/solver/simulate";
import { makeGrid } from "../src/grid";
import { basicRoster, cooler } from "./helpers";
import type { EffectiveBuilding, Placement } from "../src/solver/types";

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

describe("a terrain bonus reaching the board", () => {
  /*
   * Tidal Ascendancy is the only rule in the game where an unbuildable tile
   * does anything, and the only one resolved per tile rather than per roster or
   * per layout. Which tiles qualify is fixed by the terrain, so the context
   * settles it once and `rate` is a lookup — the reason a shore bonus costs the
   * search nothing.
   */
  const tidal = getAnomaly("tidal_ascendancy");

  /** The context for a board, with off-board treated as water throughout. */
  const contextFor = (rows: string[], anomaly = tidal) =>
    buildIslandContext(makeGrid(rows), undefined, anomaly);

  it("rates a shore tile up and an inland tile as authored", () => {
    // A 5x3 of grass ringed by nothing: every tile but the middle row's
    // interior touches the board's edge, and the edge is water.
    const ctx = contextFor(["GGGGG", "GGGGG", "GGGGG"]);
    const base = cooler(100);
    const inland = ctx.tiles.find((t) => ctx.rate(t, base) === base)!;

    expect(ctx.uniformRating).toBe(false);
    expect(ctx.rate(ctx.tiles[0], base).effectiveValue).toBe(167);
    expect(ctx.rate(inland, base).effectiveValue).toBe(100);
    // The authored tier value never moves, whatever the tile.
    expect(ctx.rate(ctx.tiles[0], base).baseValue).toBe(100);
  });

  it("rates every tile of a wholly inland island the same", () => {
    // Walled in by rock, well away from the board's edge. Nothing qualifies, so
    // the context says so and every tile skips the lookup.
    const ctx = contextFor([
      "RRRRRRR",
      "RRRRRRR",
      "RRGGGRR",
      "RRRRRRR",
      "RRRRRRR",
    ]);

    expect(ctx.uniformRating).toBe(true);
    const base = cooler(100);
    expect(ctx.rate(ctx.tiles[0], base)).toBe(base);
  });

  it("is idempotent, so a building may be moved between tiles", () => {
    /*
     * The search swaps two buildings and restores them when the move is
     * rejected, which hands `rate` objects it has already rated. Without this
     * the restore would scale a scaled building and the layout would quietly be
     * worth 2.8x.
     */
    const ctx = contextFor(["GGGGG", "GGGGG", "GGGGG"]);
    const base = cooler(100);
    const inland = ctx.tiles.find((t) => ctx.rate(t, base) === base)!;
    const shore = ctx.tiles[0];

    const onShore = ctx.rate(shore, base);
    expect(onShore.effectiveValue).toBe(167);
    // Shore -> shore, twice over.
    expect(ctx.rate(shore, onShore)).toBe(onShore);
    // Shore -> inland gives the authored building back, not 167 x 1.67.
    expect(ctx.rate(inland, onShore)).toBe(base);
    // And back again.
    expect(ctx.rate(shore, ctx.rate(inland, onShore))).toBe(onShore);
  });

  it("leaves every tile alone under an anomaly that is not terrain-based", () => {
    for (const id of ["none", "cryo_nexus", "singularity_isolation"]) {
      const ctx = contextFor(["GGGGG", "GGGGG"], getAnomaly(id));
      expect(ctx.uniformRating, id).toBe(true);
    }
  });

  it("scores a shore layout above the same layout inland", () => {
    /*
     * The rule end to end. The same three buildings, the same arrangement, on
     * a board where they are coastal and on one where they are not — and the
     * bonus is not free power, because the cooler has to be bonused too for the
     * generator's larger waste to stay covered.
     */
    const roster = basicRoster();
    const layoutOn = (rows: string[]) => {
      const ctx = buildIslandContext(makeGrid(rows), undefined, tidal);
      const placement: Placement = new Array(ctx.n).fill(null);
      const [r, g, c] = [roster[0], roster[1], roster[2]];
      placement[ctx.tiles[0]] = ctx.rate(ctx.tiles[0], r);
      placement[ctx.tiles[1]] = ctx.rate(ctx.tiles[1], g);
      placement[ctx.tiles[2]] = ctx.rate(ctx.tiles[2], c);
      return simulateIsland(placement, ctx).totalPower;
    };

    // Three tiles in a column against the board's left edge: all shore.
    const shore = layoutOn(["GRRRR", "GRRRR", "GRRRR"]);
    // The same column, walled in by rock and away from every edge.
    const inland = layoutOn([
      "RRRRR",
      "RRGRR",
      "RRGRR",
      "RRGRR",
      "RRRRR",
    ]);

    expect(inland).toBeGreaterThan(0);
    expect(shore).toBeCloseTo(inland * 1.67, 6);
  });
});
