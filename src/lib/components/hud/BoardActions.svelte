<script lang="ts">
  import { configState, layoutState, solverState, uiState } from "../../state";
  import { Play, Redo2, Square, Undo2 } from "lucide-svelte";

  /**
   * Undo, Redo, and the app's primary action, docked in the HUD stack.
   *
   * **Run lives here rather than in the config panel**, and that is the point
   * of this component: touching any tool in the HUD dismisses that panel, so
   * the loop the app exists for — paint, then run — would cost two extra taps
   * every time round.
   *
   * What stays in the panel is `SolveModeSelector`: how long a run may take is
   * a setting chosen rarely and belongs beside the roster it applies to.
   * Starting the run is not a setting.
   *
   * Undo sits beside it because the two are the same kind of thing: neither
   * changes what a tap on the board does, both must be reachable at the moment
   * the board is being worked on, and on a phone that moment is exactly when
   * the panel is out of the way.
   */

  let running = $derived(solverState.isOptimizing);

  /*
   * Run goes purple while a rule change is in force — the game's colour for
   * anomalies, on the one control that starts a solve under them.
   *
   * It follows the *selection*, not Setup's Anomaly tab: the tab is where the
   * choice is made and is closed most of the time, while this is the standing
   * reminder that the run about to start is not an ordinary one. Stopping is
   * unaffected — a stop is destructive of the run in progress whatever rules it
   * was started under, so `--danger` still wins.
   */
  let anomalous = $derived(configState.hasAnomaly);

  /*
   * A press here must not also collapse the config panel.
   *
   * `HudToolbar` dismisses it on any `pointerdown` that bubbles out of the
   * stack, which is right for a tool — reaching for one means you are done
   * with the panel — but wrong here, and not merely as a matter of taste: at
   * the sheet's `peek` detent the HUD is *lifted* above the sheet, so
   * dismissing it drops this row by 176px between `pointerdown` and
   * `pointerup`. The button slides out from under the finger and the click
   * never lands.
   */
  const keepPanel = (e: PointerEvent) => e.stopPropagation();
</script>

<div class="board-actions">
  <!--
    The arrows belong to the board the *user* builds, and they are absent while
    the solver's is the one on screen. Undo there would edit a layout nobody is
    looking at — the change would land silently on the other board and the
    press would read as broken. Gone rather than greyed: this is a mode, not a
    momentarily empty history, and a row of dead controls beside Run is worse
    than a shorter row.

    Which is also why the "disabled, not hidden" note below still holds. It is
    about the empty-history case *within* the user's board, where the pair must
    stay findable so the way back is discoverable before it is needed.
  -->
  {#if !uiState.showingSolver}
    <button
      class="act"
      onpointerdown={keepPanel}
      onclick={() => layoutState.undo()}
      disabled={!layoutState.canUndo}
      aria-label="Undo"
      title="Undo (Ctrl+Z)"
    >
      <Undo2 size={16} />
    </button>

    <button
      class="act"
      onpointerdown={keepPanel}
      onclick={() => layoutState.redo()}
      disabled={!layoutState.canRedo}
      aria-label="Redo"
      title="Redo (Ctrl+Shift+Z)"
    >
      <Redo2 size={16} />
    </button>

    <div class="divider"></div>
  {/if}

  <button
    class="run"
    class:anomaly={anomalous}
    class:stopping={running}
    onpointerdown={keepPanel}
    onclick={() => uiState.requestSolve()}
  >
    {#if running}
      <Square size={14} fill="currentColor" />
      <span>STOP</span>
    {:else}
      <Play size={14} fill="currentColor" />
      <span>RUN</span>
    {/if}
  </button>
</div>

<style>
  /*
   * Its own pill in the HUD stack, matching `PlacementViewToggle` beside it:
   * these are not tools, so they do not join the 44px mode row, and a second
   * full row of that height would eat the map on a phone.
   */
  .board-actions {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    background: rgba(10, 14, 23, 0.92);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius-pill);
    padding: 0.25rem;
    box-shadow:
      0 0 30px var(--neon-faint),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .act {
    display: flex;
    align-items: center;
    justify-content: center;
    /* The same step as the view toggle's halves — below the mode row, still
       a comfortable thumb target. */
    min-width: var(--ctl);
    min-height: var(--ctl);
    padding: 0 0.4rem;
    border-radius: var(--radius-pill);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      color var(--dur-fast) ease,
      background var(--dur-fast) ease;
  }

  .act:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-raised);
  }

  /*
   * Disabled rather than hidden, unusually for this app — a control that comes
   * and goes moves the one beside it, and Run is the one beside it. The arrows
   * also have to be *findable* before there is anything to undo, or nobody
   * learns the board has a way back.
   */
  .act:disabled {
    color: var(--text-dim);
    opacity: 0.4;
    cursor: default;
  }

  .divider {
    width: 1px;
    height: 20px;
    background: var(--border);
    margin: 0 0.15rem;
    flex: 0 0 auto;
  }

  /*
   * The one solid control in the HUD. Everything around it is a mode or a
   * toggle; this is the thing the app is for, so it is the only one filled in.
   */
  .run {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-height: var(--ctl);
    padding: 0 0.75rem;
    border-radius: var(--radius-pill);
    border: none;
    background: var(--neon);
    color: var(--surface-void);
    font-size: var(--fs-base);
    font-weight: 700;
    letter-spacing: 0.5px;
    white-space: nowrap;
    cursor: pointer;
    /*
     * No outer glow. Flush against a panel edge a glow reads as depth, but
     * here the button is a child inset 5px inside its own pill, and a 12px
     * bloom washes straight over that inset — leaving it looking like it is
     * falling out of the container holding it. The pill already carries the
     * stack's shadow.
     */
    transition: background var(--dur-fast);
  }

  .run:hover {
    background: var(--neon-strong);
  }

  /* White rather than `--surface-void`: the fill is dark, not bright. */
  .run.anomaly {
    background: var(--anomaly-action);
    color: #ffffff;
  }

  .run.anomaly:hover {
    background: var(--anomaly-action-hover);
  }

  /* Stopping is destructive of the run in progress, so it takes `--danger`. */
  .run.stopping {
    background: var(--danger);
    color: #ffffff;
  }

  .run.stopping:hover {
    background: var(--danger-strong);
  }

  @media (pointer: coarse) {
    .act,
    .run {
      min-height: var(--tap);
    }

    .act {
      min-width: var(--tap);
    }
  }
</style>
