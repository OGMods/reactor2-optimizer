import type { Candidate } from "./report";

/**
 * The top `limit` distinct layouts, best first.
 *
 * Distinct by `blueprintKey` — the uncompressed payload, never the code:
 * DEFLATE is only required to round-trip, so equal boards can have unequal
 * codes.
 *
 * Ties rank by arrival, not by attempt number. Attempts run concurrently and
 * land out of order, so "the attempt that found it first" is not something the
 * session knows; what it does know is which layout it saw first.
 */
export class Leaderboard {
  #entries: { arrival: number; candidate: Candidate }[] = [];
  #seen = new Set<string>();
  #arrivals = 0;

  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get entries(): Candidate[] {
    return this.#entries.map((e) => e.candidate);
  }

  get best(): Candidate | undefined {
    return this.#entries[0]?.candidate;
  }

  /** Files a layout; returns true if it took first place. */
  offer(candidate: Candidate): boolean {
    if (this.#seen.has(candidate.key)) return false;
    this.#seen.add(candidate.key);

    this.#entries.push({ arrival: ++this.#arrivals, candidate });
    this.#entries.sort(
      (a, b) => b.candidate.power - a.candidate.power || a.arrival - b.arrival,
    );
    for (const dropped of this.#entries.slice(this.#limit))
      this.#seen.delete(dropped.candidate.key);
    this.#entries.length = Math.min(this.#entries.length, this.#limit);

    return this.#entries[0]?.candidate.key === candidate.key;
  }
}
