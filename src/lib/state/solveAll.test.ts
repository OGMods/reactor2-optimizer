/**
 * "Solve all islands": the walk through the islands, not the search. Each run
 * is stood in for, so what is pinned is which islands are solved, in what
 * order, with what defended, where the player is left, and what Stop does.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const {
  applyInProgress,
  decodeGameExport,
  ISLAND_TEMPLATES,
  resolveGameExport,
} = await import("@reactor2/solver");
const { configState } = await import("./config.svelte");
const { layoutState } = await import("./layout.svelte");
const { solverState } = await import("./solver.svelte");
const { timelineState } = await import("./timeline.svelte");
const { uiState } = await import("./ui.svelte");

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/solver/tests/gameExports",
);

/** Imports a fixture the way `uiState.applyGameImport` does. */
async function importFixture(name: string) {
  const exp = await decodeGameExport(
    readFileSync(join(FIXTURES, `${name}.txt`), "utf8"),
  );
  const resolved = await resolveGameExport(exp);
  configState.applyGameImport(
    applyInProgress(resolved, "ignore"),
    resolved.anomalyId,
  );
  layoutState.setPrestige(configState.prestige);
  layoutState.setAnomaly(configState.activeAnomaly);
  await layoutState.importGameIslands(
    resolved.islands,
    configState.buildingUpgrades,
    resolved.lockedTemplateIds,
  );
  await timelineState.recordImport(exp, resolved);
  return resolved;
}

const realRun = solverState.runOptimizer;

/**
 * Stands in for the search: records the island on screen at each run, and
 * whether it was asked to defend a held layout. `during` runs mid-"run", while
 * the solver reads as busy — where a player pressing Stop would be.
 */
function stubRuns(during?: (call: number) => void) {
  const calls: { island: string; keepBest: boolean }[] = [];
  solverState.runOptimizer = async (options = {}) => {
    calls.push({
      island: layoutState.activeTemplateId,
      keepBest: options.keepBest ?? false,
    });
    solverState.isOptimizing = true;
    try {
      during?.(calls.length);
    } finally {
      solverState.isOptimizing = false;
    }
  };
  return calls;
}

describe("solve all islands", () => {
  beforeEach(async () => {
    store.clear();
    timelineState.record = null;
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = "island1";
    await layoutState.exitPreview({});
    await layoutState.hydrate({});
  });

  afterEach(() => {
    solverState.runOptimizer = realRun;
  });

  it("solves every island unlocked in the game, in order, and comes home", async () => {
    const resolved = await importFixture("city34-timeline3");
    const unlocked = ISLAND_TEMPLATES.filter(
      (t) => t.game && !resolved.lockedTemplateIds.includes(t.id),
    ).map((t) => t.id);
    expect(resolved.lockedTemplateIds.length).toBeGreaterThan(0);

    const home = ISLAND_TEMPLATES.find((t) => t.id === unlocked[1])!;
    await layoutState.loadTemplate(home, configState.buildingUpgrades);
    const calls = stubRuns();

    await uiState.solveAllIslands();

    expect(calls.map((c) => c.island)).toEqual(unlocked);
    expect(layoutState.activeTemplateId).toBe(home.id);
    expect(uiState.solveAll).toBeNull();
  });

  it("solves every shipped island when nothing has been imported", () => {
    expect(uiState.solveAllTargets.map((t) => t.id)).toEqual(
      ISLAND_TEMPLATES.filter((t) => t.game).map((t) => t.id),
    );
  });

  it("starts each island fresh when it has no solve to defend", async () => {
    await importFixture("city34-timeline3");
    const calls = stubRuns();
    await uiState.solveAllIslands();
    expect(calls.every((c) => !c.keepBest)).toBe(true);
  });

  it("stops after the island running when Stop is pressed", async () => {
    await importFixture("city34-timeline3");
    const calls = stubRuns((call) => {
      if (call === 2) uiState.requestSolve();
    });

    await uiState.solveAllIslands();

    expect(calls).toHaveLength(2);
    expect(uiState.solveAll).toBeNull();
    expect(layoutState.activeTemplateId).toBe("island1");
  });

  it("will not start over a run already in flight", async () => {
    await importFixture("city34-timeline3");
    const calls = stubRuns();
    solverState.isOptimizing = true;
    try {
      expect(uiState.canSolveAll).toBe(false);
      await uiState.solveAllIslands();
    } finally {
      solverState.isOptimizing = false;
    }
    expect(calls).toHaveLength(0);
  });
});
