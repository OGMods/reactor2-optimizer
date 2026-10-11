/**
 * Loading a code from the game's Export to Optimizer button into the app.
 *
 * The package tests pin how a code is read and resolved; these pin what the
 * stores do with it, which is the part a player sees: shipped islands get the
 * player's boards as saved layouts, the board on screen is reloaded, islands
 * still locked in the game are reset to their untouched maps, and the
 * roster, Time Lab, anomaly and plan are taken as the import says.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyInProgress,
  decodeBlueprint,
  decodeGameExport,
  encodeBlueprint,
  ISLAND_TEMPLATES,
  findBuilding,
  levelValue,
  resolveGameExport,
  type ResolvedGameImport,
} from "@reactor2/solver";
import { configState } from "./config.svelte";
import { layoutState } from "./layout.svelte";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/solver/tests/gameExports",
);

function fixture(name: string): Promise<ResolvedGameImport> {
  const code = readFileSync(join(FIXTURES, `${name}.txt`), "utf8");
  return decodeGameExport(code).then(resolveGameExport);
}

describe("importing a game save", () => {
  beforeEach(async () => {
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = "island1";
    await layoutState.exitPreview({});
    await layoutState.hydrate({});
  });

  it("puts the player's buildings on the island on screen", async () => {
    const game = await fixture("city34-timeline3");
    const state = applyInProgress(game, "ignore");

    await layoutState.importGameIslands(game.islands, state.buildingUpgrades);

    const island1 = game.islands.find((i) => i.templateId === "island1")!;
    expect(layoutState.placements).toHaveLength(island1.placements.length);
    // Each building stands at the tier the imported roster unlocks.
    const divine = layoutState.placements.find(
      (p) => p.buildingId === "divine_reactor",
    )!;
    const def = findBuilding("divine_reactor")!;
    expect(divine.baseValue).toBe(
      levelValue(def.levels[state.buildingUpgrades.divine_reactor]),
    );
  });

  it("saves every unlocked island and clears locked ones", async () => {
    const game = await fixture("city34-timeline3");
    // Something drawn on an island still locked in the game, and on a custom
    // island, which no game import may touch.
    layoutState.savedGrids.island8 = { code: "drawn" };
    layoutState.savedGrids.custom1 = { code: "mine" };

    await layoutState.importGameIslands(
      game.islands,
      {},
      game.lockedTemplateIds,
    );

    for (const id of ["island1", "island2", "island3", "island4", "island5"]) {
      expect(layoutState.savedGrids, id).toHaveProperty(id);
    }
    // Island 6 is unlocked in that save but untouched, so it matches the
    // template and holds no saved layout at all.
    expect(layoutState.savedGrids).not.toHaveProperty("island6");
    expect(game.lockedTemplateIds).toEqual(["island7", "island8"]);
    expect(layoutState.savedGrids).not.toHaveProperty("island8");
    expect(layoutState.savedGrids.custom1).toEqual({ code: "mine" });
  });

  it("resets a locked island that is on screen", async () => {
    const game = await fixture("city34-timeline3");
    const template = ISLAND_TEMPLATES.find((t) => t.id === "island8")!;
    const { grid } = await decodeBlueprint(template.code);
    const open = grid.flat().find((t) => t.type === "grass")!;
    layoutState.savedGrids.island8 = {
      code: await encodeBlueprint(grid, [
        { x: open.x, y: open.y, buildingId: "cooler1" },
      ]),
    };
    await layoutState.loadTemplate(template, { cooler1: 0 });
    expect(layoutState.placements).toHaveLength(1);

    await layoutState.importGameIslands(
      game.islands,
      {},
      game.lockedTemplateIds,
    );

    expect(layoutState.activeTemplateId).toBe("island8");
    expect(layoutState.placements).toHaveLength(0);
    expect(layoutState.isTemplateModified(template)).toBe(false);
  });

  it("refuses while a shared layout is on screen", async () => {
    const game = await fixture("city47-timeline1");
    const share = await layoutState.exportBlueprint(null);
    await layoutState.loadPreview(share, {});

    await expect(
      layoutState.importGameIslands(game.islands, {}),
    ).rejects.toThrow();
  });

  it("takes the roster, Time Lab, anomaly and plan", async () => {
    const game = await fixture("city47-timeline1");
    configState.upgradePlan = [];

    configState.applyGameImport(applyInProgress(game, "plan"), game.anomalyId);

    expect(configState.buildingUpgrades).toEqual(game.buildingUpgrades);
    expect(configState.prestigeLevels).toEqual({});
    expect(configState.anomalyId).toBe("none");
    expect(configState.upgradePlan).toEqual([
      { buildingId: "doomStar_reactor", level: 2 },
    ]);
  });

  it("keeps the player's own plan unless the import makes one", async () => {
    const game = await fixture("city34-timeline3");
    configState.upgradePlan = [{ buildingId: "cooler6", level: 3 }];

    configState.applyGameImport(
      applyInProgress(game, "finished"),
      game.anomalyId,
    );

    expect(configState.upgradePlan).toEqual([
      { buildingId: "cooler6", level: 3 },
    ]);
    expect(configState.anomalyId).toBe("cryo_nexus");
    expect(configState.prestigeLevels).toEqual(game.prestigeLevels);
  });
});
