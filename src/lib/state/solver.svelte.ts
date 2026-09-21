import type { OptimizationResult, PlacedBuilding } from "../types";
import {
  SolverWorkerClient,
  type SolveTaskHandle,
} from "../worker/workerClient";
import { MAX_SOLVE_VARIANTS } from "../worker/variants";
import { defaultPoolSize } from "../worker/solverCoordinator";
import {
  DEFAULT_SOLVE_MODE,
  SOLVE_MODES,
  estimateMakespanMs,
  taskDurationsMs,
  type SolveMode,
  type SolveModeId,
} from "../worker/solveModes";
import { BUILDINGS } from "@reactor2/solver";
import { getEffectiveBuildings } from "@reactor2/solver";
import { isDistinctLayout, powerTies } from "@reactor2/solver";
import {
  canCoolDirectProducer,
  countGrassTiles,
  estimateTotalMaxPower,
  splitGridIntoIslands,
} from "@reactor2/solver";
import { rebaseToUnlocks, unscoredPlacement } from "../data/placements";
import { simulatePlacedBuildings } from "../simulation/simulator";
import { blueprintKey } from "@reactor2/solver";
import { trackEvent } from "../utils/analytics";
import {
  solverStorage,
  uiStorage,
  type StoredPlacement,
} from "../storage/storage";
import { configState } from "./config.svelte";
import { layoutState } from "./layout.svelte";

/**
 * Everything about running the optimizer: the run status, the streaming result,
 * and the handle that can stop it.
 *
 * It lives apart from `ui.svelte.ts` so the UI singleton does not own a Web
 * Worker pool: this is a separate concern with a separate lifecycle, since a
 * solve outlives any particular panel.
 *
 * This is the *only* place in the app that drives `SolverWorkerClient`. The
 * solver itself never runs on the main thread.
 */
/**
 * How long a solve is allowed to run before it stops itself, in ms.
 *
 * The search has no natural end — it improves a layout until told to stop — so
 * this is the whole shape of a run: the coordinator divides it across islands
 * and every stage's deadline is carved out of it. Short enough that re-running
 * is cheap, which is what makes "run again and keep the better one" a sensible
 * move rather than a five-minute commitment.
 *
 * It is now the budget of **one attempt** rather than of the whole run, and
 * which shape a run takes is the player's choice — see `SOLVE_MODES`. A quick
 * run is one attempt of 30s, exactly as before; a deep run is ten of 10s, and
 * pays for them in wall-clock only where the worker pool is already full.
 */

/**
 * Grace before the client stops a run itself.
 *
 * The workers honour the budget on their own; this is the backstop for an
 * island whose current pass overruns its slice, so a run can never sit there
 * spinning with no way back but the Stop button.
 */
const WATCHDOG_GRACE_MS = 5_000;

/**
 * What a finished run does to the shortlist already held for this island.
 *
 * Three readings of "the run finished", and there is only something to compare
 * against when the user asked to keep the better layout (`held` is empty
 * otherwise, and the fresh run simply stands):
 *
 * - **it beat what was held** — the fresh shortlist replaces it outright.
 * - **it TIED** — both runs are right, so their layouts are pooled and the user
 *   keeps looking at the one they were already on. This is what fills the
 *   shortlist past what a single run finds on its own: ten layouts is more
 *   than one 30s search usually walks past, and every re-run at the same power
 *   adds whatever it found that was new.
 * - **it came back lower** — the held layouts defended their place, shortlist
 *   and all. The search is stochastic and the budget is short, so this is not
 *   rare.
 *
 * A fresh layout joins only if it is `MIN_ALTERNATE_DISTANCE` tiles away from
 * every layout already in the list — two runs finding the same arrangement is
 * common and it is one answer, not two, and two runs finding it a cooler apart
 * is the same again. Held layouts stay in front, and go in unfiltered so the
 * applied one keeps its index: a shortlist stored without that rule would
 * otherwise lose an entry ahead of the user's pick and shift it.
 *
 * **The bar is the best layout held, not the one being looked at.** Cycling is
 * a preview, so `heldIndex` is wherever the user's eye happens to be — and a
 * shortlist does not always stay perfectly level: `rescoreResult` re-rates
 * fixed shapes at a new roster and can rank them apart. Measuring against the
 * previewed entry would let a run that beats only *that* one throw the whole
 * shortlist away, higher layouts included, which is exactly the loss
 * "keep the better one" promises will not happen. The selection is left where
 * the user put it either way — defending is about not losing layouts, not
 * about moving the board out from under them.
 *
 * Exported because it is the whole policy behind "up to ten layouts at the
 * same power" and it is worth pinning in a test without running a solve.
 */
export function chooseSolveVariants(
  held: OptimizationResult[],
  heldIndex: number,
  fresh: OptimizationResult[],
  limit: number = MAX_SOLVE_VARIANTS,
): { variants: OptimizationResult[]; selected: number; defended: boolean } {
  if (fresh.length === 0)
    return { variants: held, selected: heldIndex, defended: true };
  if (held.length === 0)
    return { variants: fresh.slice(0, limit), selected: 0, defended: false };

  // A stored index can outrun a shortlist that has since been rebuilt; the
  // first entry is the layout the search settled on, so it is the safe home.
  const selected = Math.min(Math.max(heldIndex, 0), held.length - 1);
  const bestHeld = held.reduce((best, v) =>
    v.totalPower > best.totalPower ? v : best,
  );

  if (powerTies(fresh[0].totalPower, bestHeld.totalPower)) {
    const variants = held.slice();
    for (const variant of fresh) {
      if (variants.length >= limit) break;
      if (
        !isDistinctLayout(
          variant.placements,
          variants.map((v) => v.placements),
        )
      )
        continue;
      variants.push(variant);
    }
    return { variants, selected, defended: false };
  }

  if (bestHeld.totalPower > fresh[0].totalPower) {
    return { variants: held, selected, defended: true };
  }
  return { variants: fresh.slice(0, limit), selected: 0, defended: false };
}

/**
 * A layout stripped to what storage keeps: which building, where, and the tier
 * it was placed at. Everything else is re-derived by scoring it — see
 * `SavedSolveData.variants` for why it is not stored.
 */
function toStoredPlacements(placements: PlacedBuilding[]): StoredPlacement[] {
  return placements.map((p) => [p.buildingId, p.x, p.y, p.baseValue]);
}

/** The other direction: bare shape back to unscored placements. */
function restorePlacements(stored: StoredPlacement[]): PlacedBuilding[] {
  return stored.map(([buildingId, x, y, baseValue]) =>
    unscoredPlacement(buildingId, x, y, baseValue),
  );
}

class SolverState {
  isOptimizing = $state(false);

  /**
   * The layout on screen — replaced on every progress report, so it streams.
   * Once a run finishes it is always `variants[variantIndex]`.
   */
  optimizationResult = $state<OptimizationResult | null>(null);

  /**
   * Every layout this island's solve found at its best power, the picked one
   * included. `[0]` is the one the search settled on first.
   *
   * A search almost never finds a single best arrangement — several usually
   * tie, and which of them is nicest to actually build (how it sits against
   * the terrain, how far the cables run) is a judgement the solver has no way
   * to make. So the ties are kept and the choice is handed back to the player.
   *
   * Empty while nothing has been solved, and one-long for a solve whose search
   * genuinely found no second arrangement.
   */
  variants = $state<OptimizationResult[]>([]);

  /** Which variant the board is drawing. Moves as the user cycles. */
  variantIndex = $state(0);

  /**
   * Which variant is the *stored* answer for this island.
   *
   * Cycling is a preview — it costs nothing and can be undone by cycling back
   * — so it deliberately does not write to storage. Applying is the commitment,
   * and it is what a reload comes back to.
   */
  appliedVariant = $state(0);

  optimizationError = $state<string | null>(null);

  /** Live task handle; non-null exactly while a solve is in flight. */
  activeTask = $state<SolveTaskHandle | null>(null);

  /**
   * True between pressing Stop and the solve actually finishing.
   *
   * Stopping lets in-flight workers finish their current pass rather than
   * aborting, so the UI needs to say "winding down" instead of going straight
   * back to idle — otherwise the delay reads as a hang.
   */
  isStopping = $state(false);

  /**
   * How long the current run has been going, in ms — or how long the last one
   * took, once it is over. A solve has a five-minute ceiling and no progress
   * bar, so the elapsed clock is the only thing telling the user whether it
   * has been going for four seconds or four minutes.
   */
  elapsedMs = $state(0);

  /** Length of the last completed run, ms. Null until one finishes. */
  lastRunDurationMs = $state<number | null>(null);

  /** When the last run finished, epoch ms. Survives a reload with the result. */
  finishedAt = $state<number | null>(null);

  /** True when the on-screen result came from storage rather than this session. */
  isRestored = $state(false);

  /**
   * How the next run spends its time: one long search, or several short ones.
   *
   * Persisted, because it is a standing answer to "how much wall-clock am I
   * willing to give this", not a per-island decision. It deliberately does not
   * take part in `solveSignature()`: a layout found by ten short searches is
   * the same kind of answer as one found by a single long one, so changing the
   * mode does not make a stored solve stale.
   */
  solveModeId = $state<SolveModeId>(uiStorage.loadPrefs().solveMode);

  #startedAt = 0;
  #ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * The island a run was started on, and the board it was started against.
   *
   * A solve belongs to the island it was launched from, not to whatever is on
   * screen when it lands: the user may switch away mid-run. Both are captured
   * at the start so the result is filed under the right island with the right
   * signature, and so a late progress report cannot paint itself over a
   * different board.
   */
  #runTemplateId = "";
  #runSignature = "";

  #client = new SolverWorkerClient({
    reportIntervalMs: 1000, // 1 second
  });

  #watchdog: ReturnType<typeof setTimeout> | null = null;

  /** The chosen shape of a run. Falls back rather than throwing on a stale id. */
  get solveMode(): SolveMode {
    return SOLVE_MODES[this.solveModeId] ?? SOLVE_MODES[DEFAULT_SOLVE_MODE];
  }

  /** Picks how the next run spends its time, and remembers it. */
  setSolveMode(id: SolveModeId) {
    if (this.solveModeId === id) return;
    this.solveModeId = id;
    uiStorage.savePrefs({ solveMode: id });
  }

  /**
   * Roughly how long a run in `mode` would take on *this* machine, in ms.
   *
   * Not `attempts × budget`: the attempts are pool tasks and overlap, so the
   * cost of a deep run depends on how many cores the browser reports. Printing
   * it is the whole reason the choice can be made honestly — "10 × 10s" says
   * nothing about whether that means twenty seconds or a hundred.
   *
   * Takes the mode rather than reading the current one so the explainer can
   * price all three side by side, which is the comparison the choice actually
   * turns on.
   *
   * Zero when there is nothing to solve, which is also when there is no figure
   * worth showing.
   */
  estimateRunMs(mode: SolveMode): number {
    const grid = layoutState.grid;
    if (!grid || !grid.length || !grid[0] || !grid[0].length) return 0;

    const effectiveBuildings = getEffectiveBuildings(
      BUILDINGS,
      configState.buildingUpgrades,
      configState.prestige,
    );
    if (!effectiveBuildings.length) return 0;

    const islands = splitGridIntoIslands(
      grid,
      canCoolDirectProducer(effectiveBuildings),
      configState.activeAnomaly,
    );
    if (!islands.length) return 0;

    // `tileCount`, not the window's grass: an island's sub-grid is padded and
    // carries the board's real terrain, so a neighbouring island's tiles sit
    // inside it and counting them would inflate every budget estimate.
    const tileCounts = islands.map((island) => island.tileCount);
    return estimateMakespanMs(
      taskDurationsMs(mode, tileCounts),
      defaultPoolSize(),
    );
  }

  /** The same figure for the mode a run would use right now. */
  get estimatedRunMs(): number {
    return this.estimateRunMs(this.solveMode);
  }

  /**
   * How many island searches run at once here. Printed in the explainer,
   * because it is the single number that decides what a deep run costs.
   */
  get workerCount(): number {
    return defaultPoolSize();
  }

  /** Theoretical upper bound maximum power estimate for current grid and unlocked buildings. */
  get estimatedMaxPower(): number {
    const grid = layoutState.grid;
    if (!grid || !grid.length || !grid[0] || !grid[0].length) return 0;

    const upgrades = configState.buildingUpgrades;
    const effectiveBuildings = getEffectiveBuildings(
      BUILDINGS,
      upgrades,
      configState.prestige,
    );
    if (!effectiveBuildings.length) return 0;

    const hasCoolingSupport = canCoolDirectProducer(effectiveBuildings);
    // The same anomaly the run will be planned under: under a shared cooling
    // pool the split keeps one-tile patches, and a bound that decomposed the
    // board differently from the run would be measured against another board.
    const subGrids = splitGridIntoIslands(
      grid,
      hasCoolingSupport,
      configState.activeAnomaly,
    );
    return estimateTotalMaxPower(subGrids, effectiveBuildings);
  }

  /** How many layouts this solve offers. Below two, there is nothing to cycle. */
  get variantCount(): number {
    return this.variants.length;
  }

  /** True while the board shows something other than the stored answer. */
  get canApplyVariant(): boolean {
    return this.variantIndex !== this.appliedVariant;
  }

  /**
   * Draws one of the ties. Wraps in both directions, because the shortlist is
   * a ring the user thumbs through rather than a list they navigate.
   */
  showVariant(index: number) {
    const count = this.variants.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    this.variantIndex = wrapped;
    this.optimizationResult = this.variants[wrapped];
  }

  /** Commits the layout on screen as this island's answer. */
  applyVariant() {
    if (!this.canApplyVariant) return;
    this.appliedVariant = this.variantIndex;
    this.#persistCurrent();
  }

  /**
   * Identity of the board and roster a solve was computed against.
   *
   * Terrain only — hand-placed buildings are deliberately excluded, because
   * the solver ignores them, so placing one does not invalidate a result. What
   * does invalidate it is the terrain changing (an obstacle cleared, a custom
   * island repainted) or the roster changing, and both are covered here.
   *
   * Public because it is a plain query — and because it is what a test needs
   * to stage a stored solve without running a five-minute solve first.
   */
  solveSignature(): string {
    const roster = Object.entries(configState.buildingUpgrades)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, level]) => `${id}:${level}`)
      .join(",");
    // The anomaly and the Time Lab research are both part of the rules the
    // layout was found under, so a solve from another set describes a board
    // that no longer exists — stale in exactly the way a cleared obstacle or a
    // bought upgrade is.
    const research = Object.entries(configState.prestigeLevels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, level]) => `${id}:${level}`)
      .join(",");
    return `${blueprintKey(layoutState.grid)}|${roster}|${configState.anomalyId}|${research}`;
  }

  /**
   * Puts the **active island's** stored solve on screen, or clears the panel if
   * it has none. Total, so it is also what a template switch calls: each island
   * keeps its own solve, and switching is a change of view, not a deletion.
   *
   * A run can take five minutes, so throwing one away is the most expensive
   * thing the app can do — on reload, and on every switch of the template list
   * were solves not keyed per island.
   *
   * Awaited from `hydrateState()` after the grid exists, and called again after
   * every `loadTemplate` — the signature check reads the board, so it can never
   * run before the board is the new one.
   */
  restore() {
    const templateId = layoutState.activeTemplateId;
    const saved = solverStorage.loadSolve(templateId);

    // A repainted board or a different roster is not a stale view of the
    // truth — it is a different question's answer.
    if (!saved || saved.signature !== this.solveSignature()) {
      if (saved) solverStorage.clearSolve(templateId);
      this.#reset();
      return;
    }

    // Only the applied variant was stored scored; the rest are bare shapes,
    // re-scored here by the same code that scores a hand-built board. A record
    // written before variants existed has none, and restores as a shortlist of
    // one — which is exactly what it was.
    const applied = Math.min(
      Math.max(saved.selectedVariant ?? 0, 0),
      Math.max((saved.variants?.length ?? 1) - 1, 0),
    );
    const bound = this.estimatedMaxPower;
    this.variants = (saved.variants ?? []).map((shapes, i) =>
      i === applied
        ? saved.result
        : this.#scoreLayout(restorePlacements(shapes), bound),
    );
    if (this.variants.length === 0) this.variants = [saved.result];

    this.appliedVariant = applied;
    this.variantIndex = applied;
    this.optimizationResult = this.variants[applied];
    this.lastRunDurationMs = saved.durationMs;
    this.elapsedMs = saved.durationMs;
    this.finishedAt = saved.finishedAt;
    this.isRestored = true;
    this.optimizationError = null;
  }

  /**
   * Scores a bare layout into a full result, the way the hand-built board is
   * scored. `bound` is passed in rather than read per call: it is the same
   * figure for every variant and computing it re-splits the whole grid.
   */
  #scoreLayout(
    placements: PlacedBuilding[],
    bound: number,
  ): OptimizationResult {
    const grid = layoutState.grid;
    const scored = simulatePlacedBuildings(
      grid,
      BUILDINGS,
      placements,
      configState.prestige,
      configState.activeAnomaly,
    );

    let totalPower = 0;
    let totalHeatProduced = 0;
    let totalHeatConsumed = 0;
    let totalWasteGenerated = 0;
    let totalCoolingCapacity = 0;
    for (const p of scored) {
      totalPower += p.powerGenerated;
      totalHeatProduced += p.heatProduced;
      totalHeatConsumed += p.heatConsumed;
      totalWasteGenerated += p.wasteHeatGenerated;
      totalCoolingCapacity += p.coolingProvided;
    }

    return {
      totalPower,
      placements: scored,
      activeTilesCount: scored.length,
      unusedTilesCount: Math.max(0, countGrassTiles(grid) - scored.length),
      summary: {
        totalHeatProduced,
        totalHeatConsumed,
        totalWasteGenerated,
        totalCoolingCapacity,
      },
      theoreticalMaxPower: bound,
    };
  }

  /** Empties the panel. Touches no storage — see `clearResult`. */
  #reset() {
    this.optimizationResult = null;
    this.variants = [];
    this.variantIndex = 0;
    this.appliedVariant = 0;
    this.optimizationError = null;
    this.lastRunDurationMs = null;
    this.finishedAt = null;
    this.elapsedMs = 0;
    this.isRestored = false;
  }

  /**
   * Drops the active island's result — from the screen *and* from storage.
   *
   * This is dismissal: the Reset control, and resetting a template. Switching
   * islands deliberately does **not** come here; it goes through `restore()`,
   * which merely swaps which island's solve is on screen.
   */
  clearResult() {
    this.#reset();
    solverStorage.clearSolve(layoutState.activeTemplateId);
  }

  /** Forgets a solve for an island that no longer exists. */
  forgetSolve(templateId: string) {
    solverStorage.clearSolve(templateId);
  }

  /**
   * Re-scores the layout on screen at the player's current unlock levels.
   *
   * Buying a tier changes what every building on the board produces, and the
   * solve is a fixed set of placements — so its *figures* go stale even though
   * its shape does not. This re-runs the same scorer the hand-placed board
   * uses, over the same placements.
   *
   * It deliberately does **not** re-optimise: the layout was chosen for the old
   * roster and may no longer be the best shape, or even a stable one. What it
   * reports afterwards is the honest output of those buildings at their new
   * tiers, which is what the card claims it is. Re-running the optimizer is the
   * player's call.
   *
   * The re-scored result is written back to storage under the new signature,
   * so it survives a reload instead of being discarded as stale a moment after
   * the numbers were brought up to date.
   */
  rescoreResult() {
    // A run in flight owns the panel, and it is already using the old roster —
    // whatever it returns will be filed against the board it actually solved.
    if (this.isOptimizing) return;
    if (this.variants.length === 0) return;

    const upgrades = configState.buildingUpgrades;
    // `null` from each variant that no *tier* moved on. That is not a reason to
    // stop: this also runs for an anomaly or a Time Lab change, neither of which
    // moves a tier — they change what the same tier is worth. Returning early
    // there left the panel printing figures from the old rules and, worse, left
    // the stored record under the old signature, so a reload dropped the solve.
    const rebased = this.variants.map((variant) =>
      rebaseToUnlocks(variant.placements, upgrades),
    );

    // Every variant is re-rated, not just the one on screen: they are all this
    // island's answer and the user can cycle to any of them. A tier bought
    // behind fixed shapes can rate two arrangements differently, so the
    // shortlist may come out of this no longer perfectly level — the card
    // prints each variant's own power, so what it says stays true either way.
    const bound = this.estimatedMaxPower;
    this.variants = rebased.map((placements, i) =>
      this.#scoreLayout(placements ?? this.variants[i].placements, bound),
    );
    this.optimizationResult = this.variants[this.variantIndex] ?? null;

    this.#persistCurrent();
  }

  #startClock() {
    this.#startedAt = performance.now();
    this.elapsedMs = 0;
    this.#stopClock();
    // 100ms so the tenths tick smoothly; the solve itself runs in workers, so
    // this is the only thing the main thread is doing anyway.
    this.#ticker = setInterval(() => {
      this.elapsedMs = performance.now() - this.#startedAt;
    }, 100);
  }

  #stopClock() {
    if (this.#ticker === null) return;
    clearInterval(this.#ticker);
    this.#ticker = null;
  }

  /**
   * Writes the finished run to storage under the island it was *started* on.
   * Reading the active template here instead would file a solve the user
   * walked away from against whatever island they walked to.
   */
  #persistResult(
    variants: OptimizationResult[],
    selectedVariant: number,
    durationMs: number,
    finishedAt: number,
    templateId: string,
    signature: string,
  ) {
    const applied = variants[selectedVariant];
    if (!applied) return;

    solverStorage.saveSolve({
      templateId,
      signature,
      result: $state.snapshot(applied),
      // The picked one is written twice — once scored as `result`, once as a
      // shape here — so that its position in the shortlist survives too.
      variants: variants.map((v) =>
        toStoredPlacements($state.snapshot(v).placements),
      ),
      selectedVariant,
      durationMs,
      finishedAt,
    });
  }

  /**
   * Re-files the shortlist for the island on screen, under the board it is
   * being looked at against.
   *
   * For the writes that are not the end of a run: applying a variant, and
   * re-scoring after an upgrade. Both act on what the user is looking at, so
   * unlike a finishing run there is no captured island to file under.
   */
  #persistCurrent() {
    if (this.variants.length === 0) return;
    if (this.lastRunDurationMs === null || this.finishedAt === null) return;

    this.#persistResult(
      this.variants,
      this.appliedVariant,
      this.lastRunDurationMs,
      this.finishedAt,
      layoutState.activeTemplateId,
      this.solveSignature(),
    );
  }

  /**
   * Starts a solve.
   *
   * `keepBest` decides what happens to the layout already on screen: with it
   * set, the run has to beat that layout to replace it, and the old one comes
   * back if the new one lands lower. Without it the new result stands whatever
   * it scores. The search is stochastic and the budget is short, so a re-run
   * genuinely can come back worse — which is the whole reason the choice is
   * put to the user (see `uiState.requestSolve`) rather than assumed.
   */
  async runOptimizer(options: { keepBest?: boolean } = {}) {
    if (this.isOptimizing) {
      this.stopOptimizer();
      return;
    }

    // Captured before the panel starts streaming the new run over it. The
    // whole shortlist is held, not just the layout on screen: a run that comes
    // back tied adds to it rather than replacing it, and the best of them is
    // the bar the new run has to clear (`chooseSolveVariants`).
    //
    // A result with no shortlist behind it can only be a streaming snapshot
    // left by a run that failed, and it is not something to defend — falling
    // back to it would hand the next run a bar of nearly zero.
    const previousVariants =
      options.keepBest && this.variants.length > 0 ? this.variants : [];
    const previousIndex = this.variantIndex;
    /*
     * The bar a streaming snapshot has to clear to be worth putting on screen,
     * and it is the same bar `chooseSolveVariants` will judge the finished run
     * against — the best layout held, not the one being previewed.
     *
     * Null unless a layout is being defended, in which case every progress
     * report goes straight through as before.
     */
    const defendedPower =
      previousVariants.length > 0
        ? previousVariants.reduce((best, v) => Math.max(best, v.totalPower), 0)
        : null;
    const previousDurationMs = this.lastRunDurationMs;
    const previousFinishedAt = this.finishedAt;

    // Captured before anything can await: this is the island being solved, and
    // the board it is being solved against.
    this.#runTemplateId = layoutState.activeTemplateId;
    this.#runSignature = this.solveSignature();

    this.isOptimizing = true;
    this.isStopping = false;
    this.optimizationError = null;
    this.isRestored = false;
    this.lastRunDurationMs = null;
    this.#startClock();

    // `pool` as well as `cores`, because the pool is capped at eight and the
    // makespan the user was shown follows the pool, not the machine.
    trackEvent("solve_run", {
      mode: this.solveMode.id,
      island: this.#runTemplateId,
      tiles: countGrassTiles(layoutState.grid),
      roster: Object.keys(configState.buildingUpgrades).length,
      cores:
        typeof navigator !== "undefined"
          ? navigator.hardwareConcurrency || 0
          : 0,
      pool: defaultPoolSize(),
    });

    /** True while the board this run is solving is still the one on screen. */
    const onScreen = () => this.#runTemplateId === layoutState.activeTemplateId;
    let finalVariants: OptimizationResult[] | null = null;
    // Tracked separately from `optimizationError`, which is only written while
    // the run's island is still on screen.
    let runError: string | null = null;
    let donePower = 0;

    try {
      // $state.snapshot is required before anything crosses postMessage:
      // reactive proxies are not structured-cloneable.
      const grid = $state.snapshot(layoutState.grid);
      // BUILDINGS is static, so it needs no snapshot — only a mutable
      // copy, because solveProgressive hands it to postMessage.
      const buildings = [...BUILDINGS];
      const upgrades = $state.snapshot(configState.buildingUpgrades);

      const mode = this.solveMode;
      const handle = this.#client.solveProgressive(
        grid,
        buildings,
        upgrades,
        (progressResult) => {
          // A run outlives a template switch; its progress must not.
          if (!onScreen()) return;
          /*
           * A progress report is a search still moving, and for most of a run
           * it is well below what that search will finish at. Streamed over a
           * layout the user asked to *keep*, it takes their 100AC board off
           * the screen and puts an 80AC one there instead — the card printing
           * the lower figure and the canvas drawing the weaker board — for the
           * whole length of the run, with only the final defence putting it
           * back. That reads as the promise being broken and then got lucky.
           *
           * So while a layout is being defended the panel only yields to a
           * snapshot that has actually beaten it. Anything at or below the bar
           * is news about a search, not about the board, and the run is
           * already visibly alive: the clock ticks and Run reads STOP.
           */
          if (
            defendedPower !== null &&
            (progressResult.totalPower <= defendedPower ||
              powerTies(progressResult.totalPower, defendedPower))
          )
            return;
          this.optimizationResult = progressResult;
        },
        {
          attempts: mode.attempts,
          attemptBudgetMs: mode.attemptBudgetMs,
          // The rules this timeline runs under. The research is folded into
          // the roster the coordinator resolves and lands; the anomaly is
          // carried the whole way and not yet acted on.
          anomalyId: configState.activeAnomaly.id,
          prestige: configState.prestige,
        },
      );
      this.activeTask = handle;
      this.#startWatchdog(mode);

      finalVariants = await handle.promise;
      if (onScreen()) this.optimizationResult = finalVariants[0] ?? null;
    } catch (err: any) {
      runError = err?.message || "Optimization failed.";
      if (onScreen()) {
        this.optimizationError = runError;
      }
      console.error("Optimization error:", err);
    } finally {
      const stopped = this.isStopping;
      this.#stopClock();
      this.#stopWatchdog();
      const durationMs = performance.now() - this.#startedAt;
      this.isOptimizing = false;
      this.isStopping = false;
      this.activeTask = null;

      if (
        finalVariants &&
        finalVariants.length > 0 &&
        !this.optimizationError
      ) {
        // `previousVariants` is empty unless the user asked to keep the better
        // layout, so without that this always resolves to the fresh run.
        const { variants, selected, defended } = chooseSolveVariants(
          previousVariants,
          previousIndex,
          finalVariants,
        );

        // A defended layout keeps its own run's clock: it is still that solve,
        // and saying it took as long as the run that failed to beat it would
        // be a lie about a figure the card prints. A tie is a genuine second
        // run over the same answer, so it stamps itself as the current one.
        const winningDurationMs = defended
          ? (previousDurationMs ?? durationMs)
          : durationMs;
        const finishedAt = defended
          ? (previousFinishedAt ?? Date.now())
          : Date.now();

        // Filed under the island it was started on, whether or not that is
        // still the one being looked at.
        this.#persistResult(
          variants,
          selected,
          winningDurationMs,
          finishedAt,
          this.#runTemplateId,
          this.#runSignature,
        );
        if (onScreen()) {
          this.variants = variants;
          this.appliedVariant = selected;
          this.variantIndex = selected;
          this.optimizationResult = variants[selected];
          this.elapsedMs = winningDurationMs;
          this.lastRunDurationMs = winningDurationMs;
          this.finishedAt = finishedAt;
        }
        donePower = variants[selected]?.totalPower ?? 0;
      } else if (onScreen()) {
        /*
         * The run came back with nothing — it errored, or it was torn down
         * before a single island reported. What is on screen at this point is
         * the last thing it *streamed*, which is a search still moving and
         * usually a fraction of the power of the layout it was drawn over.
         *
         * Leaving that behind is the one way "keep the better one" could lose
         * a layout outright: the shortlist still held the good board, but the
         * panel reported the snapshot and the card printed its power. Put the
         * island's actual answer back, with the clock that came with it, or
         * empty the panel if there was never one.
         */
        this.optimizationResult = this.variants[this.variantIndex] ?? null;
        this.lastRunDurationMs = previousDurationMs;
        this.finishedAt = previousFinishedAt;
        this.elapsedMs = previousDurationMs ?? 0;
      }

      // Every `solve_run` gets one of these, so a status other than `ok` is
      // countable rather than inferred from a run that simply never reported.
      const bound = this.estimatedMaxPower;
      trackEvent("solve_done", {
        mode: this.solveMode.id,
        island: this.#runTemplateId,
        status: runError ? "error" : finalVariants?.length ? "ok" : "empty",
        stopped: stopped ? 1 : 0,
        duration_ms: Math.round(durationMs),
        power: Math.round(donePower),
        bound: Math.round(bound),
        bound_pct: bound > 0 ? Math.round((donePower / bound) * 100) : 0,
        variants: this.variants.length,
      });
    }
  }

  stopOptimizer() {
    if (this.activeTask) {
      this.isStopping = true;
      this.activeTask.stop();
    }
  }

  /**
   * The backstop is set against the run's **serial** cost — every attempt of
   * every island one after another — not against the estimate the button
   * prints. The estimate assumes a pool that is actually running in parallel;
   * a machine that reports eight cores and gives two would trip a watchdog set
   * to it, and cutting a run short is worse than letting a slow one finish.
   */
  #startWatchdog(mode: SolveMode) {
    this.#stopWatchdog();
    this.#watchdog = setTimeout(
      () => {
        this.#watchdog = null;
        // The same graceful stop the button performs: in-flight workers finish
        // the pass they are on rather than dropping the layout they have.
        this.stopOptimizer();
      },
      mode.attempts * mode.attemptBudgetMs + WATCHDOG_GRACE_MS,
    );
  }

  #stopWatchdog() {
    if (this.#watchdog === null) return;
    clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }
}

export const solverState = new SolverState();
