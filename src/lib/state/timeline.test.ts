/**
 * What the header's timeline readout is built on: an import kept as the game
 * had it, every island's power added up, and the Chronon count run forward
 * from the moment of export.
 *
 * The package pins the formula; these pin the app's two promises about it.
 * The count runs at the power the *game's* boards made, not at a board edited
 * here since. And the total is the boards *here*, live.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

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

const { decodeGameExport, resolveGameExport, applyInProgress, TICK_SECONDS } =
  await import("@reactor2/solver");
const { configState } = await import("./config.svelte");
const { layoutState } = await import("./layout.svelte");
const { timelineState } = await import("./timeline.svelte");
const { gameImportStorage, solverStorage, uiStorage } =
  await import("../storage/storage");

/**
 * Stages a stored solve for `templateId` built from `placements`. Only the
 * shape is read back — the timeline re-scores it — so the figures are left
 * at zero.
 */
function stageSolve(
  templateId: string,
  placements: { buildingId: string; x: number; y: number }[],
) {
  solverStorage.saveSolve({
    templateId,
    signature: "",
    result: {
      totalPower: 0,
      placements: placements.map(({ buildingId, x, y }) => ({
        buildingId,
        x,
        y,
        baseValue: 0,
        powerGenerated: 0,
        heatProduced: 0,
        heatConsumed: 0,
        wasteHeatGenerated: 0,
        coolingProvided: 0,
        coolingReceived: 0,
      })),
      activeTilesCount: 0,
      unusedTilesCount: 0,
      summary: {
        totalHeatProduced: 0,
        totalHeatConsumed: 0,
        totalWasteGenerated: 0,
        totalCoolingCapacity: 0,
      },
      theoreticalMaxPower: 0,
    },
    durationMs: 1,
    finishedAt: Date.now(),
  });
}

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/solver/tests/gameExports",
);

async function fixture(name: string) {
  const exp = await decodeGameExport(
    readFileSync(join(FIXTURES, `${name}.txt`), "utf8"),
  );
  return { exp, resolved: await resolveGameExport(exp) };
}

/** Imports a fixture the way `uiState.applyGameImport` does. */
async function importFixture(name: string) {
  const { exp, resolved } = await fixture(name);
  const state = applyInProgress(resolved, "ignore");
  configState.applyGameImport(state, resolved.anomalyId);
  layoutState.setPrestige(configState.prestige);
  layoutState.setAnomaly(configState.activeAnomaly);
  await layoutState.importGameIslands(
    resolved.islands,
    configState.buildingUpgrades,
    resolved.lockedTemplateIds,
  );
  await timelineState.recordImport(exp, resolved);
  return { exp, resolved };
}

describe("the timeline", () => {
  beforeEach(async () => {
    store.clear();
    timelineState.record = null;
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = "island1";
    await layoutState.exitPreview({});
    await layoutState.hydrate({});
  });

  it("keeps the import as the game had it, and survives a reload", async () => {
    const { exp, resolved } = await importFixture("gen2_cryo_city34");
    const r = timelineState.record!;

    expect(r.gameVersion).toBe("1.1.11");
    expect(r.timeline).toEqual(exp.timeline);
    // The economy research the roster never held is all there.
    expect(r.research).toEqual(exp.research);
    expect(Object.keys(r.islands).sort()).toEqual(
      resolved.islands.map((i) => i.templateId).sort(),
    );
    expect(r.energyPerTick).toBeGreaterThan(0);
    expect(gameImportStorage.load()).toEqual(r);
  });

  it("projects the game's own award at the moment of export", async () => {
    const { exp } = await importFixture("gen1_cryo_city41");
    timelineState.now = exp.timeline!.exportedAt * 1000;
    expect(timelineState.projection).toMatchObject({
      sinceExport: 0,
      award: exp.timeline!.jumpAward,
      canJump: true,
    });
  });

  it("runs energy forward at the game boards' power, per tick", async () => {
    const { exp } = await importFixture("gen2_singularity_city32");
    const r = timelineState.record!;
    timelineState.now = (exp.timeline!.exportedAt + 600) * 1000;
    expect(timelineState.projection!.energy).toBeCloseTo(
      exp.timeline!.energy + (r.energyPerTick / TICK_SECONDS) * 600,
      -10,
    );
  });

  /*
   * The game's own rate, measured: this player's save was exported more than
   * once, with the same boards and research and only offline time between.
   * The first export's energy was 1.777171287713242e31 at 1119984 s; the
   * fixture is a later one, 23,897 s on. What the game added in between, over
   * the time between, is the rate — and the simulator, through the 3-second
   * tick, has to land on it. It does, to 66 parts per million.
   */
  it("projects at the rate the game itself measured on a real save", async () => {
    const { exp } = await importFixture("gen2_city52_9c43e4b7");
    const t = exp.timeline!;
    const measured =
      (t.energy - 1.777171287713242e31) / (t.elapsedSeconds - 1119984);
    const ours = timelineState.record!.energyPerTick / TICK_SECONDS;
    expect(Math.abs(ours / measured - 1)).toBeLessThan(1e-4);
  });

  it("does not move the count when a board here is edited", async () => {
    await importFixture("gen2_cryo_city34");
    const before = timelineState.record!.energyPerTick;
    layoutState.placements = [];
    expect(timelineState.record!.energyPerTick).toBe(before);
  });

  it("adds every island up to the game's power when nothing was changed", async () => {
    await importFixture("gen2_cryo_city34");
    await timelineState.refreshIslands();
    const game = timelineState.record!.energyPerTick;
    expect(timelineState.totalPower).toBeCloseTo(game, -Math.log10(game) + 9);
  });

  it("follows the board on screen live", async () => {
    await importFixture("gen2_cryo_city34");
    await timelineState.refreshIslands();
    const total = timelineState.totalPower;
    const here = layoutState.placements.reduce(
      (s, p) => s + p.powerGenerated,
      0,
    );
    expect(here).toBeGreaterThan(0);
    layoutState.placements = [];
    expect(timelineState.totalPower).toBeCloseTo(total - here, -20);
  });

  it("lists the anomalies a jump would still pay the bonus for", async () => {
    await importFixture("gen2_cryo_city34");
    expect(timelineState.unenteredAnomalies.map((a) => a.id)).toEqual([
      "singularity_isolation",
    ]);
  });

  it("reads today's award until a target is set", async () => {
    const { exp } = await importFixture("gen1_cryo_city41");
    timelineState.setChrononTarget(null);
    timelineState.now = exp.timeline!.exportedAt * 1000;
    // An empty field answers "what would a jump now leave me holding?".
    expect(timelineState.targetEta).toMatchObject({
      target: exp.timeline!.jumpAward,
      seconds: 0,
      held: exp.timeline!.chronons + exp.timeline!.jumpAward,
    });
  });

  it("sizes the quick targets to the award", async () => {
    let { exp } = await importFixture("gen2_city52_9c43e4b7");
    timelineState.now = exp.timeline!.exportedAt * 1000;
    expect(timelineState.quickTargets).toEqual([12000, 15000, 20000]);

    ({ exp } = await importFixture("gen2_cryo_city34"));
    timelineState.now = exp.timeline!.exportedAt * 1000;
    expect(timelineState.quickTargets).toEqual([730, 750, 800]);
  });

  /*
   * The case that printed "Invalid Date": at 723 a fixed 10,000 was some
   * billion days out. The nearest chip now has to be a wait a player can plan.
   */
  it("offers a small award a chip it can reach this year", async () => {
    const { exp } = await importFixture("gen2_cryo_city34");
    timelineState.now = exp.timeline!.exportedAt * 1000;
    timelineState.setChrononTarget(timelineState.quickTargets[0]);
    const eta = timelineState.targetEta!;
    expect(eta.target).toBe(730);
    expect(eta.seconds!).toBeGreaterThan(0);
    expect(eta.seconds!).toBeLessThan(365 * 86400);
  });

  it("counts down to a set target, and remembers it", async () => {
    const { exp } = await importFixture("gen2_city52_9c43e4b7");
    const t = exp.timeline!;
    timelineState.now = t.exportedAt * 1000;
    timelineState.setChrononTarget(t.jumpAward + 10);

    const eta = timelineState.targetEta!;
    expect(eta.target).toBe(t.jumpAward + 10);
    // Ten Chronons on from 11,241, at about four minutes each.
    expect(eta.seconds!).toBeGreaterThan(9 * 230);
    expect(eta.seconds!).toBeLessThan(10 * 250);
    expect(eta.at).toBe(timelineState.now + eta.seconds! * 1000);
    expect(eta.elapsedAt).toBe(t.elapsedSeconds + eta.seconds!);

    // Half-way there, half the wait is left.
    timelineState.now += (eta.seconds! / 2) * 1000;
    expect(timelineState.targetEta!.seconds!).toBeCloseTo(eta.seconds! / 2, 3);

    expect(uiStorage.loadPrefs().chrononTarget).toBe(t.jumpAward + 10);
  });

  it("reads a target already met as reached, paying today's award", async () => {
    const { exp } = await importFixture("gen2_city52_9c43e4b7");
    const t = exp.timeline!;
    timelineState.now = t.exportedAt * 1000;
    timelineState.setChrononTarget(500);
    expect(timelineState.targetEta).toMatchObject({
      seconds: 0,
      held: t.chronons + t.jumpAward,
    });
  });

  it("starts a new import from today's award, not the last target", async () => {
    await importFixture("gen2_city52_9c43e4b7");
    timelineState.setChrononTarget(15000);
    const { exp } = await importFixture("gen1_cryo_city41");
    timelineState.now = exp.timeline!.exportedAt * 1000;
    expect(timelineState.chrononTarget).toBeNull();
    expect(uiStorage.loadPrefs().chrononTarget).toBeUndefined();
    expect(timelineState.targetEta).toMatchObject({
      target: exp.timeline!.jumpAward,
      seconds: 0,
    });
  });

  it("clears a target that is not a positive number", () => {
    timelineState.setChrononTarget(-4);
    expect(timelineState.chrononTarget).toBeNull();
    expect(uiStorage.loadPrefs().chrononTarget).toBeUndefined();
  });

  it("reads the pace now against the timeline's average", async () => {
    const { exp } = await importFixture("gen2_city52_9c43e4b7");
    const t = exp.timeline!;
    timelineState.now = t.exportedAt * 1000;
    const pace = timelineState.pace!;
    const p = timelineState.projection!;
    expect(pace.nowPerHour).toBeCloseTo(3600 / p.chrononSeconds!, 9);
    expect(pace.averagePerHour).toBeCloseTo(
      t.jumpAward / (t.elapsedSeconds / 3600),
      9,
    );
    // Thirteen days in, one Chronon takes minutes against an average of
    // seconds-apart: this save is past the point a fresh timeline beats.
    expect(pace.nowPerHour).toBeLessThan(pace.averagePerHour);
  });

  it("has no solve figures until an island has a stored solve", async () => {
    await importFixture("gen2_city52_9c43e4b7");
    await timelineState.refreshIslands();
    expect(timelineState.withSolvesPower).toBeNull();
    expect(timelineState.targetEta!.secondsWithSolves).toBeNull();
  });

  it("builds each solve in place of a weaker board, and never a stronger one", async () => {
    const { resolved } = await importFixture("gen2_city52_9c43e4b7");
    await timelineState.refreshIslands();
    const total = timelineState.totalPower;
    const island2 = resolved.islands.find((i) => i.templateId === "island2")!;

    // A solve that is the island's own board adds nothing.
    stageSolve("island2", island2.placements);
    await timelineState.refreshIslands();
    expect(timelineState.withSolvesPower).toBeCloseTo(total, -20);

    // An empty "solve" makes less than the board, so the board stays.
    stageSolve("island2", []);
    await timelineState.refreshIslands();
    expect(timelineState.withSolvesPower).toBeCloseTo(total, -20);
  });

  it("counts a target down faster with solves that beat the game's power", async () => {
    const { exp, resolved } = await importFixture("gen2_city52_9c43e4b7");
    const island2 = resolved.islands.find((i) => i.templateId === "island2")!;
    stageSolve("island2", island2.placements);
    await timelineState.refreshIslands();
    // Stand the game's boards at half their power: the solves now beat them.
    timelineState.record = {
      ...timelineState.record!,
      energyPerTick: timelineState.record!.energyPerTick / 2,
    };
    timelineState.now = exp.timeline!.exportedAt * 1000;
    timelineState.setChrononTarget(exp.timeline!.jumpAward + 50);

    const eta = timelineState.targetEta!;
    expect(eta.secondsWithSolves!).toBeGreaterThan(0);
    // Twice the power, half the wait.
    expect(eta.secondsWithSolves!).toBeCloseTo(eta.seconds! / 2, 0);
  });

  it("offers no bonus once every anomaly has been entered", async () => {
    // Cryo, Singularity and Tidal all entered, under a legacy Tidal header.
    await importFixture("gen6_tidal_city49");
    expect(timelineState.unenteredAnomalies).toEqual([]);
  });

  it("has no projection for a code from before the timeline section", async () => {
    await importFixture("city34-timeline3");
    expect(timelineState.record!.timeline).toBeNull();
    expect(timelineState.projection).toBeNull();
    expect(timelineState.unenteredAnomalies).toEqual([]);
  });
});
