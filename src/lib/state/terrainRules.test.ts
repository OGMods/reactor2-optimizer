/**
 * The two rules a shipped island enforces, and the undo that makes one of them
 * safe to live with:
 *
 *   1. Its terrain cannot be painted — it is the puzzle, not a canvas.
 *   2. Its obstacles *can* be cleared, because the game rewards that.
 *   3. So a clearance must be reversible, or rule 2 is a one-way trap whose
 *      only undo is Reset, which also discards every building placed.
 *
 * These live here rather than in the solver package's suite: they are app
 * rules, not anything the engine knows about.
 */
import { describe, expect, it } from "vitest";
import { layoutState } from "./layout.svelte";
import { editorState } from "./editor.svelte";
import { isObstacleType } from "../types/grid";
import { ISLAND_TEMPLATES } from "@reactor2/solver";
import { decodeBlueprint } from "@reactor2/solver";

describe("restore cleared obstacles", () => {
  it("round-trips a cleared obstacle on a shipped island", async () => {
    await layoutState.hydrate({});

    // Shipped island: terrain is locked, restore list starts empty.
    expect(layoutState.canEditTerrain).toBe(false);
    expect(layoutState.restorableObstacles).toHaveLength(0);

    // Find a real obstacle on the board.
    let target: { x: number; y: number; type: string } | null = null;
    for (const row of layoutState.grid) {
      for (const t of row) {
        if (isObstacleType(t.type)) {
          target = { x: t.x, y: t.y, type: t.type };
          break;
        }
      }
      if (target) break;
    }
    expect(target).not.toBeNull();
    const { x, y, type } = target!;

    editorState.eraseTile(x, y);
    expect(layoutState.grid[y][x].type).toBe("grass");

    const restorable = layoutState.restorableObstacles;
    expect(restorable).toContainEqual({ x, y, type });

    expect(layoutState.restoreObstacle(x, y)).toBe(true);
    expect(layoutState.grid[y][x].type).toBe(type);
    expect(layoutState.restorableObstacles).toHaveLength(0);
  });

  it("refuses to invent terrain on a tile that was never an obstacle", async () => {
    await layoutState.hydrate({});
    let grass: { x: number; y: number } | null = null;
    for (const row of layoutState.grid) {
      for (const t of row) {
        if (t.type === "grass") {
          grass = { x: t.x, y: t.y };
          break;
        }
      }
      if (grass) break;
    }
    expect(grass).not.toBeNull();
    expect(layoutState.restoreObstacle(grass!.x, grass!.y)).toBe(false);
    expect(layoutState.grid[grass!.y][grass!.x].type).toBe("grass");
  });

  it("terrain painting is refused on a shipped island", async () => {
    await layoutState.hydrate({});
    let grass: { x: number; y: number } | null = null;
    for (const row of layoutState.grid) {
      for (const t of row) {
        if (t.type === "grass") {
          grass = { x: t.x, y: t.y };
          break;
        }
      }
      if (grass) break;
    }
    editorState.activeTool = "water";
    editorState.paintTile(grass!.x, grass!.y);
    expect(layoutState.grid[grass!.y][grass!.x].type).toBe("grass");
    editorState.clearHand();
  });
});

describe("the transformer", () => {
  it("is the only one on every shipped map", async () => {
    for (const template of ISLAND_TEMPLATES) {
      const decoded = await decodeBlueprint(template.code);
      const count = decoded.grid
        .flat()
        .filter((t) => t.type === "transformer").length;
      expect(count, `${template.id} transformer count`).toBe(1);
    }
  });

  it("cannot be erased", async () => {
    await layoutState.hydrate({});

    const at = layoutState.findTransformer();
    expect(at).not.toBeNull();

    editorState.eraseTile(at!.x, at!.y);
    expect(layoutState.grid[at!.y][at!.x].type).toBe("transformer");

    // And so it never becomes a "cleared obstacle" that could be restored.
    expect(
      layoutState.restorableObstacles.some(
        (o) => o.x === at!.x && o.y === at!.y,
      ),
    ).toBe(false);
  });

  it("relocates rather than duplicating when painted on a custom island", async () => {
    const island = layoutState.addCustomIsland();
    expect(island).not.toBeNull();
    await layoutState.loadTemplate(island!, {});
    expect(layoutState.canEditTerrain).toBe(true);

    editorState.activeTool = "transformer";
    editorState.paintTile(1, 1);
    expect(layoutState.findTransformer()).toEqual({ x: 1, y: 1 });

    editorState.paintTile(3, 2);
    expect(layoutState.findTransformer()).toEqual({ x: 3, y: 2 });

    // Exactly one, not two.
    const count = layoutState.grid
      .flat()
      .filter((t) => t.type === "transformer").length;
    expect(count).toBe(1);

    editorState.clearHand();
    layoutState.deleteCustomIsland(island!.id);
  });
});
