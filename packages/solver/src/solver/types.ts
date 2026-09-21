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
  /**
   * The **authored** tier value this was resolved from — `effectiveValue`
   * before any multiplier was applied to it.
   *
   * It exists because a multiplier breaks the identity `effectiveValue` used to
   * carry. A placement records the value it was placed at and `effectiveAtValue`
   * resolves the tier back out of it by matching the catalogue, so reporting a
   * *scaled* value there matches the wrong tier and then scales it a second
   * time: a generator at authored 320 under a x2 research reports 640, matches
   * the authored 640 tier, and comes back as 1280 at one level too high.
   *
   * So `simulateIsland` reports this, never `effectiveValue`, and every scaling
   * helper must carry it through untouched.
   */
  baseValue: number;
}

// ============================================================================
// PRESTIGE (TIME LAB)
// ============================================================================

/**
 * A Time Lab research that changes what buildings are worth.
 *
 * Only the ones the solver can feel are modelled — see `PRESTIGE_UPGRADES` for
 * the seven that are not and why. Every one of these is a **uniform multiplier
 * on the roles it names**, which is the same shape the stat anomalies turned
 * out to have, so both go through `scaleEffectiveBuilding`.
 *
 * `bonuses` is the game's authored `BonusPercentage` per level, as a fraction:
 * `1` is +100%. The **bonus is the authored figure and the multiplier is
 * derived** (`1 + bonus`), which is the direction the game itself works in and
 * the direction its UI reads — it shows "+100%", never "×2". Carrying both
 * would be two spellings of one number to keep in step.
 *
 * Indexed like `BuildingDefinition.levels`: `bonuses[0]` is the first level,
 * which the UI numbers 1. An upgrade absent from the player's record is not
 * researched at all and multiplies by 1, so there is no zero entry.
 */
export interface PrestigeUpgrade {
  id: string;
  name: string;
  /** The game's own label for what it changes, e.g. "Cooling Output". */
  effect: string;
  description: string;
  /** Which roles it scales. */
  roles: readonly BuildingType[];
  bonuses: readonly number[];
}

/**
 * The resolved factor for each role, with every researched upgrade folded in.
 *
 * A plain record rather than a list of upgrades because that is all the roster
 * resolution needs, and it keeps `getEffectiveBuildings` from having to know
 * what a Time Lab is. An unresearched roster is every role at 1.
 */
export type PrestigeScales = Readonly<Record<BuildingType, number>>;

// ============================================================================
// ANOMALIES
// ============================================================================

/**
 * Which anomaly a timeline is running under. `"none"` is a real choice rather
 * than a missing value: it means the base rules of `docs/game-logic.md`, and
 * spelling it out keeps every consumer branching on one field instead of on
 * `undefined`.
 */
export type AnomalyId =
  | "none"
  | "cryo_nexus"
  | "tidal_ascendancy"
  | "singularity_isolation";

/**
 * Identity and the game's own wording, shared by every anomaly.
 *
 * The three strings are the game's own, with its `{0}` placeholders resolved
 * from the same `values` the rule fields carry — so the text and the numbers
 * the solver runs on cannot drift. `benefit` and `drawback` are the one-line
 * pair the game's own card shows; `description` is the full rule.
 */
export interface AnomalyBase {
  id: AnomalyId;
  name: string;
  /** One line on what it gives you. */
  benefit: string;
  /** One line on what it costs. */
  drawback: string;
  /** The full rule, near enough verbatim. */
  description: string;
}

/** The base rules, unmodified. */
export interface BaselineAnomaly extends AnomalyBase {
  rule: "baseline";
  id: "none";
}

/**
 * Cryo Nexus: every cooler on the island pays into one pool, taxed on the way
 * in, and the pool reaches every producer regardless of adjacency.
 *
 * This replaces the cooling distribution rather than scaling anything, which is
 * why it carries no multiplier on `EffectiveBuilding` — `contribution` is a tax
 * on what each cooler pays *into the pool*, not a re-rating of the cooler.
 */
export interface SharedCoolingAnomaly extends AnomalyBase {
  rule: "shared_cooling";
  /** Fraction of its authored cooling each cooler contributes. */
  contribution: number;
}

/**
 * Tidal Ascendancy: a building Chebyshev-adjacent to one of `terrain` is scaled.
 *
 * Decided by terrain alone, so the multiplier is a property of the *tile* and
 * is fixed for the whole solve — the first rule in the game where a
 * non-buildable tile does anything at all.
 */
export interface TerrainAffinityAnomaly extends AnomalyBase {
  rule: "terrain_affinity";
  /** Tile types that grant the bonus to a building standing beside one. */
  terrain: readonly TileType[];
  multiplier: number;
}

/**
 * Singularity Isolation: a building of `role` is scaled by `isolated` when no
 * other building of that role is Chebyshev-adjacent, and by `crowded` when one
 * or more is.
 *
 * The only rule so far whose multiplier depends on the layout rather than on
 * the board, so it cannot be folded into the roster or precomputed per tile.
 * The test is two-way on purpose: one neighbour costs exactly what five do.
 */
export interface RoleIsolationAnomaly extends AnomalyBase {
  rule: "role_isolation";
  role: BuildingType;
  isolated: number;
  crowded: number;
}

/**
 * One anomaly, as a tagged union over the *rule shape* rather than over the
 * anomaly's identity.
 *
 * `id` names which anomaly it is and `rule` says what kind of thing it does, so
 * a fourth anomaly that reuses an existing shape is a table entry and nothing
 * more, while a genuinely new rule is a new variant the solver fails to compile
 * without handling. Both halves of that were wanted: the game ships these in
 * batches, and most of a batch is a re-parameterised rule.
 *
 * Every variant but `shared_cooling` resolves to a **uniform** scale on a
 * building's three figures — see `scaleEffectiveBuilding`.
 */
export type AnomalyDefinition =
  | BaselineAnomaly
  | SharedCoolingAnomaly
  | TerrainAffinityAnomaly
  | RoleIsolationAnomaly;

/**
 * One island, as a window onto the original board.
 *
 * The window is the component's bounding box **padded by one tile** on every
 * side (clamped to the board), and `grid` carries each tile's real terrain
 * rather than a flattened "not mine" marker. Both exist for the same reason: a
 * rule can care what a building is standing next to, and a rock is not a lake.
 * The padding is what makes that answerable for a building on the island's own
 * edge, whose neighbours lie outside the component's box.
 *
 * Real terrain means a *neighbouring* island's grass can fall inside the
 * window, so which tiles are this island's is `buildable`, never `type ===
 * "grass"`.
 */
export interface IslandSubGrid {
  width: number;
  height: number;
  grid: Tile[][];
  /**
   * 1 where the tile belongs to this island, 0 otherwise — including grass that
   * belongs to a different island. Indexed `subY * width + subX`, same as
   * `originalTileIndices`.
   */
  buildable: Uint8Array;
  /** How many tiles this island has. `buildable`'s popcount, kept rather than recounted. */
  tileCount: number;
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
  /**
   * The timeline's anomaly, by id. Omitted means the base rules.
   *
   * Accepted but **not yet honoured** — the rules are modelled and threaded,
   * not implemented; see `docs/game-logic.md`. Time Lab research is a different
   * matter and already lands, because it resolves into the roster before a
   * solve ever starts.
   */
  anomalyId?: AnomalyId;
  /**
   * Time Lab research, already folded to one factor per role.
   *
   * Unlike the anomaly this **is** honoured, because it needs nothing from the
   * search: it resolves into the roster here and the `EffectiveBuilding[]` that
   * crosses the worker boundary already carries it in its three numbers. That
   * is also why the worker protocol below has no field for it — sending it
   * again would be sending it twice.
   */
  prestige?: PrestigeScales;
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
      /** The timeline's anomaly, by id; omitted means the base rules. */
      anomalyId?: AnomalyId;
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
