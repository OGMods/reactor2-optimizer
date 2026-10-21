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
const { gameImportStorage } = await import("../storage/storage");

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

  it("has no projection for a code from before the timeline section", async () => {
    await importFixture("city34-timeline3");
    expect(timelineState.record!.timeline).toBeNull();
    expect(timelineState.projection).toBeNull();
    expect(timelineState.unenteredAnomalies).toEqual([]);
  });
});
