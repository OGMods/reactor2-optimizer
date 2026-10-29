/**
 * Pushing the holes a finished layout leaves out to the edge of the land.
 *
 * The pass can only move buildings, never change one, and never lose power;
 * what this pins is that an interior hole does move, without costing either.
 */
import { describe, expect, it } from "vitest";
import { buildIslandContext } from "../src/solver/context";
import { internals } from "../src/solver/placementSearch";
import { simulateIsland } from "../src/solver/simulate";
import type { EffectiveBuilding, Placement, Tile } from "../src/solver/types";

const { gatherEmptyTiles } = internals;

function cooler(value: number): EffectiveBuilding {
  return {
    id: "cooler",
    type: "cooler",
    effectiveValue: value,
    energy: 0,
    waste: 0,
    baseValue: value,
  };
}

function directProducer(value: number): EffectiveBuilding {
  return {
    id: "dp",
    type: "direct_producer",
    effectiveValue: value,
    energy: value / 2,
    waste: value / 2,
    baseValue: value,
  };
}

function grass(size: number): Tile[][] {
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x): Tile => ({ x, y, type: "grass" })),
  );
}

/** A 5x5 board with `at` written in by (x, y). */
function board(at: [number, number, EffectiveBuilding][]) {
  const ctx = buildIslandContext(grass(5));
  const placement: Placement = new Array(ctx.n).fill(null);
  for (const [x, y, b] of at) placement[tileAt(ctx, x, y)] = b;
  return { ctx, sim: simulateIsland(placement, ctx) };
}

/** Tile indices follow the game's spatial order, not row-major. */
function tileAt(
  ctx: ReturnType<typeof buildIslandContext>,
  x: number,
  y: number,
): number {
  for (let t = 0; t < ctx.n; t++)
    if (ctx.xs[t] === x && ctx.ys[t] === y) return t;
  throw new Error(`no tile at ${x},${y}`);
}

describe("gatherEmptyTiles", () => {
  it("fills the centre of the land and leaves the hole nearer the edge", () => {
    // A producer above the centre and its cooler beside it, with the centre
    // empty. The cooler still touches the producer from the centre, so it can
    // step in and leave the hole one ring out.
    const dp = directProducer(10);
    const c = cooler(10);
    const { ctx, sim } = board([
      [2, 1, dp],
      [3, 1, c],
    ]);
    const roster = [dp, c];
    expect(sim.totalPower).toBeGreaterThan(0);

    const out = gatherEmptyTiles(
      sim.placements,
      sim.totalPower,
      roster,
      ctx,
      Infinity,
    );

    const occupied = new Set(out.rows.map((r) => r.idx));
    expect(occupied.has(tileAt(ctx, 2, 2))).toBe(true);
    expect(occupied.size).toBe(2);
    expect(out.power).toBe(sim.totalPower);
    const producer = out.rows.find((r) => r.buildingId === "dp")!;
    expect(producer.powerGenerated).toBeGreaterThan(0);
  });
});
