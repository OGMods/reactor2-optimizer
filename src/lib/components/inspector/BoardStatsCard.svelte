<script lang="ts">
  import { onDestroy } from "svelte";
  import { createConfirmArm } from "../confirmArm.svelte";
  import { STAT_ICON } from "../statIcons";
  import {
    layoutState,
    solverState,
    uiState,
    viewportState,
  } from "../../state";
  import {
    effectiveAtValue,
    findBuilding,
    formatNumber,
    levelIndexForValue,
  } from "@reactor2/solver";
  import { placementStatus } from "../../data/placements";
  import {
    asset,
    formatDuration,
    formatTileCoords,
    formatTimeAgo,
  } from "../../utils";
  import {
    AlertCircle,
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Copy,
    Eye,
    Hammer,
    Loader2,
    RotateCcw,
    X,
    Zap,
  } from "lucide-svelte";

  /*
   * One card for everything the board has to say: which layout is on screen,
   * what it puts out, and what is under the pointer.
   *
   * One rather than two — a hover card stacked above a solve readout puts two
   * panels on a phone screen the map also needs.
   *
   * The figures are deliberately three: power, the bound it is measured
   * against, and how long the solve took. `uiState.statsPanel` picks which
   * layout they describe; this file only renders it.
   */
  let panel = $derived(uiState.statsPanel);
  let tile = $derived(uiState.inspectedTile);
  let building = $derived(uiState.inspectedBuilding);
  let elapsed = $derived(formatDuration(solverState.elapsedMs));

  /*
   * What a finished run says out loud.
   *
   * A solve can take five minutes and the card is the only thing that reports
   * it — silently, as a number that changes. Someone using a screen reader
   * started the run and then had no way to learn it had ended short of going
   * back to poll the card.
   *
   * Empty while the run is in flight, deliberately. `optimizationResult`
   * streams during a search, and a polite live region bound to it would read
   * out every intermediate layout the walk passed through. The one moment
   * worth announcing is the one the user cannot see coming: the end.
   */
  let announcement = $derived.by(() => {
    if (solverState.isOptimizing) return "";
    if (solverState.optimizationError) {
      return `Solve failed. ${solverState.optimizationError}`;
    }
    const result = solverState.optimizationResult;
    if (!result) return "";

    // A restored solve has a result but no duration of its own — it was not
    // run in this session, so there is nothing honest to say about how long
    // it took.
    const ms = solverState.lastRunDurationMs;
    const took = ms === null ? "" : ` in ${formatDuration(ms)}`;
    const tied = solverState.variants.length;
    const layouts = tied > 1 ? ` ${tied} layouts tied at this power.` : "";
    return `Solve finished${took}. ${formatNumber(result.totalPower)} power.${layouts}`;
  });

  /*
   * The shortlist of tied layouts, and whether there is anything to choose
   * between. A solve whose search found one arrangement shows no cycler at
   * all — the same rule `PlacementViewToggle` follows for a toggle with a dead
   * half.
   *
   * Hidden while a run is in flight: the shortlist it will produce does not
   * exist yet, and the layout streaming into the panel is not one of its
   * entries.
   */
  let cycling = $derived(
    panel === "solver" &&
      !solverState.isOptimizing &&
      !solverState.optimizationError &&
      solverState.variantCount > 1,
  );

  /*
   * Folded down to one line, on a small screen only. A desktop card sits in a
   * corner of a wide canvas; a phone card lies across the map being played.
   */
  let collapsible = $derived(viewportState.isCompact);

  /*
   * Reset throws a board away, and a previewed board is not the visitor's to
   * throw: it is not stored anywhere, and "remove every building you placed"
   * describes buildings they did not place. Exiting the preview is the way out
   * of it, and the banner above holds that.
   */
  let resettable = $derived(!layoutState.isPreview);

  /**
   * Inspecting a tile folds the card, on a phone, whatever the stored
   * preference says.
   *
   * There the card lies across the map rather than sitting in a corner of it,
   * and a tile brings a sprite, a name, a level chip and up to three stat rows
   * with it. Unfolded underneath a solve's figures, its failure counts and its
   * layout row, that is most of the screen spent on a card covering the board
   * whose tile you just tapped to find out about.
   *
   * Folded, the head still carries the power and the failure pill, so nothing
   * that was worth a glance is lost — and the tile section is outside the fold
   * by construction, so the thing actually being asked about is the thing that
   * stays.
   *
   * **Derived, never written.** Dismissing the tile puts the card back exactly
   * as the player left it, because their own preference was never touched; a
   * version of this that folded the card *by* setting `statsCardCollapsed`
   * would have quietly rewritten it on the way past.
   */
  let inspecting = $derived(collapsible && tile !== null);
  let collapsed = $derived(
    collapsible && (uiState.statsCardCollapsed || inspecting),
  );

  /*
   * The buildings the figures below describe: the solve's, or the ones the
   * user placed. Taken from `panel` rather than `uiState.visiblePlacements`,
   * which is the *canvas's* answer and disagrees for one moment that matters —
   * a run that has started but produced nothing yet still shows the user's
   * board on screen while this panel has already switched to SOLVER.
   */
  let boardPlacements = $derived(
    panel === "solver"
      ? (solverState.optimizationResult?.placements ?? [])
      : layoutState.placements,
  );

  /*
   * What the board puts out, and how many of its buildings are not working —
   * split by *why*, because the two have different fixes:
   *
   * - **Idle** — every figure is zero. A generator with no reactor beside it,
   *   a cooler nobody draws from. It cost money and does nothing, and on the
   *   map it looks exactly like a building that works.
   * - **Overheating** — it makes more waste heat than the cooling routed to it
   *   covers, so the game shuts it down entirely. `placementStatus` calls this
   *   `starved`; "overheating" is what it looks like to a player, and the fix
   *   is a cooler rather than a neighbour.
   *
   * Nothing is simulated here: both boards are already scored — the user's by
   * `lib/simulation/simulator.ts`, the solve by the worker — so this is a walk
   * over rows that already hold the answer. `placementStatus` is the shared
   * reading of one of those rows, so these counts can never disagree with the
   * amber Cooling chip the inspected tile shows for the same building.
   *
   * Counted for **both** panels. A layout the solver has just returned is
   * stable by construction and shows neither, but `rescoreResult` deliberately
   * does not re-optimise: a tier bought — or locked — behind a standing layout
   * re-rates it in place, and that layout may no longer be a stable one. When
   * that happens the card should say so rather than printing a power figure
   * whose buildings have quietly shut down.
   */
  let board = $derived.by(() => {
    let power = 0;
    let idle = 0;
    let overheating = 0;
    for (const p of boardPlacements) {
      power += p.powerGenerated;
      const status = placementStatus(p);
      if (status === "idle") idle++;
      else if (status === "starved") overheating++;
    }
    return { power, idle, overheating };
  });

  /*
   * The solve reports its own total rather than having it re-summed here: it
   * is the figure the search actually optimised, and `#scoreLayout` is what
   * produced both it and the rows above.
   */
  let power = $derived(
    panel === "solver"
      ? (solverState.optimizationResult?.totalPower ?? 0)
      : board.power,
  );

  /** Folded, the card has room for one number about what is wrong, not two. */
  let troubled = $derived(board.idle + board.overheating);

  const plural = (n: number) => (n === 1 ? "building" : "buildings");

  /** What the inspected tile is called: its building, or the ground itself. */
  let tileName = $derived.by(() => {
    if (!tile) return "";
    if (!building) return tile.type;
    return findBuilding(building.buildingId)?.name ?? building.buildingId;
  });

  /**
   * The upgrade tier the inspected building is standing at, 1-based — the
   * sidebar's tier buttons number themselves `idx + 1` and the two must agree.
   *
   * Read from the placement's own `baseValue` via `levelIndexForValue`, the
   * inverse of `placementBaseValue`, rather than from the player's roster. That
   * is the same rule the figures below follow: it is the tier the building was
   * *placed* at and the one the scorer ran it at, so a building with an upgrade
   * bought behind it still reads at the tier it is actually running on. Reading
   * the roster instead would print a level the numbers underneath disagree with.
   *
   * Shown unconditionally — every building in the catalogue has at least five
   * tiers, so there is no case where this is the uninformative "1 of 1" that
   * makes the sidebar hide its own level row.
   */
  let tileLevel = $derived.by(() => {
    if (!building) return null;
    const def = findBuilding(building.buildingId);
    if (!def) return null;
    return levelIndexForValue(def, building.baseValue) + 1;
  });

  /** One labelled figure about the inspected building, against its ceiling. */
  interface StatRow {
    label: string;
    icon: string;
    value: number;
    /** What `value` is measured against. Omitted when there is no ceiling. */
    total?: number;
    /** Cooling that does not cover the waste — the building is shut down. */
    warn?: boolean;
  }

  const { energy: ENERGY, heat: HEAT, cooling: COOLING } = STAT_ICON;

  /*
   * What the inspected building is actually doing right now, as labelled rows
   * in the sidebar catalogue's idiom — same icons, same label-left/chip-right
   * shape, so a building reads the same wherever it appears.
   *
   * Each row is `used / total`, and the live half is what matters: a generator
   * with no reactor beside it reads `0 / 17.7AC`, which says both that it does
   * nothing and how much it is missing. Bare figures could not tell those apart.
   *
   * The ceilings come from `effectiveAtValue`, so they are the tier the
   * building was *placed* at — the same one the scorer ran it at. Reading the
   * player's current unlock level instead would re-rate a building the moment
   * an upgrade is bought behind it, and the ratio would stop meaning anything.
   *
   * Cooling is the one row measured against a live figure rather than a
   * ceiling: what a building needs is the waste it is actually making, which
   * falls with its fill. Against the tier's full-tilt waste, a half-fed
   * generator would look starved while being perfectly covered.
   */
  let statRows = $derived.by((): StatRow[] => {
    if (!building) return [];
    const def = findBuilding(building.buildingId);
    if (!def) return [];

    const max = effectiveAtValue(def, building.baseValue);

    // A waste producer that is not getting the cooling it needs is shut down,
    // and this row is the only place the board admits it. The test is
    // `placementStatus`, which reads the solver's own `wasteIsCovered`
    // tolerance — a bare `<` here would paint a running building red.
    const starved = placementStatus(building) === "starved";

    switch (def.type) {
      case "cooler":
        return [
          {
            label: "Cooling",
            icon: COOLING,
            value: building.coolingProvided,
            total: max.effectiveValue,
          },
        ];
      case "reactor":
        return [
          {
            label: "Heat Out",
            icon: HEAT,
            value: building.heatProduced,
            total: max.effectiveValue,
          },
        ];
      case "generator":
        return [
          {
            label: "Energy",
            icon: ENERGY,
            value: building.powerGenerated,
            total: max.energy,
          },
          {
            label: "Heat In",
            icon: HEAT,
            value: building.heatConsumed,
            total: max.effectiveValue,
          },
          {
            label: "Cooling",
            icon: COOLING,
            value: building.coolingReceived,
            total: building.wasteHeatGenerated,
            warn: starved,
          },
        ];
      case "direct_producer":
        return [
          {
            label: "Energy",
            icon: ENERGY,
            value: building.powerGenerated,
            total: max.energy,
          },
          {
            label: "Waste",
            icon: HEAT,
            value: building.wasteHeatGenerated,
            total: max.waste,
          },
          {
            label: "Cooling",
            icon: COOLING,
            value: building.coolingReceived,
            total: building.wasteHeatGenerated,
            warn: starved,
          },
        ];
    }
    return [];
  });

  /*
   * Reset asks twice, the same way the template list's Reset and Delete do —
   * one shared idiom, see `components/confirmArm.svelte.ts`.
   *
   * Keyed rather than boolean because the head holds two buttons that ask
   * twice, and arming one has to disarm the other or a second press would land
   * on whichever happened to still be live.
   */
  const confirm = createConfirmArm<"reset" | "copy">();

  function resetBoard() {
    if (!confirm.press("reset")) return;
    // Whichever board is on screen is the one being thrown away — the solve,
    // or every building placed by hand.
    if (panel === "solver") solverState.clearResult();
    else layoutState.clearPlacements();
  }

  /*
   * Copy the solve into the editable board.
   *
   * It only asks twice when there is something to lose. An empty board has no
   * work to overwrite, and making the common first use of this button a
   * two-press ceremony would teach people to double-tap it without reading —
   * which is exactly the habit that makes the confirmation useless on the day
   * it matters. Either way the write is undoable.
   */
  function copySolve() {
    if (layoutState.placements.length > 0 && !confirm.press("copy")) return;
    confirm.disarm();
    uiState.copySolveToBoard();
  }

  // Switching panels mid-confirm would apply the press to the other board.
  $effect(() => {
    void panel;
    confirm.disarm();
  });

  onDestroy(confirm.disarm);
</script>

<!--
  Outside the card, because it must survive the card being folded away or
  rendered nothing at all — a run started on an empty board of one's own still
  has to report that it finished.
-->
<div class="sr-only" role="status" aria-live="polite">{announcement}</div>

{#if panel || tile}
  <div class="board-card">
    {#if panel}
      <div class="card-head">
        {#if panel === "solver"}
          <span class="head-title"><Zap size={13} /> SOLVER</span>
        {:else if layoutState.isPreview}
          <!-- Same panel, same figures — but "YOUR LAYOUT" over a board the
               visitor did not build is the one thing it must not say. -->
          <span class="head-title"><Eye size={13} /> SHARED LAYOUT</span>
        {:else}
          <span class="head-title"><Hammer size={13} /> YOUR LAYOUT</span>
        {/if}

        {#if collapsed}
          <!--
            Folded: the one figure worth a line, and the way back.

            Plus a count of what is not working, if anything is. Folding is
            meant to put the *figures* away, not the fact that the board has a
            problem — a player who folds the card on a phone and then wonders
            why the power is low would have no other way to find out.
          -->
          <span class="peek">
            {#if troubled > 0}
              <!-- Red as soon as anything is overheating: folded to one line,
                   the pill can only carry the worse of the two readings. -->
              <span
                class="peek-warn"
                class:danger={board.overheating > 0}
                title="Buildings not working"
              >
                <AlertTriangle size={11} />
                {troubled}
              </span>
            {/if}
            {formatNumber(power)}
            <img class="unit" src={ENERGY} alt="energy" />
          </span>
        {/if}

        <span class="head-actions">
          {#if solverState.isOptimizing}
            <!--
              Stop lives here as well as in the config panel: on a phone that
              panel is a sheet the user has probably pushed back down, and a
              running solve must always be stoppable from what is on screen.
            -->
            <span class="live">
              <Loader2 size={11} class="spinner" />
              <span class="clock">{elapsed}</span>
              {#if !solverState.isStopping}
                <button
                  class="stop"
                  onclick={() => solverState.stopOptimizer()}
                >
                  Stop
                </button>
              {/if}
            </span>
          {:else if panel === "solver" && !layoutState.isPreview}
            <!--
              The way off a read-only board. A solve is as often a starting
              point as an answer, and rebuilding forty buildings by hand to
              move one cooler is not a way to offer that.
            -->
            <button
              class="head-btn copy"
              class:armed={confirm.armed === "copy"}
              onclick={copySolve}
              title="Copy this layout into your own so you can edit it"
            >
              <Copy size={13} />
              {#if confirm.armed === "copy"}<span class="sure">Replace?</span
                >{/if}
            </button>
          {/if}

          {#if !solverState.isOptimizing && resettable}
            <button
              class="head-btn reset"
              class:armed={confirm.armed === "reset"}
              onclick={resetBoard}
              title={panel === "solver"
                ? "Discard this solve"
                : "Remove every building you placed"}
            >
              <RotateCcw size={13} />
              {#if confirm.armed === "reset"}<span class="sure">Sure?</span
                >{/if}
            </button>
          {/if}

          <!--
            Absent while a tile is inspected, because there the fold is not the
            player's to choose and a control that cannot change what it names
            is worse than no control — the same call `PlacementViewToggle` and
            the variants row make. The way back to the figures is the tile's
            own close button a few rows down, which is where someone finished
            with a tile is already looking.
          -->
          {#if collapsible && !inspecting}
            <button
              class="head-btn"
              onclick={() => uiState.toggleStatsCard()}
              aria-label={collapsed ? "Show board stats" : "Hide board stats"}
              aria-expanded={!collapsed}
            >
              {#if collapsed}<ChevronDown size={14} />{:else}<ChevronUp
                  size={14}
                />{/if}
            </button>
          {/if}
        </span>
      </div>
    {/if}

    {#if (panel && !collapsed) || tile}
      <!--
        Everything under the head is one scroller — the figures and the
        inspected tile together.

        The card is a flex item in a column capped at the viewport, so a short
        screen shrinks it; without something here containing the children, the
        rows paint straight out through the bottom border and over the board.

        One scroller rather than two. Split, each half could be starved to a
        few pixels by the other while the card still had room overall, and a
        scrollbar a few pixels tall is one nobody can use — and two scrollbars
        inside a 250px card is two places to look for the same content.
        Together they are the single run of rows the card reads as anyway, and
        one drag walks the whole of it.

        The head stays out of it: it is one line naming the board, and a
        scrolled card that no longer says which of the two layouts it is
        describing is worse than a card one line shorter.
      -->
      <div class="card-scroll thin-scroll">
        {#if panel && !collapsed}
          {#if panel === "solver" && solverState.optimizationError}
            <div class="notice error">
              <AlertCircle size={14} />
              <span>{solverState.optimizationError}</span>
            </div>
          {:else if panel === "solver" && !solverState.optimizationResult}
            <div class="notice waiting">
              <Loader2 size={14} class="spinner" />
              <span>Starting solve…</span>
            </div>
          {:else}
            <div class="figures">
              <div class="fig">
                <span class="fig-label">Power</span>
                <span class="fig-value">
                  {formatNumber(power)}
                  <img class="unit" src={ENERGY} alt="energy" />
                </span>
              </div>
              {#if solverState.estimatedMaxPower > 0}
                <div class="fig align-right">
                  <span class="fig-label">Est. Max</span>
                  <span class="fig-value muted">
                    {formatNumber(solverState.estimatedMaxPower)}
                    <img class="unit" src={ENERGY} alt="energy" />
                  </span>
                </div>
              {/if}
            </div>

            {#if panel === "solver"}
              <div class="row">
                <span class="row-label">
                  {solverState.isOptimizing ? "Running for" : "Solve time"}
                </span>
                <span class="row-value">
                  {elapsed}
                  {#if !solverState.isOptimizing && solverState.finishedAt !== null}
                    <!--
                  A restored solve is the one case where the duration alone
                  misleads: the run it describes may have been days ago.
                -->
                    <span class="ago"
                      >· {formatTimeAgo(solverState.finishedAt)}</span
                    >
                  {/if}
                </span>
              </div>

              {#if cycling}
                <!--
              The solve's other answers. Several arrangements usually tie at
              the top and the solver has no way to know which is nicest to
              build, so they are all kept and the choice is handed back.

              Cycling only previews — the board redraws, nothing is written —
              and Apply is what makes one of them this island's stored answer.
              That split is the point: thumbing through ten layouts should not
              quietly overwrite the one already chosen.
            -->
                <div class="row variants">
                  <span class="row-label">Layout</span>
                  <span class="variant-controls">
                    <button
                      class="head-btn"
                      onclick={() =>
                        solverState.showVariant(solverState.variantIndex - 1)}
                      aria-label="Previous layout at this power"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span class="variant-count">
                      {solverState.variantIndex + 1} / {solverState.variantCount}
                    </span>
                    <button
                      class="head-btn"
                      onclick={() =>
                        solverState.showVariant(solverState.variantIndex + 1)}
                      aria-label="Next layout at this power"
                    >
                      <ChevronRight size={14} />
                    </button>
                    {#if solverState.canApplyVariant}
                      <button
                        class="apply"
                        onclick={() => solverState.applyVariant()}
                        title="Keep this layout as the answer for this island"
                      >
                        Apply
                      </button>
                    {:else}
                      <span
                        class="applied"
                        title="This is the layout kept for this island"
                      >
                        <Check size={11} /> Applied
                      </span>
                    {/if}
                  </span>
                </div>
              {/if}
            {/if}

            <!--
          What is not working, and why. Two rows rather than one total: the
          fixes differ, so a player who cannot see which kind they have cannot
          act on the number. Each renders only when it is non-zero — a board
          where everything runs says nothing at all, which is the point.

          **Amber is idle, red is overheating, and that pairing is the board's
          language, not this card's.** The status pad under each building says
          the same thing in the same two colours (`STATUS_FRAME` in
          `pixi/gridPainter.ts`), and so does the Cooling chip on the inspected
          tile below. A player who learns one reading has learnt all three.

          Red is the more urgent of the two on purpose: an idle building is
          only wasted money, while an overheating one is shut down and dragging
          a whole cluster's output with it.
        -->
            {#if board.idle > 0}
              <div class="row warn">
                <span class="row-label">
                  <AlertTriangle size={11} /> Idle
                </span>
                <span class="row-value">{board.idle} {plural(board.idle)}</span>
              </div>
            {/if}
            {#if board.overheating > 0}
              <div class="row danger">
                <span class="row-label">
                  <AlertTriangle size={11} /> Overheating
                </span>
                <span class="row-value">
                  {board.overheating}
                  {plural(board.overheating)}
                </span>
              </div>
            {/if}
          {/if}
        {/if}

        {#if tile}
          <!--
            What the pointer is on. Bare ground is one line; a building gets
            the sidebar catalogue's shape — sprite, name, and its live figures
            as labelled rows — so it reads the same in both places.

            It is last in the scroller rather than pinned below it: the figures
            above are a handful of rows, so on any card with room for both this
            sits exactly where it always did, and on one without, a single drag
            reaches it.

            `formatTileCoords` flips the row so it counts the way the game
            does, upward from the bottom.
          -->
          <div class="tile-section" class:alone={!panel}>
            <div class="tile-head">
              {#if building}
                <span class="hex">
                  <img
                    class="sprite"
                    src={asset(`icons/${building.buildingId}.webp`)}
                    alt=""
                  />
                </span>
              {/if}
              <!--
            Name over tier, as one column.

            The tier is part of *what this building is*, so it belongs with the
            name rather than out among the live figures, which are all things
            it is currently *doing*. On the same line, between the name and the
            coordinates, the two compete for a phone's width — the name has to
            ellipsize to make room for a chip five characters wide. Stacked,
            neither yields.
          -->
              <span class="tile-id">
                <span class="tile-name">{tileName}</span>
                {#if tileLevel !== null}
                  <span class="tile-level">Lv. {tileLevel}</span>
                {/if}
              </span>
              <span class="tile-coords">
                {formatTileCoords(tile.x, tile.y, layoutState.height)}
              </span>
              {#if viewportState.isCoarse}
                <button
                  class="head-btn"
                  onclick={() => uiState.closeInspector()}
                  aria-label="Close tile info"
                >
                  <X size={14} />
                </button>
              {/if}
            </div>

            {#each statRows as stat}
              <div class="stat">
                <span class="stat-label">{stat.label}</span>
                <span class="stat-chip" class:warn={stat.warn}>
                  {formatNumber(stat.value)}
                  {#if stat.total}
                    <span>/ {formatNumber(stat.total)}</span>
                  {/if}
                  <img class="stat-icon" src={stat.icon} alt="" />
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /*
   * Near-solid rather than translucent: isometric sprites behind glass are
   * unreadable, and this sits directly over them.
   */
  .board-card {
    width: 250px;
    max-width: 100%;
    min-height: 0;
    background: rgba(10, 14, 23, 0.94);
    backdrop-filter: blur(12px);
    border: 1px solid var(--neon-dim);
    border-radius: var(--radius);
    padding: 0.5rem 0.7rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    /*
     * Contains its own children.
     *
     * `.corner-cards` caps this at the viewport minus the header and the HUD,
     * and `min-height: 0` above lets the card shrink to fit that cap — but
     * shrinking a box does not shrink what is in it. On a short screen (a
     * phone in landscape, a small laptop with a solve, two failure rows and a
     * building inspected) the rows went on painting straight out through the
     * bottom border and over the board. `.card-scroll` below is what they
     * shrink *into*; this is what stops anything escaping the rounded corner.
     */
    overflow: hidden;
  }

  /*
   * The single scroller: the figures and the inspected tile, together.
   *
   * `flex: 1 1 auto`, and the `auto` basis is load-bearing. `flex: 1` is
   * shorthand for a basis of **0**, which would make this item's hypothetical
   * size zero — and since the card's own height is content-driven, the card
   * would collapse to its head and the scroller would then have nothing to
   * grow into. An `auto` basis keeps the card the height of what is in it, and
   * only when `.corner-cards` caps it does this shrink and start scrolling.
   * (`.scroll-body` in the sidebar can use the `0` basis because the sheet and
   * the docked panel both give it a parent of definite height.)
   *
   * `min-height: 0` is what allows the shrink at all — a flex item's automatic
   * minimum is its content height, the same rule `.scroll-body` learned.
   */
  .card-scroll {
    display: flex;
    flex-direction: column;
    /* The same gap the card sets between its own children, so pulling these
       rows into a wrapper changes no spacing. */
    gap: 0.4rem;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    /* A flick that runs out of card must not scroll the page behind it. */
    overscroll-behavior: contain;
  }

  /* ── Header ────────────────────────────────────────────────────── */
  /*
   * The one row outside `.card-scroll`, and so the one that never shrinks. It
   * is a single line naming the board, which costs nothing to keep, and losing
   * it would leave a scrolled card that no longer says which of the two
   * layouts it is describing.
   */
  .card-head {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.3rem;
  }

  .head-title {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--fs-2xs);
    letter-spacing: 0.8px;
    color: var(--text-dim);
    font-weight: 700;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex-shrink: 0;
    margin-left: auto;
  }

  /* The folded card's one figure, between the title and the controls. */
  .peek {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: var(--fs-base);
    font-weight: 700;
    color: var(--neon);
    font-variant-numeric: tabular-nums;
  }

  .head-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    min-width: 22px;
    height: 22px;
    padding: 0 0.2rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .head-btn:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  /*
   * Neutral until armed. It is not destructive by default — on an empty board
   * it takes nothing away — and dressing it in `--danger` would say otherwise
   * every time it is shown.
   */
  .copy:hover {
    color: var(--neon);
    background: var(--neon-bg);
  }

  .copy.armed {
    color: var(--danger-soft);
    background: rgba(255, 71, 87, 0.18);
    border: 1px solid var(--danger-line);
  }

  .reset:hover {
    color: var(--danger-soft);
    background: var(--danger-bg);
  }

  /* Armed: it has to look like a different button than the one just pressed. */
  .reset.armed {
    color: var(--danger-soft);
    background: rgba(255, 71, 87, 0.18);
    border: 1px solid var(--danger-line);
  }

  .sure {
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.3px;
  }

  .live {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--fs-2xs);
    font-weight: 700;
    color: var(--neon);
    background: var(--neon-bg);
    border: 1px solid var(--neon-dim);
    border-radius: var(--radius-xs);
    padding: 0.1rem 0.35rem;
  }

  .clock {
    font-variant-numeric: tabular-nums;
  }

  .stop {
    background: rgba(255, 71, 87, 0.15);
    border: 1px solid var(--danger-line);
    color: var(--danger-soft);
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    padding: 0.1rem 0.3rem;
    border-radius: var(--radius-xs);
    cursor: pointer;
  }
  .stop:hover {
    background: rgba(255, 71, 87, 0.3);
  }

  /* ── The two figures ───────────────────────────────────────────── */
  .figures {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    background: var(--neon-bg);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.5rem;
  }

  .fig {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .fig.align-right {
    align-items: flex-end;
  }

  .fig-label {
    font-size: var(--fs-2xs);
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .fig-value {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: var(--fs-lg);
    font-weight: 700;
    color: var(--neon);
    font-variant-numeric: tabular-nums;
  }
  /* The bound the power figure is measured against: the same reading, held
     back so the figure that matters reads first. */
  .fig-value.muted {
    font-size: var(--fs-base);
    color: var(--text-muted);
  }

  /* The game's own energy pip, in place of a "kW" the game never writes. */
  .unit {
    width: 13px;
    height: 13px;
    object-fit: contain;
  }

  /* ── Rows ──────────────────────────────────────────────────────── */
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--fs-sm);
  }

  .row-label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--text-muted);
  }

  .row-value {
    color: #cbd5e1;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .row.warn .row-label,
  .row.warn .row-value {
    color: var(--status-idle);
  }

  .row.danger .row-label,
  .row.danger .row-value {
    color: var(--danger-soft);
  }

  /*
   * The folded card's warning count, ahead of the power figure.
   *
   * A pill rather than bare text: two numbers side by side with nothing
   * between them read as one, and "2" next to "0" is exactly the pair that
   * would.
   */
  .peek-warn {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    margin-right: 0.15rem;
    padding: 0.05rem 0.28rem;
    border-radius: var(--radius-xs);
    background: var(--status-idle-bg);
    color: var(--status-idle);
    font-size: var(--fs-xs);
    font-weight: 700;
  }

  .peek-warn.danger {
    background: rgba(255, 71, 87, 0.18);
    color: var(--danger-soft);
  }

  .ago {
    color: var(--text-dim);
    font-weight: 500;
  }

  /* ── The shortlist of tied layouts ─────────────────────────────── */
  .variant-controls {
    display: flex;
    align-items: center;
    gap: 0.15rem;
  }

  .variant-count {
    min-width: 34px;
    text-align: center;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: #cbd5e1;
    font-variant-numeric: tabular-nums;
  }

  /* The commitment reads as an action; having made it reads as a state. */
  .apply {
    margin-left: 0.15rem;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-xs);
    border: 1px solid var(--neon-dim);
    background: var(--neon-bg);
    color: var(--neon);
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .apply:hover {
    border-color: var(--neon);
    background: rgba(0, 243, 255, 0.2);
  }

  /*
   * The arrows are the one control in this card a player uses repeatedly, so
   * on a touch screen they get a real target — keyed on the pointer, not on a
   * width, the same way the rest of the app's touch bumps are.
   */
  @media (pointer: coarse) {
    .variant-controls .head-btn {
      min-width: 32px;
      height: 30px;
    }
    .apply {
      padding: 0.3rem 0.5rem;
    }
  }

  .applied {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    margin-left: 0.15rem;
    padding: 0.1rem 0.35rem;
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--fs-sm);
  }
  .notice.error {
    color: var(--danger-soft);
  }
  .notice.waiting {
    color: var(--neon);
  }

  :global(.spinner) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  /* ── The inspected tile ────────────────────────────────────────── */
  .tile-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding-top: 0.35rem;
  }

  /* On its own — nothing built, nothing solved — it needs no divider. */
  .tile-section.alone {
    border-top: none;
    padding-top: 0;
  }

  .tile-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-sm);
  }

  /*
   * Same hex plate the catalogue sits its sprites on, at 40px rather than 22:
   * the sprite is the only thing in this card that identifies the building by
   * sight rather than by reading, and 22px on a phone loses the detail that
   * tells one reactor from another. The two-line name column beside it is tall
   * enough to carry the extra height for free.
   */
  .hex {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    background: url("/hex.webp") no-repeat center / contain;
  }

  .sprite {
    width: 30px;
    height: 30px;
    object-fit: contain;
  }

  /* Name and tier, stacked; the pair takes the row's slack. */
  .tile-id {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
  }

  .tile-name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-weight: 600;
    text-transform: capitalize;
  }

  /*
   * Deliberately quieter than `.tile-coords` beside it. Both are identity
   * rather than measurement, but the level is the one a player scans past most
   * of the time — it earns a chip, not the neon.
   */
  .tile-level {
    flex: 0 0 auto;
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-xs);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.2px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .tile-coords {
    flex: 0 0 auto;
    font-family: var(--mono);
    color: var(--neon);
    font-weight: 600;
  }

  /* ── Live building figures, in the catalogue card's idiom ──────── */
  .stat {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 0.4rem;
    background-color: #385d7b;
    border-radius: var(--radius-sm);
    padding-left: 0.4rem;
    overflow: hidden;
  }

  .stat-label {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: #b5d5ff;
    align-self: center;
    /* Yields first: a truncated label still reads next to its icon. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat-chip {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.2rem;
    background-color: #528aa8;
    padding: 0.1rem 0.4rem;
    font-size: var(--fs-xs);
    font-weight: 700;
    color: #dbeafe;
    font-variant-numeric: tabular-nums;
  }

  /*
   * Cooling that does not cover the waste: this building is shut down.
   *
   * Red, matching the Overheating row above it and the red pad the board draws
   * under the building itself. Amber is the board's word for "idle", so an
   * amber chip here would name the wrong problem on the one building the user
   * has asked about.
   */
  .stat-chip.warn {
    background-color: #991b1b;
    color: #fee2e2;
  }

  .stat-icon {
    width: auto;
    height: 12px;
    object-fit: contain;
    margin-left: 2px;
  }

  /* ── Phone ─────────────────────────────────────────────────────────
   * Full width under the header, and tighter: this card shares a small
   * screen with the map it is describing.
   */
  @media (max-width: 640px) {
    .board-card {
      width: 100%;
      padding: 0.4rem 0.55rem;
      gap: 0.3rem;
    }

    .figures {
      padding: 0.3rem 0.45rem;
    }

    .fig-value {
      font-size: var(--fs-base);
    }
    .fig-value.muted {
      font-size: var(--fs-sm);
    }

    .row,
    .tile-head {
      font-size: var(--fs-xs);
    }
  }

  /* A 22px control is not a thumb target; the header ones grow on touch. */
  @media (pointer: coarse) {
    .head-btn {
      min-width: 32px;
      height: 32px;
    }
  }
</style>
