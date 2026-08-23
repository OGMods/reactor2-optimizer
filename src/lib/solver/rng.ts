/**
 * Deterministic, portable PRNG for the solver's stochastic stages.
 *
 * `Math.random()` is not seedable, and the Python reference implementation
 * (`solver/rng.py`) needs to produce the *same* stream so a seeded run can be
 * replayed across the two languages. mulberry32 is the shared generator: every
 * operation below maps 1:1 onto Python's int32/uint32 masking, so both sides
 * emit bit-identical floats for the same seed.
 *
 * `choice`/`shuffle` derive indices via `Math.floor(random() * n)` rather than
 * modulo, matching the Python side's `int(random() * n)`.
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
