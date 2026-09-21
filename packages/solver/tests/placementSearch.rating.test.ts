/**
 * The search in a tile's own units.
 *
 * A placement holds RATED buildings — what a tile is worth under the anomaly in
 * force — while the roster, the candidate lists and the composition targets are
 * all the plain figures the player owns. Every case here is a place where the two
 * met and the comparison was made in the wrong one, and every one of them failed
 * silently: no number moved, nothing threw, and the only symptom was a search
 * that quietly did less than it says it does.
 *
 * They are gathered in one file because they are one mistake made four times, and
 * because none of them is visible at baseline: `ctx.rate` is the identity there
 * and `baseValue === effectiveValue`, so a test written without an anomaly passes
 * under either reading.
 *
 * `simulateIsland` is mocked as a pass-through spy so one case can count
 * evaluations. It calls the real implementation, so no number in this file comes
 * from the mock.
 */
import { describe, expect, it, vi } from "vitest";
import { getAnomaly } from "../src/data/anomalies";
import { buildIslandContext, type IslandContext } from "../src/solver/context";
import { EPS } from "../src/solver/constants";
import { makeGrid } from "../src/grid";
import { Pacer } from "../src/solver/pacer";
import { downgradeOversized, internals } from "../src/solver/placementSearch";
import { simulateIsland } from "../src/solver/simulate";
import { generator, reactor, cooler, basicRoster } from "./helpers";
import type { EffectiveBuilding, Placement } from "../src/solver/types";

vi.mock("../src/solver/simulate", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/solver/simulate")>();
  return { ...real, simulateIsland: vi.fn(real.simulateIsland) };
});

const tidal = getAnomaly("tidal_ascendancy");
const singularity = getAnomaly("singularity_isolation");

/**
 * Two hubs' worth of grass, one on the board's edge and one walled in by rock,
 * so the island is deliberately NOT uniformly rated: the top row is shore (off
 * the board is water) and the bottom row is inland.
 */
const MIXED_SHORE = ["GGGRR", "RRRRR", "RRRRR", "RGGGR", "RRRRR"];

function tileAt(ctx: IslandContext, x: number, y: number): number {
  for (let t = 0; t < ctx.n; t++) {
    if (ctx.xs[t] === x && ctx.ys[t] === y) return t;
  }
  throw new Error(`no buildable tile at ${x},${y}`);
}

/** Places `spec` — `[x, y, building]` in board coordinates — rated for its tile. */
function ratedPlacement(
  ctx: IslandContext,
  spec: readonly [number, number, EffectiveBuilding][],
): Placement {
  const placement: Placement = new Array<EffectiveBuilding | null>(ctx.n).fill(
    null,
  );
  for (const [x, y, building] of spec) {
    const tile = tileAt(ctx, x, y);
    placement[tile] = ctx.rate(tile, building);
  }
  return placement;
}

describe("a report row's two capacity figures", () => {
  it("states the rating the tile ran at beside the authored tier", () => {
    /*
     * `baseValue` identifies the tier and must stay authored — a scaled one
     * resolves to a HIGHER tier and gets scaled a second time. So the figure the
     * row's own numbers were measured against has to be carried separately, and
     * the walk's "under-fed reactor" move is what needs it: `heatProduced` is
     * what the distribution sent, capped by the tile's RATING.
     *
     * A shore reactor rated 167 feeding a generator that can only take 100.2 is
     * under-fed by a third — and sits ABOVE its authored 100, so the move's
     * predicate read against `baseValue` never fires. Under a x5 research the
     * same reactor has to fall below 20% fill before the walk notices it.
     */
    const [R, G, C] = basicRoster({
      reactorValue: 100,
      generatorValue: 60,
      coolerValue: 25,
    });
    const ctx = buildIslandContext(makeGrid(["GGG"]), undefined, tidal);
    const rows = simulateIsland(
      ratedPlacement(ctx, [
        [0, 0, R],
        [1, 0, G],
        [2, 0, C],
      ]),
      ctx,
    ).placements;

    const reactorRow = rows.find((r) => r.buildingId === R.id)!;
    expect(reactorRow.baseValue).toBe(100);
    expect(reactorRow.ratedValue).toBe(167);
    expect(reactorRow.heatProduced).toBeCloseTo(100.2, 9);

    // The move fires on the rating...
    expect(internals.isUnderFed(reactorRow)).toBe(true);
    // ...and would not have on the authored value, which is the whole bug: this
    // reactor is a third short of what its tile can carry and still above the
    // tier it was authored at.
    expect(reactorRow.heatProduced).toBeGreaterThan(reactorRow.baseValue);
  });

  it("states the same figure twice where nothing is scaled", () => {
    const [R, G, C] = basicRoster({ coolerValue: 25 });
    const ctx = buildIslandContext(makeGrid(["GGG"]));
    for (const row of simulateIsland(
      ratedPlacement(ctx, [
        [0, 0, R],
        [1, 0, G],
        [2, 0, C],
      ]),
      ctx,
    ).placements) {
      expect(row.ratedValue, row.buildingId).toBe(row.baseValue);
    }
  });
});

describe("the island's rating ceiling", () => {
  /*
   * What makes a plain-roster ceiling comparable to a rated layout's power. It is
   * one number for the island, the same move `estimateTotalMaxPower` makes to
   * keep its bound a bound.
   */
  const { islandRatingCeiling, targetCompositions } = internals;
  const probes = basicRoster({ coolerValue: 25 });

  it("is exactly one under the rules that leave the roster alone", () => {
    for (const anomaly of [getAnomaly("none"), getAnomaly("cryo_nexus")]) {
      const ctx = buildIslandContext(makeGrid(["GGG"]), undefined, anomaly);
      // Cryo's 0.88 only ever costs cooling, so it cannot lift a ceiling.
      expect(islandRatingCeiling(ctx, probes), anomaly.id).toBe(1);
    }
  });

  it("is the terrain multiplier where any tile of the island qualifies", () => {
    expect(
      islandRatingCeiling(
        buildIslandContext(makeGrid(MIXED_SHORE), undefined, tidal),
        probes,
      ),
    ).toBeCloseTo(1.67, 9);
    // ...and one where none of it does: walled in, well away from the board.
    expect(
      islandRatingCeiling(
        buildIslandContext(
          makeGrid(["RRRRR", "RGGGR", "RRRRR"]),
          undefined,
          tidal,
        ),
        probes,
      ),
    ).toBe(1);
  });

  it("allows both variants of a layout-resolved rule", () => {
    // Which one a tile gets is a function of the layout rather than the island,
    // and a search free to keep generators apart rates every one at the bonus.
    const ctx = buildIslandContext(makeGrid(["GGG"]), undefined, singularity);
    expect(islandRatingCeiling(ctx, probes)).toBeCloseTo(2.5, 9);
  });

  it("is what lets the composition retarget run on a rated layout at all", () => {
    /*
     * The regression, stated as the decision rather than as a power figure, so
     * it does not depend on a budget.
     *
     * A target is scored from the plain roster while `bestPower` is a rated
     * layout's. On this island the best 6-tile composition scores 150 unscaled,
     * and two hubs — one on the shore, one inland — are already worth 200.25. The
     * gate is a `break`, so read as-is the FIRST target ends the stage and every
     * arrangement it would have tried is lost: the one stage that exists to cover
     * seeding's blind spot, gone under the anomaly that most needs it.
     *
     * Scaled by the ceiling the same target reads 250.5, which is above the
     * layout in hand, and the stage runs.
     */
    const roster = basicRoster({ coolerValue: 25 });
    const [R, G, C] = roster;
    const ctx = buildIslandContext(makeGrid(MIXED_SHORE), undefined, tidal);
    const power = simulateIsland(
      ratedPlacement(ctx, [
        [0, 0, R],
        [1, 0, G],
        [2, 0, C],
        [1, 3, R],
        [2, 3, G],
        [3, 3, C],
      ]),
      ctx,
    ).totalPower;
    const top = targetCompositions(ctx.n, [R], [G], [C])[0];
    const ceiling = islandRatingCeiling(ctx, roster);

    expect(power).toBeCloseTo(200.25, 9);
    expect(top.power).toBeCloseTo(150, 9);
    // As scored, the target is behind a layout the search has already reached, so
    // read in the roster's units the stage breaks out on its first entry...
    expect(top.power).toBeLessThan(power + EPS);
    expect(internals.targetCanBeat(top, power, 1)).toBe(false);
    // ...and in the layout's units it is ahead of it, so the stage runs.
    expect(internals.targetCanBeat(top, power, ceiling)).toBe(true);
  });
});

describe("a move that would write a tile what it already holds", () => {
  it("is skipped on a rated tile, not simulated", async () => {
    /*
     * `greedyPolish` is the deterministic one of the six sites, so it is where
     * this is counted. Its candidate list is the plain roster and the tiles hold
     * rated buildings, so `building === held` is never true on a scaled tile: the
     * sweep writes back an identical object and pays a full `simulateIsland` for
     * it, once per tile per sweep, in a stage whose only product is steps per
     * second.
     *
     * The layout is one hub on an all-shore island, already the best arrangement
     * of it, so exactly one sweep runs and the arithmetic is exact: one
     * evaluation on entry, then one per (tile, candidate) pair that is not the
     * building the tile is already running — 3 x (4 - 1). Without the fix it is
     * 3 x 4.
     */
    const [R, G, C] = basicRoster({ coolerValue: 25 });
    const candidates: (EffectiveBuilding | null)[] = [R, G, C, null];
    const ctx = buildIslandContext(makeGrid(["GGG"]), undefined, tidal);
    const placement = ratedPlacement(ctx, [
      [0, 0, R],
      [1, 0, G],
      [2, 0, C],
    ]);

    const spy = vi.mocked(simulateIsland);
    spy.mockClear();
    const polished = await internals.greedyPolish(
      placement,
      ctx,
      candidates,
      performance.now() + 5_000,
      new Pacer(),
    );

    expect(polished.power).toBeCloseTo(125.25, 9);
    expect(spy.mock.calls.length).toBe(1 + ctx.n * (candidates.length - 1));
  });

  it("is still skipped where nothing is rated", async () => {
    // The same count at baseline, where `held` IS the roster entry: the guard has
    // to be the old one plus the rating, never a different one.
    const [R, G, C] = basicRoster({ coolerValue: 25 });
    const candidates: (EffectiveBuilding | null)[] = [R, G, C, null];
    const ctx = buildIslandContext(makeGrid(["GGG"]));
    const placement = ratedPlacement(ctx, [
      [0, 0, R],
      [1, 0, G],
      [2, 0, C],
    ]);

    const spy = vi.mocked(simulateIsland);
    spy.mockClear();
    await internals.greedyPolish(
      placement,
      ctx,
      candidates,
      performance.now() + 5_000,
      new Pacer(),
    );

    expect(spy.mock.calls.length).toBe(1 + ctx.n * (candidates.length - 1));
  });
});

describe("right-sizing a layout whose ratings come from its own shape", () => {
  /*
   * `role_isolation` is the one rule `ctx.rate` cannot answer: a generator's
   * multiplier is a function of what its neighbours ARE, so `simulateIsland`
   * resolves it per layout. Right-sizing measures a load that came off one of
   * those rows against a candidate from the plain roster, and the two are three
   * halves apart.
   */
  const REACTOR = reactor(300);
  const GEN_S = generator(120, "gen_s");
  const GEN_L = generator(320, "gen_l");
  const COOLER = cooler(200);
  const roster = [REACTOR, GEN_S, GEN_L, COOLER];

  it("hands back the capacity an isolated generator never uses", () => {
    /*
     * A lone generator is rated x2.5, so the authored 320 tile is running at 800
     * and absorbing 300 of it. The smallest tier that covers that load is the
     * authored 120 — rated 300, exactly enough — and at the same power, because a
     * generator's energy scales with how full it is: 0.75 x 800 x 0.375 is 0.75 x
     * 300 x 1. Compared in the roster's units instead, 120 does not cover 300 and
     * the pass leaves 500 of intake the player paid for and nothing uses.
     *
     * The worked example one step up is NOT a downgrade and must not become one:
     * the same tile absorbing 700 keeps the 320, since 120 rated 300 cannot carry
     * it.
     */
    const ctx = buildIslandContext(makeGrid(["GGG"]), undefined, singularity);
    const placement = ratedPlacement(ctx, [
      [0, 0, REACTOR],
      [1, 0, GEN_L],
      [2, 0, COOLER],
    ]);
    const before = simulateIsland(placement, ctx);
    const generatorRow = before.placements.find(
      (r) => r.buildingId === GEN_L.id,
    )!;
    expect(generatorRow.ratedValue).toBeCloseTo(800, 9);
    expect(generatorRow.heatConsumed).toBeCloseTo(300, 9);

    const after = downgradeOversized(
      before.placements,
      before.totalPower,
      roster,
      ctx,
    );

    expect(
      after.rows.find((r) => r.x === 1)!.buildingId,
      "the isolated generator kept a tier it runs at 37.5% of",
    ).toBe(GEN_S.id);
    // The pass re-tiers and nothing else: same power, same occupied tiles.
    expect(after.power).toBeCloseTo(before.totalPower, 9);
    expect(after.rows.length).toBe(before.placements.length);
  });

  it("leaves a crowded generator a tier that carries its penalised load", () => {
    /*
     * The other direction. Two generators touching are rated x0.8, so a candidate
     * that covers the load in the roster's units may not cover it at all once
     * rated — and this pass is not allowed to cost power. The guard is the
     * re-simulation, which is why nothing was ever WRONG here; the assertion is
     * the property the pass sells, stated in the units the layout is rated in.
     */
    const ctx = buildIslandContext(
      makeGrid(["GGGG", "GGGG"]),
      undefined,
      singularity,
    );
    const placement = ratedPlacement(ctx, [
      [0, 0, REACTOR],
      [1, 0, GEN_L],
      [2, 0, GEN_L],
      [3, 0, REACTOR],
      [1, 1, COOLER],
      [2, 1, COOLER],
    ]);
    const before = simulateIsland(placement, ctx);
    const after = downgradeOversized(
      before.placements,
      before.totalPower,
      roster,
      ctx,
    );

    expect(after.power).toBeGreaterThanOrEqual(before.totalPower - EPS);
    const byId = new Map(roster.map((b) => [b.id, b]));
    for (const row of after.rows) {
      expect(
        row.ratedValue,
        `${row.buildingId} at (${row.x},${row.y}) cannot carry its own load`,
      ).toBeGreaterThanOrEqual(
        internals.tileLoad(byId.get(row.buildingId)!, row) - 1e-9,
      );
    }
  });
});

describe("every building a seed writes", () => {
  it("is already rated for the tile it landed on", () => {
    /*
     * The deterministic guard for the class of bug that had to be fixed by hand
     * once: a write that went straight to the placement array instead of through
     * `put()`, leaving a roster entry on a tile that rates above it.
     *
     * Stated over the seed rather than over a finished layout on purpose. The
     * round-trip test in `anomalies.test.ts` can only fail if an unrated write
     * survives seeding, repair, annealing, pruning and right-sizing into the
     * layout that is returned — so it depends on the budget, on the roster's
     * shape (a multi-tier roster hands `downgradeOversized` the chance to rewrite
     * the tile) and on which stages happened to run. This depends on none of
     * them: `ctx.rate` is idempotent, so a correctly rated tile is a fixed point
     * of it and an unrated one is not.
     *
     * The island is deliberately mixed — a shore hub and an inland one — so a
     * seed that scaled every tile by the same factor, or none, fails too.
     */
    const roster = basicRoster({ coolerValue: 25, dpValue: 120 });
    const [R, G, C, D] = roster;
    const ctx = buildIslandContext(makeGrid(MIXED_SHORE), undefined, tidal);
    expect(ctx.uniformRating, "the case this is here for").toBe(false);

    const seed = internals.constructMultiStartSeed(
      ctx,
      [R],
      [G],
      [C],
      [D],
      performance.now() + 2_000,
    );

    let onScaledTiles = 0;
    for (let t = 0; t < ctx.n; t++) {
      const building = seed[t];
      if (building === null) continue;
      // A tile whose rating is the identity cannot tell a rated write from an
      // unrated one, so count the ones that can.
      if (ctx.rate(t, R) !== R) onScaledTiles++;
      expect(
        ctx.rate(t, building),
        `${building.id} at (${ctx.xs[t]},${ctx.ys[t]}) is not rated for its tile`,
      ).toBe(building);
    }

    expect(
      onScaledTiles,
      "a seed that filled only the inland hub would pass vacuously",
    ).toBeGreaterThan(0);
  });
});
