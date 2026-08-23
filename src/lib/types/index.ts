export * from "./building";
export * from "./grid";
export * from "./ui";

/**
 * `lib/solver/types.ts` is the source of truth for everything that crosses the
 * worker boundary; app code re-reads it from here rather than redeclaring it.
 * Type-only, so this creates no runtime coupling to the solver.
 */
export type { PlacedBuilding, OptimizationResult } from "../solver/types";
