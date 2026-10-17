import type { PlacedBuilding } from "../types";
import type { EffectiveBuilding } from "@reactor2/solver";
import { findBuilding, levelValue } from "@reactor2/solver";
import { wasteIsCovered } from "@reactor2/solver";

/**
 * The value a building would be placed at right now: its tier at the player's
 * current unlock level.
 *
 * A building the player has since **locked** falls back to its first tier
 * rather than vanishing, which is the same reading `#applySaved` has always
 * given a saved board — a locked building is one the player cannot place, not
 * one their board forgets.
 *
 * Module-private: the two questions callers outside actually ask are "build me
 * a placement" and "re-read the ones I have", and both are answered below.
 * `levelIndexForValue` in `./buildings` is the inverse, and is public — the
 * readout needs it to name the tier a standing building is running at.
 */
function placementBaseValue(
  buildingId: string,
  unlockedUpgrades: Record<string, number>,
): number {
  const def = findBuilding(buildingId);
  if (!def) return 0;
  const level = unlockedUpgrades[buildingId] ?? 0;
  return levelValue(def.levels[Math.min(level, def.levels.length - 1)]);
}

/**
 * Re-reads every placement's tier from the player's current unlocks, or
 * `null` when not one of them moved.
 *
 * A placement records the *value* it was placed at, so buying a tier behind a
 * standing building leaves it running at the old one until something re-reads
 * it. Both boards have to do that and both have to know whether anything
 * actually changed — re-scoring a board nothing happened to is wasted work,
 * and for the solve it is a wasted write to storage as well. Returning `null`
 * for "unchanged" is what lets each caller bail before paying for either.
 *
 * Unchanged placements keep their identity rather than being copied, so a
 * board where one tier moved re-scores one object and reuses the rest.
 *
 * The one board this must never be applied to is a **preview**: it is rated at
 * its author's tiers, and the reader's roster does not speak for it. That call
 * is the caller's — see `layoutState.rebasePlacements`.
 */
export function rebaseToUnlocks(
  placements: readonly PlacedBuilding[],
  unlockedUpgrades: Record<string, number>,
): PlacedBuilding[] | null {
  let changed = false;
  const rebased = placements.map((p) => {
    const baseValue = placementBaseValue(p.buildingId, unlockedUpgrades);
    if (baseValue === p.baseValue) return p;
    changed = true;
    return { ...p, baseValue };
  });
  return changed ? rebased : null;
}

/**
 * An unscored placement: what it is, where it stands, and what tier it is
 * rated at, with every derived figure at zero.
 *
 * Four places build this record and they differ only in how they answer "which
 * tier" — the player's unlock level, a tier named outright by a share code, a
 * tier read back from storage, or the one a placement already carries as it
 * goes in to be re-scored. Everything else about it is identical, and it is
 * the *zeroes* that matter: `simulatePlacedBuildings` fills the derived
 * figures in and is the only thing that may, so a copy that forgot to reset
 * one would carry a stale number into a fresh score.
 */
export function unscoredPlacement(
  buildingId: string,
  x: number,
  y: number,
  baseValue: number,
): PlacedBuilding {
  return {
    x,
    y,
    buildingId,
    baseValue,
    powerGenerated: 0,
    heatProduced: 0,
    heatConsumed: 0,
    wasteHeatGenerated: 0,
    coolingProvided: 0,
    coolingReceived: 0,
  };
}

/**
 * Builds a fresh `PlacedBuilding` for a building id at a tile.
 *
 * `baseValue` is read from the player's *current* unlock level, so a placement
 * restored from storage picks up any upgrades bought since it was saved.
 */
export function createPlacement(
  buildingId: string,
  x: number,
  y: number,
  unlockedUpgrades: Record<string, number>,
): PlacedBuilding {
  return unscoredPlacement(
    buildingId,
    x,
    y,
    placementBaseValue(buildingId, unlockedUpgrades),
  );
}

/**
 * Builds a `PlacedBuilding` at an explicit upgrade tier, ignoring what the
 * viewer has unlocked.
 *
 * This is the shared-board case and the only one: a blueprint that carries a
 * tier table is describing *someone else's* buildings, and showing them at the
 * reader's own levels would put figures on screen that the author never saw.
 * Everything the player owns goes through `createPlacement` instead, which is
 * what keeps their board tracking their own upgrades.
 *
 * The level is clamped rather than rejected — a code naming a tier this build
 * of the catalogue does not have is a newer roster, not a corrupt payload, and
 * the top tier is the closest true thing to show.
 */
export function createPlacementAtLevel(
  buildingId: string,
  x: number,
  y: number,
  level: number,
): PlacedBuilding {
  const def = findBuilding(buildingId);
  const clamped = def ? Math.max(0, Math.min(level, def.levels.length - 1)) : 0;
  return unscoredPlacement(
    buildingId,
    x,
    y,
    def ? levelValue(def.levels[clamped]) : 0,
  );
}

/**
 * What a placed building is doing, once the board has been scored.
 *
 * - `active` — it is producing, consuming or cooling something.
 * - `starved` — it makes waste heat the cooling routed to it does not cover,
 *   so the game shuts it down entirely. It still shows heat moving through it.
 * - `idle` — every figure is zero: a generator with no reactor beside it, a
 *   cooler nobody draws from, a reactor with nowhere to send its heat.
 */
export type PlacementStatus = "active" | "starved" | "idle";

/**
 * Classifies a scored placement. The two failure modes are kept apart because
 * they have different fixes — a starved building needs cooling, an idle one
 * needs a neighbour — even where the board draws both the same way.
 *
 * The starved test is `wasteIsCovered`, the solver's own online rule, rather
 * than a bare `<`: that is what decides whether the building produced power,
 * so anything else here could paint a running building red.
 */
export function placementStatus(p: PlacedBuilding): PlacementStatus {
  if (
    p.wasteHeatGenerated > 0 &&
    !wasteIsCovered(p.wasteHeatGenerated, p.coolingReceived)
  ) {
    return "starved";
  }
  if (
    p.powerGenerated <= 0 &&
    p.heatProduced <= 0 &&
    p.heatConsumed <= 0 &&
    p.coolingProvided <= 0
  ) {
    return "idle";
  }
  return "active";
}

/**
 * How hard a scored building is working, as a whole percentage of what its
 * tile rated it for — the gauge the game prints over every building.
 *
 * One figure per role, and it is the one the game fills: the heat a reactor
 * sends out, the heat a generator takes in (600 of 852 reads 70%), the cooling
 * a cooler gives, the energy a direct producer makes. A generator is gauged by
 * its *input* rather than its energy so a starved one still says how much heat
 * is reaching it — its pad already says that none of it is turning into power.
 *
 * `rated` must come from the scorer (`ratedPlacements`), not the roster: the
 * figure is only a fraction of the ceiling it was measured against.
 */
export function placementFillPercent(
  p: PlacedBuilding,
  rated: EffectiveBuilding,
): number {
  let used: number;
  let max: number;
  switch (rated.type) {
    case "cooler":
      used = p.coolingProvided;
      max = rated.effectiveValue;
      break;
    case "reactor":
      used = p.heatProduced;
      max = rated.effectiveValue;
      break;
    case "generator":
      used = p.heatConsumed;
      max = rated.effectiveValue;
      break;
    case "direct_producer":
      used = p.powerGenerated;
      max = rated.energy;
      break;
  }
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((used / max) * 100)));
}

/**
 * What the game would call a placed building's state — the finer reading its
 * status panel and board icons use, where `PlacementStatus` is the three-way
 * one the pads and the readout's counts speak.
 *
 * Every case is the game's own term, defined by its own description text:
 *
 * - `offline` — nothing it can work with is adjacent. "Place a Generator on an
 *   adjacent tile to power it up." A generator with no heat source beside it,
 *   a reactor with no generator, a cooler with no power source.
 * - `idle` — partners are adjacent but nothing flows, so it is not needed:
 *   "Generators are nearby but don't need heat. They may be saturated."
 * - `overheated` — a power source whose waste the cooling does not cover, and
 *   which has shut down. (`starved`, in `PlacementStatus`.)
 * - `wasting_heat` — a generator "running at full capacity, but nearby heat
 *   producers are generating more heat than it can handle". The game only
 *   says so once a reactor beside it leaves more than `WASTING_UNUSED_SHARE`
 *   of its heat unsent: a reactor at 91% does not trip it.
 * - `stable` / `online` — working: `stable` for a power source, `online` for
 *   a reactor or cooler, as the game words it.
 */
export type GameStatus =
  "offline" | "idle" | "overheated" | "wasting_heat" | "stable" | "online";

/** Within this fraction of a ceiling counts as at it — float noise, not slack. */
const AT_CAPACITY = 1e-6;

/**
 * How much of an adjacent reactor's heat has to go unsent before the game
 * calls a full generator "wasting heat" — more than a tenth. Below that it
 * still reads Stable, so a reactor at 91% use beside a full generator shows
 * nothing.
 */
const WASTING_UNUSED_SHARE = 0.1;

/**
 * The game's state for each placement, aligned with `placements`.
 *
 * `rated` is `ratedPlacements` over the same rows — a generator is only at full
 * capacity, and a reactor only has heat left over, against what its tile rated
 * it for. `sharedCooling` is the Cryo Nexus pool, under which a cooler serves
 * every power source on the board rather than its neighbours, so being offline
 * is a question about the board and not about the tiles around it.
 *
 * Adjacency is the game's: the eight tiles around, corners included.
 */
export function gameStatuses(
  placements: readonly PlacedBuilding[],
  rated: readonly (EffectiveBuilding | null)[],
  sharedCooling = false,
): GameStatus[] {
  const at = new Map<string, number>();
  placements.forEach((p, i) => at.set(`${p.x},${p.y}`, i));
  const roleOf = (i: number) =>
    rated[i]?.type ?? findBuilding(placements[i].buildingId)?.type;

  function neighbours(p: PlacedBuilding): number[] {
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const j = at.get(`${p.x + dx},${p.y + dy}`);
        if (j !== undefined) out.push(j);
      }
    return out;
  }

  const isPowerSource = (i: number) => {
    const r = roleOf(i);
    return r === "generator" || r === "direct_producer";
  };
  const anyPowerSource = placements.some((_, i) => isPowerSource(i));

  /** Whether anything this building can work with is in reach. */
  function hasPartner(i: number): boolean {
    const near = neighbours(placements[i]);
    switch (roleOf(i)) {
      case "generator":
        return near.some((j) => roleOf(j) === "reactor");
      case "reactor":
        return near.some((j) => roleOf(j) === "generator");
      case "cooler":
        return sharedCooling ? anyPowerSource : near.some(isPowerSource);
      default:
        return false;
    }
  }

  /** A full generator beside a reactor leaving over a tenth of its heat. */
  function isWastingHeat(i: number): boolean {
    const max = rated[i];
    if (!max || max.type !== "generator" || !(max.effectiveValue > 0)) {
      return false;
    }
    const full =
      placements[i].heatConsumed >= max.effectiveValue * (1 - AT_CAPACITY);
    if (!full) return false;
    return neighbours(placements[i]).some((j) => {
      const r = rated[j];
      return (
        r?.type === "reactor" &&
        placements[j].heatProduced <
          r.effectiveValue * (1 - WASTING_UNUSED_SHARE)
      );
    });
  }

  return placements.map((p, i) => {
    switch (placementStatus(p)) {
      case "starved":
        return "overheated";
      case "idle":
        return hasPartner(i) ? "idle" : "offline";
      case "active": {
        const role = roleOf(i);
        if (role === "generator" || role === "direct_producer") {
          return isWastingHeat(i) ? "wasting_heat" : "stable";
        }
        return "online";
      }
    }
  });
}
