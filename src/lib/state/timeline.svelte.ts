import {
  ANOMALIES,
  BUILDINGS,
  CHRONON_REACTOR_ID,
  chrononMultiplier,
  decodeBlueprint,
  encodeBlueprint,
  firstEntryBonus,
  getAnomaly,
  ISLAND_TEMPLATES,
  prestigeScales,
  projectTimeline,
  TICK_SECONDS,
  type AnomalyDefinition,
  type GameExport,
  type PrestigeScales,
  type ResolvedGameImport,
  type TimelineProjection,
} from "@reactor2/solver";
import { createPlacement } from "../data/placements";
import { boardPower } from "../simulation/simulator";
import { gameImportStorage, type SavedGameImport } from "../storage/storage";
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

  /** Each island's power from its saved board, keyed by template id. */
  #savedPower = $state<Record<string, number>>({});

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
   * tracks exactly the state the answer depends on.
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
    if (this.#memo.size > GAME_ISLANDS.length * 8) this.#memo.clear();
    this.#savedPower = next;
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
