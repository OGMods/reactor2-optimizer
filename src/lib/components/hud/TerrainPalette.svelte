<script lang="ts">
  import { editorState, layoutState } from "../../state";
  import {
    Layers,
    Boxes,
    Droplets,
    Building2,
    Eraser,
    Undo2,
  } from "lucide-svelte";
  import { OBSTACLE_TYPES } from "./ObstaclePalette.svelte";

  interface Props {
    /** Hands control to the building categories view in `HudToolbar`. */
    onEnterBuildings: () => void;
  }

  let { onEnterBuildings }: Props = $props();

  // Derived from gridState rather than passed in, so this palette and the
  // toolbar's obstacle sub-panel read the same source of truth independently.
  let isObstacleActive = $derived(
    editorState.activeTool !== null &&
      OBSTACLE_TYPES.has(editorState.activeTool),
  );

  /*
   * Shipped islands are fixed maps, so the terrain brushes simply are not
   * offered on one — the row drops to Erase and Buildings, the only two moves
   * the player actually has there. Showing them disabled instead would fill
   * the phone's thumb row with three dead buttons.
   */
  let canPaint = $derived(layoutState.canEditTerrain);

  /*
   * Clearing an obstacle is the one destructive move a fixed island allows,
   * and this is what keeps it from being one-way — but it appears only once
   * there is something to put back, so the control is absent on an untouched
   * board rather than sitting there permanently disabled.
   */
  let restorable = $derived(layoutState.restorableObstacles.length);

  function selectGrass() {
    editorState.selectTool("grass");
  }

  function selectObstaclesMode() {
    editorState.selectTool(isObstacleActive ? editorState.activeTool : "rock");
  }

  function selectWater() {
    editorState.selectTool("water");
  }
</script>

{#if canPaint}
  <button
    class="tool-btn grass-btn"
    class:active={editorState.activeTool === "grass"}
    onclick={selectGrass}
    aria-pressed={editorState.activeTool === "grass"}
  >
    <span class="mode-icon"><Layers size={18} /></span>
    <span class="tool-label">Grass</span>
  </button>

  <div class="toolbar-divider"></div>

  <button
    class="tool-btn obs-mode-btn"
    class:active={isObstacleActive}
    onclick={selectObstaclesMode}
    aria-pressed={isObstacleActive}
  >
    <span class="mode-icon"><Boxes size={18} /></span>
    <span class="tool-label">Obstacles</span>
    {#if isObstacleActive}
      <span class="sub-indicator">▲</span>
    {/if}
  </button>

  <div class="toolbar-divider"></div>

  <button
    class="tool-btn water-btn"
    class:active={editorState.activeTool === "water"}
    onclick={selectWater}
    aria-pressed={editorState.activeTool === "water"}
  >
    <span class="mode-icon"><Droplets size={18} /></span>
    <span class="tool-label">Clear</span>
  </button>

  <div class="toolbar-divider"></div>
{/if}

<!--
  Erase has its own mode because right-click — the only way to remove a
  placed building — has no touch equivalent.
-->
<button
  class="tool-btn erase-btn"
  class:active={editorState.eraseMode}
  onclick={() => editorState.toggleErase()}
  aria-pressed={editorState.eraseMode}
>
  <span class="mode-icon"><Eraser size={18} /></span>
  <span class="tool-label">Erase</span>
</button>

{#if restorable > 0}
  <div class="toolbar-divider"></div>

  <button
    class="tool-btn restore-btn"
    class:active={editorState.restoreMode}
    onclick={() => editorState.toggleRestore()}
    aria-pressed={editorState.restoreMode}
    title="Show the obstacles you cleared and tap one to put it back"
  >
    <span class="mode-icon"><Undo2 size={18} /></span>
    <span class="tool-label">Restore</span>
    <span class="count">{restorable}</span>
  </button>
{/if}

<div class="toolbar-divider"></div>

<button class="tool-btn bld-mode-btn" onclick={onEnterBuildings}>
  <span class="mode-icon"><Building2 size={18} /></span>
  <span class="tool-label">Buildings</span>
</button>

<style>
  /*
   * The `.tool-btn` / `.toolbar-divider` / `.mode-icon` / `.tool-label` base
   * rules live in HudToolbar.svelte (scoped under `.hud-toolbar`) so the two
   * palettes and the category buttons share one definition. Only the
   * terrain-specific modifiers belong here.
   */
  /* Room for the ▲ sub-panel indicator pinned at the right edge. */
  .obs-mode-btn {
    padding-right: 1.5rem;
  }

  /* How many clearances are reversible — the whole point of the control. */
  .count {
    font-size: var(--fs-2xs);
    font-weight: 700;
    line-height: 1;
    padding: 0.15rem 0.35rem;
    border-radius: var(--radius-pill);
    background: var(--surface-raised);
    color: inherit;
    font-variant-numeric: tabular-nums;
  }

  /*
   * The one tool that keeps a colour of its own, because it is the one tool
   * that destroys something. Two classes, so it outranks the shared
   * `.tool-btn.active` — see the note on that rule.
   */
  .erase-btn.active {
    background: var(--danger-bg);
    border-color: var(--danger-line);
    color: var(--danger);
  }

  .bld-mode-btn:hover {
    color: var(--text);
  }

  .sub-indicator {
    position: absolute;
    right: 0.7rem;
    top: 50%;
    transform: translateY(-50%);
    font-size: var(--fs-2xs);
    opacity: 0.7;
  }
</style>
