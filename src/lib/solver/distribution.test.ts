/**
 * Pins the Distribution System against measurements taken from the live game.
 *
 * Each case below was built in-game and its per-building power read off, so
 * these are observations, not derivations from `docs/game-logic.md` -- the
 * doc was wrong about this rule until these runs corrected it.
 *
 * The middle case is the one that matters historically: a SINGLE supplier
 * cannot distinguish an even leftover re-split from a sequential handoff,
 * because Augmenting Repair places the remainder identically either way. The
 * doc's original "validated in-game" example was single-supplier, which is why
 * the wrong rule survived validation. Keep at least one multi-supplier case
 * here, and keep the third case, which is the only one that pins the round
 * loop as sitting outside the supplier loop.
 */
import { describe, it, expect } from "vitest";
import { buildIslandContext } from "./context";
import { runDistribution } from "./distribution";
import type { Tile } from "./types";

function grid(w: number, h: number): Tile[][] {
  const g: Tile[][] = [];
  for (let y = 0; y < h; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < w; x++) row.push({ x, y, type: "grass" } as Tile);
    g.push(row);
  }
  return g;
}

function heat(
  w: number,
  h: number,
  sup: [number, number, number][],
  con: [number, number, number][],
) {
  const ctx = buildIslandContext(grid(w, h));
  const idx = (x: number, y: number) => {
    for (let i = 0; i < ctx.n; i++)
      if (ctx.xs[i] === x && ctx.ys[i] === y) return i;
    throw new Error(`no tile ${x},${y}`);
  };
  const st = Int32Array.from(
    sup.map(([x, y]) => idx(x, y)).sort((a, b) => a - b),
  );
  const ct = Int32Array.from(
    con.map(([x, y]) => idx(x, y)).sort((a, b) => a - b),
  );
  const capOf = (list: [number, number, number][], t: number) => {
    const e = list.find(([x, y]) => idx(x, y) === t)!;
    return e[2];
  };
  for (let i = 0; i < st.length; i++)
    ctx.dist.supplierCap[i] = capOf(sup, st[i]);
  for (let j = 0; j < ct.length; j++)
    ctx.dist.consumerCap[j] = capOf(con, ct[j]);
  runDistribution(st, st.length, ct, ct.length, ctx);
  const out = new Map<string, number>();
  for (let j = 0; j < ct.length; j++)
    out.set(
      `${ctx.xs[ct[j]]},${ctx.ys[ct[j]]}`,
      ctx.dist.consumerReceived[j] * 0.75,
    );
  return out;
}

describe("FairShare matches the live game", () => {
  const G2 = 1.31e6,
    G1 = 2560,
    HELIO = 250000;

  it("two contested reactors re-split the leftover evenly", () => {
    const r = heat(
      3,
      3,
      [
        [0, 1, HELIO],
        [2, 1, HELIO],
      ],
      [
        [1, 2, G2],
        [1, 1, G2],
        [1, 0, G1],
      ],
    );
    expect(r.get("1,2")).toBeCloseTo(186540, 3);
    expect(r.get("1,1")).toBeCloseTo(186540, 3);
    expect(r.get("1,0")).toBeCloseTo(1920, 6);
  });

  it("a single reactor leaves its remainder to sequential Augmenting Repair", () => {
    const r = heat(
      3,
      3,
      [[0, 1, HELIO]],
      [
        [1, 2, G2],
        [1, 1, G2],
        [1, 0, G1],
      ],
    );
    expect(r.get("1,2")).toBeCloseTo(123080, 3);
    expect(r.get("1,1")).toBeCloseTo(62500, 3);
    expect(r.get("1,0")).toBeCloseTo(1920, 6);
  });

  it("the round loop sits outside the supplier loop", () => {
    const DIV = 1.72e16,
      G5 = 1.69e16;
    const r = heat(
      3,
      3,
      [
        [0, 0, DIV],
        [1, 1, DIV],
      ],
      [
        [0, 1, G5],
        [1, 2, G5],
        [1, 0, G2],
        [2, 1, G5],
      ],
    );
    expect(r.get("0,1")! / 1e16).toBeCloseTo(1.2675, 6);
    expect(r.get("1,2")! / 1e15).toBeCloseTo(8.6, 6);
    expect(r.get("2,1")! / 1e15).toBeCloseTo(4.3, 6);
  });
});

describe("FairShare rounds are scoped to the connected component", () => {
  const HELIO = 250000,
    G2 = 1.31e6,
    G1 = 2560;

  it("an unreachable second reactor does not buy the first an extra round", () => {
    // One reactor feeding three generators, plus a second reactor/generator
    // pair far enough away to share nothing. The isolated cluster must behave
    // exactly as it does alone: one round, remainder placed by repair.
    const r = heat(
      8,
      3,
      [
        [0, 1, HELIO],
        [5, 1, HELIO],
      ],
      [
        [1, 2, G2],
        [1, 1, G2],
        [1, 0, G1],
        [6, 1, G2],
      ],
    );
    expect(r.get("1,2")).toBeCloseTo(123080, 3);
    expect(r.get("1,1")).toBeCloseTo(62500, 3);
    expect(r.get("1,0")).toBeCloseTo(1920, 6);

    // Same board without the far pair — identical numbers for the cluster.
    const alone = heat(
      8,
      3,
      [[0, 1, HELIO]],
      [
        [1, 2, G2],
        [1, 1, G2],
        [1, 0, G1],
      ],
    );
    expect(r.get("1,2")).toBeCloseTo(alone.get("1,2")!, 6);
    expect(r.get("1,1")).toBeCloseTo(alone.get("1,1")!, 6);
  });
});
