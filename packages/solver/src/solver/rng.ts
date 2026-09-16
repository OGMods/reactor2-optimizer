/**
 * Deterministic, portable PRNG for the solver's stochastic stages.
 *
 * `Math.random()` is not seedable, and a golden fixture is worth nothing if the
 * stream behind it cannot be reproduced. mulberry32 is the generator, and
 * `tests/rng.parity.test.ts` pins the first outputs of five seeds as exact
 * doubles against the canonical JS implementation.
 *
 * Those goldens are a contract, not a snapshot: if one fails, the drift is in
 * this file. Fix it here — never re-record them from what this happens to
 * produce, because every fixture in the suite is downstream of this stream.
 *
 * `choice`/`shuffle` derive indices via `Math.floor(random() * n)` rather than
 * modulo, which is what keeps the mapping from stream to index uniform.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.random() * n);
  }

  choice<T>(seq: readonly T[]): T {
    return seq[Math.floor(this.random() * seq.length)];
  }

  /** Fisher-Yates, consuming one draw per element after the first. */
  shuffle<T>(seq: T[]): void {
    for (let i = seq.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const tmp = seq[i];
      seq[i] = seq[j];
      seq[j] = tmp;
    }
  }
}

/** A fresh 32-bit seed, for when the caller did not pin one. */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}
