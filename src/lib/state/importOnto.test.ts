/**
 * A share code drawn on a shipped map may land on that island: the map with
 * obstacles cleared and buildings placed is exactly a saved layout there.
 * Anything else — another size, a painted tile, an obstacle added — is not
 * that island and still needs a custom slot.
 */
import {
  decodeBlueprint,
  encodeBlueprint,
  ISLAND_TEMPLATES,
  type Tile,
} from "@reactor2/solver";
import { describe, expect, it } from "vitest";
import { isObstacleType } from "../types/grid";
import { layoutState } from "./layout.svelte";

const island = ISLAND_TEMPLATES.find((t) => t.id === "island2")!;

async function mapGrid(): Promise<Tile[][]> {
  return (await decodeBlueprint(island.code)).grid;
}

const find = (grid: Tile[][], ok: (t: Tile) => boolean) =>
  grid.flat().find(ok)!;

describe("a share code drawn on a shipped map", () => {
  it("matches its island with obstacles cleared and buildings placed", async () => {
    const grid = await mapGrid();
    const rock = find(grid, (t) => isObstacleType(t.type));
    grid[rock.y][rock.x] = { ...rock, type: "grass" };
    const grass = find(grid, (t) => t.type === "grass");
    const code = await encodeBlueprint(grid, [
      { x: grass.x, y: grass.y, buildingId: "cooler1" },
    ]);
    expect((await layoutState.matchingTemplate(code))?.id).toBe(island.id);
  });

  it("does not match once a tile is painted or an obstacle added", async () => {
    const painted = await mapGrid();
    const water = find(painted, (t) => t.type === "water");
    painted[water.y][water.x] = { ...water, type: "grass" };
    expect(
      await layoutState.matchingTemplate(await encodeBlueprint(painted, [])),
    ).toBeNull();

    const added = await mapGrid();
    const grass = find(added, (t) => t.type === "grass");
    added[grass.y][grass.x] = { ...grass, type: "rock" };
    expect(
      await layoutState.matchingTemplate(await encodeBlueprint(added, [])),
    ).toBeNull();
  });

  it("lands on that island as its board, and opens it", async () => {
    await layoutState.hydrate({});
    const grid = await mapGrid();
    const grass = find(grid, (t) => t.type === "grass");
    const code = await encodeBlueprint(grid, [
      { x: grass.x, y: grass.y, buildingId: "cooler1" },
    ]);
    await layoutState.importOntoTemplate(code, island.id, { cooler1: 0 });
    expect(layoutState.activeTemplateId).toBe(island.id);
    expect(layoutState.placements).toHaveLength(1);
    expect(layoutState.isTemplateModified(island)).toBe(true);
    expect(layoutState.customIslands).toHaveLength(0);
  });

  it("refuses an island the code is not drawn on", async () => {
    const code = await encodeBlueprint(await mapGrid(), []);
    await expect(
      layoutState.importOntoTemplate(code, "island1", {}),
    ).rejects.toThrow("not drawn on that island");
  });
});
