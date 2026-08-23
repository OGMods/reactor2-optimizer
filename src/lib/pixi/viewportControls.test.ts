/**
 * Regression tests for the gesture rules that are invisible until they are
 * wrong: a pinch that ends with one finger still down, two fingers moving
 * together, a gesture that finishes somewhere other than the canvas, and the
 * four things the board does under its own power.
 *
 * `ViewportControls` imports nothing from PixiJS but a type, so it is driven
 * here through hand-rolled stand-ins for the wrapper and the container — and
 * driven exactly the way a browser drives it, by firing at the listeners
 * `attach()` registered rather than by reaching for private methods.
 *
 * `performance.now()` is faked throughout: velocity is sampled from it, so
 * synthetic moves dispatched in the same real millisecond would otherwise
 * register as either infinitely fast or not moving at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Container } from "pixi.js";
import { ViewportControls } from "./viewportControls";

const VIEW_W = 800;
const VIEW_H = 600;

/**
 * A board twice the viewport in each axis, so there is somewhere to pan to.
 *
 * The figures asserted below follow from it: it fits at 0.46, framed at
 * (32, 24), and may be dragged within x [-586, 650], y [-414, 462].
 */
const BOARD = { x: 0, y: 0, width: 1600, height: 1200 };

const FIT_SCALE = 0.46;
const FRAMED = { x: 32, y: 24 };
const MAX_X = 650;
const MIN_X = -586;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function makeWrapper() {
  const listeners = new Map<string, Set<(e: PointerEvent) => void>>();
  const captured = new Set<number>();

  const el = {
    addEventListener(type: string, fn: (e: PointerEvent) => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: (e: PointerEvent) => void) {
      listeners.get(type)?.delete(fn);
    },
    // 1:1 with the stage, so client pixels and stage pixels are the same and
    // the arithmetic below is readable.
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: VIEW_W,
      height: VIEW_H,
    }),
    clientWidth: VIEW_W,
    clientHeight: VIEW_H,
    setPointerCapture(id: number) {
      captured.add(id);
    },
    releasePointerCapture(id: number) {
      captured.delete(id);
    },
  };

  const fire = (type: string, e: PointerEvent) =>
    listeners.get(type)?.forEach((fn) => fn(e));

  return { el, fire, captured };
}

/**
 * Bounds of zero size are what switch `panRange` off — it returns null on an
 * empty board, and with it every limit, the resistance and the bounce. That is
 * the right default for the tests about pan and pinch arithmetic, which would
 * only be obscured by clamping.
 */
function makeContainer(bounds: Bounds) {
  const c = {
    x: 0,
    y: 0,
    scaleValue: 1,
    boundsReads: 0,
    scale: {
      set(v: number) {
        c.scaleValue = v;
      },
    },
    getLocalBounds: () => {
      c.boundsReads++;
      return bounds;
    },
  };
  return c;
}

function setup(
  bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 },
  options: { minScale?: number; maxScale?: number } = {},
) {
  const wrapper = makeWrapper();
  const container = makeContainer(bounds);
  const controls = new ViewportControls({
    canvasWrapper: wrapper.el as unknown as HTMLDivElement,
    gridContainer: container as unknown as Container,
    getAppWidth: () => VIEW_W,
    getAppHeight: () => VIEW_H,
    ...options,
  });
  controls.attach();
  return { ...wrapper, container, controls };
}

const ptr = (pointerId: number, clientX: number, clientY: number) =>
  ({ pointerId, clientX, clientY, button: 0 }) as unknown as PointerEvent;

const wheel = (
  deltaY: number,
  extra: { deltaX?: number; deltaMode?: number; ctrlKey?: boolean } = {},
) =>
  ({
    deltaY,
    deltaX: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    clientX: 400,
    clientY: 300,
    preventDefault() {},
    ...extra,
  }) as unknown as PointerEvent;

/** Runs the board's own motion to a standstill. */
function settle(controls: ViewportControls, frames = 400) {
  for (let i = 0; i < frames; i++) controls.tick(16);
}

/** One tap: down and up in the same place, with no drag between them. */
function tap(
  fire: (type: string, e: PointerEvent) => void,
  x: number,
  y: number,
) {
  fire("pointerdown", ptr(1, x, y));
  fire("pointerup", ptr(1, x, y));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ViewportControls gestures", () => {
  it("keeps panning from where the pinch left the board", () => {
    const { fire, container } = setup();

    fire("pointerdown", ptr(1, 100, 100));
    fire("pointerdown", ptr(2, 300, 100));

    // Spread the fingers about their midpoint: 200px apart -> 300px, so 1.5x.
    fire("pointermove", ptr(1, 50, 100));
    fire("pointermove", ptr(2, 350, 100));

    expect(container.scaleValue).toBeCloseTo(1.5);
    expect(container.x).toBeCloseTo(-100);
    expect(container.y).toBeCloseTo(-50);

    // One finger leaves; the other drags 10px right.
    fire("pointerup", ptr(2, 350, 100));
    fire("pointermove", ptr(1, 60, 100));

    // Continues from where the pinch ended. Before the re-anchor this resolved
    // against finger 1's *pre-pinch* origin and snapped to (-40, 0).
    expect(container.x).toBeCloseTo(-90);
    expect(container.y).toBeCloseTo(-50);
  });

  it("pans when two fingers move together without changing distance", () => {
    const { fire, container } = setup();

    fire("pointerdown", ptr(1, 100, 100));
    fire("pointerdown", ptr(2, 300, 100));

    // Both fingers move by (50, 50); the distance between them is unchanged.
    fire("pointermove", ptr(1, 150, 150));
    fire("pointermove", ptr(2, 350, 150));

    expect(container.scaleValue).toBeCloseTo(1);
    // Not (0, 0): anchoring on the current midpoint cancels the zoom pivot
    // out, and nothing moves.
    expect(container.x).toBeCloseTo(50);
    expect(container.y).toBeCloseTo(50);
  });

  it("pans after a pinch whose first press was handled by a tile", () => {
    const { fire, controls, container } = setup();

    // A press a tool claimed: no pan begins, so nothing is "panning" when the
    // second finger lands. Lifting it has to start one on the survivor anyway.
    controls.notifyTileClick();
    fire("pointerdown", ptr(1, 100, 100));
    fire("pointerdown", ptr(2, 300, 100));
    fire("pointerup", ptr(2, 300, 100));

    const before = container.x;
    fire("pointermove", ptr(1, 150, 100));
    expect(container.x).toBeCloseTo(before + 50);
  });

  it("captures the pointer so a gesture can finish off the canvas", () => {
    const { fire, captured, controls } = setup();

    fire("pointerdown", ptr(1, 100, 100));
    expect(captured.has(1)).toBe(true);

    fire("pointerup", ptr(1, 140, 140));
    expect(controls.getActivePointerCount()).toBe(0);
  });

  it("forgets a pointer whose capture was lost without a pointerup", () => {
    const { fire, controls } = setup();

    fire("pointerdown", ptr(1, 100, 100));
    fire("lostpointercapture", ptr(1, 100, 100));

    // Otherwise the next single touch is read as the second finger of a pinch.
    expect(controls.getActivePointerCount()).toBe(0);
  });

  it("re-anchors on the remaining pair when a third finger lifts", () => {
    const { fire, container } = setup();

    fire("pointerdown", ptr(1, 100, 100));
    fire("pointerdown", ptr(2, 300, 100));
    fire("pointerdown", ptr(3, 500, 100));

    // Pointer 1 leaves: the live pair is now 2 and 3, 200px apart.
    fire("pointerup", ptr(1, 100, 100));

    const before = { x: container.x, y: container.y };
    // Hold that pair exactly still. A stale anchor from the 1-2 pair would
    // move the board on this frame.
    fire("pointermove", ptr(2, 300, 100));

    expect(container.x).toBeCloseTo(before.x);
    expect(container.y).toBeCloseTo(before.y);
    expect(container.scaleValue).toBeCloseTo(1);
  });
});

describe("ViewportControls zoom limits", () => {
  it("floors the zoom-out at a fraction of the framed scale", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);
    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);

    // Far more zoom-out than the range holds.
    for (let i = 0; i < 40; i++) fire("wheel", wheel(500));

    // Half the fit, not the absolute 0.15 floor: past the fit there is nothing
    // further to bring into view.
    expect(container.scaleValue).toBeCloseTo(FIT_SCALE * 0.5);
  });

  it("lets a small board reach its own fit above the flat ceiling", () => {
    // Fits at 7.36, well past the absolute 3.5.
    const { controls, container } = setup({
      x: 0,
      y: 0,
      width: 100,
      height: 60,
    });
    controls.recenter(4, 4);

    expect(container.scaleValue).toBeGreaterThan(3.5);
    expect(container.scaleValue).toBeCloseTo(7.36);
  });
});

describe("ViewportControls framing", () => {
  it("centres the board in the band an inset leaves, not in the window", () => {
    const { controls, container } = setup(BOARD);

    // 200px of chrome across the top — a phone's full-bleed readout.
    controls.recenter(20, 20, { top: 200 });

    // The board's own centre lands on the middle of the *band* (y 200..600),
    // which is 400 — not on the middle of the window, which is 300.
    const boardCentreY = container.y + 600 * container.scaleValue;
    expect(boardCentreY).toBeCloseTo(400);
    // And it is sized to the band, so it fits under the chrome rather than
    // behind it.
    expect(container.y).toBeGreaterThan(200);
  });

  it("ignores an inset that would leave a sliver", () => {
    const { controls, container } = setup(BOARD);

    // 400 of 600 is more than `MIN_BAND` allows; a board framed inside the
    // remainder is worse than one framed in the whole window.
    controls.recenter(20, 20, { top: 400 });

    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);
    expect(container.y).toBeCloseTo(FRAMED.y);
  });
});

describe("ViewportControls wheel", () => {
  it("reads a line-mode wheel in lines, not pixels", () => {
    const pixels = setup(BOARD);
    pixels.controls.recenter(20, 20);
    // Chrome's notch: 100 pixels.
    pixels.fire("wheel", wheel(-100));

    const lines = setup(BOARD);
    lines.controls.recenter(20, 20);
    // Firefox's notch for the same physical scroll: 6 lines.
    lines.fire("wheel", wheel(-6, { deltaMode: 1 }));

    // Within a hair of each other. Read as pixels, the line-mode event moved
    // the scale by about a thirtieth of what it should have.
    expect(lines.container.scaleValue).toBeCloseTo(
      pixels.container.scaleValue,
      2,
    );
    expect(lines.container.scaleValue).toBeGreaterThan(FIT_SCALE);
  });

  it("pans on a wheel event carrying a horizontal component", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    // Only a trackpad swipe or a tilt wheel reports deltaX; a mouse wheel
    // reports zero, which is what makes this unambiguous.
    fire("wheel", wheel(20, { deltaX: 40 }));

    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);
    expect(container.x).toBeCloseTo(FRAMED.x - 40);
    expect(container.y).toBeCloseTo(FRAMED.y - 20);
  });

  it("zooms on a plain vertical wheel", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    fire("wheel", wheel(-100));

    // The board's existing convention, and every map's: a mouse wheel zooms.
    expect(container.scaleValue).toBeGreaterThan(FIT_SCALE);
  });

  it("zooms on ctrl+wheel even when it carries a horizontal component", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    // What the browser synthesises for a trackpad pinch.
    fire("wheel", wheel(-100, { deltaX: 40, ctrlKey: true }));

    expect(container.scaleValue).toBeGreaterThan(FIT_SCALE);
  });
});

describe("ViewportControls overscroll", () => {
  it("resists a drag past the edge instead of stopping dead", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    fire("pointerdown", ptr(1, 400, 300));
    fire("pointermove", ptr(1, 2400, 300));

    // It goes past the limit — a hard stop reads as the gesture breaking —
    // but by a third of the overshoot, not all of it.
    expect(container.x).toBeGreaterThan(MAX_X);
    expect(container.x).toBeCloseTo(MAX_X + (FRAMED.x + 2000 - MAX_X) * 0.35);
  });

  it("eases back inside the limits once the finger lifts", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    fire("pointerdown", ptr(1, 400, 300));
    fire("pointermove", ptr(1, 2400, 300));
    // Held still before the release, so there is no throw in it.
    vi.advanceTimersByTime(200);
    fire("pointerup", ptr(1, 2400, 300));

    const overscrolled = container.x;
    controls.tick(16);
    // Travels back rather than snapping.
    expect(container.x).toBeLessThan(overscrolled);
    expect(container.x).toBeGreaterThan(MAX_X);

    settle(controls);
    expect(container.x).toBeCloseTo(MAX_X);
  });

  it("snaps home instead of easing when animation is off", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);
    controls.setAnimated(false);

    fire("pointerdown", ptr(1, 400, 300));
    fire("pointermove", ptr(1, 2400, 300));
    fire("pointerup", ptr(1, 2400, 300));

    controls.tick(16);
    expect(container.x).toBeCloseTo(MAX_X);
  });
});

describe("ViewportControls glide", () => {
  it("carries on after a flick and comes to rest inside the limits", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    fire("pointerdown", ptr(1, 400, 300));
    vi.advanceTimersByTime(16);
    fire("pointermove", ptr(1, 384, 300));
    vi.advanceTimersByTime(16);
    fire("pointermove", ptr(1, 368, 300));
    fire("pointerup", ptr(1, 368, 300));

    const released = container.x;
    expect(released).toBeCloseTo(FRAMED.x - 32);

    controls.tick(16);
    expect(container.x).toBeLessThan(released);

    settle(controls);
    // The throw carried it much further than the 32px the finger moved.
    expect(container.x).toBeLessThan(released - 100);
    expect(container.x).toBeGreaterThanOrEqual(MIN_X);

    // And it has actually stopped.
    const resting = container.x;
    settle(controls, 10);
    expect(container.x).toBeCloseTo(resting);
  });

  it("does not throw the board when the drag ends in a pause", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    fire("pointerdown", ptr(1, 400, 300));
    vi.advanceTimersByTime(16);
    fire("pointermove", ptr(1, 368, 300));
    // The finger rests before lifting: a deliberate end, not a flick.
    vi.advanceTimersByTime(200);
    fire("pointerup", ptr(1, 368, 300));

    const released = container.x;
    settle(controls);
    expect(container.x).toBeCloseTo(released);
  });

  it("does not glide when animation is off", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);
    controls.setAnimated(false);

    fire("pointerdown", ptr(1, 400, 300));
    vi.advanceTimersByTime(16);
    fire("pointermove", ptr(1, 384, 300));
    vi.advanceTimersByTime(16);
    fire("pointermove", ptr(1, 368, 300));
    fire("pointerup", ptr(1, 368, 300));

    const released = container.x;
    settle(controls);
    expect(container.x).toBeCloseTo(released);
  });

  it("stops the glide the moment the board is touched again", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    fire("pointerdown", ptr(1, 400, 300));
    vi.advanceTimersByTime(16);
    fire("pointermove", ptr(1, 384, 300));
    vi.advanceTimersByTime(16);
    fire("pointermove", ptr(1, 368, 300));
    fire("pointerup", ptr(1, 368, 300));

    controls.tick(16);
    fire("pointerdown", ptr(2, 200, 300));
    const caught = container.x;

    settle(controls);
    expect(container.x).toBeCloseTo(caught);
  });
});

describe("ViewportControls idling", () => {
  it("reads nothing from the board while it is at rest", () => {
    const { controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    settle(controls, 5);
    const before = container.boundsReads;
    settle(controls, 60);

    /*
     * `getLocalBounds` is cached in Pixi but still walks every tile node to
     * find out whether the cache holds, and this runs on every frame the app
     * draws. A board nobody is touching must not pay for the bounce it does
     * not owe.
     */
    expect(container.boundsReads).toBe(before);
  });

  it("still bounces a board that does owe one", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    fire("pointerdown", ptr(1, 400, 300));
    fire("pointermove", ptr(1, 2400, 300));
    vi.advanceTimersByTime(200);
    fire("pointerup", ptr(1, 2400, 300));

    settle(controls);
    expect(container.x).toBeCloseTo(MAX_X);
  });
});

describe("ViewportControls double-tap", () => {
  it("zooms in about the tapped point", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    // The world point sitting under the tap before the zoom.
    const world = (400 - container.x) / container.scaleValue;

    tap(fire, 400, 300);
    vi.advanceTimersByTime(50);
    tap(fire, 400, 300);

    settle(controls);

    expect(container.scaleValue).toBeCloseTo(FIT_SCALE * 2);
    // Still under the tap afterwards, which is what "about that point" means.
    expect((400 - container.x) / container.scaleValue).toBeCloseTo(world);
  });

  it("returns to the framed view when tapped at full zoom", () => {
    // A ceiling equal to the fit, so the board starts fully zoomed in.
    const { fire, controls, container } = setup(BOARD, {
      maxScale: FIT_SCALE,
    });
    controls.recenter(20, 20);

    // Drag it off-centre first, so returning is observable.
    fire("pointerdown", ptr(1, 400, 300));
    fire("pointermove", ptr(1, 300, 300));
    vi.advanceTimersByTime(200);
    fire("pointerup", ptr(1, 300, 300));
    expect(container.x).toBeCloseTo(FRAMED.x - 100);

    vi.advanceTimersByTime(50);
    tap(fire, 400, 300);
    vi.advanceTimersByTime(50);
    tap(fire, 400, 300);

    settle(controls);

    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);
    expect(container.x).toBeCloseTo(FRAMED.x);
    expect(container.y).toBeCloseTo(FRAMED.y);
  });

  it("ignores two taps that are too far apart in time", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    tap(fire, 400, 300);
    vi.advanceTimersByTime(600);
    tap(fire, 400, 300);

    settle(controls);
    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);
  });

  it("ignores two taps that land far apart", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    tap(fire, 400, 300);
    vi.advanceTimersByTime(50);
    tap(fire, 600, 300);

    settle(controls);
    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);
  });

  it("does not zoom when the taps are placing buildings", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    /*
     * A tile handling the press is what tells the viewport this gesture is an
     * edit. `startPan` is never reached, so the double-tap is never armed —
     * which is the whole reason it is armed there and not in `pointerdown`.
     */
    controls.notifyTileClick();
    tap(fire, 400, 300);
    vi.advanceTimersByTime(50);
    controls.notifyTileClick();
    tap(fire, 400, 300);

    settle(controls);
    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);
  });

  it("reports another finger by id, not by count", () => {
    const { fire, controls } = setup();

    /*
     * The tile handler asks this *before* its own press is registered here, so
     * a count cannot answer it — the second finger of a pinch sees a count of
     * one and would pass a `> 1` guard. By id the answer holds whatever ran
     * first.
     */
    expect(controls.hasOtherPointer(1)).toBe(false);

    fire("pointerdown", ptr(1, 100, 100));
    expect(controls.hasOtherPointer(1)).toBe(false);
    expect(controls.hasOtherPointer(2)).toBe(true);

    fire("pointerup", ptr(1, 100, 100));
    expect(controls.hasOtherPointer(2)).toBe(false);
  });

  it("pans a press that a tile is also going to edit", () => {
    const { fire, controls, container } = setup();

    // What the canvas does for a touch press with an edit armed: the tile
    // claims the press and starts the pan itself, so one finger still moves
    // the board while a building is selected.
    controls.notifyTileClick();
    const down = ptr(1, 400, 300);
    controls.startPan(down, false);
    fire("pointerdown", down);

    fire("pointermove", ptr(1, 460, 340));

    expect(container.x).toBeCloseTo(60);
    expect(container.y).toBeCloseTo(40);
  });

  it("gives up the drag when a press turns into a brush", () => {
    const { fire, controls, container } = setup();

    controls.notifyTileClick();
    const down = ptr(1, 400, 300);
    controls.startPan(down, false);
    fire("pointerdown", down);

    // Inside the slop, before the hold: still a pan.
    fire("pointermove", ptr(1, 406, 300));
    expect(container.x).toBeCloseTo(6);

    // The hold elapses. The finger is a brush now, so the rest of the gesture
    // must leave the board where it is.
    controls.cancelPan();

    fire("pointermove", ptr(1, 600, 500));
    expect(container.x).toBeCloseTo(6);
    expect(container.y).toBeCloseTo(0);

    // And the release must not fling a board that was being painted on.
    fire("pointerup", ptr(1, 600, 500));
    settle(controls);
    expect(container.x).toBeCloseTo(6);
  });

  it("does not zoom on two taps that pan-and-edit", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);

    // Two placements on the same tile land well inside the double-tap window
    // and slop, so the edit press must pass `armDoubleTap: false`.
    const edit = (x: number, y: number) => {
      controls.notifyTileClick();
      const down = ptr(1, x, y);
      controls.startPan(down, false);
      fire("pointerdown", down);
      fire("pointerup", ptr(1, x, y));
    };

    edit(400, 300);
    vi.advanceTimersByTime(50);
    edit(400, 300);

    settle(controls);
    expect(container.scaleValue).toBeCloseTo(FIT_SCALE);
  });

  it("lands immediately when animation is off", () => {
    const { fire, controls, container } = setup(BOARD);
    controls.recenter(20, 20);
    controls.setAnimated(false);

    tap(fire, 400, 300);
    vi.advanceTimersByTime(50);
    tap(fire, 400, 300);

    // No tick: with animation off there is nothing to play out.
    expect(container.scaleValue).toBeCloseTo(FIT_SCALE * 2);
  });
});
