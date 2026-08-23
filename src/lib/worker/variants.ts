import { buildOptimizationResult, type IslandPlan } from "../solver/solver";
import { layoutKey, powerTies } from "../solver/alternates";
import type { IslandSolution } from "../solver/placementSearch";
import type { OptimizationResult } from "../solver/types";

/**
 * Turns per-island shortlists into whole-board layouts that all put out the
 * same power.
 *
 * Islands never interact, so swapping one island's layout for another of its
 * ties leaves every other island — and the board's total — exactly where it
 * was. That is what makes the shortlist cheap: the search does not have to
 * find ten whole-board answers, only ties per island, and the combinations
 * come out of the arithmetic.
 *
 * Variants are generated one island at a time, cycling across the islands
 * rather than exhausting one of them first, so an early pick differs from the
 * primary somewhere different each time instead of rearranging the same corner
 * ten ways. Once every single-island swap is used up, the remaining slots take
 * combinations that move every island at once.
 */

/** How many whole-board layouts the app keeps for one solve. */
export const MAX_SOLVE_VARIANTS = 10;

/**
 * All of them, best first: `[0]` is the layout the search actually settled on,
 * and everything after it ties that layout's power.
 */
export function buildSolveVariants(
  plan: IslandPlan,
  islandResults: IslandSolution[],
  limit: number = MAX_SOLVE_VARIANTS,
): OptimizationResult[] {
  const primary = buildOptimizationResult(plan, islandResults);
  const variants = [primary];
  const seen = new Set([layoutKey(primary.placements)]);

  const depth = islandResults.reduce(
    (max, island) => Math.max(max, island.alternates?.length ?? 0),
    0,
  );
  if (depth === 0) return variants;

  const take = (swapped: IslandSolution[]) => {
    const candidate = buildOptimizationResult(plan, swapped);
    // The islands were solved independently, so this should hold by
    // construction — but a variant that does not tie is not what the card is
    // about to promise the user, and dropping it is cheaper than explaining it.
    if (!powerTies(candidate.totalPower, primary.totalPower)) return;

    const key = layoutKey(candidate.placements);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(candidate);
  };

  for (let d = 0; d < depth && variants.length < limit; d++) {
    for (let i = 0; i < islandResults.length && variants.length < limit; i++) {
      const alternate = islandResults[i].alternates?.[d];
      if (alternate === undefined) continue;
      const swapped = islandResults.slice();
      swapped[i] = alternate;
      take(swapped);
    }
  }

  // Only reachable on a board of several islands, where the single-island
  // swaps run out before the shortlist is full.
  for (let d = 0; d < depth && variants.length < limit; d++) {
    const swapped = islandResults.map(
      (island) => island.alternates?.[d] ?? island,
    );
    take(swapped);
  }

  return variants;
}
