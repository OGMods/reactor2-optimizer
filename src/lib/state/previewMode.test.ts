/**
 * What a shared link is allowed to do to the person who opens it.
 *
 * The answer is "nothing": a `?bp=` code puts someone else's board on screen,
 * and until the visitor imports it, none of their own islands, edits or saved
 * layouts may move. That is one rule with a lot of surfaces — the terrain
 * brushes, the eraser, `persist()`, the roster re-base — and every one of them
 * has to hold on its own, because the interface only *hides* the controls.
 *
 * The other half is the tier table. Preview is the one place in the app that
 * shows a building at a tier the viewer has not unlocked, and it has to,
 * because the alternative is putting numbers on screen that the sender never
 * saw.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { layoutState } from "./layout.svelte";
import { editorState } from "./editor.svelte";
import { encodeBlueprint } from "../encoding/blueprint";
import { buildShareUrl, readSharedCode } from "../encoding/shareLink";
import { findBuilding, levelValue } from "../data/buildings";
import type { Tile } from "../types";

/** The tier the author had, and the (lower) tier the reader has unlocked. */
const AUTHOR_TIER = 3;
const READER_UNLOCKS = { cooler1: 0, generator: 0 };

function valueAt(id: string, tier: number): number {
  const def = findBuilding(id)!;
  return levelValue(def.levels[tier]);
}

/** A small all-grass board, which is all a placement needs to stand on. */
function grass(width: number, height: number): Tile[][] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x): Tile => ({ x, y, type: "grass" })),
  );
}

/** A shared code for a two-building board, tiers included. */
function sharedCode(tiers?: Record<string, number>): Promise<string> {
  return encodeBlueprint(
    grass(3, 2),
    [
      { x: 0, y: 0, buildingId: "cooler1" },
      { x: 2, y: 1, buildingId: "generator" },
    ],
    tiers,
  );
}

describe("preview mode", () => {
  beforeEach(async () => {
    // Back to a shipped island with nothing saved over it, so each case starts
    // from the board a first-time visitor would have behind the link.
    layoutState.savedGrids = {};
    layoutState.customIslands = [];
    layoutState.activeTemplateId = "island1";
    await layoutState.exitPreview(READER_UNLOCKS);
    await layoutState.hydrate(READER_UNLOCKS);
  });

  it("loads a shared board at the author's tiers", async () => {
    const code = await sharedCode({
      cooler1: AUTHOR_TIER,
      generator: AUTHOR_TIER,
    });

    expect(await layoutState.loadPreview(code, READER_UNLOCKS)).toBe(true);

    expect(layoutState.isPreview).toBe(true);
    expect(layoutState.placements).toHaveLength(2);
    for (const p of layoutState.placements) {
      expect(p.baseValue).toBe(valueAt(p.buildingId, AUTHOR_TIER));
      // The point of the table: the reader's own unlock would rate this lower.
      expect(p.baseValue).not.toBe(valueAt(p.buildingId, 0));
    }
  });

  it("falls back to the reader's unlocks for a code with no tier table", async () => {
    // Every code written before the table existed. There is nothing better to
    // show than what the reader has, which is what the app always did.
    expect(
      await layoutState.loadPreview(await sharedCode(), READER_UNLOCKS),
    ).toBe(true);

    for (const p of layoutState.placements) {
      expect(p.baseValue).toBe(valueAt(p.buildingId, 0));
    }
  });

  it("refuses every write a visitor could reach", async () => {
    await layoutState.loadPreview(await sharedCode(), READER_UNLOCKS);

    expect(layoutState.canEditTerrain).toBe(false);

    // Painting is gated on canEditTerrain; erasing an obstacle is the one edit
    // a *shipped* island still allows, so it needs its own refusal.
    const before = layoutState.grid.map((row) => row.map((t) => t.type));
    editorState.activeTool = "rock";
    editorState.paintTile(1, 0);
    layoutState.grid[1][0].type = "rock";
    editorState.eraseTile(1, 0);
    expect(layoutState.grid[1][0].type).toBe("rock");
    layoutState.grid[1][0].type = before[1][0];

    editorState.clearHand();
  });

  it("writes nothing to the visitor's saved layouts", async () => {
    await layoutState.loadPreview(await sharedCode(), READER_UNLOCKS);

    layoutState.persist();
    await Promise.resolve();

    expect(layoutState.savedGrids).toEqual({});
  });

  it("does not re-base the author's buildings to the reader's roster", async () => {
    // The live re-score in `App.svelte` calls this whenever a tier is bought.
    // A previewed board is the one board the reader's roster does not speak
    // for, so it has to sit that one out.
    await layoutState.loadPreview(
      await sharedCode({ cooler1: AUTHOR_TIER, generator: AUTHOR_TIER }),
      READER_UNLOCKS,
    );

    layoutState.rebasePlacements(READER_UNLOCKS);

    for (const p of layoutState.placements) {
      expect(p.baseValue).toBe(valueAt(p.buildingId, AUTHOR_TIER));
    }
  });

  it("refuses a second import while a preview is up", async () => {
    await layoutState.loadPreview(await sharedCode(), READER_UNLOCKS);

    // Importing claims an island slot, and claiming one in preview would go
    // unsaved — a half-exited preview with an island that vanishes on reload.
    await expect(
      layoutState.importBlueprint(await sharedCode(), READER_UNLOCKS),
    ).rejects.toThrow(/Leave the shared layout/);
    expect(layoutState.isPreview).toBe(true);
  });

  it("puts the visitor back on their own board when it exits", async () => {
    const own = layoutState.activeTemplateId;
    const ownTerrain = layoutState.grid.map((row) => row.map((t) => t.type));

    await layoutState.loadPreview(await sharedCode(), READER_UNLOCKS);
    expect(layoutState.grid).toHaveLength(2);

    await layoutState.exitPreview(READER_UNLOCKS);

    expect(layoutState.isPreview).toBe(false);
    expect(layoutState.activeTemplateId).toBe(own);
    expect(layoutState.grid.map((row) => row.map((t) => t.type))).toEqual(
      ownTerrain,
    );
  });

  it("adopts the board as a new island, re-based to the reader's own tiers", async () => {
    await layoutState.loadPreview(
      await sharedCode({ cooler1: AUTHOR_TIER, generator: AUTHOR_TIER }),
      READER_UNLOCKS,
    );

    const island = await layoutState.adoptPreview(READER_UNLOCKS);

    // Preview is where the author's tiers are shown faithfully. Once the board
    // is the reader's, it is their roster that rates it — the rule every other
    // board in the app already follows, and the one `rebasePlacements` applies
    // live the moment they buy an upgrade.
    expect(layoutState.isPreview).toBe(false);
    expect(layoutState.activeTemplateId).toBe(island.id);
    expect(layoutState.customIslands.map((c) => c.id)).toContain(island.id);
    expect(layoutState.placements).toHaveLength(2);
    for (const p of layoutState.placements) {
      expect(p.baseValue).toBe(valueAt(p.buildingId, 0));
    }
  });

  it("stays in preview when an adoption is refused", async () => {
    await layoutState.loadPreview(await sharedCode(), READER_UNLOCKS);

    // A board with two transformers cannot be produced by the editor, so
    // importBlueprint rejects it. The visitor should still be reading.
    const twoTransformers = await encodeBlueprint([
      [
        { x: 0, y: 0, type: "transformer" },
        { x: 1, y: 0, type: "transformer" },
      ],
    ]);
    await layoutState.loadPreview(twoTransformers, READER_UNLOCKS);

    await expect(layoutState.adoptPreview(READER_UNLOCKS)).rejects.toThrow(
      /transformers/,
    );
    expect(layoutState.isPreview).toBe(true);
  });

  it("reports an unreadable code rather than half-loading it", async () => {
    expect(await layoutState.loadPreview("not-a-code", READER_UNLOCKS)).toBe(
      false,
    );
    expect(layoutState.isPreview).toBe(false);
  });
});

describe("share links", () => {
  it("carries the code in the bp parameter, against the served path", () => {
    const url = buildShareUrl("eJxAbC", {
      origin: "https://example.github.io",
      pathname: "/reactor2-optimizer/",
    });

    expect(url).toBe("https://example.github.io/reactor2-optimizer/?bp=eJxAbC");
    expect(readSharedCode({ search: new URL(url).search })).toBe("eJxAbC");
  });

  it("drops an existing query, so a link built in preview carries one code", () => {
    // Sharing from a previewed board must not emit the author's code beside
    // the new one — `?bp=theirs&bp=mine` reads back as theirs.
    expect(
      buildShareUrl("mine", {
        origin: "https://example.com",
        pathname: "/app/",
      }),
    ).toBe("https://example.com/app/?bp=mine");
  });

  it("reads no code from a plain URL", () => {
    expect(readSharedCode({ search: "" })).toBeNull();
    expect(readSharedCode({ search: "?other=1" })).toBeNull();
    expect(readSharedCode({ search: "?bp=" })).toBeNull();
  });
});
