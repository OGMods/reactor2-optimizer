<script lang="ts">
  import {
    configState,
    editorState,
    layoutState,
    solverState,
    uiState,
  } from "../../state";
  import { ISLAND_TEMPLATES, MAX_CUSTOM_ISLANDS } from "@reactor2/solver";
  import type { IslandTemplate } from "../../types/building";
  import { Plus, RotateCcw, Trash2 } from "lucide-svelte";
  import { onDestroy } from "svelte";
  import { createConfirmArm } from "../confirmArm.svelte";

  /**
   * Both destructive actions — reset and delete — throw away a board the user
   * built, so both ask twice. Keyed by template id: a row shows only one of
   * the two buttons, so the id alone says which confirmation is live, and
   * arming a different row replaces it.
   */
  const confirm = createConfirmArm<string>();

  // The sidebar unmounts when collapsed; don't leave a timer poking at state.
  onDestroy(confirm.disarm);

  // loadTemplate restores that island's saved terrain AND placements, so
  // there is no clearPlacements() here — switching islands is not "discard".
  async function selectTemplate(template: IslandTemplate) {
    confirm.disarm();
    // A terrain brush held over from a custom island does nothing on a
    // shipped one, so the hand is emptied rather than left looking armed.
    editorState.clearHand();
    // A run belongs to the board it was launched from, and that board is about
    // to leave the screen. Its result is still filed under that island.
    solverState.stopOptimizer();
    await layoutState.loadTemplate(template, configState.buildingUpgrades);
    // Each island keeps its own solve, so this swaps which one is showing
    // rather than throwing anything away — which is what keeps switching
    // islands from costing the user a five-minute run.
    solverState.restore();
    // layoutState deliberately knows nothing about the renderer, so
    // recentering is the caller's job rather than loadTemplate's.
    uiState.recenterCanvas();
  }

  async function resetTemplate(template: IslandTemplate) {
    if (!confirm.press(template.id)) return;

    editorState.clearHand();
    // Reset *is* a discard, unlike a switch: the board this solve describes is
    // being thrown away, so the solve goes with it.
    solverState.stopOptimizer();
    solverState.clearResult();
    await layoutState.resetTemplate(template);
    uiState.recenterCanvas();
  }

  async function addCustomIsland() {
    const created = layoutState.addCustomIsland();
    if (created) await selectTemplate(created);
  }

  async function deleteCustomIsland(template: IslandTemplate) {
    if (!confirm.press(template.id)) return;

    const wasActive = layoutState.activeTemplateId === template.id;
    // Nothing will ever ask for this island's solve again.
    solverState.forgetSolve(template.id);
    layoutState.deleteCustomIsland(template.id);

    // The active board just stopped existing; land somewhere real.
    if (wasActive) {
      const fallback = layoutState.customTemplates[0] ?? ISLAND_TEMPLATES[0];
      if (fallback) await selectTemplate(fallback);
    }
  }
</script>

<div class="section-box">
  <!--
    No "Island Templates" heading: the Setup switch directly above says
    "Islands", and repeating it costs a row of a panel that is short on them.
    "My Islands" below stays — that one separates two lists rather than
    naming the section.
  -->
  <div class="template-list">
    {#each ISLAND_TEMPLATES as template (template.id)}
      {@const isModified = layoutState.isTemplateModified(template)}
      <div
        class="template-row"
        class:active={layoutState.activeTemplateId === template.id}
      >
        <button class="template-item" onclick={() => selectTemplate(template)}>
          <span class="name">{template.name}</span>
          {#if isModified}
            <span class="badge-modified">Modified</span>
          {/if}
        </button>

        {#if isModified}
          <button
            class="icon-btn reset-btn"
            class:armed={confirm.armed === template.id}
            title={confirm.armed === template.id
              ? "Click again to discard your changes"
              : "Reset to default template"}
            onclick={(e) => {
              e.stopPropagation();
              resetTemplate(template);
            }}
          >
            {#if confirm.armed === template.id}
              <span class="confirm-label">Sure?</span>
            {:else}
              <RotateCcw size={13} />
            {/if}
          </button>
        {/if}
      </div>
    {/each}
  </div>

  <div class="section-title custom-title">
    <span>My Islands</span>
    <span class="count" class:full={!layoutState.canAddCustomIsland}>
      {layoutState.customIslands.length}/{MAX_CUSTOM_ISLANDS}
    </span>
  </div>

  <div class="template-list">
    {#each layoutState.customTemplates as template (template.id)}
      <div
        class="template-row"
        class:active={layoutState.activeTemplateId === template.id}
      >
        <button
          class="template-item custom-item"
          onclick={() => selectTemplate(template)}
        >
          <span class="name">{template.name}</span>
        </button>

        <button
          class="icon-btn delete-btn"
          class:armed={confirm.armed === template.id}
          title={confirm.armed === template.id
            ? "Click again to delete permanently"
            : `Delete ${template.name}`}
          onclick={(e) => {
            e.stopPropagation();
            deleteCustomIsland(template);
          }}
        >
          {#if confirm.armed === template.id}
            <span class="confirm-label">Sure?</span>
          {:else}
            <Trash2 size={13} />
          {/if}
        </button>
      </div>
    {:else}
      <p class="empty-hint">No custom islands yet.</p>
    {/each}

    <button
      class="add-btn"
      disabled={!layoutState.canAddCustomIsland}
      title={layoutState.canAddCustomIsland
        ? "Create a blank island"
        : `You can keep ${MAX_CUSTOM_ISLANDS} custom islands at a time`}
      onclick={addCustomIsland}
    >
      <Plus size={14} />
      <span>New Island</span>
    </button>
  </div>
</div>

<style>
  .section-box {
    margin-bottom: 1.5rem;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--neon);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 0.75rem;
  }
  .custom-title {
    margin-top: 1.25rem;
    justify-content: space-between;
  }
  .count {
    font-size: var(--fs-xs);
    font-weight: 700;
    color: var(--text-dim);
    letter-spacing: 0.4px;
  }
  /* A limit reached is the one thing in this panel that warrants warn. */
  .count.full {
    color: var(--warn);
  }
  .template-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .template-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
  }
  .template-item {
    flex: 1;
    background: rgba(20, 28, 46, 0.45);
    border: 1px solid var(--neon-faint);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.85rem;
    text-align: left;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease);
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
  }
  .template-item:hover {
    background: rgba(20, 28, 46, 0.65);
    border-color: var(--neon-dim);
    transform: translateX(2px);
  }
  .template-row.active .template-item {
    background: var(--neon-bg);
    border-color: var(--neon);
    box-shadow: 0 0 10px var(--neon-glow);
  }
  .name {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text-muted);
    transition: color var(--dur-fast);
  }
  .template-row.active .name {
    color: var(--neon);
    text-shadow: 0 0 5px rgba(0, 243, 255, 0.4);
  }
  /*
   * "Modified" is a fact about the island, not a warning about it, and it was
   * wearing the warn colour beside a board that uses the same family to
   * report trouble. Neutral chip; the word carries the meaning.
   */
  .badge-modified {
    font-size: var(--fs-2xs);
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-dim);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    padding: 0.15rem 0.4rem;
    border-radius: var(--radius-xs);
    letter-spacing: 0.4px;
  }
  .icon-btn {
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
    color: var(--danger-soft);
    border-radius: var(--radius-sm);
    padding: 0.6rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all var(--dur-fast) ease;
  }
  .icon-btn:hover {
    background: rgba(255, 71, 87, 0.25);
    border-color: var(--danger);
    color: #ffffff;
  }
  .icon-btn.armed {
    background: var(--danger);
    border-color: var(--danger);
    color: #ffffff;
    padding: 0.6rem 0.5rem;
  }
  .confirm-label {
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.3px;
    line-height: 1;
  }
  .custom-item {
    border-style: dashed;
    border-color: var(--neon-dim);
  }
  .custom-item:hover {
    border-style: solid;
    border-color: var(--neon-line);
  }
  .template-row.active .custom-item {
    border-style: solid;
    border-color: var(--neon);
  }
  .empty-hint {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-dim);
    font-style: italic;
    padding: 0.2rem 0.1rem;
  }
  .add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    background: rgba(0, 243, 255, 0.08);
    border: 1px dashed var(--neon-dim);
    border-radius: var(--radius-sm);
    color: var(--neon);
    padding: 0.55rem 0.85rem;
    font-size: var(--fs-base);
    font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast) ease;
  }
  .add-btn:hover:not(:disabled) {
    background: rgba(0, 243, 255, 0.18);
    border-style: solid;
    border-color: var(--neon-line);
  }
  .add-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    color: var(--text-dim);
    border-color: rgba(100, 116, 139, 0.35);
  }

  /*
   * Touch sizing. Keyed on `pointer: coarse` rather than a width breakpoint —
   * a touchscreen laptop needs the bigger targets at 1400px just as much as a
   * phone does, and a narrow desktop window does not.
   */
  @media (pointer: coarse) {
    .template-item,
    .icon-btn,
    .add-btn {
      min-height: var(--tap);
    }

    .icon-btn {
      min-width: var(--tap);
    }

    /* The hover nudge has no meaning without a hover. */
    .template-item:hover {
      transform: none;
    }
  }
</style>
