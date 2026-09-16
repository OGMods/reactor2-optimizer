<script lang="ts">
  import { editorState, configState } from "../../state";
  import {
    BUILDINGS,
    buildingCategory,
    type BuildingCategory,
  } from "@reactor2/solver";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import BuildingPaletteItem from "./BuildingPaletteItem.svelte";
  import { headlineValue } from "../statIcons";

  interface Props {
    category: BuildingCategory;
  }

  let { category }: Props = $props();

  /**
   * The unlocked buildings of this category, **strongest first**.
   *
   * The ribbon scrolls, and the catalogue is authored weakest-first, so the
   * building a player reaches for most — the best one they have unlocked —
   * was the one furthest along a row they had to drag to reach. Every other
   * one is a tier they have already outgrown and left unlocked.
   *
   * Sorted by the figure rather than reversed, because "reverse the table"
   * only reads as "strongest first" for as long as the table stays in tier
   * order, and it is generated. `headlineValue` is the same number the
   * sidebar's card prints for the building, resolved at the tier the player
   * has unlocked — so the palette's order and the card's figures cannot
   * disagree. Comparing across categories never arises: the ribbon shows one.
   */
  let enabledBuildings = $derived(
    BUILDINGS.filter(
      (b) =>
        buildingCategory(b.type) === category &&
        configState.isBuildingEnabled(b.id),
    ).sort(
      (a, b) =>
        headlineValue(b, configState.buildingUpgrades[b.id] ?? 0) -
        headlineValue(a, configState.buildingUpgrades[a.id] ?? 0),
    ),
  );
</script>

<div
  class="building-panel"
  role="toolbar"
  aria-label="Building selection"
  transition:fly={{ y: 8, duration: 180, easing: cubicOut }}
>
  <div class="ribbon">
    {#each enabledBuildings as bld (bld.id)}
      <BuildingPaletteItem
        building={bld}
        upgradeLevel={configState.buildingUpgrades[bld.id] ?? 0}
        isActive={editorState.selectedBuildingId === bld.id}
        onSelect={() => editorState.selectBuilding(bld.id)}
      />
    {:else}
      <div class="empty-msg">Unlock a component in Setup to place it</div>
    {/each}
  </div>
</div>

<style>
  /*
   * In normal flow inside `HudToolbar`'s stack, rather than positioned
   * absolutely at a hard-coded offset guessing the toolbar's height.
   */
  .building-panel {
    max-width: min(100%, 620px);
    background: var(--surface-sunken);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius-pill);
    padding: 0.4rem 0.5rem;
    box-shadow:
      0 0 30px var(--neon-faint),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /*
   * `.ribbon` (app.css) carries the scroll + snap behaviour and hides the
   * scrollbar. On a phone a visible 4px bar inside a 60px-tall strip is just
   * noise — the row scrolls by touch, and the cut-off item is the affordance.
   */
  .ribbon {
    gap: 0.4rem;
  }

  .empty-msg {
    font-size: var(--fs-sm);
    color: var(--text-dim);
    padding: 0.75rem 1rem;
    text-align: center;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .building-panel {
      width: 100%;
      border-radius: var(--radius-lg);
    }

    .empty-msg {
      white-space: normal;
    }
  }
</style>
