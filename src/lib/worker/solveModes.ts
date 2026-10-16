/**
 * How a run spends its time: one long search, or several short ones.
 *
 * The search is stochastic — only seed construction and `simulateIsland` are
 * deterministic — so a single 30s walk is one sample from a distribution, and
 * a long walk is not worth ten times a short one. Past the first few seconds
 * the annealing temperature has fallen far enough that it mostly polishes the
 * basin it is already in. Independent walks start from different random
 * streams, and the best of several samples beats one longer sample often
 * enough that it is worth offering as a choice rather than picking for the
 * user.
 *
 * Not too short, though. A walk on a large island is still climbing well past
 * 10s on a late roster, and `npm run survey` over all eight maps puts the
 * average share of the bound at 91.7% for a 10s walk, 92.9% at 20s and 93.6%
 * at 40s (full unlocks less cooler8 and ecto_compressor, no anomaly), and
 * 95.3% against 96.1% at full unlocks. One 20s walk matches or beats the best
 * of three 10s ones on both rosters, at two-thirds of the time — so at a fixed
 * cost, five 20s walks beat ten 10s ones. The gain is on the large maps
 * (147-180 tiles, 1-3 points); maps 1-3 sit where they will stay at 10s.
 *
 * It costs more wall-clock, which is why it is a choice at all. How much more
 * depends on the machine: the attempts are independent tasks and go through
 * the same worker pool the islands do, so a machine with cores to spare runs
 * several of them at once and a single-core one pays the full serial price.
 * `estimateMakespanMs` is what the UI prints so that trade is visible before
 * the button is pressed rather than after.
 */

import {
  fitBudgetsToPool,
  getAnomaly,
  islandBudgetsS,
  type AnomalyId,
} from "@reactor2/solver";

export type SolveModeId = "quick" | "deep" | "max";

export interface SolveMode {
  id: SolveModeId;
  /** Short name for the control. */
  label: string;
  /** What the run actually does, e.g. "5 × 20s". */
  shape: string;
  /**
   * How many independent searches **each island** gets. Their best is kept,
   * per island rather than per board: islands never interact, so taking the
   * best attempt for each one composes into a board at least as good as the
   * best whole-board attempt, never worse.
   */
  attempts: number;
  /**
   * What one attempt has to spend, in ms. Each attempt divides this across the
   * islands in proportion to their buildable-tile count, exactly as a single
   * run divides its budget today.
   */
  attemptBudgetMs: number;
}

export const SOLVE_MODES: Record<SolveModeId, SolveMode> = {
  quick: {
    id: "quick",
    label: "Quick",
    shape: "1 × 30s",
    attempts: 1,
    attemptBudgetMs: 30_000,
  },
  deep: {
    id: "deep",
    label: "Deep",
    shape: "5 × 20s",
    attempts: 5,
    attemptBudgetMs: 20_000,
  },
  /**
   * The same 20s attempt as `deep`, five times over.
   *
   * Sampling has diminishing returns — the best of twenty-five draws beats the
   * best of five by much less than five beat one — so this is the mode for a
   * board being settled rather than explored, and it is priced accordingly. It
   * earns its place mostly on the shortlist: more walks past the same optimum
   * find more of the arrangements that tie it, and which of those is nicest to
   * build is the one judgement the solver cannot make. It was fifty 10s walks
   * at the same cost, which found more ties and less power.
   */
  max: {
    id: "max",
    label: "Max",
    shape: "25 × 20s",
    attempts: 25,
    attemptBudgetMs: 20_000,
  },
};

export const DEFAULT_SOLVE_MODE: SolveModeId = "quick";

/**
 * How much longer each attempt runs under an anomaly whose search needs it.
 *
 * Singularity Isolation is the one: a generator's rating depends on its
 * neighbours, so the walk has to discover a different shape of layout, and a
 * short attempt comes back with one that would score the same under the base
 * rules.
 *
 * Measured with `npm run survey` over all eight maps, three runs each, on four
 * rosters from full unlocks down to generator7 at tier 1 (where the bonus is
 * worth +60%). A 10s walk falls short on every one of them — at generator7 tier
 * 3 it averages +30.6% over the base rules against +37.7% at 20s, and at full
 * unlocks it comes back 1.2% *below* them. 20s recovers nearly all of it; 30s
 * and 60s add a few tenths more. Best of ten 10s walks beats one 10s walk, but
 * best of ten 20s walks beats it again by 1-2 points on every roster, so the
 * attempt is lengthened rather than the count raised. Those figures were taken
 * against 10s attempts; doubling now gives Deep and Max 40s, and Quick goes
 * along so a mode keeps one meaning.
 *
 * Both Tidals were measured too and gain no more from a longer walk than the
 * base rules do (legacy ×1.67: 90.2% / 91.5% / 91.9% of the bound at 10 / 20 /
 * 40s), so the longer default covers them and they take no factor here.
 */
const ATTEMPT_BUDGET_SCALE: Partial<
  Record<AnomalyId, { scale: number; reason: string }>
> = {
  singularity_isolation: {
    scale: 2,
    reason:
      "A generator's output depends on its neighbours there, so a walk needs " +
      "the extra time to find layouts that keep them apart.",
  },
};

/** The factor `solveModeFor` applies under `anomalyId`; 1 under most rules. */
export function attemptBudgetScale(anomalyId: string): number {
  return ATTEMPT_BUDGET_SCALE[getAnomaly(anomalyId).id]?.scale ?? 1;
}

/** Why `attemptBudgetScale` is above 1 under `anomalyId`, for the mode dialog. */
export function attemptBudgetReason(anomalyId: string): string {
  return ATTEMPT_BUDGET_SCALE[getAnomaly(anomalyId).id]?.reason ?? "";
}

/**
 * `mode` as it runs under `anomalyId`: the same attempts, each scaled by
 * `ATTEMPT_BUDGET_SCALE`, and a `shape` that says so. Every reader of a mode —
 * the control, the estimate, the run itself — goes through this, so the figure
 * on the button cannot describe a run the coordinator does not make.
 */
export function solveModeFor(mode: SolveMode, anomalyId: string): SolveMode {
  const scale = attemptBudgetScale(anomalyId);
  if (scale === 1) return mode;
  const attemptBudgetMs = mode.attemptBudgetMs * scale;
  return {
    ...mode,
    attemptBudgetMs,
    shape: `${mode.attempts} × ${Math.round(attemptBudgetMs / 1000)}s`,
  };
}

/** Every mode, in the order the control offers them. */
export const SOLVE_MODE_LIST: SolveMode[] = [
  SOLVE_MODES.quick,
  SOLVE_MODES.deep,
  SOLVE_MODES.max,
];

/**
 * How long a set of island tasks takes on a pool of `poolSize` workers.
 *
 * This is not a guess at the shape of the schedule — it *is* the schedule:
 * `SolverCoordinator` hands each task to whichever worker frees up first, in
 * the order given, which is greedy list scheduling. Replaying that over the
 * task durations gives the same makespan the run will have, up to the workers
 * finishing a shade past their own deadlines.
 *
 * Durations must be passed in dispatch order, because that is what decides
 * which worker gets which task.
 */
export function estimateMakespanMs(
  taskDurationsMs: readonly number[],
  poolSize: number,
): number {
  if (taskDurationsMs.length === 0) return 0;
  const busyUntil = new Array<number>(Math.max(1, poolSize)).fill(0);
  for (const duration of taskDurationsMs) {
    let earliest = 0;
    for (let w = 1; w < busyUntil.length; w++) {
      if (busyUntil[w] < busyUntil[earliest]) earliest = w;
    }
    busyUntil[earliest] += duration;
  }
  return Math.max(...busyUntil);
}

/**
 * The task list a mode produces for islands of the given buildable-tile
 * counts, in dispatch order — attempt-major, so every island has been solved
 * once before any of them is solved twice.
 *
 * Shared by the estimate and by the coordinator's own ordering, so the figure
 * on the button cannot describe a schedule the run does not use. The split
 * within an attempt is `islandBudgetsS`, the one `planSolve` hands the
 * coordinator, stretched by `fitBudgetsToPool` as the coordinator stretches
 * it, for the same reason.
 */
export function taskDurationsMs(
  mode: SolveMode,
  islandTileCounts: readonly number[],
  poolSize: number,
): number[] {
  const attemptS = mode.attemptBudgetMs / 1000;
  const perAttempt = fitBudgetsToPool(
    islandBudgetsS(islandTileCounts, attemptS),
    attemptS,
    mode.attempts,
    poolSize,
  ).map((s) => s * 1000);
  const durations: number[] = [];
  for (let attempt = 0; attempt < mode.attempts; attempt++) {
    durations.push(...perAttempt);
  }
  return durations;
}
