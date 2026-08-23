import type { EffectiveBuilding, OptimizationResult, Tile } from "./types";

/**
 * Post-solve sanity checks. Port of `solver/report.py`.
 *
 * @lintignore deliberate public entry point with no in-app caller
 */
export function verify(
  grid: Tile[][],
  roster: EffectiveBuilding[],
  result: OptimizationResult,
): void {
  const seenTiles = new Set<string>();
  // Unlocked building ids may be placed on as many tiles as fit — there is no
  // per-id quantity limit, so this only checks that each placed id is an
  // unlocked/available building, not how many times it appears.
  const availableIds = new Set(roster.map((b) => b.id));

  for (const placement of result.placements) {
    const posKey = `${placement.x},${placement.y}`;

    // 1. No duplicate tiles
    if (seenTiles.has(posKey)) {
      throw new Error(
        `Duplicate tile found at (${placement.x}, ${placement.y})`,
      );
    }
    seenTiles.add(posKey);

    // 2. Grass-only
    if (grid[placement.y]?.[placement.x]?.type !== "grass") {
      throw new Error(
        `Building placed on non-grass tile at (${placement.x}, ${placement.y})`,
      );
    }

    // 3. Building is actually unlocked/available
    if (!availableIds.has(placement.buildingId)) {
      throw new Error(
        `Unavailable/locked building placed: ${placement.buildingId}`,
      );
    }
  }
}
