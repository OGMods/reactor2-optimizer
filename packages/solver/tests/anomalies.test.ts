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
import { BUILDINGS } from "../src/data/buildings";
import {
  getEffectiveBuildings,
  scaleEffectiveBuilding,
} from "../src/data/effectiveBuildings";
import { prestigeScales } from "../src/data/prestige";
import { wasteIsCovered } from "../src/solver/physics";
import { buildIslandContext, type IslandContext } from "../src/solver/context";
import { EPS } from "../src/solver/constants";
import { simulateIsland } from "../src/solver/simulate";
import { makeGrid } from "../src/grid";
import {
  canCoolDirectProducer,
  estimateTotalMaxPower,
  splitGridIntoIslands,
} from "../src/solver/island";
import { solveIsland } from "../src/solver/placementSearch";
import { basicCatalogue, basicRoster, cooler } from "./helpers";
import type {
  AnomalyDefinition,
  EffectiveBuilding,
  IslandSubGrid,
  Placement,
  RoleIsolationAnomaly,
} from "../src/solver/types";

/*
 * A generator whose figures part company under the shipped x1.67: the pair
 * scales to 167 and 100 x 1.67 is 167.00000000000003, so a test on it can tell
 * a derived waste from a scaled one. `scaleEffectiveBuilding`'s own file pins
 * that against the real catalogue; this fixture is here so the cases below,
 * which are about the other three figures, cannot pass under the rule this one
 * replaced.
 */
const generator: EffectiveBuilding = {
  id: "gen",
  type: "generator",
  effectiveValue: 100,
  energy: 70,
  waste: 30,
  baseValue: 100,
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
  /*
   * `baseValue` staying authored and the by-reference identity at a factor of
   * one are pinned in `scaling.test.ts`, which is the file dedicated to this
   * function and states them against the shipped catalogue. What is here is the
   * half the anomalies care about: that a bonus reaches every figure a role has,
   * so it is never free power.
   */

  it("scales the pair and derives waste from it, rather than scaling waste", () => {
    /*
     * The contract that replaced "scales all three figures by the same factor".
     * Waste is the game's runtime getter over the scaled pair —
     * `snapToAuthoredPrecision(heat - energy)` — not the authored waste put
     * through the same multiply, and the two disagree in the last digit where
     * the fixtures assert exactly.
     *
     * The old test survived the change only because its fixture happened to
     * satisfy `waste === snap(heat - energy)` at its chosen factor, so it read
     * as a statement about scaling and could not fail if scaling came back.
     */
    const scaled = scaleEffectiveBuilding(generator, 1.67);

    expect(scaled.effectiveValue).toBe(167);
    expect(scaled.energy).toBeCloseTo(116.9, 9);
    expect(scaled.waste).toBe(50.1);
    // Scaling the authored waste instead gives 50.099999999999994.
    expect(scaled.waste).not.toBe(generator.waste * 1.67);
    // And the authored tier value never moves, whatever the factor.
    expect(scaled.baseValue).toBe(100);
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

describe("a shared cooling pool reaching the board", () => {
  /*
   * The one rule that reaches across the whole board rather than a tile or a
   * neighbourhood. Two halves: every cooler is re-rated x0.88 — the game
   * applies that to `CoolingPerSec`, so it is what a cooler is worth — and the
   * cooling half of the distribution is replaced by one pool that ignores
   * adjacency entirely.
   */
  const cryo = getAnomaly("cryo_nexus");
  // A cooler deliberately smaller than two generators' waste, so "the pool
  // falls short" is a case these boards can actually reach: 30 x 0.88 is 26.4
  // against 25 of waste per generator.
  const roster = basicRoster({ reactorValue: 500, coolerValue: 30 });
  const [REACTOR, GENERATOR, COOLER] = roster;

  const ctxFor = (rows: string[], anomaly = cryo) =>
    buildIslandContext(makeGrid(rows), undefined, anomaly);

  /** Place `spec` — `[x, y, building]` — rating each for its tile. */
  const score = (
    ctx: ReturnType<typeof ctxFor>,
    spec: [number, number, EffectiveBuilding][],
  ) => {
    const at = new Map<string, number>();
    for (let t = 0; t < ctx.n; t++) at.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);
    const placement: Placement = new Array(ctx.n).fill(null);
    for (const [x, y, b] of spec) {
      const tile = at.get(`${x},${y}`)!;
      placement[tile] = ctx.rate(tile, b);
    }
    return simulateIsland(placement, ctx, true);
  };

  it("rates every cooler down, and nothing else", () => {
    const ctx = ctxFor(["RRRR", "RGGR", "RRRR"]);
    const tile = ctx.tiles[0];

    expect(ctx.rate(tile, COOLER).effectiveValue).toBeCloseTo(30 * 0.88, 9);
    // The authored tier is what identifies it and never moves.
    expect(ctx.rate(tile, COOLER).baseValue).toBe(30);
    expect(ctx.rate(tile, REACTOR)).toBe(REACTOR);
    expect(ctx.rate(tile, GENERATOR)).toBe(GENERATOR);
  });

  it("cools a producer no cooler is anywhere near", () => {
    /*
     * The rule itself. The cooler is five tiles from the generator and on the
     * far side of the board — under the base rules it reaches nothing and the
     * generator is offline; pooled, distance stops existing.
     */
    const rows = ["RRRRRRRR", "RGGGGGGR", "RRRRRRRR"];
    const spec: [number, number, EffectiveBuilding][] = [
      [1, 1, REACTOR],
      [2, 1, GENERATOR],
      [6, 1, COOLER],
    ];

    expect(score(ctxFor(rows, getAnomaly("none")), spec).totalPower).toBe(0);
    expect(score(ctxFor(rows), spec).totalPower).toBeGreaterThan(0);
  });

  it("runs the board or none of it, never part", () => {
    /*
     * Every source is served the same fraction of what it is owed, so a short
     * pool leaves all of them under their waste at once. There is no layout
     * where one cluster is sustainable and another is not.
     */
    const rows = ["RRRRRRRR", "RGGGGGGR", "RGGGGGGR", "RRRRRRRR"];

    // Two independent hubs, one cooler between them — enough for one.
    const short = score(ctxFor(rows), [
      [1, 1, REACTOR],
      [2, 1, GENERATOR],
      [5, 1, REACTOR],
      [6, 1, GENERATOR],
      [1, 2, COOLER],
    ]);
    expect(
      short.placements.filter((p) => p.powerGenerated > 0).length,
      "a short pool runs nothing at all",
    ).toBe(0);

    // A second cooler, still nowhere near either generator, covers the board.
    const covered = score(ctxFor(rows), [
      [1, 1, REACTOR],
      [2, 1, GENERATOR],
      [5, 1, REACTOR],
      [6, 1, GENERATOR],
      [1, 2, COOLER],
      [2, 2, COOLER],
    ]);
    expect(
      covered.placements.filter((p) => p.powerGenerated > 0).length,
      "and a sufficient one runs both hubs",
    ).toBe(2);
  });

  it("reports each cooler its share of the work the pool did", () => {
    // The game's own reporting rule: a cooler is credited with its share of
    // what the pool actually absorbed, not with its whole rating.
    const ctx = ctxFor(["RRRRRR", "RGGGGR", "RGGGGR", "RRRRRR"]);
    const out = score(ctx, [
      [1, 1, REACTOR],
      [2, 1, GENERATOR],
      [1, 2, COOLER],
      [2, 2, COOLER],
    ]);

    const waste = out.placements.reduce(
      (sum, p) => sum + p.wasteHeatGenerated,
      0,
    );
    const provided = out.placements.reduce(
      (sum, p) => sum + p.coolingProvided,
      0,
    );

    expect(waste).toBeGreaterThan(0);
    // The pool absorbed exactly the waste, and the two coolers split the
    // credit for it evenly, being the same tier.
    expect(provided).toBeCloseTo(waste, 6);
    const each = out.placements.filter((p) => p.coolingProvided > 0);
    expect(each.length).toBe(2);
    expect(each[0].coolingProvided).toBeCloseTo(each[1].coolingProvided, 6);
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
    // Both of these leave the roster exactly as authored: the baseline does
    // nothing, and role isolation is resolved per layout by `simulateIsland`
    // through `rateIsolated`, never by `rate`.
    for (const id of ["none", "singularity_isolation"]) {
      const ctx = contextFor(["GGGGG", "GGGGG"], getAnomaly(id));
      const base = cooler(100);
      expect(ctx.uniformRating, id).toBe(true);
      expect(ctx.rate(ctx.tiles[0], base), id).toBe(base);
    }
  });

  it("is not uniform under a shared cooling pool, which scales a role", () => {
    /*
     * `uniformRating` is the promise that `rate` is the identity, and it invites
     * a stage to skip the call — so it has to cover the role scale as well as
     * the per-tile one. It read `tileScale === null` once, which said "uniform"
     * while every cooler on the board was being rated x0.88: a stage taking the
     * invitation would have returned a layout 13.6% over-cooled on paper that
     * the game shuts down board-wide, with nothing failing.
     */
    const ctx = contextFor(["GGGGG", "GGGGG"], getAnomaly("cryo_nexus"));
    const base = cooler(100);

    expect(ctx.uniformRating).toBe(false);
    expect(ctx.rate(ctx.tiles[0], base).effectiveValue).toBeCloseTo(88, 9);
    // Only the cooler role, and the same answer on every tile.
    expect(ctx.rate(ctx.tiles[1], base)).toBe(ctx.rate(ctx.tiles[0], base));
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

describe("role isolation for a role that is not the generator", () => {
  /*
   * `simulateIsland` dispatches the rule over four role arms, and the shipped
   * table names only one of them: `singularity_isolation` is `role: "generator"`,
   * so three quarters of that dispatch runs nowhere in the suite and nowhere in
   * the app. A future entry naming coolers would pick the wrong tile list in
   * silence — a cooler rule applied to the generators rates every building on
   * the board, and the board simply comes back worth something else.
   *
   * `ANOMALIES` is hand-owned and must not gain a fake entry for a test, so the
   * definition is built here, as the mixed-terrain bound case does.
   */
  const ROSTER = basicRoster({
    reactorValue: 500,
    generatorValue: 100,
    coolerValue: 200,
    dpValue: 120,
    dpWasteRatio: 0.2,
  });
  const CODES: Record<string, EffectiveBuilding> = {
    r: ROSTER[0],
    g: ROSTER[1],
    c: ROSTER[2],
    d: ROSTER[3],
  };

  /** Singularity's own shape with the role swapped out, and nothing else. */
  const isolating = (
    role: EffectiveBuilding["type"],
  ): RoleIsolationAnomaly => ({
    ...(getAnomaly("singularity_isolation") as RoleIsolationAnomaly),
    role,
  });

  /** Each occupied tile's authored value and the value it was rated at. */
  const ratings = (
    spec: readonly [number, number, string][],
    anomaly: AnomalyDefinition,
  ) => {
    const ctx = buildIslandContext(
      makeGrid(["GGGGG", "GGGGG"]),
      undefined,
      anomaly,
    );
    const at = new Map<string, number>();
    for (let t = 0; t < ctx.n; t++) at.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);

    const placement: Placement = new Array(ctx.n).fill(null);
    for (const [x, y, code] of spec)
      placement[at.get(`${x},${y}`)!] = CODES[code];

    const out = new Map<string, { base: number; rated: number }>();
    for (const row of simulateIsland(placement, ctx, true).placements)
      out.set(`${row.x},${row.y}`, {
        base: row.baseValue,
        rated: row.ratedValue,
      });
    return out;
  };

  /*
   * The same picture per role: two of the isolated role touching at (0,0) and
   * (1,0), a third alone at (4,0), and a pair of some *other* role on the row
   * below as the control — it must come back rated exactly as authored, which is
   * what fails if the dispatch reads the wrong tile list.
   */
  const CASES: [EffectiveBuilding["type"], string, string][] = [
    ["cooler", "c", "g"],
    ["reactor", "r", "c"],
    ["direct_producer", "d", "c"],
  ];

  for (const [role, code, control] of CASES) {
    it(`rates a lone ${role} up and a touching pair down`, () => {
      const rated = ratings(
        [
          [0, 0, code],
          [1, 0, code],
          [4, 0, code],
          [0, 1, control],
          [1, 1, control],
        ],
        isolating(role),
      );

      for (const key of ["0,0", "1,0"]) {
        const row = rated.get(key)!;
        expect(row.rated, `${key} touches another ${role}`).toBeCloseTo(
          row.base * 0.8,
          6,
        );
      }
      const lone = rated.get("4,0")!;
      expect(lone.rated, "three tiles from the nearest one").toBeCloseTo(
        lone.base * 2.5,
        6,
      );

      // The control pair, of a role the rule does not name: untouched however
      // tightly it is packed.
      for (const key of ["0,1", "1,1"]) {
        const row = rated.get(key)!;
        expect(row.rated, `${key} is a ${control}, not a ${role}`).toBe(
          row.base,
        );
      }
    });
  }
});

describe("one island context scoring one layout after another", () => {
  /*
   * `ctx.ratedLayout` is held by the island rather than allocated per call, so
   * every `simulateIsland` under a role-isolation rule writes into the same
   * buffer the last one left behind. Two things keep that honest today: the
   * whole board is copied in on entry, and the neighbour scan reads `placement`
   * rather than the buffer it is filling. Either alone is harmless; drop both —
   * narrow the copy to "the tiles this rule touches" and let the scan read the
   * buffer, which is the natural pair of optimisations — and a tile emptied
   * between two calls keeps the building the previous layout had there, which
   * changes what its *neighbours* are rated at.
   *
   * Nothing else in the suite runs two layouts through one context, and the leak
   * would be invisible: the report carries no row for the empty tile, so the
   * board looks right and is simply worth the wrong amount.
   */
  const singularity = getAnomaly("singularity_isolation");
  const [R, G, C] = basicRoster({
    reactorValue: 500,
    generatorValue: 100,
    coolerValue: 200,
  });

  const layoutOn = (
    ctx: IslandContext,
    spec: readonly [number, number, EffectiveBuilding][],
  ): Placement => {
    const at = new Map<string, number>();
    for (let t = 0; t < ctx.n; t++) at.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);
    const placement: Placement = new Array(ctx.n).fill(null);
    for (const [x, y, b] of spec) placement[at.get(`${x},${y}`)!] = b;
    return placement;
  };

  const CROWDED: [number, number, EffectiveBuilding][] = [
    [0, 0, R],
    [1, 0, G],
    [2, 0, G],
    [3, 0, R],
    [1, 1, C],
    [2, 1, C],
  ];
  // The same board with (2, 0) emptied, which leaves the generator at (1, 0)
  // with no generator beside it.
  const LONE = CROWDED.filter(([x, y]) => !(x === 2 && y === 0));

  it("forgets the building a tile held in the previous layout", () => {
    const board = makeGrid(["GGGG", "GGGG"]);
    const shared = buildIslandContext(board, undefined, singularity);

    // The crowded layout first, so the buffer holds a generator at (2, 0).
    const crowded = simulateIsland(layoutOn(shared, CROWDED), shared, true);
    expect(
      crowded.placements.find((r) => r.x === 1 && r.y === 0)!.ratedValue,
      "two generators touching",
    ).toBeCloseTo(80, 6);

    // Then the same board with that tile empty, through the same context.
    const lone = simulateIsland(layoutOn(shared, LONE), shared, true);
    const row = lone.placements.find((r) => r.x === 1 && r.y === 0)!;

    expect(row.ratedValue, "nothing beside it any more").toBeCloseTo(250, 6);
    expect(lone.placements.some((r) => r.x === 2 && r.y === 0)).toBe(false);

    // And the whole report is what a context that had never seen the first
    // layout produces — the property, rather than one figure off it.
    const fresh = buildIslandContext(board, undefined, singularity);
    const alone = simulateIsland(layoutOn(fresh, LONE), fresh, true);
    expect(lone.totalPower).toBe(alone.totalPower);
    expect(lone.placements).toEqual(alone.placements);
  });
});

describe("the search running under each rule", () => {
  /*
   * Every other `solveIsland` call in the suite is baseline or Tidal, so three of
   * the four rule shapes were searched nowhere. The hole that matters is not the
   * rule's arithmetic — the cases above cover that over hand-built layouts — but
   * the thread: `solveIsland` resolves its own context, and if the anomaly stopped
   * reaching `buildIslandContext` every solve under that rule would come back with
   * a layout rated under the base rules and a power figure to match, with only the
   * app's own scorer disagreeing.
   *
   * The assertions are properties rather than figures, because a stage deadline is
   * wall-clock and a searched power is not reproducible on CI: the layout the
   * search reports must score the same when rebuilt from the roster and rated for
   * its tiles, and must sit under the anomaly-aware bound.
   */
  const BOARD = ["GGGGGG", "GGGGGG", "GGGGGG"];

  /**
   * Searches `island` under `anomaly` and rebuilds what it returned the way the
   * app does — every building resolved from the roster and rated for the tile it
   * landed on — so the two powers can be compared.
   */
  const searchAndRebuild = async (
    island: IslandSubGrid,
    roster: EffectiveBuilding[],
    anomaly: AnomalyDefinition,
    rngSeed: number,
  ) => {
    const ctx = buildIslandContext(
      island.grid,
      island.buildable,
      anomaly,
      island.waterAdjacent,
    );
    const byId = new Map(roster.map((b) => [b.id, b]));
    const tileAt = new Map<string, number>();
    for (let t = 0; t < ctx.n; t++) tileAt.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);

    const solution = await solveIsland(
      island,
      roster,
      0.4,
      undefined,
      rngSeed,
      anomaly,
    );
    const rebuilt: Placement = new Array(ctx.n).fill(null);
    for (const p of solution.placements) {
      const tile = tileAt.get(`${p.x},${p.y}`)!;
      rebuilt[tile] = ctx.rate(tile, byId.get(p.buildingId)!);
    }

    // The same rebuilt layout scored under the base rules, so each case can say
    // the rule it names actually changes this board — a property test on a board
    // where the anomaly happens to be a no-op proves nothing.
    const plain = buildIslandContext(
      island.grid,
      island.buildable,
      undefined,
      island.waterAdjacent,
    );
    const unrated: Placement = new Array(plain.n).fill(null);
    for (const p of solution.placements) {
      const tile = tileAt.get(`${p.x},${p.y}`)!;
      unrated[tile] = byId.get(p.buildingId)!;
    }

    return {
      reported: solution.powerOutput,
      rebuilt: simulateIsland(rebuilt, ctx).totalPower,
      underBaseRules: simulateIsland(unrated, plain).totalPower,
      placed: solution.placements.length,
      bound: estimateTotalMaxPower([island], roster, anomaly),
    };
  };

  it("threads a shared cooling pool into the layout it reports", async () => {
    /*
     * Pooling changes both halves of what a solve is worth: every cooler is
     * x0.88 and adjacency stops mattering. Drop the anomaly on the way into the
     * context and the search reports a figure about 13.6% over what the board is
     * actually worth, arranged for a rule it is not under.
     *
     * The board is handed over whole, as `wholeBoardIsland` does — that is what a
     * pool is defined over.
     */
    const cryo = getAnomaly("cryo_nexus");
    // A cooler tight against the generators' waste, so the x0.88 genuinely
    // binds and the pool has work to do.
    const roster = basicRoster({ reactorValue: 500, coolerValue: 30 });
    const [island] = splitGridIntoIslands(
      makeGrid(BOARD),
      canCoolDirectProducer(roster),
      cryo,
    );

    const out = await searchAndRebuild(island, roster, cryo, 4321);

    expect(out.placed).toBeGreaterThan(0);
    expect(out.reported).toBeGreaterThan(0);
    expect(out.reported).toBeCloseTo(out.rebuilt, 6);
    expect(out.reported).toBeLessThanOrEqual(out.bound + EPS);
    expect(
      out.reported,
      "the rule has to change this board, or the round trip is vacuous",
    ).not.toBeCloseTo(out.underBaseRules, 6);
  });

  it("threads role isolation into the layout it reports", async () => {
    /*
     * The rule the search has to act on rather than merely be rated by: a
     * generator's multiplier is a function of what its neighbours are, so the
     * search's job under it is mostly to keep generators apart. The roster is
     * generator-bound on purpose, so an isolated generator is genuinely worth
     * more and the rule is not power-neutral here.
     */
    const singularity = getAnomaly("singularity_isolation");
    const roster = basicRoster({
      reactorValue: 500,
      generatorValue: 40,
      coolerValue: 200,
    });
    const [island] = splitGridIntoIslands(
      makeGrid(BOARD),
      canCoolDirectProducer(roster),
      singularity,
    );

    const out = await searchAndRebuild(island, roster, singularity, 4321);

    expect(out.placed).toBeGreaterThan(0);
    expect(out.reported).toBeGreaterThan(0);
    expect(out.reported).toBeCloseTo(out.rebuilt, 6);
    expect(out.reported).toBeLessThanOrEqual(out.bound + EPS);
    expect(
      out.reported,
      "the rule has to change this board, or the round trip is vacuous",
    ).not.toBeCloseTo(out.underBaseRules, 6);
  });

  it("searches a roster the Time Lab has already scaled", async () => {
    /*
     * Research reaches the search only through the roster —
     * `getEffectiveBuildings` folds it in and nothing below that knows a Time Lab
     * exists — so a solve on a researched roster is a path nothing else here
     * walks. It is also the one place both multipliers meet on a board: Infinite
     * Grid at x5 on the generator and Absolute Zero at x5 on the cooler, and then
     * a shore bonus on top of both.
     */
    const tidal = getAnomaly("tidal_ascendancy");
    const { buildings, unlocks } = basicCatalogue();
    const roster = getEffectiveBuildings(
      buildings,
      unlocks,
      prestigeScales({ infinite_grid: 4, absolute_zero: 4 }),
    );
    expect(
      roster.map((b) => b.effectiveValue),
      "the reactor is untouched; the other two are x5",
    ).toEqual([100, 500, 500]);

    const [island] = splitGridIntoIslands(
      makeGrid(BOARD),
      canCoolDirectProducer(roster),
      tidal,
    );
    const out = await searchAndRebuild(island, roster, tidal, 4321);

    expect(out.placed).toBeGreaterThan(0);
    expect(out.reported).toBeGreaterThan(0);
    expect(out.reported).toBeCloseTo(out.rebuilt, 6);
    expect(out.reported).toBeLessThanOrEqual(out.bound + EPS);
    expect(
      out.reported,
      "the rule has to change this board, or the round trip is vacuous",
    ).not.toBeCloseTo(out.underBaseRules, 6);
  });

  it("rates a researched roster research-first, then the anomaly", () => {
    /*
     * The order the two arrive in, end to end and in the last bit. The game
     * applies the Time Lab in the ScriptableObject getter and the anomaly in the
     * runtime getter, which is the order these two layers happen to be in —
     * `getEffectiveBuildings` folds research into the roster and `ctx.rate`
     * scales what comes out — and it is not the same double as the other way
     * round: generator7's fourth tier under Infinite Grid maxed and then a Tidal
     * shore is 7.38975e22, against 7.389749999999999e22 reversed.
     *
     * `scaling.test.ts` pins the arithmetic; this pins that the production path
     * is that way round, which no test reached — `prestige.test.ts` never builds
     * a context, and every context test starts from an unresearched roster.
     */
    const tidal = getAnomaly("tidal_ascendancy");
    const [researched] = getEffectiveBuildings(
      BUILDINGS,
      { generator7: 3 },
      prestigeScales({ infinite_grid: 4 }),
    );
    expect(researched.effectiveValue).toBe(8.85e21 * 5);
    expect(researched.baseValue, "the tier it identifies as").toBe(8.85e21);

    // Bare grass, so every tile of it is on the board's edge and therefore
    // shore.
    const ctx = buildIslandContext(makeGrid(["GGG"]), undefined, tidal);
    const onShore = ctx.rate(ctx.tiles[0], researched);

    expect(onShore.effectiveValue).toBe(8.85e21 * 5 * 1.67);
    expect(onShore.effectiveValue).toBe(7.38975e22);
    // The anomaly first and the research second, which is the wrong way round.
    expect(onShore.effectiveValue).not.toBe(8.85e21 * 1.67 * 5);
    expect(onShore.baseValue).toBe(8.85e21);
  });
});
