import {
  BUILDINGS,
  DEFAULT_ANOMALY_ID,
  getAnomaly,
  getEffectiveBuildings,
  MAX_UPGRADE_STEPS,
  prestigeScales,
  resolveUpgradePlan,
  rosterCanProducePower,
  type AnomalyDefinition,
  type PrestigeScales,
  type ResolvedUpgradePlan,
  type UpgradeStep,
} from "@reactor2/solver";
import {
  anomalyStorage,
  buildingStorage,
  prestigeStorage,
  upgradePlanStorage,
} from "../storage/storage";
import { trackEvent } from "../utils/analytics";

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

  /**
   * The upgrade plan: up to `MAX_UPGRADE_STEPS` tiers the player means to buy,
   * **in buying order**. Persisted.
   *
   * The order is the whole point rather than a detail. A layout that survives
   * "cooler, then reactor" can overheat if the reactor comes first, and a plan
   * that had to survive every order was measured at 31-59% of the power a
   * fixed order keeps — so the player states the order they will buy in, and
   * the solve holds for that one.
   *
   * Stored as the player wrote it, not as it resolves: a step the roster has
   * since caught up with (the upgrade was bought) stays in the list and simply
   * stops counting, so the plan is carried out rather than edited away.
   */
  upgradePlan = $state<UpgradeStep[]>([]);

  /**
   * The plan against the current roster: the rosters a run is held to, and
   * which steps still upgrade anything. `$derived` so the Setup list, the run
   * and the readout all read one resolution.
   */
  resolvedPlan: ResolvedUpgradePlan = $derived(
    resolveUpgradePlan(BUILDINGS, this.buildingUpgrades, this.upgradePlan),
  );

  constructor() {
    this.loadCatalog();
    this.anomalyId = anomalyStorage.loadAnomaly();
    this.prestigeLevels = prestigeStorage.loadPrestige();
    this.upgradePlan = upgradePlanStorage.loadPlan();
  }

  /** Whether any step of the plan still upgrades something. */
  get hasPlan(): boolean {
    return this.resolvedPlan.along.length > 0;
  }

  /**
   * The plan's effective steps as one string — empty with no plan — so a
   * result can record which plan it was searched under and be compared with
   * the current one. Only steps that still count go in, so buying a planned
   * upgrade changes the key exactly as it changes what a run would do.
   */
  get planKey(): string {
    return this.upgradePlan
      .filter((_, i) => this.resolvedPlan.effective[i])
      .map((s) => `${s.buildingId}:${s.level}`)
      .join(">");
  }

  /**
   * Where `id` stands once the whole plan is bought, if the plan takes it
   * higher than the roster does — what a building's card marks as planned.
   * Null when the plan leaves it alone.
   */
  plannedLevel(id: string): number | null {
    const planned = this.resolvedPlan.target[id];
    const held = this.buildingUpgrades[id];
    return planned !== undefined && planned !== held ? planned : null;
  }

  /**
   * Whether `id` can take another step: unlocked, and below its top tier even
   * after what the plan already buys. Maxed buildings are not offered, since a
   * step for one would upgrade nothing.
   */
  canPlan(id: string): boolean {
    const def = BUILDINGS.find((b) => b.id === id);
    const at = this.resolvedPlan.target[id];
    return def !== undefined && at !== undefined && at < def.levels.length - 1;
  }

  /**
   * Appends a step for `id`, one tier above where the plan leaves it — the
   * smallest purchase, which the step's tier row can raise. Does nothing at
   * the limit or for a building with no tier left to buy.
   */
  addPlanStep(id: string) {
    if (this.upgradePlan.length >= MAX_UPGRADE_STEPS) return;
    if (!this.canPlan(id)) return;
    this.upgradePlan.push({
      buildingId: id,
      level: this.resolvedPlan.target[id] + 1,
    });
    this.#savePlan();
  }

  /**
   * Moves a step one place earlier (`-1`) or later (`+1`). The order is the
   * buying order, and it decides what the layout has to survive, so it is
   * editable rather than fixed by the order steps happened to be added in.
   */
  movePlanStep(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (index < 0 || to < 0 || to >= this.upgradePlan.length) return;
    const [step] = this.upgradePlan.splice(index, 1);
    this.upgradePlan.splice(to, 0, step);
    this.#savePlan();
  }

  setPlanStep(index: number, step: UpgradeStep) {
    if (index < 0 || index >= this.upgradePlan.length) return;
    this.upgradePlan[index] = { ...step };
    this.#savePlan();
  }

  removePlanStep(index: number) {
    if (index < 0 || index >= this.upgradePlan.length) return;
    this.upgradePlan.splice(index, 1);
    this.#savePlan();
  }

  #savePlan() {
    upgradePlanStorage.savePlan($state.snapshot(this.upgradePlan));
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
    // Pressing the card already chosen is not a choice, and would count one
    // timeline twice.
    if (id === this.anomalyId) return;
    trackEvent("anomaly_select", { anomaly: id, from: this.anomalyId });
    this.anomalyId = id;
    anomalyStorage.saveAnomaly(id);
  }

  /**
   * The rules a run is launched under, as analytics params: the anomaly, and
   * the research as `id:level` pairs numbered from 1 the way the tier buttons
   * are. One string rather than a param per upgrade, so one custom dimension
   * covers it and a research added later needs no new registration.
   */
  rulesParams(): { anomaly: string; research: string } {
    const research = Object.entries(this.prestigeLevels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, level]) => `${id}:${level + 1}`)
      .join(",");
    return { anomaly: this.activeAnomaly.id, research: research || "none" };
  }

  isResearchEnabled(id: string): boolean {
    return id in this.prestigeLevels;
  }

  /** Toggling off deletes the key, exactly as locking a building does. */
  toggleResearch(id: string) {
    if (id in this.prestigeLevels) delete this.prestigeLevels[id];
    else this.prestigeLevels[id] = 0;
    // 1-based like the tier buttons, 0 for switched off.
    trackEvent("research_set", {
      research: id,
      level: id in this.prestigeLevels ? this.prestigeLevels[id] + 1 : 0,
    });
    prestigeStorage.savePrestige(this.prestigeLevels);
  }

  setResearchLevel(id: string, level: number) {
    if (this.prestigeLevels[id] === level) return;
    this.prestigeLevels[id] = level;
    trackEvent("research_set", { research: id, level: level + 1 });
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
