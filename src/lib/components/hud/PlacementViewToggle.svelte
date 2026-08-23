<script lang="ts">
  import { uiState } from "../../state";
  import { Hammer, Sparkles } from "lucide-svelte";

  /*
   * Switches the canvas between the two boards that can exist at once: the one
   * the user built by hand, and the one the last solve produced.
   *
   * It renders only while there is a solve to switch to — with none there is
   * one board, and a toggle with a dead half is worse than no toggle. That is
   * also why the solver half is never disabled here: the component is simply
   * absent instead.
   *
   * Two words and no figures: the card above already carries the power of
   * whichever board is showing, and repeating both here made a switch read
   * like a scoreboard.
   *
   * The left half says **Edit**, not "Yours". Ownership was the wrong axis
   * once the solver's board became read-only: both layouts are the player's,
   * and the difference that matters is that only one of them can be built on.
   * "Edit" names it, and it names what the tap does — the tools reappear.
   */
</script>

{#if uiState.hasSolverPlacements}
  <div class="view-toggle" role="group" aria-label="Which layout to show">
    <button
      class="view-btn"
      class:active={!uiState.showingSolver}
      onclick={() => uiState.setPlacementView("user")}
      aria-pressed={!uiState.showingSolver}
      title="Switch to your own layout, where you can build"
    >
      <span class="view-icon"><Hammer size={15} /></span>
      <span class="view-label">Edit</span>
    </button>

    <button
      class="view-btn"
      class:active={uiState.showingSolver}
      onclick={() => uiState.setPlacementView("solver")}
      aria-pressed={uiState.showingSolver}
      title="Show the layout the optimizer found (read-only)"
    >
      <span class="view-icon"><Sparkles size={15} /></span>
      <span class="view-label">Solver</span>
    </button>
  </div>
{/if}

<style>
  /*
   * Its own pill in the HUD stack rather than two more buttons in the mode
   * row: the row is already full at 360px, and this is not a tool — it does
   * not change what a tap on the board does, only which layout that board is
   * showing.
   *
   * Deliberately does not reuse `.tool-btn`; those are 44px-tall mode
   * switches, and a full second row of them would eat the map on a phone.
   */
  .view-toggle {
    display: flex;
    align-items: stretch;
    gap: 0.2rem;
    background: rgba(10, 14, 23, 0.92);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius-pill);
    padding: 0.25rem;
    box-shadow:
      0 0 30px rgba(0, 243, 255, 0.06),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .view-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    /* Below the 44px mode row, but still a comfortable thumb target. */
    min-height: var(--ctl);
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-pill);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-base);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color var(--dur-fast) ease,
      background var(--dur-fast) ease,
      border-color var(--dur-fast) ease;
  }

  .view-btn:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .view-icon {
    display: flex;
    align-items: center;
  }

  /*
   * One accent, not two. Amber and neon halves would make the colour say
   * which is picked as well — but the labels already say "Yours" and "Solver",
   * and amber is the board's word for an idle building, sitting two
   * centimetres from the board saying it. Selected is neon here as it is
   * everywhere; see the colour law in `app.css`.
   */
  .view-btn.active {
    background: var(--neon-bg);
    border-color: var(--neon-line);
    color: var(--neon);
    box-shadow: 0 0 14px var(--neon-glow);
  }

  @media (max-width: 640px) {
    .view-btn {
      padding: 0.3rem 0.55rem;
      font-size: var(--fs-sm);
    }
  }
</style>
