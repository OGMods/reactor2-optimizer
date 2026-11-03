<script lang="ts">
  import { formatNumber } from "@reactor2/solver";
  import type { BuildingPricing } from "../../simulation/islandStats";
  import type { BuildingDefinition } from "../../types";
  import { asset } from "../../utils";

  interface Props {
    building: BuildingDefinition;
    upgradeLevel: number;
    /** Its price and copies across every island — see `buildingPricing`. */
    pricing: BuildingPricing;
    isActive: boolean;
    onSelect: () => void;
  }

  let { building, upgradeLevel, pricing, isActive, onSelect }: Props = $props();

  /*
   * The chip has room for the next copy's price and the count, which are what
   * a player buying one needs; the base price is in the tooltip and on the
   * Buildings tab's card.
   */
  let title = $derived(
    `${building.name}\nNext copy: ${formatNumber(pricing.next)}\n` +
      `Base price: ${formatNumber(pricing.base)}\n` +
      `Built on all islands: ${pricing.built}`,
  );
</script>

<button
  class="bld-item-btn"
  class:active={isActive}
  onclick={onSelect}
  {title}
  aria-pressed={isActive}
>
  <div class="icon-wrapper">
    <!-- Decorative: the name is already in the adjacent label. -->
    <img src={asset(`icons/${building.id}.webp`)} alt="" class="bld-icon" />
  </div>
  <span class="bld-name">{building.name}</span>
  <span class="bld-level"
    >Lvl {upgradeLevel + 1}{#if pricing.built > 0}<span class="bld-built"
        >&nbsp;×{pricing.built}</span
      >{/if}</span
  >
  <span class="bld-price">
    <img
      src={asset("icons/icon_cash.webp")}
      alt="Next copy"
      class="cash-icon"
    />
    {formatNumber(pricing.next)}
  </span>
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
    white-space: nowrap;
  }

  .bld-built {
    font-weight: 600;
  }

  .bld-price {
    display: flex;
    align-items: center;
    gap: 2px;
    font-size: var(--fs-2xs);
    font-weight: 700;
    color: var(--text);
    white-space: nowrap;
  }

  .cash-icon {
    width: 11px;
    height: 11px;
    object-fit: contain;
  }
</style>
