export * from "./building";
export * from "./grid";
export * from "./ui";

/**
 * `@reactor2/solver` is the source of truth for everything that crosses the
 * worker boundary; app code re-reads it from here rather than redeclaring it.
 * Type-only, so this creates no runtime coupling to the solver.
 */
export type { PlacedBuilding, OptimizationResult } from "@reactor2/solver";
