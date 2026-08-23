import {
  buildOptimizationResult,
  createEmptyResult,
  DEFAULT_TIME_BUDGET_S,
  planSolve,
  type IslandPlan,
} from "../solver/solver";
import { buildSolveVariants } from "./variants";
import { IslandBest } from "./islandBest";
import { countGrassTiles } from "../solver/island";
import type { IslandSolution } from "../solver/placementSearch";
import type {
  BuildingDefinition,
  IslandWorkerErrorResponse,
  IslandWorkerRequest,
  IslandWorkerResponse,
  OptimizationResult,
  PlacedBuilding,
  SolveOptions,
  Tile,
} from "../solver/types";

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  currentTaskId: string | null;
}

/** One island, searched once. The unit of work the pool schedules. */
interface IslandTask {
  island: number;
  attempt: number;
}

export interface CoordinatorSolveOptions extends SolveOptions {
  /**
   * How many independent searches each island gets; their best is kept. One
   * by default, which is the single-run behaviour.
   *
   * Attempts are ordinary pool tasks, so on a machine with cores to spare they
   * overlap the same way separate islands already do — the extra searches cost
   * wall-clock only once the pool is full.
   */
  attempts?: number;
}

/**
 * How many island workers to run at once.
 *
 * One below the reported core count so the main thread still has somewhere to
 * paint from, and capped because past eight the pool costs more in worker
 * startup and memory than the extra parallelism returns.
 *
 * Exported because the UI prints how long a run will take, and that figure is
 * a function of the pool width — see `estimateMakespanMs`.
 */
export function defaultPoolSize(): number {
  const hw =
    typeof navigator !== "undefined"
      ? navigator.hardwareConcurrency
      : undefined;
  return Math.min(8, Math.max(1, (hw || 4) - 1));
}

/**
 * Runs one island-search per worker, mirroring the process pool the Python
 * pipeline uses: islands cannot influence each other, so wall-clock time
 * becomes ~max(island budget) instead of the sum of them, and every island
 * still gets its full proportional share of the budget.
 *
 * A multi-attempt run rides the same queue. Nothing about a second search of
 * an island differs from a first, so `attempts × islands` tasks go into the
 * pool and the workers take them as they free up — which is what makes "ten
 * short runs" cost far less than ten times a single run on any machine with
 * cores to spare, and exactly ten times as much on one without.
 */
export class SolverCoordinator {
  private pool: WorkerSlot[] = [];
  private readonly poolSize: number;

  constructor(poolSize?: number) {
    this.poolSize = poolSize ?? defaultPoolSize();
  }

  /**
   * Solves the whole grid and returns every layout worth showing for it: the
   * one the search settled on first, then the ties it walked past, all at the
   * same power. Never empty — see `buildSolveVariants`.
   */
  async solve(
    grid: Tile[][],
    buildings: BuildingDefinition[],
    unlockedUpgrades: Record<string, number>,
    timeBudgetS = DEFAULT_TIME_BUDGET_S,
    options?: CoordinatorSolveOptions,
    rngSeed?: number,
  ): Promise<OptimizationResult[]> {
    const plan = planSolve(
      grid,
      buildings,
      unlockedUpgrades,
      timeBudgetS,
      rngSeed,
    );
    if (!plan)
      return [createEmptyResult(grid?.[0]?.length ? countGrassTiles(grid) : 0)];

    this.ensurePool();
    const solutions = await this.runQueue(
      plan,
      Math.max(1, options?.attempts ?? 1),
      options,
    );

    return buildSolveVariants(plan, solutions);
  }

  private ensurePool() {
    while (this.pool.length < this.poolSize) {
      const worker = new Worker(new URL("./islandWorker.ts", import.meta.url), {
        type: "module",
      });
      this.pool.push({ worker, busy: false, currentTaskId: null });
    }
  }

  private runQueue(
    plan: IslandPlan,
    attempts: number,
    options?: CoordinatorSolveOptions,
  ): Promise<IslandSolution[]> {
    /*
     * Attempt-major, so every island is solved once before any island is
     * solved twice. Island-major would leave the last island of a large board
     * with nothing at all if the user pressed Stop early; this way the board is
     * complete after the first pass and every task after that only improves it.
     */
    const tasks: IslandTask[] = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      for (let island = 0; island < plan.islands.length; island++) {
        tasks.push({ island, attempt });
      }
    }

    /** The answer per island: finished attempts only. */
    const finals = plan.islands.map(() => new IslandBest());

    /*
     * What the screen shows while the run is in flight — the best anything has
     * reported so far, finished or not.
     *
     * Kept apart from `finals` because the two answer different questions. A
     * progress report is a snapshot of a search still moving: good enough to
     * draw, not good enough to be filed as one of this island's tied answers.
     * It is monotonic, so a slow attempt reporting its early, worse layouts can
     * never pull the board backwards while a better one is already on it.
     */
    const display: IslandSolution[] = plan.islands.map(() => ({
      placements: [],
      powerOutput: 0,
    }));
    const shown = plan.islands.map(() => false);

    let nextTaskIdx = 0;
    let remaining = tasks.length;
    let stopSignaled = false;

    const emitProgress = () => {
      options?.onProgress?.(buildOptimizationResult(plan, display));
    };

    /** Monotonic: only a layout that beats what is drawn replaces it. */
    const show = (
      index: number,
      placements: PlacedBuilding[],
      power: number,
    ) => {
      if (shown[index] && power <= display[index].powerOutput) return;
      shown[index] = true;
      display[index] = { placements, powerOutput: power };
    };

    return new Promise((resolve) => {
      const settle = () => {
        // An island whose every attempt errored has no finished answer; the
        // last thing it streamed is better than nothing, and better than the
        // empty board it would otherwise contribute.
        resolve(
          finals.map((best, i) => (best.settled ? best.solution : display[i])),
        );
      };

      if (tasks.length === 0) {
        settle();
        return;
      }

      let stopTimer: ReturnType<typeof setInterval> | null = null;

      const finishIfDone = () => {
        if (remaining === 0) {
          if (stopTimer) clearInterval(stopTimer);
          settle();
        }
      };

      // Poll shouldStop on the same cadence as reportIntervalMs (default 1s),
      // and forward STOP to every worker currently holding a task for this job.
      const stopPollMs = options?.reportIntervalMs ?? 1000;
      stopTimer = options?.shouldStop
        ? setInterval(() => {
            if (stopSignaled || !options.shouldStop!()) return;
            stopSignaled = true;
            // Tasks still queued will never run, so they can never report —
            // drop them from the count now, or the run sits there waiting for
            // messages nobody is going to send. With one attempt per island
            // this only bit boards of more islands than workers; a deep run
            // queues far more tasks than the pool, so it would always bite.
            remaining -= tasks.length - nextTaskIdx;
            nextTaskIdx = tasks.length;
            for (const slot of this.pool) {
              if (slot.busy && slot.currentTaskId) {
                slot.worker.postMessage({
                  id: slot.currentTaskId,
                  type: "STOP",
                });
              }
            }
            finishIfDone();
          }, stopPollMs)
        : null;

      const dispatchNext = (slot: WorkerSlot) => {
        // Once stop has been signaled, don't start any new island tasks — let
        // already-running ones wind down via their own STOP handling.
        if (stopSignaled || nextTaskIdx >= tasks.length) return;

        const { island: index, attempt } = tasks[nextTaskIdx++];
        slot.busy = true;
        const taskId = `island_${index}_a${attempt}`;
        slot.currentTaskId = taskId;

        const onMessage = (
          e: MessageEvent<IslandWorkerResponse | IslandWorkerErrorResponse>,
        ) => {
          const msg = e.data;
          if (msg.id !== taskId) return;

          if (msg.type === "ISLAND_PROGRESS") {
            show(index, msg.placements, msg.powerOutput);
            emitProgress();
            return;
          }

          // ISLAND_DONE or ERROR: the task is finished either way.
          if (msg.type === "ISLAND_DONE") {
            finals[index].offer({
              placements: msg.placements,
              powerOutput: msg.powerOutput,
              alternates: msg.alternates,
            });
            show(index, msg.placements, msg.powerOutput);
          }
          slot.worker.removeEventListener("message", onMessage);
          slot.busy = false;
          slot.currentTaskId = null;
          remaining--;
          emitProgress();
          finishIfDone();
          if (!stopSignaled) dispatchNext(slot);
        };

        slot.worker.addEventListener("message", onMessage);
        const baseSeed = plan.seeds[index];
        const req: IslandWorkerRequest = {
          id: taskId,
          type: "SOLVE_ISLAND",
          island: plan.islands[index],
          effectiveBuildings: plan.effectiveBuildings,
          timeBudgetS: plan.budgetsS[index],
          reportIntervalMs: options?.reportIntervalMs,
          // Every attempt needs its own random stream — running the same walk
          // ten times over would only cost ten times as much. An unseeded run
          // gets a fresh stream per task already; a seeded one is offset so it
          // stays reproducible.
          rngSeed:
            baseSeed === undefined
              ? undefined
              : (baseSeed + attempt * plan.islands.length) >>> 0,
        };
        slot.worker.postMessage(req);
      };

      for (const slot of this.pool) dispatchNext(slot);
    });
  }

  destroy() {
    for (const slot of this.pool) slot.worker.terminate();
    this.pool = [];
  }
}
