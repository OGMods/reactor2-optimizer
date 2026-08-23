/**
 * What a run mode costs in wall-clock.
 *
 * The figure on the mode control is the one thing that makes "10 × 10s" a
 * decision rather than a guess, and it is only honest if it models the pool the
 * coordinator actually schedules onto. These cases pin the two ends of that:
 * a pool wide enough to overlap the attempts, and one that is not.
 */
import { describe, expect, it } from "vitest";
import { SOLVE_MODES, estimateMakespanMs, taskDurationsMs } from "./solveModes";

describe("taskDurationsMs", () => {
  it("splits an attempt's budget across islands by tile count", () => {
    const durations = taskDurationsMs(SOLVE_MODES.quick, [30, 10]);
    expect(durations).toEqual([22_500, 7_500]);
  });

  it("repeats the split once per attempt, attempt-major", () => {
    // Attempt-major is what lets an early Stop still leave every island
    // solved; island-major would starve the last one.
    const durations = taskDurationsMs(
      { ...SOLVE_MODES.deep, attempts: 3 },
      [1, 1],
    );
    expect(durations).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it("survives a board with no buildable tiles at all", () => {
    expect(taskDurationsMs(SOLVE_MODES.quick, [0])).toEqual([0]);
  });
});

describe("estimateMakespanMs", () => {
  it("is the single task's own budget when there is only one", () => {
    expect(
      estimateMakespanMs(taskDurationsMs(SOLVE_MODES.quick, [10]), 8),
    ).toBe(30_000);
  });

  it("overlaps a deep run's attempts across the pool", () => {
    // Ten 10s attempts of one island on seven workers: two rounds, because the
    // eighth task has to wait for a worker to come free.
    expect(estimateMakespanMs(taskDurationsMs(SOLVE_MODES.deep, [10]), 7)).toBe(
      20_000,
    );
  });

  it("charges a single-worker browser the full serial price", () => {
    expect(estimateMakespanMs(taskDurationsMs(SOLVE_MODES.deep, [10]), 1)).toBe(
      100_000,
    );
    expect(estimateMakespanMs(taskDurationsMs(SOLVE_MODES.max, [10]), 1)).toBe(
      500_000,
    );
  });

  it("keeps a fifty-attempt run to eight rounds on seven workers", () => {
    // 50 tasks over 7 workers is 7 apiece with one left over, so one worker
    // runs an eighth — 80s, not the 500s the mode's own arithmetic suggests.
    expect(estimateMakespanMs(taskDurationsMs(SOLVE_MODES.max, [10]), 7)).toBe(
      80_000,
    );
  });

  it("never reports less than the longest single task", () => {
    // An island that owns most of the board gets most of every attempt's
    // budget, and no amount of parallelism makes that one search shorter.
    const durations = taskDurationsMs(SOLVE_MODES.quick, [90, 5, 5]);
    expect(estimateMakespanMs(durations, 8)).toBe(27_000);
  });

  it("is zero when there is nothing to schedule", () => {
    expect(estimateMakespanMs([], 8)).toBe(0);
  });
});
