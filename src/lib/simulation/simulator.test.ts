/**
 * The hand-placed scorer must agree with the solver on every board.
 *
 * `simulator.ts` calls `simulateIsland` outright, so that agreement is true by
 * construction rather than something a test protects. Two independent
 * implementations of the same Distribution System drift — over a supplier's
 * leftover folded into a running `carry` within one pass, or over counting
 * every supplier on the board where the solver counts every supplier on the
 * island — and the same board then scores differently depending on whether the
 * player placed it or the optimizer produced it.
 *
 * What these pin is everything around that call, which is where a scorer built
 * on top of someone else's evaluator can still get it wrong:
 *
 * - the numbers the game itself produces, in `matches the live game` — those
 *   are measured, and belong to neither implementation;
 * - the adapter: a placement's (x, y) has to find its tile, and the report has
 *   to come back onto the caller's rows in the caller's order;
 * - that handing the *whole board* to one context is not an approximation of
 *   solving each island separately. That is the load-bearing assumption in
 *   `simulatePlacedBuildings`, and it holds only because distribution scopes
 *   itself to each connected component of the supplier<->consumer graph, which
 *   is a finer partition than the island.
 */
import { describe, it, expect } from "vitest";
import { simulatePlacedBuildings } from "./simulator";
import { getAnomaly } from "@reactor2/solver";
import { buildIslandContext } from "@reactor2/solver";
import { splitGridIntoIslands } from "@reactor2/solver";
import { simulateIsland } from "@reactor2/solver";
import { Rng } from "@reactor2/solver";
import type {
  BuildingDefinition,
  EffectiveBuilding,
  PlacedBuilding,
  Placement,
  Tile,
} from "@reactor2/solver";

const HELIO = 250000,
  G2 = 1.31e6,
  G1 = 2560,
  DIVINE = 1.72e16,
  G5 = 1.69e16;

const VALUES: Record<string, number> = {
  reactor: 1000,
  generator: 800,
  cooler: 600,
  dp: 500,
};

/**
 * Stand-in catalogue. A placement carries the value it was placed at rather
 * than a level index, so every value these tests place has to be an authored
 * tier of the building it names -- the scorer resolves the tier by that value.
 * The generator and direct-producer tiers carry the game's authored energy and
 * waste for the matching real building.
 */
const DEFS: BuildingDefinition[] = [
  {
    id: "reactor",
    name: "Reactor",
    type: "reactor",
    price: 0,
    displayIndex: 0,
    levels: [{ heat: VALUES.reactor }, { heat: HELIO }, { heat: DIVINE }],
  },
  {
    id: "generator",
    name: "Generator",
    type: "generator",
    price: 0,
    displayIndex: 0,
    levels: [
      {
        heat: VALUES.generator,
        energy: VALUES.generator * 0.75,
        waste: VALUES.generator * 0.25,
      },
      { heat: G1, energy: 1920, waste: 640 },
      { heat: G2, energy: 983040, waste: 326960 },
      { heat: G5, energy: 1.27e16, waste: 4.2e15 },
    ],
  },
  {
    id: "cooler",
    name: "Cooler",
    type: "cooler",
    price: 0,
    displayIndex: 0,
    levels: [{ cooling: VALUES.cooler }],
  },
  {
    id: "dp",
    name: "Direct Producer",
    type: "direct_producer",
    price: 0,
    displayIndex: 0,
    levels: [
      { heat: VALUES.dp, energy: VALUES.dp * 0.8, waste: VALUES.dp * 0.2 },
    ],
  },
];

type Spec = [number, number, string, number][];

function grassGrid(w: number, h: number): Tile[][] {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => ({ x, y, type: "grass" as const })),
  );
}

function place(spec: Spec) {
  return spec.map(([x, y, buildingId, baseValue]) => ({
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
  }));
}

/** Heat routed into each generator, keyed "x,y", expressed as the power it implies. */
function generatorPower(spec: Spec, w = 8, h = 8) {
  const out = simulatePlacedBuildings(grassGrid(w, h), DEFS, place(spec));
  const m = new Map<string, number>();
  for (const r of out) m.set(`${r.x},${r.y}`, r.heatConsumed * 0.75);
  return m;
}

describe("hand-placed scorer matches the live game", () => {
  it("two contested reactors re-split the leftover evenly", () => {
    const p = generatorPower([
      [0, 1, "reactor", HELIO],
      [2, 1, "reactor", HELIO],
      [1, 2, "generator", G2],
      [1, 1, "generator", G2],
      [1, 0, "generator", G1],
    ]);
    expect(p.get("1,2")).toBeCloseTo(186540, 3);
    expect(p.get("1,1")).toBeCloseTo(186540, 3);
    expect(p.get("1,0")).toBeCloseTo(1920, 6);
  });

  it("a single reactor leaves its remainder to Augmenting Repair", () => {
    const p = generatorPower([
      [0, 1, "reactor", HELIO],
      [1, 2, "generator", G2],
      [1, 1, "generator", G2],
      [1, 0, "generator", G1],
    ]);
    expect(p.get("1,2")).toBeCloseTo(123080, 3);
    expect(p.get("1,1")).toBeCloseTo(62500, 3);
    expect(p.get("1,0")).toBeCloseTo(1920, 6);
  });

  it("the round loop sits outside the supplier loop", () => {
    const p = generatorPower([
      [0, 0, "reactor", DIVINE],
      [1, 1, "reactor", DIVINE],
      [0, 1, "generator", G5],
      [1, 2, "generator", G5],
      [1, 0, "generator", G2],
      [2, 1, "generator", G5],
    ]);
    expect(p.get("0,1")! / 1e16).toBeCloseTo(1.2675, 6);
    expect(p.get("1,2")! / 1e15).toBeCloseTo(8.6, 6);
    expect(p.get("2,1")! / 1e15).toBeCloseTo(4.3, 6);
  });
});

describe("distribution is scoped to the connected component", () => {
  /**
   * A lone reactor between one small generator and two big ones delivers
   * 123,080 / 62,500 / 1,920 — one FairShare round, with the remainder placed
   * sequentially by Augmenting Repair.
   *
   * Reactors that cannot reach these generators must not change that. They did,
   * twice over: the scorer counted every supplier on the board and the solver
   * counted every supplier on the island, so an unrelated reactor bought this
   * cluster an extra round and both big generators drifted to 92,790.
   */
  function expectIsolatedCluster(p: Map<string, number>, dy: number) {
    expect(p.get(`1,${2 + dy}`)).toBeCloseTo(123080, 3);
    expect(p.get(`1,${1 + dy}`)).toBeCloseTo(62500, 3);
    expect(p.get(`1,${0 + dy}`)).toBeCloseTo(1920, 6);
  }

  it("ignores reactors on another island", () => {
    // Island A (two reactors) at y=0..2, island B (one reactor) at y=4..6.
    const p = generatorPower([
      [1, 0, "generator", G1],
      [0, 1, "reactor", HELIO],
      [1, 1, "generator", G2],
      [2, 1, "reactor", HELIO],
      [1, 2, "generator", G2],

      [1, 4, "generator", G1],
      [0, 5, "reactor", HELIO],
      [1, 5, "generator", G2],
      [1, 6, "generator", G2],
    ]);
    // Island A: two reactors in one component, so two rounds and an even split.
    expect(p.get("1,1")).toBeCloseTo(186540, 3);
    expect(p.get("1,2")).toBeCloseTo(186540, 3);
    // Island B: one reactor, so one round — unaffected by island A.
    expectIsolatedCluster(p, 4);
  });

  it("ignores an unreachable reactor on the same island", () => {
    const p = generatorPower([
      [0, 1, "reactor", HELIO],
      [1, 2, "generator", G2],
      [1, 1, "generator", G2],
      [1, 0, "generator", G1],
      // Same landmass, too far to feed any of the three above.
      [5, 1, "reactor", HELIO],
      [6, 1, "generator", G2],
    ]);
    expectIsolatedCluster(p, 0);
  });
});

describe("hand-placed scorer matches the solver", () => {
  const IDS = ["reactor", "generator", "cooler", "dp"];

  function randomSpec(grid: Tile[][], rng: Rng): Spec {
    const spec: Spec = [];
    for (const row of grid) {
      for (const tile of row) {
        if (tile.type !== "grass" || rng.random() < 0.3) continue;
        const id = IDS[rng.int(IDS.length)];
        spec.push([tile.x, tile.y, id, VALUES[id]]);
      }
    }
    return spec;
  }

  function effective(id: string): EffectiveBuilding {
    const def = DEFS.find((d) => d.id === id)!;
    const tier = def.levels[0];
    return {
      id,
      type: def.type,
      effectiveValue: VALUES[id],
      energy: "energy" in tier ? tier.energy : 0,
      waste: "waste" in tier ? (tier.waste ?? 0) : 0,
      baseValue: VALUES[id],
    };
  }

  it("maps 400 random single-island layouts onto the right rows", () => {
    const rng = new Rng(20240819);
    let compared = 0;

    for (let trial = 0; trial < 400; trial++) {
      const grid = grassGrid(2 + rng.int(3), 2 + rng.int(3));
      const ctx = buildIslandContext(grid);

      const placement: Placement = new Array(ctx.n).fill(null);
      const spec: Spec = [];
      for (let t = 0; t < ctx.n; t++) {
        if (rng.random() < 0.25) continue;
        const id = IDS[rng.int(IDS.length)];
        placement[t] = effective(id);
        spec.push([ctx.xs[t], ctx.ys[t], id, VALUES[id]]);
      }
      if (spec.length === 0) continue;

      const solver = simulateIsland(placement, ctx);
      const hand = simulatePlacedBuildings(grid, DEFS, place(spec));

      const handPower = new Map<string, number>();
      for (const r of hand) handPower.set(`${r.x},${r.y}`, r.powerGenerated);

      for (const r of solver.placements) {
        expect(handPower.get(`${r.x},${r.y}`)).toBeCloseTo(r.powerGenerated, 6);
      }
      expect(hand.reduce((a, r) => a + r.powerGenerated, 0)).toBeCloseTo(
        solver.totalPower,
        6,
      );
      compared++;
    }

    expect(compared).toBeGreaterThan(350);
  });

  /**
   * The case above cannot catch a scoping bug, because one all-grass grid is a
   * single island — a whole-board pass and a per-island one see the same
   * suppliers. Water is what separates them, and this is the test that says
   * `simulatePlacedBuildings` may hand the entire board to one context.
   */
  it("agrees with a per-island solve on 200 random split boards", () => {
    const rng = new Rng(770311);
    let compared = 0;

    for (let trial = 0; trial < 200; trial++) {
      const w = 3 + rng.int(3);
      const h = 3 + rng.int(4);
      const grid: Tile[][] = Array.from({ length: h }, (_, y) =>
        Array.from({ length: w }, (_, x) => ({
          x,
          y,
          type: (rng.random() < 0.22 ? "water" : "grass") as Tile["type"],
        })),
      );

      const spec = randomSpec(grid, rng);
      if (spec.length === 0) continue;

      const hand = simulatePlacedBuildings(grid, DEFS, place(spec));
      const handPower = new Map<string, number>();
      for (const r of hand) handPower.set(`${r.x},${r.y}`, r.powerGenerated);

      // Reference: the solver's own decomposition, one island at a time.
      // Sub-grid tiles carry LOCAL coordinates, so map back through
      // `originalTileIndices`. Islands too small to ever run are dropped by the
      // splitter, and the scorer still reports those, so they are skipped here.
      for (const island of splitGridIntoIslands(grid, true)) {
        const ctx = buildIslandContext(island.grid);
        const toOriginal = (t: number) => {
          const flat =
            island.originalTileIndices[ctx.ys[t] * island.width + ctx.xs[t]];
          return { x: flat % w, y: Math.floor(flat / w) };
        };

        const placement: Placement = new Array(ctx.n).fill(null);
        for (let t = 0; t < ctx.n; t++) {
          const { x, y } = toOriginal(t);
          const hit = spec.find(([sx, sy]) => sx === x && sy === y);
          if (hit) placement[t] = effective(hit[2]);
        }

        for (const r of simulateIsland(placement, ctx).placements) {
          const { x, y } = toOriginal(r.idx);
          expect(handPower.get(`${x},${y}`)).toBeCloseTo(r.powerGenerated, 6);
        }
      }
      compared++;
    }

    expect(compared).toBeGreaterThan(150);
  });
});

describe("the readout rates a board under the same rules the search does", () => {
  /*
   * The whole reason this module delegates: a terrain bonus is resolved per
   * tile when a board is scored, so if the scorer behind the readout did not
   * take the anomaly, a shore layout would print its authored figures while the
   * solver's identical layout printed bonused ones — the two disagreeing about
   * the same board, which is the one thing this arrangement exists to prevent.
   */
  const tidal = getAnomaly("tidal_ascendancy");

  /** A reactor, generator and cooler in a row, with their tiles. */
  const chain = (x: number, y: number): Spec => [
    [x, y, "reactor", VALUES.reactor],
    [x + 1, y, "generator", VALUES.generator],
    [x + 2, y, "cooler", VALUES.cooler],
  ];

  /** A board walled in by rock, so no tile of it is on the board's edge. */
  const inlandGrid = (w: number, h: number): Tile[][] =>
    Array.from({ length: h }, (_, y) =>
      Array.from({ length: w }, (_, x) => ({
        x,
        y,
        type:
          x === 0 || y === 0 || x === w - 1 || y === h - 1
            ? ("rock" as const)
            : ("grass" as const),
      })),
    );

  const powerOf = (rows: PlacedBuilding[]) =>
    rows.reduce((sum, r) => sum + r.powerGenerated, 0);

  it("bonuses a shore layout and leaves an inland one alone", () => {
    // Every tile of a bare board is on its edge, and off the edge is water.
    const shore = simulatePlacedBuildings(
      grassGrid(5, 1),
      DEFS,
      place(chain(0, 0)),
      undefined,
      tidal,
    );
    const inland = simulatePlacedBuildings(
      inlandGrid(7, 3),
      DEFS,
      place(chain(2, 1)),
      undefined,
      tidal,
    );

    expect(powerOf(inland)).toBeGreaterThan(0);
    expect(powerOf(shore)).toBeCloseTo(powerOf(inland) * 1.67, 6);
  });

  it("changes nothing when no anomaly is passed", () => {
    // The default, and every board in the rest of this file.
    const withNone = simulatePlacedBuildings(
      grassGrid(5, 1),
      DEFS,
      place(chain(0, 0)),
    );
    const inland = simulatePlacedBuildings(
      inlandGrid(7, 3),
      DEFS,
      place(chain(2, 1)),
      undefined,
      tidal,
    );

    expect(powerOf(withNone)).toBeCloseTo(powerOf(inland), 6);
  });
});
