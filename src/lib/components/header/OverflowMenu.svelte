<script lang="ts">
  import {
    configState,
    layoutState,
    uiState,
    viewportState,
  } from "../../state";
  import GridControls from "./GridControls.svelte";
  import DonateButton from "./DonateButton.svelte";
  import {
    Download,
    EyeOff,
    ImageDown,
    MoreHorizontal,
    Settings,
    Share2,
    X,
  } from "lucide-svelte";

  /**
   * The header's overflow dropdown, present at every width.
   *
   * It holds two kinds of thing. Settings, Save as image, Import and Support
   * live here always — they are secondary everywhere, and giving them a fixed
   * home keeps the header bar from growing a new button per feature. Map size
   * and Share move in only on a phone, where the bar has no room for them.
   */
  let menuEl = $state<HTMLDivElement | null>(null);
  let compact = $derived(viewportState.isPhone);

  /* Hidden rather than disabled on a shipped island — see `Header`. */
  let showSize = $derived(compact && layoutState.canEditTerrain);

  /*
   * Import is absent while a shared link is being previewed. The visitor
   * already has the only import that makes sense there — "Import as my island"
   * on the preview banner, for the board actually in front of them — and a
   * second one that lands a *different* board would leave the preview half
   * exited, since importing writes and a preview writes nothing.
   */
  let showImport = $derived(!uiState.isPreview);

  function close() {
    uiState.overflowOpen = false;
  }

  /*
   * Close on outside pointerdown and on Escape. `pointerdown` rather than
   * `click` so the menu is gone before the canvas underneath reacts.
   */
  $effect(() => {
    if (!uiState.overflowOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (menuEl && !menuEl.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

<div class="overflow-wrap" bind:this={menuEl}>
  <button
    class="icon-btn"
    class:open={uiState.overflowOpen}
    onclick={() => (uiState.overflowOpen = !uiState.overflowOpen)}
    aria-label="More options"
    aria-expanded={uiState.overflowOpen}
    aria-haspopup="true"
  >
    {#if uiState.overflowOpen}
      <X size={18} />
    {:else}
      <MoreHorizontal size={18} />
    {/if}
  </button>

  {#if uiState.overflowOpen}
    <div
      class="menu thin-scroll"
      class:anomalous={configState.hasAnomaly}
      role="menu"
    >
      {#if showSize}
        <div class="menu-section">
          <span class="menu-title">Map size</span>
          <GridControls variant="stacked" />
        </div>

        <div class="menu-divider"></div>
      {/if}

      {#if compact}
        <button
          class="menu-item share"
          role="menuitem"
          onclick={() => uiState.shareLayout()}
        >
          <Share2 size={16} />
          <span>Share this layout</span>
        </button>
      {/if}

      <!--
        Present at every width, and in preview too: it captures the board on
        screen and writes nothing the visitor owns. The label says what comes
        back rather than what it does, because "export" is what the two rows
        around it also are — a code, a link, and now a picture.
      -->
      <button
        class="menu-item"
        role="menuitem"
        disabled={uiState.isSavingImage}
        onclick={() => uiState.saveLayoutImage()}
      >
        <ImageDown size={16} />
        <span>{uiState.isSavingImage ? "Saving image…" : "Save as image"}</span>
      </button>

      <!--
        Puts every other pixel away and leaves the board. It sits beside "Save
        as image" because the two answer the same wish from opposite ends —
        one takes the board out of the app, the other takes the app off the
        board — and it belongs in preview for the same reason that one does:
        it shows the visitor more of the layout and writes nothing they own.
      -->
      <button
        class="menu-item"
        role="menuitem"
        onclick={() => uiState.setUiHidden(true)}
      >
        <EyeOff size={16} />
        <span>Hide interface</span>
      </button>

      {#if showImport}
        <button
          class="menu-item"
          role="menuitem"
          onclick={() => uiState.openImport()}
        >
          <Download size={16} />
          <span>Import a layout</span>
        </button>
      {/if}

      <!--
        Present in preview too, unlike Import: it changes how the app behaves
        rather than what board is loaded, so there is nothing about a shared
        layout that should put it out of reach.
      -->
      <button
        class="menu-item"
        role="menuitem"
        onclick={() => uiState.openSettings()}
      >
        <Settings size={16} />
        <span>Settings</span>
      </button>

      <div class="menu-divider"></div>

      <DonateButton variant="menu" />
    </div>
  {/if}
</div>

<style>
  .overflow-wrap {
    position: relative;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tap);
    height: var(--tap);
    background: transparent;
    /*
     * The same hairline its neighbours in the bar carry; transparent, it would
     * leave the header reading as two bordered buttons and one floating glyph.
     * `.icon-btn.open` below still takes the neon, because an open menu is a
     * selection and that is what neon means.
     */
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--dur-fast);
  }

  .icon-btn:hover,
  .icon-btn.open {
    background: var(--neon-bg);
    border-color: var(--neon-dim);
    color: var(--neon);
  }

  .menu {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    min-width: 250px;
    background: var(--surface-panel-solid);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius);
    padding: 0.75rem;
    transition:
      background var(--dur) var(--ease),
      border-color var(--dur) var(--ease);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    animation: menu-in var(--dur-fast) var(--ease);
    /*
     * Bounded by what is under the header, and scrolls inside it.
     *
     * This list only grows — Settings, Save as image and Hide interface are
     * all on it, and on a phone it also takes in the map steppers and Share.
     * Unbounded it simply runs off the bottom of the screen: the page cannot
     * scroll (`html, body { overflow: hidden }` in `app.css`) and this is
     * absolutely positioned, so rows past the fold are not merely awkward to
     * reach, they are unreachable.
     *
     * `--header-clearance` is the header's measured bottom edge, published on
     * `.app-shell`, so the cap tracks a bar that is 57px on a phone and 62px
     * on a desktop rather than a guess at either. It is a slightly
     * conservative anchor — the menu hangs off the button, whose bottom sits
     * a little above the bar's — which errs the right way.
     */
    max-height: calc(
      100dvh - var(--header-clearance, 4.5rem) - var(--safe-bottom) - 1.5rem
    );
    overflow-y: auto;
    /* A flick that runs out of menu must not drag the board behind it. */
    overscroll-behavior: contain;
  }

  /*
   * Same reminder as every other panel — see `--anomaly-panel-rgb` in
   * `app.css`. Re-points the inherited tokens rather than restyling each row,
   * the idiom `ConfigSidebar` and `BoardStatsCard` already use, so a menu item
   * added later follows the ground without learning anomalies exist.
   */
  .menu.anomalous {
    background: var(--anomaly-panel-solid);
    border-color: var(--anomaly-border-neon);
    --text: var(--anomaly-text);
    --text-muted: var(--anomaly-text-muted);
    --text-dim: var(--anomaly-text-dim);
    --border: var(--anomaly-border);
  }

  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .menu-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .menu-title {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    font-weight: 700;
  }

  .menu-divider {
    height: 1px;
    background: var(--border);
    margin: 0.15rem 0;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    min-height: var(--tap);
    padding: 0 0.6rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: var(--fs-md);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast);
  }

  /*
   * Menu rows are neutral. Neon would say "selected" of rows none of which
   * are, and singling one out in amber would borrow the board's idle colour.
   * Nothing here is a selection — they are all just actions. See the colour
   * law in `app.css`.
   */
  .menu-item:hover {
    background: var(--surface-raised);
  }

  /* Disabled, not hidden: the row is mid-action, and a row that vanished
     while the picture was being made would move everything under it. */
  .menu-item:disabled {
    color: var(--text-dim);
    cursor: default;
  }

  .menu-item:disabled:hover {
    background: transparent;
  }
</style>
