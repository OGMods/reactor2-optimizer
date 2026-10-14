/**
 * The shortlist of equal-power layouts, as the app keeps it: what a re-run
 * does to it, and what survives a reload.
 *
 * The solver's half of this is pinned in `solver/alternates.test.ts` — that
 * one run comes back with several boards at the same power. This is the other
 * half: pooling them across runs, remembering which one the user picked, and
 * getting them back from storage without keeping ten scored boards in it.
 *
 * An app rule, like `solvePersistence.test.ts` — the engine solves
 * for one layout and has nothing to say about any of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptimizationResult, PlacedBuilding } from "../types";

// The storage helpers are SSR-guarded on `typeof window`, so a test running in
// node needs both a window and a localStorage before it imports anything that
// touches them.
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
};

const { layoutState } = await import("./layout.svelte");
const { solverState, chooseSolveVariants, composeIslandBests } =
  await import("./solver.svelte");
const { solverStorage } = await import("../storage/storage");
const { configState } = await import("./config.svelte");
const { SolverWorkerClient } = await import("../worker/workerClient");
const { simulatePlacedBuildings } = await import("../simulation/simulator");
const { createPlacementAtLevel } = await import("../data/placements");
const { BUILDINGS } = await import("@reactor2/solver");

function placed(buildingId: string, x: number, y: number): PlacedBuilding {
  return {
    x,
    y,
    buildingId,
    baseValue: 1,
    powerGenerated: 0,
    heatProduced: 0,
    heatConsumed: 0,
    wasteHeatGenerated: 0,
    coolingProvided: 0,
    coolingReceived: 0,
  };
}

/** A layout of one building at `x`, said to be worth `totalPower`. */
function result(totalPower: number, x: number): OptimizationResult {
  return {
    totalPower,
    placements: [placed("generator", x, 0)],
    activeTilesCount: 1,
    unusedTilesCount: 0,
    summary: {
      totalHeatProduced: 0,
      totalHeatConsumed: 0,
      totalWasteGenerated: 0,
      totalCoolingCapacity: 0,
    },
    theoreticalMaxPower: totalPower,
  };
}

/**
 * The same, spread over the `slot`th block of five tiles.
 *
 * Pooling holds a fresh layout to the solver's distance rule, so a run whose
 * board differs by one tile is the board already on screen. These are ten
 * tiles apart, which is what the cases below are about — except the one that
 * is about the rule.
 */
function spread(totalPower: number, slot: number): OptimizationResult {
  const base = result(totalPower, slot * 5);
  base.placements = [0, 1, 2, 3, 4].map((k) =>
    placed("generator", slot * 5 + k, 0),
  );
  base.activeTilesCount = 5;
  return base;
}

const at = (variants: OptimizationResult[]) =>
  variants.map((v) => v.placements[0].x / 5);

describe("what a finished run does to the shortlist", () => {
  it("stands on its own when there is nothing held", () => {
    const chosen = chooseSolveVariants([], 0, [spread(500, 0), spread(500, 1)]);
    expect(at(chosen.variants)).toEqual([0, 1]);
    expect(chosen.selected).toBe(0);
    expect(chosen.defended).toBe(false);
  });

  /*
   * The case the feature exists for: a second run at the same power is not a
   * duplicate of the first, it is more of the same answer. Held layouts stay
   * in front so the user's pick keeps its place, and the board does not jump
   * to something else under them.
   */
  it("pools a run that ties, keeping the layout being looked at", () => {
    const held = [spread(500, 0), spread(500, 1)];
    const chosen = chooseSolveVariants(held, 1, [
      spread(500, 2),
      spread(500, 0),
    ]);

    // The fresh run's second layout is one the shortlist already had.
    expect(at(chosen.variants)).toEqual([0, 1, 2]);
    expect(chosen.selected).toBe(1);
    expect(chosen.defended).toBe(false);
  });

  /*
   * Pooling runs is where near-copies pile up without this: every re-run at
   * the same power contributes its own version of the layout already on
   * screen, filling the shortlist with boards a player cannot tell apart.
   */
  it("turns away a fresh layout a tile from one already in the list", () => {
    const held = [spread(500, 0)];
    const nudged = spread(500, 0);
    nudged.placements[4] = placed("cooler1", 4, 0);

    const chosen = chooseSolveVariants(held, 0, [nudged, spread(500, 1)]);
    expect(at(chosen.variants)).toEqual([0, 1]);
    expect(chosen.selected).toBe(0);
  });

  it("replaces the shortlist outright when the run comes back higher", () => {
    const chosen = chooseSolveVariants([spread(500, 0)], 0, [spread(600, 1)]);
    expect(at(chosen.variants)).toEqual([1]);
    expect(chosen.selected).toBe(0);
  });

  it("lets the held layouts defend their place against a worse run", () => {
    const held = [spread(500, 0), spread(500, 1)];
    const chosen = chooseSolveVariants(held, 1, [spread(400, 2)]);
    expect(at(chosen.variants)).toEqual([0, 1]);
    expect(chosen.selected).toBe(1);
    expect(chosen.defended).toBe(true);
  });

  /*
   * The bar is the best layout held, not the one the user happens to be
   * previewing. A shortlist is level when a run produces it, but
   * `rescoreResult` re-rates fixed shapes at a new roster and can rank them
   * apart — and measuring against the previewed entry then let a run that beat
   * only *that* one throw the higher layouts away with it.
   */
  it("defends the best layout held, not the one being previewed", () => {
    const held = [spread(500, 0), spread(400, 1)];
    const chosen = chooseSolveVariants(held, 1, [spread(450, 2)]);
    expect(at(chosen.variants)).toEqual([0, 1]);
    expect(chosen.defended).toBe(true);
    // The selection stays where the user put it: defending is about not losing
    // layouts, not about moving the board out from under them.
    expect(chosen.selected).toBe(1);
  });

  it("clamps an index that outran the shortlist behind it", () => {
    const chosen = chooseSolveVariants([spread(500, 0)], 4, [spread(400, 1)]);
    expect(chosen.selected).toBe(0);
    expect(chosen.defended).toBe(true);
  });

  it("ranks by the figure it is handed, so a plan is judged after the plan", () => {
    // Under an upgrade plan the search maximises the power once the plan is
    // bought; today's figure is a side effect. A run lower today but higher
    // after the plan has to win, and one higher today but lower after has to
    // lose, or "keep the better one" defends against the wrong number.
    const after = new Map<OptimizationResult, number>();
    const held = result(100, 0);
    const fresh = result(80, 9);
    after.set(held, 150);
    after.set(fresh, 200);
    const rank = (r: OptimizationResult) => after.get(r) ?? 0;

    const won = chooseSolveVariants([held], 0, [fresh], 10, rank);
    expect(won.defended).toBe(false);
    expect(won.variants).toEqual([fresh]);

    after.set(fresh, 120);
    const lost = chooseSolveVariants([held], 0, [fresh], 10, rank);
    expect(lost.defended).toBe(true);
    expect(lost.variants).toEqual([held]);
  });

  it("never grows past the limit", () => {
    const held = Array.from({ length: 8 }, (_, i) => spread(500, i));
    const fresh = Array.from({ length: 8 }, (_, i) => spread(500, i + 8));
    expect(chooseSolveVariants(held, 0, fresh, 10).variants).toHaveLength(10);
  });
});

describe("taking each island's best across two runs", () => {
  /**
   * A board of two islands, x < 100 and x >= 100, worth `a` and `b`. `shape`
   * moves both islands' buildings, so boards of different shapes are distinct
   * layouts on each island separately.
   */
  function twoIslands(a: number, b: number, shape: number): OptimizationResult {
    const board = result(a + b, 0);
    const row = (x0: number, power: number) =>
      [0, 1, 2, 3, 4].map((k) => ({
        ...placed("generator", x0 + shape * 5 + k, 0),
        powerGenerated: k === 0 ? power : 0,
      }));
    board.placements = [...row(0, a), ...row(100, b)];
    return board;
  }
  const islandOf = (p: PlacedBuilding) => (p.x < 100 ? 0 : 1);
  const sum = (rows: PlacedBuilding[]) =>
    rows.reduce((s, p) => s + p.powerGenerated, 0);
  const shapeOf = (rows: PlacedBuilding[], island: number) =>
    (rows.filter((p) => islandOf(p) === island)[0].x - island * 100) / 5;

  /*
   * The case it exists for: the fresh run wins on the total by finding a
   * better large island, and would have taken a worse small one with it.
   */
  it("keeps the held island the fresh run did worse on", () => {
    const held = [twoIslands(100, 200, 0)];
    const fresh = [twoIslands(150, 180, 1)];
    const composed = composeIslandBests(held, fresh, islandOf, sum)!;

    expect(composed.map(sum)).toEqual([350]);
    expect(shapeOf(composed[0], 0)).toBe(1);
    expect(shapeOf(composed[0], 1)).toBe(0);
  });

  it("has nothing to add when one board already holds every best", () => {
    const held = [twoIslands(100, 200, 0)];
    expect(
      composeIslandBests(held, [twoIslands(150, 200, 1)], islandOf, sum),
    ).toBeNull();
    expect(
      composeIslandBests(held, [twoIslands(90, 190, 1)], islandOf, sum),
    ).toBeNull();
  });

  it("is never asked to merge when nothing is held", () => {
    expect(
      composeIslandBests([], [twoIslands(1, 2, 0)], islandOf, sum),
    ).toBeNull();
  });

  /*
   * Every layout is upgraded, so a tied alternate on the island it was
   * already best on survives as an alternate of the merged board.
   */
  it("upgrades the shortlist too, and drops the copies that makes", () => {
    const held = [twoIslands(100, 200, 0), twoIslands(100, 200, 2)];
    const fresh = [twoIslands(150, 180, 1), twoIslands(150, 180, 3)];
    const composed = composeIslandBests(held, fresh, islandOf, sum)!;

    // The fresh run's leader, upgraded, is the held leader upgraded: one board.
    expect(composed.map(sum)).toEqual([350, 350, 350]);
    expect(composed.map((c) => [shapeOf(c, 0), shapeOf(c, 1)])).toEqual([
      [1, 0],
      [1, 2],
      [3, 0],
    ]);
  });

  it("feeds a merge that beats both runs through as the new shortlist", () => {
    const held = [twoIslands(100, 200, 0)];
    const merged = composeIslandBests(
      held,
      [twoIslands(150, 180, 1)],
      islandOf,
      sum,
    )!.map((placements) => ({ ...result(sum(placements), 0), placements }));

    const chosen = chooseSolveVariants(held, 0, merged);
    expect(chosen.defended).toBe(false);
    expect(chosen.variants[0].totalPower).toBe(350);
  });
});

describe("a shortlist that survives a reload", () => {
  /** Where the buildings can actually go, so the re-score has something to do. */
  const grassAt = (n: number) => {
    const grass = layoutState.grid.flat().filter((t) => t.type === "grass");
    return grass[n % grass.length];
  };

  /** Stages a solve holding three layouts, with the middle one applied. */
  function stageShortlist() {
    const applied = result(500, grassAt(1).x);
    applied.placements[0].y = grassAt(1).y;

    solverStorage.saveSolve({
      templateId: layoutState.activeTemplateId,
      signature: solverState.solveSignature(),
      result: applied,
      variants: [0, 1, 2].map((i) => [
        ["generator", grassAt(i).x, grassAt(i).y, 1] as [
          string,
          number,
          number,
          number,
        ],
      ]),
      selectedVariant: 1,
      durationMs: 1234,
      finishedAt: Date.now(),
    });
  }

  beforeEach(async () => {
    store.clear();
    solverState.clearResult();
    await layoutState.hydrate({});
  });

  it("brings back every layout, and hangs the one that was applied", () => {
    stageShortlist();
    solverState.restore();

    expect(solverState.variantCount).toBe(3);
    expect(solverState.variantIndex).toBe(1);
    expect(solverState.appliedVariant).toBe(1);
    expect(solverState.optimizationResult?.totalPower).toBe(500);
    // Only the applied layout was stored scored; the others were bare shapes
    // and had to be re-scored on the way in.
    expect(solverState.variants[0].placements[0].x).toBe(grassAt(0).x);
    expect(solverState.variants[2].placements[0].x).toBe(grassAt(2).x);
  });

  it("restores a solve written before variants existed as a shortlist of one", () => {
    solverStorage.saveSolve({
      templateId: layoutState.activeTemplateId,
      signature: solverState.solveSignature(),
      result: result(500, grassAt(0).x),
      durationMs: 1234,
      finishedAt: Date.now(),
    });
    solverState.restore();

    expect(solverState.variantCount).toBe(1);
    expect(solverState.optimizationResult?.totalPower).toBe(500);
  });

  /*
   * Cycling is a preview and applying is the commitment. Thumbing through ten
   * layouts must not quietly overwrite the one already chosen — otherwise the
   * choice is made by wherever the user happened to stop.
   */
  it("cycles without writing, and writes when applied", () => {
    stageShortlist();
    solverState.restore();

    solverState.showVariant(solverState.variantIndex + 1);
    expect(solverState.variantIndex).toBe(2);
    expect(solverState.canApplyVariant).toBe(true);
    expect(
      solverStorage.loadSolve(layoutState.activeTemplateId)?.selectedVariant,
    ).toBe(1);

    solverState.applyVariant();
    expect(solverState.canApplyVariant).toBe(false);
    const saved = solverStorage.loadSolve(layoutState.activeTemplateId);
    expect(saved?.selectedVariant).toBe(2);
    // The applied one is the record's scored result, so a reload needs no
    // re-scoring to put it back on screen.
    expect(saved?.result.placements[0].x).toBe(grassAt(2).x);
  });

  it("wraps in both directions, because the shortlist is a ring", () => {
    stageShortlist();
    solverState.restore();

    solverState.showVariant(0);
    solverState.showVariant(-1);
    expect(solverState.variantIndex).toBe(2);
    solverState.showVariant(3);
    expect(solverState.variantIndex).toBe(0);
  });
});

/*
 * The same policy as the app actually reaches it: through `runOptimizer`, with
 * the worker pool stubbed out. What the block above pins is the decision; this
 * is the wiring around it — what gets captured before the panel starts
 * streaming, and what is left on screen when a run comes back with nothing.
 */
describe("what a re-run leaves on screen", () => {
  let fake: OptimizationResult[] = [];
  let fail = false;
  /** What the panel was showing at the moment a progress report landed. */
  let onScreenMidRun: number | null = null;

  (
    SolverWorkerClient.prototype as unknown as Record<string, unknown>
  ).solveProgressive = function (
    _grid: unknown,
    _buildings: unknown,
    _upgrades: unknown,
    onProgress?: (r: OptimizationResult) => void,
  ) {
    // Every run streams a near-empty board first, the way a search that has
    // only just started does.
    onProgress?.(spread(1, 8));
    onScreenMidRun = solverState.optimizationResult?.totalPower ?? null;
    return {
      promise: fail
        ? Promise.reject(new Error("worker died"))
        : Promise.resolve(fake),
      stop: () => {},
    };
  };

  beforeEach(async () => {
    store.clear();
    fail = false;
    onScreenMidRun = null;
    solverState.clearResult();
    await layoutState.hydrate({});
  });

  it("keeps the better layout when the run comes back lower", async () => {
    fake = [spread(500, 0)];
    await solverState.runOptimizer();
    expect(solverState.optimizationResult?.totalPower).toBe(500);

    fake = [spread(400, 1)];
    await solverState.runOptimizer({ keepBest: true });
    expect(solverState.optimizationResult?.totalPower).toBe(500);
  });

  it("keeps the shortlist when the user was previewing a lower layout", async () => {
    fake = [spread(500, 0), spread(400, 1)];
    await solverState.runOptimizer();
    solverState.showVariant(1);

    fake = [spread(450, 2)];
    await solverState.runOptimizer({ keepBest: true });
    expect(solverState.variants.map((v) => v.totalPower)).toContain(500);
  });

  /*
   * The defence has to hold for the *length* of the run, not only at the end
   * of it. A progress report is a search still moving and is well below what
   * it will finish at, so streamed over a layout the user asked to keep it
   * takes their board off the screen and draws a weaker one in its place until
   * the run lands — which reads as the promise being broken and then got
   * lucky. Only a snapshot that has actually beaten the bar is news about the
   * board rather than about a search.
   */
  it("does not stream a snapshot below the layout it is defending", async () => {
    fake = [spread(500, 0)];
    await solverState.runOptimizer();

    fake = [spread(400, 1)];
    await solverState.runOptimizer({ keepBest: true });
    expect(onScreenMidRun).toBe(500);
  });

  /* ...and with nothing to defend, the stream is the only thing there is. */
  it("streams freely when no layout is being kept", async () => {
    fake = [spread(500, 0)];
    await solverState.runOptimizer();
    expect(onScreenMidRun).toBe(1);
  });

  /*
   * The failure that made "keep the better one" look broken: the shortlist was
   * defended correctly, but the panel was still showing the snapshot the dead
   * run had streamed over it, so the card reported a fraction of the power.
   */
  it("puts the held layout back when a run produces nothing", async () => {
    fake = [spread(500, 0)];
    await solverState.runOptimizer();

    fail = true;
    await solverState.runOptimizer({ keepBest: true });
    expect(solverState.optimizationResult?.totalPower).toBe(500);
    expect(solverState.variants.map((v) => v.totalPower)).toEqual([500]);
  });

  /*
   * The merge as the app reaches it: two islands, each run winning one of
   * them, and real scoring on the way out — the composite is re-scored on the
   * board, so this is what proves it is a legal board worth the sum.
   */
  it("keeps the better of each island across the two runs", async () => {
    // Two three-tile islands, rows 0 and 4, with water between.
    layoutState.grid = ["GGG", "~~~", "~~~", "~~~", "GGG"].map((row, y) =>
      [...row].map((c, x) => ({
        x,
        y,
        type: c === "G" ? ("grass" as const) : ("water" as const),
      })),
    );
    /** A reactor, generator and cooler along row `y`, the reactor at `tier`. */
    const hub = (y: number, tier: number) => [
      createPlacementAtLevel("solar_panel", 0, y, tier),
      createPlacementAtLevel("generator", 1, y, 0),
      createPlacementAtLevel("cooler1", 2, y, 5),
    ];
    const board = (rows: PlacedBuilding[]): OptimizationResult => {
      const scored = simulatePlacedBuildings(layoutState.grid, BUILDINGS, rows);
      const power = scored.reduce((sum, p) => sum + p.powerGenerated, 0);
      return { ...result(power, 0), placements: scored };
    };
    const strong = board(hub(0, 5)).totalPower;
    const weak = board(hub(0, 0)).totalPower;
    expect(weak).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(weak);

    fake = [board([...hub(0, 5), ...hub(4, 0)])];
    await solverState.runOptimizer();
    // The two tie on the total, so the whole-board rules could only pool
    // them; neither board on its own has both strong islands.
    fake = [board([...hub(0, 0), ...hub(4, 5)])];
    await solverState.runOptimizer({ keepBest: true });

    expect(solverState.optimizationResult?.totalPower).toBeCloseTo(2 * strong);
  });

  describe("merging islands on a board that has moved on", () => {
    /** Two three-tile islands, rows 0 and 4, with water between. */
    const twoIslands = () =>
      ["GGG", "~~~", "~~~", "~~~", "GGG"].map((row, y) =>
        [...row].map((c, x) => ({
          x,
          y,
          type: c === "G" ? ("grass" as const) : ("water" as const),
        })),
      );
    /** A reactor, generator and cooler along row `y`. */
    const hub = (y: number) => [
      createPlacementAtLevel("solar_panel", 0, y, 5),
      createPlacementAtLevel("generator", 1, y, 0),
      createPlacementAtLevel("cooler1", 2, y, 5),
    ];
    /** The same row with no reactor, so nothing to convert: worth nothing. */
    const idle = (y: number) => [
      createPlacementAtLevel("generator", 1, y, 0),
      createPlacementAtLevel("cooler1", 2, y, 5),
    ];
    const board = (rows: PlacedBuilding[]): OptimizationResult => {
      const scored = simulatePlacedBuildings(layoutState.grid, BUILDINGS, rows);
      const power = scored.reduce((sum, p) => sum + p.powerGenerated, 0);
      return { ...result(power, 0), placements: scored };
    };
    const reactorRows = (v: OptimizationResult | null | undefined) =>
      (v?.placements ?? [])
        .filter((p) => p.buildingId === "solar_panel")
        .map((p) => p.y)
        .sort();

    let roster: Record<string, number> = {};
    beforeEach(() => {
      roster = { ...configState.buildingUpgrades };
      configState.lockAll();
      configState.setUpgradeLevel("solar_panel", 5);
      configState.setUpgradeLevel("generator", 0);
      configState.setUpgradeLevel("cooler1", 5);
      layoutState.grid = twoIslands();
    });
    afterEach(() => {
      while (configState.upgradePlan.length > 0) configState.removePlanStep(0);
      configState.lockAll();
      for (const [id, level] of Object.entries(roster))
        configState.setUpgradeLevel(id, level);
    });

    /*
     * Under a plan an island is judged by `evaluatePlan` on its placements
     * alone, so the merge leans on that figure adding up across islands. A
     * part-board it could not rate would read as zero and the merge would
     * never fire.
     */
    it("takes each island's best under an upgrade plan too", async () => {
      configState.addPlanStep("generator");
      expect(configState.hasPlan).toBe(true);

      fake = [board([...hub(0), ...idle(4)])];
      await solverState.runOptimizer();
      fake = [board([...idle(0), ...hub(4)])];
      await solverState.runOptimizer({ keepBest: true });

      expect(reactorRows(solverState.optimizationResult)).toEqual([0, 4]);
    });

    /*
     * A held layout is the board at its own run. Paint under one of its
     * buildings and that island is no longer something a new board can be
     * built from: the merge would carry the building on the rock across.
     *
     * The building painted over is a spare cooler, so losing it costs the held
     * island nothing — which is exactly when a merged board carrying it would
     * win and be kept.
     */
    it("does not take an island from a held layout the terrain has left", async () => {
      const wider = () => {
        const grid = twoIslands();
        grid[0].push({ x: 3, y: 0, type: "grass" });
        for (const row of grid.slice(1))
          row.push({ x: 3, y: row[0].y, type: "water" });
        return grid;
      };
      layoutState.grid = wider();
      const spare = createPlacementAtLevel("cooler1", 3, 0, 5);
      fake = [board([...hub(0), spare, ...idle(4)])];
      await solverState.runOptimizer();

      layoutState.grid = wider();
      layoutState.grid[0][3] = { x: 3, y: 0, type: "rock" };
      fake = [board([...idle(0), ...hub(4)])];
      await solverState.runOptimizer({ keepBest: true });

      for (const v of solverState.variants)
        expect(reactorRows(v)).not.toEqual([0, 4]);
    });
  });
});
