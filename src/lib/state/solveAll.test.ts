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
  BUILDINGS,
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

  /*
   * Between two islands the solver is idle while the next board loads. Setup
   * used to key on the solver alone, so it flashed back in there, and Run
   * showed where a press would have started a second solve beside the batch.
   */
  it("keeps Setup hidden and Run as Stop between islands", async () => {
    const seen: { hidden: boolean; running: boolean }[] = [];
    solverState.runOptimizer = async () => {
      // Called with the solver still idle: the gap between two islands.
      seen.push({ hidden: uiState.setupHidden, running: uiState.running });
    };

    await uiState.solveAllIslands();

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((s) => s.hidden && s.running)).toBe(true);
    expect(uiState.running).toBe(false);
    expect(uiState.setupHidden).toBe(false);
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

  /*
   * The estimate used to be the island on screen times the island count. An
   * island in several pieces packs onto the pool differently from one in a
   * single piece, so its own figure differs — on a four-core phone, Quick on a
   * split island can come out at 24s against everyone else's 30s — and the
   * total moved with whichever island was open. Each island is counted at its
   * own figure now, which takes its board decoding in the background first.
   */
  it("estimates the same total whichever island is open", async () => {
    // Not an earlier case's import: its anomaly may be a cooling pool, which
    // makes every map one island and every estimate alike.
    const anomaly = configState.anomalyId;
    configState.anomalyId = "none";
    const roster = configState.buildingUpgrades;
    configState.buildingUpgrades = Object.fromEntries(
      BUILDINGS.map((b) => [b.id, b.levels.length - 1]),
    );
    Object.defineProperty(globalThis.navigator, "hardwareConcurrency", {
      value: 4,
      configurable: true,
    });
    const mode = solverState.solveModeId;
    solverState.solveModeId = "quick";
    try {
      // The shipped maps, obstacles and all, at every building's top tier:
      // several are split into pieces that pack onto the pool unevenly.
      const targets = uiState.solveAllTargets;
      const own = new Map<string, number>();
      for (const t of targets) {
        await layoutState.loadTemplate(t, configState.buildingUpgrades);
        own.set(t.id, solverState.estimatedRunMs);
      }
      const low = targets.reduce((a, b) =>
        own.get(b.id)! < own.get(a.id)! ? b : a,
      );
      const high = targets.reduce((a, b) =>
        own.get(b.id)! > own.get(a.id)! ? b : a,
      );
      // Otherwise the old reading would pass too.
      expect(own.get(low.id)).toBeLessThan(own.get(high.id)!);

      const settled = async () => {
        let last = -1;
        for (let i = 0; i < 50; i++) {
          const now = uiState.solveAllEstimateMs;
          if (now === last) return now;
          last = now;
          await new Promise((r) => setTimeout(r, 20));
        }
        return last;
      };
      await layoutState.loadTemplate(low, configState.buildingUpgrades);
      const fromLow = await settled();
      await layoutState.loadTemplate(high, configState.buildingUpgrades);
      const fromHigh = await settled();

      expect(fromLow).toBeCloseTo(fromHigh, 6);
      const sum = [...own.values()].reduce((a, b) => a + b, 0);
      expect(fromHigh).toBeCloseTo(sum, 6);
    } finally {
      solverState.solveModeId = mode;
      configState.buildingUpgrades = roster;
      configState.anomalyId = anomaly;
      // The stub is an own property shadowing the prototype's getter;
      // deleting it puts the real core count back for whatever runs next.
      delete (globalThis.navigator as { hardwareConcurrency?: number })
        .hardwareConcurrency;
    }
  });
});
