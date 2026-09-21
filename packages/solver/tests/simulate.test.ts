/**
 * `simulateIsland`: the placement evaluator.
 *
 * This is the function the search calls millions of times per solve, so it is
 * also the one most likely to be "optimized" into subtly wrong behaviour. The
 * rules encoded here come from `docs/game-logic.md` — chiefly the authored
 * per-tier conversion, the all-or-nothing cooling rule, and the guarantee that
 * cooling never feeds back into heat.
 *
 * Ported from the reference solver's `tests/test_simulate.py`. Two differences
 * in how the cases are written, both from the port's data structures rather
 * than from its behaviour:
 *
 * - A board is an `IslandContext` over a grass rectangle and a `Placement` is a
 *   dense array over it, where the reference used a `{(x, y): building}` dict.
 *   A `.` in a picture is therefore an empty *buildable* tile, which is what it
 *   meant there too.
 * - Its `NeighborMapConsistencyTests` compared a run with a precomputed
 *   neighbour map against one without. There is no "without" here: adjacency is
 *   built once into the context and every call uses it, so the two paths whose
 *   agreement that test checked do not both exist.
 */
import { describe, expect, it } from "vitest";
import {
  GENERATOR_ENERGY_RATIO,
  GENERATOR_WASTE_RATIO,
} from "../src/solver/constants";
import { buildIslandContext, type IslandContext } from "../src/solver/context";
import { snapToAuthoredPrecision, wasteIsCovered } from "../src/solver/physics";
import { simulateIsland } from "../src/solver/simulate";
import type { EffectiveBuilding, PlacedBuilding } from "../src/solver/types";
import {
  cooler,
  directProducer,
  expectClose,
  generator,
  grassGrid,
  placeOn,
  placementsByPos,
  reactor,
} from "./helpers";

/**
 * Simulates an ASCII board on an all-grass rectangle of its own size.
 *
 * Returns the power and the report rows keyed by `"x,y"`, which is the shape
 * every case below reads.
 */
function run(
  rows: string[],
  legend: Record<string, EffectiveBuilding>,
  fullReport = false,
): {
  power: number;
  byPos: Map<string, PlacedBuilding>;
  placements: PlacedBuilding[];
  ctx: IslandContext;
} {
  const ctx = buildIslandContext(grassGrid(rows[0].length, rows.length));
  const { totalPower, placements } = simulateIsland(
    placeOn(ctx, rows, legend),
    ctx,
    fullReport,
  );
  return {
    power: totalPower,
    byPos: placementsByPos(placements),
    placements,
    ctx,
  };
}

describe("generator physics", () => {
  it("converts 75 percent of the heat it takes into power", () => {
    const { power, byPos } = run(["RGC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(power, 75, 1e-9); // 100 heat in -> 75 power
    expectClose(byPos.get("1,0")!.heatConsumed, 100);
    expectClose(byPos.get("1,0")!.wasteHeatGenerated, 25);
    expectClose(byPos.get("1,0")!.powerGenerated, 75);
  });

  it("keeps the documented fallback ratios", () => {
    expect(GENERATOR_ENERGY_RATIO).toBe(0.75);
    expect(GENERATOR_WASTE_RATIO).toBe(0.25);
    expect(GENERATOR_ENERGY_RATIO + GENERATOR_WASTE_RATIO).toBe(1.0);
  });

  it("caps its input at its own capacity", () => {
    // A reactor's surplus heat is lost, not stored or rerouted.
    const { power, byPos } = run(["RGC"], {
      R: reactor(500),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(power, 75);
    expectClose(byPos.get("1,0")!.heatConsumed, 100); // H_in cannot exceed H_max
    expectClose(byPos.get("0,0")!.heatProduced, 100); // the reactor only reports what it sent
  });

  it("produces nothing with no adjacent reactor", () => {
    const { power } = run(["R.GC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(power, 0);
  });

  it("can be fed by two reactors", () => {
    const { power, byPos } = run(["RGR", ".C."], {
      R: reactor(40),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(byPos.get("1,0")!.heatConsumed, 80);
    expectClose(power, 60);
  });

  it("converts at its own authored rate, not a fixed ratio", () => {
    /*
     * Generator 7 tier 4: heat 8.85e21, energy 6.64e21, waste 2.21e21 — a
     * conversion of 0.7503, not 0.75. Every generator authors its own pair, so
     * a fixed ratio would quietly overstate this one.
     */
    const gen: EffectiveBuilding = {
      id: "generator7",
      type: "generator",
      effectiveValue: 8.85e21,
      energy: 6.64e21,
      waste: snapToAuthoredPrecision(8.85e21 - 6.64e21),
      baseValue: 8.85e21,
    };

    const { power, byPos } = run(["RGC"], {
      R: reactor(8.85e21),
      G: gen,
      C: cooler(gen.waste),
    });

    expectClose(power, 6.64e21);
    expectClose(byPos.get("1,0")!.wasteHeatGenerated, 2.21e21);
    expect(power, "not the 0.75 fallback").not.toBe(
      8.85e21 * GENERATOR_ENERGY_RATIO,
    );
  });

  it("scales both figures by how full it is", () => {
    // Half the heat in, half the power and half the waste out.
    const gen: EffectiveBuilding = {
      id: "odd",
      type: "generator",
      effectiveValue: 100,
      energy: 70,
      waste: 30,
      baseValue: 100,
    };

    const { power, byPos } = run(["RGC"], {
      R: reactor(50),
      G: gen,
      C: cooler(15),
    });

    expectClose(power, 35);
    expectClose(byPos.get("1,0")!.wasteHeatGenerated, 15);
  });
});

describe("the cooling tolerance", () => {
  // `wasteIsCovered` is relative, not a fixed epsilon.

  it("still counts a late-game ULP shortfall as covered", () => {
    /*
     * One ULP at 1e21 is ~1e5, so an absolute epsilon decides nothing up here:
     * it would shut down a generator the game keeps running.
     */
    const waste = 1e21;

    expect(wasteIsCovered(waste, waste - waste * 1e-12)).toBe(true);
  });

  it("still calls a real shortfall a shortfall at any scale", () => {
    expect(wasteIsCovered(1e21, 1e21 * 0.999)).toBe(false);
    expect(wasteIsCovered(10, 9)).toBe(false);
  });
});

describe("the all-or-nothing cooling rule", () => {
  // Online iff waste <= the cooling routed to it.

  it("keeps a building online on exactly enough cooling", () => {
    // The comparison is <=, so cooling equal to waste is valid.
    const { power, byPos } = run(["RGC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(power, 75);
    expectClose(byPos.get("1,0")!.coolingReceived, 25);
  });

  it("shuts a building down completely on slightly too little", () => {
    const { power, byPos } = run(["RGC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(24.9),
    });
    const gen = byPos.get("1,0")!;

    expectClose(power, 0); // partial cooling means zero power, not reduced power
    expectClose(gen.powerGenerated, 0);
    // Heat stays allocated even though the generator is offline.
    expectClose(gen.heatConsumed, 100);
    expectClose(gen.wasteHeatGenerated, 25);
  });

  it("does not let an offline building return its heat", () => {
    /*
     * Two generators fed by one reactor; only the first has cooling. The
     * offline generator must NOT hand its heat back for the online one to use —
     * if it did, generator A (capacity 200) would end up at 200 heat and 150
     * power instead of 100 heat and 75 power.
     */
    const { power, byPos } = run(["ARB", "C.."], {
      A: generator(200, "gen_big"),
      R: reactor(200),
      B: generator(100, "gen_small"),
      C: cooler(50),
    });

    // FairShare splits the reactor 100/100 before cooling is considered.
    expectClose(byPos.get("0,0")!.heatConsumed, 100); // heat is not reassigned
    expectClose(byPos.get("2,0")!.heatConsumed, 100);
    expectClose(byPos.get("2,0")!.powerGenerated, 0); // uncooled generator is offline
    expectClose(power, 75);
  });

  it("can starve both producers sharing one cooler", () => {
    /*
     * A trap worth pinning down: cooling FairShares evenly and the online check
     * is all-or-nothing, so a single cooler adjacent to two generators gives
     * each half of what it needs and BOTH shut down. Total power is 0 even
     * though the cooler has exactly enough capacity for one of them.
     */
    const { power, byPos } = run(["GRG", ".C."], {
      R: reactor(200),
      G: generator(100),
      C: cooler(25),
    });

    expectClose(byPos.get("0,0")!.coolingReceived, 12.5);
    expectClose(byPos.get("2,0")!.coolingReceived, 12.5);
    expectClose(power, 0); // half the required cooling powers nothing
  });

  it("produces no power at all without a cooler", () => {
    const { power, placements } = run(["RG"], {
      R: reactor(100),
      G: generator(100),
    });

    expectClose(power, 0);
    expect(placements.length, "every occupied tile is still reported").toBe(2);
  });

  it("reports only the cooling a cooler actually routed", () => {
    const { byPos } = run(["RGC"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(1000),
    });

    // Spare cooling capacity sits idle.
    expectClose(byPos.get("2,0")!.coolingProvided, 25);
  });
});

describe("direct producers", () => {
  it("commits its full load", () => {
    const { power, byPos } = run(["DC"], {
      D: directProducer(100, 0.2),
      C: cooler(20),
    });

    expectClose(power, 80); // power = the level's energy figure
    // Waste = what it makes minus what it converts.
    expectClose(byPos.get("0,0")!.wasteHeatGenerated, 20);
  });

  it("obeys the all-or-nothing cooling rule", () => {
    const { power } = run(["DC"], {
      D: directProducer(100, 0.2),
      C: cooler(19.9),
    });

    expectClose(power, 0);
  });

  it("never participates in heat distribution", () => {
    // A reactor next to a direct producer must not be able to feed it.
    const { power, byPos } = run(["RDC"], {
      R: reactor(100),
      D: directProducer(100, 0.2),
      C: cooler(20),
    });

    expectClose(byPos.get("0,0")!.heatProduced, 0); // reactor has no valid consumer
    expectClose(power, 80); // the direct producer's own output is unaffected
  });

  it("shares cooling with a generator", () => {
    const { power } = run(["RGCD"], {
      R: reactor(100),
      G: generator(100),
      C: cooler(45),
      D: directProducer(100, 0.2),
    });

    // 45 cooling covers the generator's 25 waste and the producer's 20.
    expectClose(power, 75 + 80);
  });
});

describe("heat and cooling are decided separately", () => {
  // Spec: heat distribution never considers cooling, and vice versa.

  it("fixes a generator's heat input regardless of cooling", () => {
    const legend = { R: reactor(100), G: generator(100) };

    const cooled = run(["RGC"], { ...legend, C: cooler(25) });
    const starved = run(["RGC"], { ...legend, C: cooler(1) });

    // H_in is fixed by heat distribution before cooling is evaluated.
    expectClose(starved.byPos.get("1,0")!.heatConsumed, 100);
    expectClose(cooled.byPos.get("1,0")!.heatConsumed, 100);
    expectClose(cooled.power, 75);
    expectClose(starved.power, 0); // only the ONLINE decision changes
  });

  it("never reduces power by adding cooling", () => {
    const legend = { R: reactor(100), G: generator(100), C: cooler(25) };

    const without = run(["RG."], legend).power;
    const withCooler = run(["RGC"], legend).power;

    expect(withCooler).toBeGreaterThanOrEqual(without);
  });
});

describe("the fast paths", () => {
  // The early-exit branches must agree with the full path.

  it("reports no diagnostics when no cooler is placed", () => {
    /*
     * A deliberate shortcut: with no cooler placed nothing can be online, so
     * `simulateIsland` returns 0 immediately WITHOUT running heat distribution.
     * Per-building diagnostics are therefore all zero in this state — only the
     * total power is meaningful. The search relies on this being fast, so if
     * you ever make the fast path populate real values, keep an eye on solve
     * throughput.
     */
    const { power, byPos } = run(["RG"], {
      R: reactor(100),
      G: generator(100),
    });
    const gen = byPos.get("1,0")!;

    expectClose(power, 0);
    expectClose(gen.heatConsumed, 0);
    expectClose(gen.baseValue, 100); // baseValue is still reported
  });

  it("fills the diagnostics in anyway when asked for a full report", () => {
    /*
     * The one thing the port added here: a player looking at a coolerless board
     * still wants to see the heat its reactors and generators are moving
     * around, even though the search would have stopped at "this scores zero".
     * It changes no number the short-circuit would have reported — it only
     * fills in the ones it skipped.
     */
    const legend = { R: reactor(100), G: generator(100) };

    const quick = run(["RG"], legend);
    const full = run(["RG"], legend, true);

    expectClose(full.power, quick.power);
    expectClose(full.byPos.get("1,0")!.heatConsumed, 100);
    expectClose(full.byPos.get("0,0")!.heatProduced, 100);
    expectClose(full.byPos.get("1,0")!.powerGenerated, 0); // still offline
  });

  it("scores a layout with no power producers at zero", () => {
    const { power, placements } = run(["RC"], {
      R: reactor(100),
      C: cooler(100),
    });

    expectClose(power, 0);
    expect(placements.length).toBe(2);
  });

  it("handles an empty layout", () => {
    const { power, placements } = run([".."], {});

    expectClose(power, 0);
    expect(placements).toEqual([]);
  });

  it("reports every occupied tile exactly once", () => {
    const rows = ["RGC", "DR.", "CGR"];
    const legend: Record<string, EffectiveBuilding> = {
      R: reactor(100),
      G: generator(100),
      C: cooler(50),
      D: directProducer(10, 0.2),
    };
    const occupied = rows.flatMap((row, y) =>
      [...row].flatMap((char, x) =>
        char === "." ? [] : [[`${x},${y}`, char]],
      ),
    ) as [string, string][];

    const { placements, byPos } = run(rows, legend);

    expect(placements.length).toBe(occupied.length);
    expect(new Set(byPos.keys())).toEqual(
      new Set(occupied.map(([pos]) => pos)),
    );
    for (const [pos, char] of occupied) {
      expect(byPos.get(pos)!.buildingId).toBe(legend[char].id);
    }
  });

  it("records a base value for every building", () => {
    const { byPos } = run(["RGC"], {
      R: reactor(100),
      G: generator(80),
      C: cooler(25),
    });

    expectClose(byPos.get("0,0")!.baseValue, 100);
    expectClose(byPos.get("1,0")!.baseValue, 80);
    expectClose(byPos.get("2,0")!.baseValue, 25);
  });
});
