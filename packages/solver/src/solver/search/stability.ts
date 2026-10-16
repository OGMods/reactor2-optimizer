import { EPS } from "../constants";
import type { IslandContext } from "../context";
import { type SimPlacedBuilding, simulateIsland } from "../simulate";
import type { EffectiveBuilding, Placement } from "../types";
import { isDirectProducer } from "./placement";

/**
 * What makes a layout an answer: every producer online, at the target and at
 * every step of an upgrade plan. See the stability rule in `placementSearch.ts`.
 */

/**
 * Tiles holding a generator or direct producer that generates no power —
 * either because it is overheating (waste above the cooling routed to it) or
 * because it never received any heat at all.
 *
 * A layout containing one of these is not a valid answer: the goal is a fully
 * stable grid where every producer runs, so these tiles are wasted at best and
 * represent an overheating building at worst.
 */
export function offlineProducers(
  placement: Placement,
  rows: SimPlacedBuilding[],
): number[] {
  const offline: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    const building = placement[p.idx];
    if (building === null) continue;
    const producer =
      building.type === "generator" || isDirectProducer(building);
    if (producer && p.powerGenerated <= EPS) offline.push(p.idx);
  }
  return offline;
}

/**
 * A supplier sending out less than the tile it stands on was rated to carry —
 * the walk's cue that a generator beside it would have somewhere to put the
 * rest.
 *
 * Against `ratedValue`, never `baseValue`: `heatProduced` is what the
 * distribution actually sent, capped by the tile's RATING, so measuring it
 * against the authored tier compares a scaled delivery with an unscaled ceiling
 * and only calls a reactor under-fed below 1/k fill for a tile rated k — on a
 * Tidal shore k is its `multiplier`, under a maxed Stellar Forge the
 * research's. The move then stops firing on much of what it exists for, with
 * no number anywhere disagreeing. It is a named function so that the reading
 * can be pinned by a test rather than only stated here.
 */
export function isUnderFed(row: SimPlacedBuilding): boolean {
  return row.heatProduced > EPS && row.heatProduced < row.ratedValue - EPS;
}

/** Allocation-free `offlineProducers(...).length > 0`, for the search's inner loops. */
export function anyOfflineProducer(
  placement: Placement,
  rows: SimPlacedBuilding[],
): boolean {
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    const building = placement[p.idx];
    if (building === null) continue;
    const producer =
      building.type === "generator" || isDirectProducer(building);
    if (producer && p.powerGenerated <= EPS) return true;
  }
  return false;
}

/**
 * An upgrade plan: the rosters a layout has to stay stable under besides the
 * one it is scored at — the tiers the player holds today and every step on the
 * way to the target. Each step is keyed by building id, because a placement
 * holds the target roster's objects and the step's own figures are found by
 * id; a building the step does not have stands on its tile as nothing.
 *
 * A step is simulated with the rating its tiles give it (`ctx.rate`), so a
 * terrain bonus or a cooling pool applies at every step exactly as it does at
 * the target.
 */
interface UpgradePlan {
  steps: Map<string, EffectiveBuilding>[];
  /** Scratch the step layout is written into, one per island. */
  buffer: Placement;
}

/**
 * Held beside the context rather than on it, so the context type — and every
 * stage that takes one — is untouched when there is no plan, which is always
 * the case for the fixtures.
 */
export const upgradePlans = new WeakMap<IslandContext, UpgradePlan>();

/**
 * The producers that go offline under the first plan step the layout fails, or
 * null when it runs at every step. Free when the island has no plan.
 */
function planFailure(
  placement: Placement,
  ctx: IslandContext,
): number[] | null {
  const plan = upgradePlans.get(ctx);
  if (plan === undefined) return null;
  const buffer = plan.buffer;
  for (const step of plan.steps) {
    for (let t = 0; t < ctx.n; t++) {
      const b = placement[t];
      const at = b === null ? undefined : step.get(b.id);
      buffer[t] = at === undefined ? null : ctx.rate(t, at);
    }
    const sim = simulateIsland(buffer, ctx);
    const offline = offlineProducers(buffer, sim.placements);
    if (offline.length > 0) return offline;
  }
  return null;
}

/** Whether the layout runs at every step of the island's plan. */
export function planHolds(placement: Placement, ctx: IslandContext): boolean {
  return planFailure(placement, ctx) === null;
}

interface StableLayout {
  placement: Placement;
  power: number;
  rows: SimPlacedBuilding[];
}

/**
 * Drops producers that generate no power until every remaining one is online.
 *
 * This has to iterate rather than delete them all in one pass: removing an
 * offline generator hands the heat it was absorbing to its neighbours, which
 * can push THEIR waste past what their coolers cover and take them offline in
 * turn. Power can legitimately fall as a result — a layout that only scores
 * well by parking heat in an overheating building is not a layout we want.
 */
export function stabilize(
  placement: Placement,
  ctx: IslandContext,
): StableLayout {
  const current = placement.slice();
  let sim = simulateIsland(current, ctx);

  for (;;) {
    let offline = offlineProducers(current, sim.placements);
    // Stable at the target is not enough under a plan: a producer that
    // overheats at any step goes too, and so on until every step runs.
    if (offline.length === 0) offline = planFailure(current, ctx) ?? [];
    if (offline.length === 0) {
      return {
        placement: current,
        power: sim.totalPower,
        rows: sim.placements,
      };
    }
    for (const tile of offline) current[tile] = null;
    sim = simulateIsland(current, ctx);
  }
}
