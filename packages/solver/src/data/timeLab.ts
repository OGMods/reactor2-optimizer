import { chrononAward, chrononMultiplier } from "./chronons";

/**
 * Every Time Lab research: what each level costs in Chronons and what it does.
 *
 * Transcribed by hand from the external extractor's Time Lab record, the way
 * `PRESTIGE_UPGRADES` and `ANOMALIES` are — nothing splices this file. That
 * table carries only the three researches a layout can feel and exists to
 * rate buildings; this one carries all twelve and exists to *buy* them, so the
 * Time Lab planner can price a jump's worth of Chronons. Where the two overlap
 * they must agree, and `tests/timeLab.test.ts` holds them to it.
 *
 * `values` is the authored figure each level reaches, in the unit `kind`
 * names. Chrono Seed has none: its record authors eighteen "levels" against
 * six costs, and the values read as city levels rather than a bonus — six
 * purchases are what the game sells, and what it delivers is said in words.
 */

/** How a research's `values` read. */
export type TimeLabKind =
  /** A fraction added on top: 0.5 reads "+50%". */
  | "bonus"
  /** A fraction taken off: 0.2 reads "−20%". */
  | "reduction"
  /** A window in seconds: 900 reads "15m". */
  | "window"
  /** No figure — what a level gives is in the description. */
  | "level";

export interface TimeLabResearch {
  /** The extractor's id, which is also the game's — bar Chrono Seed's. */
  id: string;
  /** The id a game export's research section files it under. */
  gameId: string;
  name: string;
  /** What it changes, short: the row's subtitle. */
  effect: string;
  description: string;
  kind: TimeLabKind;
  /** The figure each level reaches, level 1 first; null for `level`. */
  values: readonly number[] | null;
  /** Chronons each level costs, level 1 first. Its length is the cap. */
  costs: readonly number[];
}

export const TIME_LAB: readonly TimeLabResearch[] = [
  {
    id: "chronon_reactor",
    gameId: "chronon_reactor",
    name: "Chronon Reactor",
    effect: "Chronons per jump",
    description:
      "Extracts more Chronons from the Energy produced in each timeline.",
    kind: "bonus",
    values: [0.05, 0.1, 0.15, 0.2, 0.25],
    costs: [150, 350, 800, 1800, 4000],
  },
  {
    id: "stellar_forge",
    gameId: "stellar_forge",
    name: "Stellar Forge",
    effect: "Reactor heat",
    description: "Boosts the Heat output of all Heat Producers.",
    kind: "bonus",
    values: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5],
    costs: [15, 25, 45, 85, 150, 260, 460, 820, 1500, 2600],
  },
  {
    id: "infinite_grid",
    gameId: "infinite_grid",
    name: "Infinite Grid",
    effect: "Generators and wind turbines",
    description:
      "Improves all Generators and Wind Turbines, increasing Energy output, " +
      "Heat, and overheat thresholds.",
    kind: "bonus",
    values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    costs: [10, 20, 35, 70, 130, 250, 480, 910, 1700, 3300],
  },
  {
    id: "absolute_zero",
    gameId: "absolute_zero",
    name: "Absolute Zero",
    effect: "Cooling output",
    description: "Boosts the Cooling output of all cooling systems.",
    kind: "bonus",
    values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    costs: [10, 20, 35, 70, 130, 250, 480, 910, 1700, 3300],
  },
  {
    id: "archives_beyond_time",
    gameId: "archives_beyond_time",
    name: "Archives Beyond Time",
    effect: "Research point income",
    description:
      "Recovers knowledge from lost timelines, increasing Research Point " +
      "income.",
    kind: "bonus",
    values: [0.5, 1.2, 1.9, 2.6, 3.4, 4.3, 5.3, 6.5, 8.0, 10.0, 13.0],
    costs: [15, 30, 60, 120, 240, 480, 970, 1900, 3900, 7800, 16000],
  },
  {
    id: "chrono_accelerator",
    gameId: "chrono_accelerator",
    name: "Chrono Accelerator",
    effect: "Research time",
    description:
      "Accelerates all research, reducing the time needed to complete it.",
    kind: "reduction",
    values: [0.2, 0.3, 0.39, 0.47, 0.54, 0.6, 0.65, 0.72, 0.81, 0.9, 0.94],
    costs: [20, 45, 100, 220, 500, 1100, 2500, 5500, 12000, 28000, 62000],
  },
  {
    id: "zero_time_protocol",
    gameId: "zero_time_protocol",
    name: "Zero-Time Protocol",
    effect: "Free research speed-up",
    description:
      "Extends the time window for free research completion, adding to your " +
      "existing free speedup.",
    kind: "window",
    values: [
      1200, 1800, 2700, 3600, 4800, 6000, 7500, 9300, 11400, 14100, 17400,
    ],
    costs: [20, 35, 60, 100, 170, 280, 480, 820, 1400, 2400, 4100],
  },
  {
    id: "quantum_exchange",
    gameId: "quantum_exchange",
    name: "Quantum Exchange",
    effect: "Energy sale price",
    description: "Increases the price of all energy sold, including surplus.",
    kind: "bonus",
    values: [1.0, 1.7, 2.4, 3.2, 4.0, 4.9, 5.8, 6.8, 8.0, 9.4, 11.0],
    costs: [20, 40, 80, 170, 330, 680, 1400, 2800, 5600, 11000, 23000],
  },
  {
    id: "quantum_replicator",
    gameId: "quantum_replicator",
    name: "Quantum Replicator",
    effect: "Building cost",
    description:
      "Replicates construction materials, reducing the cost of all buildings.",
    kind: "reduction",
    values: [0.15, 0.27, 0.37, 0.45, 0.52, 0.58, 0.62, 0.66, 0.69, 0.72, 0.75],
    costs: [10, 20, 40, 80, 160, 320, 640, 1300, 2600, 5100, 10000],
  },
  {
    id: "phase_breaker",
    gameId: "phase_breaker",
    name: "Phase Breaker",
    effect: "Obstacle removal time",
    description:
      "Destabilizes obstacles, reducing the time needed to remove them.",
    kind: "reduction",
    values: [0.25, 0.35, 0.45, 0.55, 0.62, 0.68, 0.74, 0.8, 0.85, 0.9],
    costs: [5, 10, 30, 70, 160, 380, 910, 2200, 5200, 12000],
  },
  {
    id: "erased_from_time",
    gameId: "erased_from_time",
    name: "Erased from Time",
    effect: "Free obstacle finish",
    description:
      "Allows you to finish removing an obstacle for free when its remaining " +
      "removal time is within the limit.",
    kind: "window",
    values: [
      900, 1500, 2100, 3000, 4200, 5400, 7200, 9600, 12600, 16800, 21600,
    ],
    costs: [5, 10, 25, 55, 120, 260, 560, 1200, 2700, 6000, 13000],
  },
  {
    id: "skip_city",
    gameId: "TimeLabSkipCityResearchSO",
    name: "Chrono Seed",
    effect: "City after jump",
    description:
      "After your next Time Jump, start at a higher City level with a starter " +
      "kit to assemble and replay rewards for skipped chapters.",
    kind: "level",
    values: null,
    costs: [150, 500, 1500, 3000, 6000, 12000],
  },
];

/** One research by id; throws on an id the table does not have. */
export function timeLabResearch(id: string): TimeLabResearch {
  const r = TIME_LAB.find((t) => t.id === id);
  if (!r) throw new Error(`No Time Lab research "${id}"`);
  return r;
}

/**
 * Each research's purchased level, by our id, read off a game export's
 * research section — 0 for one it does not name, and clamped to the levels
 * this table carries, so a game that adds a level does not read past it.
 */
export function timeLabLevels(
  research: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of TIME_LAB) {
    const level = research[r.gameId] ?? 0;
    out[r.id] = Math.max(0, Math.min(level, r.costs.length));
  }
  return out;
}

/** What levels `from + 1` through `to` cost together; 0 when `to <= from`. */
export function timeLabCost(
  research: TimeLabResearch,
  from: number,
  to: number,
): number {
  let sum = 0;
  for (let l = Math.max(from, 0); l < Math.min(to, research.costs.length); l++)
    sum += research.costs[l];
  return sum;
}

/**
 * Chronons a jump pays at `energy` with Chronon Reactor at `to` rather than
 * `from` — the one research whose worth is a count of Chronons.
 */
export function chrononReactorGain(
  energy: number,
  from: number,
  to: number,
): number {
  return (
    chrononAward(energy, chrononMultiplier(to)) -
    chrononAward(energy, chrononMultiplier(from))
  );
}
