<script lang="ts">
  import type { BuildingDefinition } from "../../types";
  import { asset } from "../../utils";

  interface Props {
    building: BuildingDefinition;
    upgradeLevel: number;
    isActive: boolean;
    onSelect: () => void;
  }

  let { building, upgradeLevel, isActive, onSelect }: Props = $props();
</script>

<button
  class="bld-item-btn"
  class:active={isActive}
  onclick={onSelect}
  title={building.name}
  aria-pressed={isActive}
>
  <div class="icon-wrapper">
    <!-- Decorative: the name is already in the adjacent label. -->
    <img src={asset(`icons/${building.id}.webp`)} alt="" class="bld-icon" />
  </div>
  <span class="bld-name">{building.name}</span>
  <span class="bld-level">Lvl {upgradeLevel + 1}</span>
</button>

<style>
  .bld-item-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    background: rgba(14, 23, 38, 0.6);
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 0.3rem 0.45rem;
    border-radius: var(--radius-md);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      background var(--dur-fast) ease,
      color var(--dur-fast) ease,
      border-color var(--dur-fast) ease;
    /* Matches ObstaclePalette's .obs-btn so every ribbon item is one size. */
    min-width: 60px;
    min-height: var(--tap-lg);
    justify-content: center;
  }

  .bld-item-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .bld-item-btn.active {
    background: var(--accent-bg);
    border-color: var(--accent-line);
    color: var(--accent);
    box-shadow: 0 0 12px var(--accent-glow);
  }

  .icon-wrapper {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .bld-icon {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .bld-name {
    font-size: var(--fs-2xs);
    font-weight: 600;
    white-space: nowrap;
    max-width: 70px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bld-level {
    font-size: var(--fs-2xs);
    color: var(--text-dim);
    font-weight: 700;
  }
</style>
