import { asset } from "../utils";
import { buildingCategory, levelValue, type BuildingCategory } from "../data";
import type { BuildingDefinition, BuildingType } from "../types";

/**
 * The three figures the game states a building in, and the icon for each.
 *
 * They are shared rather than re-derived per component because the same three
 * appear in three places that are supposed to read alike — the sidebar's
 * catalogue card, the inspected tile in `BoardStatsCard`, and the run-again
 * dialog's power figure. `BoardStatsCard` is written in the catalogue card's
 * idiom deliberately (same icons, same label-left/chip-right shape), so that a
 * building reads the same wherever it appears; that claim held only because
 * three files happened to spell the same filename, which is exactly the kind
 * of agreement that lasts until someone renames an asset.
 *
 * `asset()` rather than a bare path: these resolve at runtime, and the app
 * ships to a GitHub Pages subpath where a leading slash 404s. See
 * `utils/assetUrl.ts`.
 */
export const STAT_ICON = {
  energy: asset("icons/icon_energy.webp"),
  heat: asset("icons/icon_heat.webp"),
  cooling: asset("icons/icon_cooling.webp"),
} as const;

/**
 * The figure a building's catalogue card is sized by, and the icon for it.
 *
 * One entry per UI group, so the mapping is exhaustive over `BuildingCategory`
 * by construction — a fourth group would fail to typecheck here rather than
 * falling through to a default that quietly showed the wrong unit.
 */
const CATEGORY_STAT: Record<BuildingCategory, { label: string; icon: string }> =
  {
    heat_producer: { label: "Heat Output", icon: STAT_ICON.heat },
    cooler: { label: "Waste Heat Cooling", icon: STAT_ICON.cooling },
    generator: { label: "Energy Output", icon: STAT_ICON.energy },
  };

/** What a building's headline figure is called, and what it is measured in. */
export function statForType(type: BuildingType): {
  label: string;
  icon: string;
} {
  return CATEGORY_STAT[buildingCategory(type)];
}

/**
 * The number that figure carries, for a building at a given unlock level.
 *
 * The companion to `statForType`: that says what the headline figure is
 * *called*, this says what it *is*. A generator's card shows the power it puts
 * out — its authored energy figure — while everything else is stated in the
 * one number its role is sized by, which is what `levelValue` resolves.
 *
 * Shared for the same reason the icons are. The sidebar's catalogue card
 * prints it and the HUD's palette sorts by it, and a palette ordered by a
 * different number from the one the card shows is a palette that looks
 * shuffled.
 *
 * `level` is clamped rather than trusted: a roster saved when a building had
 * more tiers than it does now would otherwise index past the end.
 */
export function headlineValue(bld: BuildingDefinition, level: number): number {
  const idx = Math.min(Math.max(level, 0), bld.levels.length - 1);
  if (idx < 0) return 0;
  return bld.type === "generator"
    ? bld.levels[idx].energy
    : levelValue(bld.levels[idx]);
}
