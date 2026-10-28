<script lang="ts">
  import { findBuilding, formatNumber } from "@reactor2/solver";
  import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-svelte";
  import { layoutState, uiState } from "../../state";
  import type { MoveStep } from "../../simulation/moveSteps";
  import { asset, formatTileCoords } from "../../utils";

  /*
   * Step mode's controls, in the HUD's place: which step the board is showing,
   * what it asks the player to do in the game, what the island makes once it
   * is done, and the way through the rest.
   *
   * The board above it is the island after the step, with the step's tiles
   * marked — cyan where a building arrives, red where one leaves — so the bar
   * says in words what the board shows in place. Step 0 is the start, the
   * island as the game has it, and its line is the summary of the whole plan.
   * The arrow keys step too.
   */
  let m = $derived(uiState.moveSteps);
  let planning = $derived(uiState.moveStepsPlanning);

  let measuredHeight = $state(0);
  $effect(() => {
    uiState.hudHeight = measuredHeight;
    return () => {
      uiState.hudHeight = 0;
    };
  });

  let index = $derived(m?.index ?? 0);
  let total = $derived(m?.plan.steps.length ?? 0);
  let step = $derived(m && index > 0 ? m.plan.steps[index - 1] : null);
  let power = $derived(m ? m.plan.powers[index] : 0);
  let before = $derived(m && index > 0 ? m.plan.powers[index - 1] : null);
  let end = $derived(m ? m.plan.powers[total] : 0);

  /** The plan in one line: how many of each kind of step. */
  let summary = $derived.by(() => {
    if (!m) return "";
    const n = { move: 0, replace: 0, build: 0, sell: 0, clear: 0, sellAll: 0 };
    for (const s of m.plan.steps) n[s.kind]++;
    return [
      n.clear && `${n.clear} to clear`,
      n.sellAll && "sell everything",
      n.move && `${n.move} to move`,
      n.replace && `${n.replace} to replace`,
      n.build && `${n.build} to build`,
      n.sell && `${n.sell} to sell`,
    ]
      .filter(Boolean)
      .join(" · ");
  });

  /** The lowest the island falls on the way, against where it starts. */
  let lowest = $derived(m ? Math.min(...m.plan.powers) : 0);

  /*
   * The money. Each step's own figures, and for the whole plan what it spends,
   * what it gets back, and the most it ever needs at once: refunds land along
   * the way, so the cash a player must hold is that peak, not the net.
   */
  let price = $derived(m && index > 0 ? m.prices[index - 1] : null);
  let money = $derived.by(() => {
    if (!m) return null;
    let spend = 0;
    let refund = 0;
    let running = 0;
    let peak = 0;
    for (const p of m.prices) {
      spend += p.spend;
      refund += p.refund;
      // A refund in the same step as a purchase (a replace) pays for it.
      running += p.spend - p.refund;
      peak = Math.max(peak, running);
    }
    return { spend, refund, net: spend - refund, peak };
  });

  const nameOf = (id: string) => findBuilding(id)?.name ?? id;
  const at = (x: number, y: number) =>
    formatTileCoords(x, y, layoutState.height);
  /** Each obstacle's word, and the icon the palette already shows for it. */
  const OBSTACLE: Record<string, { word: string; icon: string }> = {
    rock: { word: "rocks", icon: "icon_rocks" },
    tree1: { word: "trees", icon: "icon_trees1" },
    tree2: { word: "trees", icon: "icon_trees2" },
    pond: { word: "pond", icon: "icon_pond" },
  };

  function describe(s: MoveStep): string {
    switch (s.kind) {
      case "move":
        return `Move ${nameOf(s.buildingId)} from ${at(s.from.x, s.from.y)} to ${at(s.to.x, s.to.y)}`;
      case "build":
        return `Build ${nameOf(s.buildingId)} at ${at(s.x, s.y)}`;
      case "replace":
        return `Replace ${nameOf(s.from)} with ${nameOf(s.to)} at ${at(s.x, s.y)}`;
      case "sellAll":
        return `Sell everything: all ${s.count} buildings`;
      case "sell":
        return `Sell ${nameOf(s.buildingId)} at ${at(s.x, s.y)}`;
      case "clear":
        return `Clear the ${OBSTACLE[s.obstacle]?.word ?? s.obstacle} at ${at(s.x, s.y)}`;
    }
  }

  /** The step's picture: the building it puts down, or what it clears. */
  function iconOf(s: MoveStep): string | null {
    switch (s.kind) {
      case "clear":
        return asset(
          `icons/${OBSTACLE[s.obstacle]?.icon ?? "icon_rocks"}.webp`,
        );
      case "sellAll":
        return null;
      case "replace":
        return asset(`icons/${s.to}.webp`);
      default:
        return asset(`icons/${s.buildingId}.webp`);
    }
  }

  function delta(now: number, was: number): string {
    if (was <= 0) return "";
    const p = (now / was - 1) * 100;
    if (Math.abs(p) < 0.05) return "";
    return `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
  }

  /*
   * Holding an arrow walks the plan: one step on the press, then after a
   * pause a step every so often, quicker the longer it is held, until it is
   * let go, slides off, or the plan runs out. A long plan is a lot of taps
   * otherwise. The keyboard needs none of this — a held key repeats itself.
   */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function stopHold() {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  }

  function startHold(e: PointerEvent, delta: number) {
    if (e.button !== 0) return;
    stopHold();
    // Captured, so the hold is the button's until it is let go: the board
    // repaints under every step, and a pointer the browser decides has left
    // would otherwise end it after a few.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    let wait = 380;
    const tick = () => {
      const before = uiState.moveSteps?.index;
      uiState.showMoveStep((before ?? 0) + delta);
      if (uiState.moveSteps?.index === before) return stopHold();
      holdTimer = setTimeout(tick, wait);
      wait = Math.max(45, wait * 0.8);
    };
    tick();
  }

  $effect(() => stopHold);

  function onKey(e: KeyboardEvent) {
    if (!m || e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") uiState.showMoveStep(index + 1);
    else if (e.key === "ArrowLeft") uiState.showMoveStep(index - 1);
    else return;
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- The game's cash, beside every figure of it. -->
{#snippet cash()}
  <img src={asset("icons/icon_cash.webp")} alt="" width="14" height="14" />
{/snippet}

<div class="steps-dock" bind:clientHeight={measuredHeight}>
  <div class="bar" role="region" aria-label="Steps to this layout">
    {#if planning || !m}
      <div class="planning">
        <Loader2 size={14} class="spinner" />
        <span>
          Planning the steps{planning && planning.total
            ? ` · ${Math.round((planning.done / planning.total) * 100)}%`
            : "…"}
        </span>
        <button
          type="button"
          class="icon"
          aria-label="Cancel"
          onclick={() => uiState.closeMoveSteps()}><X size={16} /></button
        >
      </div>
    {:else}
      <div class="head">
        <span class="count">
          {index === 0 ? "Start" : `Step ${index} of ${total}`}
        </span>
        <span class="power">
          <img
            src={asset("icons/icon_energy.webp")}
            alt=""
            width="14"
            height="14"
          />
          {formatNumber(power)}
          {#if before !== null && delta(power, before)}
            <span class="delta" class:down={power < before}
              >{delta(power, before)}</span
            >
          {/if}
        </span>
        <button
          type="button"
          class="icon"
          aria-label="Leave the steps"
          onclick={() => uiState.closeMoveSteps()}><X size={16} /></button
        >
      </div>

      <div class="what">
        {#if step}
          {#if iconOf(step)}
            <img
              class="sprite"
              src={iconOf(step)}
              alt=""
              width="28"
              height="28"
            />
          {/if}
          <span>{describe(step)}</span>
        {:else}
          <span>
            Your board in Edit. {summary} to reach {formatNumber(end)}.
          </span>
        {/if}
      </div>
      <!--
        The plan ends where the island first makes the layout's power; what is
        left would only rearrange it into the layout's exact shape. Said on the
        last step, where a player would otherwise wonder why the board on
        screen is not quite the solve.
      -->
      {#if index === total && m.plan.stoppedEarly}
        <p class="note">
          Done: this already makes the layout's power. The rest would only
          rearrange buildings.
        </p>
      {/if}
      {#if price && (price.spend > 0 || price.refund > 0)}
        <!-- This step's cash: what it costs, what a sale in it pays back. -->
        <dl class="money">
          {#if price.spend > 0}
            <dt>Costs</dt>
            <dd>{@render cash()}{formatNumber(price.spend)}</dd>
          {/if}
          {#if price.refund > 0}
            <dt>Refunds</dt>
            <dd>{@render cash()}{formatNumber(price.refund)}</dd>
          {/if}
        </dl>
      {/if}
      {#if index === 0 && money && (money.spend > 0 || money.refund > 0)}
        <!--
          The cash the whole plan moves: everything it buys, and everything its
          sales pay back. "Cash on hand needed" is the peak a player has to hold,
          since refunds land along the way. None of it is set against the cash
          in the export: that is a snapshot, stale as soon as the game earns on,
          and doubled by a rush hour.
        -->
        <dl class="money">
          <dt>Cash needed</dt>
          <dd>{@render cash()}{formatNumber(money.spend)}</dd>
          <dt>Refunded</dt>
          <dd>{@render cash()}{formatNumber(money.refund)}</dd>
          {#if money.peak > 0 && money.peak < money.spend}
            <dt>Cash on hand needed</dt>
            <dd>{@render cash()}{formatNumber(money.peak)}</dd>
          {/if}
        </dl>
      {/if}
      {#if index === 0 && lowest < power}
        <p class="note">
          Lowest on the way: {formatNumber(lowest)}, {delta(lowest, power)}
          from now.
        </p>
      {/if}

      <div class="nav">
        <button
          type="button"
          class="step-btn"
          aria-label="Previous step"
          disabled={index === 0}
          onpointerdown={(e) => startHold(e, -1)}
          onpointerup={stopHold}
          onlostpointercapture={stopHold}
          onpointercancel={stopHold}
          onclick={(e) => {
            // A pointer press already stepped; a click from the keyboard
            // (Enter or Space on the focused button) has no pointer behind it.
            if (e.detail === 0) uiState.showMoveStep(index - 1);
          }}><ChevronLeft size={18} /></button
        >
        <input
          type="range"
          min="0"
          max={total}
          value={index}
          aria-label="Step"
          oninput={(e) => uiState.showMoveStep(Number(e.currentTarget.value))}
        />
        <button
          type="button"
          class="step-btn"
          aria-label="Next step"
          disabled={index === total}
          onpointerdown={(e) => startHold(e, 1)}
          onpointerup={stopHold}
          onlostpointercapture={stopHold}
          onpointercancel={stopHold}
          onclick={(e) => {
            // A pointer press already stepped; a click from the keyboard
            // (Enter or Space on the focused button) has no pointer behind it.
            if (e.detail === 0) uiState.showMoveStep(index + 1);
          }}><ChevronRight size={18} /></button
        >
      </div>
    {/if}
  </div>
</div>

<style>
  /* Positioned as the HUD is, which it stands in for: see `HudToolbar`. */
  .steps-dock {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-hud);
    display: flex;
    justify-content: center;
    padding: 0 max(0.5rem, var(--safe-right)) max(0.75rem, var(--safe-bottom))
      calc(max(0.5rem, var(--safe-left)) + var(--sidebar-clearance, 0px));
    transition: padding-left var(--dur) var(--ease);
    pointer-events: none;
  }

  .bar {
    pointer-events: auto;
    width: min(30rem, 100%);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.7rem 0.8rem;
    background: rgba(var(--surface-panel-rgb), 0.94);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius);
    color: var(--text);
  }

  .planning,
  .head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: var(--fs-sm);
  }

  .planning span {
    flex: 1;
    color: var(--text-muted);
  }

  .count {
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .power {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-left: auto;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .delta {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
  }

  /* A step that costs power: a limit the player should see, `--warn`'s. */
  .delta.down {
    color: var(--warn);
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ctl-sm);
    height: var(--ctl-sm);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }

  .icon:hover {
    background: var(--surface-raised);
    color: var(--text);
  }

  .what {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-height: 28px;
    font-size: var(--fs-base);
    font-weight: 600;
  }

  .sprite {
    flex-shrink: 0;
    object-fit: contain;
  }

  .money {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem 0.75rem;
    margin: 0;
    font-size: var(--fs-sm);
  }

  .money dt {
    color: var(--text-muted);
  }

  .money dd {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.3rem;
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .note {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .nav input {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent);
  }

  .step-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ctl);
    height: var(--ctl);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    cursor: pointer;
  }

  /* Held to walk the plan, so a long press must not select or call out. */
  .step-btn {
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    touch-action: manipulation;
  }

  .step-btn:hover:not(:disabled) {
    background: var(--surface-raised);
    border-color: var(--accent-dim);
  }

  /*
   * The one place step mode disables rather than hides: the arrows are a pair
   * the thumb finds by position, and one vanishing at either end would move
   * the other out from under it — the reason Undo and Redo are disabled too.
   */
  .step-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  @media (pointer: coarse) {
    .step-btn {
      width: var(--tap);
      height: var(--tap);
    }
    .icon {
      width: var(--tap);
      height: var(--tap);
    }
  }
</style>
