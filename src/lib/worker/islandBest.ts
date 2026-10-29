import {
  cheapestFirst,
  isDistinctLayout,
  powerTies,
  MAX_ALTERNATES,
} from "@reactor2/solver";
import type { IslandSolution } from "@reactor2/solver";
import type { IslandLayout, PlacedBuilding } from "@reactor2/solver";

/**
 * The answer for one island, gathered from however many attempts it was given.
 *
 * A multi-attempt run solves each island several times over, from independent
 * random streams, and this is what decides which of those searches the board
 * ends up showing. Three readings, and they are the same three the app already
 * applies to a whole re-run (`chooseSolveVariants`) — deliberately, because a
 * player should not have to hold two different notions of "the better layout":
 *
 * - **higher power** — the new attempt replaces what was held, shortlist and
 *   all. The layouts it beat were answers to the same question and they lost.
 * - **the same power** — both attempts are right, so their layouts are pooled.
 *   This is where a deep run earns its shortlist: one 10s walk rarely finds
 *   ten distinct tied arrangements, but ten of them together often do, and
 *   which arrangement is nicest to actually build is a judgement the solver
 *   cannot make.
 * - **lower power** — ignored outright.
 *
 * The first attempt to land always sets the bar, whatever it scored: an island
 * with no cooler in the roster genuinely solves to zero power and an empty
 * board, and that is its answer rather than a placeholder to be improved on.
 *
 * Layouts are pooled under the same distance rule one search applies to its
 * own shortlist (`MIN_ALTERNATE_DISTANCE`), so two attempts converging on the
 * same arrangement — common, and the usual case on a small island — count
 * once, and so do two that converged a tile apart.
 *
 * **Cheapest first.** Everything held ties on power, so the pool is kept
 * ordered by `cheapestFirst` and its head is the primary: an attempt that
 * found the same power for less takes the island over, and once the shortlist
 * is full a cheaper newcomer pushes out the dearest entry. A later attempt is
 * still judged against the best power any attempt reached, not the primary's:
 * a tie may sit a hair below the bar, and measuring from the cheapest would let
 * the island's figure creep down one tolerance at a time.
 */
export class IslandBest {
  #primary: IslandLayout = { placements: [], powerOutput: 0 };
  #alternates: IslandLayout[] = [];
  /** The primary and every alternate kept, for the distance test. */
  #kept: PlacedBuilding[][] = [];
  #settled = false;
  /** The best power any attempt reached — the bar the next one is held to. */
  #bar = 0;
  readonly #limit: number;

  /** `limit` caps the alternates kept, matching what one search would keep. */
  constructor(limit: number = MAX_ALTERNATES) {
    this.#limit = limit;
  }

  /** What this island contributes to the board: its best layout and its ties. */
  get solution(): IslandSolution {
    return {
      placements: this.#primary.placements,
      powerOutput: this.#primary.powerOutput,
      alternates: this.#alternates,
    };
  }

  /** True once an attempt has actually reported. */
  get settled(): boolean {
    return this.#settled;
  }

  /**
   * Files a **finished** attempt.
   *
   * Progress snapshots deliberately do not come here: a report from a search
   * still moving is not an answer, and its runners-up are not ties. The
   * coordinator streams those to the screen on a separate track.
   */
  offer(candidate: IslandSolution): void {
    const ties = this.#settled && powerTies(candidate.powerOutput, this.#bar);

    if (ties) {
      this.#bar = Math.max(this.#bar, candidate.powerOutput);
    } else {
      if (this.#settled && candidate.powerOutput <= this.#bar) return;
      this.#settled = true;
      this.#bar = candidate.powerOutput;
      this.#primary = {
        placements: candidate.placements,
        powerOutput: candidate.powerOutput,
      };
      this.#alternates = [];
      this.#kept = [candidate.placements];
    }

    // On a tie the candidate's own primary is one more arrangement at this
    // power, so it joins the alternates rather than being dropped as a
    // duplicate of the winner it did not displace.
    const incoming = ties
      ? [
          {
            placements: candidate.placements,
            powerOutput: candidate.powerOutput,
          },
          ...(candidate.alternates ?? []),
        ]
      : (candidate.alternates ?? []);

    const pool = [this.#primary, ...this.#alternates];
    for (const layout of incoming) {
      if (!isDistinctLayout(layout.placements, this.#kept)) continue;
      this.#kept.push(layout.placements);
      pool.push(layout);
    }
    const ranked = cheapestFirst(pool, (l) => l.placements).slice(
      0,
      this.#limit + 1,
    );
    this.#primary = ranked[0];
    this.#alternates = ranked.slice(1);
    this.#kept = ranked.map((l) => l.placements);
  }
}
