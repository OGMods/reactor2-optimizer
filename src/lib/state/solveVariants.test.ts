/**
 * The shortlist of equal-power layouts, as the app keeps it: what a re-run
 * does to it, and what survives a reload.
 *
 * The solver's half of this is pinned in `solver/alternates.test.ts` — that
 * one run comes back with several boards at the same power. This is the other
 * half: pooling them across runs, remembering which one the user picked, and
 * getting them back from storage without keeping ten scored boards in it.
 *
 * An app rule, like `solvePersistence.test.ts` — the Python reference solves
 * for one layout and has nothing to say about any of it.
 */
import { beforeEach, describe, expect, it } from "vitest";
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
const { solverState, chooseSolveVariants } = await import("./solver.svelte");
const { solverStorage } = await import("../storage/storage");
const { SolverWorkerClient } = await import("../worker/workerClient");

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

  it("never grows past the limit", () => {
    const held = Array.from({ length: 8 }, (_, i) => spread(500, i));
    const fresh = Array.from({ length: 8 }, (_, i) => spread(500, i + 8));
    expect(chooseSolveVariants(held, 0, fresh, 10).variants).toHaveLength(10);
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
});
