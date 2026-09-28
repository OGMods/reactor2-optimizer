<script lang="ts">
  import { uiState, viewportState } from "../../state";
  import { type SheetDetent } from "../../state/ui.svelte";
  import TemplateSelector from "./TemplateSelector.svelte";
  import BuildingUnlockList from "./BuildingUnlockList.svelte";
  import SolveModeSelector from "./SolveModeSelector.svelte";
  import AnomalySelector from "./AnomalySelector.svelte";
  import PrestigeUpgrades from "./PrestigeUpgrades.svelte";
  import {
    ChevronLeft,
    ChevronRight,
    FlaskConical,
    Layers,
    X,
    Zap,
  } from "lucide-svelte";

  /*
   * The sheet's top region — grabber, header, run slot. Measured rather than
   * assumed, because it *is* the `peek` detent: peek shows exactly this much
   * and nothing else, and its contents change.
   */
  let peekHeight = $state(0);

  $effect(() => {
    if (peekHeight > 0) uiState.sheetPeekHeight = peekHeight;
  });

  /*
   * How much of the canvas the docked panel is standing on, for `PixiCanvas`
   * to frame the board around. Zero while it is collapsed (it translates fully
   * off-screen) and zero on a compact viewport, where it is a sheet over the
   * bottom rather than a column down the side — the sheet's contribution is
   * already covered by the HUD's own clearance.
   */
  let sidebarWidth = $state(0);

  $effect(() => {
    if (compact || uiState.sidebarCollapsed) {
      uiState.sidebarWidth = 0;
    } else if (sidebarWidth > 0) {
      /*
       * A `0` out of `bind:clientWidth` means "not measured yet", not "no
       * panel" — the binding lands a frame after mount. Publishing it would
       * drop the inset to nothing for one paint every time Setup comes back
       * from a run, and `.hud`'s `padding-left` transitions, so the whole tool
       * stack would glide out and straight back again.
       */
      uiState.sidebarWidth = sidebarWidth;
    }
    /*
     * Cleared once this component is gone, the same call `HudToolbar` makes
     * for `hudHeight`: a width left behind reserves canvas — and the HUD's own
     * `padding-left`, which tracks the same edge — for a column that is not on
     * screen. That is the right answer for a preview or a hidden interface,
     * which are states the user is *in*.
     *
     * A run is not one of those. Setup is away for a few seconds and comes
     * back on its own, so handing the space to the board and the HUD means
     * taking it again a moment later, with the action pill gliding 190px out
     * from under the cursor that pressed RUN and back once it lands. The inset
     * is held for the duration instead, which is what keeps the whole scene
     * still; all the run changes is that the panel is not drawn over it.
     */
    return () => {
      if (!uiState.setupHidden) uiState.sidebarWidth = 0;
    };
  });

  /**
   * One component, two presentations — a bottom sheet under 1024px and a
   * docked sidebar at or above it. The contents are identical; only the shell
   * and the gesture differ, which is exactly why this is not two components.
   */

  /** Live drag offset in px while a pointer is down; null when at rest. */
  let dragHeight = $state<number | null>(null);
  let dragStartY = 0;
  let dragStartHeight = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  /*
   * A `click` still fires after a drag that started and ended on the handle.
   * Without this the drag's own click would immediately re-snap the sheet —
   * throwing it open to `full` and watching it drop straight back to `peek`.
   */
  let didDrag = false;

  let compact = $derived(viewportState.isCompact);
  let vh = $derived(viewportState.height || 800);

  /** Visible height, in px, for each detent at the current viewport size. */
  let detentHeights = $derived<Record<SheetDetent, number>>({
    closed: 0,
    peek: uiState.sheetPeekHeight,
    half: Math.round(vh * 0.5),
    full: Math.round(vh * 0.9),
  });

  /** The sheet element is always full-size; the transform hides the rest. */
  let sheetHeight = $derived(detentHeights.full);

  let restingHeight = $derived(detentHeights[uiState.sheetDetent]);
  let visibleHeight = $derived(dragHeight ?? restingHeight);
  let translateY = $derived(Math.max(0, sheetHeight - visibleHeight));

  const ORDER: SheetDetent[] = ["closed", "peek", "half", "full"];

  function nearestDetent(height: number): SheetDetent {
    return ORDER.reduce((best, d) =>
      Math.abs(detentHeights[d] - height) <
      Math.abs(detentHeights[best] - height)
        ? d
        : best,
    );
  }

  function neighbour(from: SheetDetent, direction: 1 | -1): SheetDetent {
    const i = ORDER.indexOf(from);
    return ORDER[Math.min(ORDER.length - 1, Math.max(0, i + direction))];
  }

  function onHandleDown(e: PointerEvent) {
    if (!compact) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartY = e.clientY;
    dragStartHeight = restingHeight;
    dragHeight = restingHeight;
    lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    didDrag = false;
  }

  function onHandleMove(e: PointerEvent) {
    if (dragHeight === null) return;
    // Dragging up (negative delta) grows the sheet.
    const next = dragStartHeight - (e.clientY - dragStartY);
    if (Math.abs(e.clientY - dragStartY) > 4) didDrag = true;
    // A little overshoot past `full` keeps the drag from feeling stuck.
    dragHeight = Math.max(0, Math.min(sheetHeight + 40, next));

    const dt = e.timeStamp - lastT;
    if (dt > 0) {
      // px/ms, positive when moving up.
      velocity = (lastY - e.clientY) / dt;
      lastY = e.clientY;
      lastT = e.timeStamp;
    }
  }

  function onHandleUp() {
    if (dragHeight === null) return;
    const landed = dragHeight;
    dragHeight = null;

    /*
     * A fast flick should skip a detent rather than snapping to whichever one
     * happens to be closest — otherwise a deliberate throw upward from `peek`
     * stops at `half` even when the user clearly meant `full`.
     */
    const FLICK = 0.5; // px/ms
    if (Math.abs(velocity) > FLICK) {
      const from = nearestDetent(landed);
      uiState.setSheetDetent(neighbour(from, velocity > 0 ? 1 : -1));
    } else {
      uiState.setSheetDetent(nearestDetent(landed));
    }
    velocity = 0;
  }

  /** Tapping the handle cycles open rather than requiring a drag. */
  function onHandleClick() {
    if (!compact || didDrag) return;
    uiState.setSheetDetent(uiState.sheetDetent === "full" ? "peek" : "half");
  }

  /*
   * Escape closes the sheet outright, not back to `peek`.
   *
   * Stopping at peek would be right if peek kept the Run button on screen. It
   * does not: Run is in the HUD, and the HUD stands down for as long as this
   * sheet is open at *any* detent. Escaping to peek would leave the user
   * looking at a sliver of Setup with every tool and the primary action gone —
   * dismissed, but not back to the board.
   */
  $effect(() => {
    if (!compact || uiState.sheetDetent === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") uiState.setSheetDetent("closed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<!--
  ── The two halves of Setup ──────────────────────────────────────
  Rendered by both shells, which is the whole reason they are snippets: the
  switch and the body are the same in a sheet and in a docked column, and a
  second copy of either is a thing to get out of step.

  The switch sits *between* the fixed top region and the scroller rather than
  inside either. Inside `.sheet-top` it would inflate `peekHeight` — peek is
  measured, and it is meant to be the header alone, not a header plus a
  control for content peek does not show. Inside `.scroll-body` it would
  scroll away — and the one control that says where you are is the last thing
  that should leave the screen.
-->
{#snippet setupSwitch()}
  <div class="setup-switch">
    <button
      class="switch-btn"
      class:active={uiState.setupTab === "islands"}
      aria-pressed={uiState.setupTab === "islands"}
      onclick={() => (uiState.setupTab = "islands")}
    >
      <Layers size={15} />
      <span>Islands</span>
    </button>
    <button
      class="switch-btn"
      class:active={uiState.setupTab === "buildings"}
      aria-pressed={uiState.setupTab === "buildings"}
      onclick={() => (uiState.setupTab = "buildings")}
    >
      <Zap size={15} />
      <span>Buildings</span>
    </button>
    <!--
      Named for the game's own screen rather than for either of the two things
      on it: the research and the anomaly are both chosen in the Time Lab, and
      a tab called "Anomaly" leaves the research with nowhere to be.
    -->
    <button
      class="switch-btn"
      class:active={uiState.setupTab === "timelab"}
      aria-pressed={uiState.setupTab === "timelab"}
      onclick={() => (uiState.setupTab = "timelab")}
    >
      <FlaskConical size={15} />
      <span>Time Lab</span>
    </button>
  </div>
{/snippet}

{#snippet setupBody()}
  <!--
    One at a time, and unmounted rather than hidden. They share the scroller,
    so a hidden section would have to share its scroll offset too — landing the
    roster halfway down because the island list is scrolled there.
  -->
  {#if uiState.setupTab === "islands"}
    <TemplateSelector />
  {:else if uiState.setupTab === "buildings"}
    <BuildingUnlockList />
  {:else}
    <!-- Research first: it applies under every anomaly, including none. -->
    <PrestigeUpgrades />
    <AnomalySelector />
  {/if}
{/snippet}

{#if compact}
  <!--
    ── Bottom sheet ─────────────────────────────────────────────
    The way back in is not here: it is a sibling of Run inside the HUD's own
    action row — see `hud/HudToolbar.svelte`.
  -->
  <aside
    class="sheet"
    class:dragging={dragHeight !== null}
    style:height="{sheetHeight}px"
    style:transform="translateY({translateY}px)"
    inert={uiState.sheetDetent === "closed"}
  >
    <!--
      The drag handle stays fixed while the body scrolls beneath it.
      `touch-action: none` is required or the browser claims the vertical
      gesture for page scrolling before we see a single pointermove.
    -->
    <div class="sheet-top" bind:clientHeight={peekHeight}>
      <div
        class="grabber"
        role="slider"
        tabindex="0"
        aria-label="Setup panel height"
        aria-valuenow={ORDER.indexOf(uiState.sheetDetent)}
        aria-valuemin={0}
        aria-valuemax={ORDER.length - 1}
        aria-valuetext={uiState.sheetDetent}
        onpointerdown={onHandleDown}
        onpointermove={onHandleMove}
        onpointerup={onHandleUp}
        onpointercancel={onHandleUp}
        onclick={onHandleClick}
        onkeydown={(e) => {
          if (e.key === "ArrowUp")
            uiState.setSheetDetent(neighbour(uiState.sheetDetent, 1));
          if (e.key === "ArrowDown")
            uiState.setSheetDetent(neighbour(uiState.sheetDetent, -1));
        }}
      >
        <span class="grabber-bar"></span>
      </div>

      <div class="sheet-head">
        <h2>SETUP</h2>
        <button
          class="sheet-close"
          onclick={() => uiState.setSheetDetent("closed")}
          aria-label="Dismiss setup"
        >
          <X size={18} />
        </button>
      </div>

      <!--
        Run itself is not here: it lives in the HUD stack, which is the one
        surface a tool press does not dismiss — see `hud/BoardActions.svelte`.
        What is left is the choice of how long a run may take, which sits under
        the header rather than in a footer so it is readable at the `peek`
        detent without the panel covering the map.
      -->
      <div class="run-slot">
        <SolveModeSelector />
      </div>
    </div>

    {@render setupSwitch()}

    <div class="scroll-body thin-scroll">
      {@render setupBody()}
    </div>
  </aside>
{:else}
  <!-- ── Docked sidebar ─────────────────────────────────────────── -->
  <aside
    class="sidebar"
    class:collapsed={uiState.sidebarCollapsed}
    bind:clientWidth={sidebarWidth}
  >
    <button
      class="toggle-handle"
      onclick={() => uiState.toggleSidebar()}
      aria-label={uiState.sidebarCollapsed ? "Show setup" : "Hide setup"}
      aria-expanded={!uiState.sidebarCollapsed}
    >
      <!--
        Named while it is shut. Collapsed, this is a 28px chevron against the
        left edge of the screen with nothing to say what is behind it — the
        panel that would have told you is the thing it is hiding. Open, the
        label would only repeat the SETUP heading two centimetres to its left,
        so it goes back to being a plain chevron.
      -->
      {#if uiState.sidebarCollapsed}
        <ChevronRight size={16} />
        <span class="handle-label">SETUP</span>
      {:else}
        <ChevronLeft size={18} />
      {/if}
    </button>

    <div class="sidebar-panel">
      <div class="sidebar-head">
        <h2>SETUP</h2>
      </div>

      {@render setupSwitch()}

      <div class="scroll-body thin-scroll">
        {@render setupBody()}
      </div>

      <!-- Run is in the HUD; see the note on the sheet's `run-slot` above. -->
      <div class="sidebar-foot">
        <SolveModeSelector />
      </div>
    </div>
  </aside>
{/if}

<style>
  /* ── Shared ─────────────────────────────────────────────────────── */
  h2 {
    margin: 0;
    font-size: var(--fs-md);
    letter-spacing: 1.2px;
    color: var(--accent);
    font-weight: 600;
  }

  /*
   * The top-level switch. Deliberately *not* the filled-pill idiom the
   * category tabs inside the roster use — two rows of identical-looking tabs
   * stacked on top of one another read as one confusing row of five. An
   * underline above a pill is a legible hierarchy; the accent is `--accent` in
   * both, because the colour law has one meaning for "this one is selected".
   */
  .setup-switch {
    display: flex;
    flex-shrink: 0;
    gap: 0.25rem;
    padding: 0 1rem;
    border-bottom: 1px solid var(--accent-faint);
  }

  .switch-btn {
    flex: 1;
    /* Three of these share a 380px panel and a 374px phone, so a long label
       has to be allowed to shrink rather than widening the row past it. */
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    height: var(--ctl);
    background: none;
    border: none;
    /* Overlaps the container's hairline, so the active mark sits *on* the
       rule rather than a pixel above it. */
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--text-dim);
    font-size: var(--fs-base);
    font-weight: 600;
    letter-spacing: 0.3px;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease);
  }

  .switch-btn span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .switch-btn:hover {
    color: var(--text);
  }

  .switch-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  @media (pointer: coarse) {
    .switch-btn {
      min-height: var(--tap);
    }
  }

  .scroll-body {
    flex: 1;
    /*
     * **`min-height: 0` is what makes this scroll at all.**
     *
     * A flex item's automatic minimum size is its content size, so `flex: 1`
     * alone cannot shrink this below the height of every building card in it.
     * A handful of unlocks hides that; the full roster of 38 refuses to shrink,
     * overflows the sheet, and makes `.app-shell` a 1604px scroll container
     * inside an 844px window. Focusing any control in the list then scrolls the
     * *whole app* up by ~340px — header, HUD and board with it — and
     * `overflow: hidden` on the shell leaves no scrollbar to get back with,
     * short of reloading.
     *
     * `.sidebar-panel` clips its own overflow, which is why the symptom shows
     * on the phone and not in the docked layout.
     */
    min-height: 0;
    overflow-y: auto;
    /* Keeps a flick inside the sheet from scrolling the page behind it. */
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 0.85rem 1rem;
  }

  /* ── Bottom sheet ───────────────────────────────────────────────── */
  /*
   * `inert` rather than `aria-hidden` when closed: the sheet is only
   * translated off-screen, so its buttons stay focusable and a keyboard user
   * would otherwise tab into a panel they cannot see.
   */
  .sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-sheet);
    display: flex;
    flex-direction: column;
    /*
     * Its own 0.97 over the board; the theme decides the hue — see the theme
     * block in `app.css`. Everything inside follows, because every descendant
     * already reads `--text` / `--accent` / `--border` and a theme is a
     * rebinding of exactly those.
     */
    background: rgba(var(--surface-panel-rgb), 0.97);
    backdrop-filter: blur(16px);
    border-top: 1px solid var(--border-accent);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.6);
    /* Nothing inside may paint outside the sheet — the belt to `min-height`'s
       braces, and it makes the top corners clip properly too. */
    overflow: hidden;
    transition:
      transform var(--dur) var(--ease),
      background var(--dur) var(--ease);
    /* Content clears the home indicator when pulled up. */
    padding-bottom: var(--safe-bottom);
  }

  /* No transition while a finger is down — it must track the finger 1:1. */
  .sheet.dragging {
    transition: none;
  }

  /* The three rows `peek` shows, measured as one. */
  .sheet-top {
    flex-shrink: 0;
  }

  .grabber {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Generous hit area: the visual bar is 4px but the target is 28px. */
    height: 28px;
    flex-shrink: 0;
    cursor: grab;
    touch-action: none;
  }

  .grabber:active {
    cursor: grabbing;
  }

  .grabber-bar {
    width: 40px;
    height: 4px;
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.25);
  }

  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.75rem 0.5rem 1rem;
    flex-shrink: 0;
  }

  .sheet-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tap);
    height: var(--tap);
    background: transparent;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .sheet-close:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .run-slot {
    padding: 0 1rem 0;
    flex-shrink: 0;
  }

  /* ── Docked sidebar ─────────────────────────────────────────────── */
  .sidebar {
    position: absolute;
    /* Under the header's measured edge — see the note in `Header.svelte`. */
    top: calc(var(--header-clearance, 4.5rem) + 0.5rem);
    left: calc(var(--safe-left) + 0.75rem);
    bottom: 1.5rem;
    width: 380px;
    max-width: calc(100vw - 2rem);
    z-index: var(--z-sheet);
    transition: transform var(--dur) var(--ease);
  }

  /*
   * Slid left by exactly its own left offset, so its right edge lands on 0 and
   * the handle hanging off that edge is fully on screen. `1rem` against a
   * `0.75rem` offset puts 4px of the handle past the window — barely visible
   * as a clipped chevron, and plainly wrong with a SETUP label on it.
   */
  .sidebar.collapsed {
    transform: translateX(calc(-100% - var(--safe-left) - 0.75rem));
  }

  .toggle-handle {
    position: absolute;
    right: -28px;
    top: 12px;
    width: 28px;
    /* Tall enough for the label when there is one; a plain chevron when not. */
    min-height: var(--tap);
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem 0;
    background: rgba(var(--surface-panel-rgb), 0.9);
    border: 1px solid var(--accent-dim);
    border-left: none;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    color: var(--accent);
    transition:
      border-color var(--dur) var(--ease),
      color var(--dur) var(--ease);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    backdrop-filter: blur(8px);
  }

  .handle-label {
    writing-mode: vertical-rl;
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 1.5px;
  }

  .sidebar-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    /* Its own 0.88, where the header takes 0.94 — see `--surface-panel-rgb`. */
    background: rgba(var(--surface-panel-rgb), 0.88);
    transition: background var(--dur) var(--ease);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .sidebar-head {
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--accent-faint);
    flex-shrink: 0;
  }

  .sidebar-foot {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--accent-faint);
    /* A region set apart inside the panel — see `--surface-inset`, which the
       theme swaps for a neutral where a navy tint would fight the ground. */
    background: var(--surface-inset);
    transition: background var(--dur) var(--ease);
    flex-shrink: 0;
  }
</style>
