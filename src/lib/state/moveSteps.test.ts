/**
 * Step mode: the board on screen walks from the island as the game has it to
 * the solve, one step at a time. The planner's own rules are pinned in
 * `simulation/moveSteps.test.ts`; these pin what the app does with a plan —
 * which board it starts from, what the canvas and readout are handed, and
 * what ends it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const { applyInProgress, decodeGameExport, resolveGameExport } =
  await import("@reactor2/solver");
const { configState } = await import("./config.svelte");
const { layoutState } = await import("./layout.svelte");
const { solverState } = await import("./solver.svelte");
const { timelineState } = await import("./timeline.svelte");
const { uiState } = await import("./ui.svelte");

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/solver/tests/gameExports",
);

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

/** Puts `placements` on screen as the solve, the way a finished run does. */
function showSolve(placements: PlacedBuilding[]): OptimizationResult {
  const result: OptimizationResult = {
    totalPower: 0,
    placements,
    activeTilesCount: placements.length,
    unusedTilesCount: 0,
    summary: {
      totalHeatProduced: 0,
      totalHeatConsumed: 0,
      totalWasteGenerated: 0,
      totalCoolingCapacity: 0,
    },
    theoreticalMaxPower: 0,
  };
  solverState.optimizationResult = result;
  uiState.setPlacementView("solver");
  return result;
}

const shape = (
  board: readonly { buildingId: string; x: number; y: number }[],
) => new Set(board.map((b) => `${b.buildingId}@${b.x},${b.y}`));

describe("step mode", () => {
  beforeEach(async () => {
    store.clear();
    uiState.closeMoveSteps();
    timelineState.record = null;
    solverState.optimizationResult = null;
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = "island1";
    await layoutState.exitPreview({});
    await layoutState.hydrate({});
  });

  /**
   * The board in Edit stood five generators short of the game's island1, and
   * the full board as the "solve": real placements, so the plan is five
   * builds that each add power, starting from what Edit shows.
   */
  async function planOnIsland1() {
    await importFixture("gen2_city52_9c43e4b7");
    const full = layoutState.placements;
    const gens = full.filter((p) => p.buildingId.startsWith("generator"));
    const short = full.filter((p) => !gens.slice(0, 5).includes(p));
    layoutState.placements = short;
    const target = full.map(({ buildingId, x, y }) => ({ buildingId, x, y }));
    const result = showSolve(full);
    await uiState.planMoveSteps();
    return { edit: short, target, result };
  }

  it("starts from the board in Edit and ends on the solve", async () => {
    const { edit, target } = await planOnIsland1();
    const m = uiState.moveSteps!;
    expect(uiState.stepsActive).toBe(true);
    // Not the game's island as imported, which had all five generators.
    expect(shape(m.plan.boards[0])).toEqual(shape(edit));
    expect(shape(m.plan.boards.at(-1)!)).toEqual(shape(target));
    expect(m.plan.steps.every((s) => s.kind === "build")).toBe(true);
    expect(m.plan.steps).toHaveLength(5);
    // Each one adds power: the greedy order never goes backwards here.
    for (let i = 1; i < m.plan.powers.length; i++)
      expect(m.plan.powers[i]).toBeGreaterThan(m.plan.powers[i - 1]);
  });

  it("prices every step at the player's research, copies counted across islands", async () => {
    await planOnIsland1();
    const m = uiState.moveSteps!;
    expect(m.prices).toHaveLength(m.plan.steps.length);
    // Five generators built, each dearer than the last as the copies climb.
    const spends = m.prices.map((p) => p.spend);
    expect(spends.every((x) => x > 0)).toBe(true);
    const sameKind = m.plan.steps.map((s) =>
      s.kind === "build" ? s.buildingId : "",
    );
    for (let i = 1; i < spends.length; i++)
      if (sameKind[i] === sameKind[i - 1])
        expect(spends[i]).toBeGreaterThan(spends[i - 1]);
  });

  it("hands the canvas and readout the board after the step on screen", async () => {
    await planOnIsland1();
    const m = uiState.moveSteps!;
    expect(shape(uiState.visiblePlacements)).toEqual(shape(m.plan.boards[0]));

    uiState.showMoveStep(2);
    expect(shape(uiState.visiblePlacements)).toEqual(shape(m.plan.boards[2]));
    expect(uiState.visiblePower).toBe(m.plan.powers[2]);
    // Scored, not bare: the board on screen carries its figures.
    const sum = uiState.visiblePlacements.reduce(
      (s, p) => s + p.powerGenerated,
      0,
    );
    expect(sum).toBeCloseTo(m.plan.powers[2], -15);

    uiState.showMoveStep(99);
    expect(m.index).toBe(m.plan.steps.length);
    uiState.showMoveStep(-3);
    expect(m.index).toBe(0);
  });

  it("ends when the player goes back to their own board", async () => {
    await planOnIsland1();
    uiState.setPlacementView("user");
    expect(uiState.moveSteps).toBeNull();
    expect(uiState.stepsActive).toBe(false);
  });

  it("stops applying the moment the solve on screen is another", async () => {
    await planOnIsland1();
    showSolve(layoutState.placements.slice(2));
    expect(uiState.stepsActive).toBe(false);
    // The board on screen is the new solve, not a step of the old plan.
    expect(uiState.visiblePlacements).toBe(
      solverState.optimizationResult!.placements,
    );
  });

  it("plans nothing when the game's board already makes the solve's power", async () => {
    await importFixture("gen2_city52_9c43e4b7");
    // A weaker "solve": the game's board less five buildings.
    showSolve(layoutState.placements.slice(5));
    await uiState.planMoveSteps();
    expect(uiState.moveSteps).toBeNull();
  });

  it("plans nothing for a board that is already the solve", async () => {
    await importFixture("gen2_city52_9c43e4b7");
    showSolve(layoutState.placements);
    await uiState.planMoveSteps();
    expect(uiState.moveSteps).toBeNull();
  });
});
