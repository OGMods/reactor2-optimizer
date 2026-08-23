<script lang="ts">
  import { solverState, uiState } from "../../state";
  import { SOLVE_MODE_LIST } from "../../worker/solveModes";
  import { Check } from "lucide-svelte";
  import ModalShell from "./ModalShell.svelte";

  /*
   * What the run-length choice actually means, and what each option costs on
   * this machine.
   *
   * It answers a question the control itself cannot: why several short
   * searches beat one long one, when the opposite is what everyone expects of
   * an optimizer. The short version is that the search is not a computation
   * running to completion — it is a random walk that cools, and a cooled walk
   * mostly polishes the basin it is already in.
   *
   * The rows are pickable rather than read-only. This is where the decision is
   * actually made, and closing the dialog to go and press the thing it just
   * explained is a step with nothing in it.
   */
  let poolSize = $derived(solverState.workerCount);
  let running = $derived(solverState.isOptimizing);

  /** Seconds, whole — the figure is an estimate and tenths would oversell it. */
  function seconds(ms: number): string {
    return `~${Math.max(1, Math.round(ms / 1000))}s`;
  }

  function choose(id: (typeof SOLVE_MODE_LIST)[number]["id"]) {
    solverState.setSolveMode(id);
    uiState.closeModal();
  }

  /** What each mode is *for*, as opposed to what it does. */
  const blurb: Record<string, string> = {
    quick:
      "One search. The fastest answer, and on a small island usually the same answer as the others.",
    deep: "Ten searches from ten different starting streams, best kept. The one to reach for when the layout matters.",
    max: "Fifty. Barely more power than Deep — but far more arrangements that tie it, which is what you cycle through.",
  };
</script>

{#if uiState.activeModal === "solveModes"}
  <ModalShell title="Run length" onClose={() => uiState.closeModal()}>
    <p class="lead">
      The optimizer does not compute the best layout — it walks toward one at
      random and cools as it goes. Past the first few seconds a walk mostly
      polishes the arrangement it already has, so a longer run is worth much
      less than <em>more</em> runs. Each option below is the same search repeated
      a different number of times; the best result per island is kept.
    </p>

    <div class="modes">
      {#each SOLVE_MODE_LIST as mode (mode.id)}
        <button
          class="mode"
          class:active={solverState.solveModeId === mode.id}
          aria-pressed={solverState.solveModeId === mode.id}
          disabled={running}
          onclick={() => choose(mode.id)}
        >
          <span class="mode-head">
            <span class="mode-name">
              {mode.label}
              {#if solverState.solveModeId === mode.id}
                <Check size={13} />
              {/if}
            </span>
            <span class="mode-cost">
              <span class="shape">{mode.shape}</span>
              <span class="est">{seconds(solverState.estimateRunMs(mode))}</span
              >
            </span>
          </span>
          <span class="mode-blurb">{blurb[mode.id]}</span>
        </button>
      {/each}
    </div>

    <p class="note">
      The second figure is what it should actually take here. Searches run in
      parallel — this browser gives {poolSize}
      {poolSize === 1 ? "worker" : "workers"}, shared across the map's islands —
      so fifty searches cost nothing like fifty times one.
    </p>

    <p class="note">
      Islands never affect each other, so the best result is taken island by
      island rather than for the board as a whole. Searches that finish level
      with each other all keep their layouts, which is why a longer run leaves
      you more equal-power boards to choose between.
    </p>

    {#if running}
      <p class="note running">
        A run is in flight. The length applies to the next one.
      </p>
    {/if}
  </ModalShell>
{/if}

<style>
  .lead,
  .note {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--text-muted);
  }

  .note {
    font-size: var(--fs-sm);
  }

  .note.running {
    color: var(--neon);
  }

  .lead em {
    color: var(--text);
    font-style: normal;
    font-weight: 700;
  }

  .modes {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .mode {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    width: 100%;
    text-align: left;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius);
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: var(--surface-raised);
    color: var(--text);
    cursor: pointer;
    /* Picking a mode acts immediately, so each row is a real touch target. */
    min-height: var(--tap);
    transition:
      border-color var(--dur-fast) ease,
      background var(--dur-fast) ease;
  }

  .mode:hover:not(:disabled) {
    border-color: var(--neon-dim);
  }

  .mode.active {
    border-color: var(--neon);
    background: var(--neon-bg);
  }

  .mode:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .mode-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .mode-name {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--fs-md);
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--neon);
  }

  .mode-cost {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--fs-sm);
    white-space: nowrap;
  }

  /* What the mode is, then what it costs here — the second is the one that
     changes from machine to machine, so it is the one that gets the emphasis. */
  .shape {
    color: var(--text-muted);
  }

  .est {
    color: var(--text);
    font-weight: 700;
  }

  .mode-blurb {
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-muted);
  }
</style>
