/**
 * Pins `rng.ts` to the canonical mulberry32 stream.
 *
 * This is the easiest contract in the package to break without noticing, and it
 * is the foundation every golden fixture stands on: if the stream drifts, all
 * of them are invalidated at once and the failures show up somewhere far less
 * obvious than here.
 *
 * If one of these fails, fix the implementation that drifted -- do NOT
 * re-record the goldens from what the code now produces.
 */

import { describe, expect, it } from "vitest";
import { Rng } from "../src/solver/rng";

// seed -> first five outputs, exact doubles.
const GOLDEN: Record<number, number[]> = {
  0: [
    0.26642920868471265, 0.0003297457005828619, 0.2232720274478197,
    0.1462021479383111, 0.46732782293111086,
  ],
  1: [
    0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    0.9810509674716741, 0.9683778982143849,
  ],
  42: [
    0.6011037519201636, 0.44829055899754167, 0.8524657934904099,
    0.6697340414393693, 0.17481389874592423,
  ],
  123456789: [
    0.2577907438389957, 0.9707721115555614, 0.7853280142880976,
    0.20616457983851433, 0.30307188746519387,
  ],
  4294967295: [
    0.8964226141106337, 0.189478256739676, 0.7156526781618595,
    0.9440599093213677, 0.8452364315744489,
  ],
};

describe("the mulberry32 stream", () => {
  it("reproduces every golden stream bit for bit", () => {
    for (const [seed, expected] of Object.entries(GOLDEN)) {
      const rng = new Rng(Number(seed));
      const got = expected.map(() => rng.random());
      expect(got, `stream diverged for seed ${seed}`).toEqual(expected);
    }
  });

  it("wraps the seed to 32 bits", () => {
    const wide = new Rng(2 ** 32 + 7);
    const narrow = new Rng(7);
    for (let i = 0; i < 10; i++) expect(wide.random()).toBe(narrow.random());
  });

  it("keeps outputs in [0, 1)", () => {
    const rng = new Rng(20260818);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.random();
      expect(v).toBeGreaterThanOrEqual(0.0);
      expect(v).toBeLessThan(1.0);
    }
  });

  it("shuffles to a pinned permutation", () => {
    const a = Array.from({ length: 20 }, (_, i) => i);
    new Rng(77).shuffle(a);
    // Pinned: Rng(77).shuffle of 0..19.
    expect(a).toEqual([
      13, 16, 7, 6, 11, 2, 4, 3, 5, 9, 15, 18, 10, 14, 17, 1, 19, 12, 0, 8,
    ]);
  });

  it("picks a pinned choice", () => {
    const items = Array.from({ length: 17 }, (_, i) => i);
    expect(new Rng(9).choice(items)).toBe(3);
  });
});
