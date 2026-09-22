<script module lang="ts">
  import { OBSTACLE_TILE_TYPES, type TileType } from "../../types";

  interface ObstacleDef {
    type: TileType;
    label: string;
    icon: string;
  }

  const OBSTACLE_DEFS: ObstacleDef[] = [
    { type: "rock", label: "Rock", icon: "icons/icon_rocks.webp" },
    { type: "tree1", label: "Oak", icon: "icons/icon_trees1.webp" },
    { type: "tree2", label: "Pine", icon: "icons/icon_trees2.webp" },
    { type: "pond", label: "Pond", icon: "icons/icon_pond.webp" },
    {
      type: "transformer",
      label: "Transformer",
      icon: "icons/icon_transformer.webp",
    },
  ];

  /**
   * Which tile types count as "obstacles" for the toolbar's mode logic.
   * Exported so `TerrainPalette` and `HudToolbar` can tell whether the current
   * tool is an obstacle without owning a second copy of the list.
   *
   * Built from the canonical set in `types/grid.ts`, not from `OBSTACLE_DEFS`
   * above: that list is presentation (labels and icons), and deriving the
   * semantic answer from it would let the two drift the moment a type is
   * added without an icon. `layoutState` reads the same canonical set to work
   * out which cleared obstacles can be restored.
   */
  export const OBSTACLE_TYPES = new Set<TileType>(OBSTACLE_TILE_TYPES);
</script>

<script lang="ts">
  import { configState, editorState, layoutState } from "../../state";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";

  function selectObstacle(type: TileType) {
    editorState.selectTool(type);
  }

  /*
   * A board carries at most one transformer, so once it has one the brush
   * relocates it rather than adding another. Saying so on the button is the
   * difference between that reading as a feature and as a bug.
   */
  let hasTransformer = $derived(layoutState.findTransformer() !== null);

  function labelFor(def: ObstacleDef): string {
    return def.type === "transformer" && hasTransformer ? "Move" : def.label;
  }

  function titleFor(def: ObstacleDef): string {
    return def.type === "transformer"
      ? hasTransformer
        ? "Move the transformer — a map can only have one"
        : "Place the map's transformer"
      : def.label;
  }
</script>

<div
  class="obstacle-panel ribbon"
  class:anomalous={configState.hasAnomaly}
  role="toolbar"
  aria-label="Obstacle tools"
  transition:fly={{ y: 8, duration: 180, easing: cubicOut }}
>
  {#each OBSTACLE_DEFS as def (def.type)}
    <button
      class="obs-btn"
      class:active={editorState.activeTool === def.type}
      onclick={() => selectObstacle(def.type)}
      title={titleFor(def)}
      aria-label={titleFor(def)}
      aria-pressed={editorState.activeTool === def.type}
    >
      <div class="tile-icon-wrapper">
        <img src={def.icon} alt="" class="tile-icon" />
      </div>
      <span class="obs-label">{labelFor(def)}</span>
    </button>
  {/each}
</div>

<style>
  /*
   * In normal flow inside `HudToolbar`'s stack, rather than positioned
   * absolutely at a hard-coded offset guessing the toolbar's height.
   */
  .obstacle-panel {
    gap: 0.3rem;
    background: var(--surface-sunken);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border-neon);
    /* `--radius-lg`, not the pill the buttons inside it are not shaped like —
       see the note in `BuildingPalette`. */
    border-radius: var(--radius-lg);
    padding: 0.35rem 0.5rem;
    transition:
      background var(--dur) var(--ease),
      border-color var(--dur) var(--ease);
    box-shadow:
      0 0 30px var(--neon-faint),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /* Same reminder every other HUD panel carries — see `BuildingPalette`. */
  .obstacle-panel.anomalous {
    background: rgba(var(--anomaly-panel-rgb), 0.92);
    border-color: var(--anomaly-border-neon);
  }

  .obs-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
    /* Matches BuildingPaletteItem so all ribbons share one item size. */
    min-width: 60px;
    min-height: var(--tap-lg);
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    padding: 0.3rem 0.45rem;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition:
      background var(--dur-fast) ease,
      color var(--dur-fast) ease,
      border-color var(--dur-fast) ease;
  }

  .obs-btn:hover {
    background: rgba(255, 255, 255, 0.07);
    color: var(--text);
  }

  /* Selected is neon, as everywhere else — see the law in `app.css`. */
  .obs-btn.active {
    background: var(--neon-bg);
    border-color: var(--neon-line);
    color: var(--neon);
  }

  .tile-icon-wrapper {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tile-icon {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .obs-label {
    font-size: var(--fs-2xs);
    font-weight: 600;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .obstacle-panel {
      width: 100%;
    }
  }
</style>
