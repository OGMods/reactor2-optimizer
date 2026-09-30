import type { BuildingDefinition } from "../solver/types";

/**
 * One upgrade the player means to buy: a building, and the tier it goes to.
 *
 * `level` is a 0-based upgrade index, the same convention `unlockedUpgrades`
 * uses, so the UI numbers it from 1 like every other tier button.
 */
export interface UpgradeStep {
  buildingId: string;
  level: number;
}

/**
 * How many upgrades a plan may hold.
 *
 * Every step is one more roster each kept layout has to be simulated under, and
 * past a handful the answer stops being a layout for today and becomes a layout
 * for a roster nobody holds yet. Three covers "the next few purchases", which
 * is what the feature is for.
 */
export const MAX_UPGRADE_STEPS = 3;

/** An upgrade plan reduced to the rosters a solve runs against. */
export interface ResolvedUpgradePlan {
  /**
   * The roster after the last step that still upgrades something — what the
   * search scores at. The player's own roster when no step does.
   */
  target: Record<string, number>;
  /**
   * Every roster before `target`, in buying order and starting with today's:
   * what a layout also has to *run* under. Empty when no step upgrades
   * anything, which is the same thing as having no plan.
   */
  along: Record<string, number>[];
  /**
   * Per input step, whether it still raises a tier. A step stops counting once
   * it is bought (the roster has caught up with it), when its building is
   * locked, or when an earlier step already took the building that far.
   */
  effective: boolean[];
}

/**
 * Resolves an ordered upgrade plan against the player's roster.
 *
 * The order is the buying order, and it is the point: a layout that survives
 * "cooler, then generator, then reactor" can overheat if the reactor comes
 * first, since more heat arrives before the cooling for it. So the plan is a
 * path, not a set, and each roster along it is the one before with one step
 * applied.
 *
 * A step that no longer upgrades anything is skipped rather than refused. The
 * usual reason is the best one — the player bought it — and the plan should
 * simply get shorter as it is carried out, not turn into an error.
 */
export function resolveUpgradePlan(
  buildings: readonly BuildingDefinition[],
  unlockedUpgrades: Record<string, number>,
  steps: readonly UpgradeStep[],
): ResolvedUpgradePlan {
  const along: Record<string, number>[] = [];
  const effective: boolean[] = [];
  let current = unlockedUpgrades;

  for (const step of steps.slice(0, MAX_UPGRADE_STEPS)) {
    const def = buildings.find((b) => b.id === step.buildingId);
    const held = current[step.buildingId];
    const raises =
      def !== undefined &&
      held !== undefined &&
      Number.isInteger(step.level) &&
      step.level > held &&
      step.level < def.levels.length;
    effective.push(raises);
    if (!raises) continue;
    along.push(current);
    current = { ...current, [step.buildingId]: step.level };
  }

  return { target: current, along, effective };
}
