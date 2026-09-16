/**
 * Worker entry. One task per message; the two kinds are the two axes the CLI
 * parallelises over.
 *
 * An `attempt` task solves its islands serially on purpose: the pool it runs
 * in already owns the cores, and a nested pool per island would oversubscribe
 * the machine several times over.
 */

import { parentPort } from "node:worker_threads";

import { BUILDINGS } from "../src/data/buildings";
import { solveIsland } from "../src/solver/placementSearch";
import { solve } from "../src/solver/solver";
import type {
  EffectiveBuilding,
  IslandSubGrid,
  Tile,
} from "../src/solver/types";

type Task =
  | {
      kind: "island";
      island: IslandSubGrid;
      effectiveBuildings: EffectiveBuilding[];
      budgetS: number;
      seed?: number;
    }
  | {
      kind: "attempt";
      grid: Tile[][];
      unlockedUpgrades: Record<string, number>;
      timeLimitS: number;
      seed?: number;
    };

parentPort?.on(
  "message",
  async ({ meta, payload }: { meta: unknown; payload: Task }) => {
    try {
      const result =
        payload.kind === "island"
          ? await solveIsland(
              payload.island,
              payload.effectiveBuildings,
              payload.budgetS,
              undefined,
              payload.seed,
            )
          : await solve(
              payload.grid,
              [...BUILDINGS],
              payload.unlockedUpgrades,
              payload.timeLimitS,
              undefined,
              payload.seed,
            );
      parentPort?.postMessage({ meta, result });
    } catch (err) {
      parentPort?.postMessage({ meta, error: (err as Error).message });
    }
  },
);
