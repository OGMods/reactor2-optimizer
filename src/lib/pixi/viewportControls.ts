import type { Container } from "pixi.js";
import { TILE_WIDTH, TILE_HEIGHT } from "../utils/isoMath";

export interface ViewportControlsOptions {
  canvasWrapper: HTMLDivElement;
  gridContainer: Container;
  getAppWidth: () => number;
  getAppHeight: () => number;
  minScale?: number;
  maxScale?: number;
}

/** One frame at 60fps. The unit every per-frame rate below is quoted in. */
const FRAME_MS = 1000 / 60;

/**
 * The zoom-out floor, as a fraction of the scale that fits the board.
 *
 * The absolute `minScale` cannot express this: a large board on a phone fits
 * at around 0.25, so a flat floor of 0.15 left a stretch of zoom in which the
 * board only got smaller inside an already-empty frame. Everything past the
 * fit is dead travel — there is nothing beyond the board to bring into view.
 */
const MIN_ZOOM_FACTOR = 0.5;

/** What one double-tap multiplies the scale by. */
const DOUBLE_TAP_ZOOM = 2;

/** The longest gap between two taps that still reads as one double-tap. */
const DOUBLE_TAP_MS = 300;

/** How far the second tap may land from the first, in client pixels. */
const DOUBLE_TAP_SLOP_PX = 24;

/** How long the double-tap zoom takes to play out. */
const ZOOM_TWEEN_MS = 220;

/** Share of a glide's speed that survives each frame. */
const GLIDE_FRICTION = 0.95;

/** Below this speed, in stage pixels per ms, the glide stops. */
const MIN_GLIDE_SPEED = 0.015;

/**
 * A release this long after the last move has no throw in it.
 *
 * Without it, dragging somewhere, holding still and then lifting would fling
 * the board off on a velocity sampled seconds earlier — a press that ends
 * deliberately would behave like one that ends in a flick.
 */
const GLIDE_IDLE_MS = 60;

/** How much of a drag past the edge actually moves the board. */
const OVERSCROLL_RESIST = 0.35;

/** Share of the remaining overscroll given back each frame. */
const BOUNCE_RATE = 0.18;

/** Closer than this to home, the bounce simply lands. In stage pixels. */
const BOUNCE_SNAP_PX = 0.5;

/**
 * What one line of wheel delta is worth in pixels.
 *
 * Firefox reports `deltaMode: DOM_DELTA_LINE` on several platforms, where a
 * notch is about 3 rather than Chrome's ~100. Read as pixels — which is what
 * this did — the zoom came out roughly thirty times weaker there.
 */
const WHEEL_LINE_PX = 16;

interface PanRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Inset {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** Where a framing puts the board, without putting it there. */
interface Framing {
  scale: number;
  x: number;
  y: number;
  /** The fit before it was clamped — what `MIN_ZOOM_FACTOR` is measured from. */
  fit: number;
}

/** Scales a per-frame decay rate to an arbitrary elapsed time. */
function decay(perFrame: number, dtMs: number): number {
  return Math.pow(perFrame, dtMs / FRAME_MS);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Lets a value past a limit, but only by `OVERSCROLL_RESIST` of the excess. */
function resist(v: number, min: number, max: number): number {
  if (v < min) return min - (min - v) * OVERSCROLL_RESIST;
  if (v > max) return max + (v - max) * OVERSCROLL_RESIST;
  return v;
}

export class ViewportControls {
  private canvasWrapper: HTMLDivElement;
  private gridContainer: Container;
  private getAppWidth: () => number;
  private getAppHeight: () => number;

  public scale = 1;
  private minScale: number;
  private maxScale: number;

  /**
   * The scale at which the whole board fits the band the chrome leaves free,
   * as of the last framing. Zero until one has happened.
   *
   * Both zoom limits are expressed against it rather than as flat numbers, so
   * that they mean the same thing on a 60x60 island and a 4x4 one.
   */
  private fitScale = 0;

  /**
   * The arguments of the last framing, so it can be recomputed.
   *
   * Double-tapping at full zoom returns the board to exactly the view Center
   * View gives, which means knowing what that view is without disturbing the
   * current one.
   */
  private lastFraming: {
    gridWidth: number;
    gridHeight: number;
    inset: Inset;
  } | null = null;

  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private containerStart = { x: 0, y: 0 };

  /**
   * Whether the player has moved the view themselves.
   *
   * Auto-framing may re-frame the board when the chrome around it changes —
   * folding the sidebar hands back 380px, and the board should take it. But
   * the moment someone pans or zooms, that view is *theirs*: shifting it out
   * from under them because a panel moved would be the app overruling a
   * deliberate act. After that only `recenter()` — Center View — may reframe,
   * and doing so hands control back.
   */
  private userAdjusted = false;

  public get isUserAdjusted(): boolean {
    return this.userAdjusted;
  }

  private activePointers = new Map<number, PointerEvent>();
  private prevTouchDist = 0;

  /**
   * The midpoint of the two pinching fingers as of the last move, in stage
   * coordinates.
   *
   * A pinch anchors on the world point under *this* — not the one under the
   * current midpoint, which cancels algebraically to a no-op and leaves two
   * fingers zooming without panning. See `handlePointerMove`.
   */
  private prevTouchMid = { x: 0, y: 0 };
  private handledByTile = false;

  /**
   * Whether the board may move under its own power — glide, bounce and the
   * double-tap tween.
   *
   * Pushed in by `PixiCanvas` rather than read from a media query here, for
   * the same reason `GridRenderer.setAnimated` exists: the effective answer is
   * the user's Settings choice *or* `prefers-reduced-motion` when they have
   * made none, and choosing between those is the state layer's job. With it
   * off every one of these still reaches the same place, immediately.
   */
  private animated = true;

  /**
   * Whether the board is currently past its limits and owes a bounce.
   *
   * Tracked rather than tested for, so that a board at rest costs the ticker
   * nothing: `panRange` reads `getLocalBounds`, which is cached but still
   * walks every tile node to see whether the cache holds. Only two things can
   * put the board out of range — a resisted gesture and a glide — and both set
   * this; everything else hard-clamps and clears it. Same call the status
   * pulse makes: a board with nothing to do leaves the ticker alone.
   */
  private outOfBounds = false;

  /** Live velocity of the drag, in stage pixels per ms. */
  private panVelocity = { x: 0, y: 0 };
  private velocitySample = { x: 0, y: 0, at: 0 };
  private gliding = false;

  private zoomTween: {
    fromScale: number;
    toScale: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
    elapsed: number;
  } | null = null;

  /** The press that could still turn out to be the second half of a double-tap. */
  private pendingDoubleTap = false;
  private lastTapAt = 0;
  private lastTapPos = { x: 0, y: 0 };
  private tapDownPos = { x: 0, y: 0 };

  constructor(options: ViewportControlsOptions) {
    this.canvasWrapper = options.canvasWrapper;
    this.gridContainer = options.gridContainer;
    this.getAppWidth = options.getAppWidth;
    this.getAppHeight = options.getAppHeight;
    this.minScale = options.minScale ?? 0.15;
    this.maxScale = options.maxScale ?? 3.5;
  }

  public attach(): void {
    this.canvasWrapper.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });
    this.canvasWrapper.addEventListener("pointerdown", this.handlePointerDown);
    this.canvasWrapper.addEventListener("pointermove", this.handlePointerMove);
    this.canvasWrapper.addEventListener("pointerup", this.handlePointerUp);
    this.canvasWrapper.addEventListener("pointercancel", this.handlePointerUp);
    this.canvasWrapper.addEventListener(
      "lostpointercapture",
      this.handleLostCapture,
    );
  }

  public detach(): void {
    this.canvasWrapper.removeEventListener("wheel", this.handleWheel);
    this.canvasWrapper.removeEventListener(
      "pointerdown",
      this.handlePointerDown,
    );
    this.canvasWrapper.removeEventListener(
      "pointermove",
      this.handlePointerMove,
    );
    this.canvasWrapper.removeEventListener("pointerup", this.handlePointerUp);
    this.canvasWrapper.removeEventListener(
      "pointercancel",
      this.handlePointerUp,
    );
    this.canvasWrapper.removeEventListener(
      "lostpointercapture",
      this.handleLostCapture,
    );
    this.activePointers.clear();
  }

  /** Marks that a tile container intercepted the click */
  public notifyTileClick(): void {
    this.handledByTile = true;
  }

  /** See `animated`. Turning it off settles the board where it stands. */
  public setAnimated(on: boolean): void {
    this.animated = on;
    if (!on) {
      this.gliding = false;
      if (this.zoomTween) {
        this.applyFrame(this.zoomTween.toScale, this.zoomTween.to);
        this.zoomTween = null;
      }
      this.clampBounds();
    }
  }

  /**
   * Ratio between CSS/client pixels (what DOM pointer events report)
   * and stage pixels (the coordinate space gridContainer.x/y actually
   * live in). These only match when the canvas is rendered 1:1 with
   * its CSS size — if it's scaled by CSS (responsive layout, DPR,
   * etc.) they diverge, and using client pixels directly as stage
   * pixels throws off zoom pivoting and centering.
   */
  private getClientToStageScale(): { x: number; y: number } {
    const rect = this.canvasWrapper.getBoundingClientRect();
    return {
      x: rect.width ? this.getAppWidth() / rect.width : 1,
      y: rect.height ? this.getAppHeight() / rect.height : 1,
    };
  }

  /** Converts a DOM client position into stage (gridContainer) coordinates */
  private toStagePoint(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    const rect = this.canvasWrapper.getBoundingClientRect();
    const { x: scaleX, y: scaleY } = this.getClientToStageScale();
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  /** The viewport size in the same coordinate space gridContainer lives in */
  private getStageSize(): { width: number; height: number } {
    return {
      width: this.getAppWidth() || this.canvasWrapper.clientWidth,
      height: this.getAppHeight() || this.canvasWrapper.clientHeight,
    };
  }

  /**
   * The zoom-out floor actually in force: never past `MIN_ZOOM_FACTOR` of the
   * framed view, and never past the absolute floor either.
   */
  private get minZoom(): number {
    return this.fitScale > 0
      ? Math.max(this.minScale, this.fitScale * MIN_ZOOM_FACTOR)
      : this.minScale;
  }

  /**
   * The zoom-in ceiling actually in force.
   *
   * `Math.max` against the fit is not decoration: a three-tile island fits at
   * a scale well above the flat 3.5, and a ceiling below the fit would leave
   * Center View unable to reach its own framing.
   */
  private get maxZoom(): number {
    return Math.max(this.maxScale, this.fitScale);
  }

  /**
   * Where a framing would put the board — see `recenter`, which is this
   * applied. Split out because double-tapping at full zoom returns to exactly
   * this view, and has to know it without moving anything to find out.
   */
  private computeFraming(
    gridWidth: number,
    gridHeight: number,
    inset: Inset,
  ): Framing {
    const { width: wrapperWidth, height: wrapperHeight } = this.getStageSize();

    const top = inset.top ?? 0;
    const right = inset.right ?? 0;
    const bottom = inset.bottom ?? 0;
    const left = inset.left ?? 0;

    /*
     * A board framed inside a sliver is worse than one framed in the whole
     * window, so the insets are only honoured while they leave a band worth
     * aiming at. A phone in landscape with a palette ribbon open can leave
     * very little.
     */
    const MIN_BAND = 0.4;
    const bandWidth =
      wrapperWidth - left - right > wrapperWidth * MIN_BAND
        ? wrapperWidth - left - right
        : wrapperWidth;
    const bandHeight =
      wrapperHeight - top - bottom > wrapperHeight * MIN_BAND
        ? wrapperHeight - top - bottom
        : wrapperHeight;
    const bandCenterX =
      bandWidth === wrapperWidth ? wrapperWidth / 2 : left + bandWidth / 2;
    const bandCenterY =
      bandHeight === wrapperHeight ? wrapperHeight / 2 : top + bandHeight / 2;

    const bounds = this.gridContainer.getLocalBounds();

    const width = bounds?.width || (gridWidth + gridHeight) * (TILE_WIDTH / 2);
    const height =
      bounds?.height || (gridWidth + gridHeight) * (TILE_HEIGHT / 2);
    const boundsX = bounds?.x ?? 0;
    const boundsY = bounds?.y ?? 0;

    const padding = 0.92;
    const fit = Math.min(
      (bandWidth * padding) / width,
      (bandHeight * padding) / height,
    );
    /*
     * Floored, but deliberately **not** capped: a small island fits above the
     * flat `maxScale`, and a ceiling below the fit would leave Center View
     * unable to reach its own framing. `maxZoom` is what carries that across
     * to the gestures.
     */
    const scale = Math.max(this.minScale, fit);

    // Centre on the band's middle, not the window's.
    const centerX = boundsX + width / 2;
    const centerY = boundsY + height / 2;

    return {
      scale,
      fit,
      x: bandCenterX - centerX * scale,
      y: bandCenterY - centerY * scale,
    };
  }

  /**
   * Fits the board into the part of the canvas the chrome actually leaves
   * free, and centres it there.
   *
   * `inset` is that chrome, in CSS pixels: the header along the top, the HUD
   * stack along the bottom, the docked sidebar down the left. The canvas is
   * full-bleed and everything else floats over it, so without this the board
   * is fitted to — and centred in — the *whole* window. On a 390x844 phone
   * that means two faults at once: it is sized against 844px of height when
   * only 647px is ever visible, and its centre lands 30px below the centre of
   * the strip the player can see. Desktop hides the same fault behind
   * proportion, its chrome being a small fraction of a large window.
   *
   * The margin is a fraction of the *band* rather than of the window, which is
   * why it can be this tight without crowding anything: the room it leaves is
   * real room, not room the HUD is standing in.
   */
  public recenter(
    gridWidth: number,
    gridHeight: number,
    inset: Inset = {},
  ): void {
    // Reframing hands the view back to the app.
    this.userAdjusted = false;
    this.gliding = false;
    this.zoomTween = null;

    this.lastFraming = { gridWidth, gridHeight, inset };
    const framing = this.computeFraming(gridWidth, gridHeight, inset);
    this.fitScale = framing.fit;

    this.applyFrame(framing.scale, framing);
    this.clampBounds();
  }

  public getActivePointerCount(): number {
    return this.activePointers.size;
  }

  /**
   * Whether a pointer *other* than this one is already down.
   *
   * The question `getActivePointerCount` cannot answer from a tile handler.
   * Pixi binds `pointerdown` to the canvas, which is a child of the wrapper
   * these listeners are on, so a tile's handler runs a whole bubble before the
   * press it is handling is registered here — the count it reads is the state
   * *before* its own finger landed. Asked as a count, the second finger of a
   * pinch reads as `1` and passes a `> 1` guard, which is how a pinch used to
   * place a building with its second touch.
   *
   * Asked by pointer id instead, the answer does not depend on when this one
   * was registered: `true` means the press is part of a multi-touch gesture
   * whoever ran first.
   */
  public hasOtherPointer(pointerId: number): boolean {
    for (const id of this.activePointers.keys()) {
      if (id !== pointerId) return true;
    }
    return false;
  }

  /**
   * Advances everything the board does on its own: the double-tap zoom, the
   * glide after a flick, and the return from an overscroll.
   *
   * Driven by `PixiCanvas` from the app's own Pixi ticker rather than a
   * `requestAnimationFrame` loop here — Pixi is already drawing every frame,
   * so a second loop would buy nothing. Same call the status pulse makes.
   */
  public tick(dtMs: number): void {
    if (!(dtMs > 0)) return;

    // A finger on the board outranks all three: it is being moved by hand.
    if (this.activePointers.size > 0) return;

    if (this.zoomTween) {
      this.advanceZoomTween(dtMs);
      return;
    }
    if (this.gliding) this.advanceGlide(dtMs);
    if (this.outOfBounds) this.settle(dtMs);
  }

  /**
   * A wheel event's deltas in pixels, whatever unit the browser quoted them
   * in. See `WHEEL_LINE_PX`.
   */
  private wheelDeltaPx(e: WheelEvent): { x: number; y: number } {
    const unit =
      e.deltaMode === 1
        ? WHEEL_LINE_PX
        : e.deltaMode === 2
          ? this.getStageSize().height
          : 1;
    return { x: (e.deltaX || 0) * unit, y: (e.deltaY || 0) * unit };
  }

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.gliding = false;
    this.zoomTween = null;

    const delta = this.wheelDeltaPx(e);

    /*
     * Whether a wheel event means zoom or pan, which the event itself cannot
     * quite say.
     *
     * A vertical-only wheel stays a **zoom**, which is the convention this
     * board already had and the one every map on the web uses — changing it
     * would take mouse-wheel zoom away from every desktop user to fix
     * something only trackpad users see.
     *
     * The two cases that are not ambiguous are handled: the browser
     * synthesises `ctrlKey` for a trackpad *pinch*, so that always zooms; and
     * a horizontal component can only come from a trackpad swipe or a tilt
     * wheel, since a mouse wheel reports `deltaX` of zero — so an event
     * carrying one is a two-axis scroll and pans.
     */
    if (!e.ctrlKey && !e.metaKey && delta.x !== 0) {
      this.userAdjusted = true;
      this.gridContainer.x -= delta.x;
      this.gridContainer.y -= delta.y;
      // Hard, not resisted: a wheel has no release, so there is no moment at
      // which a bounce could be understood as answering the gesture.
      this.clampBounds();
      return;
    }

    const zoomFactor = Math.pow(1.0015, -delta.y);
    const newScale = clamp(this.scale * zoomFactor, this.minZoom, this.maxZoom);
    if (newScale === this.scale) return;

    const { x: mouseX, y: mouseY } = this.toStagePoint(e.clientX, e.clientY);

    const worldX = (mouseX - this.gridContainer.x) / this.scale;
    const worldY = (mouseY - this.gridContainer.y) / this.scale;

    this.userAdjusted = true;
    this.applyFrame(newScale, {
      x: mouseX - worldX * newScale,
      y: mouseY - worldY * newScale,
    });

    this.clampBounds();
  };

  private handlePointerDown = (e: PointerEvent): void => {
    /*
     * Every listener here is on the wrapper, and the header, the docked
     * sidebar and the readout float *over* it as siblings — so without capture
     * a drag that wandered onto any of them stopped receiving moves, and its
     * `pointerup` was delivered to the chrome instead. The pointer was then
     * never removed from `activePointers`, and the next single touch was read
     * as the second finger of a pinch.
     *
     * The wrapper is the right capture target even though the Pixi canvas is
     * its child: `EventSystem` binds `pointermove` to `document` and
     * `pointerup` to `window`, both in the *capture* phase, so Pixi's own
     * hit-testing does not care where the event is retargeted. It is also what
     * makes `PixiCanvas`'s own `onpointerup` — and therefore `endStroke()` —
     * land on a gesture that finishes off-canvas, which is one undo entry per
     * gesture rather than two gestures in one entry.
     */
    this.canvasWrapper.setPointerCapture(e.pointerId);

    // A touch catches the board: whatever it was doing on its own stops here.
    this.gliding = false;
    this.zoomTween = null;
    this.panVelocity = { x: 0, y: 0 };

    this.activePointers.set(e.pointerId, e);

    if (this.activePointers.size >= 2) {
      // A pinch is not two taps.
      this.pendingDoubleTap = false;
      this.lastTapAt = 0;
      this.syncPinchAnchors();
    } else if (this.activePointers.size === 1) {
      if (e.button === 1 || (e.button === 0 && !this.handledByTile)) {
        this.startPan(e);
      }
    }

    this.handledByTile = false;
  };

  /**
   * Begins a navigation gesture: a drag of the view, and — when `armDoubleTap`
   * allows it — the half of a double-tap that might follow it.
   *
   * Every press pans. A press that may also *write* passes `false`, which is
   * what keeps the double-tap out of the way of editing: two taps that place
   * two buildings must never also zoom.
   */
  public startPan(e: PointerEvent, armDoubleTap = true): void {
    this.isPanning = true;
    this.panStart = { x: e.clientX, y: e.clientY };
    this.containerStart = { x: this.gridContainer.x, y: this.gridContainer.y };

    const now = performance.now();
    this.velocitySample = {
      x: this.gridContainer.x,
      y: this.gridContainer.y,
      at: now,
    };
    this.panVelocity = { x: 0, y: 0 };

    /*
     * A press that is *going* to write something still pans — on a touch
     * screen one finger is the only way to move the board, so a held tool
     * cannot be allowed to take it away — but it must not also arm the zoom.
     * Two taps placing two buildings on neighbouring tiles land inside
     * `DOUBLE_TAP_MS` and `DOUBLE_TAP_SLOP_PX` of each other, and would
     * otherwise zoom the board out from under the second one.
     */
    if (!armDoubleTap) {
      this.pendingDoubleTap = false;
      this.lastTapAt = 0;
      return;
    }

    const near =
      Math.hypot(
        e.clientX - this.lastTapPos.x,
        e.clientY - this.lastTapPos.y,
      ) <= DOUBLE_TAP_SLOP_PX;
    this.pendingDoubleTap = near && now - this.lastTapAt <= DOUBLE_TAP_MS;
    this.lastTapAt = now;
    this.lastTapPos = { x: e.clientX, y: e.clientY };
    this.tapDownPos = { x: e.clientX, y: e.clientY };
  }

  /**
   * Gives up the drag without letting go of the pointer.
   *
   * For the press that turns out to be an edit after all: a finger held still
   * on a tile stops being a way to move the board and becomes a brush, so the
   * pan it started has to be abandoned mid-gesture while the same finger goes
   * on producing moves. The velocity goes with it, or the release would fling
   * a board the user was painting on.
   *
   * The pointer stays in `activePointers`, so a second finger arriving on top
   * of the paint is still a pinch.
   */
  public cancelPan(): void {
    this.isPanning = false;
    this.panVelocity = { x: 0, y: 0 };
    this.pendingDoubleTap = false;
  }

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.set(e.pointerId, e);

    const pinch = this.activePointers.size >= 2 ? this.pinchGeometry() : null;

    if (pinch) {
      if (this.prevTouchDist > 0) {
        const factor = pinch.dist / this.prevTouchDist;
        const newScale = clamp(this.scale * factor, this.minZoom, this.maxZoom);

        /*
         * Take the world point that was under the *previous* midpoint and put
         * it under the new one. That single substitution is what makes two
         * fingers pan as well as zoom.
         *
         * Reading the world point under the *current* midpoint instead — which
         * is what this did — algebraically cancels: at unchanged scale
         * `mid - (mid - x)` is just `x`, so moving both fingers together left
         * the board exactly where it was. With a building selected a
         * one-finger drag paints, so that made the board impossible to pan
         * without first putting the tool down.
         */
        const worldX =
          (this.prevTouchMid.x - this.gridContainer.x) / this.scale;
        const worldY =
          (this.prevTouchMid.y - this.gridContainer.y) / this.scale;

        this.userAdjusted = true;
        this.scale = newScale;
        this.gridContainer.scale.set(newScale);
        this.setPositionResisted(
          pinch.mid.x - worldX * newScale,
          pinch.mid.y - worldY * newScale,
        );
      }
      this.prevTouchDist = pinch.dist;
      this.prevTouchMid = pinch.mid;
      this.sampleVelocity();
    } else if (this.isPanning && this.activePointers.size === 1) {
      const { x: scaleX, y: scaleY } = this.getClientToStageScale();
      const dx = (e.clientX - this.panStart.x) * scaleX;
      const dy = (e.clientY - this.panStart.y) * scaleY;
      this.userAdjusted = true;
      this.setPositionResisted(
        this.containerStart.x + dx,
        this.containerStart.y + dy,
      );
      this.sampleVelocity();
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);

    if (this.activePointers.size >= 2) {
      // A finger left a three-or-more touch; the remaining pair is a new pinch.
      this.syncPinchAnchors();
      return;
    }

    this.prevTouchDist = 0;

    if (this.activePointers.size === 1) {
      /*
       * The pinch is over but a finger is still down, so the drag has to be
       * re-anchored on it.
       *
       * `panStart`/`containerStart` still describe the *first* finger's touch
       * as it stood before the pinch, and the pinch has since moved the board
       * a long way. Without this the next move resolves against that stale
       * origin and the board snaps back by everything the pinch did — the jump
       * on every pinch-then-drag, which is the commonest gesture chain there
       * is on a phone.
       *
       * `startPan` re-arms the double-tap too, which is why the tap clock is
       * cleared when the second finger lands: a pinch must not leave half a
       * double-tap behind it.
       */
      const [remaining] = this.activePointers.values();
      this.startPan(remaining);
      return;
    }

    this.isPanning = false;

    if (this.pendingDoubleTap) {
      this.pendingDoubleTap = false;
      const moved = Math.hypot(
        e.clientX - this.tapDownPos.x,
        e.clientY - this.tapDownPos.y,
      );
      /*
       * Committed on the *up*, once it is known the second tap was not the
       * start of a drag — the same call `PixiCanvas` makes for tap-to-inspect,
       * and for the same reason. It also means no finger is down while the
       * tween plays, so the two can never fight over the board.
       */
      if (moved <= DOUBLE_TAP_SLOP_PX) {
        // Not a third of a triple-tap.
        this.lastTapAt = 0;
        this.startDoubleTapZoom(e.clientX, e.clientY);
        return;
      }
    }

    this.startGlide();
  };

  /**
   * Cleans up after a capture that ended without a `pointerup`.
   *
   * Normally a no-op: capture is released implicitly *by* the pointerup, so
   * this arrives just after `handlePointerUp` has already forgotten the
   * pointer. It earns its place in the abnormal cases — the element being
   * removed mid-gesture, the browser cancelling the touch — where a pointer
   * left in the map would make the next single touch read as a pinch.
   */
  private handleLostCapture = (e: PointerEvent): void => {
    if (this.activePointers.has(e.pointerId)) this.handlePointerUp(e);
  };

  /**
   * Re-reads the pinch's distance and midpoint from the two live pointers.
   *
   * Called whenever the set of pointers changes rather than only on the second
   * touch, because a third finger landing — or either of the first two
   * lifting — changes which pair `activePointers` yields, and an anchor left
   * over from the previous pair would move the board by the difference on the
   * very next frame.
   */
  private syncPinchAnchors(): void {
    const pinch = this.pinchGeometry();
    if (!pinch) {
      this.prevTouchDist = 0;
      return;
    }
    this.prevTouchDist = pinch.dist;
    this.prevTouchMid = pinch.mid;
  }

  /**
   * The distance between the two live pointers and their midpoint in stage
   * coordinates — the whole of a pinch's state.
   *
   * One reader would not need a method; two do, and they have to agree
   * *exactly*. `syncPinchAnchors` records the anchor that `handlePointerMove`
   * then measures against, so a midpoint derived one way in one and another
   * way in the other would shift the board on the opening frame of every
   * pinch.
   */
  private pinchGeometry(): {
    dist: number;
    mid: { x: number; y: number };
  } | null {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2) return null;
    return {
      dist: Math.hypot(
        pts[0].clientX - pts[1].clientX,
        pts[0].clientY - pts[1].clientY,
      ),
      mid: this.toStagePoint(
        (pts[0].clientX + pts[1].clientX) / 2,
        (pts[0].clientY + pts[1].clientY) / 2,
      ),
    };
  }

  /** Writes a scale and position in one go, keeping `this.scale` in step. */
  private applyFrame(scale: number, at: { x: number; y: number }): void {
    this.scale = scale;
    this.gridContainer.scale.set(scale);
    this.gridContainer.x = at.x;
    this.gridContainer.y = at.y;
  }

  private startDoubleTapZoom(clientX: number, clientY: number): void {
    this.userAdjusted = true;
    this.gliding = false;

    let target: { scale: number; x: number; y: number };

    if (this.scale >= this.maxZoom - 1e-6 && this.lastFraming) {
      /*
       * Already as close as the board goes, so the second double-tap is a way
       * back out. It returns to the framed view rather than to some multiple
       * of the current scale, because that is the one view the player can
       * name — it is what Center View gives — and a zoom-out pivoted on the
       * tap would leave the board hanging off an edge.
       */
      const { gridWidth, gridHeight, inset } = this.lastFraming;
      target = this.computeFraming(gridWidth, gridHeight, inset);
    } else {
      const toScale = clamp(
        this.scale * DOUBLE_TAP_ZOOM,
        this.minZoom,
        this.maxZoom,
      );
      const pivot = this.toStagePoint(clientX, clientY);
      const worldX = (pivot.x - this.gridContainer.x) / this.scale;
      const worldY = (pivot.y - this.gridContainer.y) / this.scale;
      target = {
        scale: toScale,
        x: pivot.x - worldX * toScale,
        y: pivot.y - worldY * toScale,
      };
    }

    if (
      Math.abs(target.scale - this.scale) < 1e-6 &&
      Math.abs(target.x - this.gridContainer.x) < 1 &&
      Math.abs(target.y - this.gridContainer.y) < 1
    ) {
      return;
    }

    if (!this.animated) {
      this.applyFrame(target.scale, target);
      this.clampBounds();
      return;
    }

    this.zoomTween = {
      fromScale: this.scale,
      toScale: target.scale,
      from: { x: this.gridContainer.x, y: this.gridContainer.y },
      to: { x: target.x, y: target.y },
      elapsed: 0,
    };
  }

  private advanceZoomTween(dtMs: number): void {
    const tween = this.zoomTween;
    if (!tween) return;

    tween.elapsed += dtMs;
    const t = Math.min(1, tween.elapsed / ZOOM_TWEEN_MS);
    // easeOutCubic: quick off the mark, so the tap feels answered at once.
    const k = 1 - Math.pow(1 - t, 3);

    this.applyFrame(tween.fromScale + (tween.toScale - tween.fromScale) * k, {
      x: tween.from.x + (tween.to.x - tween.from.x) * k,
      y: tween.from.y + (tween.to.y - tween.from.y) * k,
    });
    // Hard, not resisted: the tween lands on its target rather than bouncing.
    this.clampBounds();

    if (t >= 1) this.zoomTween = null;
  }

  /** Records how fast the board is moving, for the glide after the release. */
  private sampleVelocity(): void {
    const now = performance.now();
    const dt = now - this.velocitySample.at;
    const px = this.gridContainer.x - this.velocitySample.x;
    const py = this.gridContainer.y - this.velocitySample.y;

    this.velocitySample = {
      x: this.gridContainer.x,
      y: this.gridContainer.y,
      at: now,
    };
    if (!(dt > 0)) return;

    /*
     * Smoothed toward the newest sample rather than taken from it outright: a
     * single frame's delta is noisy enough on a touchscreen that a flick can
     * end on an outlier, and the whole throw is then quoted from that one
     * reading.
     */
    const weight = 0.7;
    this.panVelocity = {
      x: this.panVelocity.x * (1 - weight) + (px / dt) * weight,
      y: this.panVelocity.y * (1 - weight) + (py / dt) * weight,
    };
  }

  private startGlide(): void {
    const idle = performance.now() - this.velocitySample.at;
    const speed = Math.hypot(this.panVelocity.x, this.panVelocity.y);
    this.gliding =
      this.animated && idle <= GLIDE_IDLE_MS && speed > MIN_GLIDE_SPEED;
  }

  private advanceGlide(dtMs: number): void {
    this.gridContainer.x += this.panVelocity.x * dtMs;
    this.gridContainer.y += this.panVelocity.y * dtMs;

    const friction = decay(GLIDE_FRICTION, dtMs);
    this.panVelocity = {
      x: this.panVelocity.x * friction,
      y: this.panVelocity.y * friction,
    };

    /*
     * An axis that has run past its limit is done throwing, and `settle` takes
     * it from there. Killing the axis rather than the whole velocity is what
     * lets a diagonal flick keep sliding along the edge it has not reached.
     */
    const range = this.panRange();
    if (range) {
      if (
        this.gridContainer.x < range.minX ||
        this.gridContainer.x > range.maxX
      ) {
        this.panVelocity.x = 0;
        this.outOfBounds = true;
      }
      if (
        this.gridContainer.y < range.minY ||
        this.gridContainer.y > range.maxY
      ) {
        this.panVelocity.y = 0;
        this.outOfBounds = true;
      }
    }

    if (Math.hypot(this.panVelocity.x, this.panVelocity.y) < MIN_GLIDE_SPEED) {
      this.gliding = false;
    }
  }

  /** Eases the board back inside its limits after an overscroll. */
  private settle(dtMs: number): void {
    const range = this.panRange();
    if (!range) return;

    const toX = clamp(this.gridContainer.x, range.minX, range.maxX);
    const toY = clamp(this.gridContainer.y, range.minY, range.maxY);
    const dx = toX - this.gridContainer.x;
    const dy = toY - this.gridContainer.y;
    if (dx === 0 && dy === 0) {
      this.outOfBounds = false;
      return;
    }

    if (!this.animated) {
      this.gridContainer.x = toX;
      this.gridContainer.y = toY;
      this.outOfBounds = false;
      return;
    }

    const k = 1 - decay(1 - BOUNCE_RATE, dtMs);
    this.gridContainer.x += Math.abs(dx) < BOUNCE_SNAP_PX ? dx : dx * k;
    this.gridContainer.y += Math.abs(dy) < BOUNCE_SNAP_PX ? dy : dy * k;
  }

  /**
   * The range `gridContainer.x`/`.y` may take while still leaving enough of
   * the board on screen — at least 25% of it, or 150px, whichever is smaller.
   */
  private panRange(): PanRange | null {
    const { width: wrapperWidth, height: wrapperHeight } = this.getStageSize();
    const bounds = this.gridContainer.getLocalBounds();

    if (!bounds || bounds.width === 0 || bounds.height === 0) return null;

    const marginX = Math.min(bounds.width * this.scale * 0.25, 150);
    const marginY = Math.min(bounds.height * this.scale * 0.25, 150);

    return {
      minX: marginX - (bounds.x + bounds.width) * this.scale,
      maxX: wrapperWidth - marginX - bounds.x * this.scale,
      minY: marginY - (bounds.y + bounds.height) * this.scale,
      maxY: wrapperHeight - marginY - bounds.y * this.scale,
    };
  }

  /**
   * Moves the board, letting it past its limits under resistance.
   *
   * A hard stop mid-gesture reads as the gesture having broken — the finger
   * goes on moving and the board does not. Giving back a third of the
   * overshoot keeps the board following the finger while saying, in the only
   * language a drag has, that there is nothing further this way. `settle`
   * takes it home once the finger lifts.
   *
   * Applied to an absolute position rather than an increment, which is what
   * makes it stable: both callers recompute where the board *should* be from
   * an anchor every frame, so the damping is re-derived rather than compounded.
   */
  private setPositionResisted(x: number, y: number): void {
    const range = this.panRange();
    if (!range) {
      this.gridContainer.x = x;
      this.gridContainer.y = y;
      return;
    }
    this.gridContainer.x = resist(x, range.minX, range.maxX);
    this.gridContainer.y = resist(y, range.minY, range.maxY);
    this.outOfBounds = this.gridContainer.x !== x || this.gridContainer.y !== y;
  }

  /** Prevents panning/zooming too far out of the canvas boundaries */
  private clampBounds(): void {
    this.outOfBounds = false;
    const range = this.panRange();
    if (!range) return;
    this.gridContainer.x = clamp(this.gridContainer.x, range.minX, range.maxX);
    this.gridContainer.y = clamp(this.gridContainer.y, range.minY, range.maxY);
  }
}
