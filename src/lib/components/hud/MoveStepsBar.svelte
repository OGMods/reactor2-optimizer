<script lang="ts">
  import { findBuilding, formatNumber } from "@reactor2/solver";
  import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-svelte";
  import { layoutState, uiState, viewportState } from "../../state";
  import type { MoveStep } from "../../simulation/moveSteps";
  import { asset, formatTileCoords } from "../../utils";
  import KindFilter from "./KindFilter.svelte";
  import { KIND_META } from "./buildingKinds";

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

  /*
   * Short: a phone split-screened beside the game, which is where the steps
   * are walked. The arrows move up either side of the step's own line and the
   * slider goes, which takes a 44px row out of a bar that is otherwise most of
   * a 400px screen. The arrows are what a thumb walks a plan with; scrubbing
   * is for reading it, and that is the full-height screen's job.
   */
  let short = $derived(viewportState.isShort);

  /*
   * "Not now" on the last step's offer, for this plan: asked once, not again
   * every time the player steps back and forward past the end.
   */
  let applyDeclined = $state<object | null>(null);
  let total = $derived(m?.plan.steps.length ?? 0);
  let step = $derived(m && index > 0 ? m.plan.steps[index - 1] : null);
  let power = $derived(m ? m.plan.powers[index] : 0);
  let before = $derived(m && index > 0 ? m.plan.powers[index - 1] : null);
  let end = $derived(m ? m.plan.powers[total] : 0);

  /** The plan in one line: how many of each kind of step. */
  let summary = $derived.by(() => {
    if (!m) return "";
    const n = {
      move: 0,
      swap: 0,
      replace: 0,
      build: 0,
      sell: 0,
      clear: 0,
      sellAll: 0,
    };
    for (const s of m.plan.steps) n[s.kind]++;
    return [
      n.clear && `${n.clear} to clear`,
      n.sellAll && "sell everything",
      n.move && `${n.move} to move`,
      n.swap && `${n.swap} to swap`,
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
      case "swap":
        return `Swap ${nameOf(s.a.buildingId)} at ${at(s.a.x, s.a.y)} with ${nameOf(s.b.buildingId)} at ${at(s.b.x, s.b.y)}`;
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
      case "swap":
        return asset(`icons/${s.a.buildingId}.webp`);
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
    // A dialog over the bar has the keys: the arrows must not step behind it.
    if (!m || e.target instanceof HTMLInputElement) return;
    if (uiState.activeModal !== null) return;
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

{#snippet prevButton()}
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
    }}><ChevronLeft size={16} /></button
  >
{/snippet}

{#snippet nextButton()}
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
    }}><ChevronRight size={16} /></button
  >
{/snippet}

<div class="steps-dock" bind:clientHeight={measuredHeight}>
  {#if m && !planning}
    <!--
      The kind filter rides above the bar as it does above the solver board's
      actions: a step's own building stays drawn large, with the rest of the
      kind picked out beside it for where it goes among them.
    -->
    <KindFilter />
  {/if}
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
          onclick={() => uiState.closeMoveSteps()}><X size={14} /></button
        >
      </div>
    {:else}
      <div class="head">
        <span class="count">
          {index === 0 ? "Start" : `Step ${index} of ${total}`}
        </span>
        {#if price && (price.spend > 0 || price.refund > 0)}
          <!--
            This step's cash, on the head line rather than a row of its own:
            what it costs, and what a sale in it pays back.
          -->
          <span class="step-cash">
            {#if price.spend > 0}{@render cash()}{formatNumber(
                price.spend,
              )}{/if}
            {#if price.refund > 0}<span class="back"
                >+{formatNumber(price.refund)} back</span
              >{/if}
          </span>
        {/if}
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
          onclick={() => uiState.closeMoveSteps()}><X size={14} /></button
        >
      </div>

      <div class="what">
        {#if short}{@render prevButton()}{/if}
        {#if step}
          {#if iconOf(step)}
            <img
              class="sprite"
              src={iconOf(step)}
              alt=""
              width="24"
              height="24"
            />
          {/if}
          <span>{describe(step)}</span>
        {:else}
          <span>
            Your board in Edit. {summary} to reach {formatNumber(end)}.
          </span>
        {/if}
        {#if short}<span class="what-end">{@render nextButton()}</span>{/if}
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
      {#if index === total && total > 0 && applyDeclined !== m.plan && !layoutState.isPreview}
        <!--
          The end of the walk: the player has, presumably, built it in the
          game. Their board in Edit is still the island as it started, and that
          is what Island stats and the timeline count — so offer to bring it
          up to date, as the readout's Copy would. Asked, not done: they may
          only have been reading the plan.
        -->
        <div class="apply">
          <p>Built it? Put it on your board in Edit for Island stats.</p>
          <div class="apply-actions">
            <button
              type="button"
              class="apply-btn"
              onclick={() => (applyDeclined = m.plan)}>Not now</button
            >
            <button
              type="button"
              class="apply-btn primary"
              onclick={() => uiState.applyMoveSteps()}>Update my board</button
            >
          </div>
        </div>
      {/if}
      {#if index === 0 && money && (money.spend > 0 || money.refund > 0)}
        <!--
          The cash the whole plan moves: everything it buys, and everything its
          sales pay back. "Cash on hand needed" is the peak a player has to hold,
          since refunds land along the way. None of it is set against the cash
          in the export: that is a snapshot, stale as soon as the game earns on,
          and doubled by a rush hour.
        -->
        <p class="money">
          <span
            ><span class="money-label">Costs</span>
            {@render cash()}{formatNumber(money.spend)}</span
          >
          {#if money.refund > 0}
            <span
              ><span class="money-label">Refunds</span>
              {@render cash()}{formatNumber(money.refund)}</span
            >
          {/if}
          {#if money.peak > 0 && money.peak < money.spend}
            <span
              ><span class="money-label">Hold at once</span>
              {@render cash()}{formatNumber(money.peak)}</span
            >
          {/if}
        </p>
      {/if}
      {#if index === 0 && lowest < power}
        <p class="note">
          Lowest on the way: {formatNumber(lowest)}, {delta(lowest, power)}
          from now.
        </p>
      {/if}
      {#if index === 0}
        <!--
          The order, offered at the start where the plan is summed up: the most
          power first keeps the island earning, one kind at a time is simpler
          to carry out. Changing it plans again.
        -->
        <div class="order" role="group" aria-label="Order of the steps">
          <span class="order-label">Order</span>
          <button
            type="button"
            class="order-btn"
            class:active={uiState.stepOrder === "power"}
            aria-pressed={uiState.stepOrder === "power"}
            title="Each step the one that leaves the most power"
            onclick={() => uiState.setStepOrder("power")}>Most power</button
          >
          <button
            type="button"
            class="order-btn"
            class:active={uiState.stepOrder === "kind"}
            aria-pressed={uiState.stepOrder === "kind"}
            title="One kind at a time, in an order you choose"
            aria-haspopup="dialog"
            onclick={() => uiState.openStepOrder()}>By kind</button
          >
        </div>
        {#if uiState.stepOrder === "kind"}
          <!--
            The order in one line; it is set in its own dialog
            (`StepOrderModal`), which "By kind" opens too.
          -->
          <p class="note kinds-line">
            <span
              >{uiState.stepKinds.map((k) => KIND_META[k].label).join(" → ")},
              row by row.</span
            >
            <button
              type="button"
              class="link-btn"
              onclick={() => uiState.openStepOrder()}>Change</button
            >
          </p>
        {/if}
      {/if}

      {#if !short}
        <div class="nav">
          {@render prevButton()}
          <input
            type="range"
            min="0"
            max={total}
            value={index}
            aria-label="Step"
            oninput={(e) => uiState.showMoveStep(Number(e.currentTarget.value))}
          />
          {@render nextButton()}
        </div>
      {/if}
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
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0 max(0.5rem, var(--safe-right)) max(0.5rem, var(--safe-bottom))
      calc(max(0.5rem, var(--safe-left)) + var(--sidebar-clearance, 0px));
    transition: padding-left var(--dur) var(--ease);
    pointer-events: none;
  }

  .bar {
    pointer-events: auto;
    width: min(30rem, 100%);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.45rem 0.6rem 0.5rem;
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
    gap: 0.5rem;
    min-height: var(--ctl-sm);
    font-size: var(--fs-sm);
  }

  .count {
    white-space: nowrap;
  }

  .step-cash {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-size: var(--fs-xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .back {
    color: var(--text-dim);
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

  /*
   * Close and Cancel: 32px at every pointer, the readout head's own buttons'
   * size. It used to grow to 44px on touch with negative margins to keep the
   * line short, which pushed it into the bar's corner and onto the next-step
   * arrow below it.
   */
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ctl-sm);
    height: var(--ctl-sm);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }

  .icon:hover {
    background: var(--surface-raised);
    color: var(--text);
  }

  .what {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 24px;
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.3;
  }

  /* Short: the next arrow pinned to the far end, however short the line. */
  .what-end {
    display: flex;
    margin-left: auto;
  }

  .sprite {
    flex-shrink: 0;
    object-fit: contain;
  }

  /* The plan's cash on one line, wrapping only when it must. */
  .money {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.85rem;
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .money > span {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .money-label {
    font-weight: 400;
    color: var(--text-muted);
  }

  .note {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .order {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-sm);
  }

  .order-label {
    margin-right: auto;
    color: var(--text-muted);
  }

  .order-btn {
    min-height: var(--ctl-sm);
    padding: 0.2rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
  }

  /* Hover only where there is one: on touch it sticks after the tap. */
  @media (hover: hover) {
    .order-btn:hover {
      color: var(--text);
      background: var(--surface-raised);
    }
  }

  /* Selected takes `--accent`, as everywhere: see the colour law in app.css. */
  .order-btn.active {
    background: var(--accent-bg);
    border-color: var(--accent-line);
    color: var(--accent);
  }

  .kinds-line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .link-btn {
    flex-shrink: 0;
    padding: 0;
    border: 0;
    background: transparent;
    /* Not `--accent`: that means selected, and a link is not (colour law). */
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  /*
   * The question and its answers on one line where they fit, two where not.
   * Neutral, not accented: a prompt is not a selection (colour law), and
   * `--action` is RUN's alone.
   */
  .apply {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.5rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-inset);
  }

  .apply p {
    flex: 1 1 12rem;
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.35;
    color: var(--text);
  }

  .apply-actions {
    display: flex;
    flex: 1 1 auto;
    gap: 0.4rem;
  }

  .apply-btn {
    flex: 1;
    min-height: var(--ctl-sm);
    padding: 0 0.6rem;
    white-space: nowrap;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
  }

  /* The answer the prompt is for, set apart by weight rather than hue. */
  .apply-btn.primary {
    color: var(--text);
    background: var(--surface-raised);
  }

  @media (hover: hover) {
    .apply-btn:hover {
      color: var(--text);
      background: var(--surface-raised);
    }
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
    width: var(--ctl-sm);
    height: var(--ctl-sm);
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
    /*
     * `--ctl`, under the tap floor on purpose. At 44px the pair were the
     * largest thing in the bar and read heavier than the step they frame; two
     * fixed squares at the bar's far ends are found by position, not aim.
     */
    .step-btn {
      width: var(--ctl);
      height: var(--ctl);
    }
    /*
     * Below the tap floor on purpose: a setting chosen once per plan, not a
     * control walked with the thumb, and at 44px the two of them made the
     * start of the plan a row taller for it.
     */
    .order-btn {
      min-height: var(--ctl);
    }
    .apply-btn {
      min-height: var(--tap);
    }
    /* A full thumb target inside a line of small text, without growing it. */
    .link-btn {
      min-height: var(--tap);
      margin: -0.75rem -0.25rem;
      padding: 0 0.25rem;
    }
  }
</style>
