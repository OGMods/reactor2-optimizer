/**
 * The app's own records about buildings and boards.
 *
 * The *catalogue* types — `BuildingDefinition` and its four role variants,
 * `UpgradeLevel`, `BuildingType` — are the game's, so they live in
 * `@reactor2/solver` beside the table that instantiates them, and are
 * re-exported here so `lib/types` stays the one place app code imports a type
 * from. `IslandTemplate` went with them, because a template *is* a blueprint
 * code and the headless CLI reads the shipped ones.
 *
 * What is left is the one record the solver has never heard of: a board the
 * player made.
 */

export type {
  BuildingDefinition,
  BuildingType,
  IslandTemplate,
} from "@reactor2/solver";

/**
 * A board the user created. Only its identity is stored — the terrain lives in
 * `savedGrids` under the same id, exactly like a shipped island's edits do.
 */
export interface CustomIsland {
  id: string;
  name: string;
}
