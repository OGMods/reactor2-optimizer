/**
 * How a run is scheduled onto the worker pool.
 *
 * The workers themselves are stubbed — what is under test is the queue, not
 * the search: which tasks are dispatched and in what order, which of several
 * attempts at the same island survives, and that pressing Stop with tasks
 * still queued ends the run instead of leaving it waiting for messages nobody
 * is going to send.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SolverCoordinator } from "./solverCoordinator";
import { BUILDINGS } from "../data";
import type {
  IslandWorkerRequest,
  PlacedBuilding,
  Tile,
} from "../solver/types";

/** Enough of a roster for `planSolve` to have something to place. */
const UPGRADES = { cooler1: 0, nuclear_reactor: 0, generator: 0 };

/**
 * A board of `islands` grass patches, each separated by water so the
 * decomposition sees them as independent. Three tiles apiece, which is the
 * smallest patch `splitGridIntoIslands` keeps for a roster of reactor,
 * generator and cooler.
 */
function board(islands: number): Tile[][] {
  const row: Tile[] = [];
  for (let i = 0; i < islands; i++) {
    if (i > 0) row.push({ x: 0, y: 0, type: "water" });
    for (let t = 0; t < 3; t++) row.push({ x: 0, y: 0, type: "grass" });
  }
  return [row.map((tile, x) => ({ ...tile, x }))];
}

/** Every SOLVE_ISLAND request the pool posted, in dispatch order. */
const dispatched: IslandWorkerRequest[] = [];

/**
 * Stands in for `islandWorker.ts`. Replies to each task on a macrotask with a
 * power the caller chooses per task id, so an "attempt" can be made to win,
 * tie or lose deterministically.
 */
function installFakeWorker(powerFor: (taskId: string) => number) {
  const listeners = new Map<object, Set<(e: MessageEvent) => void>>();

  class FakeWorker {
    #self = {};
    addEventListener(_type: string, fn: (e: MessageEvent) => void) {
      if (!listeners.has(this.#self)) listeners.set(this.#self, new Set());
      listeners.get(this.#self)!.add(fn);
    }
    removeEventListener(_type: string, fn: (e: MessageEvent) => void) {
      listeners.get(this.#self)?.delete(fn);
    }
    postMessage(req: IslandWorkerRequest) {
      if (req.type !== "SOLVE_ISLAND") return;
      dispatched.push(req);
      const placements: PlacedBuilding[] = [];
      setTimeout(() => {
        const msg = {
          data: {
            id: req.id,
            type: "ISLAND_DONE",
            placements,
            powerOutput: powerFor(req.id),
            alternates: [],
          },
        } as MessageEvent;
        for (const fn of listeners.get(this.#self) ?? []) fn(msg);
      }, 0);
    }
    terminate() {
      listeners.delete(this.#self);
    }
  }

  vi.stubGlobal("Worker", FakeWorker);
}

afterEach(() => {
  dispatched.length = 0;
  vi.unstubAllGlobals();
});

describe("SolverCoordinator", () => {
  it("dispatches one task per island for a single-attempt run", async () => {
    installFakeWorker(() => 1);
    const coordinator = new SolverCoordinator(4);

    await coordinator.solve(board(3), [...BUILDINGS], UPGRADES, 30, {
      attempts: 1,
    });
    coordinator.destroy();

    expect(dispatched.map((r) => r.id)).toEqual([
      "island_0_a0",
      "island_1_a0",
      "island_2_a0",
    ]);
  });

  it("solves every island once before solving any of them twice", async () => {
    // Attempt-major: a Stop partway through still leaves a complete board.
    installFakeWorker(() => 1);
    const coordinator = new SolverCoordinator(1);

    await coordinator.solve(board(2), [...BUILDINGS], UPGRADES, 10, {
      attempts: 3,
    });
    coordinator.destroy();

    expect(dispatched.map((r) => r.id)).toEqual([
      "island_0_a0",
      "island_1_a0",
      "island_0_a1",
      "island_1_a1",
      "island_0_a2",
      "island_1_a2",
    ]);
  });

  it("gives each attempt at an island its own random stream", async () => {
    installFakeWorker(() => 1);
    const coordinator = new SolverCoordinator(2);

    await coordinator.solve(
      board(2),
      [...BUILDINGS],
      UPGRADES,
      10,
      { attempts: 2 },
      100,
    );
    coordinator.destroy();

    const seeds = dispatched.map((r) =>
      r.type === "SOLVE_ISLAND" ? r.rngSeed : undefined,
    );
    expect(seeds).toHaveLength(4);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it("keeps the best attempt per island, not the best whole board", async () => {
    // Island 0 peaks on its second attempt and island 1 on its first, so no
    // single attempt produced the board that wins — which is exactly the point
    // of taking the maximum per island.
    const powers: Record<string, number> = {
      island_0_a0: 10,
      island_1_a0: 50,
      island_0_a1: 40,
      island_1_a1: 20,
    };
    installFakeWorker((id) => powers[id] ?? 0);
    const coordinator = new SolverCoordinator(4);

    const results = await coordinator.solve(
      board(2),
      [...BUILDINGS],
      UPGRADES,
      10,
      {
        attempts: 2,
      },
    );
    coordinator.destroy();

    expect(results[0].totalPower).toBe(90);
  });

  it("ends the run when Stop leaves tasks still queued", async () => {
    // One worker and thirty tasks: most of them never get dispatched, and the
    // run has to stop counting on messages they will never send.
    installFakeWorker(() => 1);
    const coordinator = new SolverCoordinator(1);

    let stop = false;
    const solving = coordinator.solve(board(3), [...BUILDINGS], UPGRADES, 10, {
      attempts: 10,
      reportIntervalMs: 5,
      shouldStop: () => stop,
    });
    setTimeout(() => {
      stop = true;
    }, 20);

    const results = await solving;
    coordinator.destroy();

    expect(results.length).toBeGreaterThan(0);
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.length).toBeLessThan(30);
  }, 5_000);
});
