/**
 * Pins the data contract between the solver's self-contained type module and
 * the app's canonical types.
 *
 * `lib/solver/types.ts` deliberately keeps its own copies of `Tile`,
 * `TileType`, `BuildingType` and `BuildingDefinition` rather than importing
 * `lib/types/` — that is what lets the solver be lifted out into a worker (or
 * another project) as a unit. The cost of that choice is silent drift: someone
 * adds a field to the app's `BuildingDefinition`, the solver's copy no longer
 * matches, and nothing complains until a real payload crosses the worker
 * boundary and arrives subtly wrong.
 *
 * These are compile-time assertions with no runtime cost. `npm run check`
 * type-checks this file via `tsc -p tsconfig.test.json`; if a shape drifts, the
 * assignment below stops compiling. The `it()` block exists only so Vitest has
 * something to run.
 */

import { describe, expect, it } from "vitest";

import type {
  BuildingDefinition as AppBuildingDefinition,
  BuildingType as AppBuildingType,
  OptimizationResult as AppOptimizationResult,
  PlacedBuilding as AppPlacedBuilding,
  Tile as AppTile,
  TileType as AppTileType,
} from "../types";

import type {
  BuildingDefinition as SolverBuildingDefinition,
  BuildingType as SolverBuildingType,
  OptimizationResult as SolverOptimizationResult,
  PlacedBuilding as SolverPlacedBuilding,
  Tile as SolverTile,
  TileType as SolverTileType,
} from "./types";

/** `true` only when A and B are assignable in both directions. */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _tileType: MutuallyAssignable<SolverTileType, AppTileType> = true;
const _tile: MutuallyAssignable<SolverTile, AppTile> = true;
const _buildingType: MutuallyAssignable<SolverBuildingType, AppBuildingType> =
  true;
const _buildingDef: MutuallyAssignable<
  SolverBuildingDefinition,
  AppBuildingDefinition
> = true;

// These two are re-exported by `lib/types/index.ts` rather than redeclared, so
// the assertion also catches anyone reintroducing a second declaration.
const _placed: MutuallyAssignable<SolverPlacedBuilding, AppPlacedBuilding> =
  true;
const _result: MutuallyAssignable<
  SolverOptimizationResult,
  AppOptimizationResult
> = true;

describe("solver <-> app type contract", () => {
  it("holds (enforced at compile time by npm run check)", () => {
    expect([
      _tileType,
      _tile,
      _buildingType,
      _buildingDef,
      _placed,
      _result,
    ]).toEqual([true, true, true, true, true, true]);
  });
});
