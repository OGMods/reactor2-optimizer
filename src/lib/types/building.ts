export type BuildingType =
  "cooler" | "reactor" | "generator" | "direct_producer";

/**
 * One upgrade tier's numbers, per second. The game's own tables mix
 * `HeatPerSec` and `HeatPerTick` field names, but a tick is a second, so no
 * conversion applies.
 */

/*
 * The members of the two unions below are deliberately not exported: consumers
 * take `BuildingDefinition` / `UpgradeLevel` and narrow on `type`. The solver's
 * own copy in `lib/solver/types.ts` does export them, because that module is
 * the data contract for a tree meant to be liftable on its own.
 */

/** Cooling a cooler can absorb from its neighbours. */
interface CoolerLevel {
  cooling: number;
}

/** Heat a reactor pushes out to adjacent generators. */
interface ReactorLevel {
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
interface GeneratorLevel {
  heat: number;
  energy: number;
  waste?: number;
}

/**
 * A direct producer runs flat out on its own: no reactor, no heat intake.
 * `heat` is what it makes per second doing so -- the same three authored
 * figures a generator carries, resolved the same way.
 */
interface DirectProducerLevel {
  heat: number;
  energy: number;
  waste?: number;
}

export type UpgradeLevel =
  CoolerLevel | ReactorLevel | GeneratorLevel | DirectProducerLevel;

/** Identity and shop data, shared by every role. */
interface BuildingBase {
  id: string;
  name: string;
  price: number;
  displayIndex: number;
}

interface CoolerDefinition extends BuildingBase {
  type: "cooler";
  levels: readonly CoolerLevel[];
}

interface ReactorDefinition extends BuildingBase {
  type: "reactor";
  levels: readonly ReactorLevel[];
}

interface GeneratorDefinition extends BuildingBase {
  type: "generator";
  levels: readonly GeneratorLevel[];
}

interface DirectProducerDefinition extends BuildingBase {
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
 * A board the user created. Only its identity is stored — the terrain lives in
 * `savedGrids` under the same id, exactly like a shipped island's edits do.
 */
export interface CustomIsland {
  id: string;
  name: string;
}

export interface IslandTemplate {
  id: string;
  name: string;
  /**
   * Blueprint code (`lib/encoding/blueprint.ts`). Carries the grid, its
   * dimensions and any placements, so there is no separate width/height here.
   */
  code: string;
}
