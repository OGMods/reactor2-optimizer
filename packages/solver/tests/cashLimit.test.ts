/**
 * The cash limit: what a layout spends from the board standing, and the search
 * keeping every layout it returns within it.
 *
 * The search half is pinned as invariants, the way the upgrade plan's is: the
 * returned layout spends no more than the cash, a board kept whole with no cash
 * at all loses nothing, and the board is solved as one island. What power a
 * given sum reaches is a measurement, and the CLI's `--cash` is where it is
 * taken.
 */
import { describe, expect, it } from "vitest";
import {
  buildPrice,
  layoutCost,
  netSpend,
  priceRules,
  sellRefund,
} from "../src/data/buildingPrices";
import { allUpgradesUnlocked, BUILDINGS } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { makeGrid } from "../src/grid";
import { buildIslandContext } from "../src/solver/context";
import { Rng } from "../src/solver/rng";
import {
  affordableRoster,
  layoutSpend,
  setCashLimit,
  trimToBudget,
  withinBudget,
} from "../src/solver/search/cashLimit";
import { splitGridIntoIslands } from "../src/solver/island";
import { planSolve, solve } from "../src/solver/solver";
import type {
  BuildingDefinition,
  CashBudget,
  Placement,
} from "../src/solver/types";

const CATALOGUE = BUILDINGS as BuildingDefinition[];
const UNLOCKS = allUpgradesUnlocked();
const ROSTER = getEffectiveBuildings(CATALOGUE, UNLOCKS);
const PRICES = priceRules({});
const price = (id: string) => CATALOGUE.find((b) => b.id === id)!.price;

const at = (x: number, y: number, buildingId: string) => ({
  x,
  y,
  buildingId,
});

function budget(
  cash: number,
  standing: CashBudget["standing"] = [],
  elsewhere: Record<string, number> = {},
): CashBudget {
  return { cash, standing, elsewhere, prices: PRICES };
}

describe("netSpend", () => {
  it("is the build cost from empty when nothing stands", () => {
    const layout = [
      at(0, 0, "cooler3"),
      at(1, 0, "cooler3"),
      at(2, 0, "generator2"),
    ];
    expect(netSpend(layout, budget(0))).toBeCloseTo(layoutCost(layout), 6);
  });

  it("charges nothing for keeping a building or for moving it", () => {
    const standing = [at(0, 0, "cooler3"), at(1, 0, "generator2")];
    const moved = [at(4, 4, "generator2"), at(3, 3, "cooler3")];
    expect(netSpend(standing, budget(0, standing))).toBe(0);
    expect(netSpend(moved, budget(0, standing))).toBe(0);
  });

  it("refunds a sale at the current price, the copies elsewhere counted", () => {
    const standing = [at(0, 0, "cooler3"), at(1, 0, "cooler3")];
    const spend = netSpend(
      [at(0, 0, "cooler3")],
      budget(0, standing, { cooler3: 4 }),
    );
    // Six copies stand across the islands before the sale.
    expect(spend).toBeCloseTo(-sellRefund(price("cooler3"), 6, PRICES), 9);
  });

  it("prices a new copy after every copy anywhere", () => {
    const spend = netSpend(
      [at(0, 0, "cooler3")],
      budget(0, [], { cooler3: 3 }),
    );
    expect(spend).toBeCloseTo(buildPrice(price("cooler3"), 3, PRICES), 9);
  });
});

describe("the island's spend tables", () => {
  const grid = makeGrid(["GGGGG", "GGGGG", "GGGGG", "GGGGG"]);
  const [island] = splitGridIntoIslands(grid);
  const ctx = buildIslandContext(
    island.grid,
    island.buildable,
    undefined,
    island.waterAdjacent,
  );
  const cheap = ROSTER.filter((b) => b.id.match(/^(cooler|generator)[1-3]$/));
  const standing = [
    at(ctx.xs[0], ctx.ys[0], "cooler2"),
    at(ctx.xs[1], ctx.ys[1], "cooler2"),
    at(ctx.xs[2], ctx.ys[2], "generator1"),
  ];
  const limit = budget(5e4, standing, { cooler2: 7, generator3: 2 });
  setCashLimit(ctx, cheap, limit);

  const random = (rng: Rng): Placement =>
    Array.from({ length: ctx.n }, () =>
      rng.random() < 0.4 ? null : cheap[rng.int(cheap.length)],
    );
  const asPlaced = (placement: Placement) =>
    placement.flatMap((b, t) =>
      b === null ? [] : [at(ctx.xs[t], ctx.ys[t], b.id)],
    );

  it("agree with netSpend on any layout", () => {
    const rng = new Rng(11);
    for (let i = 0; i < 200; i++) {
      const placement = random(rng);
      const expected = netSpend(asPlaced(placement), limit);
      // Relative: the two sum the same prices in a different order.
      const spend = layoutSpend(placement, ctx)!;
      expect(Math.abs(spend - expected)).toBeLessThanOrEqual(
        1e-12 * Math.max(1, Math.abs(expected)),
      );
    }
  });

  it("trims any layout to within the cash, and leaves one inside it alone", () => {
    const rng = new Rng(3);
    for (let i = 0; i < 100; i++) {
      const placement = random(rng);
      const before = placement.slice();
      const wasWithin = withinBudget(placement, ctx);
      const changed = trimToBudget(placement, ctx);
      expect(withinBudget(placement, ctx)).toBe(true);
      expect(netSpend(asPlaced(placement), limit)).toBeLessThanOrEqual(
        limit.cash * (1 + 1e-9),
      );
      expect(changed).toBe(!wasWithin);
      if (wasWithin) expect(placement).toEqual(before);
    }
  });
});

describe("affordableRoster", () => {
  it("drops what the cash and every refund together cannot buy one of", () => {
    const kept = affordableRoster(ROSTER, budget(1e6));
    expect(kept.length).toBeGreaterThan(0);
    for (const b of kept) expect(price(b.id)).toBeLessThanOrEqual(1e6);
    expect(kept.some((b) => b.id === "cooler8")).toBe(false);
  });

  it("keeps a building that stands, whatever it costs", () => {
    const kept = affordableRoster(ROSTER, budget(0, [at(0, 0, "cooler8")]));
    expect(kept.some((b) => b.id === "cooler8")).toBe(true);
  });
});

describe("a budgeted solve", () => {
  const grid = makeGrid([
    "GGGGGG.GGG",
    "GGGGGG.GGG",
    "GGGGGG.GGG",
    "GGGGGG....",
  ]);

  it("solves the board as one island, since one budget pays for all of it", () => {
    expect(planSolve(grid, CATALOGUE, UNLOCKS, 1)!.islands).toHaveLength(2);
    expect(
      planSolve(
        grid,
        CATALOGUE,
        UNLOCKS,
        1,
        1,
        undefined,
        undefined,
        undefined,
        budget(1e20),
      )!.islands,
    ).toHaveLength(1);
  });

  it("returns a layout within the cash, and more cash buys more power", async () => {
    let previous = 0;
    for (const cash of [1e12, 1e18, 1e24]) {
      const limit = budget(cash);
      const result = await solve(
        grid,
        CATALOGUE,
        UNLOCKS,
        0.6,
        { cashBudget: limit },
        5,
      );
      expect(result.totalPower).toBeGreaterThan(previous);
      expect(netSpend(result.placements, limit)).toBeLessThanOrEqual(
        cash * (1 + 1e-9),
      );
      previous = result.totalPower;
    }
  });

  it("with no cash, keeps what the standing board makes and spends nothing", async () => {
    const built = await solve(
      grid,
      CATALOGUE,
      UNLOCKS,
      0.6,
      { cashBudget: budget(1e18) },
      9,
    );
    const standing = built.placements.map((p) => at(p.x, p.y, p.buildingId));
    const limit = budget(0, standing);
    const result = await solve(
      grid,
      CATALOGUE,
      UNLOCKS,
      0.6,
      { cashBudget: limit },
      9,
    );
    expect(netSpend(result.placements, limit)).toBeLessThanOrEqual(0);
    expect(result.totalPower).toBeGreaterThanOrEqual(
      built.totalPower * (1 - 1e-9),
    );
  });

  it("builds nothing when nothing is affordable", async () => {
    const result = await solve(
      grid,
      CATALOGUE,
      UNLOCKS,
      0.3,
      { cashBudget: budget(1) },
      1,
    );
    expect(result.totalPower).toBe(0);
    expect(result.placements).toHaveLength(0);
  });
});
