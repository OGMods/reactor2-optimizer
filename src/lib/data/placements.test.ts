import { describe, expect, it } from "vitest";
import type { EffectiveBuilding } from "@reactor2/solver";
import {
  gameStatuses,
  placementFillPercent,
  unscoredPlacement,
} from "./placements";

function rated(
  type: EffectiveBuilding["type"],
  effectiveValue: number,
  energy = 0,
): EffectiveBuilding {
  return { id: "x", type, effectiveValue, energy, waste: 0, baseValue: 0 };
}

describe("placementFillPercent", () => {
  it("gauges a generator by the heat it takes in — the game's 600 / 852", () => {
    const p = { ...unscoredPlacement("g", 0, 0, 0), heatConsumed: 600 };
    expect(placementFillPercent(p, rated("generator", 852))).toBe(70);
  });

  it("gauges each other role by its own figure", () => {
    const base = unscoredPlacement("b", 0, 0, 0);
    expect(
      placementFillPercent(
        { ...base, coolingProvided: 152 },
        rated("cooler", 760),
      ),
    ).toBe(20);
    expect(
      placementFillPercent(
        { ...base, heatProduced: 300 },
        rated("reactor", 300),
      ),
    ).toBe(100);
    expect(
      placementFillPercent(
        { ...base, powerGenerated: 5 },
        rated("direct_producer", 99, 10),
      ),
    ).toBe(50);
  });

  it("reads 0 against no ceiling, and never past 100", () => {
    const base = unscoredPlacement("b", 0, 0, 0);
    expect(placementFillPercent(base, rated("cooler", 0))).toBe(0);
    expect(
      placementFillPercent(
        { ...base, heatProduced: 301 },
        rated("reactor", 300),
      ),
    ).toBe(100);
  });
});

describe("gameStatuses", () => {
  type Row = Parameters<typeof gameStatuses>[0][number];
  const at = (
    id: string,
    x: number,
    y: number,
    figures: Partial<Row> = {},
  ): Row => ({ ...unscoredPlacement(id, x, y, 0), ...figures });

  const REACTOR = rated("reactor", 300);
  const GEN = rated("generator", 852, 636);
  const COOLER = rated("cooler", 760);

  it("calls a generator with no heat source beside it offline", () => {
    expect(gameStatuses([at("g", 0, 0)], [GEN])).toEqual(["offline"]);
  });

  it("calls an unused building with a partner beside it idle", () => {
    // A reactor diagonal to a generator that takes nothing from it: in reach,
    // not needed.
    expect(
      gameStatuses([at("r", 0, 0), at("g", 1, 1)], [REACTOR, GEN]),
    ).toEqual(["idle", "idle"]);
  });

  it("calls a power source its cooling does not cover overheated", () => {
    const g = at("g", 1, 0, { heatConsumed: 600, wasteHeatGenerated: 150 });
    expect(gameStatuses([at("r", 0, 0), g], [REACTOR, GEN])[1]).toBe(
      "overheated",
    );
  });

  it("calls a full generator beside a reactor with heat left wasting heat", () => {
    const covered = { wasteHeatGenerated: 216, coolingReceived: 216 };
    const full = at("g", 1, 0, {
      heatConsumed: 852,
      powerGenerated: 636,
      ...covered,
    });
    const leftover = at("r", 0, 0, { heatProduced: 200 });
    expect(gameStatuses([leftover, full], [REACTOR, GEN])[1]).toBe(
      "wasting_heat",
    );

    const spent = at("r", 0, 0, { heatProduced: 300 });
    expect(gameStatuses([spent, full], [REACTOR, GEN])[1]).toBe("stable");

    // 91% used is under the game's tenth: still Stable. 89% is over it.
    const mostly = at("r", 0, 0, { heatProduced: 273 });
    expect(gameStatuses([mostly, full], [REACTOR, GEN])[1]).toBe("stable");
    const short = at("r", 0, 0, { heatProduced: 267 });
    expect(gameStatuses([short, full], [REACTOR, GEN])[1]).toBe("wasting_heat");
  });

  it("lets a Cryo cooler serve a power source anywhere on the board", () => {
    const rows = [at("c", 0, 0), at("g", 5, 5)];
    expect(gameStatuses(rows, [COOLER, GEN], false)[0]).toBe("offline");
    expect(gameStatuses(rows, [COOLER, GEN], true)[0]).toBe("idle");
  });
});
