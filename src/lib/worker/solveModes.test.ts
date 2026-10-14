/**
 * What a run mode costs in wall-clock.
 *
 * The figure on the mode control is the one thing that makes "5 × 20s" a
 * decision rather than a guess, and it is only honest if it models the pool the
 * coordinator actually schedules onto. These cases pin the two ends of that:
 * a pool wide enough to overlap the attempts, and one that is not.
 */
import { describe, expect, it } from "vitest";
import {
  SOLVE_MODES,
  estimateMakespanMs,
  solveModeFor,
  taskDurationsMs,
} from "./solveModes";

describe("taskDurationsMs", () => {
  it("splits an attempt's budget across islands by tile count squared", () => {
    // 900 : 100, where a linear split would give 3 : 1. See `islandBudgetsS`.
    // On one worker the run queues, so the slices have to sum to the budget.
    const durations = taskDurationsMs(SOLVE_MODES.quick, [30, 10], 1);
    expect(durations).toEqual([27_000, 3_000]);
  });

  /*
   * With a worker per task the islands run side by side and the run lasts as
   * long as its largest slice, so the slices are stretched until that one is
   * the whole budget: a "30s" run takes 30s, and every island gets more.
   */
  it("stretches the split to the whole budget when the run fits the pool", () => {
    const [big, small] = taskDurationsMs(SOLVE_MODES.quick, [30, 10], 8);
    expect(big).toBe(30_000);
    expect(small).toBeCloseTo(30_000 / 9);
    expect(
      estimateMakespanMs(taskDurationsMs(SOLVE_MODES.quick, [30, 10], 8), 8),
    ).toBe(30_000);
  });

  it("leaves the split alone once the run has to queue", () => {
    // 5 attempts x 2 islands is ten tasks for eight workers.
    expect(taskDurationsMs(SOLVE_MODES.deep, [30, 10], 8).slice(0, 2)).toEqual([
      18_000, 2_000,
    ]);
  });

  it("repeats the split once per attempt, attempt-major", () => {
    // Attempt-major is what lets an early Stop still leave every island
    // solved; island-major would starve the last one.
    const durations = taskDurationsMs(
      { ...SOLVE_MODES.deep, attempts: 3 },
      [1, 1],
      1,
    );
    expect(durations).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it("survives a board with no buildable tiles at all", () => {
    expect(taskDurationsMs(SOLVE_MODES.quick, [0], 8)).toEqual([0]);
  });
});

describe("estimateMakespanMs", () => {
  it("is the single task's own budget when there is only one", () => {
    expect(
      estimateMakespanMs(taskDurationsMs(SOLVE_MODES.quick, [10], 8), 8),
    ).toBe(30_000);
  });

  it("overlaps a deep run's attempts across the pool", () => {
    // Five 20s attempts of one island on four workers: two rounds, because the
    // fifth task has to wait for a worker to come free.
    expect(
      estimateMakespanMs(taskDurationsMs(SOLVE_MODES.deep, [10], 4), 4),
    ).toBe(40_000);
  });

  it("charges a single-worker browser the full serial price", () => {
    expect(
      estimateMakespanMs(taskDurationsMs(SOLVE_MODES.deep, [10], 1), 1),
    ).toBe(100_000);
    expect(
      estimateMakespanMs(taskDurationsMs(SOLVE_MODES.max, [10], 1), 1),
    ).toBe(500_000);
  });

  it("keeps a twenty-five-attempt run to four rounds on seven workers", () => {
    // 25 tasks over 7 workers is 3 apiece with four left over, so four workers
    // run a fourth — 80s, not the 500s the mode's own arithmetic suggests.
    expect(
      estimateMakespanMs(taskDurationsMs(SOLVE_MODES.max, [10], 7), 7),
    ).toBe(80_000);
  });

  it("never reports less than the longest single task", () => {
    // An island that owns most of the board gets most of every attempt's
    // budget, and no amount of parallelism makes that one search shorter. The
    // two scraps are held at the quarter-second floor, so it gets the rest.
    const durations = taskDurationsMs(SOLVE_MODES.quick, [90, 5, 5], 2);
    expect(estimateMakespanMs(durations, 2)).toBe(29_500);
  });

  it("is zero when there is nothing to schedule", () => {
    expect(estimateMakespanMs([], 8)).toBe(0);
  });
});

describe("solveModeFor", () => {
  it("leaves every mode alone under the base rules", () => {
    for (const mode of Object.values(SOLVE_MODES))
      expect(solveModeFor(mode, "none")).toBe(mode);
  });

  it("lengthens each attempt under Singularity, and the shape says so", () => {
    const deep = solveModeFor(SOLVE_MODES.deep, "singularity_isolation");
    expect(deep.attempts).toBe(SOLVE_MODES.deep.attempts);
    expect(deep.attemptBudgetMs).toBeGreaterThan(
      SOLVE_MODES.deep.attemptBudgetMs,
    );
    expect(deep.shape).toBe(`5 × ${deep.attemptBudgetMs / 1000}s`);
  });

  it("reads an unknown id as the base rules, as getAnomaly does", () => {
    expect(solveModeFor(SOLVE_MODES.quick, "not-an-anomaly")).toBe(
      SOLVE_MODES.quick,
    );
  });
});
