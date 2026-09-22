<script lang="ts">
  import { uiState } from "../../state";
  import { Hammer, Sparkles } from "lucide-svelte";

  /*
   * Switches the canvas between the two boards that can exist at once: the one
   * the user built by hand, and the one the last solve produced.
   *
   * It renders only while there is a solve to switch to: with none there is
   * one board, and a toggle with a dead half is worse than no toggle. That is
   * also why neither half is ever disabled here — the component is absent
   * instead.
   *
   * A run in flight is the one case it goes away without going: the board on
   * screen is the run's, which is what pressing RUN asked for, so the pill is
   * hidden — but on a wide screen it shares a centred row with the action
   * pill, and dropping out of the flow there re-centres RUN/STOP under the
   * cursor that just pressed it. So it keeps its box and gives up everything
   * else. On a compact viewport the line it sits on is not rendered at all
   * during a run (`HudToolbar`), so this never costs a phone a row.
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
  <div
    class="view-toggle"
    class:held={!uiState.canSwitchBoards}
    role="group"
    aria-label="Which layout to show"
  >
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
  /*
   * Invisible and out of reach while a run is in flight, but still taking up
   * its place in the row — see the note at the top. `visibility: hidden` is
   * the whole of it: it takes the pill out of the accessibility tree and out
   * of hit testing while leaving the box, which is exactly the three things
   * wanted, so there is no `inert` or `aria-hidden` beside it to keep in step.
   */
  .view-toggle.held {
    visibility: hidden;
  }

  .view-toggle {
    display: flex;
    align-items: stretch;
    gap: 0.2rem;
    background: rgba(var(--surface-panel-rgb), 0.92);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-pill);
    padding: 0.25rem;
    transition:
      background var(--dur) var(--ease),
      border-color var(--dur) var(--ease);
    box-shadow:
      0 0 30px rgba(0, 243, 255, 0.06),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /*
   * Same reminder every other HUD pill carries. `.view-btn.active` stays
   * `--accent` — this says which board is showing, not that the rules changed,
   * the same split Setup's own tabs keep against their purple ground.
   */
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
   * One accent, not two. An amber half against an accented one would make the
   * colour say which is picked as well — but the labels already say "Edit" and
   * "Solver", and amber is the board's word for an idle building, sitting two
   * centimetres from the board saying it. Selected takes `--accent` here as it
   * does everywhere; see the colour law in `app.css`.
   */
  .view-btn.active {
    background: var(--accent-bg);
    border-color: var(--accent-line);
    color: var(--accent);
    box-shadow: 0 0 14px var(--accent-glow);
  }

  @media (max-width: 640px) {
    .view-btn {
      padding: 0.3rem 0.55rem;
      font-size: var(--fs-sm);
    }
  }
</style>
