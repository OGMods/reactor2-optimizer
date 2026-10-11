/**
 * Switching islands under repeated taps.
 *
 * A load decodes the template and the saved layout asynchronously. It used to
 * paint each as it arrived, so the bare template flashed up between the two,
 * and a second tap on the same island could land its template over the
 * first tap's saved board — the player saw either state depending on timing.
 * These pin the fix: nothing is written until both decodes are done, and only
 * the newest load writes at all.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ISLAND_TEMPLATES,
  decodeBlueprint,
  encodeBlueprint,
} from "@reactor2/solver";
import { layoutState } from "./layout.svelte";

const island1 = ISLAND_TEMPLATES[0];
const island2 = ISLAND_TEMPLATES[1];
const UNLOCKS = { cooler1: 0 };

/** A saved layout for `template`: its own map with one cooler on it. */
async function savedWithCooler(template: (typeof ISLAND_TEMPLATES)[number]) {
  const { grid } = await decodeBlueprint(template.code);
  const open = grid.flat().find((t) => t.type === "grass")!;
  return encodeBlueprint(grid, [
    { x: open.x, y: open.y, buildingId: "cooler1" },
  ]);
}

describe("loading an island", () => {
  beforeEach(async () => {
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = "island1";
    await layoutState.exitPreview(UNLOCKS);
    await layoutState.hydrate(UNLOCKS);
  });

  it("never shows the bare template while the saved layout decodes", async () => {
    layoutState.savedGrids.island2 = { code: await savedWithCooler(island2) };
    const seen: number[] = [];

    const load = layoutState.loadTemplate(island2, UNLOCKS);
    // Whatever is on screen before the load finishes must still be the old
    // island, untouched — not island 2 without its buildings.
    seen.push(layoutState.placements.length);
    expect(layoutState.activeTemplateId).toBe("island1");
    await load;

    expect(seen).toEqual([0]);
    expect(layoutState.activeTemplateId).toBe("island2");
    expect(layoutState.placements).toHaveLength(1);
  });

  it("ends on the saved board however often the island is tapped", async () => {
    layoutState.savedGrids.island2 = { code: await savedWithCooler(island2) };

    await Promise.all([
      layoutState.loadTemplate(island2, UNLOCKS),
      layoutState.loadTemplate(island2, UNLOCKS),
      layoutState.loadTemplate(island2, UNLOCKS),
    ]);

    expect(layoutState.activeTemplateId).toBe("island2");
    expect(layoutState.placements).toHaveLength(1);
  });

  it("lands on the island tapped last", async () => {
    layoutState.savedGrids.island2 = { code: await savedWithCooler(island2) };

    await Promise.all([
      layoutState.loadTemplate(island2, UNLOCKS),
      layoutState.loadTemplate(island1, UNLOCKS),
    ]);

    expect(layoutState.activeTemplateId).toBe("island1");
    expect(layoutState.placements).toHaveLength(0);
  });

  it("lets a shared link outrank a switch still decoding", async () => {
    const share = await savedWithCooler(island1);

    const load = layoutState.loadTemplate(island2, UNLOCKS);
    await layoutState.loadPreview(share, UNLOCKS);
    await load;

    expect(layoutState.isPreview).toBe(true);
    expect(layoutState.placements).toHaveLength(1);
  });

  /*
   * Saving an edit is fire-and-forget: the board is encoded in the background
   * and written to its record when that finishes. A reset or an import that
   * replaces the record while one is still encoding must cancel it, or it lands
   * afterwards and brings back the board that was replaced.
   */
  it("does not let a pending save undo a reset", async () => {
    const tile = layoutState.grid.flat().find((t) => t.type === "grass")!;
    layoutState.addPlacement({
      x: tile.x,
      y: tile.y,
      buildingId: "cooler1",
      baseValue: 1,
      powerGenerated: 0,
      heatProduced: 0,
      heatConsumed: 0,
      wasteHeatGenerated: 0,
      coolingProvided: 0,
      coolingReceived: 0,
    });
    // No await between the edit and the reset: its save is still encoding.
    await layoutState.resetTemplate(island1);
    await new Promise((r) => setTimeout(r, 50));

    expect(layoutState.savedGrids).not.toHaveProperty("island1");
    expect(layoutState.placements).toHaveLength(0);
  });
});
