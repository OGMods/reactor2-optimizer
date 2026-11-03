import { buildPrice, sellRefund } from "../../data/buildingPrices";
import { findBuilding } from "../../data/buildings";
import type { IslandContext } from "../context";
import type { CashBudget, EffectiveBuilding, Placement } from "../types";
import { put } from "./placement";

/**
 * A cash limit: what turning the board as it stands into the layout may cost,
 * net of what the sales along the way pay back.
 *
 * Moves are free, so no building type is ever sold and rebuilt — its count on
 * the board only goes up, each copy bought at the next copy's price, or down,
 * each sale refunding a share of the current one. The net spend is therefore a
 * sum over types of a function of that type's count alone, the same in every
 * order, and each of those functions is tabulated once per island. Selling
 * first is always possible, so the net is also the most cash the change ever
 * needs on hand.
 */
interface CashLimit {
  cash: number;
  /** Building id to its row in `spendAt`. */
  slot: Map<string, number>;
  /**
   * Per type, the net spend at each count on the island: 0 at the count
   * standing, climbing above it and negative below. Strictly increasing,
   * since every price and refund is positive.
   */
  spendAt: Float64Array[];
  /** Per type, the next cheaper building of the same role, or null. */
  cheaper: (EffectiveBuilding | null)[];
  /** Scratch: per type, its count in the layout being priced. */
  counts: Int32Array;
}

/**
 * Relative slack for "within budget": a net spend sums buys and refunds
 * across thirty orders of magnitude, so it is compared against the size of
 * its own terms rather than exactly.
 */
const SPEND_RELATIVE_TOLERANCE = 1e-9;

/**
 * Held beside the context like `upgradePlans`, so every stage's signature is
 * untouched without a limit — which is always the case for the fixtures.
 */
const cashLimits = new WeakMap<IslandContext, CashLimit>();

/** The net spend at each count, 0 at `standing`. */
function spendTable(
  id: string,
  standing: number,
  elsewhere: number,
  maxCount: number,
  budget: CashBudget,
): Float64Array {
  const base = findBuilding(id)?.price ?? 0;
  const table = new Float64Array(Math.max(standing, maxCount) + 1);
  for (let t = standing + 1; t < table.length; t++)
    table[t] =
      table[t - 1] + buildPrice(base, elsewhere + t - 1, budget.prices);
  for (let t = standing - 1; t >= 0; t--)
    table[t] =
      table[t + 1] - sellRefund(base, elsewhere + t + 1, budget.prices);
  return table;
}

/** Each building id standing on the island, and how many. */
function standingCounts(budget: CashBudget): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of budget.standing)
    counts.set(p.buildingId, (counts.get(p.buildingId) ?? 0) + 1);
  return counts;
}

/**
 * The roster less every building the budget can never buy: one whose next copy
 * costs more than the cash plus what selling everything standing pays back,
 * and of which none stands. Sound — no layout within the budget holds one —
 * and it is what keeps the seed, the repair and the bound from building
 * around a top tier the player cannot reach.
 */
export function affordableRoster(
  roster: EffectiveBuilding[],
  budget: CashBudget,
): EffectiveBuilding[] {
  const standing = standingCounts(budget);
  let refundAll = 0;
  for (const [id, c] of standing)
    refundAll -= spendTable(id, c, budget.elsewhere[id] ?? 0, 0, budget)[0];
  const reach = budget.cash + refundAll;
  return roster.filter((b) => {
    const c = standing.get(b.id) ?? 0;
    if (c > 0) return true;
    const first = spendTable(b.id, 0, budget.elsewhere[b.id] ?? 0, 1, budget);
    return first[1] <= reach * (1 + SPEND_RELATIVE_TOLERANCE);
  });
}

/**
 * Puts a cash limit on the island. `roster` is every building a layout may
 * hold, in any rating — the limit reads ids — and the standing board's types
 * are priced too, since selling one is a refund every layout without it gets.
 */
export function setCashLimit(
  ctx: IslandContext,
  roster: EffectiveBuilding[],
  budget: CashBudget,
): void {
  const standing = standingCounts(budget);
  const ids = [...new Set([...roster.map((b) => b.id), ...standing.keys()])];
  const slot = new Map(ids.map((id, i) => [id, i]));
  const spendAt = ids.map((id) =>
    spendTable(
      id,
      standing.get(id) ?? 0,
      budget.elsewhere[id] ?? 0,
      ctx.n,
      budget,
    ),
  );
  const price = (b: EffectiveBuilding) => findBuilding(b.id)?.price ?? 0;
  const cheaper = ids.map((id) => {
    const self = roster.find((b) => b.id === id);
    if (self === undefined) return null;
    let best: EffectiveBuilding | null = null;
    for (const b of roster) {
      if (b.type !== self.type || price(b) >= price(self)) continue;
      if (best === null || price(b) > price(best)) best = b;
    }
    return best;
  });
  cashLimits.set(ctx, {
    cash: budget.cash,
    slot,
    spendAt,
    cheaper,
    counts: new Int32Array(ids.length),
  });
}

/**
 * Anything a spend can be read off: a placement, a composition, or a list of
 * ids. Only ids count — where a building stands is free.
 */
type Priced = readonly ({ id: string } | null)[];

/** Fills `limit.counts` from the layout. */
function countInto(placement: Priced, limit: CashLimit): void {
  limit.counts.fill(0);
  for (const b of placement) {
    if (b === null) continue;
    const s = limit.slot.get(b.id);
    if (s !== undefined) limit.counts[s]++;
  }
}

/** Whether the counts in `limit.counts` are within the cash. */
function countsFit(limit: CashLimit): boolean {
  let spend = 0;
  let scale = 0;
  for (let s = 0; s < limit.spendAt.length; s++) {
    const v = limit.spendAt[s][limit.counts[s]];
    spend += v;
    scale += Math.abs(v);
  }
  return (
    spend <=
    limit.cash +
      SPEND_RELATIVE_TOLERANCE * Math.max(scale, Math.abs(limit.cash))
  );
}

/** Whether the layout is within the island's cash limit. Free without one. */
export function withinBudget(placement: Priced, ctx: IslandContext): boolean {
  const limit = cashLimits.get(ctx);
  if (limit === undefined) return true;
  countInto(placement, limit);
  return countsFit(limit);
}

/** The layout's net spend, or null when the island has no cash limit. */
export function layoutSpend(
  placement: Priced,
  ctx: IslandContext,
): number | null {
  const limit = cashLimits.get(ctx);
  if (limit === undefined) return null;
  countInto(placement, limit);
  let spend = 0;
  for (let s = 0; s < limit.spendAt.length; s++)
    spend += limit.spendAt[s][limit.counts[s]];
  return spend;
}

/**
 * Brings the layout within the cash limit, in place: while it is over, the
 * type whose last copy costs the most gives one up — stepped down to the next
 * cheaper building of its role where that saves money, removed where it does
 * not. Reports whether anything changed.
 *
 * Every step lowers the spend strictly, and the empty board's spend is at most
 * nothing, so this always ends within any cash of zero or more. What it
 * leaves may have producers offline, which is `stabilize`'s to clear.
 */
export function trimToBudget(
  placement: Placement,
  ctx: IslandContext,
): boolean {
  const limit = cashLimits.get(ctx);
  if (limit === undefined) return false;
  let changed = false;
  for (;;) {
    countInto(placement, limit);
    if (countsFit(limit)) return changed;

    let worst = -1;
    let saving = 0;
    for (let s = 0; s < limit.spendAt.length; s++) {
      const c = limit.counts[s];
      if (c === 0) continue;
      const d = limit.spendAt[s][c] - limit.spendAt[s][c - 1];
      if (d > saving) {
        saving = d;
        worst = s;
      }
    }
    if (worst < 0) return changed;

    let tile = -1;
    for (let t = ctx.n - 1; t >= 0 && tile < 0; t--) {
      const b = placement[t];
      if (b !== null && limit.slot.get(b.id) === worst) tile = t;
    }

    const down = limit.cheaper[worst];
    const ds = down === null ? undefined : limit.slot.get(down.id);
    const added =
      ds === undefined
        ? Infinity
        : limit.spendAt[ds][limit.counts[ds] + 1] -
          limit.spendAt[ds][limit.counts[ds]];
    if (down !== null && added < saving) put(placement, ctx, tile, down);
    else placement[tile] = null;
    changed = true;
  }
}

/**
 * The board as it stands, as a placement on this island: where every building
 * of `budget.standing` would sit, in `roster`'s buildings by id. A building
 * the roster does not hold is left off — the run sells it.
 */
export function standingPlacement(
  ctx: IslandContext,
  roster: EffectiveBuilding[],
  budget: CashBudget,
  into: Placement,
): void {
  const byId = new Map(roster.map((b) => [b.id, b]));
  const at = new Map<string, number>();
  for (let t = 0; t < ctx.n; t++) at.set(`${ctx.xs[t]},${ctx.ys[t]}`, t);
  for (const p of budget.standing) {
    const t = at.get(`${p.x},${p.y}`);
    const b = byId.get(p.buildingId);
    if (t !== undefined && b !== undefined) put(into, ctx, t, b);
  }
}
