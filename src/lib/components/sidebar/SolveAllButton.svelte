<script lang="ts">
  import { ListChecks } from "lucide-svelte";
  import { solverState, uiState } from "../../state";
  import { formatSpan } from "../../utils";

  /*
   * "Solve all islands" — see `uiState.solveAllIslands`.
   *
   * Where it sits depends on the layout. On a wide screen it is in Setup's
   * footer beside the run-length modes, under every tab, since it is a way of
   * running and the modes are what it runs with. On a phone the sheet's mode
   * row is in its peek strip, which has no room for a second, so it stays at
   * the head of the island list.
   *
   * Hidden, not disabled, whenever it cannot start: during any run (Setup is
   * gone then anyway), on a previewed board, or with a roster that makes no
   * power. Not the action colour: RUN is the one filled control in the app.
   *
   * The estimate is the run the current mode would take on the island on
   * screen, once per island. Islands differ in size, so it is a scale ("about
   * four minutes"), not a promise.
   */
  let estimate = $derived(
    formatSpan(
      (solverState.estimatedRunMs * uiState.solveAllTargets.length) / 1000,
    ),
  );
</script>

{#if uiState.canSolveAll}
  <button class="solve-all" onclick={() => uiState.solveAllIslands()}>
    <ListChecks size={14} />
    <span>Solve all islands</span>
    <span class="estimate">~{estimate}</span>
  </button>
{/if}

<style>
  .solve-all {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    height: var(--ctl);
    padding: 0 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .solve-all:hover {
    background: var(--surface-raised);
    border-color: var(--accent-dim);
  }
  .estimate {
    margin-left: auto;
    color: var(--text-dim);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  @media (pointer: coarse) {
    .solve-all {
      height: var(--tap);
    }
  }
</style>
