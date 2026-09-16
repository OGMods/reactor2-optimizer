<script lang="ts">
  import { configState, uiState } from "../../state";
  import { BUILDINGS, buildingCategory } from "@reactor2/solver";
  import { Cpu, Zap, Snowflake, Lock, Unlock } from "lucide-svelte";
  import { onDestroy } from "svelte";
  import BuildingUnlockCard from "./BuildingUnlockCard.svelte";
  import { createConfirmArm } from "../confirmArm.svelte";

  /**
   * "Lock All" empties the whole roster and `configState` keeps no history, so
   * it is the one control in this panel that destroys work with nothing behind
   * it. It asks twice, the same idiom as the template list's Delete and the
   * readout's Reset — a player who has met one knows what this one does.
   *
   * "Unlock All" is not armed: it only ever adds, and the way back from it is
   * the button beside it.
   */
  const confirm = createConfirmArm<"lockAll">();

  // The panel unmounts when the sidebar collapses, and now also when the Setup
  // switch changes tab; a live timer would be left poking at state that is gone.
  onDestroy(confirm.disarm);

  /*
   * No `onMount(configState.loadCatalog)` here. `ConfigState`'s constructor
   * already reads storage, so it would only re-read what is in memory — and
   * because the Setup switch mounts and unmounts this component, that re-read
   * would happen every time the tab is opened, overwriting live state from
   * storage for no reason at all.
   */

  let filteredBuildings = $derived(
    BUILDINGS.filter((b) => buildingCategory(b.type) === uiState.catalogTab),
  );
</script>

<div class="section-box">
  <!--
    The category switch stays put while the cards scroll under it. Scrolling
    with them, it would leave the screen after the third of the 24 cards under
    Reactors, so changing category would mean scrolling back up the length of
    the whole list to reach the control that replaces it.

    It is the *only* thing pinned here, which is the point — see the utility
    row below.

    No section title above it: the Setup switch two rows up already says
    "Buildings", and a heading that repeats the tab you just pressed is a row
    of a short panel spent saying nothing.
  -->
  <div class="list-controls">
    <div class="tabs-bar">
      <button
        class="tab-btn"
        class:active={uiState.catalogTab === "generator"}
        onclick={() => (uiState.catalogTab = "generator")}
      >
        <Cpu size={13} />
        <span>Generators</span>
      </button>
      <button
        class="tab-btn"
        class:active={uiState.catalogTab === "cooler"}
        onclick={() => (uiState.catalogTab = "cooler")}
      >
        <Snowflake size={13} />
        <span>Coolers</span>
      </button>
      <button
        class="tab-btn"
        class:active={uiState.catalogTab === "heat_producer"}
        onclick={() => (uiState.catalogTab = "heat_producer")}
      >
        <Zap size={13} />
        <span>Reactors</span>
      </button>
    </div>
  </div>

  <!--
    Outside the sticky strip, so it scrolls away with the cards.

    Pinning is for the control you reach for *while* reading the list, and that
    is the category switch. These two are a bulk edit you make once on the way
    in — worth having at the top of the list, not worth a permanent band across
    every screen of it.
  -->
  <div class="utility-row">
    <button class="action-btn" onclick={() => configState.unlockAll()}>
      <Unlock size={11} />
      <span>Unlock All</span>
    </button>
    <button
      class="action-btn"
      class:armed={confirm.armed === "lockAll"}
      title={confirm.armed === "lockAll"
        ? "Click again to lock every building"
        : "Lock every building"}
      onclick={() => {
        if (confirm.press("lockAll")) configState.lockAll();
      }}
    >
      <Lock size={11} />
      <span>{confirm.armed === "lockAll" ? "Sure?" : "Lock All"}</span>
    </button>
  </div>

  <div class="building-list">
    {#each filteredBuildings as bld (bld.id)}
      <BuildingUnlockCard
        {bld}
        enabled={configState.isBuildingEnabled(bld.id)}
        selectedUpgrade={configState.buildingUpgrades[bld.id] ?? 0}
        onToggle={() => configState.toggleBuilding(bld.id)}
        onUpgradeChange={(level) => configState.setUpgradeLevel(bld.id, level)}
      />
    {:else}
      <div class="empty-state">No buildings in this category.</div>
    {/each}
  </div>
</div>

<style>
  .section-box {
    margin-bottom: 1rem;
  }
  /*
   * Pinned to the top of `.scroll-body`, which is the scroller in both shells.
   *
   * `top` is the negative of that scroller's own `padding-top`, so the bar
   * lands flush against the top of the panel rather than 0.85rem down it with
   * a strip of scrolling cards showing above; the matching negative margins
   * take it out to the full width for the same reason, and its own padding
   * puts the inset back visually.
   *
   * The background has to be **opaque** — `--surface-panel` is 88% and the
   * sheet 97%, so either would leave the cards faintly legible through the
   * bar as they passed under it. `--surface-panel-solid` is the token that
   * already exists for exactly this (the overflow menu and every modal use
   * it), and the hairline under it means the strip reads as a header in both
   * shells rather than having to match two different backdrops.
   */
  .list-controls {
    position: sticky;
    top: -0.85rem;
    z-index: 1;
    margin: -0.85rem -1rem 0.75rem;
    padding: 0.85rem 1rem 0.5rem;
    background: var(--surface-panel-solid);
    border-bottom: 1px solid var(--neon-faint);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .empty-state {
    font-size: var(--fs-base);
    color: var(--text-dim);
    text-align: center;
    padding: 1.5rem 0;
  }

  .tabs-bar {
    display: flex;
    background: rgba(10, 14, 23, 0.65);
    border: 1px solid var(--neon-faint);
    border-radius: var(--radius);
    padding: 3px;
    gap: 3px;
  }
  .tab-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    background: none;
    border: 1px solid transparent;
    color: var(--text-dim);
    font-size: var(--fs-sm);
    font-weight: 600;
    padding: 0.35rem 0.25rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease);
  }
  .tab-btn:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.02);
  }
  .tab-btn.active {
    background: var(--neon-faint);
    color: var(--neon);
    border-color: var(--border-neon);
  }

  .utility-row {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .action-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--dur-fast) ease;
  }
  .action-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.15);
    color: #ffffff;
  }

  /* `--danger` because this destroys something — the colour law's second
     reading of it, and the same one the template list's armed Delete takes. */
  .action-btn.armed,
  .action-btn.armed:hover {
    background: var(--danger);
    border-color: var(--danger);
    color: #ffffff;
  }

  .building-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  @media (pointer: coarse) {
    /*
     * A rung down the control ladder from the `--tap` floor, for two different
     * reasons.
     *
     * The tabs, because the bar they sit in does not scroll. As a row you pass
     * once on the way into the list its height would be charged to the list
     * once; pinned, it is charged against *every* screen of a roster 24 cards
     * long, and 44px of permanent chrome is most of what pinning it is meant
     * to hand back. They keep `--ctl`, being the control most often pressed
     * here.
     *
     * The utility row, because it is secondary and sizing it below the tabs
     * is what keeps the top of the list legible as controls-then-actions
     * rather than two rows of equal weight. `--ctl-sm` puts it furthest under
     * the 44px touch guideline, which is a real trade — "Lock All" undoes a
     * whole roster and `configState` keeps no history — and it is why that
     * one button is armed. The safety is bought back with a second press
     * rather than with pixels off every screen of the list.
     */
    .tab-btn {
      min-height: var(--ctl);
    }

    .action-btn {
      min-height: var(--ctl-sm);
      padding: 0 12px;
    }
  }
</style>
