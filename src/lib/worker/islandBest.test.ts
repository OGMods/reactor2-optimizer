/**
 * What a multi-attempt run keeps when the same island is searched several
 * times over.
 *
 * The rule is the one the app already applies to a whole re-run: a better
 * attempt wins outright, a tied one is pooled, a worse one is ignored. These
 * cases pin it directly, without needing a worker or a solve.
 */
import { describe, expect, it } from "vitest";
import { IslandBest } from "./islandBest";
import type { IslandLayout, PlacedBuilding } from "../solver/types";

/** One building on an island-local tile, carrying `power` and nothing else. */
function placed(buildingId: string, x: number): PlacedBuilding {
  return {
    x,
    y: 0,
    buildingId,
    baseValue: 1,
    powerGenerated: 0,
    heatProduced: 0,
    heatConsumed: 0,
    wasteHeatGenerated: 0,
    coolingProvided: 0,
    coolingReceived: 0,
  };
}

/**
 * A layout in the `slot`th block of five tiles, scoring `power`.
 *
 * Five buildings rather than one, and a block of its own rather than a tile of
 * its own, because pooling applies the same distance rule the search does: two
 * boards a tile apart are one answer. Any two of these are ten tiles apart.
 */
function layout(buildingId: string, slot: number, power: number): IslandLayout {
  const placements = [0, 1, 2, 3, 4].map((k) =>
    placed(buildingId, slot * 5 + k),
  );
  return { placements, powerOutput: power };
}

/** The shapes a solution holds, primary first, as `id@slot` strings. */
function shapes(best: IslandBest): string[] {
  const solution = best.solution;
  const all = [
    { placements: solution.placements },
    ...(solution.alternates ?? []),
  ];
  return all.map((l) => {
    const first = l.placements[0];
    return first === undefined ? "" : `${first.buildingId}@${first.x / 5}`;
  });
}

describe("IslandBest", () => {
  it("is unsettled until an attempt reports", () => {
    const best = new IslandBest();
    expect(best.settled).toBe(false);
    expect(best.solution.powerOutput).toBe(0);
  });

  it("takes the first attempt whatever it scored", () => {
    // An island with no cooler in the roster genuinely solves to nothing, and
    // that is its answer rather than a placeholder waiting to be improved on.
    const best = new IslandBest();
    best.offer({ placements: [], powerOutput: 0 });
    expect(best.settled).toBe(true);
    expect(best.solution.alternates).toEqual([]);
  });

  it("keeps the higher attempt and drops the loser's ties", () => {
    const best = new IslandBest();
    best.offer({ ...layout("a", 0, 100), alternates: [layout("b", 1, 100)] });
    best.offer({ ...layout("c", 2, 150), alternates: [layout("d", 3, 150)] });

    expect(best.solution.powerOutput).toBe(150);
    expect(shapes(best)).toEqual(["c@2", "d@3"]);
  });

  it("ignores an attempt that came back lower", () => {
    const best = new IslandBest();
    best.offer(layout("a", 0, 150));
    best.offer({ ...layout("b", 1, 100), alternates: [layout("c", 2, 100)] });

    expect(best.solution.powerOutput).toBe(150);
    expect(shapes(best)).toEqual(["a@0"]);
  });

  it("pools tied attempts, the loser's own layout included", () => {
    // This is where a deep run earns its shortlist: one short walk rarely
    // finds ten distinct tied arrangements, but ten of them together do.
    const best = new IslandBest();
    best.offer({ ...layout("a", 0, 100), alternates: [layout("b", 1, 100)] });
    best.offer({ ...layout("c", 2, 100), alternates: [layout("d", 3, 100)] });

    expect(best.solution.powerOutput).toBe(100);
    // The first attempt stays the primary — a tie changes nothing about which
    // layout the board draws — and the second attempt's own layout joins the
    // shortlist rather than being dropped as the one that failed to win.
    expect(shapes(best)).toEqual(["a@0", "b@1", "c@2", "d@3"]);
  });

  it("counts an arrangement two attempts both found only once", () => {
    const best = new IslandBest();
    best.offer(layout("a", 0, 100));
    best.offer({ ...layout("a", 0, 100), alternates: [layout("b", 1, 100)] });

    expect(shapes(best)).toEqual(["a@0", "b@1"]);
  });

  /*
   * The same rule one search applies to its own shortlist. Two attempts that
   * converged on the same corner of the board are not two answers to offer the
   * player, however differently their last cooler landed.
   */
  it("turns away a tied attempt that landed a tile from one it holds", () => {
    const best = new IslandBest();
    best.offer(layout("a", 0, 100));

    const nudged = layout("a", 0, 100);
    nudged.placements[4] = placed("b", 4);
    best.offer(nudged);

    expect(best.solution.alternates).toEqual([]);
  });

  it("treats a hair of floating-point drift as the same power", () => {
    // Two arrangements of the same multiset sum in tile order and can differ
    // in the last bits. Calling that a difference would throw away every tie.
    const best = new IslandBest();
    best.offer(layout("a", 0, 1_000_000));
    best.offer(layout("b", 1, 1_000_000.0000001));

    expect(shapes(best)).toEqual(["a@0", "b@1"]);
  });

  it("stops collecting ties at its limit", () => {
    const best = new IslandBest(2);
    best.offer(layout("a", 0, 100));
    best.offer(layout("b", 1, 100));
    best.offer(layout("c", 2, 100));
    best.offer(layout("d", 3, 100));

    expect(shapes(best)).toHaveLength(3); // primary + 2 alternates
  });
});
