<script lang="ts">
  import { editorState, uiState, viewportState } from "../../state";
  import type { BuildingCategory } from "../../data";
  import {
    ArrowLeft,
    Cpu,
    SlidersHorizontal,
    Snowflake,
    Zap,
  } from "lucide-svelte";
  import BoardActions from "./BoardActions.svelte";
  import BuildingPalette from "./BuildingPalette.svelte";
  import ObstaclePalette, { OBSTACLE_TYPES } from "./ObstaclePalette.svelte";
  import PlacementViewToggle from "./PlacementViewToggle.svelte";
  import TerrainPalette from "./TerrainPalette.svelte";

  let hudMode = $state<"tiles" | "buildings">("tiles");
  /**
   * Which category's ribbon is open, or `null` for none.
   *
   * Nullable because pressing the open one closes it: the ribbon is a row of
   * chrome ~62px tall over a board the player is trying to see, and the only
   * other way to be rid of it is to leave buildings mode altogether — which
   * also puts the brush down and takes the three category buttons with it.
   * Closing it is the same press that opened it, which is how every other mode
   * button in this stack behaves (`selectTool`, `selectBuilding`).
   */
  let activeBuildingCategory = $state<BuildingCategory | null>("generator");

  let showObstaclePanel = $derived(
    hudMode === "tiles" &&
      editorState.activeTool !== null &&
      OBSTACLE_TYPES.has(editorState.activeTool),
  );

  function enterBuildingsMode() {
    editorState.activeTool = null;
    hudMode = "buildings";
  }

  function exitBuildingsMode() {
    hudMode = "tiles";
    editorState.selectBuilding(null);
  }

  function selectCategory(cat: BuildingCategory) {
    const closing = activeBuildingCategory === cat;
    activeBuildingCategory = closing ? null : cat;
    /*
     * Closing the ribbon puts the brush down with it. A building selected from
     * a palette that is no longer on screen is a hand nothing shows you are
     * holding, and a tap on the board would place it — the same reason the
     * solver-board effect below calls `clearHand`.
     */
    if (closing) editorState.selectBuilding(null);
  }

  /*
   * The stack never rides above a peeking sheet, because it is never on screen
   * at the same time as one — `App.svelte` unmounts it whenever the sheet is
   * open. That is also why `hudHeight` has to be cleared on the way out: it is
   * an inset the canvas and the corner readout budget for, and a stale one
   * reserves room for a bar that is not there.
   */
  /*
   * Publish the stack's real height so anything anchoring above it — the
   * touch inspector, the sheet's reopen tab — can clear it exactly, instead
   * of guessing at an offset that breaks when a ribbon row appears.
   */
  let measuredHeight = $state(0);

  $effect(() => {
    uiState.hudHeight = measuredHeight;
    return () => {
      uiState.hudHeight = 0;
    };
  });

  /*
   * Reaching for a tool means the user is done with the config panel, so it
   * gets out of the way — the docked sidebar folds.
   *
   * **On a phone this is now a backstop and nothing more.** The two can no
   * longer share the screen: `App.svelte` unmounts this whole stack while the
   * sheet is open, so if a tool is reachable the sheet is already closed and
   * the compact branch below is a no-op. It is kept for the frame during a
   * resize where the viewport class and the detent can still disagree.
   *
   * On a wide screen it does real work. The sidebar is 380px pinned to the
   * left edge while this stack centres itself in what is left, so below
   * roughly 1200px the two genuinely overlap and the panel sits on top
   * (`--z-sheet` outranks `--z-hud`). Folding it is what keeps the left half
   * of the tool row reachable.
   *
   * `pointerdown` on the container catches everything inside it — mode
   * buttons, palette items, and a flick that scrolls a ribbon. Events from
   * descendants still bubble through, because `pointer-events: none` only
   * stops this element being a hit target itself.
   */
  /*
   * Nothing may stay in the hand across a switch to the solver's board. The
   * tools are unmounted there, so a brush held from a moment earlier would be
   * invisible *and* still selected when the user came back — and `PixiCanvas`
   * would be refusing its taps in the meantime for reasons nothing on screen
   * explains.
   */
  $effect(() => {
    if (uiState.showingSolver) {
      editorState.clearHand();
      hudMode = "tiles";
    }
  });

  function dismissConfigPanel() {
    if (viewportState.isCompact) {
      if (uiState.sheetDetent !== "closed") uiState.setSheetDetent("closed");
    } else {
      uiState.collapseSidebar();
    }
  }
</script>

<!--
 * The HUD is one bottom-anchored stack: a contextual ribbon on top, the
 * persistent mode row beneath it.
 *
 * Both palettes sit in normal flow inside this container, so the stack
 * measures itself. Positioned absolutely at `bottom: calc(3.5rem + 1.5rem)`
 * they would be guessing at this toolbar's height, which breaks silently the
 * moment the buttons grow to a 44px touch target.
-->
<!--
  svelte-ignore a11y_no_static_element_interactions
  The rule guards against a <div> impersonating a button. This one is a layout
  stack that merely *observes* pointer activity to dismiss the sheet; every
  actual control inside it is a real <button>, and the container itself is not
  focusable or activatable by design.
-->
<div
  class="hud"
  bind:clientHeight={measuredHeight}
  onpointerdown={dismissConfigPanel}
>
  <!--
    Top of the stack, above any palette ribbon: none of this is a tool, and it
    stays put as the ribbon underneath opens and closes.

    The view toggle is placed twice on purpose, and the `{#if}` pair is the
    whole of the difference between the two layouts. On a wide screen it sits
    beside the board actions in one centred row. On a phone it cannot: Setup
    joins that row there, and Setup + toggle + actions is 425px of pills in
    374px of screen, so the toggle takes its own centred line above them and
    the other two take the ends of the row below. It renders itself away
    entirely when there is no solve to switch to, in which case neither line
    costs anything.
  -->
  {#if viewportState.isCompact && uiState.hasSolverPlacements}
    <!--
      Right-aligned, not centred. Centred it sat in the middle of the line
      above Setup and Run, which are pinned to opposite edges — three pills in
      a triangle, none of them apparently related to the others. Sharing an
      edge with the action pill below reads as one stack of board controls,
      and leaves Setup alone on the other side, which is what it is.

      Rendered on the same condition the toggle itself uses, so an empty row
      never contributes its gap to the stack's measured height.
    -->
    <div class="view-row"><PlacementViewToggle /></div>
  {/if}

  <div class="hud-top">
    {#if viewportState.isCompact}
      <!--
        Setup lived in its own floating tab pinned to the bottom-right corner,
        stacked directly above this row. Two bottom-right pills on two lines
        read as one control that had grown a second head; they are siblings,
        so they sit on one line with the space between them saying so. Run
        takes the right — it is the primary action and the easier thumb reach.

        It opens the sheet at `full`, not `half`. Half spent 340px of a phone
        keeping the top of the board visible — but this row and every tool on
        it unmount for as long as the sheet is open at *any* detent, so what
        that bought was a view of a board nothing could touch, at the cost of
        more than half the list the user came to read. Setup is a task you
        finish and leave, and the grabber still drags it back down.
      -->
      <button
        class="setup-btn"
        onclick={() => uiState.setSheetDetent("full")}
        onpointerdown={(e) => e.stopPropagation()}
      >
        <SlidersHorizontal size={16} />
        <span>Setup</span>
      </button>
    {:else}
      <PlacementViewToggle />
    {/if}
    <BoardActions />
  </div>

  <!--
    Every editing tool is absent while the solver's layout is the one on
    screen, because that board cannot be edited — see the note on `readOnly` in
    `PixiCanvas`. Hidden rather than disabled, the same call the app makes for
    a shipped island's grid steppers and for a previewed board: a row of inert
    brushes is not a smaller interface, it is a broken-looking one.

    It also leaves the solve almost the whole screen, which is the state a
    player is in when they are reading a result rather than building.
  -->
  {#if !uiState.showingSolver}
    {#if showObstaclePanel}
      <ObstaclePalette />
    {:else if hudMode === "buildings" && activeBuildingCategory}
      <BuildingPalette category={activeBuildingCategory} />
    {/if}

    <div class="hud-modes ribbon" role="toolbar" aria-label="Editing tools">
      {#if hudMode === "tiles"}
        <TerrainPalette onEnterBuildings={enterBuildingsMode} />
      {:else}
        <!-- Building Categories View -->
        <button class="tool-btn back-btn" onclick={exitBuildingsMode}>
          <span class="mode-icon"><ArrowLeft size={18} /></span>
          <span class="tool-label">Back</span>
        </button>

        <div class="toolbar-divider"></div>

        <button
          class="tool-btn cat-btn"
          class:active={activeBuildingCategory === "generator"}
          aria-pressed={activeBuildingCategory === "generator"}
          onclick={() => selectCategory("generator")}
        >
          <span class="mode-icon"><Cpu size={18} /></span>
          <span class="tool-label">Generators</span>
        </button>

        <div class="toolbar-divider"></div>

        <button
          class="tool-btn cat-btn"
          class:active={activeBuildingCategory === "cooler"}
          aria-pressed={activeBuildingCategory === "cooler"}
          onclick={() => selectCategory("cooler")}
        >
          <span class="mode-icon"><Snowflake size={18} /></span>
          <span class="tool-label">Coolers</span>
        </button>

        <div class="toolbar-divider"></div>

        <button
          class="tool-btn cat-btn"
          class:active={activeBuildingCategory === "heat_producer"}
          aria-pressed={activeBuildingCategory === "heat_producer"}
          onclick={() => selectCategory("heat_producer")}
        >
          <span class="mode-icon"><Zap size={18} /></span>
          <span class="tool-label">Reactors</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── The stack ─────────────────────────────────────────────────── */
  .hud {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    /* `padding-left` tracks the sidebar, which slides rather than snapping, and
       a HUD that jumped while the panel glided would read as a glitch. */
    transition: padding-left var(--dur) var(--ease);
    z-index: var(--z-hud);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    /*
     * Above the home indicator on iOS, with a sensible floor everywhere
     * else. This is what keeps the HUD clear of the gesture bar.
     */
    padding: 0 max(0.5rem, var(--safe-left)) max(0.75rem, var(--safe-bottom))
      max(0.5rem, var(--safe-right));
    /*
     * Centred on the space the docked sidebar leaves, not on the window.
     * `PixiCanvas` frames the board the same way; centred on the window with
     * the panel open, the two disagree by ~190px — the board sitting right of
     * centre while the tool row it belongs to stays left of it. Zero on a compact viewport, where
     * the panel is a sheet across the bottom and there is no column to clear.
     */
    padding-left: calc(
      max(0.5rem, var(--safe-left)) + var(--sidebar-clearance, 0px)
    );
    /*
     * The container spans the full width so its children can centre
     * themselves, but only the children should swallow pointer events —
     * otherwise this invisible strip would eat drags meant for the canvas.
     */
    pointer-events: none;
  }

  /*
   * The :global() here is load-bearing, not decoration.
   *
   * Two of this container's three possible children — ObstaclePalette and
   * BuildingPalette — are rendered by other components, so they carry their
   * own scope class rather than this one. Without :global(), Svelte scopes
   * both halves of the selector, and the child half then matches only the
   * mode row, which this component owns. The two palettes inherited
   * pointer-events:none from the container and became impossible to tap or
   * scroll at all. Same boundary caveat as the .tool-btn rules below.
   */
  .hud > :global(*) {
    pointer-events: auto;
    max-width: 100%;
  }

  /*
   * The top row: the view toggle beside the board actions, wrapping onto two
   * lines on a narrow phone rather than scrolling.
   *
   * It has to opt *out* of pointer events again, because the rule above turns
   * them back on for every direct child of `.hud` — without this its empty
   * middle would swallow drags meant for the canvas behind it.
   */
  .hud-top {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    max-width: 100%;
    pointer-events: none;
  }

  .hud-top > :global(*) {
    pointer-events: auto;
  }

  .view-row {
    display: flex;
    width: 100%;
    justify-content: flex-end;
    pointer-events: none;
  }

  .view-row > :global(*) {
    pointer-events: auto;
  }

  /*
   * The same pill the rest of the HUD stack wears. Neutral, not neon: it is
   * not a selection, and neon means selection everywhere in this app — see the
   * colour law in `app.css`. Neon here would say "chosen" of a panel that is
   * closed.
   */
  .setup-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-height: var(--tap);
    padding: 0 0.85rem;
    border-radius: var(--radius-pill);
    background: rgba(10, 14, 23, 0.92);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-neon);
    color: var(--text);
    font-size: var(--fs-sm);
    font-weight: 700;
    letter-spacing: 0.5px;
    white-space: nowrap;
    cursor: pointer;
    box-shadow:
      0 0 30px var(--neon-faint),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /*
   * Compact: the row spans the width and `margin-right: auto` on Setup pushes
   * everything after it to the far end, which is the gap the two are meant to
   * have between them. `justify-content: center` still governs the wide-screen
   * case above, where the row is only as wide as its contents.
   */
  @media (max-width: 1023px) {
    .hud-top {
      width: 100%;
    }

    .setup-btn {
      margin-right: auto;
    }
  }

  /* ── Mode row ──────────────────────────────────────────────────── */
  .hud-modes {
    gap: 0.25rem;
    background: rgba(10, 14, 23, 0.92);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius-pill);
    padding: 0.35rem 0.5rem;
    box-shadow:
      0 0 30px rgba(0, 243, 255, 0.06),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /*
   * Shared toolbar-button primitives. These are `:global` because the buttons
   * they style are rendered by `TerrainPalette` as well as by this component,
   * and Svelte's scoped CSS does not cross a component boundary. Deliberately
   * left at single-class specificity so that per-tool modifiers — `.cat-btn.active`
   * here, `.grass-btn.active` and friends in TerrainPalette — always outrank
   * them, which is the same base/modifier relationship these rules had when
   * every button lived in this one file.
   */
  :global(.toolbar-divider) {
    width: 1px;
    height: 28px;
    background: rgba(255, 255, 255, 0.08);
    margin: 0 0.1rem;
    flex: 0 0 auto;
  }

  :global(.tool-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    /* WCAG 2.5.5 minimum; a 36px row is under it. */
    min-height: var(--tap);
    min-width: var(--tap);
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    padding: 0.5rem 0.9rem;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition:
      color var(--dur-fast) ease,
      background var(--dur-fast) ease,
      border-color var(--dur-fast) ease;
    font-size: var(--fs-md);
    font-weight: 500;
    white-space: nowrap;
    position: relative;
  }

  :global(.tool-btn:hover) {
    color: var(--text);
    background: var(--surface-raised);
  }

  /*
   * One active rule for every tool in the HUD, including the ones
   * `TerrainPalette` renders into this row. Neon means selected; the icons say
   * which tool that is. See the colour law in `app.css`.
   *
   * Two classes, so a per-tool modifier in a child component still outranks
   * it — which is exactly how `.erase-btn.active` stays red.
   */
  :global(.tool-btn.active) {
    background: var(--neon-bg);
    border-color: var(--neon-line);
    color: var(--neon);
    box-shadow: 0 0 14px var(--neon-glow);
  }

  :global(.mode-icon) {
    display: flex;
    align-items: center;
  }

  :global(.tool-label) {
    font-size: var(--fs-md);
    font-weight: 600;
  }

  /* ── Phone ─────────────────────────────────────────────────────────
   * Edge-to-edge rather than a floating pill: at 320px a centred pill with
   * four labelled buttons has nowhere to go. Full-bleed plus the horizontal
   * scroll from `.ribbon` means the row always fits, and the labels survive.
   */
  @media (max-width: 640px) {
    .hud {
      gap: 0.4rem;
      padding-left: max(0.4rem, var(--safe-left));
      padding-right: max(0.4rem, var(--safe-right));
    }

    .hud-modes {
      width: 100%;
      border-radius: var(--radius-lg);
      padding: 0.3rem 0.35rem;
      /*
       * Centred while the tools fit, which on a shipped island they usually
       * do — its terrain brushes are not rendered, so the row can be as few as
       * three buttons and was leaving the whole right half of a full-bleed bar
       * empty.
       *
       * `safe` is what makes centring usable here rather than a trap: when the
       * row *does* overflow, centred content spills equally off both ends and
       * the first button becomes unreachable, because a scroll container
       * cannot scroll back past its start edge. `safe center` falls back to
       * `flex-start` in exactly that case, so a long row still scrolls from
       * its first tool.
       */
      justify-content: safe center;
    }

    :global(.tool-btn) {
      padding: 0.5rem 0.7rem;
      gap: 0.35rem;
    }

    :global(.tool-label) {
      font-size: var(--fs-base);
    }
  }

  /* Very narrow: drop the divider rules rather than the labels. */
  @media (max-width: 360px) {
    :global(.toolbar-divider) {
      display: none;
    }
  }
</style>
