/**
 * The upgrade plan's editing verbs on `configState`.
 *
 * The resolver underneath is pinned in the solver package; these pin what the
 * dialog relies on: a maxed building is never offered, a new step is one tier
 * up from wherever the plan already leaves its building, the order can be
 * changed, and a building's card can ask what tier the plan takes it to.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_UPGRADE_STEPS } from "@reactor2/solver";
import { configState } from "./config.svelte";

beforeEach(() => {
  configState.lockAll();
  while (configState.upgradePlan.length > 0) configState.removePlanStep(0);
  // generator4 has six tiers (0-5), cooler4 eight (0-7).
  configState.setUpgradeLevel("generator4", 3);
  configState.setUpgradeLevel("cooler4", 7);
  configState.setUpgradeLevel("quantum_reactor", 1);
});

describe("which buildings a step may name", () => {
  it("offers an unlocked building below its top tier", () => {
    expect(configState.canPlan("generator4")).toBe(true);
  });

  it("does not offer a maxed building", () => {
    expect(configState.canPlan("cooler4")).toBe(false);
    configState.addPlanStep("cooler4");
    expect(configState.upgradePlan).toEqual([]);
  });

  it("does not offer a locked one", () => {
    expect(configState.canPlan("generator7")).toBe(false);
  });

  it("stops offering a building once the plan takes it to the top", () => {
    configState.addPlanStep("generator4");
    configState.setPlanStep(0, { buildingId: "generator4", level: 5 });
    expect(configState.canPlan("generator4")).toBe(false);
  });
});

describe("adding and ordering steps", () => {
  it("starts a step one tier above where the plan leaves the building", () => {
    configState.addPlanStep("generator4");
    configState.addPlanStep("generator4");
    expect(configState.upgradePlan).toEqual([
      { buildingId: "generator4", level: 4 },
      { buildingId: "generator4", level: 5 },
    ]);
  });

  it(`holds no more than ${MAX_UPGRADE_STEPS} steps`, () => {
    configState.addPlanStep("quantum_reactor");
    configState.addPlanStep("quantum_reactor");
    configState.addPlanStep("quantum_reactor");
    configState.addPlanStep("generator4");
    expect(configState.upgradePlan).toHaveLength(MAX_UPGRADE_STEPS);
  });

  it("moves a step earlier or later, and not past either end", () => {
    configState.addPlanStep("generator4");
    configState.addPlanStep("quantum_reactor");
    configState.movePlanStep(1, -1);
    expect(configState.upgradePlan.map((s) => s.buildingId)).toEqual([
      "quantum_reactor",
      "generator4",
    ]);
    configState.movePlanStep(0, -1);
    configState.movePlanStep(1, 1);
    expect(configState.upgradePlan.map((s) => s.buildingId)).toEqual([
      "quantum_reactor",
      "generator4",
    ]);
  });
});

describe("the planned tier a card marks", () => {
  it("is where the whole plan leaves the building", () => {
    configState.addPlanStep("generator4");
    configState.addPlanStep("generator4");
    expect(configState.plannedLevel("generator4")).toBe(5);
  });

  it("is null for a building the plan leaves alone", () => {
    configState.addPlanStep("generator4");
    expect(configState.plannedLevel("quantum_reactor")).toBeNull();
  });

  it("is null once the roster has caught up — the tier was bought", () => {
    configState.addPlanStep("generator4");
    configState.setUpgradeLevel("generator4", 4);
    expect(configState.plannedLevel("generator4")).toBeNull();
  });
});
