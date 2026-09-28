<script lang="ts">
  import { formatNumber } from "@reactor2/solver";
  import { asset } from "../../utils/assetUrl";
  import type { BuildingDefinition } from "../../types";
  import { headlineValue, statForType } from "../statIcons";

  interface Props {
    bld: BuildingDefinition;
    enabled?: boolean;
    selectedUpgrade?: number;
    onToggle: () => void;
    onUpgradeChange: (level: number) => void;
  }

  let {
    bld,
    enabled = true,
    selectedUpgrade = 0,
    onToggle,
    onUpgradeChange,
  }: Props = $props();

  /*
   * What this building's headline figure is called and measured in. Shared
   * with the inspected tile in `BoardStatsCard`, which renders in this
   * card's idiom on purpose — see `components/statIcons.ts`.
   *
   * A `Record` rather than two switches over `buildingCategory`: a switch
   * carries a `default` arm no value can reach, since the category is a
   * three-member union with all three covered, so its fallbacks ("Value", and
   * a second copy of the energy icon) are dead code. A missing member fails to
   * typecheck instead.
   */
  let stat = $derived(statForType(bld.type));

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  }

  /*
   * A generator's card shows the power it puts out — its authored energy
   * figure, not a fixed fraction of the heat it takes in. That rule now lives
   * beside the icons in `statIcons.ts`, because the HUD's palette sorts by the
   * same number and a palette ordered by a different one from the figure this
   * card prints is a palette that looks shuffled.
   */
  let statVal = $derived(headlineValue(bld, selectedUpgrade ?? 0));
</script>

<div
  class="building-card"
  class:disabled={!enabled}
  role="button"
  tabindex="0"
  onclick={onToggle}
  onkeydown={handleKeyDown}
>
  <!--
      The edge stripe says the thing this list is actually for: whether the
      building is in the roster the solver may build from.

      Naming the category in colour instead — red for reactors, amber for
      generators, cyan for coolers — distinguishes nothing, because the tab bar
      above already filters the list to one category, so every stripe on screen
      is the same colour; and two of the three are the hues the board reserves
      for overheating and idle.
    -->
  <div class="unlock-stripe" class:on={enabled}></div>

  <div class="card-content">
    <!-- Main Section: Icon on Left, Title + Stats Stacked on Right -->
    <div class="main-row">
      <!-- Left: Building sprite with larger hex frame -->
      <div class="icon-frame">
        <div class="hex-bg">
          <img
            src={asset(`icons/${bld.id}.webp`)}
            alt={bld.name}
            class="building-sprite"
          />
        </div>
      </div>

      <!-- Right Column: Title on top, Stats underneath -->
      <div class="info-container">
        <div class="card-header">
          <span class="building-name">{bld.name}</span>
        </div>

        {#if bld.levels.length > 0}
          <div class="stats-container">
            <span class="stat-label">{stat.label}</span>
            <div class="stat-value-group">
              <img src={stat.icon} alt="Stat Icon" class="stat-icon-img" />
              <span class="stat-value">{formatNumber(statVal)}</span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Upgrades Row (Under main section) -->
    {#if bld.levels.length > 1}
      <div class="upgrades-bar" role="presentation">
        <span class="lbl">Level:</span>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="tiers" onclick={(e) => e.stopPropagation()}>
          {#each bld.levels as _, idx}
            <button
              type="button"
              class="tier-btn"
              class:active={selectedUpgrade === idx}
              disabled={!enabled}
              onclick={(e) => {
                e.stopPropagation();
                onUpgradeChange(idx);
              }}
            >
              {idx + 1}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .building-card {
    position: relative;
    /*
     * The card is a stacking context of its own.
     *
     * The three `z-index`es below — the stripe at 3, the icon at 2, the name
     * plate at 1 — are a *local* order: the name plate tucks behind the icon
     * that overlaps it, and the stripe sits over both. Without this they are
     * not local at all. `position: relative` with `z-index: auto` creates no
     * context, so they compete in whatever ancestor makes one, and the roster's
     * sticky control bar (`z-index: 1`) is in that same context — every card's
     * stripe, sprite and name then scrolls straight over the top of it. `isolation` rather than a `z-index: 0`, because the ordering wanted
     * here is the default one; only the containment was missing.
     */
    isolation: isolate;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, #2d3f5c 0%, #19232f 100%);
    border: 2px solid #0e1826;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 4px 10px rgba(0, 0, 0, 0.45);
    border-radius: var(--radius-md);
    padding: 2px 8px;
    gap: 4px;
    cursor: pointer;
    user-select: none;
    overflow: hidden;
    transition:
      transform 0.15s ease,
      border-color 0.15s ease,
      filter 0.15s ease;
  }

  .building-card:hover {
    border-color: #4f688e;
    transform: translateY(-1px);
  }

  .building-card.disabled {
    opacity: 0.5;
    filter: grayscale(0.6);
  }

  /* Category stripe inside container edge */
  .unlock-stripe {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    border-radius: var(--radius-md) 0 0 var(--radius-md);
    z-index: 3;
    background-color: var(--border);
    transition: background-color var(--dur-fast) var(--ease);
  }

  .unlock-stripe.on {
    background-color: var(--accent);
  }

  .card-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding-left: 2px;
  }

  /* Main Row layout */
  .main-row {
    display: flex;
    align-items: center;
    width: 100%;
    position: relative;
  }

  /* Increased Icon Frame Size */
  .icon-frame {
    position: relative;
    z-index: 2;
    flex-shrink: 0;
  }

  .hex-bg {
    width: 58px;
    height: 58px;
    background: url("/hex.webp") no-repeat center / contain;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .building-sprite {
    width: 42px;
    height: 42px;
    object-fit: contain;
  }

  /* Info Container */
  .info-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 3px;
    min-width: 0;
  }

  /* Title extending behind icon with reduced vertical padding */
  .card-header {
    position: relative;
    z-index: 1;
    margin-top: 4px;
    margin-left: -38px;
    padding: 0 8px 0 44px;
    background: #0e1d36;
    border-radius: var(--radius-sm);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
  }

  .building-name {
    font-size: 14px;
    font-weight: 700;
    color: #b6d6ff;
    letter-spacing: 0.2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }

  /* Compact Stat Container with no right padding (#385d7b) */
  .stats-container {
    background-color: #385d7b;
    border-radius: var(--radius-sm);
    padding: 0 0 0 6px;
    margin: 2px 0 4px 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .stat-label {
    font-size: 12px;
    font-weight: 600;
    color: #b5d5ff;
  }

  /* Value group fully covering the right end (#528aa8) */
  .stat-value-group {
    display: flex;
    align-items: center;
    gap: 4px;
    background-color: #528aa8;
    padding: 0px 8px;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    align-self: stretch;
  }

  .stat-icon-img {
    width: auto;
    height: 14px;
    object-fit: contain;
  }

  .stat-value {
    font-size: 12px;
    font-weight: 600;
    color: #b8d8ff;
  }

  /* Upgrades Row */
  .upgrades-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 3px;
    border-top: 1px dashed rgba(255, 255, 255, 0.1);
  }

  .lbl {
    font-size: var(--fs-2xs);
    color: #64748b;
    font-weight: 600;
    text-transform: uppercase;
  }

  .tiers {
    display: flex;
    gap: 3px;
  }

  .tier-btn {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #141c28;
    border: 1px solid #334866;
    color: var(--text-muted);
    font-size: var(--fs-2xs);
    font-weight: 700;
    border-radius: var(--radius-xs);
    cursor: pointer;
    transition: all var(--dur-fast) ease;
    padding: 0;
  }

  .tier-btn:hover:not(:disabled) {
    border-color: #3b82f6;
    color: #ffffff;
  }

  .tier-btn.active {
    border-color: #3b82f6;
    color: #ffffff;
    background: #2563eb;
    box-shadow: 0 0 6px rgba(59, 130, 246, 0.5);
  }

  .tier-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  @media (pointer: coarse) {
    /*
         * 18px tier chips are not hittable with a thumb. They wrap rather
         * than growing the card, since a building can carry several tiers.
         */
    .tiers {
      flex-wrap: wrap;
      gap: 6px;
    }

    .tier-btn {
      width: 34px;
      height: 34px;
      font-size: var(--fs-base);
    }
  }
</style>
