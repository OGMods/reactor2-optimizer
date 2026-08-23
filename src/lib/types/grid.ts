/**
 * The core tile model. Peer: `py_solver/solver/types.py` (`TileType` / `Tile`).
 *
 * `lib/solver/types.ts` keeps its own structurally-identical copy on purpose —
 * the solver is a self-contained data-contract module. `solver/typeContract.test.ts`
 * asserts the two stay assignable.
 */

export type TileType =
  "water" | "grass" | "rock" | "tree1" | "tree2" | "pond" | "transformer";

/** Only `grass` is buildable; every other type is an obstacle. */
export interface Tile {
  x: number;
  y: number;
  type: TileType;
}

/**
 * The clearable obstacles — everything that blocks building but is *on* the
 * land, as opposed to `water` (not part of the island) and `grass` (already
 * clear).
 *
 * This is the canonical set. `hud/ObstaclePalette.svelte` keeps its own list
 * of labels and icons for the ones it paints, but the semantic question
 * "is this an obstacle?" is answered here, because `layoutState` needs the
 * same answer to work out which cleared obstacles can be restored and cannot
 * import a component to ask.
 */
export const OBSTACLE_TILE_TYPES = [
  "rock",
  "tree1",
  "tree2",
  "pond",
  "transformer",
] as const satisfies readonly TileType[];

export function isObstacleType(type: TileType): boolean {
  return (OBSTACLE_TILE_TYPES as readonly TileType[]).includes(type);
}
