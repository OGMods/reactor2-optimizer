<script lang="ts">
  import {
    buildingCategory,
    findBuilding,
    type BuildingCategory,
  } from "@reactor2/solver";
  import { uiState } from "../../state";
  import { KIND_META } from "./buildingKinds";

  /*
   * Picks one kind of building out of the solver's board. A solve on a large
   * island is a hundred buildings, and a player copying it into the game
   * builds one kind at a time: pressed, a kind stays at full strength and
   * every other building fades (`GridRenderer.setFocus`), so the eye finds
   * every cooler without hunting. Pressed again, the board is whole.
   *
   * Faded rather than hidden: a tile another kind will take must still read
   * differently from a free one, or the player puts a cooler where a reactor
   * goes. Each chip carries its count on the board on screen — in step mode,
   * the board after the step being looked at.
   *
   * The same three groups, icons and order as the Edit board's building
   * ribbon, so the two read as one vocabulary.
   */
  const KINDS = (["generator", "cooler", "heat_producer"] as const).map(
    (kind) => ({ kind, ...KIND_META[kind] }),
  );

  let counts = $derived.by(() => {
    const n: Record<BuildingCategory, number> = {
      generator: 0,
      cooler: 0,
      heat_producer: 0,
    };
    for (const p of uiState.visiblePlacements) {
      const type = findBuilding(p.buildingId)?.type;
      if (type) n[buildingCategory(type)]++;
    }
    return n;
  });
</script>

<div class="kind-filter" role="group" aria-label="Pick out one kind">
  {#each KINDS as { kind, label, icon: Icon } (kind)}
    <button
      type="button"
      class="kind-btn"
      class:active={uiState.kindFilter === kind}
      aria-pressed={uiState.kindFilter === kind}
      aria-label={`${label}: ${counts[kind]}`}
      title={uiState.kindFilter === kind
        ? "Show every building"
        : `Pick out the ${label.toLowerCase()}`}
      onclick={() => uiState.setKindFilter(kind)}
    >
      <span class="kind-icon"><Icon size={15} /></span>
      <span class="kind-label">{label}</span>
      <span class="kind-count">{counts[kind]}</span>
    </button>
  {/each}
</div>

<style>
  /* The view toggle's pill, so the two read as one family of board controls. */
  .kind-filter {
    pointer-events: auto;
    display: flex;
    align-items: stretch;
    gap: 0.2rem;
    max-width: 100%;
    background: rgba(var(--surface-panel-rgb), 0.92);
    backdrop-filter: blur(14px);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-pill);
    padding: 0.25rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /*
   * `--ctl` on every pointer, under the 44px tap floor on purpose: the pill
   * rides above the step bar, and at 44 it covered a second bar's worth of
   * board. The view toggle beside it is the same height.
   */
  .kind-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-height: var(--ctl);
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-pill);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-base);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color var(--dur-fast) ease,
      background var(--dur-fast) ease,
      border-color var(--dur-fast) ease;
  }

  /* Hover only where there is one: on touch it sticks after the tap. */
  @media (hover: hover) {
    .kind-btn:hover {
      color: var(--text);
      background: var(--surface-raised);
    }
  }

  .kind-icon {
    display: flex;
    align-items: center;
  }

  .kind-count {
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }

  /* Selected takes `--accent`, as everywhere: see the colour law in app.css. */
  .kind-btn.active {
    background: var(--accent-bg);
    border-color: var(--accent-line);
    color: var(--accent);
    box-shadow: 0 0 14px var(--accent-glow);
  }

  .kind-btn.active .kind-count {
    color: var(--accent);
  }

  /*
   * Three labelled chips with counts do not fit a phone: the icon and the
   * count carry it there, the label staying in `aria-label` and the title.
   */
  @media (max-width: 520px) {
    .kind-btn {
      gap: 0.25rem;
      padding: 0.3rem 0.45rem;
      font-size: var(--fs-sm);
    }
    .kind-label {
      display: none;
    }
  }

  /*
   * The narrowest phones: just tight enough to keep the pill on the view
   * toggle's line (see `HudToolbar`) rather than stepping onto one of its own.
   */
  @media (max-width: 359px) {
    .kind-filter {
      gap: 0;
      padding: 0.2rem;
    }
    .kind-btn {
      padding: 0.3rem 0.38rem;
    }
  }
</style>
