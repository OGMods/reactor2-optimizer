/**
 * How a run spends its time: one long search, or several short ones.
 *
 * The search is stochastic — only seed construction and `simulateIsland` are
 * deterministic — so a single 30s walk is one sample from a distribution, and
 * a long walk is not worth ten times a short one. Past the first few seconds
 * the annealing temperature has fallen far enough that it mostly polishes the
 * basin it is already in. Ten independent 10s walks start from ten different
 * random streams, and the best of ten samples beats one longer sample often
 * enough that it is worth offering as a choice rather than picking for the
 * user.
 *
 * It costs more wall-clock, which is why it is a choice at all. How much more
 * depends on the machine: the attempts are independent tasks and go through
 * the same worker pool the islands do, so a machine with cores to spare runs
 * several of them at once and a single-core one pays the full serial price.
 * `estimateMakespanMs` is what the UI prints so that trade is visible before
 * the button is pressed rather than after.
 */

import { getAnomaly, islandBudgetsS, type AnomalyId } from "@reactor2/solver";

export type SolveModeId = "quick" | "deep" | "max";

export interface SolveMode {
  id: SolveModeId;
  /** Short name for the control. */
  label: string;
  /** What the run actually does, e.g. "10 × 10s". */
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
    shape: "10 × 10s",
    attempts: 10,
    attemptBudgetMs: 10_000,
  },
  /**
   * The same 10s attempt as `deep`, five times over.
   *
   * Sampling has diminishing returns — the best of fifty draws beats the best
   * of ten by much less than ten beat one — so this is the mode for a board
   * being settled rather than explored, and it is priced accordingly. It earns
   * its place mostly on the shortlist: fifty walks past the same optimum find
   * far more of the arrangements that tie it than ten do, and which of those
   * is nicest to build is the one judgement the solver cannot make.
   */
  max: {
    id: "max",
    label: "Max",
    shape: "50 × 10s",
    attempts: 50,
    attemptBudgetMs: 10_000,
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
 * attempt is lengthened rather than the count raised. Doubling gives Deep and
 * Max their 20s, and Quick goes along so a mode keeps one meaning.
 */
const ATTEMPT_BUDGET_SCALE: Partial<Record<AnomalyId, number>> = {
  singularity_isolation: 2,
};

/** The factor `solveModeFor` applies under `anomalyId`; 1 under most rules. */
export function attemptBudgetScale(anomalyId: string): number {
  return ATTEMPT_BUDGET_SCALE[getAnomaly(anomalyId).id] ?? 1;
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
 * coordinator, for the same reason.
 */
export function taskDurationsMs(
  mode: SolveMode,
  islandTileCounts: readonly number[],
): number[] {
  const perAttempt = islandBudgetsS(
    islandTileCounts,
    mode.attemptBudgetMs / 1000,
  ).map((s) => s * 1000);
  const durations: number[] = [];
  for (let attempt = 0; attempt < mode.attempts; attempt++) {
    durations.push(...perAttempt);
  }
  return durations;
}
