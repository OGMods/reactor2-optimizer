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
  class:anomalous={configState.hasAnomaly}
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
    /*
     * `--radius-lg`, not the stack's usual pill: a pill's corner radius tracks
     * half the container's height, and at this height (~70px) that curve is
     * far more aggressive than the `--radius-md` items inside it — their own
     * square-ish corners sat inside the sweep of the outer curve and read as
     * clipped by it. `--radius-pill` only reads right around a control that is
     * itself pill-shaped, like the buttons in `.hud-modes`.
     */
    border-radius: var(--radius-lg);
    padding: 0.4rem 0.5rem;
    transition:
      background var(--dur) var(--ease),
      border-color var(--dur) var(--ease);
    box-shadow:
      0 0 30px var(--neon-faint),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /*
   * The same reminder Header, Setup and Run carry — a building placed while
   * this ribbon is purple is rated under rules that are not the ordinary ones
   * the moment it lands.
   *
   * `--text-dim` goes with the ground: tuned against the navy panel, it reads
   * 3.5:1 on this one, and the empty-roster line it colours is not a disabled
   * control, so `app.css`'s exemption does not cover it.
   */
  .building-panel.anomalous {
    background: rgba(var(--anomaly-panel-rgb), 0.92);
    border-color: var(--anomaly-border-neon);
    --text-dim: var(--anomaly-text-dim);
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
    }

    .empty-msg {
      white-space: normal;
    }
  }
</style>
