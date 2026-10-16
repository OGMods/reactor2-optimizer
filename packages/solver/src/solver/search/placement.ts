import type { IslandContext } from "../context";
import type { SimPlacedBuilding } from "../simulate";
import type { EffectiveBuilding, PlacedBuilding, Placement } from "../types";

/**
 * The placement primitives every stage of the search shares: writing a
 * building onto a tile in that tile's units, the cheap geometry the moves are
 * built from, and turning simulation rows into the rows a result carries.
 */

/** Max Chebyshev distance between two tiles considered for an arrangement swap. */
export const SWAP_RADIUS = 2;

export function emptyPlacement(n: number): Placement {
  return new Array<EffectiveBuilding | null>(n).fill(null);
}

/**
 * Writes a building onto a tile, rated for that tile.
 *
 * The one way a building enters a placement, so that a terrain bonus cannot be
 * missed at one of three dozen sites — and a miss would be silent, since the
 * layout would simply be worth less than it is. `ctx.rate` is the identity
 * under every rule but a terrain bonus, and idempotent under that one, so this
 * is equally correct for a fresh placement, a swap between two tiles, and the
 * restore that undoes a rejected move.
 *
 * Clearing a tile stays a plain `= null`: a null carries no rating, so there is
 * nothing to resolve and nothing to get wrong.
 */
export function put(
  placement: Placement,
  ctx: IslandContext,
  tile: number,
  building: EffectiveBuilding | null,
): void {
  placement[tile] = ratedFor(ctx, tile, building);
}

/**
 * Exactly what `put` would write onto `tile` — the building as that tile rates
 * it, or `null`.
 *
 * This is how a move asks "would writing this change anything?", and it has to
 * be asked in the tile's own units: a placement holds RATED buildings, so
 * comparing a plain roster entry against one is never equal on a scaled tile,
 * and the guard that should have skipped the move instead writes back an
 * identical object, runs a full `simulateIsland`, and hands `accept` a delta of
 * zero — which it "accepts". No number moves, and the walk quietly spends a
 * slice of a budget whose only product is steps per second.
 *
 * The comparison is exact rather than approximate because `ctx.rate` caches one
 * object per (scale, roster entry) pair, so two tiles of the same scale holding
 * the same building hold the *same* object — and it is cheap for the same
 * reason: a lookup, not a multiply.
 */
export function ratedFor(
  ctx: IslandContext,
  tile: number,
  building: EffectiveBuilding | null,
): EffectiveBuilding | null {
  return building === null ? null : ctx.rate(tile, building);
}

export function copyInto(dst: Placement, src: Placement): void {
  for (let i = 0; i < dst.length; i++) dst[i] = src[i];
}

export function isReactor(b: EffectiveBuilding): boolean {
  return b.type === "reactor";
}

export function isDirectProducer(b: EffectiveBuilding): boolean {
  return b.type === "direct_producer";
}

export function chebyshev(ctx: IslandContext, a: number, b: number): number {
  return Math.max(
    Math.abs(ctx.xs[a] - ctx.xs[b]),
    Math.abs(ctx.ys[a] - ctx.ys[b]),
  );
}

/** The tile's Chebyshev-adjacent buildable neighbors that are still unclaimed. */
export function availableNeighbors(
  tile: number,
  available: Uint8Array,
  ctx: IslandContext,
): number[] {
  const out: number[] = [];
  const nb = ctx.neighbors[tile];
  for (let k = 0; k < nb.length; k++) {
    if (available[nb[k]]) out.push(nb[k]);
  }
  return out;
}

export function toPlacedBuildings(rows: SimPlacedBuilding[]): PlacedBuilding[] {
  return rows.map((r) => ({
    x: r.x,
    y: r.y,
    buildingId: r.buildingId,
    baseValue: r.baseValue,
    powerGenerated: r.powerGenerated,
    heatProduced: r.heatProduced,
    heatConsumed: r.heatConsumed,
    wasteHeatGenerated: r.wasteHeatGenerated,
    coolingProvided: r.coolingProvided,
    coolingReceived: r.coolingReceived,
  }));
}
