import {
  BUILDINGS,
  DEFAULT_ANOMALY_ID,
  getAnomaly,
  getEffectiveBuildings,
  prestigeScales,
  rosterCanProducePower,
  type AnomalyDefinition,
  type PrestigeScales,
} from "@reactor2/solver";
import {
  anomalyStorage,
  buildingStorage,
  prestigeStorage,
} from "../storage/storage";

/**
 * Which components the player has unlocked and to what level, and which anomaly
 * the timeline is running under.
 *
 * This is the roster the solver is allowed to build from: `buildingUpgrades`
 * maps a building id to its unlocked upgrade index, and **presence in that map
 * is what "unlocked" means** — `isBuildingEnabled` is just a key check, and
 * locking deletes the key rather than storing a flag.
 *
 * The **anomaly** shares this class rather than getting one of its own because
 * it is the same kind of thing: an input to the solve that the player sets once
 * and then tries against one island after another. It is not view state and not
 * a preference about the app — it changes what the rules are, so
 * `solverState.solveSignature()` counts it and a stored solve found under a
 * different anomaly is stale.
 *
 * Neither catalog is here — import `BUILDINGS` and `ANOMALIES` from
 * `@reactor2/solver`. Nor is the catalog's selected tab, which is view state and
 * lives in `ui.svelte.ts`.
 */
class ConfigState {
  /** id -> unlocked upgrade index. Absent key means locked. Persisted. */
  buildingUpgrades = $state<Record<string, number>>({});

  /**
   * Which anomaly is active, as a bare id. Persisted.
   *
   * Stored as the id rather than the definition so a save written by a build
   * that knows more anomalies than this one still reads back — `activeAnomaly`
   * resolves it, and an id with no entry falls through to the baseline rather
   * than leaving the app with no rules at all.
   */
  anomalyId = $state<string>(DEFAULT_ANOMALY_ID);

  /**
   * Time Lab research: upgrade id -> researched level index. Absent key means
   * not researched. Persisted.
   *
   * Deliberately the same convention as `buildingUpgrades` above — presence is
   * the unlock, the value is a 0-based index the UI numbers from 1 — because
   * the two are picked with the same control and a second convention would only
   * be a way to rate a board at the wrong level without failing.
   */
  prestigeLevels = $state<Record<string, number>>({});

  /**
   * The research folded to one multiplier per role — what every roster
   * resolution is handed.
   *
   * `$derived` rather than a getter so it is one object per set of levels: the
   * roster hand-off and `App.svelte`'s re-score effect both compare it, and a
   * getter would mint a fresh record on every read and never look equal to
   * itself.
   */
  prestige: PrestigeScales = $derived(prestigeScales(this.prestigeLevels));

  constructor() {
    this.loadCatalog();
    this.anomalyId = anomalyStorage.loadAnomaly();
    this.prestigeLevels = prestigeStorage.loadPrestige();
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
      getEffectiveBuildings(BUILDINGS, this.buildingUpgrades, this.prestige),
    );
  }

  /** The rules this timeline runs under; never null — see `getAnomaly`. */
  get activeAnomaly(): AnomalyDefinition {
    return getAnomaly(this.anomalyId);
  }

  /**
   * Whether a rule change is in force at all.
   *
   * Asked through `activeAnomaly.rule` rather than `anomalyId !== "none"`, so
   * a caller never has to know which id spells "nothing is modified" — and an
   * id this build does not recognise answers `false`, which is the same
   * fallback `getAnomaly` makes and the only safe one: this drives a signal
   * saying the rules are not the ordinary ones.
   */
  get hasAnomaly(): boolean {
    return this.activeAnomaly.rule !== "baseline";
  }

  setAnomaly(id: string) {
    this.anomalyId = id;
    anomalyStorage.saveAnomaly(id);
  }

  isResearchEnabled(id: string): boolean {
    return id in this.prestigeLevels;
  }

  /** Toggling off deletes the key, exactly as locking a building does. */
  toggleResearch(id: string) {
    if (id in this.prestigeLevels) delete this.prestigeLevels[id];
    else this.prestigeLevels[id] = 0;
    prestigeStorage.savePrestige(this.prestigeLevels);
  }

  setResearchLevel(id: string, level: number) {
    this.prestigeLevels[id] = level;
    prestigeStorage.savePrestige(this.prestigeLevels);
  }

  /** The level index, or 0 for an upgrade that is not researched at all. */
  researchLevel(id: string): number {
    return this.prestigeLevels[id] ?? 0;
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
