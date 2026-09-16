/**
 * The one rule that makes a persisted solve safe to re-hang on load: a stored
 * result is only ever shown for the board and roster it was computed against.
 *
 * A solve is expensive — up to five minutes — which is why it survives a
 * reload at all. That same expense is why it must not be shown over a board it
 * no longer describes: a layout that looks authoritative but was solved for
 * different terrain is worse than no layout, because nothing on screen says so.
 *
 * An app rule, like `terrainRules.test.ts` — the solver package knows nothing
 * about storage.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { OptimizationResult } from "../types";

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
const { solverState } = await import("./solver.svelte");
const { editorState } = await import("./editor.svelte");
const { solverStorage } = await import("../storage/storage");
const { isObstacleType } = await import("../types/grid");
const { ISLAND_TEMPLATES } = await import("@reactor2/solver");

/** A stand-in result: `restore()` only ever moves it around, never reads into it. */
function fakeResult(totalPower: number): OptimizationResult {
  return {
    totalPower,
    placements: [
      {
        x: 0,
        y: 0,
        buildingId: "generator",
        baseValue: 1,
        powerGenerated: totalPower,
        heatProduced: 0,
        heatConsumed: 1,
        wasteHeatGenerated: 0,
        coolingProvided: 0,
        coolingReceived: 0,
      },
    ],
    activeTilesCount: 1,
    unusedTilesCount: 0,
    summary: {
      totalHeatProduced: 0,
      totalHeatConsumed: 1,
      totalWasteGenerated: 0,
      totalCoolingCapacity: 0,
    },
    theoreticalMaxPower: totalPower,
  };
}

/** Stages a finished solve in storage, stamped for the board as it is now. */
function stageSolve(result: OptimizationResult, durationMs = 1234) {
  solverStorage.saveSolve({
    templateId: layoutState.activeTemplateId,
    signature: solverState.solveSignature(),
    result,
    durationMs,
    finishedAt: Date.now(),
  });
}

const activeSolve = () => solverStorage.loadSolve(layoutState.activeTemplateId);

describe("persisted solve results", () => {
  beforeEach(async () => {
    store.clear();

    // `store.clear()` does not reach `savedGrids`: it is an in-memory field on
    // the singleton, and a `persist()` from the previous case is still
    // encoding in the background when this runs. Left alone, that write lands
    // *after* the hydrate below, and the board it carries — an obstacle
    // cleared, a building placed — is then applied by the next
    // `loadTemplate`, moving the terrain out from under a signature staged
    // against the pristine one.
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = ISLAND_TEMPLATES[0].id;

    solverState.clearResult();
    await layoutState.hydrate({});

    // The board is pristine again, so this writes nothing and queues nothing.
    // What it does is claim the next persist sequence, which is what makes an
    // encode still in flight from the previous case bail instead of landing.
    layoutState.persist();
  });

  it("re-hangs a solve for the board it was computed on", () => {
    stageSolve(fakeResult(500), 4200);
    solverState.restore();

    expect(solverState.optimizationResult?.totalPower).toBe(500);
    expect(solverState.lastRunDurationMs).toBe(4200);
    // The clock reads the finished run's length, not zero.
    expect(solverState.elapsedMs).toBe(4200);
    expect(solverState.isRestored).toBe(true);
  });

  it("discards a solve once the terrain it was solved for changes", () => {
    stageSolve(fakeResult(500));

    // Clearing an obstacle is a legal move on a shipped island, and it changes
    // what the solver would answer — the stored layout no longer describes
    // this board.
    const obstacle = layoutState.grid
      .flat()
      .find((t) => isObstacleType(t.type));
    expect(obstacle).toBeDefined();
    editorState.eraseTile(obstacle!.x, obstacle!.y);

    solverState.restore();

    expect(solverState.optimizationResult).toBeNull();
    // And it is gone for good, rather than waiting to be retried every load.
    expect(activeSolve()).toBeNull();
  });

  it("keeps each island's solve apart, and puts the right one back", async () => {
    const first = layoutState.activeTemplateId;
    stageSolve(fakeResult(500));
    solverState.restore();
    expect(solverState.optimizationResult?.totalPower).toBe(500);

    // Switching islands is a change of view, not a deletion — the reason this
    // is stored per island at all.
    const second = ISLAND_TEMPLATES.find((t) => t.id !== first)!;
    await layoutState.loadTemplate(second, {});
    solverState.restore();
    expect(solverState.optimizationResult).toBeNull();

    // That island can hold its own solve without disturbing the first.
    stageSolve(fakeResult(900));
    solverState.restore();
    expect(solverState.optimizationResult?.totalPower).toBe(900);

    await layoutState.loadTemplate(
      ISLAND_TEMPLATES.find((t) => t.id === first)!,
      {},
    );
    solverState.restore();
    expect(solverState.optimizationResult?.totalPower).toBe(500);
  });

  it("forgets a solve for an island that is deleted", () => {
    stageSolve(fakeResult(500));
    solverState.forgetSolve(layoutState.activeTemplateId);
    expect(activeSolve()).toBeNull();
  });

  it("clearResult drops the stored copy, not just the on-screen one", () => {
    stageSolve(fakeResult(500));
    solverState.restore();
    expect(solverState.optimizationResult).not.toBeNull();

    solverState.clearResult();

    expect(solverState.optimizationResult).toBeNull();
    expect(solverState.finishedAt).toBeNull();
    expect(activeSolve()).toBeNull();
  });

  it("keeps a solve when the user places a building by hand", () => {
    stageSolve(fakeResult(500));

    // The solver ignores hand placements, so one appearing does not make its
    // answer stale — the two boards coexist and the HUD toggles between them.
    const grass = layoutState.grid.flat().find((t) => t.type === "grass");
    expect(grass).toBeDefined();
    layoutState.addPlacement({
      x: grass!.x,
      y: grass!.y,
      buildingId: "generator",
      baseValue: 1,
      powerGenerated: 0,
      heatProduced: 0,
      heatConsumed: 0,
      wasteHeatGenerated: 0,
      coolingProvided: 0,
      coolingReceived: 0,
    });

    solverState.restore();
    expect(solverState.optimizationResult?.totalPower).toBe(500);
  });
});
