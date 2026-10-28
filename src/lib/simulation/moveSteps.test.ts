/**
 * The move-step planner: that its steps really turn one board into the other,
 * never build onto a taken tile, leave alone what is already right, and order
 * themselves by power — pinned on small boards with a stand-in score, and once
 * on a real island with the real one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILDINGS,
  decodeGameExport,
  getAnomaly,
  prestigeScales,
  resolveGameExport,
} from "@reactor2/solver";
import { createBoardScorer } from "./simulator";
import {
  planMoveSteps,
  priceSteps,
  type BoardBuilding,
  type MovePlan,
  type MoveStep,
} from "./moveSteps";

const b = (buildingId: string, x: number, y: number): BoardBuilding => ({
  buildingId,
  x,
  y,
});
const asSet = (board: readonly BoardBuilding[]) =>
  new Set(board.map((p) => `${p.buildingId}@${p.x},${p.y}`));

/** A stand-in score: one point a building, so more is always better. */
const count = (board: ReadonlyMap<string, string>) => board.size;

/** Replays `plan` on `start`, failing on any step that cannot be taken. */
function replay(start: readonly BoardBuilding[], plan: MovePlan) {
  const board = new Map(start.map((p) => [`${p.x},${p.y}`, p.buildingId]));
  const at = (x: number, y: number) => `${x},${y}`;
  plan.steps.forEach((s: MoveStep, i) => {
    switch (s.kind) {
      case "clear":
        return;
      case "sellAll":
        expect(board.size, `step ${i}`).toBe(s.count);
        board.clear();
        return;
      case "replace":
        expect(board.get(at(s.x, s.y)), `step ${i}`).toBe(s.from);
        board.set(at(s.x, s.y), s.to);
        return;
      case "move":
        expect(board.get(at(s.from.x, s.from.y)), `step ${i}`).toBe(
          s.buildingId,
        );
        expect(board.has(at(s.to.x, s.to.y)), `step ${i} onto taken`).toBe(
          false,
        );
        board.delete(at(s.from.x, s.from.y));
        board.set(at(s.to.x, s.to.y), s.buildingId);
        return;
      case "build":
        expect(board.has(at(s.x, s.y)), `step ${i} onto taken`).toBe(false);
        board.set(at(s.x, s.y), s.buildingId);
        return;
      case "sell":
        expect(board.get(at(s.x, s.y)), `step ${i}`).toBe(s.buildingId);
        board.delete(at(s.x, s.y));
    }
  });
  return [...board].map(([k, buildingId]) => {
    const [x, y] = k.split(",").map(Number);
    return b(buildingId, x, y);
  });
}

describe("planMoveSteps", () => {
  it("turns the start into the target, touching nothing already right", async () => {
    const start = [
      b("cooler1", 0, 0),
      b("generator", 1, 0),
      b("cooler1", 4, 4),
    ];
    const target = [
      b("cooler1", 0, 0),
      b("generator", 2, 0),
      b("cooler2", 3, 3),
    ];
    const plan = await planMoveSteps(start, target, [], [], count);

    expect(asSet(replay(start, plan))).toEqual(asSet(target));
    expect(asSet(plan.boards.at(-1)!)).toEqual(asSet(target));
    expect(plan.boards).toHaveLength(plan.steps.length + 1);
    expect(plan.powers).toHaveLength(plan.steps.length + 1);
    // The cooler at (0,0) is right where it is and is never mentioned.
    expect(JSON.stringify(plan.steps)).not.toContain('"x":0,"y":0');
  });

  it("moves a building rather than selling it and buying another", async () => {
    const plan = await planMoveSteps(
      [b("cooler1", 0, 0), b("cooler1", 9, 9)],
      [b("cooler1", 1, 0), b("cooler1", 8, 9)],
      [],
      [],
      count,
    );
    // Each cooler goes to the wanted tile nearest it, not across the board.
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        {
          kind: "move",
          buildingId: "cooler1",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 0 },
        },
        {
          kind: "move",
          buildingId: "cooler1",
          from: { x: 9, y: 9 },
          to: { x: 8, y: 9 },
        },
      ]),
    );
    expect(plan.steps).toHaveLength(2);
  });

  it("clears an obstacle the target builds on, first", async () => {
    const plan = await planMoveSteps(
      [],
      [b("cooler1", 2, 2)],
      [
        { x: 2, y: 2, type: "rock" },
        { x: 5, y: 5, type: "tree1" },
      ],
      [],
      count,
    );
    expect(plan.steps[0]).toEqual({
      kind: "clear",
      x: 2,
      y: 2,
      obstacle: "rock",
    });
    // An obstacle nothing is built on is left standing.
    expect(plan.steps.filter((s) => s.kind === "clear")).toHaveLength(1);
  });

  it("breaks a ring of moves by parking one on a free tile", async () => {
    const start = [b("cooler1", 0, 0), b("generator", 1, 0)];
    const target = [b("generator", 0, 0), b("cooler1", 1, 0)];
    const plan = await planMoveSteps(
      start,
      target,
      [],
      [{ x: 5, y: 5 }],
      count,
    );

    expect(asSet(replay(start, plan))).toEqual(asSet(target));
    expect(plan.steps.some((s) => s.kind === "move" && s.to.x === 5)).toBe(
      true,
    );
    expect(plan.steps.every((s) => s.kind === "move")).toBe(true);
  });

  it("sells and rebuilds to break a ring with nowhere to park", async () => {
    const start = [b("cooler1", 0, 0), b("generator", 1, 0)];
    const target = [b("generator", 0, 0), b("cooler1", 1, 0)];
    const plan = await planMoveSteps(start, target, [], [], count);

    expect(asSet(replay(start, plan))).toEqual(asSet(target));
    expect(plan.steps.some((s) => s.kind === "sell")).toBe(true);
    expect(plan.steps.some((s) => s.kind === "build")).toBe(true);
  });

  it("replaces a building in place rather than selling and building", async () => {
    const start = [b("cooler1", 0, 0), b("generator", 1, 0)];
    const target = [b("cooler2", 0, 0), b("generator", 1, 0)];
    const plan = await planMoveSteps(start, target, [], [], count);
    expect(plan.steps).toEqual([
      { kind: "replace", from: "cooler1", to: "cooler2", x: 0, y: 0 },
    ]);
  });

  it("sells everything and starts again when the island changes almost entirely", async () => {
    // Five tiles, all changing to buildings found nowhere on the start, and
    // the target on tiles the start does not use: walking it is ten steps.
    const start = [0, 1, 2, 3, 4].map((x) => b("cooler1", x, 0));
    const target = [0, 1, 2, 3].map((x) => b("generator", x, 5));
    const plan = await planMoveSteps(start, target, [], [], count);
    expect(plan.steps[0]).toMatchObject({ kind: "sellAll", count: 5 });
    expect(plan.steps).toHaveLength(1 + target.length);
    expect(asSet(replay(start, plan))).toEqual(asSet(target));
  });

  it("stops once the island makes the target's power", async () => {
    // Power is the generators; the target only shuffles the coolers about.
    const score = (board: ReadonlyMap<string, string>) =>
      [...board.values()].filter((id) => id === "generator").length;
    const plan = await planMoveSteps(
      [b("cooler1", 0, 0), b("cooler1", 1, 0)],
      [b("generator", 5, 5), b("cooler1", 2, 0), b("cooler1", 3, 0)],
      [],
      [],
      score,
      { stopAtPower: 1 },
    );
    expect(plan.steps).toEqual([
      { kind: "build", buildingId: "generator", x: 5, y: 5 },
    ]);
    expect(plan.stoppedEarly).toBe(true);
  });

  it("counts the shorter route between two boards", async () => {
    const { stepCount } = await import("./moveSteps");
    expect(stepCount([b("cooler1", 0, 0)], [b("cooler1", 0, 0)])).toBe(0);
    expect(stepCount([b("cooler1", 0, 0)], [b("cooler2", 0, 0)])).toBe(1);
    expect(stepCount([b("cooler1", 0, 0)], [b("cooler1", 3, 0)])).toBe(1);
  });

  it("orders by power: a running island gets its cooler before its generator", async () => {
    // A generator makes power only while every generator has a cooler: one
    // more without its cooler shuts the lot down.
    const score = (board: ReadonlyMap<string, string>) => {
      const ids = [...board.values()];
      const coolers = ids.filter((id) => id === "cooler1").length;
      const gens = ids.filter((id) => id === "generator").length;
      return gens <= coolers ? gens : 0;
    };
    const running = [b("generator", 0, 0), b("cooler1", 1, 0)];
    const plan = await planMoveSteps(
      running,
      [...running, b("generator", 2, 0), b("cooler1", 3, 0)],
      [],
      [],
      score,
    );
    expect(
      plan.steps.map((s) => (s.kind === "build" ? s.buildingId : s.kind)),
    ).toEqual(["cooler1", "generator"]);
    // The island never goes dark on the way.
    expect(plan.powers).toEqual([1, 1, 2]);
  });

  it("plans a real island from nothing in reasonable time", async () => {
    const code = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../packages/solver/tests/gameExports/gen2_city52_9c43e4b7_server.txt",
      ),
      "utf8",
    );
    const resolved = await resolveGameExport(await decodeGameExport(code));
    const island = resolved.islands.find((i) => i.templateId === "island4")!;
    const score = createBoardScorer(
      island.grid,
      BUILDINGS,
      resolved.buildingUpgrades,
      prestigeScales(resolved.prestigeLevels),
      getAnomaly(resolved.anomalyId),
    );

    const t0 = performance.now();
    const plan = await planMoveSteps([], island.placements, [], [], score);
    const ms = performance.now() - t0;

    expect(plan.steps).toHaveLength(island.placements.length);
    expect(plan.powers.at(-1)).toBeCloseTo(
      score(
        new Map(island.placements.map((p) => [`${p.x},${p.y}`, p.buildingId])),
      ),
      -15,
    );
    expect(ms).toBeLessThan(30_000);
    console.log(
      `island4: ${island.placements.length} builds planned in ${Math.round(ms)}ms`,
    );
  }, 60_000);

  describe("priceSteps", () => {
    // Base 100 for everything, each copy x2, refunds of half the current price.
    const build = (_id: string, n: number) => 100 * 2 ** n;
    const refund = (_id: string, n: number) => (n > 0 ? 100 * 2 ** n * 0.5 : 0);

    it("charges builds as copies climb and refunds sales at the current price", async () => {
      const plan = await planMoveSteps(
        [b("cooler1", 0, 0)],
        [b("cooler1", 0, 0), b("cooler1", 1, 0), b("cooler1", 2, 0)],
        [],
        [],
        count,
      );
      // One cooler1 stands elsewhere too: two copies before the first build.
      const prices = priceSteps(plan, new Map([["cooler1", 2]]), build, refund);
      expect(prices).toEqual([
        { spend: 400, refund: 0 },
        { spend: 800, refund: 0 },
      ]);
    });

    it("prices a replace as a sale and a purchase, and a move as nothing", async () => {
      const plan = await planMoveSteps(
        [b("cooler1", 0, 0), b("generator", 5, 5)],
        [b("cooler2", 0, 0), b("generator", 6, 5)],
        [],
        [],
        count,
      );
      const prices = priceSteps(
        plan,
        new Map([
          ["cooler1", 1],
          ["generator", 1],
        ]),
        build,
        refund,
      );
      const byKind = Object.fromEntries(
        plan.steps.map((s, i) => [s.kind, prices[i]]),
      );
      expect(byKind.replace).toEqual({ spend: 100, refund: 100 });
      expect(byKind.move).toEqual({ spend: 0, refund: 0 });
    });

    it("refunds every building sold by a sell-everything, the count falling", async () => {
      const start = [0, 1, 2].map((x) => b("cooler1", x, 0));
      const plan = await planMoveSteps(
        start,
        [b("generator", 9, 9)],
        [],
        [],
        count,
      );
      expect(plan.steps[0].kind).toBe("sellAll");
      const prices = priceSteps(plan, new Map([["cooler1", 3]]), build, refund);
      // Sold at three, two and one standing: 400 + 200 + 100.
      expect(prices[0]).toEqual({ spend: 0, refund: 700 });
    });
  });
});
