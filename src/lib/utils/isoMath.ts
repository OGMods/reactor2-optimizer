/**
 * Isometric projection math.
 *
 * Grid -> screen only. There is no inverse transform anywhere in the app:
 * hit-testing is done with per-tile diamond `hitArea` polygons in `gridPainter.ts`.
 */

export interface IsoPoint {
  x: number;
  y: number;
}

// The game's own cell size in Unity world units. Not exported: nothing outside
// this file wants them, only the two figures derived from them below.
const UNITY_CELL_WIDTH = 0.82;
const UNITY_CELL_HEIGHT = 0.48;
export const TILE_WIDTH = 164;
export const TILE_HEIGHT = TILE_WIDTH * (UNITY_CELL_HEIGHT / UNITY_CELL_WIDTH);
export const PIXELS_PER_WORLD_UNIT = TILE_WIDTH / UNITY_CELL_WIDTH;

/**
 * Converts 2D grid coordinates (x, y) to Isometric screen coordinates.
 */
export function gridToIso(x: number, y: number): IsoPoint {
  return {
    x: (x - y) * (TILE_WIDTH / 2),
    y: (x + y) * (TILE_HEIGHT / 2),
  };
}

/**
 * Calculates rendering z-order index based on grid coordinates.
 * In isometric projection, items higher up (lower x + y) are drawn first.
 */
export function getIsoDepth(x: number, y: number): number {
  return x + y;
}
