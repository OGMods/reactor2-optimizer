/**
 * What importing the game does to the solves already stored for each island.
 *
 * An import changes the roster, the research and usually the terrain, and all
 * three are in a solve's signature — so without `carryOverSolves` every
 * island's solve would be discarded the next time it was opened. These pin
 * which ones survive: a solve is dropped only for a locked island, another
 * anomaly, or layouts the import made unbuildable.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  blueprintKey,
  decodeBlueprint,
  encodeBlueprint,
  ISLAND_TEMPLATES,
} from "@reactor2/solver";
import type { AnomalyId } from "@reactor2/solver";
import type { OptimizationResult, PlacedBuilding, Tile } from "../types";
import type { StoredPlacement } from "../storage/storage";

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

const { configState } = await import("./config.svelte");
const { layoutState } = await import("./layout.svelte");
const { solverState } = await import("./solver.svelte");
const { solverStorage } = await import("../storage/storage");
const { createPlacementAtLevel } = await import("../data/placements");
const { SolverWorkerClient } = await import("../worker/workerClient");

const ISLAND = "island1";
const template = ISLAND_TEMPLATES.find((t) => t.id === ISLAND)!;
const { grid: mapGrid } = await decodeBlueprint(template.code);
const grass = mapGrid.flat().filter((t) => t.type === "grass");

/** A one-building layout on the `i`th grass tile of the island's map. */
function layout(i: number, buildingId = "cooler1"): PlacedBuilding[] {
  return [createPlacementAtLevel(buildingId, grass[i].x, grass[i].y, 0)];
}

function result(placements: PlacedBuilding[]): OptimizationResult {
  return {
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
}

/** Stores a solve for the island, as a finished run would have. */
function stage(
  variants: PlacedBuilding[][],
  selected = 0,
  anomalyId: AnomalyId = "none",
  signature = "the roster before the import",
) {
  solverStorage.saveSolve({
    templateId: ISLAND,
    signature,
    result: result(variants[selected]),
    variants: variants.map((v) =>
      v.map((p): StoredPlacement => [p.buildingId, p.x, p.y, p.baseValue]),
    ),
    selectedVariant: selected,
    anomalyId,
    planKey: "",
    durationMs: 30_000,
    finishedAt: 1,
  });
}

/** The island's map with tile `i` turned to rock, saved as its layout. */
async function rockOn(i: number) {
  const grid: Tile[][] = mapGrid.map((row) =>
    row.map((t) =>
      t.x === grass[i].x && t.y === grass[i].y ? { ...t, type: "rock" } : t,
    ),
  );
  layoutState.savedGrids[ISLAND] = { code: await encodeBlueprint(grid, []) };
}

const shapesOf = (id: string) =>
  solverStorage.loadSolve(id)?.variants?.map((v) => [v[0][1], v[0][2]]);

describe("carrying stored solves through a game import", () => {
  beforeEach(async () => {
    store.clear();
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = ISLAND;
    await layoutState.hydrate({});
    // The roster the import brings: a different one from the solve's.
    configState.buildingUpgrades = { cooler1: 5, generator: 0 };
    configState.prestigeLevels = {};
    configState.setAnomaly("none");
  });

  it("keeps a solve the import left buildable, re-filed for the new roster", async () => {
    stage([layout(0)]);
    await solverState.carryOverSolves([]);

    const saved = solverStorage.loadSolve(ISLAND)!;
    expect(saved.signature).toBe(solverState.solveSignature(mapGrid));
    // Re-tiered to what the import unlocks.
    expect(saved.result.placements[0].baseValue).toBe(
      createPlacementAtLevel("cooler1", 0, 0, 5).baseValue,
    );
    // And it is what the island now restores.
    solverState.restore();
    expect(solverState.variants).toHaveLength(1);
  });

  it("drops a solve for an island still locked in the game", async () => {
    stage([layout(0)]);
    await solverState.carryOverSolves([ISLAND]);
    expect(solverStorage.loadSolve(ISLAND)).toBeNull();
  });

  it("drops a solve searched under another anomaly", async () => {
    stage([layout(0)], 0, "cryo_nexus");
    await solverState.carryOverSolves([]);
    expect(solverStorage.loadSolve(ISLAND)).toBeNull();
  });

  it("drops only the layouts an imported obstacle now covers", async () => {
    stage([layout(0), layout(1), layout(2)], 1);
    await rockOn(0);
    await solverState.carryOverSolves([]);

    expect(shapesOf(ISLAND)).toEqual([
      [grass[1].x, grass[1].y],
      [grass[2].x, grass[2].y],
    ]);
    // The pick survives and keeps pointing at the same layout.
    expect(solverStorage.loadSolve(ISLAND)?.selectedVariant).toBe(0);
  });

  it("drops the solve once an obstacle covers every layout", async () => {
    stage([layout(0)]);
    await rockOn(0);
    await solverState.carryOverSolves([]);
    expect(solverStorage.loadSolve(ISLAND)).toBeNull();
  });

  it("drops a layout that uses a building the import does not unlock", async () => {
    stage([layout(0, "solar_panel"), layout(1)]);
    await solverState.carryOverSolves([]);
    expect(shapesOf(ISLAND)).toEqual([[grass[1].x, grass[1].y]]);

    stage([layout(0, "solar_panel")]);
    await solverState.carryOverSolves([]);
    expect(solverStorage.loadSolve(ISLAND)).toBeNull();
  });
});

/*
 * The same keep-what-still-stands rule for a change made in Setup. The island
 * on screen is re-rated as the change happens (`rescoreResult`); one off
 * screen is re-rated by `restore()` when it is next opened, rather than
 * discarded because its signature names the old roster.
 */
/*
 * A stop only asks a run to end: the workers finish their pass, and the result
 * is scored and filed after. A game import that changed the rules in that gap
 * had the late result scored under the imported ones and filed over the
 * record `carryOverSolves` had just re-filed.
 */
describe("a game import over a run still finishing", () => {
  const proto = SolverWorkerClient.prototype as unknown as Record<
    string,
    unknown
  >;
  const original = proto.solveProgressive;

  beforeEach(async () => {
    store.clear();
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = ISLAND;
    await layoutState.hydrate({});
    configState.buildingUpgrades = { cooler1: 0, solar_panel: 0 };
    configState.prestigeLevels = {};
    configState.setAnomaly("none");
  });

  it("waits until the run has filed its result under its own rules", async () => {
    let finish!: (variants: OptimizationResult[]) => void;
    let stopped = false;
    proto.solveProgressive = () => ({
      promise: new Promise<OptimizationResult[]>((r) => (finish = r)),
      stop: () => void (stopped = true),
    });
    try {
      const signature = solverState.solveSignature();
      const run = solverState.runOptimizer();
      let settled = false;
      const settle = solverState
        .settleOptimizer()
        .then(() => void (settled = true));

      await new Promise((r) => setTimeout(r, 0));
      expect(stopped).toBe(true);
      expect(settled).toBe(false);

      finish([result(layout(0))]);
      await settle;
      expect(solverStorage.loadSolve(ISLAND)?.signature).toBe(signature);
      await run;
    } finally {
      proto.solveProgressive = original;
    }
  });

  it("returns at once when nothing is running", async () => {
    await solverState.settleOptimizer();
    expect(solverState.isOptimizing).toBe(false);
  });
});

describe("opening an island after Setup changed", () => {
  /** A solve filed for this terrain under the roster and rules set now. */
  function stageHere(variants: PlacedBuilding[][]) {
    stage(variants, 0, "none", solverState.solveSignature(mapGrid));
  }

  beforeEach(async () => {
    store.clear();
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = ISLAND;
    await layoutState.hydrate({});
    configState.buildingUpgrades = { cooler1: 0, solar_panel: 0 };
    configState.prestigeLevels = {};
    configState.setAnomaly("none");
  });

  it("re-rates a solve whose roster changed while it was off screen", () => {
    stageHere([layout(0)]);
    configState.buildingUpgrades = { cooler1: 5, solar_panel: 0 };
    configState.prestigeLevels = { absolute_zero: 2 };

    solverState.restore();

    expect(solverState.variants).toHaveLength(1);
    expect(solverState.variants[0].placements[0].baseValue).toBe(
      createPlacementAtLevel("cooler1", 0, 0, 5).baseValue,
    );
    expect(solverStorage.loadSolve(ISLAND)?.signature).toBe(
      solverState.solveSignature(),
    );
  });

  it("keeps a solve across an anomaly change, still saying where it was found", () => {
    stageHere([layout(0)]);
    configState.setAnomaly("cryo_nexus");

    solverState.restore();

    expect(solverState.variants).toHaveLength(1);
    expect(solverState.resultAnomalyId).toBe("none");
  });

  it("drops the layouts that use a building Setup has locked", () => {
    stageHere([layout(0, "solar_panel"), layout(1)]);
    configState.buildingUpgrades = { cooler1: 0 };

    solverState.restore();
    expect(solverState.variants).toHaveLength(1);

    // And the whole solve, once none of its layouts can still be built.
    configState.buildingUpgrades = { cooler1: 0, solar_panel: 0 };
    stageHere([layout(0, "solar_panel")]);
    configState.buildingUpgrades = { cooler1: 0 };
    solverState.restore();
    expect(solverStorage.loadSolve(ISLAND)).toBeNull();
    expect(solverState.variants).toHaveLength(0);
  });

  /*
   * The first records were `terrain|roster`, from before there were anomalies,
   * so the field an anomaly is read from in a record that names none is a
   * piece of the terrain key. Read as an id, it left the solve forever "found
   * under another timeline".
   */
  it("reads a solve from before anomalies as found under the base rules", () => {
    stage([layout(0)], 0, "none", `${blueprintKey(mapGrid)}|cooler1:0`);
    const saved = solverStorage.loadSolve(ISLAND)!;
    delete saved.anomalyId;
    solverStorage.saveSolve(saved);
    configState.buildingUpgrades = { cooler1: 5, solar_panel: 0 };

    solverState.restore();

    expect(solverState.variants).toHaveLength(1);
    expect(solverState.resultAnomalyId).toBe("none");
    expect(solverStorage.loadSolve(ISLAND)?.anomalyId).toBe("none");
  });

  it("still discards a solve for terrain that has changed", () => {
    stage([layout(1)], 0, "none", "another board|cooler1:0|none|");
    solverState.restore();
    expect(solverStorage.loadSolve(ISLAND)).toBeNull();
    expect(solverState.variants).toHaveLength(0);
  });
});
