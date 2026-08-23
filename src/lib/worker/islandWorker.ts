import { solveIsland } from "../solver/placementSearch";
import type {
  IslandWorkerRequest,
  IslandWorkerResponse,
  IslandWorkerErrorResponse,
} from "../solver/types";

let stopRequested = false;
let activeTaskId: string | null = null;

function post(msg: IslandWorkerResponse | IslandWorkerErrorResponse) {
  (self as unknown as Worker).postMessage(msg);
}

self.addEventListener(
  "message",
  async (event: MessageEvent<IslandWorkerRequest>) => {
    const req = event.data;

    if (req.type === "STOP") {
      if (activeTaskId === req.id) stopRequested = true;
      return;
    }

    activeTaskId = req.id;
    stopRequested = false;

    try {
      const result = await solveIsland(
        req.island,
        req.effectiveBuildings,
        req.timeBudgetS,
        {
          reportIntervalMs: req.reportIntervalMs,
          shouldStop: () => stopRequested,
          onProgress: (placements, powerOutput) => {
            post({
              id: req.id,
              type: "ISLAND_PROGRESS",
              placements,
              powerOutput,
            });
          },
        },
        req.rngSeed,
      );
      post({
        id: req.id,
        type: "ISLAND_DONE",
        placements: result.placements,
        powerOutput: result.powerOutput,
        alternates: result.alternates ?? [],
      });
    } catch (err) {
      post({
        id: req.id,
        type: "ERROR",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (activeTaskId === req.id) activeTaskId = null;
    }
  },
);
