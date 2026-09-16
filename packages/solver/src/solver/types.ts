export type BuildingType =
  "cooler" | "reactor" | "generator" | "direct_producer";

export type TileType =
  "water" | "grass" | "rock" | "tree1" | "tree2" | "pond" | "transformer";

export interface Tile {
  x: number;
  y: number;
  type: TileType;
}

/**
 * One upgrade tier's numbers, per second. The game's own tables mix
 * `HeatPerSec` and `HeatPerTick` field names, but a tick is a second, so no
 * conversion applies.
 */

/** Cooling a cooler can absorb from its neighbours. */
export interface CoolerLevel {
  cooling: number;
}

/** Heat a reactor pushes out to adjacent generators. */
export interface ReactorLevel {
  heat: number;
}

/**
 * A generator converts the heat it receives into power.
 *
 * The game authors all three figures per tier (`HeatPerTick`, `EnergyPerTick`,
 * `WasteHeatPerTick`) rather than deriving them from a ratio, which is why
 * `energy / heat` is only *near* 0.75 up the tiers: the fields are rounded to
 * 3 significant figures independently of each other.
 *
 * `waste` is absent only for a source that authors none -- the extractor's
 * rounded JSON does not -- in which case it resolves to
 * `snapToAuthoredPrecision(heat - energy)`, which is how the game derives it.
 */
export interface GeneratorLevel {
  heat: number;
  energy: number;
  waste?: number;
}

/**
 * A direct producer runs flat out on its own: no reactor, no heat intake.
 * `heat` is what it makes per second doing so -- the same three authored
 * figures a generator carries, resolved the same way.
 */
export interface DirectProducerLevel {
  heat: number;
  energy: number;
  waste?: number;
}

export type UpgradeLevel =
  CoolerLevel | ReactorLevel | GeneratorLevel | DirectProducerLevel;

/** Identity and shop data, shared by every role. */
export interface BuildingBase {
  id: string;
  name: string;
  price: number;
  displayIndex: number;
}

export interface CoolerDefinition extends BuildingBase {
  type: "cooler";
  levels: readonly CoolerLevel[];
}

export interface ReactorDefinition extends BuildingBase {
  type: "reactor";
  levels: readonly ReactorLevel[];
}

export interface GeneratorDefinition extends BuildingBase {
  type: "generator";
  levels: readonly GeneratorLevel[];
}

export interface DirectProducerDefinition extends BuildingBase {
  type: "direct_producer";
  levels: readonly DirectProducerLevel[];
}

/**
 * A building as authored in the game's roster, with all upgrade tiers.
 *
 * A tagged union with one variant per role, because the four roles carry
 * different numbers and a single flat record could only express that with
 * nullable fields. It had them: `wasteRatio` was null for every building except
 * the wind turbine, and telling a reactor from a direct producer meant writing
 * `type === "heat_producer" && wasteRatio == null` at a dozen call sites.
 *
 * Note this splits the game's own `heat_producer` category into `reactor` and
 * `direct_producer`; `buildingCategory()` in `lib/data/buildings.ts` maps back
 * for the UI, which still groups them under one tab.
 */
export type BuildingDefinition =
  | CoolerDefinition
  | ReactorDefinition
  | GeneratorDefinition
  | DirectProducerDefinition;

/**
 * A building collapsed to the single upgrade tier the player has unlocked.
 *
 * The level is already chosen here, so the role's waste rule has already been
 * applied and what is left is three plain numbers the solver can use without
 * branching on anything but `type`:
 *
 * - `effectiveValue` -- cooling for a cooler, heat out for a reactor, heat
 *   intake capacity for a generator, heat produced for a direct producer.
 * - `energy` -- power at that full value; 0 for coolers and reactors.
 * - `waste` -- waste heat at that full value; 0 for coolers and reactors.
 *
 * A generator that only fills part way scales both by the same fraction (see
 * `physics.ts`); a direct producer always runs at full.
 */
export interface EffectiveBuilding {
  id: string;
  type: BuildingType;
  effectiveValue: number;
  energy: number;
  waste: number;
}

export interface IslandSubGrid {
  width: number;
  height: number;
  grid: Tile[][];
  /**
   * 1D Int32Array mapping each sub-grid tile (at index `subY * width + subX`)
   * to its flat index in the original full grid (`origY * origWidth + origX`).
   */
  originalTileIndices: Int32Array | number[];
}

/**
 * One island's layout: `placement[tileIndex]` is the building on that buildable
 * tile, or `null` if it is empty. Tile indices come from an `IslandContext` and
 * run in the game's spatial processing order.
 */
export type Placement = (EffectiveBuilding | null)[];

export interface PlacedBuilding {
  x: number;
  y: number;
  buildingId: string;
  baseValue: number;
  powerGenerated: number;
  heatProduced: number;
  heatConsumed: number;
  wasteHeatGenerated: number;
  coolingProvided: number;
  coolingReceived: number;
}

/**
 * One island's layout and what it puts out, in island-local coordinates.
 *
 * Lives here rather than beside the search because it crosses the worker
 * boundary twice over: as the island result itself, and as each of the tied
 * alternates that come back with it.
 */
export interface IslandLayout {
  placements: PlacedBuilding[];
  powerOutput: number;
}

export interface OptimizationSummary {
  totalHeatProduced: number;
  totalHeatConsumed: number;
  totalWasteGenerated: number;
  totalCoolingCapacity: number;
}

export interface OptimizationResult {
  totalPower: number;
  placements: PlacedBuilding[];
  activeTilesCount: number;
  unusedTilesCount: number;
  summary: OptimizationSummary;
  /** Upper bound for the same grid + roster, used to report layout efficiency. */
  theoreticalMaxPower: number;
}

export interface SearchHooks {
  onProgress?: (placements: PlacedBuilding[], powerOutput: number) => void;
  shouldStop?: () => boolean;
  reportIntervalMs?: number;
}

export interface SolveOptions {
  onProgress?: (result: OptimizationResult) => void;
  shouldStop?: () => boolean;
  reportIntervalMs?: number;
}

// ============================================================================
// WORKER PROTOCOL
// ============================================================================

export type IslandWorkerRequest =
  | {
      id: string; // per-island task id
      type: "SOLVE_ISLAND";
      island: IslandSubGrid;
      effectiveBuildings: EffectiveBuilding[];
      timeBudgetS: number;
      reportIntervalMs?: number;
      /** Pins the annealing walk's random stream; omitted means a fresh seed. */
      rngSeed?: number;
    }
  | { id: string; type: "STOP" };

export type IslandWorkerResponse =
  | {
      id: string;
      type: "ISLAND_PROGRESS";
      placements: PlacedBuilding[];
      powerOutput: number;
    }
  | {
      id: string;
      type: "ISLAND_DONE";
      placements: PlacedBuilding[];
      powerOutput: number;
      /**
       * Layouts this island finished tied with, if any. Only the final message
       * carries them: a progress report is a snapshot of a search still moving,
       * and its runners-up are not answers yet.
       */
      alternates: IslandLayout[];
    };

export type IslandWorkerErrorResponse = {
  id: string;
  type: "ERROR";
  error: string;
};
