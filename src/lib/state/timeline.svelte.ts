import {
  ANOMALIES,
  blueprintKey,
  BUILDINGS,
  CHRONON_REACTOR_ID,
  chrononMultiplier,
  chrononReactorGain,
  decodeBlueprint,
  encodeBlueprint,
  energyForAward,
  FIRST_ENTRY_BONUS,
  firstEntryBonus,
  getAnomaly,
  ISLAND_TEMPLATES,
  PRESTIGE_UPGRADES,
  prestigeScales,
  projectTimeline,
  secondsUntilAward,
  TICK_SECONDS,
  TIME_LAB,
  timeLabCost,
  timeLabLevels,
  type AnomalyDefinition,
  type GameExport,
  type PlacedBuilding,
  type PrestigeScales,
  type ResolvedGameImport,
  type Tile,
  type TimelineProjection,
} from "@reactor2/solver";
import { createPlacement } from "../data/placements";
import { boardPower, boardPowers } from "../simulation/simulator";
import {
  gameImportStorage,
  solverStorage,
  uiStorage,
  type SavedGameImport,
} from "../storage/storage";
import { configState } from "./config.svelte";
import { layoutState } from "./layout.svelte";

/** The shipped islands that exist in the game — the ones a total adds up. */
const GAME_ISLANDS = ISLAND_TEMPLATES.filter((t) => t.game);

/**
 * The player's timeline as a whole: the power of every island at once, and
 * where the Chronon count stands.
 *
 * Two different questions, answered from two different sources, and keeping
 * them apart is the point:
 *
 * - **Power** is the boards *here*, live: the island being edited from its
 *   scored placements, every other one from its saved layout under the
 *   current roster, research and anomaly. It moves as the player edits, which
 *   is what lets them see a change pay before they build it.
 * - **Chronons** are the *game's*, projected from the last import: its energy,
 *   carried forward from the moment of export at the power the game's own
 *   boards made then. An edit here changes nothing in the game, so it must
 *   not move the count; a re-import is what brings the two back together.
 *
 * References `configState` and `layoutState`, and nothing references it but
 * `uiState` and the header — so the store graph stays a DAG.
 */
class TimelineState {
  /** The last game import, as the game had it. Null before the first. */
  record = $state<SavedGameImport | null>(gameImportStorage.load());

  /** Wall clock, epoch ms; `startClock` ticks it while the readout is up. */
  now = $state(Date.now());

  /**
   * The jump award the player is waiting for, or null for none set — in which
   * case `targetEta` reads today's award: what a jump now would leave the
   * player holding. Kept across reloads, and cleared by an import: a new code
   * is a new situation, and a goal set against the last one left standing
   * reads as an import that did not take.
   */
  chrononTarget = $state<number | null>(
    uiStorage.loadPrefs().chrononTarget ?? null,
  );

  /** Each island's power from its saved board, keyed by template id. */
  #savedPower = $state<Record<string, number>>({});

  /**
   * What each island's stored solve would make if it were built, keyed by
   * template id; islands without one are absent. Re-scored under today's
   * roster, research and anomaly on the island's own terrain, so a solve found
   * before an upgrade counts at the tier the player has now.
   */
  #solvePower = $state<Record<string, number>>({});

  /** Power by board and rules, so an unchanged island is not re-scored. */
  #memo = new Map<string, number>();
  #refreshSeq = 0;

  /**
   * The board on screen, live — or null when it is not one the total counts:
   * a custom island, or someone else's previewed layout.
   */
  get #livePower(): number | null {
    if (layoutState.isPreview) return null;
    const id = layoutState.activeTemplateId;
    if (!GAME_ISLANDS.some((t) => t.id === id)) return null;
    let sum = 0;
    for (const p of layoutState.placements) sum += p.powerGenerated;
    return sum;
  }

  /** Every game island's power, per tick, on the boards as they stand here. */
  get totalPower(): number {
    const live = this.#livePower;
    let sum = 0;
    for (const t of GAME_ISLANDS) {
      sum +=
        live !== null && t.id === layoutState.activeTemplateId
          ? live
          : (this.#savedPower[t.id] ?? 0);
    }
    return sum;
  }

  /**
   * Re-scores every island from its saved board. Cheap to call often: a board
   * whose code and rules are unchanged is answered from the memo, and a later
   * call supersedes one still in flight.
   *
   * Reads all of its inputs before the first await, so an `$effect` calling it
   * tracks exactly the state the answer depends on. Stored solves are read off
   * storage, which nothing tracks: the caller re-runs this when a solve lands.
   */
  async refreshIslands(): Promise<void> {
    const seq = ++this.#refreshSeq;
    const upgrades = configState.buildingUpgrades;
    const prestige = configState.prestige;
    const anomaly = configState.activeAnomaly;
    const rules = JSON.stringify([upgrades, configState.prestigeLevels]);
    // The board on screen is counted live, and is re-saved after every edit;
    // scoring its saved copy too would redo that work on every paint.
    const liveId = layoutState.isPreview ? null : layoutState.activeTemplateId;
    const boards = GAME_ISLANDS.filter((t) => t.id !== liveId).map((t) => ({
      id: t.id,
      code: layoutState.savedGrids[t.id]?.code ?? t.code,
    }));

    const next: Record<string, number> = {};
    for (const { id, code } of boards) {
      const key = `${anomaly.id}|${rules}|${code}`;
      let power = this.#memo.get(key);
      if (power === undefined) {
        power = await scoreBoard(code, upgrades, prestige, anomaly);
        if (seq !== this.#refreshSeq) return;
        this.#memo.set(key, power);
      }
      next[id] = power;
    }
    // A memo keyed on whole boards grows with every edit; past a few rounds
    // of islands it is cheaper to start again than to track which are live.
    // Each stored solve, scored on its island's terrain. The board on screen
    // gives its terrain live — tile types only, so a paint that places a
    // building does not re-score a solve that ignores hand placements.
    const solves = GAME_ISLANDS.flatMap((t) => {
      const saved = solverStorage.loadSolve(t.id);
      if (!saved) return [];
      const grid = t.id === liveId ? $state.snapshot(layoutState.grid) : null;
      const code = layoutState.savedGrids[t.id]?.code ?? t.code;
      return [{ id: t.id, saved, grid, code }];
    });
    const solved: Record<string, number> = {};
    for (const { id, saved, grid, code } of solves) {
      const terrain = grid ? blueprintKey(grid) : code;
      const key = [
        "solve",
        anomaly.id,
        rules,
        terrain,
        saved.finishedAt,
        saved.selectedVariant ?? 0,
      ].join("|");
      let power = this.#memo.get(key);
      if (power === undefined) {
        const board = grid ?? (await decodeTerrain(code));
        if (seq !== this.#refreshSeq) return;
        power = board
          ? boardPower(
              board,
              BUILDINGS,
              saved.result.placements.map((p) =>
                createPlacement(p.buildingId, p.x, p.y, upgrades),
              ),
              prestige,
              anomaly,
            )
          : 0;
        this.#memo.set(key, power);
      }
      solved[id] = power;
    }

    if (this.#memo.size > GAME_ISLANDS.length * 8) this.#memo.clear();
    this.#savedPower = next;
    this.#solvePower = solved;
  }

  /** How many game islands have a stored solve — what "With solves" covers. */
  get solvedIslands(): number {
    return Object.keys(this.#solvePower).length;
  }

  /**
   * Every game island's power with each stored solve built in place of the
   * board here — or null when no island has a solve. An island whose solve
   * makes less than the board it would replace keeps the board: nobody
   * rebuilds to lose power.
   */
  get withSolvesPower(): number | null {
    const solved = this.#solvePower;
    if (Object.keys(solved).length === 0) return null;
    const live = this.#livePower;
    let sum = 0;
    for (const t of GAME_ISLANDS) {
      const here =
        live !== null && t.id === layoutState.activeTemplateId
          ? live
          : (this.#savedPower[t.id] ?? 0);
      sum += Math.max(here, solved[t.id] ?? 0);
    }
    return sum;
  }

  /** The Chronon Reactor multiplier the game reported, ×1 without a record. */
  get #multiplier(): number {
    return chrononMultiplier(this.record?.research[CHRONON_REACTOR_ID] ?? 0);
  }

  /**
   * The imported timeline run forward to `now`, or null with no timeline to
   * run: nothing imported yet, or a code from before the game wrote one.
   */
  get projection(): TimelineProjection | null {
    const r = this.record;
    if (!r?.timeline) return null;
    return projectTimeline(
      r.timeline,
      r.energyPerTick / TICK_SECONDS,
      this.#multiplier,
      this.now / 1000,
    );
  }

  setChrononTarget(target: number | null) {
    const valid = target !== null && Number.isFinite(target) && target > 0;
    this.chrononTarget = valid ? Math.floor(target) : null;
    uiStorage.savePrefs({ chrononTarget: this.chrononTarget ?? undefined });
  }

  /**
   * Three round targets above today's award, sized to it: one, five and ten
   * units past it, the unit a tenth of the award's order of magnitude — 11,483
   * gives 12,000, 15,000 and 20,000, and 723 gives 730, 750 and 800.
   *
   * Sized to the award because the exponent makes size everything: a fixed
   * 10,000 is two days away for a late player and, for one at 723, a span
   * longer than any date can name.
   */
  get quickTargets(): number[] {
    const award = this.projection?.award ?? 0;
    const unit = Math.max(
      1,
      10 ** (Math.floor(Math.log10(Math.max(award, 1))) - 1),
    );
    const out: number[] = [];
    for (const multiple of [1, 5, 10]) {
      const step = unit * multiple;
      let v = (Math.floor(award / step) + 1) * step;
      while (out.length && v <= out[out.length - 1]) v += step;
      out.push(v);
    }
    return out;
  }

  /**
   * What an unset target reads: today's award, so an empty field answers
   * "what would I hold if I jumped now?".
   */
  get defaultTarget(): number {
    return this.projection?.award ?? 0;
  }

  /**
   * When the jump award reaches the target, or null with no timeline to count.
   *
   * `seconds` is real time from `now`, and null when nothing is produced so the
   * target never arrives; `at` is that moment on this device's clock, and
   * `elapsedAt` the timeline's length then, the figure the game shows. `held`
   * is what the player would hold after jumping at that point, first-entry
   * bonus excluded.
   */
  get targetEta(): {
    target: number;
    seconds: number | null;
    at: number | null;
    elapsedAt: number | null;
    held: number;
    /**
     * The same wait were the game running every stored solve from now on —
     * null with no solve that beats the game's power, or no wait to shorten.
     */
    secondsWithSolves: number | null;
  } | null {
    const r = this.record;
    const p = this.projection;
    if (!r?.timeline || !p) return null;
    const target = this.chrononTarget ?? this.defaultTarget;
    const seconds = secondsUntilAward(
      p.energy,
      r.energyPerTick / TICK_SECONDS,
      this.#multiplier,
      target,
    );
    const solves = this.withSolvesPower;
    const secondsWithSolves =
      seconds && solves !== null && solves > r.energyPerTick
        ? secondsUntilAward(
            p.energy,
            solves / TICK_SECONDS,
            this.#multiplier,
            target,
          )
        : null;
    return {
      target,
      seconds,
      at: seconds === null ? null : this.now + seconds * 1000,
      elapsedAt: seconds === null ? null : p.elapsedSeconds + seconds,
      // A target already met is met by today's award, which a jump pays.
      held: r.timeline.chronons + Math.max(target, p.award),
      secondsWithSolves,
    };
  }

  /**
   * How fast the timeline earns now against how fast it has earned on
   * average, in Chronons an hour — null with no timeline, or nothing produced.
   *
   * The award grows with energy to the power 0.135, so every Chronon takes
   * longer than the last. If the next timeline runs much like this one, the
   * moment the rate now falls below this timeline's average is the moment a
   * fresh timeline starts earning faster than staying does — the classic
   * point to jump. That "if" is the whole caveat, and Time Lab research bought
   * at the jump only makes the next one faster, so this errs late, not early.
   */
  get pace(): { nowPerHour: number; averagePerHour: number } | null {
    const p = this.projection;
    if (!p || p.chrononSeconds === null || p.elapsedSeconds <= 0) return null;
    return {
      nowPerHour: 3600 / p.chrononSeconds,
      averagePerHour: p.award / (p.elapsedSeconds / 3600),
    };
  }

  /**
   * The anomalies a jump would still pay the first-entry bonus for — the
   * choices a player makes at the jump, so the readout lists them by name.
   * One entry per anomaly: a balance variant is the same anomaly.
   */
  get unenteredAnomalies(): AnomalyDefinition[] {
    const entered = this.record?.timeline?.anomaliesEntered;
    if (!entered) return [];
    return ANOMALIES.filter(
      (a) =>
        a.id !== "none" &&
        !a.id.endsWith("_legacy") &&
        firstEntryBonus(a.id, entered) > 0,
    );
  }

  /**
   * Keeps `now` ticking once a second, for as long as something shows it.
   * Returns the stop, so a component's `$effect` can hand it straight back.
   */
  startClock(): () => void {
    this.now = Date.now();
    const id = setInterval(() => (this.now = Date.now()), 1000);
    return () => clearInterval(id);
  }

  /**
   * Keeps a game import as the game had it — see `SavedGameImport`. Called by
   * `uiState.applyGameImport` once the import has landed.
   *
   * The power is scored here, from the resolved boards at the resolved
   * levels, rather than read back off the islands just written: those are at
   * whatever the import mode made of research still running, and the game's
   * boards are not running at levels it has not finished.
   */
  async recordImport(
    exp: GameExport,
    resolved: ResolvedGameImport,
  ): Promise<void> {
    const prestige = prestigeScales(resolved.prestigeLevels);
    const anomaly = getAnomaly(resolved.anomalyId);
    const islands: Record<string, string> = {};
    let energyPerTick = 0;
    for (const island of resolved.islands) {
      islands[island.templateId] = await encodeBlueprint(
        island.grid,
        island.placements,
      );
      energyPerTick += boardPower(
        island.grid,
        BUILDINGS,
        island.placements.map((p) =>
          createPlacement(p.buildingId, p.x, p.y, resolved.buildingUpgrades),
        ),
        prestige,
        anomaly,
      );
    }

    const record: SavedGameImport = {
      version: 1,
      importedAt: Date.now(),
      gameVersion: exp.gameVersion,
      anomalyId: exp.anomalyId,
      anomalyBalance: exp.anomalyBalance,
      research: { ...exp.research },
      researchInProgress: exp.researchInProgress.map((p) => ({ ...p })),
      clearing: exp.clearing.map((c) => ({ ...c })),
      islands,
      lockedTemplateIds: [...resolved.lockedTemplateIds],
      energyPerTick,
      timeline: exp.timeline
        ? {
            ...exp.timeline,
            anomaliesEntered: [...exp.timeline.anomaliesEntered],
          }
        : null,
    };
    this.record = record;
    this.now = Date.now();
    gameImportStorage.save(record);
    this.setChrononTarget(null);
    // A plan priced against the last import's levels is against levels the
    // player may no longer hold.
    this.timeLabPlan = {};
  }

  // ── The Time Lab planner ─────────────────────────────────────────────────

  /**
   * Extra levels the player means to buy at the jump, by research id. Kept for
   * the session and cleared by an import, like the target: a plan is priced
   * against the levels the last code reported.
   */
  timeLabPlan = $state<Record<string, number>>({});

  /** Whether the budget counts the +88 for entering an anomaly not yet run. */
  planWithBonus = $state(true);

  /**
   * Power across every island under the game's research, under the plan, and
   * under the plan with one more level of each stat research — or null until
   * `refreshPlanPower` has run.
   */
  planPower = $state<{
    base: number;
    plan: number;
    next: Record<string, number>;
  } | null>(null);

  #planSeq = 0;
  /** Decoded boards by roster and code, so a tap re-prices without decoding. */
  #boards = new Map<
    string,
    { grid: Tile[][]; placements: PlacedBuilding[] } | null
  >();

  /** Each research's level in the game, or null with nothing imported. */
  get timeLabLevels(): Record<string, number> | null {
    return this.record ? timeLabLevels(this.record.research) : null;
  }

  /** Raises or lowers a research's planned levels, within what it has left. */
  planLevels(id: string, delta: number) {
    const levels = this.timeLabLevels;
    const research = TIME_LAB.find((r) => r.id === id);
    if (!levels || !research) return;
    const room = research.costs.length - levels[id];
    const next = Math.max(
      0,
      Math.min((this.timeLabPlan[id] ?? 0) + delta, room),
    );
    const plan = { ...this.timeLabPlan };
    if (next === 0) delete plan[id];
    else plan[id] = next;
    this.timeLabPlan = plan;
  }

  clearTimeLabPlan() {
    this.timeLabPlan = {};
  }

  /** What the plan costs in Chronons. */
  get planCost(): number {
    const levels = this.timeLabLevels;
    if (!levels) return 0;
    let sum = 0;
    for (const r of TIME_LAB) {
      const extra = this.timeLabPlan[r.id] ?? 0;
      if (extra) sum += timeLabCost(r, levels[r.id], levels[r.id] + extra);
    }
    return sum;
  }

  /**
   * The Chronons there will be to spend: what the target says a jump would
   * leave the player holding, plus the first-entry bonus when it is counted
   * and there is an anomaly left to earn it. Null with no timeline.
   */
  get planBudget(): number | null {
    const eta = this.targetEta;
    if (!eta) return null;
    const bonus =
      this.planWithBonus && this.unenteredAnomalies.length > 0
        ? FIRST_ENTRY_BONUS
        : 0;
    return eta.held + bonus;
  }

  /**
   * What the next planned-on level of Chronon Reactor pays per jump, at the
   * energy the jump is made at — the target's, or today's once that is met.
   * Null with no timeline, or nothing left to buy.
   */
  get reactorNextGain(): number | null {
    const levels = this.timeLabLevels;
    const p = this.projection;
    const eta = this.targetEta;
    if (!levels || !p || !eta) return null;
    const at = levels.chronon_reactor + (this.timeLabPlan.chronon_reactor ?? 0);
    if (at >= TIME_LAB.find((r) => r.id === "chronon_reactor")!.costs.length)
      return null;
    const energy = Math.max(
      p.energy,
      energyForAward(eta.target, this.#multiplier),
    );
    return chrononReactorGain(energy, at, at + 1);
  }

  /**
   * Scores every island under the game's research, the plan, and the plan
   * with one more level of each stat research, into `planPower`. Async and
   * superseded by a later call, so a burst of taps prices only the last plan.
   *
   * The boards are the ones here, at their saved layouts, so the figure is
   * "what this research would do to the layouts you have" — a solve re-run at
   * the new rating could do better, which makes these the floor.
   */
  async refreshPlanPower(): Promise<void> {
    const seq = ++this.#planSeq;
    const levels = this.timeLabLevels;
    if (!levels) {
      this.planPower = null;
      return;
    }
    const upgrades = configState.buildingUpgrades;
    const anomaly = configState.activeAnomaly;
    const plan = this.timeLabPlan;

    /** Solver research levels (0-based, absent = none) from game levels. */
    const scales = (extra: (id: string) => number): PrestigeScales => {
      const out: Record<string, number> = {};
      for (const u of PRESTIGE_UPGRADES) {
        const level = levels[u.id] + extra(u.id);
        if (level > 0) out[u.id] = level - 1;
      }
      return prestigeScales(out);
    };
    const statIds = PRESTIGE_UPGRADES.map((u) => u.id);
    const sets = [
      scales(() => 0),
      scales((id) => plan[id] ?? 0),
      ...statIds.map((stat) =>
        scales((id) => (plan[id] ?? 0) + (id === stat ? 1 : 0)),
      ),
    ];

    const roster = JSON.stringify(upgrades);
    const totals = sets.map(() => 0);
    for (const t of GAME_ISLANDS) {
      const code = layoutState.savedGrids[t.id]?.code ?? t.code;
      const key = `${roster}|${code}`;
      let board = this.#boards.get(key);
      if (board === undefined) {
        board = await decodeBoard(code, upgrades);
        if (seq !== this.#planSeq) return;
        this.#boards.set(key, board);
      }
      if (!board) continue;
      boardPowers(
        board.grid,
        BUILDINGS,
        board.placements,
        sets,
        anomaly,
      ).forEach((p, i) => (totals[i] += p));
    }
    if (this.#boards.size > GAME_ISLANDS.length * 4) this.#boards.clear();
    this.planPower = {
      base: totals[0],
      plan: totals[1],
      next: Object.fromEntries(statIds.map((id, i) => [id, totals[2 + i]])),
    };
  }
}

/**
 * A saved board, its buildings at the tiers `upgrades` unlocks; null if it
 * cannot be read.
 */
async function decodeBoard(
  code: string,
  upgrades: Record<string, number>,
): Promise<{ grid: Tile[][]; placements: PlacedBuilding[] } | null> {
  try {
    const { grid, placements } = await decodeBlueprint(code);
    return {
      grid,
      placements: placements.map((p) =>
        createPlacement(p.buildingId, p.x, p.y, upgrades),
      ),
    };
  } catch {
    return null;
  }
}

/** A saved board's terrain, or null if it cannot be read. */
async function decodeTerrain(code: string): Promise<Tile[][] | null> {
  try {
    return (await decodeBlueprint(code)).grid;
  } catch {
    return null;
  }
}

/** One saved board's power under the given rules; 0 if it cannot be read. */
async function scoreBoard(
  code: string,
  upgrades: Record<string, number>,
  prestige: PrestigeScales,
  anomaly: AnomalyDefinition,
): Promise<number> {
  try {
    const { grid, placements } = await decodeBlueprint(code);
    return boardPower(
      grid,
      BUILDINGS,
      placements.map((p) => createPlacement(p.buildingId, p.x, p.y, upgrades)),
      prestige,
      anomaly,
    );
  } catch {
    return 0;
  }
}

export const timelineState = new TimelineState();
