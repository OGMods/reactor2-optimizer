/**
 * Undo/redo for the board.
 *
 * The rules worth pinning are not "undo puts the tile back" — that one is hard
 * to get wrong. They are the three that are easy to get wrong and expensive
 * when you do:
 *
 *   1. A drag is **one** undo, not one per tile it crossed.
 *   2. History **never crosses a board**. An undo that survived a template
 *      switch would paint one island's terrain onto another.
 *   3. A previewed board has no history, because it is not the visitor's to
 *      edit — the same rule every other write path in preview follows.
 *
 * App rules, so they live here rather than in the solver package's suite: the
 * engine knows nothing about an editor.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { layoutState } from "./layout.svelte";
import { ISLAND_TEMPLATES } from "@reactor2/solver";

/** A hand-placed building, scored to zero — `recalculate` re-derives it. */
function placementAt(x: number, y: number, buildingId = "generator") {
  return {
    x,
    y,
    buildingId,
    baseValue: 1,
    powerGenerated: 0,
    heatProduced: 0,
    heatConsumed: 0,
    wasteHeatGenerated: 0,
    coolingProvided: 0,
    coolingReceived: 0,
  };
}

/** The first `n` buildable tiles, in whatever order the board holds them. */
function grassTiles(n: number) {
  const found = layoutState.grid.flat().filter((t) => t.type === "grass");
  expect(found.length).toBeGreaterThanOrEqual(n);
  return found.slice(0, n).map((t) => ({ x: t.x, y: t.y }));
}

describe("board history", () => {
  beforeEach(async () => {
    await layoutState.hydrate({});
    await layoutState.resetTemplate(ISLAND_TEMPLATES[0]);
  });

  it("starts with nothing to undo or redo", () => {
    expect(layoutState.canUndo).toBe(false);
    expect(layoutState.canRedo).toBe(false);
  });

  it("undoes a placement and redoes it", () => {
    const [tile] = grassTiles(1);
    layoutState.addPlacement(placementAt(tile.x, tile.y));
    expect(layoutState.placements).toHaveLength(1);
    expect(layoutState.canUndo).toBe(true);

    expect(layoutState.undo()).toBe(true);
    expect(layoutState.placements).toHaveLength(0);
    expect(layoutState.canUndo).toBe(false);
    expect(layoutState.canRedo).toBe(true);

    expect(layoutState.redo()).toBe(true);
    expect(layoutState.placements).toHaveLength(1);
    expect(layoutState.placements[0].x).toBe(tile.x);
    expect(layoutState.placements[0].y).toBe(tile.y);
  });

  it("undoes a removal", () => {
    const [tile] = grassTiles(1);
    layoutState.addPlacement(placementAt(tile.x, tile.y));
    layoutState.removePlacement(tile.x, tile.y);
    expect(layoutState.placements).toHaveLength(0);

    layoutState.undo();
    expect(layoutState.placements).toHaveLength(1);
  });

  it("counts a whole stroke as one undo", () => {
    const tiles = grassTiles(4);

    // What a drag across four tiles does: one gesture, four writes.
    layoutState.beginStroke();
    for (const t of tiles) layoutState.addPlacement(placementAt(t.x, t.y));
    layoutState.endStroke();

    expect(layoutState.placements).toHaveLength(4);
    expect(layoutState.undoDepth).toBe(1);

    layoutState.undo();
    expect(layoutState.placements).toHaveLength(0);
  });

  it("treats two strokes as two undos", () => {
    const tiles = grassTiles(2);

    layoutState.beginStroke();
    layoutState.addPlacement(placementAt(tiles[0].x, tiles[0].y));
    layoutState.endStroke();

    layoutState.beginStroke();
    layoutState.addPlacement(placementAt(tiles[1].x, tiles[1].y));
    layoutState.endStroke();

    expect(layoutState.undoDepth).toBe(2);
    layoutState.undo();
    expect(layoutState.placements).toHaveLength(1);
  });

  it("records nothing for a write that changes nothing", () => {
    const grass = layoutState.grid.flat().find((t) => t.type === "grass")!;
    // Same type it already is: the no-op guard in `setTile` runs first, so
    // this must not spend an entry a real edit would need.
    layoutState.setTile(grass.x, grass.y, "grass");
    expect(layoutState.canUndo).toBe(false);
  });

  it("drops the redo branch once a new edit lands", () => {
    const tiles = grassTiles(2);
    layoutState.addPlacement(placementAt(tiles[0].x, tiles[0].y));
    layoutState.undo();
    expect(layoutState.canRedo).toBe(true);

    layoutState.addPlacement(placementAt(tiles[1].x, tiles[1].y));
    // The board Redo was holding no longer follows from the one on screen.
    expect(layoutState.canRedo).toBe(false);
  });

  it("undoes the readout's Reset", () => {
    const tiles = grassTiles(3);
    layoutState.beginStroke();
    for (const t of tiles) layoutState.addPlacement(placementAt(t.x, t.y));
    layoutState.endStroke();

    // The most destructive single press a player has on their own board.
    layoutState.clearPlacements();
    expect(layoutState.placements).toHaveLength(0);

    layoutState.undo();
    expect(layoutState.placements).toHaveLength(3);
  });

  it("restores a cleared obstacle through undo", async () => {
    const obstacle = layoutState.grid
      .flat()
      .find(
        (t) => t.type === "rock" || t.type === "tree1" || t.type === "tree2",
      );
    expect(obstacle).toBeDefined();
    const { x, y, type } = obstacle!;

    layoutState.setTile(x, y, "grass");
    expect(layoutState.grid[y][x].type).toBe("grass");

    layoutState.undo();
    expect(layoutState.grid[y][x].type).toBe(type);
  });

  it("never lets an undo cross a board", async () => {
    const [tile] = grassTiles(1);
    layoutState.addPlacement(placementAt(tile.x, tile.y));
    expect(layoutState.canUndo).toBe(true);

    // A different island arrives; the previous board's history describes
    // terrain this one does not have.
    await layoutState.loadTemplate(ISLAND_TEMPLATES[1], {});

    expect(layoutState.canUndo).toBe(false);
    expect(layoutState.canRedo).toBe(false);
    expect(layoutState.undo()).toBe(false);
  });

  it("caps the stack rather than growing without limit", () => {
    const tiles = grassTiles(1);
    // Well past MAX_HISTORY (30): alternate add/remove on one tile so every
    // write is a real change.
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0)
        layoutState.addPlacement(placementAt(tiles[0].x, tiles[0].y));
      else layoutState.removePlacement(tiles[0].x, tiles[0].y);
    }
    expect(layoutState.undoDepth).toBeLessThanOrEqual(30);
    expect(layoutState.undoDepth).toBeGreaterThan(0);
  });

  it("copies a layout in as one undoable step", () => {
    const tiles = grassTiles(3);
    // Something already built by hand, so the copy has work to overwrite.
    layoutState.addPlacement(placementAt(tiles[0].x, tiles[0].y));
    expect(layoutState.placements).toHaveLength(1);

    const solved = [
      placementAt(tiles[0].x, tiles[0].y),
      placementAt(tiles[1].x, tiles[1].y),
      placementAt(tiles[2].x, tiles[2].y),
    ];
    layoutState.adoptPlacements(solved);
    expect(layoutState.placements).toHaveLength(3);

    // A copy, not a reference: the solve's own array must not be reachable
    // from the board, or editing one would silently rewrite the other.
    expect(layoutState.placements[0]).not.toBe(solved[0]);

    // One entry, so the board the copy replaced comes back whole.
    layoutState.undo();
    expect(layoutState.placements).toHaveLength(1);
    expect(layoutState.placements[0].x).toBe(tiles[0].x);
  });

  /*
   * Measured as deltas rather than absolutes: `beforeEach` re-hydrates a
   * singleton whose `resetTemplate` only reapplies when the active template
   * matches, so what a test inherits depends on the one before it. What is
   * being pinned here is what cancelling *changes*, which is the same
   * either way.
   */
  it("erases a cancelled stroke without leaving an undo entry", () => {
    const [a] = grassTiles(1);
    const placed = layoutState.placements.length;
    const depth = layoutState.undoDepth;

    layoutState.beginStroke();
    layoutState.addPlacement(placementAt(a.x, a.y));
    expect(layoutState.placements).toHaveLength(placed + 1);
    expect(layoutState.undoDepth).toBe(depth + 1);

    /*
     * The press turned out to be the first finger of a pinch. It is erased
     * rather than reversed: the user never asked for it, so Undo must not have
     * to be spent putting it back.
     */
    expect(layoutState.cancelStroke()).toBe(true);
    expect(layoutState.placements).toHaveLength(placed);
    expect(layoutState.undoDepth).toBe(depth);
  });

  it("gives the redo branch back when a stroke is cancelled", () => {
    const [a, b] = grassTiles(2);

    layoutState.addPlacement(placementAt(a.x, a.y));
    layoutState.undo();
    const branch = layoutState.redoDepth;
    expect(branch).toBeGreaterThan(0);

    // Writing normally is what discards Redo. A write that is then taken back
    // never happened, so it must not cost the user the branch they had.
    layoutState.beginStroke();
    layoutState.addPlacement(placementAt(b.x, b.y));
    layoutState.cancelStroke();

    expect(layoutState.redoDepth).toBe(branch);
    expect(layoutState.redo()).toBe(true);
  });

  it("reports nothing to cancel for a stroke that never wrote", () => {
    const depth = layoutState.undoDepth;
    layoutState.beginStroke();
    expect(layoutState.cancelStroke()).toBe(false);
    expect(layoutState.undoDepth).toBe(depth);
  });

  it("cancels a whole multi-tile stroke, not just its last write", () => {
    const tiles = grassTiles(3);
    const placed = layoutState.placements.length;

    layoutState.beginStroke();
    for (const t of tiles) layoutState.addPlacement(placementAt(t.x, t.y));
    expect(layoutState.placements).toHaveLength(placed + 3);

    layoutState.cancelStroke();
    expect(layoutState.placements).toHaveLength(placed);
  });

  it("refuses to record or undo on a previewed board", async () => {
    const code = await layoutState.exportBlueprint();
    expect(code).toBeTruthy();

    expect(await layoutState.loadPreview(code!, {})).toBe(true);
    expect(layoutState.isPreview).toBe(true);

    // Every write path is already closed in preview; these are the backstops.
    expect(layoutState.canUndo).toBe(false);
    expect(layoutState.undo()).toBe(false);
    expect(layoutState.redo()).toBe(false);

    // Nor may a layout be copied onto a board that is not the visitor's.
    const before = layoutState.placements.length;
    layoutState.adoptPlacements([placementAt(0, 0)]);
    expect(layoutState.placements).toHaveLength(before);

    await layoutState.exitPreview({});
  });
});
