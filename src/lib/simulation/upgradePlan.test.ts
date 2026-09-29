/**
 * `evaluatePlan`: how a layout fares as the upgrade plan is bought.
 *
 * The board is three tiles — a reactor feeding a generator, one cooler beside
 * it — sized so the cooler covers the generator's waste at the reactor's
 * fourth tier and not at its sixth. More heat is more waste, and nothing else
 * on the board changes, so the step that tips it over is known exactly.
 */
import { describe, expect, it } from "vitest";
import {
  BUILDINGS,
  findBuilding,
  getAnomaly,
  levelValue,
  makeGrid,
  resolveUpgradePlan,
  type UpgradeStep,
} from "@reactor2/solver";
import { placementStatus, unscoredPlacement } from "../data/placements";
import { simulatePlacedBuildings } from "./simulator";
import { evaluatePlan } from "./upgradePlan";

const today = { heliothermal_plant: 0, generator2: 5, cooler2: 5 };
const grid = makeGrid(["GGG"]);

/** The three-tile layout, each building at the tier `unlocks` holds. */
function layoutAt(unlocks: Record<string, number>) {
  return ["heliothermal_plant", "generator2", "cooler2"].map((id, x) => {
    const def = findBuilding(id)!;
    return unscoredPlacement(id, x, 0, levelValue(def.levels[unlocks[id]]));
  });
}

function report(steps: UpgradeStep[], unlocks: Record<string, number> = today) {
  return evaluatePlan(
    grid,
    layoutAt(unlocks),
    resolveUpgradePlan(BUILDINGS, unlocks, steps),
    undefined,
    getAnomaly(undefined),
  );
}

describe("evaluatePlan", () => {
  it("is null for a plan that upgrades nothing", () => {
    expect(report([])).toBeNull();
    expect(report([{ buildingId: "heliothermal_plant", level: 0 }])).toBeNull();
  });

  it("counts a building idle today and working after the plan as reserved", () => {
    // A second cooler beside the generator. Cooling fills coolers in the
    // game's processing order (columns left to right, rows bottom up), so the
    // one below covers today's waste alone and the top-row one does nothing
    // until the reactor's sixth tier sends more heat than one can take.
    const unlocks = today;
    const board = makeGrid(["GGG", "GGG"]);
    const layout = [...layoutAt(unlocks), { ...layoutAt(unlocks)[2], y: 1 }];
    const scoredToday = simulatePlacedBuildings(board, BUILDINGS, layout);
    expect(scoredToday.map(placementStatus)).toEqual([
      "active",
      "active",
      "idle",
      "active",
    ]);

    const r = evaluatePlan(
      board,
      scoredToday,
      resolveUpgradePlan(BUILDINGS, unlocks, [
        { buildingId: "heliothermal_plant", level: 5 },
      ]),
      undefined,
      getAnomaly(undefined),
    );
    expect(r?.failedStep).toBeNull();
    expect(r?.reserved).toBe(1);
  });

  it("reports the power at the end of a plan the layout survives", () => {
    const r = report([{ buildingId: "heliothermal_plant", level: 3 }]);
    expect(r?.failedStep).toBeNull();
    expect(r?.overheating).toBe(0);
    // More heat into the same generator: more power than today's.
    expect(r?.power).toBeGreaterThan(61_000);
  });

  it("names the first step that overheats, by its place in the list", () => {
    const r = report([
      { buildingId: "heliothermal_plant", level: 3 },
      { buildingId: "heliothermal_plant", level: 5 },
    ]);
    expect(r?.failedStep).toBe(1);
    expect(r?.overheating).toBe(1);
    // An overheated generator makes nothing.
    expect(r?.power).toBe(0);
  });

  it("indexes the player's list, skipping steps that no longer count", () => {
    // Step 0 is already bought, so the failure is the list's second entry.
    const r = report([
      { buildingId: "heliothermal_plant", level: 0 },
      { buildingId: "heliothermal_plant", level: 5 },
    ]);
    expect(r?.failedStep).toBe(1);
  });

  it("reports the power at the end even when a step on the way fails", () => {
    // A smaller cooler today: the reactor's fourth tier outruns it, and the
    // cooler upgrade after that puts it right. The player ends up with a
    // running board and still needs telling about the step in between.
    const r = report(
      [
        { buildingId: "heliothermal_plant", level: 3 },
        { buildingId: "cooler2", level: 5 },
      ],
      { ...today, cooler2: 4 },
    );
    expect(r?.failedStep).toBe(0);
    expect(r?.overheating).toBe(1);
    expect(r?.power).toBeGreaterThan(61_000);
  });
});
