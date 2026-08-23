<script lang="ts">
  import { layoutState, uiState, viewportState } from "../../state";
  import { LocateFixed, Share2 } from "lucide-svelte";
  import { asset } from "../../utils";
  import GridControls from "./GridControls.svelte";
  import OverflowMenu from "./OverflowMenu.svelte";

  /*
   * Two arrangements of the same controls.
   *
   * Phone: identity mark, Center View, overflow. Center View is the recovery
   * action when a user pans off the map, so it stays a single tap away rather
   * than moving into the menu. Grid dimensions and share go into the menu.
   *
   * Wider: everything inline.
   *
   * The identity is the same at both widths -- the game's own logo plus the
   * word this tool adds to it. It survives the phone because it is 54px wide
   * at the height the bar already is, which is narrower than the "REACTOR 2"
   * it replaces; there was never a reason to abbreviate it to "R2".
   */
  let compact = $derived(viewportState.isPhone);

  /*
   * Hidden, not disabled, on a shipped island. Its dimensions are part of the
   * map, so a stepper there is not a control the user is temporarily barred
   * from — it is one that does not exist for this board.
   */
  let showSize = $derived(!compact && layoutState.canEditTerrain);

  /*
   * Publishes where this bar ends, for everything anchored beneath it: the
   * docked sidebar, the corner readout, and the canvas, which frames the board
   * in what the chrome leaves free.
   *
   * Measured rather than assumed, for the same reason `hudHeight` is. Those
   * anchors used a hard-coded `4.5rem`, which is 72px — and this bar is 57px
   * tall on a phone but 62px on a desktop, where its buttons are taller. So
   * the guess left a 3px gap in one case and *overlapped the header by 2px* in
   * the other, with `--z-sheet` outranking `--z-header` so the sidebar won.
   *
   * `getBoundingClientRect().bottom` rather than `clientHeight`, because the
   * bar is offset by `--safe-top` plus a margin and the callers want the edge,
   * not the size. `clientHeight` is only the trigger for re-reading it.
   */
  let headerEl = $state<HTMLElement | null>(null);
  let headerHeight = $state(0);

  $effect(() => {
    void headerHeight;
    void compact;
    if (headerEl)
      uiState.headerBottom = headerEl.getBoundingClientRect().bottom;
  });
</script>

<header
  class="hud-header"
  class:compact
  bind:this={headerEl}
  bind:clientHeight={headerHeight}
>
  <!--
    `alt` carries the half of the name the picture is, so the heading's
    accessible name is the whole of it: "Reactor 2 Optimizer". The intrinsic
    dimensions are the file's own (3x the 44px it draws at, for HiDPI), which
    is what lets the browser reserve the right box before the image lands.
  -->
  <h1 class="logo">
    <img
      class="logo-mark"
      src={asset("logo.webp")}
      alt="Reactor 2"
      width="163"
      height="132"
    />
    <span class="tool">Optimizer</span>
  </h1>

  <div class="actions">
    {#if showSize}
      <GridControls />
    {/if}

    <button
      class="action-btn"
      onclick={() => uiState.recenterCanvas()}
      aria-label="Center view on the map"
    >
      <LocateFixed size={16} />
      {#if !compact}<span>Center View</span>{/if}
    </button>

    {#if !compact}
      <!--
        Opens `modals/ShareModal.svelte`, which is where the copying happens.
        The dialog offers two forms of the same layout, a code and a link, and
        nothing here can know which one the user came for — so this opens the
        dialog and leaves the choice there rather than copying and flashing
        "Copied!" itself. On a phone it lives in the overflow menu.
      -->
      <button class="action-btn" onclick={() => uiState.shareLayout()}>
        <Share2 size={16} />
        <span>Share</span>
      </button>
    {/if}

    <!--
      Present at every width: Import and Support live here always, and on a
      phone the map-size and share controls fold in beside them.
    -->
    <OverflowMenu />
  </div>
</header>

<style>
  .hud-header {
    position: absolute;
    /*
     * Pinned against the safe area rather than a bare 1rem, so the bar clears
     * the notch in landscape and the status bar in a standalone PWA.
     */
    top: calc(var(--safe-top) + 0.75rem);
    left: calc(var(--safe-left) + 0.75rem);
    right: calc(var(--safe-right) + 0.75rem);
    z-index: var(--z-header);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    background: var(--surface-panel);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius);
    padding: 0.5rem 0.85rem;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    margin: 0;
  }

  /*
   * 44px is the tallest mark that changes neither bar: the phone's row is
   * already that (its buttons are `--tap`) and the desktop's is 46px. So the
   * logo costs no height at either width, and `uiState.headerBottom` -- which
   * the canvas frames the board inside -- does not move.
   *
   * `width: auto` rather than a paired px value, so the ratio comes from the
   * file and a re-exported logo cannot arrive squashed.
   */
  .logo-mark {
    height: 2.75rem;
    width: auto;
    flex-shrink: 0;
  }

  /*
   * The picture says "Reactor 2"; this says what the tool does. It is set
   * quietly on purpose -- the mark beside it is gold and white on a bar whose
   * job is to sit out of the way, and two loud things next to each other read
   * as neither. Caps in CSS rather than in the markup, so the accessible name
   * and anything that copies the heading get the real casing.
   */
  .tool {
    font-size: var(--fs-md);
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--fs-base);
    font-weight: 600;
    white-space: nowrap;
    padding: 0 0.75rem;
    height: var(--ctl);
    transition: all var(--dur-fast);
  }

  /*
   * Both header actions are neutral, and that is the point.
   *
   * Center View was neon and Share was `--amber` — two accents in a bar whose
   * job is to sit out of the way, and the amber one was the exact colour the
   * board uses to report an idle building. Under the colour law in `app.css`
   * neither of these is a selection and neither destroys anything, so neither
   * earns a hue. The only colour left in the bar is the logo's own, which is
   * the game's rather than the app's and so speaks none of the board's
   * readings; nothing here competes with the board, or with Run.
   */
  .action-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
  }

  .action-btn:hover {
    background: var(--surface-raised);
    border-color: var(--neon-dim);
    color: var(--text);
  }

  /* ── Phone ───────────────────────────────────────────────────────── */
  .hud-header.compact {
    padding: 0.35rem 0.5rem;
    gap: 0.5rem;
  }

  /*
   * A touchscreen laptop is wide *and* coarse, so it never reaches the
   * `.compact` branch below and was left with 34px targets. Keyed on the
   * pointer, like every other touch bump in the app.
   */
  @media (pointer: coarse) {
    .action-btn {
      min-height: var(--tap);
    }
  }

  /* Icon-only, and squared up to the 44px minimum touch target. */
  .hud-header.compact .action-btn {
    width: var(--tap);
    height: var(--tap);
    padding: 0;
  }
</style>
