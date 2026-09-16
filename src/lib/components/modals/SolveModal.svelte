<script lang="ts">
  import { solverState, uiState } from "../../state";
  import { formatNumber } from "@reactor2/solver";
  import { Sparkles, Trash2 } from "lucide-svelte";
  import ModalShell from "./ModalShell.svelte";
  import { STAT_ICON } from "../statIcons";

  /*
   * Asked before a re-run, whenever there is already a layout to lose.
   *
   * The search is stochastic and the budget is short, so a second run genuinely
   * can come back below the first — and replacing a good layout with a worse
   * one is not something the board can undo. Rather than pick for the user,
   * this puts the two readings of "run it again" side by side: try to beat what
   * I have, or start over from nothing.
   *
   * The trigger is `uiState.requestSolve()`, which every Run control goes
   * through; dismissing (backdrop, Escape, Close) starts no run at all.
   */
  let current = $derived(solverState.optimizationResult?.totalPower ?? 0);
  let held = $derived(solverState.variantCount);
  /*
   * The run length is chosen beside the Run button, not here — this dialog is
   * about what happens to the layout already on screen. It still prints how
   * long the chosen shape will take, because that is the cost of finding out.
   */
  let mode = $derived(solverState.solveMode);
  let estimateSeconds = $derived(
    Math.max(1, Math.round(solverState.estimatedRunMs / 1000)),
  );
</script>

{#if uiState.activeModal === "solve"}
  <ModalShell title="Run again?" onClose={() => uiState.closeModal()}>
    <p class="lead">
      This island already has a layout at
      <strong>{formatNumber(current)}</strong>
      <img class="unit" src={STAT_ICON.energy} alt="energy" />. A {mode.label.toLowerCase()}
      run ({mode.shape}) takes about {estimateSeconds}s and does not always come
      back better.
      {#if held > 1}
        There {held === 2 ? "is" : "are"}
        {held - 1} other layout{held === 2 ? "" : "s"} at that power to cycle through.
      {/if}
    </p>

    <button class="choice keep" onclick={() => uiState.startSolve(true)}>
      <Sparkles size={16} />
      <span class="choice-text">
        <span class="choice-title">Keep the better one</span>
        <span class="choice-sub">
          The new layout has to beat {formatNumber(current)} to replace this one.
          One that ties it joins this island's shortlist instead.
        </span>
      </span>
    </button>

    <button class="choice discard" onclick={() => uiState.startSolve(false)}>
      <Trash2 size={16} />
      <span class="choice-text">
        <span class="choice-title">Discard this layout</span>
        <span class="choice-sub">
          Start fresh — whatever the run finds stands, higher or lower, and this
          island's other layouts go with it.
        </span>
      </span>
    </button>
  </ModalShell>
{/if}

<style>
  .lead {
    margin: 0;
    font-size: var(--fs-md);
    line-height: 1.5;
    color: var(--text-muted);
  }

  .lead strong {
    color: var(--neon);
    font-weight: 700;
  }

  .unit {
    width: 13px;
    height: 13px;
    object-fit: contain;
    vertical-align: -2px;
  }

  .choice {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    width: 100%;
    text-align: left;
    padding: 0.6rem 0.7rem;
    border-radius: var(--radius);
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: var(--surface-raised);
    color: var(--text);
    cursor: pointer;
    /* Both choices act immediately, so both must be a real touch target. */
    min-height: var(--tap);
    /*
     * And that `min-height` is exactly what makes the card shrinkable: it
     * replaces a flex item's automatic `min-height: auto`, which is the rule
     * that otherwise refuses to squash an item below its own content. In
     * `.panel-body`'s column these two cards are the tallest things in the
     * dialog, so on a short screen (a landscape phone) the flexbox took the
     * whole shortfall out of them, crushed both to 44px, and the sub-text
     * painted straight out through the border. The body is the scroller; the
     * cards keep their height and let it do its job.
     */
    flex-shrink: 0;
    transition:
      border-color var(--dur-fast) ease,
      background var(--dur-fast) ease;
  }

  .choice-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .choice-title {
    font-size: var(--fs-md);
    font-weight: 700;
  }

  .choice-sub {
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-muted);
  }

  /* The safe option reads as the default; the destructive one is not red until
     hovered, so the dialog does not open looking like a warning. */
  .choice.keep {
    border-color: var(--neon-dim);
  }
  .choice.keep:hover {
    border-color: var(--neon);
    background: var(--neon-bg);
  }

  .choice.discard:hover {
    border-color: var(--danger-line);
    background: var(--danger-bg);
    color: var(--danger-soft);
  }
</style>
