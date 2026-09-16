import { isDistinctLayout, powerTies, MAX_ALTERNATES } from "@reactor2/solver";
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
 */
export class IslandBest {
  #primary: IslandLayout = { placements: [], powerOutput: 0 };
  #alternates: IslandLayout[] = [];
  /** The primary and every alternate kept, for the distance test. */
  #kept: PlacedBuilding[][] = [];
  #settled = false;
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
    const ties =
      this.#settled &&
      powerTies(candidate.powerOutput, this.#primary.powerOutput);

    if (!ties) {
      if (this.#settled && candidate.powerOutput <= this.#primary.powerOutput)
        return;
      this.#settled = true;
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

    for (const layout of incoming) {
      if (this.#alternates.length >= this.#limit) break;
      if (!isDistinctLayout(layout.placements, this.#kept)) continue;
      this.#kept.push(layout.placements);
      this.#alternates.push(layout);
    }
  }
}
