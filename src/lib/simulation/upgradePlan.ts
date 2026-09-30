import {
  BUILDINGS,
  type AnomalyDefinition,
  type PrestigeScales,
  type ResolvedUpgradePlan,
} from "@reactor2/solver";
import { placementStatus, rebaseToUnlocks } from "../data/placements";
import type { PlacedBuilding, Tile } from "../types";
import { simulatePlacedBuildings } from "./simulator";

/** How a layout fares as the player works through their upgrade plan. */
export interface PlanReport {
  /** Power once every step is bought — what a plan solve is scored at. */
  power: number;
  /**
   * The first step after which a building on the layout overheats, as an
   * index into the player's plan list, or null when it runs at every step.
   */
  failedStep: number | null;
  /** How many buildings overheat at `failedStep`; 0 when nothing fails. */
  overheating: number;
  /**
   * Buildings idle today that are working once the plan is bought — mostly
   * coolers a plan holds back for heat that has not arrived yet.
   *
   * Counted so the readout can tell them apart from idle buildings that are
   * simply wasted: both read as idle today, and only one of them should be
   * torn down. Printed as idle, the reserve the plan paid for is exactly what
   * a tidy player would remove.
   */
  reserved: number;
}

/**
 * Scores a layout at each step of an upgrade plan, re-reading every
 * placement's tier from that step's roster the way buying the upgrade would.
 *
 * Today's roster is not re-checked: the placements already carry today's
 * tiers, and their own figures are the board's — which is also what
 * `reserved` reads, so they must arrive scored. What this adds is the future,
 * so it answers for **any** layout, not only one searched under the plan: a
 * solve found without it is told plainly that the upgrade will shut part of
 * it down, rather than finding out in the game.
 *
 * Every step goes through `simulatePlacedBuildings`, the scorer that rates the
 * board on screen, so the report and the readout above it cannot disagree about
 * what a building does.
 *
 * Null when the plan upgrades nothing, which is the same as having no plan.
 */
export function evaluatePlan(
  grid: Tile[][],
  placements: readonly PlacedBuilding[],
  plan: ResolvedUpgradePlan,
  prestige: PrestigeScales | undefined,
  anomaly: AnomalyDefinition,
): PlanReport | null {
  if (plan.along.length === 0) return null;

  // The rosters after each effective step: the rest of `along`, then the
  // target. `along[0]` is today.
  const rosters = [...plan.along.slice(1), plan.target];
  const stepIndices = plan.effective.flatMap((on, i) => (on ? [i] : []));

  const report: PlanReport = {
    power: 0,
    failedStep: null,
    overheating: 0,
    reserved: 0,
  };
  for (let k = 0; k < rosters.length; k++) {
    const rebased = rebaseToUnlocks(placements, rosters[k]) ?? placements;
    const scored = simulatePlacedBuildings(
      grid,
      BUILDINGS,
      rebased as PlacedBuilding[],
      prestige,
      anomaly,
    );
    // Every step is scored even after one fails: the power at the end is what
    // the player ends up with either way, and printing it beside the failure
    // is what says how much the failure costs.
    if (report.failedStep === null) {
      const overheating = scored.filter(
        (p) => placementStatus(p) === "starved",
      ).length;
      if (overheating > 0) {
        report.failedStep = stepIndices[k];
        report.overheating = overheating;
      }
    }
    if (k === rosters.length - 1) {
      report.power = scored.reduce((sum, p) => sum + p.powerGenerated, 0);
      // `placements` carry today's figures and `scored` is in the same order.
      report.reserved = placements.filter(
        (p, i) =>
          placementStatus(p) === "idle" &&
          placementStatus(scored[i]) === "active",
      ).length;
    }
  }

  return report;
}
