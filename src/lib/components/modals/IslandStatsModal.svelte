<script lang="ts">
  import {
    buildingCategory,
    findBuilding,
    formatNumber,
    type BuildingCategory,
  } from "@reactor2/solver";
  import {
    configState,
    layoutState,
    timelineState,
    uiState,
  } from "../../state";
  import {
    buildingPricing,
    clearWait,
    type BuildingPricing,
  } from "../../simulation/islandStats";
  import { asset, formatSpan } from "../../utils";
  import ModalShell from "./ModalShell.svelte";

  /*
   * The whole save at a glance: every game island's terrain, buildings and
   * power, and every building's copies and prices across all of them.
   *
   * Read off `timelineState.islands`, which the header keeps current — the
   * board on screen live, the rest from their saved boards — so nothing here
   * decodes or scores on its own. Power is per tick under today's roster,
   * research and anomaly, the same figure the header totals.
   */
  let open = $derived(uiState.activeModal === "islandStats");
  let islands = $derived(open ? timelineState.islands : []);
  let rules = $derived(timelineState.priceRules);
  let clearing = $derived(open ? timelineState.obstacleClearing : null);
  let nextIsland = $derived(open ? timelineState.nextIsland : null);

  /*
   * Erased from Time finishes a clear for free once what is left fits its
   * window, so the wait is the clear's length less the window — none at all
   * when the whole clear fits.
   */
  let nextWait = $derived(clearing ? clearWait(clearing) : 0);

  /** A solve worth building: it makes more than the board it replaces. */
  const solveGains = (i: (typeof islands)[number]) =>
    i.solvePower !== null &&
    i.solveCost !== null &&
    i.solvePower > i.power * (1 + 1e-9);

  /*
   * Each island whose stored solve makes more than its board, with what
   * building it costs, best value first: a solve that pays for itself in
   * refunds before one that costs anything, then by power gained per cash.
   */
  let worthBuilding = $derived(
    islands
      .filter(solveGains)
      .map((i) => ({
        name: i.name,
        gain: i.solvePower! - i.power,
        cost: i.solveCost!,
      }))
      .sort((a, b) =>
        a.cost <= 0 || b.cost <= 0
          ? a.cost - b.cost
          : b.gain / b.cost - a.gain / a.cost,
      ),
  );

  /*
   * Grass beside water is only worth anything under a shore bonus (Tidal
   * Ascendancy); under any other rule it is a number with no use, so it is
   * not shown.
   */
  let showShore = $derived(
    configState.activeAnomaly.rule === "terrain_affinity",
  );

  const pct = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–";
  const sum = (f: (i: (typeof islands)[number]) => number) =>
    islands.reduce((s, i) => s + f(i), 0);

  let totals = $derived.by(() => {
    const placed = sum((i) => buildingTotal(i.counts));
    const grass = sum((i) => i.terrain.grass);
    return {
      power: sum((i) => i.power),
      // An island whose solve makes less than its board keeps the board, as
      // the header's "with solves" figure counts it.
      withSolves: sum((i) => Math.max(i.power, i.solvePower ?? 0)),
      solved: islands.filter((i) => i.solvePower !== null).length,
      placed,
      grass,
      free: grass - placed,
      shore: sum((i) => i.terrain.shore),
      rocks: sum((i) => i.terrain.rocks),
      trees: sum((i) => i.terrain.trees),
      ponds: sum((i) => i.terrain.ponds),
      idle: sum((i) => i.idle),
      starved: sum((i) => i.starved),
    };
  });

  /** Plural nouns for the three groups the catalogue files buildings under. */
  const GROUP_WORDS: Record<BuildingCategory, [string, string]> = {
    heat_producer: ["reactor", "reactors"],
    generator: ["generator", "generators"],
    cooler: ["cooler", "coolers"],
  };

  /** "12 reactors · 30 generators · 25 coolers", leaving out empty groups. */
  function roleMix(counts: Record<string, number>): string {
    const groups: Record<BuildingCategory, number> = {
      heat_producer: 0,
      generator: 0,
      cooler: 0,
    };
    for (const [id, n] of Object.entries(counts)) {
      const b = findBuilding(id);
      if (b) groups[buildingCategory(b.type)] += n;
    }
    return (Object.keys(groups) as BuildingCategory[])
      .filter((g) => groups[g] > 0)
      .map((g) => `${groups[g]} ${GROUP_WORDS[g][groups[g] === 1 ? 0 : 1]}`)
      .join(" · ");
  }

  /** "2 idle · 1 overheating", or null when every building works. */
  function notWorking(t: { idle: number; starved: number }): string | null {
    const parts: string[] = [];
    if (t.idle > 0) parts.push(`${t.idle} idle`);
    if (t.starved > 0) parts.push(`${t.starved} overheating`);
    return parts.length ? parts.join(" · ") : null;
  }

  /** A change's net cash: what it costs, or what its sales pay back. */
  const spendText = (cost: number) =>
    cost < 0 ? `pays back ${formatNumber(-cost)}` : formatNumber(cost);

  /** "1 rock · 5 trees", leaving out the kinds there are none of. */
  function obstacles(t: { rocks: number; trees: number; ponds: number }) {
    const parts = [
      [t.rocks, "rock"],
      [t.trees, "tree"],
      [t.ponds, "pond"],
    ] as const;
    return (
      parts
        .filter(([n]) => n > 0)
        .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`)
        .join(" · ") || "None"
    );
  }

  function buildingTotal(counts: Record<string, number>): number {
    let n = 0;
    for (const c of Object.values(counts)) n += c;
    return n;
  }

  interface BuildingRow extends BuildingPricing {
    id: string;
    name: string;
    /** Where the copies stand, for the row's tooltip. */
    spread: string;
  }

  /** Every building with a copy anywhere, dearest to rebuild first. */
  let buildings = $derived.by((): BuildingRow[] => {
    const copies = timelineState.copies;
    return Object.entries(copies)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({
        id,
        name: findBuilding(id)?.name ?? id,
        spread: islands
          .filter((i) => i.counts[id])
          .map((i) => `${i.name} ×${i.counts[id]}`)
          .join("\n"),
        ...buildingPricing(id, n, rules),
      }))
      .sort((a, b) => b.rebuild - a.rebuild);
  });

  let rebuildTotal = $derived(buildings.reduce((s, b) => s + b.rebuild, 0));
</script>

{#snippet cash()}
  <img src={asset("icons/icon_cash.webp")} alt="" width="12" height="12" />
{/snippet}

{#if open}
  <ModalShell title="Island stats" onClose={() => uiState.closeModal()}>
    <section class="summary">
      <h3>All islands</h3>
      <dl>
        <dt>Power</dt>
        <dd>{formatNumber(totals.power)}</dd>
        {#if totals.solved > 0}
          <dt>With solves built ({totals.solved})</dt>
          <dd>{formatNumber(totals.withSolves)}</dd>
        {/if}
        <dt>Buildings</dt>
        <dd>{totals.placed}</dd>
        {#if notWorking(totals)}
          <dt>Not working</dt>
          <dd>{notWorking(totals)}</dd>
        {/if}
        <dt>Free grass</dt>
        <dd>{totals.free} of {totals.grass}</dd>
        {#if showShore}
          <dt>Grass beside water</dt>
          <dd>{pct(totals.shore, totals.grass)}</dd>
        {/if}
        <dt>Obstacles left</dt>
        <dd>
          {obstacles(totals)}
        </dd>
        {#if clearing}
          <dt>Obstacles cleared</dt>
          <dd>{clearing.removed}</dd>
          <dt>Next clear</dt>
          <dd>
            {#if nextWait === 0}
              Free <span class="dim">({formatSpan(clearing.nextSeconds)})</span>
            {:else}
              {formatSpan(clearing.nextSeconds)}
              {#if clearing.freeWindow > 0}
                <span class="dim">(free after {formatSpan(nextWait)})</span>
              {/if}
            {/if}
          </dd>
          {#if clearing.left > 0}
            <dt>Clear all {clearing.left} left</dt>
            <dd>{formatSpan(clearing.allSeconds)}</dd>
          {/if}
        {/if}
        {#if nextIsland}
          <dt>Next island: {nextIsland.name}</dt>
          <dd>{@render cash()}{formatNumber(nextIsland.price)}</dd>
        {/if}
        <dt>Rebuild cost</dt>
        <dd>{@render cash()}{formatNumber(rebuildTotal)}</dd>
      </dl>
      <p class="aside">
        Power is per tick under your current roster, research and anomaly.
        Rebuild cost is every building bought again from none at today's prices{timelineState.record
          ? ""
          : " with no price research — import a game code for yours"}.
        {#if clearing && clearing.left > 0}
          Clearing all is each clear's wait added up, one after another.
        {/if}
      </p>
    </section>

    {#if worthBuilding.length > 0}
      <h3>Solves worth building</h3>
      <div class="table" role="table" aria-label="Solves worth building">
        <div class="row head solves" role="row">
          <span role="columnheader">Island</span>
          <span role="columnheader">Power</span>
          <span role="columnheader">Cash</span>
        </div>
        {#each worthBuilding as w (w.name)}
          <div class="row solves" role="row">
            <span class="name" role="cell">{w.name}</span>
            <span role="cell">+{formatNumber(w.gain)}</span>
            <span role="cell">{spendText(w.cost)}</span>
          </div>
        {/each}
      </div>
      <p class="aside below">
        What changing each board into its solve costs, net of what selling the
        buildings it drops pays back. Moving a building is free. Best value
        first.
      </p>
    {/if}

    <h3>Buildings on all islands</h3>
    {#if buildings.length === 0}
      <p class="empty">No buildings placed yet.</p>
    {:else}
      <div class="table" role="table" aria-label="Buildings on all islands">
        <div class="row head" role="row">
          <span role="columnheader">Building</span>
          <span role="columnheader">Built</span>
          <span role="columnheader">Next</span>
          <span role="columnheader">Rebuild</span>
        </div>
        {#each buildings as b (b.id)}
          <div class="row" role="row" title={b.spread}>
            <span class="name" role="cell">
              <img src={asset(`icons/${b.id}.webp`)} alt="" class="icon" />
              <span class="label">
                <span class="title">{b.name}</span>
                <span class="base">Base {formatNumber(b.base)}</span>
              </span>
            </span>
            <span role="cell">{b.built}</span>
            <span role="cell">{formatNumber(b.next)}</span>
            <span role="cell">{formatNumber(b.rebuild)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <h3>Islands</h3>
    <ul class="islands">
      {#each islands as island (island.id)}
        {@const placed = buildingTotal(island.counts)}
        <li class:current={island.id === layoutState.activeTemplateId}>
          <div class="island-head">
            <span class="island-name">{island.name}</span>
            {#if island.locked}
              <span class="chip">Locked in game</span>
            {:else if island.id === layoutState.activeTemplateId}
              <span class="chip">On screen</span>
            {/if}
          </div>
          <dl>
            <dt>Power</dt>
            <dd>{formatNumber(island.power)}</dd>
            {#if island.solvePower !== null}
              <dt>Solve</dt>
              <dd>
                {formatNumber(island.solvePower)}
                <span class="dim"
                  >({pct(island.power, island.solvePower)} built)</span
                >
              </dd>
              {#if solveGains(island)}
                <dt>To build it</dt>
                <dd>
                  +{formatNumber(island.solvePower - island.power)}
                  <span class="dim">for {spendText(island.solveCost!)}</span>
                </dd>
              {/if}
            {/if}
            <dt>Buildings</dt>
            <dd>{placed}</dd>
            {#if placed > 0}
              <dt>Mix</dt>
              <dd>{roleMix(island.counts)}</dd>
              <dt>Power per building</dt>
              <dd>{formatNumber(island.power / placed)}</dd>
            {/if}
            {#if notWorking(island)}
              <dt>Not working</dt>
              <dd>{notWorking(island)}</dd>
            {/if}
            <dt>Free grass</dt>
            <dd>{island.terrain.grass - placed} of {island.terrain.grass}</dd>
            {#if showShore}
              <dt>Beside water</dt>
              <dd>{pct(island.terrain.shore, island.terrain.grass)}</dd>
            {/if}
            {#if island.terrain.rocks + island.terrain.trees + island.terrain.ponds > 0}
              <dt>Obstacles</dt>
              <dd>
                {obstacles(island.terrain)}
              </dd>
            {/if}
            {#if island.cleared > 0}
              <dt>Cleared</dt>
              <dd>{island.cleared}</dd>
            {/if}
          </dl>
        </li>
      {/each}
    </ul>
  </ModalShell>
{/if}

<style>
  .summary {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
  }

  .summary h3 {
    margin: 0;
  }

  dl {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.25rem 0.75rem;
    margin: 0;
    font-size: var(--fs-sm);
  }

  dt {
    color: var(--text-muted);
  }

  dd {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.3rem;
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .dim {
    color: var(--text-dim);
    font-weight: 500;
  }

  .aside,
  .empty {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  h3 {
    margin: 1rem 0 0.4rem;
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  /*
   * The shell's body is a flex column, and a child with `overflow: hidden`
   * may shrink to nothing in one: without this the table renders 2px tall.
   */
  .table {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 2.6rem 3.6rem 3.6rem;
    gap: 0.5rem;
    align-items: center;
    padding: 0.35rem 0.6rem;
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }

  .row + .row {
    border-top: 1px solid var(--border);
  }

  .row > span:not(.name) {
    text-align: right;
    font-weight: 600;
    white-space: nowrap;
  }

  .row.head {
    background: var(--surface-raised);
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .row.head > span {
    font-weight: 700;
  }

  .row.head > span:first-child {
    text-align: left;
  }

  .row.solves {
    grid-template-columns: minmax(0, 1fr) 4rem 6.5rem;
  }

  .aside.below {
    margin-top: 0.35rem;
  }

  .name {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  .icon {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    object-fit: contain;
  }

  .label {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .base {
    font-size: var(--fs-2xs);
    color: var(--text-dim);
  }

  .islands {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .islands li {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  /* The island on screen: a selection, which is what `--accent` means. */
  .islands li.current {
    border-color: var(--accent-dim);
  }

  .island-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .island-name {
    font-size: var(--fs-md);
    font-weight: 700;
  }

  .chip {
    padding: 0.1rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    font-size: var(--fs-2xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>
