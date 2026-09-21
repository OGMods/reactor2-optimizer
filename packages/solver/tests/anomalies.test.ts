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
import { splitGridIntoIslands } from "../src/solver/island";
import { solveIsland } from "../src/solver/placementSearch";
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

describe("role isolation reaching the board", () => {
  /*
   * The one rule whose multiplier depends on the layout rather than on the
   * board, so it is resolved per simulation instead of per tile. The test is on
   * what a neighbour *is*, never on what it is doing — an idle, booting or
   * overheated generator costs its neighbour the penalty just the same.
   *
   * The roster gives the reactor far more heat than the generator can take, so
   * the generator is never starved: with a reactor only as large as the
   * generator's authored intake, a x2.5 intake bonus buys nothing at all and
   * every case below would read as 1.0.
   */
  const singularity = getAnomaly("singularity_isolation");
  const roster = basicRoster({
    reactorValue: 500,
    coolerValue: 200,
    dpValue: 120,
    dpWasteRatio: 0.2,
  });
  const CODES: Record<string, EffectiveBuilding> = {
    r: roster[0],
    g: roster[1],
    c: roster[2],
    d: roster[3],
  };

  /** A 7x5 board of grass walled in by rock, so no tile of it is on an edge. */
  const BOARD = [
    "RRRRRRR",
    "RGGGGGR",
    "RGGGGGR",
    "RGGGGGR",
    "RRRRRRR",
  ];

  /**
   * Scores `spec` — `[x, y, code]` in board coordinates — and returns each
   * building's own power, keyed "x,y". Run twice per case, under the anomaly
   * and under none, so what is compared is one layout against itself.
   */
  const powers = (spec: [number, number, string][], anomaly = singularity) => {
    const ctx = buildIslandContext(makeGrid(BOARD), undefined, anomaly);
    const at = new Map<string, number>();
    for (let t = 0; t < ctx.n; t++) at.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);

    const placement: Placement = new Array(ctx.n).fill(null);
    for (const [x, y, code] of spec) placement[at.get(`${x},${y}`)!] = CODES[code];

    const out = new Map<string, number>();
    for (const row of simulateIsland(placement, ctx, true).placements)
      out.set(`${row.x},${row.y}`, row.powerGenerated);
    return out;
  };

  it("rates a generator with no generator beside it at the bonus", () => {
    const spec: [number, number, string][] = [
      [1, 1, "r"],
      [2, 1, "g"],
      [3, 1, "c"],
    ];

    const base = powers(spec, getAnomaly("none")).get("2,1")!;
    expect(base).toBeGreaterThan(0);
    expect(powers(spec).get("2,1")).toBeCloseTo(base * 2.5, 6);
  });

  it("penalises both generators the moment they touch", () => {
    // Two generators side by side, each with its own reactor and cooler. The
    // rule is mutual and two-way, so both drop together.
    const spec: [number, number, string][] = [
      [1, 1, "r"],
      [2, 1, "g"],
      [3, 1, "g"],
      [4, 1, "r"],
      [2, 2, "c"],
      [3, 2, "c"],
    ];

    const base = powers(spec, getAnomaly("none"));
    const crowded = powers(spec);

    expect(base.get("2,1")).toBeGreaterThan(0);
    expect(crowded.get("2,1")).toBeCloseTo(base.get("2,1")! * 0.8, 6);
    expect(crowded.get("3,1")).toBeCloseTo(base.get("3,1")! * 0.8, 6);
  });

  it("costs no more for a second neighbour than for the first", () => {
    // Three generators in a row, each with a reactor above it and a cooler
    // below. The middle one touches two generators and the outer ones touch
    // one; all three take exactly x0.8 — the rule is a test, not a count.
    const spec: [number, number, string][] = [
      [2, 1, "r"],
      [3, 1, "r"],
      [4, 1, "r"],
      [2, 2, "g"],
      [3, 2, "g"],
      [4, 2, "g"],
      [2, 3, "c"],
      [3, 3, "c"],
      [4, 3, "c"],
    ];

    const base = powers(spec, getAnomaly("none"));
    const crowded = powers(spec);

    for (const key of ["2,2", "3,2", "4,2"]) {
      expect(base.get(key)).toBeGreaterThan(0);
      expect(crowded.get(key), key).toBeCloseTo(base.get(key)! * 0.8, 6);
    }
  });

  it("does not let a direct producer trigger the penalty", () => {
    /*
     * A wind turbine is a power source and not a Generator, so a generator
     * beside one keeps its bonus — and takes none itself. Modelled by the roles
     * the buildings are rather than by the catalogue's grouping, which files
     * turbines with the reactors.
     */
    const spec: [number, number, string][] = [
      [1, 1, "r"],
      [2, 1, "g"],
      [3, 1, "d"],
      [2, 2, "c"],
      [3, 2, "c"],
    ];

    const base = powers(spec, getAnomaly("none"));
    const under = powers(spec);

    expect(under.get("2,1")).toBeCloseTo(base.get("2,1")! * 2.5, 6);
    // And the turbine beside it is rated exactly as authored.
    expect(under.get("3,1")).toBeCloseTo(base.get("3,1")!, 6);
  });

  it("leaves coolers and reactors alone however tightly they are packed", () => {
    const spec: [number, number, string][] = [
      [1, 1, "d"],
      [2, 1, "d"],
      [1, 2, "c"],
      [2, 2, "c"],
    ];

    const base = powers(spec, getAnomaly("none"));
    const under = powers(spec);

    for (const key of ["1,1", "2,1"]) {
      expect(base.get(key)).toBeGreaterThan(0);
      expect(under.get(key), key).toBeCloseTo(base.get(key)!, 6);
    }
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

  it("reports a power the same layout re-rates to", async () => {
    /*
     * The agreement between the solver and everything that reads its output.
     * A solve returns placements naming a building and an authored tier; the
     * app rebuilds them with `effectiveAtValue` and rates each for its tile, so
     * if that round trip does not land on the figure the solver reported, the
     * board and the panel describing it disagree — and under a terrain bonus
     * the gap is 67% on every shore tile rather than a rounding.
     */
    const roster = basicRoster({ dpValue: 120, dpWasteRatio: 0.2 });
    const island = splitGridIntoIslands(
      makeGrid(["GGGGGG", "GGGGGG", "GGGGGG"]),
      true,
      tidal,
    )[0];
    const ctx = buildIslandContext(
      island.grid,
      island.buildable,
      tidal,
      island.waterAdjacent,
    );
    const byId = new Map(roster.map((b) => [b.id, b]));

    const solution = await solveIsland(island, roster, 0.5, undefined, 11, tidal);
    expect(solution.placements.length).toBeGreaterThan(0);

    // Tile index by the island-local coordinates the report carries.
    const tileAt = new Map<string, number>();
    for (let t = 0; t < ctx.n; t++) tileAt.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);

    // Rebuild the reported layout the way the app does — every building rated
    // for the tile it sits on — and score it.
    const rebuilt: Placement = new Array(ctx.n).fill(null);
    for (const p of solution.placements) {
      const tile = tileAt.get(`${p.x},${p.y}`)!;
      rebuilt[tile] = ctx.rate(tile, byId.get(p.buildingId)!);
    }

    expect(simulateIsland(rebuilt, ctx).totalPower).toBeCloseTo(
      solution.powerOutput,
      6,
    );
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
