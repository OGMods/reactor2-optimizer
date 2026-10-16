import type { IslandContext } from "../context";
import { wasteIsCovered } from "../physics";
import { type SimPlacedBuilding, simulateIsland } from "../simulate";
import type { EffectiveBuilding, Placement } from "../types";
import { emptyPlacement, isReactor, put } from "./placement";
import { anyOfflineProducer, planHolds } from "./stability";

/**
 * Right-sizing the finished layout: every building swapped for the smallest
 * tier that still carries the load the layout gives it.
 */

/**
 * The roles a finished layout can be re-tiered in. A direct producer always
 * runs flat out on its own, so there is no slack in one to give back — a
 * smaller tier is simply less power, and the power guard below would reject it
 * anyway. The other three are sized against a load the finished layout fixes,
 * and any capacity above that load is money spent on a building that never
 * uses it.
 */
export const DOWNGRADE_ROLES: ReadonlySet<string> = new Set([
  "cooler",
  "reactor",
  "generator",
]);

/**
 * True when `capacity` meets `load` at the game's own relative tolerance.
 *
 * This is `wasteIsCovered`, whose parameters are named for the cooling case it
 * was written for; the tolerance has to be relative here for the same reason it
 * does there — at 1e18 one ULP is already ~1e2, so an absolute epsilon would
 * reject a tier that is exactly big enough.
 */
export function covers(capacity: number, load: number): boolean {
  return wasteIsCovered(load, capacity);
}

/**
 * What a placed building is actually doing, in the units its tier is sized in.
 *
 * Cooling sent for a cooler, heat sent for a reactor, heat absorbed for a
 * generator — the figure a replacement tier has to be able to match for the
 * rest of the layout to keep behaving the same way.
 */
export function tileLoad(
  building: EffectiveBuilding,
  row: SimPlacedBuilding,
): number {
  if (building.type === "cooler") return row.coolingProvided;
  if (isReactor(building)) return row.heatProduced;
  return row.heatConsumed;
}

/**
 * The capacity `candidate` would actually run at on `tile` in this layout —
 * `tileLoad`'s units, so the two can be compared.
 *
 * `ctx.rate` answers this for every rule but one: a role isolation multiplier is
 * a function of what a tile's NEIGHBOURS are, so `rate` is the identity under it
 * and `simulateIsland` resolves it per layout through `rateIsolated` instead.
 * That leaves right-sizing measuring a load rated by `isolated` against an
 * unrated capacity: an isolated generator authored 320, rated 1280 (at the
 * `isolated` the rule shipped with) and absorbing 300, was never offered the
 * authored 120 tier that covers it at its own rating of 480, so the pass left
 * 980 of intake nobody pays it to have — which is exactly the money it
 * exists to hand back. In the other direction the plain figure is over-generous,
 * and there the re-simulation below catches it, so only the waste escaped.
 *
 * The neighbour scan mirrors `simulateIsland`'s: it reads what a neighbour *is*,
 * which the swap cannot change — the ladder is one role deep, so a re-tiered
 * generator is still a generator and every tile's crowding survives the pass.
 */
function ratedCapacity(
  ctx: IslandContext,
  placement: Placement,
  tile: number,
  candidate: EffectiveBuilding,
): number {
  const isolation = ctx.isolation;
  if (isolation === null || candidate.type !== isolation.role) {
    return candidate.effectiveValue;
  }

  const neighbors = ctx.neighbors[tile];
  let crowded = false;
  for (let k = 0; k < neighbors.length; k++) {
    const other = placement[neighbors[k]];
    if (other !== null && other.type === isolation.role) {
      crowded = true;
      break;
    }
  }
  return ctx.rateIsolated(candidate, crowded).effectiveValue;
}

/** Each downgradable role's roster entries, smallest capacity first. */
export function downgradeTiers(
  effectiveBuildings: EffectiveBuilding[],
): Map<string, EffectiveBuilding[]> {
  const tiers = new Map<string, EffectiveBuilding[]>();
  for (const role of DOWNGRADE_ROLES) {
    tiers.set(
      role,
      effectiveBuildings
        .filter((b) => b.type === role)
        .sort((a, b) => a.effectiveValue - b.effectiveValue),
    );
  }
  return tiers;
}

/**
 * Final pass: replace every building with the smallest tier that still does the
 * job the finished layout gives it. Port of `_downgrade_oversized`.
 *
 * The search maximizes power, and power cannot tell a cooler running flat out
 * from one running at 2%: both keep the same generators online, so both score
 * identically and the search has no reason to prefer either. It therefore
 * leaves the roster's top tier on tiles that need a twentieth of it, which
 * costs the player real money for capacity that never runs. This is why the
 * pass belongs after the search rather than inside it — only once the layout
 * stops moving is the load on each tile settled enough to size against.
 *
 * Covering the tile's current load is what makes a candidate plausible, not
 * what makes it safe: shrinking a supplier changes the FairShare split, and the
 * split is what decides which producers clear their cooling. So every swap is
 * re-simulated and accepted only under the test `pruneDeadWeight` applies to a
 * removal — no power lost against the layout handed in, and no producer left
 * offline. Power is defended against the figure this pass started from rather
 * than against the running total, so a sequence of swaps cannot drift down one
 * tolerance at a time.
 *
 * The sweep repeats to a fixpoint: downgrading a generator changes the waste
 * its cooler has to absorb, which can free a cooler this sweep already walked
 * past. It terminates because every accepted swap strictly lowers one tile's
 * capacity and the ladders are finite.
 *
 * Tiles are visited in ascending index order, which is the game's own spatial
 * order — see `context.ts`.
 */
export function downgradeOversized(
  rows: SimPlacedBuilding[],
  power: number,
  effectiveBuildings: EffectiveBuilding[],
  ctx: IslandContext,
): { rows: SimPlacedBuilding[]; power: number } {
  if (rows.length === 0) return { rows, power };

  const byId = new Map(effectiveBuildings.map((b) => [b.id, b]));
  const current = emptyPlacement(ctx.n);
  const occupied: number[] = [];
  for (const row of rows) {
    const building = byId.get(row.buildingId);
    // Everything the search places comes from this roster; a layout holding
    // anything else is not one this pass can reason about.
    if (building === undefined) return { rows, power };
    put(current, ctx, row.idx, building);
    occupied.push(row.idx);
  }
  occupied.sort((a, b) => a - b);

  const tiers = downgradeTiers(effectiveBuildings);
  const rowAt = new Map(rows.map((r) => [r.idx, r]));
  const floor = power;

  for (let changed = true; changed;) {
    changed = false;

    for (const tile of occupied) {
      const building = current[tile]!;
      const ladder = tiers.get(building.type);
      if (ladder === undefined || ladder.length === 0) continue;

      const load = tileLoad(building, rowAt.get(tile)!);

      for (const candidate of ladder) {
        // Rated for this tile before it is compared to anything: `building` is
        // what the tile is running and `load` is what the layout measured it
        // doing, both in this tile's units, and the ladder is the plain roster.
        // Ascending order survives the rating, since one tile scales every
        // candidate by the same factor.
        const rated = ctx.rate(tile, candidate);
        // Ascending, so nothing smaller is left to try. Both sides are `rate`'s
        // units, and one tile scales every candidate by the same factor, so the
        // ladder's order survives whichever units this is asked in.
        if (rated.effectiveValue >= building.effectiveValue) break;
        // Covering the load is asked in the layout's units, which is `rate`'s
        // plus whatever `simulateIsland` resolves per layout — see
        // `ratedCapacity`. `load` came off a row it measured, so this is the one
        // comparison here that cannot be made in the roster's units.
        if (!covers(ratedCapacity(ctx, current, tile, rated), load)) continue;

        put(current, ctx, tile, rated);
        const trial = simulateIsland(current, ctx);

        if (
          covers(trial.totalPower, floor) &&
          !anyOfflineProducer(current, trial.placements) &&
          planHolds(current, ctx)
        ) {
          power = trial.totalPower;
          rows = trial.placements;
          rowAt.clear();
          for (const r of rows) rowAt.set(r.idx, r);
          changed = true;
          break;
        }

        put(current, ctx, tile, building);
      }
    }
  }

  return { rows, power };
}
