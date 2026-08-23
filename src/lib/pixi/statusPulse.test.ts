/**
 * The breathing curve, and the ranking the two rates encode.
 *
 * These are pinned because they are the whole of what the animation *means*.
 * A pulse that starts at its trough looks like a rendering glitch on the frame
 * a building lands; one that dips below its floor washes the sprite out
 * entirely; and if idle ever became the faster or deeper of the two, the board
 * would be shouting about the cheaper problem.
 */
import { describe, expect, it } from "vitest";
import { pulseAlpha, STATUS_PULSE, type Pulse } from "./statusPulse";

const IDLE = STATUS_PULSE.idle!;
const STARVED = STATUS_PULSE.starved!;

describe("pulseAlpha", () => {
  it("starts at full opacity, so a new building fades in rather than blinking on", () => {
    for (const pulse of [IDLE, STARVED]) {
      expect(pulseAlpha(0, pulse)).toBeCloseTo(1, 10);
    }
  });

  it("reaches exactly its floor at the half cycle", () => {
    for (const pulse of [IDLE, STARVED]) {
      expect(pulseAlpha(pulse.periodMs / 2, pulse)).toBeCloseTo(
        pulse.minAlpha,
        10,
      );
    }
  });

  it("returns to full opacity after one period", () => {
    for (const pulse of [IDLE, STARVED]) {
      expect(pulseAlpha(pulse.periodMs, pulse)).toBeCloseTo(1, 10);
      expect(pulseAlpha(pulse.periodMs * 7, pulse)).toBeCloseTo(1, 10);
    }
  });

  it("never leaves [floor, 1] — a sprite can be dimmed, never erased", () => {
    for (const pulse of [IDLE, STARVED]) {
      for (let t = 0; t <= pulse.periodMs * 3; t += 7) {
        const alpha = pulseAlpha(t, pulse);
        expect(alpha).toBeGreaterThanOrEqual(pulse.minAlpha - 1e-12);
        expect(alpha).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  it("is smooth — no step between adjacent frames at 60fps", () => {
    // The eye reads a jump as a stutter. At 16ms steps the deepest, fastest
    // pulse must still move by only a few percent per frame.
    let biggest = 0;
    for (let t = 0; t < STARVED.periodMs; t += 16) {
      biggest = Math.max(
        biggest,
        Math.abs(pulseAlpha(t + 16, STARVED) - pulseAlpha(t, STARVED)),
      );
    }
    expect(biggest).toBeLessThan(0.1);
  });
});

describe("the two rates rank the two problems", () => {
  it("only failing buildings breathe", () => {
    // `active` absent rather than a no-op entry: a working board is completely
    // still, which is what makes movement on it mean something.
    expect(Object.keys(STATUS_PULSE).sort()).toEqual(["idle", "starved"]);
    expect(STATUS_PULSE.active).toBeUndefined();
  });

  it("overheating pulses faster and deeper than idle", () => {
    // Overheating is shut down and costing its cluster output; idle is only
    // wasted money and must not compete with it for attention.
    expect(STARVED.periodMs).toBeLessThan(IDLE.periodMs);
    expect(STARVED.minAlpha).toBeLessThan(IDLE.minAlpha);
  });

  it("keeps both buildings legible at their dimmest", () => {
    // A pad that fades far enough to read as empty ground would lose the
    // building it is describing.
    for (const pulse of [IDLE, STARVED] as Pulse[]) {
      expect(pulse.minAlpha).toBeGreaterThanOrEqual(0.3);
    }
  });
});
