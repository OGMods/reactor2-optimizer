import {
  buildPrice,
  findBuilding,
  netSpend,
  priceRules,
  type Tile,
} from "@reactor2/solver";
import { describe, expect, it } from "vitest";
import {
  addCounts,
  buildingPricing,
  changeSpend,
  countBuildings,
  islandPrice,
  nextRemoval,
  terrainStats,
} from "./islandStats";

const grid = (rows: string[]): Tile[][] =>
  rows.map((row, y) =>
    [...row].map((c, x) => ({
      x,
      y,
      type: (
        {
          ".": "grass",
          "~": "water",
          r: "rock",
          t: "tree1",
          T: "tree2",
          p: "pond",
        } as const
      )[c]!,
    })),
  );

describe("terrainStats", () => {
  it("counts the edge as water and a pond as an obstacle", () => {
    // 5×5: the ring touches the board edge, so all of it is shore; the
    // centre's eight neighbours are a pond and grass, so it is inland.
    const stats = terrainStats(
      grid([".....", "..p..", ".....", ".r.t.", "....T"]),
    );
    expect(stats).toEqual({
      grass: 21,
      shore: 16 - 1, // the ring holds the T
      rocks: 1,
      trees: 2,
      ponds: 1,
    });
  });

  it("finds shore inland of a water tile, corners included", () => {
    const stats = terrainStats(
      grid([
        ".......",
        ".......",
        ".......",
        "...~...",
        ".......",
        ".......",
        ".......",
      ]),
    );
    // 24 edge tiles + the 8 around the water.
    expect(stats.shore).toBe(24 + 8);
    expect(stats.grass).toBe(48);
  });
});

describe("counts", () => {
  it("tallies and adds per building", () => {
    const a = countBuildings([
      { buildingId: "cooler1" },
      { buildingId: "cooler1" },
      { buildingId: "generator" },
    ]);
    expect(a).toEqual({ cooler1: 2, generator: 1 });
    addCounts(a, { cooler1: 1, nuclear_reactor: 4 });
    expect(a).toEqual({ cooler1: 3, generator: 1, nuclear_reactor: 4 });
  });
});

describe("buildingPricing", () => {
  it("prices the next copy after every copy built, and the rebuild as their sum", () => {
    const rules = priceRules({ BuildingsCostMultiplierResearchSO: 9 });
    const base = findBuilding("nuclear_reactor")!.price;
    const p = buildingPricing("nuclear_reactor", 3, rules);
    expect(p.base).toBe(base);
    expect(p.built).toBe(3);
    expect(p.next).toBe(buildPrice(base, 3, rules));
    expect(p.rebuild).toBeCloseTo(
      buildPrice(base, 0, rules) +
        buildPrice(base, 1, rules) +
        buildPrice(base, 2, rules),
    );
  });

  it("costs nothing to rebuild with none built", () => {
    const p = buildingPricing("cooler1", 0, priceRules({}));
    expect(p.rebuild).toBe(0);
    expect(p.next).toBe(findBuilding("cooler1")!.price);
  });
});

describe("nextRemoval", () => {
  it("is five minutes for the first clear with no research", () => {
    expect(nextRemoval(0, {})).toEqual({
      removed: 0,
      nextSeconds: 300,
      freeWindow: 0,
      left: 0,
      allSeconds: 0,
    });
  });

  it("grows per clear and takes both reductions off, multiplied", () => {
    // Clearance Crews 7 (-85%), Phase Breaker 6 (-68%), Erased from Time 7.
    const c = nextRemoval(100, {
      ObstacleRemovalTimeResearchSO: 7,
      phase_breaker: 6,
      erased_from_time: 7,
    });
    expect(c.nextSeconds).toBeCloseTo(300 * 1.025 ** 100 * 0.15 * 0.32);
    expect(c.freeWindow).toBe(7200);
  });
});

describe("changeSpend", () => {
  it("agrees with the solver's netSpend on the same change", () => {
    const rules = priceRules({
      BuildingsCostMultiplierResearchSO: 9,
      BuildingSellRefundResearchSO: 10,
    });
    const list = (counts: Record<string, number>) =>
      Object.entries(counts).flatMap(([buildingId, n]) =>
        Array.from({ length: n }, () => ({ x: 0, y: 0, buildingId })),
      );
    const before = { nuclear_reactor: 5, cooler1: 3, generator: 2 };
    const after = { nuclear_reactor: 8, cooler1: 1, generator2: 4 };
    const elsewhere = { nuclear_reactor: 20, cooler1: 7 };
    expect(changeSpend(after, before, elsewhere, rules)).toBe(
      netSpend(list(after), {
        cash: 0,
        standing: list(before),
        elsewhere,
        prices: rules,
      }),
    );
  });
});

describe("clearing everything", () => {
  it("adds up each clear's wait past the free window", () => {
    const research = { erased_from_time: 1 }; // 900 s free
    const c = nextRemoval(0, research, 3);
    // 300 s each times 1.025^k, all inside the window.
    expect(c.allSeconds).toBe(0);
    const late = nextRemoval(200, research, 2);
    const t = (k: number) => 300 * 1.025 ** k;
    expect(late.allSeconds).toBeCloseTo(t(200) - 900 + (t(201) - 900));
    expect(late.left).toBe(2);
  });

  it("prices the islands the record lists, and nothing else", () => {
    expect(islandPrice("area_8")).toBe(3.13e28);
    expect(islandPrice("area_99")).toBeNull();
  });
});
