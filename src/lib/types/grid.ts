/**
 * Which tiles an editor may clear, and what a cleared one used to be.
 *
 * The tile model itself — `Tile`, `TileType`, and the rule that only `grass`
 * is buildable — belongs to `@reactor2/solver`, which is the thing that has to
 * agree with the game. It is re-exported here so app code can go on importing
 * the whole model from `lib/types`.
 */
import type { TileType } from "@reactor2/solver";

export type { Tile, TileType } from "@reactor2/solver";

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
