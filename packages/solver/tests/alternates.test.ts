/**
 * The shortlist of tied layouts: what the collector keeps, and what the search
 * hands back with a solved island.
 *
 * The retired reference solver had no equivalent — it solved for one layout —
 * so there is no fixture to replay here. What it pins is the promise the card
 * makes to the player: every alternate is a *materially different* board, at
 * the *same* power, and as buildable as the one the search settled on.
 * "Materially different" is `MIN_ALTERNATE_DISTANCE` tiles apart — a shortlist
 * of boards that differ by one swapped cooler is a shortlist of one board.
 */
import { describe, expect, it } from "vitest";
import {
  AlternateCollector,
  MAX_ALTERNATES,
  MIN_ALTERNATE_DISTANCE,
  layoutDistance,
  placementDistance,
  powerTies,
} from "../src/solver/alternates";
import { BUILDINGS } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import {
  splitGridIntoIslands,
  canCoolDirectProducer,
} from "../src/solver/island";
import { solveIsland } from "../src/solver/placementSearch";
import type {
  EffectiveBuilding,
  PlacedBuilding,
  Placement,
  Tile,
} from "../src/solver/types";

function grassGrid(w: number, h: number): Tile[][] {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x): Tile => ({ x, y, type: "grass" })),
  );
}

/** A stand-in building; only its id reaches the layout key. */
function stub(id: string): EffectiveBuilding {
  return {
    id,
    type: "cooler",
    effectiveValue: 1,
    energy: 0,
    waste: 0,
    baseValue: 1,
  };
}

/** `..A.B` — dots are empty tiles, letters are building ids. */
function layout(spec: string): Placement {
  return [...spec].map((c) => (c === "." ? null : stub(c)));
}

/**
 * A board of five `id` buildings in the `slot`th block of five tiles, on an
 * island of `blocks` such blocks. Any two of these are ten tiles apart, so
 * they clear the distance rule with room to spare — which is what these cases
 * are about, except where they are about the rule itself.
 */
function block(id: string, slot: number, blocks = slot + 1): Placement {
  const spec = Array.from({ length: blocks }, (_, i) =>
    i === slot ? id.repeat(5) : ".....",
  ).join("");
  return layout(spec);
}

describe("AlternateCollector", () => {
  it("keeps distinct layouts that tie, and only those", () => {
    const collector = new AlternateCollector();
    collector.offer(100, block("A", 0, 2));
    collector.offer(100, block("B", 1, 2));
    collector.offer(100, block("A", 0, 2)); // the same board again
    collector.offer(99, layout("AAAAABBBBB")); // a worse one

    expect(collector.layouts()).toHaveLength(2);
    expect(collector.power).toBe(100);
  });

  /*
   * The rule this file is really about. A converged walk ties its own best
   * constantly, and nearly every one of those ties is the layout it already
   * holds with one tile swapped. Ten of those are not ten answers, and cycling
   * through them on the board looks like nothing is happening at all.
   */
  it("turns away a tie that is only a tile or two from one it holds", () => {
    const collector = new AlternateCollector();
    collector.offer(100, layout("AAAAA....."));

    // One tile substituted, then one building relocated: 1 apart and 2 apart.
    expect(collector.accepts(layout("AAAAB....."))).toBe(false);
    expect(collector.accepts(layout(".AAAAA...."))).toBe(false);
    // Four tiles is still the same board rearranged; five is a different one.
    expect(collector.accepts(layout("..AAAAA..."))).toBe(false);
    expect(collector.accepts(layout("....AAAAA."))).toBe(true);

    collector.offer(100, layout("AAAAB....."));
    collector.offer(100, layout("....AAAAA."));
    expect(collector.layouts()).toHaveLength(2);
  });

  it("measures a board against every layout held, not just the last", () => {
    const collector = new AlternateCollector();
    collector.offer(100, block("A", 0, 3));
    collector.offer(100, block("A", 2, 3));

    // Five tiles from the second entry, but one from the first.
    expect(collector.accepts(layout("AAAAB.........."))).toBe(false);
    expect(collector.layouts()).toHaveLength(2);
  });

  it("keeps a better layout however close it is to what it replaces", () => {
    // The bar is on being a second answer, not on being an answer: a new best
    // empties the shortlist, so there is nothing left for it to be close to.
    const collector = new AlternateCollector();
    collector.offer(100, layout("AAAAA....."));
    collector.offer(120, layout("AAAAB....."));

    expect(collector.layouts()).toHaveLength(1);
    expect(collector.power).toBe(120);
  });

  it("drops everything the moment a better layout turns up", () => {
    const collector = new AlternateCollector();
    collector.offer(100, block("A", 0, 2));
    collector.offer(100, block("B", 1, 2));
    collector.offer(120, layout("AAAAABBBBB"));

    expect(collector.layouts()).toHaveLength(1);
    expect(collector.power).toBe(120);
  });

  /*
   * Two arrangements of the same buildings sum their power in tile order, so
   * they can differ in the last bits while being the same answer. Against the
   * solver's absolute EPS at the millions these layouts reach, every alternate
   * would be thrown away as a worse layout.
   */
  it("treats a last-bit difference at scale as the same power", () => {
    const power = 1_234_567.25;
    expect(powerTies(power, power + power * 1e-14)).toBe(true);
    expect(powerTies(power, power * 1.0001)).toBe(false);

    const collector = new AlternateCollector();
    collector.offer(power, block("A", 0, 2));
    collector.offer(power + power * 1e-14, block("B", 1, 2));
    expect(collector.layouts()).toHaveLength(2);
  });

  it("stops at the cap rather than growing without bound", () => {
    const total = MAX_ALTERNATES + 5;
    const collector = new AlternateCollector();
    for (let i = 0; i < total; i++) {
      collector.offer(100, block("A", i, total));
    }
    expect(collector.full).toBe(true);
    expect(collector.layouts()).toHaveLength(MAX_ALTERNATES);
  });
});

describe("how far apart two layouts are", () => {
  it("counts the tiles they disagree on, an empty tile included", () => {
    expect(placementDistance(layout("AAA"), layout("AAA"))).toBe(0);
    expect(placementDistance(layout("AAA"), layout("AAB"))).toBe(1);
    expect(placementDistance(layout("AAA"), layout("..A"))).toBe(2);
    // Relocating one building moves two tiles: the one it left and the one it
    // landed on. That is the case the rule is written against.
    expect(placementDistance(layout("A.."), layout(".A."))).toBe(2);
  });

  it("stops counting once the answer cannot change", () => {
    // The walk only ever asks whether the distance clears the bar.
    const far = placementDistance(
      layout("AAAAAAAA"),
      layout("........"),
      MIN_ALTERNATE_DISTANCE,
    );
    expect(far).toBe(MIN_ALTERNATE_DISTANCE);
  });

  it("says the same thing over rows as it does over tiles", () => {
    const rows = (spec: string): PlacedBuilding[] =>
      [...spec].flatMap((c, x) =>
        c === "."
          ? []
          : [
              {
                x,
                y: 0,
                buildingId: c,
                baseValue: 1,
                powerGenerated: 0,
                heatProduced: 0,
                heatConsumed: 0,
                wasteHeatGenerated: 0,
                coolingProvided: 0,
                coolingReceived: 0,
              },
            ],
      );

    for (const [a, b] of [
      ["AAA", "AAB"],
      ["A..", ".A."],
      ["AAAAA", "....."],
    ]) {
      expect(layoutDistance(rows(a), rows(b))).toBe(
        placementDistance(layout(a), layout(b)),
      );
    }
  });
});

describe("solveIsland's alternates", () => {
  const upgrades = { generator: 0, nuclear_reactor: 0, cooler1: 0 };
  const effective = getEffectiveBuildings(BUILDINGS, upgrades);
  const grid = grassGrid(4, 4);
  const [island] = splitGridIntoIslands(grid, canCoolDirectProducer(effective));

  /** Every producer online, and the rows adding up to what was reported. */
  function isStable(
    placements: PlacedBuilding[],
    powerOutput: number,
  ): boolean {
    let sum = 0;
    for (const p of placements) sum += p.powerGenerated;
    if (!powerTies(sum, powerOutput)) return false;
    return placements.every((p) => {
      const def = BUILDINGS.find((b) => b.id === p.buildingId);
      const producer =
        def?.type === "generator" || def?.type === "direct_producer";
      return !producer || p.powerGenerated > 0;
    });
  }

  it("comes back with boards that differ, tie, and stand up on their own", async () => {
    const solution = await solveIsland(island, effective, 0.4);
    const alternates = solution.alternates ?? [];

    expect(solution.powerOutput).toBeGreaterThan(0);
    expect(alternates.length).toBeLessThanOrEqual(MAX_ALTERNATES);

    const boards = [solution, ...alternates];
    for (const layout of boards) {
      expect(powerTies(layout.powerOutput, solution.powerOutput)).toBe(true);
      expect(isStable(layout.placements, layout.powerOutput)).toBe(true);
    }

    // No two entries describe the same board — including the primary — and
    // "the same board" is a distance, not a string comparison: an entry that
    // only moves one cooler is the board the player is already looking at,
    // however different its key is.
    for (let i = 0; i < boards.length; i++) {
      for (let j = i + 1; j < boards.length; j++) {
        expect(
          layoutDistance(boards[i].placements, boards[j].placements),
        ).toBeGreaterThanOrEqual(MIN_ALTERNATE_DISTANCE);
      }
    }
  });
});
