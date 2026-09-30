<script lang="ts">
  import { findBuilding } from "@reactor2/solver";
  import { ChevronRight, ListOrdered } from "lucide-svelte";
  import { configState, uiState } from "../../state";

  /*
   * The upgrade plan's way in: one row at the top of the Buildings tab that
   * says what is planned and opens the editor.
   *
   * On the Buildings tab because a plan is a statement about buildings — the
   * tiers the roster below will hold next — and beside the roster is where a
   * player looking for "plan an upgrade" will look. A row rather than the
   * editor itself, because the editor wants room (sprites, tier rows,
   * reordering) and inline it would push the roster down on every visit for a
   * thing set once. Outside the sticky category bar, so it scrolls away with
   * the cards like the Unlock/Lock row does.
   */
  let steps = $derived(
    configState.upgradePlan.map((step, i) => ({
      name: findBuilding(step.buildingId)?.name ?? step.buildingId,
      level: step.level + 1,
      effective: configState.resolvedPlan.effective[i],
    })),
  );
  let active = $derived(configState.hasPlan);
</script>

<button
  type="button"
  class="plan-summary"
  class:active
  onclick={() => uiState.openUpgradePlan()}
>
  <ListOrdered size={15} />
  <span class="text">
    <span class="title">Upgrade plan</span>
    {#if steps.length === 0}
      <span class="sub">Solve for upgrades you're about to buy</span>
    {:else}
      {#each steps as s, i (i)}
        <span class="sub step" class:idle={!s.effective}>
          {i + 1}. {s.name} → Lv. {s.level}
        </span>
      {/each}
    {/if}
  </span>
  <ChevronRight size={15} />
</button>

<style>
  .plan-summary {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    margin-bottom: 0.6rem;
    padding: 0.5rem 0.6rem;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease);
  }

  .plan-summary:hover {
    border-color: var(--accent-dim);
  }

  /* A plan in force changes what every run does, so it is marked the way a
     selected control is. */
  .plan-summary.active {
    border-color: var(--accent-dim);
    color: var(--accent);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
    min-width: 0;
  }

  .title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
  }

  .sub {
    font-size: var(--fs-2xs);
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub.step {
    color: var(--text-muted);
  }

  .sub.idle {
    text-decoration: line-through;
    opacity: 0.7;
  }

  @media (pointer: coarse) {
    .plan-summary {
      min-height: var(--tap);
    }
  }
</style>
