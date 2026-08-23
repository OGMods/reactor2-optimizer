import type { PlacementStatus } from "../data/placements";

/**
 * How a building that is not working breathes.
 *
 * The pad under a building says *what* is wrong, in colour; this says *that*
 * something is, in motion — and motion is what the eye finds without being
 * told where to look. On a board of forty buildings the two pads that are not
 * green are easy to miss when nothing moves.
 *
 * Split out of `gridPainter.ts` so the curve can be pinned by a test: that file
 * imports PixiJS, and the arithmetic below is the part worth asserting.
 */

/** One cycle's length, and the alpha the building dips to at its trough. */
export interface Pulse {
  periodMs: number;
  minAlpha: number;
}

/**
 * The two failing states, and nothing else.
 *
 * The rates carry the same ranking the board readout's colours do. Overheating
 * is a fast, deep pulse: that building is shut down and dragging its cluster's
 * output down with it. Idle is a slow, shallow breath — it is only wasted
 * money, and it must not compete for attention with the urgent one.
 *
 * `active` is deliberately absent rather than mapped to a no-op: a board where
 * everything works is *completely* still, which is what makes any movement on
 * it mean something. It is also what keeps the ticker free in the common case —
 * the renderer's registry is empty, so there is nothing to walk.
 */
export const STATUS_PULSE: Partial<Record<PlacementStatus, Pulse>> = {
  starved: { periodMs: 900, minAlpha: 0.35 },
  idle: { periodMs: 2200, minAlpha: 0.55 },
};

/**
 * The alpha a breathing sprite should be at, `elapsedMs` into the animation.
 *
 * A raised cosine rather than a triangle or a square: the eye reads a linear
 * ramp's corners as a stutter, and a hard on/off as a fault in the renderer
 * rather than a property of the building.
 *
 * It starts at 1 and falls, so a building that has just appeared fades in from
 * full opacity rather than blinking on at its dimmest — which is what makes
 * placing a building that turns out to be idle look like a state it settles
 * into, instead of a glitch on the frame it lands.
 *
 * Every sprite is given the *same* `elapsedMs` rather than its own phase, so
 * the whole board dips in step. Staggered phases read as decoration; one
 * board-wide beat reads as a signal.
 */
export function pulseAlpha(
  elapsedMs: number,
  { periodMs, minAlpha }: Pulse,
): number {
  const wave = 0.5 + 0.5 * Math.cos((2 * Math.PI * elapsedMs) / periodMs);
  return minAlpha + (1 - minAlpha) * wave;
}
