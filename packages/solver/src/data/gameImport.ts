import type { BlueprintPlacement } from "../encoding/blueprint";
import { decodeBlueprint } from "../encoding/blueprint";
import type { GameExport, GameExportIsland } from "../encoding/gameExport";
import type { Tile, TileType } from "../solver/types";
import { ANOMALIES, DEFAULT_ANOMALY_ID } from "./anomalies";
import { findBuilding } from "./buildings";
import { ISLAND_TEMPLATES } from "./maps";
import { PRESTIGE_UPGRADES } from "./prestige";
import { MAX_UPGRADE_STEPS, type UpgradeStep } from "./upgradePlan";

/**
 * Turns a code from the game's Export to Optimizer button
 * (`encoding/gameExport.ts`) into the optimizer's own terms: a roster, Time Lab
 * levels, an anomaly, an upgrade plan and one board per shipped island.
 *
 * Everything the game names, it names by its own ids, so this is mostly a
 * translation table, and its one rule is **what we cannot place, we report
 * rather than guess**. An id with no counterpart here — a building the roster
 * does not carry yet, research that does not change a layout — is dropped and
 * counted; it is never mapped onto the nearest thing we do have.
 */

/** The game's terrain ids, as its palette spells them. */
const GAME_TERRAIN: Readonly<Record<string, TileType>> = {
  TileWater: "water",
  TileGrass: "grass",
  Map_Rock: "rock",
  // The game's two forests are our two tree sprites, and not in name order:
  // its deciduous forest is `tree1`, its coniferous one `tree2`. Read off the
  // shipped maps against the first exports the game produced.
  Map_Forest_Deciduous: "tree1",
  Map_Forest_Coniferous: "tree2",
  Map_Pond: "pond",
  CantBuildHere: "transformer",
};

const OBSTACLES: ReadonlySet<TileType> = new Set<TileType>([
  "rock",
  "tree1",
  "tree2",
  "pond",
]);

/**
 * The building a research node unlocks and upgrades, or undefined for
 * research that is not a building's. The game's ids are
 * `research_building_<id>` with one exception it shipped with —
 * `research_gas_plant` — so both spellings are tried.
 */
function buildingForResearch(researchId: string): string | undefined {
  for (const prefix of ["research_building_", "research_"]) {
    if (!researchId.startsWith(prefix)) continue;
    const def = findBuilding(researchId.slice(prefix.length));
    if (def) return def.id;
  }
  return undefined;
}

/**
 * A purchased level as our 0-based tier index, or undefined for level 0
 * (not bought, which for a building means locked). Clamped to the tiers we
 * carry, so a game that has authored a tier past ours rates it at our top one
 * rather than failing.
 */
function levelToIndex(level: number, tiers: number): number | undefined {
  if (level <= 0) return undefined;
  return Math.min(level, tiers) - 1;
}

/** One research the game had running at the moment of export. */
export interface ImportedProgress {
  /** `building`: a building's unlock or tier. `research`: a Time Lab level. */
  kind: "building" | "research";
  /** Our building id or Time Lab id. */
  id: string;
  /** The tier index (or Time Lab level index) it will reach. */
  level: number;
  secondsLeft: number;
}

/** One shipped island as the player has it in the game. */
export interface ImportedIsland {
  templateId: string;
  name: string;
  /** The template's terrain with the player's cleared obstacles cleared. */
  grid: Tile[][];
  placements: BlueprintPlacement[];
  /** Obstacles the player has cleared. */
  cleared: number;
  /**
   * Cells where the game's map and ours disagree on something other than a
   * cleared obstacle. Our template wins on terrain — a shipped board is fixed
   * apart from clearing.
   */
  mismatched: number;
  /** Buildings dropped because our map has no buildable tile under them. */
  blockedBuildings: number;
  /** Buildings on the island the roster does not carry, which were dropped. */
  unknownBuildings: number;
}

export interface ResolvedGameImport {
  gameVersion: string;
  /** Our `buildingUpgrades`: building id -> tier index; absent = locked. */
  buildingUpgrades: Record<string, number>;
  /** Our Time Lab levels: research id -> level index; absent = not bought. */
  prestigeLevels: Record<string, number>;
  /** An anomaly id this build knows — `none` when the game's is unknown. */
  anomalyId: string;
  /** The game's anomaly id when it is one this build does not know. */
  unknownAnomaly: string | null;
  /** Research running at export, soonest first — building and Time Lab only. */
  inProgress: ImportedProgress[];
  /** Unlocked islands, as boards. */
  islands: ImportedIsland[];
  /**
   * Templates whose island is still locked in the game. The player has nothing
   * there, so an import resets them to their untouched map.
   */
  lockedTemplateIds: string[];
}

/**
 * Builds one board: the shipped template, with the game's cleared obstacles
 * cleared and its buildings placed.
 */
async function resolveIsland(
  templateCode: string,
  link: { originX: number; originY: number },
  island: GameExportIsland,
): Promise<Omit<ImportedIsland, "templateId" | "name">> {
  const { grid } = await decodeBlueprint(templateCode);
  const placements: BlueprintPlacement[] = [];
  let cleared = 0;
  let mismatched = 0;
  let blockedBuildings = 0;
  let unknownBuildings = 0;

  const cellAt = (gx: number, gy: number): string => {
    const i = gx - island.minX;
    const j = gy - island.minY;
    if (i < 0 || j < 0 || i >= island.width || j >= island.height) {
      return "TileWater";
    }
    return island.cells[j * island.width + i];
  };

  for (const row of grid) {
    for (const tile of row) {
      const ours = tile.type;
      const theirs = cellAt(link.originX - tile.y, link.originY - tile.x);
      const terrain = GAME_TERRAIN[theirs];

      if (terrain === undefined) {
        // A building. It stands on grass in the game, so here it needs grass
        // too — or an obstacle the player cleared to make room for it.
        if (ours !== "grass" && !OBSTACLES.has(ours)) {
          mismatched++;
          blockedBuildings++;
          continue;
        }
        if (OBSTACLES.has(ours)) {
          tile.type = "grass";
          cleared++;
        }
        if (findBuilding(theirs)) {
          placements.push({ x: tile.x, y: tile.y, buildingId: theirs });
        } else {
          unknownBuildings++;
        }
      } else if (terrain === "grass" && OBSTACLES.has(ours)) {
        tile.type = "grass";
        cleared++;
      } else if (
        OBSTACLES.has(terrain) ? !OBSTACLES.has(ours) : terrain !== ours
      ) {
        // Which forest stands on a tile is not ours to change, so two kinds
        // of obstacle are not a disagreement — only obstacle against open
        // ground, or land against water, is.
        mismatched++;
      }
    }
  }

  return {
    grid,
    placements,
    cleared,
    mismatched,
    blockedBuildings,
    unknownBuildings,
  };
}

/** Resolves a decoded game export. See the module header for the rules. */
export async function resolveGameExport(
  exp: GameExport,
): Promise<ResolvedGameImport> {
  const buildingUpgrades: Record<string, number> = {};
  const prestigeLevels: Record<string, number> = {};

  for (const [researchId, level] of Object.entries(exp.research)) {
    const buildingId = buildingForResearch(researchId);
    if (buildingId) {
      const def = findBuilding(buildingId)!;
      const index = levelToIndex(level, def.levels.length);
      if (index !== undefined) buildingUpgrades[buildingId] = index;
      continue;
    }
    const upgrade = PRESTIGE_UPGRADES.find((u) => u.id === researchId);
    if (upgrade) {
      const index = levelToIndex(level, upgrade.bonuses.length);
      if (index !== undefined) prestigeLevels[upgrade.id] = index;
    }
  }

  const inProgress: ImportedProgress[] = [];
  for (const p of exp.researchInProgress) {
    const buildingId = buildingForResearch(p.id);
    if (buildingId) {
      const index = levelToIndex(
        p.level,
        findBuilding(buildingId)!.levels.length,
      );
      if (index !== undefined) {
        inProgress.push({
          kind: "building",
          id: buildingId,
          level: index,
          secondsLeft: p.secondsLeft,
        });
      }
      continue;
    }
    const upgrade = PRESTIGE_UPGRADES.find((u) => u.id === p.id);
    if (upgrade) {
      const index = levelToIndex(p.level, upgrade.bonuses.length);
      if (index !== undefined) {
        inProgress.push({
          kind: "research",
          id: upgrade.id,
          level: index,
          secondsLeft: p.secondsLeft,
        });
      }
    }
  }
  inProgress.sort((a, b) => a.secondsLeft - b.secondsLeft);

  const known = ANOMALIES.some((a) => a.id === exp.anomalyId);

  const islands: ImportedIsland[] = [];
  const lockedTemplateIds: string[] = [];
  for (const template of ISLAND_TEMPLATES) {
    if (!template.game) continue;
    const area = exp.islands.find((i) => i.areaId === template.game!.areaId);
    if (!area) continue;
    if (!area.unlocked) {
      lockedTemplateIds.push(template.id);
      continue;
    }
    islands.push({
      templateId: template.id,
      name: template.name,
      ...(await resolveIsland(template.code, template.game, area)),
    });
  }

  return {
    gameVersion: exp.gameVersion,
    buildingUpgrades,
    prestigeLevels,
    anomalyId: known ? exp.anomalyId : DEFAULT_ANOMALY_ID,
    unknownAnomaly: known ? null : exp.anomalyId,
    inProgress,
    islands,
    lockedTemplateIds,
  };
}

/**
 * What to do with research still running in the game.
 *
 * - `finished`: count it as done — the roster and Time Lab take its level.
 * - `plan`: make the building upgrades among it the upgrade plan, in the order
 *   they finish, so a solve keeps working through each of them.
 * - `ignore`: import today's levels only.
 */
export type InProgressMode = "finished" | "plan" | "ignore";

export interface GameImportState {
  buildingUpgrades: Record<string, number>;
  prestigeLevels: Record<string, number>;
  /** The new upgrade plan, or null to leave the player's own alone. */
  upgradePlan: UpgradeStep[] | null;
}

/**
 * Applies the chosen handling of research in progress.
 *
 * A plan can only hold tiers of a building that is already unlocked —
 * `resolveUpgradePlan` would ignore a step for a locked one — so under `plan`
 * an unlock still in progress is left out rather than added as a step that
 * never counts, and so is Time Lab research, which a plan does not hold. The
 * import dialog says so beside the choice.
 */
export function applyInProgress(
  resolved: ResolvedGameImport,
  mode: InProgressMode,
): GameImportState {
  const buildingUpgrades = { ...resolved.buildingUpgrades };
  const prestigeLevels = { ...resolved.prestigeLevels };

  if (mode === "finished") {
    for (const p of resolved.inProgress) {
      const into = p.kind === "building" ? buildingUpgrades : prestigeLevels;
      into[p.id] = Math.max(into[p.id] ?? -1, p.level);
    }
    return { buildingUpgrades, prestigeLevels, upgradePlan: null };
  }

  if (mode === "plan") {
    const upgradePlan = plannableProgress(resolved)
      .slice(0, MAX_UPGRADE_STEPS)
      .map((p) => ({ buildingId: p.id, level: p.level }));
    return { buildingUpgrades, prestigeLevels, upgradePlan };
  }

  return { buildingUpgrades, prestigeLevels, upgradePlan: null };
}

/** The research in progress a plan can hold: tier upgrades of unlocked buildings. */
export function plannableProgress(
  resolved: ResolvedGameImport,
): ImportedProgress[] {
  return resolved.inProgress.filter(
    (p) =>
      p.kind === "building" &&
      resolved.buildingUpgrades[p.id] !== undefined &&
      p.level > resolved.buildingUpgrades[p.id],
  );
}
