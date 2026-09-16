/**
 * Tile predicates and the ASCII tile alphabet.
 *
 * `isIslandTile` is the renderer's and the decomposer's shared question — the
 * solver's own copy of the buildable test lives in `solver/island.ts`, where it
 * is on the hot path. `TILE_CHAR_MAP` is the alphabet the tests are written in,
 * via `makeGrid(["GGG", "G.G"])`.
 *
 * The wire format is a blueprint code — see `encoding/blueprint.ts`. Nothing
 * here decodes one.
 */
import type { Tile, TileType } from "./solver/types";

/**
 * Tile character → tile type. Only `grass` is buildable; every other type is
 * scenery that blocks placement.
 */
export const TILE_CHAR_MAP: Readonly<Record<string, TileType>> = {
  ".": "water",
  G: "grass",
  R: "rock",
  T: "tree1",
  U: "tree2",
  O: "pond",
  X: "transformer",
};

/** True for any land tile (buildable or scenery), i.e. anything but water. */
export function isIslandTile(tile: Tile | null | undefined): boolean {
  return tile != null && tile.type !== "water";
}

/**
 * Builds a tile grid from an ASCII picture, one string per row (y).
 *
 *     makeGrid(["GGG", "G.G"])
 *
 * Exported rather than kept in the test helpers because the CLI reads boards
 * the same way, and an alphabet with two readings is an alphabet with a bug.
 */
export function makeGrid(rows: readonly string[]): Tile[][] {
  const width = rows.length > 0 ? rows[0].length : 0;
  if (!rows.every((r) => r.length === width)) {
    throw new Error("makeGrid rows must be equal length");
  }
  return rows.map((row, y) =>
    [...row].map((char, x): Tile => {
      const type = TILE_CHAR_MAP[char];
      if (type === undefined) {
        throw new Error(`makeGrid: '${char}' is not a tile character`);
      }
      return { x, y, type };
    }),
  );
}
