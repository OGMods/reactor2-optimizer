import type { GameExportTimeline } from "../encoding/gameExport";

/**
 * What a Time Jump pays, and when the next Chronon lands.
 *
 * The award is the game's `ChrononFormula`, read out of its binary and then
 * stated by its developer in the same form:
 *
 *   Chronons = max(1, floor(97.34 × (E / 2.82e16)^0.135 × M)) + B
 *
 * `E` is the timeline's energy, online and offline; `M` the Chronon Reactor
 * multiplier; `B` the first-entry bonus — 88 the first time a timeline runs
 * under a given anomaly, otherwise 0, and added after the multiplier rather
 * than through it. At `E = 0` the game pays 0, not the `max(1, …)` floor.
 *
 * Every sample the game exported carries its own award, and this formula
 * reproduces each one (`tests/chronons.test.ts`). The projection was then held
 * against a live save: from the export's figures and the board's power taken
 * per 3-second tick, it put the next Chronon within two seconds of the game's.
 *
 * The exponent is the fact that matters to a player: doubling a whole
 * timeline's energy buys about 9.8% more Chronons. The multiplier and the
 * first-entry bonus are the levers that move the count; layout power mostly
 * moves how soon it arrives.
 */

const AWARD_BASE = 97.34;
const ENERGY_SCALE = 2.82e16;
const EXPONENT = 0.135;

/** `B`: paid on a timeline's first entry into an anomaly, unmultiplied. */
export const FIRST_ENTRY_BONUS = 88;

/**
 * Seconds per game tick. A board's power — what `simulateIsland` totals, and
 * what the readout prints — is energy per tick, so this turns it into the rate
 * timeline energy grows at.
 */
export const TICK_SECONDS = 3;

/**
 * Chronon Reactor's authored `BonusPercentage` per level, from the external
 * extractor's Time Lab record. It is one of the nine researches
 * `PRESTIGE_UPGRADES` leaves out, since it changes no layout; it is carried
 * here because it is the `M` above.
 */
const CHRONON_REACTOR_BONUSES = [0.05, 0.1, 0.15, 0.2, 0.25] as const;

/** The game's research id for it, as a game export spells it. */
export const CHRONON_REACTOR_ID = "chronon_reactor";

/** `M` at a purchased level — 0 means not bought, and is ×1. */
export function chrononMultiplier(level: number): number {
  if (!(level > 0)) return 1;
  const i = Math.min(level, CHRONON_REACTOR_BONUSES.length) - 1;
  return 1 + CHRONON_REACTOR_BONUSES[i];
}

/** Chronons a jump pays for `energy`, without the first-entry bonus. */
export function chrononAward(energy: number, multiplier: number): number {
  if (!(energy > 0)) return 0;
  return Math.max(
    1,
    Math.floor(AWARD_BASE * (energy / ENERGY_SCALE) ** EXPONENT * multiplier),
  );
}

/**
 * The timeline energy at which the award first reaches `award` — the inverse
 * of `chrononAward`, up to its floor.
 */
export function energyForAward(award: number, multiplier: number): number {
  if (award <= 1) return 0;
  return ENERGY_SCALE * (award / (AWARD_BASE * multiplier)) ** (1 / EXPONENT);
}

/**
 * Seconds until a timeline at `energy`, growing at `energyPerSecond`, pays
 * `target` on a jump (first-entry bonus excluded): 0 when it already does,
 * null when it never will because nothing is being produced.
 *
 * Real seconds. The game counts offline time in real time, but its ticks run
 * a little slow while it is open, so a target hours away arrives somewhat
 * later than this for a player who keeps the game open throughout.
 */
export function secondsUntilAward(
  energy: number,
  energyPerSecond: number,
  multiplier: number,
  target: number,
): number | null {
  if (chrononAward(energy, multiplier) >= target) return 0;
  if (!(energyPerSecond > 0)) return null;
  return (energyForAward(target, multiplier) - energy) / energyPerSecond;
}

const THRESHOLD_BASE = 88;
const THRESHOLD_GROWTH = 1.15;
const THRESHOLD_CAP = 5000;

/**
 * The smallest award (bonus excluded) the game lets a player jump on, after
 * `generation` completed jumps: 88, 101, 116, 134, 154 … capped at 5000 from
 * the 29th. Rounded half away from zero, which on a positive number is what
 * `Math.round` does.
 */
export function jumpThreshold(generation: number): number {
  return Math.min(
    THRESHOLD_CAP,
    Math.round(THRESHOLD_BASE * THRESHOLD_GROWTH ** Math.max(0, generation)),
  );
}

/**
 * The anomaly a first-entry bonus is filed under. A rebalance is still the
 * same anomaly — the game writes `tidal_ascendancy` into the entered list
 * whichever balance the save runs — so a balance-variant id folds back.
 */
function bonusAnomaly(anomalyId: string): string {
  return anomalyId === "tidal_ascendancy_legacy"
    ? "tidal_ascendancy"
    : anomalyId;
}

/** `B` for a jump into `anomalyId`, given the anomalies already entered. */
export function firstEntryBonus(
  anomalyId: string,
  entered: readonly string[],
): number {
  if (anomalyId === "none") return 0;
  return entered.includes(bonusAnomaly(anomalyId)) ? 0 : FIRST_ENTRY_BONUS;
}

/** Where a timeline stands at one moment, projected from an export. */
export interface TimelineProjection {
  /** Seconds since the export the projection ran forward. */
  sinceExport: number;
  energy: number;
  elapsedSeconds: number;
  /** Chronons a jump pays now, first-entry bonus excluded. */
  award: number;
  /** Seconds until the award goes up by one; null when energy is not growing. */
  secondsToNext: number | null;
  /**
   * How long the Chronon now under way takes from start to finish, at this
   * rate; null when energy is not growing. Each one takes a little longer
   * than the last.
   */
  chrononSeconds: number | null;
  /**
   * How far the energy is from this award's threshold to the next one's, 0 to
   * 1 — the game's own "until next Chronon" bar.
   */
  towardNext: number;
  /** The award a jump needs, and whether this one clears it. */
  threshold: number;
  canJump: boolean;
}

/**
 * Runs an exported timeline forward to `atUnixSeconds` at `energyPerSecond`.
 *
 * A code is a photograph: it may be pasted minutes or days after the game
 * wrote it, and the timeline kept running in between — offline time counts
 * too. So nothing is shown as the export's own figure; everything is carried
 * forward from `exportedAt`. A clock behind the export's (a device clock, or a
 * server time ahead of it) projects nothing rather than running backwards.
 *
 * The rate is the caller's to choose, and the right one is the power the
 * player's game boards make — not a board edited here since, which the game
 * has not seen.
 */
export function projectTimeline(
  timeline: Pick<
    GameExportTimeline,
    "exportedAt" | "energy" | "elapsedSeconds" | "generation"
  >,
  energyPerSecond: number,
  multiplier: number,
  atUnixSeconds: number,
): TimelineProjection {
  const sinceExport = Math.max(0, atUnixSeconds - timeline.exportedAt);
  const rate = energyPerSecond > 0 ? energyPerSecond : 0;
  const energy = timeline.energy + rate * sinceExport;
  const award = chrononAward(energy, multiplier);
  const next = Math.max(energyForAward(award + 1, multiplier), energy);
  const from = Math.min(energyForAward(award, multiplier), energy);
  const threshold = jumpThreshold(timeline.generation);
  return {
    sinceExport,
    energy,
    elapsedSeconds: timeline.elapsedSeconds + sinceExport,
    award,
    secondsToNext: rate > 0 ? (next - energy) / rate : null,
    chrononSeconds: rate > 0 ? (next - from) / rate : null,
    towardNext: next > from ? (energy - from) / (next - from) : 0,
    threshold,
    canJump: award >= threshold,
  };
}
