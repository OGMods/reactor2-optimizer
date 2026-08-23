import { EPS } from "./constants";
import type { PlacedBuilding, Placement } from "./types";

/**
 * Collects the *other* layouts a search walked past at its best power.
 *
 * TS-only: the Python reference solves for one layout and prints it, so it has
 * no use for this and no peer file (see docs/PARITY.md). It exists because a player
 * does not want "the" answer so much as a shortlist — several arrangements
 * usually tie at the top, and which of them is nicest to build is a judgement
 * the solver cannot make.
 *
 * It is a **passive observer**: it reads layouts the walk offers it and changes
 * no number the search produces. Nothing here may feed back into the search.
 *
 * Two rules it inherits from the search proper:
 *
 * - Only **stable** layouts are ever offered (see the stability rule in
 *   `placementSearch.ts`). An alternate has to be as buildable as the primary.
 * - Ties are compared with a **relative** tolerance rather than the solver's
 *   absolute `EPS`. Two arrangements of the same multiset sum their power in
 *   tile order, so they can differ in the last bits while being the same
 *   answer; at the millions these layouts produce, `EPS` would call that a
 *   difference and every alternate would be thrown away.
 *
 * And one rule of its own: an entry has to be a **materially different board**,
 * not merely a different one — see `MIN_ALTERNATE_DISTANCE`.
 */

/** How many tied layouts one island keeps. */
export const MAX_ALTERNATES = 10;

/**
 * Relative slack for "the same power". Doubles carry ~1e-16 of relative
 * precision and a board sums a few hundred terms, so this is orders of
 * magnitude above the noise and far below anything the UI prints.
 */
const TIE_RELATIVE_TOLERANCE = 1e-9;

/**
 * How many tiles two layouts must disagree on before they count as different
 * answers rather than the same answer twice.
 *
 * Deduplicating by shape alone is technically correct and practically useless:
 * a walk that has converged spends most of its time swapping one cooler for
 * another cooler on the same tile, so ten "distinct" layouts came back as ten
 * near-copies of one board and cycling through them looked like a rendering
 * glitch. The shortlist exists so the player can pick the arrangement that is
 * nicest to build, and that choice only means something between boards that
 * are laid out differently.
 *
 * The measure is the number of **tiles whose occupant differs** (an empty tile
 * counts as an occupant), so a one-tile substitution is 1, relocating one
 * building is 2, and clearing this bar takes a genuine rearrangement.
 */
export const MIN_ALTERNATE_DISTANCE = 5;

/**
 * Whether two power figures are the same answer.
 *
 * Non-finite in means non-finite out: an empty collector holds `-Infinity`,
 * and a relative comparison against that says "tie" for every number there is.
 */
export function powerTies(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(EPS, TIE_RELATIVE_TOLERANCE * scale);
}

/**
 * Identity of a layout's *shape*: which building sits on which tile, and
 * nothing else. Two layouts with the same key are the same board however
 * differently the search arrived at them.
 */
function placementKey(placement: Placement): string {
  let key = "";
  for (let i = 0; i < placement.length; i++) {
    const b = placement[i];
    if (b !== null) key += `${i}:${b.id};`;
  }
  return key;
}

/** The same identity, for a layout that has already been turned into rows. */
export function layoutKey(rows: readonly PlacedBuilding[]): string {
  return rows
    .map((r) => `${r.x},${r.y},${r.buildingId}`)
    .sort()
    .join(";");
}

/**
 * How many tiles two layouts disagree on, counting an empty tile as an
 * occupant of its own.
 *
 * `cap` stops the count early: every caller only asks whether the distance
 * clears `MIN_ALTERNATE_DISTANCE`, and this runs inside the annealing walk.
 */
export function placementDistance(
  a: Placement,
  b: Placement,
  cap: number = Number.POSITIVE_INFINITY,
): number {
  const n = Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if ((x === null ? null : x.id) !== (y === null ? null : y.id)) {
      diff++;
      if (diff >= cap) return diff;
    }
  }
  return diff;
}

/** Tile -> building id, for a layout that has already been turned into rows. */
function rowIndex(rows: readonly PlacedBuilding[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const r of rows) index.set(`${r.x},${r.y}`, r.buildingId);
  return index;
}

/** The same measure as `placementDistance`, over rows rather than tiles. */
export function layoutDistance(
  a: readonly PlacedBuilding[],
  b: readonly PlacedBuilding[],
): number {
  const ai = rowIndex(a);
  const bi = rowIndex(b);
  let diff = 0;
  for (const [tile, id] of ai) if (bi.get(tile) !== id) diff++;
  for (const tile of bi.keys()) if (!ai.has(tile)) diff++;
  return diff;
}

/**
 * Whether a layout is far enough from every layout already kept to be worth
 * offering as a separate answer. Identical boards fall out of this for free:
 * their distance is zero.
 */
export function isDistinctLayout(
  rows: readonly PlacedBuilding[],
  kept: readonly (readonly PlacedBuilding[])[],
  minDistance: number = MIN_ALTERNATE_DISTANCE,
): boolean {
  for (const other of kept) {
    if (layoutDistance(rows, other) < minDistance) return false;
  }
  return true;
}

export class AlternateCollector {
  #power = -Infinity;
  #layouts = new Map<string, Placement>();
  readonly #limit: number;
  readonly #minDistance: number;

  constructor(
    limit: number = MAX_ALTERNATES,
    minDistance: number = MIN_ALTERNATE_DISTANCE,
  ) {
    this.#limit = limit;
    this.#minDistance = minDistance;
  }

  /**
   * True once there is nothing more to gain from offering a tie.
   *
   * The search checks this *before* testing a layout for stability, which is
   * the only per-tie cost this feature adds to the hot walk. A new best clears
   * the collector, so it goes back to false on its own.
   */
  get full(): boolean {
    return this.#layouts.size >= this.#limit;
  }

  /** The power every layout held here ties. `-Infinity` until the first offer. */
  get power(): number {
    return this.#power;
  }

  /**
   * Whether this layout would join the shortlist as it stands — the same test
   * `offer` applies, minus the power comparison.
   *
   * The walk asks this *before* it checks a tie for stability: with a distance
   * rule in force the shortlist rarely reaches `full`, so that check on its own
   * does not keep the hot path clear. This one rejects the near copies a
   * converged walk mostly produces, and it only ever reads the layout's tiles.
   */
  accepts(placement: Placement): boolean {
    if (this.#layouts.has(placementKey(placement))) return false;
    for (const held of this.#layouts.values()) {
      if (
        placementDistance(placement, held, this.#minDistance) <
        this.#minDistance
      )
        return false;
    }
    return true;
  }

  /**
   * Files a stable layout. A tie joins the shortlist; a genuinely better power
   * replaces it, because the shortlist is only ever *the best* power's layouts.
   *
   * Ties are checked before improvements on purpose: a layout a hair above the
   * recorded power is the same answer, and treating it as a new best would
   * discard the alternates already gathered for it.
   *
   * A tie also has to be `MIN_ALTERNATE_DISTANCE` tiles away from everything
   * already held. A layout that beats the shortlist empties it first, so it is
   * always kept: the bar is on being a second answer, not on being an answer.
   */
  offer(power: number, placement: Placement): void {
    if (powerTies(power, this.#power)) {
      if (this.full) return;
    } else if (power > this.#power) {
      this.#layouts.clear();
      this.#power = power;
    } else {
      return;
    }

    if (!this.accepts(placement)) return;
    this.#layouts.set(placementKey(placement), placement.slice());
  }

  /** The shortlist, in the order it was gathered. */
  layouts(): Placement[] {
    return [...this.#layouts.values()];
  }
}
