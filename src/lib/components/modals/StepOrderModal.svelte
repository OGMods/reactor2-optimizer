<script lang="ts">
  import type { BuildingCategory } from "@reactor2/solver";
  import { ChevronDown, ChevronUp } from "lucide-svelte";
  import { uiState } from "../../state";
  import { KIND_META } from "../hud/buildingKinds";
  import ModalShell from "./ModalShell.svelte";

  /*
   * The order step mode's "By kind" builds in: every building of the first
   * kind, then the second, then the third. Players build in different orders
   * — one asked for generators, then coolers, then reactors — so it is theirs
   * to set.
   *
   * A dialog rather than a row in the step bar: a row of three chips and two
   * swaps was cramped on a phone and said nothing about what it did, where
   * three full-width rows with up and down are the same control on a mouse
   * and a thumb. The rows are a draft: nothing changes, and nothing is planned
   * again, until "Use this order" — closing the dialog leaves the steps as
   * they were.
   */
  let draft = $state<BuildingCategory[]>([...uiState.stepKinds]);

  // Each opening starts from the order in use, not from an abandoned draft.
  $effect(() => {
    if (uiState.activeModal === "stepOrder") draft = [...uiState.stepKinds];
  });

  let rows = $derived(draft.map((kind) => ({ kind, ...KIND_META[kind] })));

  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    draft = next;
  }
</script>

{#if uiState.activeModal === "stepOrder"}
  <ModalShell title="Build by kind" onClose={() => uiState.closeModal()}>
    <p class="lead">
      The steps put down every building of one kind before the next, each kind
      row by row across the island. Choose the order you build in.
    </p>

    <ol class="kinds">
      {#each rows as { kind, label, icon: Icon }, i (kind)}
        <li class="kind">
          <span class="kind-no" aria-hidden="true">{i + 1}</span>
          <span class="kind-icon"><Icon size={18} /></span>
          <span class="kind-name">{label}</span>
          <span class="kind-tools">
            <button
              type="button"
              class="icon-btn"
              disabled={i === 0}
              aria-label="Build {label.toLowerCase()} earlier"
              onclick={() => move(i, -1)}
            >
              <ChevronUp size={18} />
            </button>
            <button
              type="button"
              class="icon-btn"
              disabled={i === rows.length - 1}
              aria-label="Build {label.toLowerCase()} later"
              onclick={() => move(i, 1)}
            >
              <ChevronDown size={18} />
            </button>
          </span>
        </li>
      {/each}
    </ol>

    <p class="lead small">
      The island makes little power until the last kind goes in, since a
      building needs its partners beside it to work. For the most power at every
      step, choose Most power instead.
    </p>

    <div class="actions">
      <button type="button" class="btn" onclick={() => uiState.closeModal()}
        >Cancel</button
      >
      <button
        type="button"
        class="btn primary"
        onclick={() => uiState.useStepKinds(draft)}>Use this order</button
      >
    </div>
  </ModalShell>
{/if}

<style>
  .lead {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--text-muted);
  }

  .lead.small {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .kinds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .kind {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.4rem 0.4rem 0.6rem;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  /* The upgrade plan's step number, the same idiom for "in this order". */
  .kind-no {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-pill);
    background: var(--accent-bg);
    color: var(--accent);
    font-size: var(--fs-2xs);
    font-weight: 700;
  }

  .kind-icon {
    display: flex;
    color: var(--text-muted);
  }

  .kind-name {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }

  .kind-tools {
    display: flex;
    gap: 0.2rem;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ctl);
    height: var(--ctl);
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
  }

  @media (hover: hover) {
    .icon-btn:hover:not(:disabled) {
      background: var(--surface-inset);
      color: var(--text);
    }
  }

  .icon-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn {
    flex: 1;
    min-height: var(--tap);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--fs-md);
    font-weight: 600;
    cursor: pointer;
  }

  @media (hover: hover) {
    .btn:hover {
      background: var(--surface-raised);
      color: var(--text);
    }
  }

  .btn.primary {
    background: var(--accent-bg);
    border-color: var(--accent-dim);
    color: var(--accent);
  }

  @media (pointer: coarse) {
    .icon-btn {
      width: var(--tap);
      height: var(--tap);
    }
  }
</style>
