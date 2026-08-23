<script lang="ts">
  import { solverState, uiState } from "../../state";
  import { SOLVE_MODE_LIST } from "../../worker/solveModes";
  import { Info } from "lucide-svelte";

  /*
   * How the next run spends its time, offered as a choice rather than picked
   * for the user.
   *
   * The search is stochastic, so one 30s walk is a single sample and ten 10s
   * walks are ten — usually the better answer, and reliably the better
   * *shortlist*, since ties found by different attempts are pooled. What it
   * costs is wall-clock, and how much depends on the machine: the attempts go
   * through the same worker pool the islands already use, so a browser
   * reporting eight cores overlaps most of them and a single-core one pays the
   * full serial price. That is the whole reason the estimate is printed here —
   * "10 × 10s" is not a duration on its own.
   *
   * It sits directly above the Run button rather than inside the re-run dialog
   * because it has to be answerable on a first run too, when no dialog opens.
   * One line, because on a phone this row shares the sheet's `peek` detent
   * with the button it belongs to and every pixel it takes is map.
   */
  let estimate = $derived(solverState.estimatedRunMs);
  let disabled = $derived(solverState.isOptimizing);

  /** Seconds, whole — the figure is an estimate and tenths would oversell it. */
  function seconds(ms: number): string {
    return `~${Math.max(1, Math.round(ms / 1000))}s`;
  }
</script>

<div class="mode-row">
  <div class="modes" role="group" aria-label="Optimizer run length">
    {#each SOLVE_MODE_LIST as mode (mode.id)}
      <button
        class="mode"
        class:active={solverState.solveModeId === mode.id}
        aria-pressed={solverState.solveModeId === mode.id}
        {disabled}
        onclick={() => solverState.setSolveMode(mode.id)}
      >
        <span class="mode-label">{mode.label}</span>
        <span class="mode-sub">
          {#if solverState.solveModeId === mode.id && estimate > 0}
            {seconds(estimate)}
          {:else}
            {mode.shape}
          {/if}
        </span>
      </button>
    {/each}
  </div>

  <!--
    The row can say what each mode costs but not why several short searches
    beat one long one, and that is the part the choice actually turns on. It
    lives one tap away rather than in a tooltip, because on a phone this row
    sits in a bottom sheet with nothing beside it.
  -->
  <button
    class="info-btn"
    onclick={() => uiState.openSolveModeInfo()}
    aria-label="About run lengths"
    title="About run lengths"
  >
    <Info size={14} />
  </button>
</div>

<style>
  .mode-row {
    display: flex;
    align-items: stretch;
    gap: 0.3rem;
    margin-bottom: 0.45rem;
  }

  /*
   * Flex rather than equal grid columns so the picked mode can take the extra
   * room it needs. Its label swaps from "50 x 10s" to what the run will cost,
   * and an even split would truncate "~100s" to something that reads as a
   * different number.
   */
  .modes {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: 0.3rem;
  }

  .mode {
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.3rem 0.35rem;
    min-height: 1.9rem;
    border-radius: var(--radius);
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: var(--surface-raised);
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
    transition:
      border-color var(--dur-fast) ease,
      background var(--dur-fast) ease,
      color var(--dur-fast) ease;
  }

  .mode:hover:not(:disabled),
  .info-btn:hover {
    border-color: var(--neon-dim);
    color: var(--text);
  }

  .mode.active {
    flex-grow: 1.4;
    border-color: var(--neon);
    background: var(--neon-bg);
    color: var(--text);
  }

  .mode:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .mode-label {
    font-size: var(--fs-xs);
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }

  /* The shape until this mode is picked, then what it will actually cost. Both
     matter, but only one of them is a decision the user is still making. */
  .mode-sub {
    font-size: var(--fs-2xs);
    line-height: 1;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Deliberately not disabled during a run: the choice applies to the next one
     either way, and the explanation is worth reading while you wait. */
  .info-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 1.9rem;
    border-radius: var(--radius);
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: var(--surface-raised);
    color: var(--text-muted);
    cursor: pointer;
    transition:
      border-color var(--dur-fast) ease,
      color var(--dur-fast) ease;
  }

  @media (pointer: coarse) {
    .mode,
    .info-btn {
      min-height: var(--tap);
    }

    .info-btn {
      width: var(--tap);
    }
  }
</style>
