import type {
  Tile,
  AnomalyId,
  BuildingDefinition,
  OptimizationResult,
  PrestigeScales,
} from "@reactor2/solver";
import { SolverCoordinator } from "./solverCoordinator";

interface PendingEntry {
  resolve: (value: OptimizationResult[]) => void;
  reject: (reason: unknown) => void;
  onProgress?: (result: OptimizationResult) => void;
  stopped: boolean;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `req_${Date.now()}_${counter}`;
}

export interface SolverWorkerClientOptions {
  /** Number of island workers to run concurrently. Defaults to hardwareConcurrency - 1. */
  poolSize?: number;
  /** Max total search duration in ms. Defaults to SolverCoordinator's own default. */
  maxDurationMs?: number;
  /** Progress reporting cadence in ms. */
  reportIntervalMs?: number;
}

/**
 * What one run may spend, overriding the client's defaults.
 *
 * Per call rather than per client because the user picks the shape of a run
 * right before starting it (see `SOLVE_MODES`), and the client is a long-lived
 * singleton that owns the worker pool.
 */
export interface SolveRunOptions {
  /**
   * Independent searches per island; the best is kept, and ties are pooled.
   * Defaults to 1.
   */
  attempts?: number;
  /** What one attempt divides across the islands, ms. */
  attemptBudgetMs?: number;
  /**
   * The timeline's anomaly, by id. Omitted means the base rules.
   *
   * Carried the whole way to `solveIsland` and **not yet acted on** — the
   * rules are modelled and threaded, not implemented. Time Lab research needs
   * nothing here: it resolves into `unlockedUpgrades`' effective roster before
   * a run starts.
   */
  anomalyId?: AnomalyId;
  /**
   * Time Lab research as resolved scales. **Required for research to reach a
   * run at all** — the coordinator resolves the roster itself from `buildings`
   * and `unlockedUpgrades`, so without this it builds an unresearched one and
   * the search optimises a board the player does not have.
   *
   * It goes no further than `planSolve`: the roster that crosses to the workers
   * already carries it.
   */
  prestige?: PrestigeScales;
}

export interface SolveTaskHandle {
  /**
   * Resolves when solving completes, times out, or is stopped, with every
   * layout the run found at its best power — `[0]` is the one the search
   * settled on, and the rest tie it. Always holds at least that one.
   */
  promise: Promise<OptimizationResult[]>;
  /** Function to prematurely stop the solver task. */
  stop: () => void;
}

/**
 * Public API is unchanged from the single-worker version: solveProgressive(),
 * solve(), destroy(). Underneath, work is now farmed out to a pool of
 * per-island workers via SolverCoordinator instead of one worker solving
 * every island cooperatively on a single thread.
 */
export class SolverWorkerClient {
  private coordinator: SolverCoordinator | null = null;
  private pending = new Map<string, PendingEntry>();
  private destroyed = false;
  private readonly options: SolverWorkerClientOptions;

  constructor(options: SolverWorkerClientOptions = {}) {
    this.options = options;
  }

  /**
   * Starts a continuous solving task. Reports progress periodically and runs
   * until finished, stopped, or the configured max duration elapses.
   */
  solveProgressive(
    grid: Tile[][],
    buildings: BuildingDefinition[],
    unlockedUpgrades: Record<string, number>,
    onProgress?: (result: OptimizationResult) => void,
    run?: SolveRunOptions,
  ): SolveTaskHandle {
    if (this.destroyed) {
      throw new Error("SolverWorkerClient has been destroyed");
    }

    const id = nextId();
    const coordinator = this.ensureCoordinator();
    const entry: PendingEntry = {
      resolve: () => {},
      reject: () => {},
      onProgress,
      stopped: false,
    };
    this.pending.set(id, entry);

    // The budget passed down is what *one attempt* gets: the coordinator hands
    // each attempt the same proportional split across islands, so a run's total
    // is attempts × this.
    const budgetMs = run?.attemptBudgetMs ?? this.options.maxDurationMs;
    const timeBudgetS = budgetMs ? budgetMs / 1000 : undefined;

    const promise = coordinator
      .solve(grid, buildings, unlockedUpgrades, timeBudgetS, {
        attempts: run?.attempts,
        anomalyId: run?.anomalyId,
        prestige: run?.prestige,
        reportIntervalMs: this.options.reportIntervalMs,
        onProgress: (result) => {
          if (!entry.stopped) entry.onProgress?.(result);
        },
        shouldStop: () => entry.stopped,
      })
      .finally(() => {
        this.pending.delete(id);
      });

    const stop = () => {
      entry.stopped = true;
    };

    return { promise, stop };
  }

  /**
   * Standard Promise-based solve method for single runs. Returns only the
   * layout the search settled on; use `solveProgressive` for the ties too.
   *
   * @lintignore deliberate public entry point with no in-app caller
   */
  async solve(
    grid: Tile[][],
    buildings: BuildingDefinition[],
    unlockedUpgrades: Record<string, number>,
  ): Promise<OptimizationResult> {
    const handle = this.solveProgressive(grid, buildings, unlockedUpgrades);
    return (await handle.promise)[0];
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [, entry] of this.pending) {
      entry.stopped = true;
    }
    this.pending.clear();
    if (this.coordinator) {
      this.coordinator.destroy();
      this.coordinator = null;
    }
  }

  private ensureCoordinator(): SolverCoordinator {
    if (this.destroyed) {
      throw new Error("SolverWorkerClient has been destroyed");
    }
    if (!this.coordinator) {
      if (typeof Worker === "undefined") {
        throw new Error(
          "SolverWorkerClient needs a browser environment to create workers.",
        );
      }
      this.coordinator = new SolverCoordinator(this.options.poolSize);
    }
    return this.coordinator;
  }
}
