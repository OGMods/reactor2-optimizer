/**
 * Game-rule constants and the grid adjacency primitives every solver stage
 * shares. See `docs/game-logic.md` for the authoritative rules; the adjacency
 * geometry these pair with lives in `context.ts`.
 */

/**
 * The conversion every generator in the game has used so far. It is NOT a rule
 * of the game: each generator tier authors its own EnergyPerTick and
 * WasteHeatPerTick, and `physics.ts` reads those. These two are the fallback
 * for a roster that authors neither.
 */
export const GENERATOR_ENERGY_RATIO = 0.75;
export const GENERATOR_WASTE_RATIO = 0.25;

/** Matches `HeatFlowTolerance.Floor` in the Unity flow solver. */
export const EPS = 1e-6;

/** 8-directional Chebyshev neighbor relative offsets [dx, dy]. */
export const CHEBYSHEV_DIRECTIONS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Comparator for the game's explicit processing order: ascending X, then
 * descending Y — the key `(x, -y)`, spelled as a comparator.
 */
export function spatialKeyCompare(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return b[1] - a[1];
}
