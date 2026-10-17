import type { AnomalyDefinition, BuildingType } from "@reactor2/solver";
import type { RatingShift } from "../simulation/simulator";
import type { GameStatus } from "./placements";

/**
 * The per-building icons the game draws on the board, by the name of the file
 * each ships as (`icons/<name>.webp`). Both families are read straight out of
 * the game: the state icons are `SpritesDB`'s per-state sprites, and the
 * anomaly icons are the sprites each anomaly hands its `anomalyIconRenderer`.
 */
export const BOARD_ICONS = [
  "status_offline",
  "status_idle",
  "status_overheated",
  "status_gauge",
  "anomaly_buff_isolated",
  "anomaly_buff_crowded",
  "anomaly_buff_waterside",
  "anomaly_buff_cooling_pool",
] as const;

export type BoardIcon = (typeof BOARD_ICONS)[number];

/**
 * The icon over a building, by the game's state for it, or null over one that
 * is simply working.
 *
 * `SpritesDB`'s sprites, chosen by what each state asks of the player: the red
 * triangle (NotWorking) for a building with nothing to work with beside it,
 * zzz (Idle) for one whose partners do not need it, the warning thermometer
 * (Overheated) for a power source shut down by its waste, and the gauge for a
 * generator that cannot take what its reactors offer — the prefab's own
 * `ICON_wastingheatStatus` child, which is the same `status_gauge` sprite the
 * fill badge carries, not `SpritesDB`'s WastingHeat thermometer. The game's Stable and Online sprites are left off the board on
 * purpose — it draws nothing over a building that is fine, and nor does this.
 */
export const STATE_ICON: Record<GameStatus, BoardIcon | null> = {
  offline: "status_offline",
  idle: "status_idle",
  overheated: "status_overheated",
  wasting_heat: "status_gauge",
  stable: null,
  online: null,
};

/**
 * The anomaly icon at a building's foot, or null for none.
 *
 * `shift` is whether the scorer rated this building above or below its plain
 * tier (`ratingShifts`), which is what decides *whether* an icon shows; the
 * rule only decides *which*. Keyed on the rule rather than the anomaly id
 * because each rule's art is the same across its variants — the pre-nerf Tidal
 * wears the same wave as the live one.
 *
 * - **Role isolation** (Singularity) has both directions: the game's
 *   `boostedIcon` for a generator standing alone, `downgradedIcon` for one
 *   touching another.
 * - **Terrain affinity** (Tidal) only ever raises a waterside building.
 * - **Shared cooling** (Cryo Nexus) scales every cooler, and the game marks
 *   each one with its cooler icon whichever way the scale points.
 */
export function anomalyIconFor(
  anomaly: AnomalyDefinition,
  shift: RatingShift | null,
  role: BuildingType,
): BoardIcon | null {
  if (shift === null) return null;
  switch (anomaly.rule) {
    case "role_isolation":
      return shift === "up" ? "anomaly_buff_isolated" : "anomaly_buff_crowded";
    case "terrain_affinity":
      return shift === "up" ? "anomaly_buff_waterside" : null;
    case "shared_cooling":
      return role === "cooler" ? "anomaly_buff_cooling_pool" : null;
    case "baseline":
      return null;
  }
}
