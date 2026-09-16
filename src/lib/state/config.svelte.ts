import {
  BUILDINGS,
  getEffectiveBuildings,
  rosterCanProducePower,
} from "@reactor2/solver";
import { buildingStorage } from "../storage/storage";

/**
 * Which components the player has unlocked, and to what level.
 *
 * This is the roster the solver is allowed to build from: `buildingUpgrades`
 * maps a building id to its unlocked upgrade index, and **presence in that map
 * is what "unlocked" means** — `isBuildingEnabled` is just a key check, and
 * locking deletes the key rather than storing a flag.
 *
 * The catalog itself is not here — import `BUILDINGS` from `lib/data`. Nor is
 * the catalog's selected tab, which is view state and lives in `ui.svelte.ts`.
 */
class ConfigState {
  /** id -> unlocked upgrade index. Absent key means locked. Persisted. */
  buildingUpgrades = $state<Record<string, number>>({});

  constructor() {
    this.loadCatalog();
  }

  loadCatalog() {
    const saved = buildingStorage.loadBuildings();
    const keys = Object.keys(saved);

    if (keys.length === 0) {
      this.buildingUpgrades = {};
    } else {
      this.buildingUpgrades = saved;
    }
  }

  isBuildingEnabled(id: string): boolean {
    return id in this.buildingUpgrades;
  }

  /**
   * Whether the roster has anything in it at all.
   *
   * Presence of a key is what "unlocked" means here, so an empty map is an
   * empty roster — and a solve against one has nothing it is allowed to place.
   * `uiState.requestSolve` refuses on this rather than letting the run go and
   * come back with a blank board.
   */
  get hasUnlockedBuildings(): boolean {
    return Object.keys(this.buildingUpgrades).length > 0;
  }

  /**
   * Whether this roster could produce power on *any* board — see
   * `rosterCanProducePower` for the rule.
   *
   * A stricter question than `hasUnlockedBuildings`, and the one the Run
   * button actually needs: a roster of coolers, or of reactors with nothing to
   * convert their heat, is not empty and still cannot come back with a number.
   * Resolved through the same `getEffectiveBuildings` the solver is handed, so
   * the answer is about the roster the run would really get.
   */
  get canProducePower(): boolean {
    return rosterCanProducePower(
      getEffectiveBuildings(BUILDINGS, this.buildingUpgrades),
    );
  }

  toggleBuilding(id: string) {
    if (id in this.buildingUpgrades) {
      delete this.buildingUpgrades[id];
    } else {
      this.buildingUpgrades[id] = 0;
    }
    this.save();
  }

  setUpgradeLevel(id: string, level: number) {
    this.buildingUpgrades[id] = level;
    this.save();
  }

  unlockAll() {
    BUILDINGS.forEach((b) => {
      this.buildingUpgrades[b.id] = b.levels.length - 1;
    });
    this.save();
  }

  lockAll() {
    this.buildingUpgrades = {};
    this.save();
  }

  save() {
    buildingStorage.saveBuildings(this.buildingUpgrades);
  }
}

export const configState = new ConfigState();
