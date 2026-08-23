/**
 * What the *device* is, as reactive state.
 *
 * Two independent axes, and conflating them is the usual way this pattern
 * breaks:
 *
 *   - **Width** decides the shape of the chrome. Below 1024px the config panel
 *     is a bottom sheet; at or above it, a docked sidebar.
 *   - **Pointer** decides how the inspector is driven. `pointer: coarse` means
 *     there is no hover to read, so tiles are tapped to pin instead.
 *
 * `prefersReducedMotion` is a third, independent of both: it is what the viewer
 * has asked their *system* for, and it only ever sets a default — see
 * `uiState.animations`, where an explicit choice in Settings overrides it.
 *
 * A touchscreen laptop at 1400px is wide *and* coarse: it gets the docked
 * sidebar and tap-to-inspect. Deriving one from the other would give it the
 * wrong half of each.
 *
 * This sits at the top of the state DAG — it imports nothing from the rest of
 * the state layer, the same rule `layoutState` follows.
 */

/** Below this the config panel is a bottom sheet rather than a sidebar. */
const SIDEBAR_MIN_WIDTH = 1024;
/** Below this the header collapses its secondary controls into a menu. */
const PHONE_MAX_WIDTH = 768;

class ViewportState {
  /** Viewport is narrower than the sidebar breakpoint — use a bottom sheet. */
  isCompact = $state(false);

  /** Phone-sized: the header sheds everything but the recovery actions. */
  isPhone = $state(false);

  /** No usable hover — tap to inspect instead of hovering. */
  isCoarse = $state(false);

  /**
   * The viewer has asked their system to reduce animation.
   *
   * Tracked live rather than read once, so someone who changes it while the
   * app is open sees the board settle immediately — the same as every other
   * query here.
   */
  prefersReducedMotion = $state(false);

  /**
   * Visual viewport height in px. `100dvh` covers most cases, but iOS Safari
   * only settles it after the URL bar finishes collapsing, so the sheet's
   * detent maths reads this instead of trusting a CSS unit mid-animation.
   */
  height = $state(0);

  constructor() {
    if (typeof window === "undefined" || !window.matchMedia) return;

    this.#track(`(max-width: ${SIDEBAR_MIN_WIDTH - 1}px)`, (m) => {
      this.isCompact = m;
    });
    this.#track(`(max-width: ${PHONE_MAX_WIDTH - 1}px)`, (m) => {
      this.isPhone = m;
    });
    this.#track("(pointer: coarse)", (m) => {
      this.isCoarse = m;
    });
    this.#track("(prefers-reduced-motion: reduce)", (m) => {
      this.prefersReducedMotion = m;
    });

    this.height = window.innerHeight;
    const onResize = () => {
      this.height = window.innerHeight;
    };
    window.addEventListener("resize", onResize, { passive: true });
    // `resize` alone misses the iOS URL-bar collapse, which changes the
    // visual viewport without changing the layout viewport.
    window.visualViewport?.addEventListener("resize", onResize, {
      passive: true,
    });
  }

  /** Seeds from the query's current value, then keeps it in sync. */
  #track(query: string, apply: (matches: boolean) => void) {
    const mql = window.matchMedia(query);
    apply(mql.matches);
    mql.addEventListener("change", (e) => apply(e.matches));
  }
}

export const viewportState = new ViewportState();
