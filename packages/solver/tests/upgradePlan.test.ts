/**
 * The upgrade plan: resolving an ordered list of purchases into rosters, and
 * the search holding every layout it keeps to all of them.
 *
 * The search half is pinned as an invariant rather than a figure. What a plan
 * promises is that the returned layout runs — no producer overheats — at
 * today's tiers and after every step, and that is checkable exactly on any
 * run; the power it reaches depends on the budget and is the fixtures' and the
 * CLI's business. The rosters are ones where the promise costs something: a
 * reactor upgrade that shuts down a layout solved for today, and a cooler
 * upgrade that the target alone would build too few coolers for.
 */
import { describe, expect, it } from "vitest";
import { BUILDINGS } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { BLANK_ISLAND_CODE } from "../src/data/maps";
import {
  MAX_UPGRADE_STEPS,
  resolveUpgradePlan,
  type UpgradeStep,
} from "../src/data/upgradePlan";
import { decodeBlueprint } from "../src/encoding/blueprint";
import { buildIslandContext } from "../src/solver/context";
import { wasteIsCovered } from "../src/solver/physics";
import { simulateIsland } from "../src/solver/simulate";
import { planSolve, solve } from "../src/solver/solver";
import type {
  BuildingDefinition,
  PlacedBuilding,
  Placement,
  Tile,
} from "../src/solver/types";

const CATALOGUE = BUILDINGS as BuildingDefinition[];

describe("resolveUpgradePlan", () => {
  const roster = { generator4: 3, cooler4: 5, quantum_reactor: 1 };

  it("walks the steps in order, each roster one purchase on from the last", () => {
    const steps: UpgradeStep[] = [
      { buildingId: "cooler4", level: 6 },
      { buildingId: "generator4", level: 5 },
      { buildingId: "quantum_reactor", level: 2 },
    ];
    const plan = resolveUpgradePlan(CATALOGUE, roster, steps);
    expect(plan.effective).toEqual([true, true, true]);
    expect(plan.along).toEqual([
      roster,
      { ...roster, cooler4: 6 },
      { ...roster, cooler4: 6, generator4: 5 },
    ]);
    expect(plan.target).toEqual({
      generator4: 5,
      cooler4: 6,
      quantum_reactor: 2,
    });
  });

  it("skips a step the roster has caught up with, rather than refusing it", () => {
    // Bought: the roster already holds generator4 at 5.
    const plan = resolveUpgradePlan(CATALOGUE, { ...roster, generator4: 5 }, [
      { buildingId: "generator4", level: 5 },
      { buildingId: "cooler4", level: 7 },
    ]);
    expect(plan.effective).toEqual([false, true]);
    expect(plan.along).toHaveLength(1);
    expect(plan.target.cooler4).toBe(7);
  });

  it("counts a building's earlier step, so the same tier twice is one step", () => {
    const plan = resolveUpgradePlan(CATALOGUE, roster, [
      { buildingId: "generator4", level: 4 },
      { buildingId: "generator4", level: 4 },
      { buildingId: "generator4", level: 5 },
    ]);
    expect(plan.effective).toEqual([true, false, true]);
    expect(plan.target.generator4).toBe(5);
  });

  it("ignores a locked building and a level past the table", () => {
    const plan = resolveUpgradePlan(CATALOGUE, roster, [
      { buildingId: "generator7", level: 1 },
      { buildingId: "generator4", level: 99 },
      { buildingId: "no_such_building", level: 1 },
    ]);
    expect(plan.effective).toEqual([false, false, false]);
    expect(plan.along).toEqual([]);
    expect(plan.target).toBe(roster);
  });

  it(`reads no more than ${MAX_UPGRADE_STEPS} steps`, () => {
    const plan = resolveUpgradePlan(CATALOGUE, { cooler6: 0 }, [
      { buildingId: "cooler6", level: 1 },
      { buildingId: "cooler6", level: 2 },
      { buildingId: "cooler6", level: 3 },
      { buildingId: "cooler6", level: 4 },
    ]);
    expect(plan.effective).toHaveLength(MAX_UPGRADE_STEPS);
    expect(plan.target.cooler6).toBe(3);
  });
});

/** Everything up to the named tiers at their top level, the named ones below it. */
function roster(
  top: Record<string, number>,
  alsoMaxed: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of alsoMaxed) {
    const def = CATALOGUE.find((b) => b.id === id)!;
    out[id] = def.levels.length - 1;
  }
  return { ...out, ...top };
}

/** Producers that overheat when the layout is rated at `unlocks`. */
function overheatingAt(
  grid: Tile[][],
  placements: PlacedBuilding[],
  unlocks: Record<string, number>,
): number {
  const byId = new Map(
    getEffectiveBuildings(CATALOGUE, unlocks).map((b) => [b.id, b]),
  );
  const ctx = buildIslandContext(grid);
  const stride = Math.max(...ctx.xs) + 1;
  const tileAt = new Map<number, number>();
  for (let t = 0; t < ctx.n; t++) tileAt.set(ctx.ys[t] * stride + ctx.xs[t], t);
  const placement: Placement = new Array(ctx.n).fill(null);
  for (const p of placements) {
    const t = tileAt.get(p.y * stride + p.x)!;
    placement[t] = ctx.rate(t, byId.get(p.buildingId)!);
  }
  return simulateIsland(placement, ctx, true).placements.filter(
    (row) =>
      row.wasteHeatGenerated > 0 &&
      !wasteIsCovered(row.wasteHeatGenerated, row.coolingReceived),
  ).length;
}

describe("solving under an upgrade plan", () => {
  // The generator-4 era: everything below maxed, the top of each role mid-way.
  const today = roster({ generator4: 3, cooler4: 5, quantum_reactor: 1 }, [
    "cooler1",
    "cooler2",
    "cooler3",
    "generator",
    "generator2",
    "generator3",
    "solar_panel",
    "coal_plant",
    "hydro_plant",
    "gas_plant",
    "heliothermal_plant",
    "geothermal_plant",
    "biomass_plant",
    "nuclear_reactor",
    "fusion_reactor",
    "arc_reactor",
    "antimatter_plant",
  ]);

  const cases: [string, UpgradeStep[]][] = [
    // More heat, and nothing more to cool it with.
    ["a reactor upgrade", [{ buildingId: "quantum_reactor", level: 3 }]],
    // Fewer coolers do at the target than today.
    ["a cooler upgrade", [{ buildingId: "cooler4", level: 7 }]],
    [
      "three upgrades in order",
      [
        { buildingId: "cooler4", level: 6 },
        { buildingId: "generator4", level: 4 },
        { buildingId: "quantum_reactor", level: 2 },
      ],
    ],
  ];

  for (const [name, steps] of cases) {
    it(`keeps the layout running at every step of ${name}`, async () => {
      const { grid } = await decodeBlueprint(BLANK_ISLAND_CODE);
      const plan = resolveUpgradePlan(CATALOGUE, today, steps);
      expect(plan.along.length).toBe(steps.length);

      const result = await solve(
        grid,
        CATALOGUE,
        plan.target,
        1.5,
        { upgradePlan: plan.along },
        7,
      );

      expect(result.totalPower).toBeGreaterThan(0);
      for (const unlocks of [...plan.along, plan.target]) {
        expect(overheatingAt(grid, result.placements, unlocks)).toBe(0);
      }
    });
  }

  it("treats an empty plan as no plan", async () => {
    const { grid } = await decodeBlueprint(BLANK_ISLAND_CODE);
    const plan = planSolve(
      grid,
      CATALOGUE,
      today,
      1,
      0,
      undefined,
      undefined,
      [],
    );
    expect(plan?.upgradeSteps).toEqual([]);
  });

  it("resolves each step's roster the way the target's is resolved", async () => {
    const { grid } = await decodeBlueprint(BLANK_ISLAND_CODE);
    const steps = resolveUpgradePlan(CATALOGUE, today, cases[2][1]);
    const plan = planSolve(
      grid,
      CATALOGUE,
      steps.target,
      1,
      0,
      undefined,
      undefined,
      steps.along,
    )!;
    expect(plan.upgradeSteps).toEqual(
      steps.along.map((unlocks) => getEffectiveBuildings(CATALOGUE, unlocks)),
    );
  });
});
