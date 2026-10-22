<script lang="ts">
  import { formatNumber } from "@reactor2/solver";
  import {
    solverState,
    timelineState,
    uiState,
    viewportState,
  } from "../../state";
  import {
    asset,
    formatClockTime,
    formatSpan,
    formatTimeAgo,
  } from "../../utils";

  /*
   * The header's one figure about the whole game rather than the board on
   * screen: every island's power, and the Chronons a jump would pay.
   *
   * Hidden, not disabled, until there is something to say — a fresh visitor
   * with empty islands and no import gets nothing here, not a pill of zeroes.
   * On a phone the pill carries one figure, the Chronons when there are any:
   * the bar already holds the logo, Center View and the menu, and the count is
   * the figure that moves. The details open from it on a tap.
   *
   * The two figures come from different places: power is the boards *here*,
   * live, while the Chronons are the game's, run forward from the last import
   * at the power the game's own boards made. Editing a board here does not
   * change the game, so it does not move the count.
   *
   * The panel leads with the one figure it exists for — what a jump pays now —
   * and keeps everything else to a line. What it leaves out is deliberate: the
   * jump threshold only once the player is below it, and no caveat about the
   * game's slow ticks, which are the game's bug to fix.
   */
  const id = "timeline-status";
  let anchor = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();

  let power = $derived(timelineState.totalPower);
  let record = $derived(timelineState.record);
  let projection = $derived(timelineState.projection);
  let eta = $derived(timelineState.targetEta);
  let visible = $derived(power > 0 || record !== null);
  let compact = $derived(viewportState.isPhone);

  // Re-score the islands whenever a saved board or the rules change; the call
  // reads its inputs before its first await, so this tracks exactly those.
  $effect(() => {
    // Stored solves are read off storage, which nothing tracks; a solve that
    // lands or a variant applied is what changes them.
    void solverState.optimizationResult;
    void solverState.appliedVariant;
    void timelineState.refreshIslands();
  });

  let pace = $derived(timelineState.pace);

  /*
   * Every island with its stored solve built, and what that adds over the
   * power the count runs at — the game's when there is an import. Shown only
   * when the solves would actually add something.
   */
  let withSolves = $derived(timelineState.withSolvesPower);
  let solvesGain = $derived.by(() => {
    const base = record?.energyPerTick ?? power;
    if (withSolves === null || base <= 0 || withSolves <= base) return null;
    const pct = (withSolves / base - 1) * 100;
    return pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  });

  /** A rate in Chronons an hour: a decimal while small, whole past ten. */
  const rate = (perHour: number) =>
    perHour >= 10 ? Math.round(perHour).toString() : perHour.toFixed(1);

  // Tick only while there is a timeline to count down.
  $effect(() => {
    if (record?.timeline) return timelineState.startClock();
  });

  /*
   * The game's power at export, beside the live total when the two differ —
   * the sign a board here has moved on from the game's, and that the count
   * is still running at the game's rate.
   */
  let gamePower = $derived(record?.energyPerTick ?? null);
  let diverged = $derived(
    gamePower !== null &&
      Math.abs(gamePower - power) > 1e-6 * Math.max(gamePower, power),
  );

  let bonusNames = $derived(
    timelineState.unenteredAnomalies.map((a) => a.name).join(" or "),
  );

  /*
   * Tap-to-set targets sized to the award (`timelineState.quickTargets`): on
   * a phone, typing is the exception rather than the way in.
   */
  let quickTargets = $derived(timelineState.quickTargets);

  /*
   * Past this, a wait is not a plan: the award grows with energy to the power
   * 0.135, so a target far above it can be centuries out — and past the
   * largest date there is, which is how "Invalid Date" reached the panel.
   */
  const OUT_OF_REACH_S = 365 * 86400;

  const count = (n: number) => n.toLocaleString("en-US");
  const short = (n: number) =>
    n >= 1000 && n % 1000 === 0 ? `${count(n / 1000)}k` : count(n);

  /*
   * The field is bare digits while it has focus and comma-grouped once it
   * leaves: "12000" to type in, "12,000" to read. Every keystroke sets the
   * target, so the countdown and the chips follow the number as it is typed.
   *
   * While focused it shows `draft`, not the target: the target is formatted,
   * and binding the field to it would rewrite the text under the caret on
   * every keystroke. Anything but a digit is dropped as it is typed, and an
   * empty field goes back to the default.
   */
  let editing = $state(false);
  let draft = $state("");

  let fieldValue = $derived(
    editing
      ? draft
      : timelineState.chrononTarget === null
        ? ""
        : count(timelineState.chrononTarget),
  );

  function startEditing() {
    draft =
      timelineState.chrononTarget === null
        ? ""
        : String(timelineState.chrononTarget);
    editing = true;
  }

  function editTarget(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    draft = input.value.replace(/\D/g, "");
    // Only when something was dropped: rewriting an unchanged field would
    // still move the caret to its end.
    if (input.value !== draft) input.value = draft;
    timelineState.setChrononTarget(draft ? Number(draft) : null);
  }

  const GAP = 6;
  const EDGE = 8;

  /** Under the pill, right edges aligned, kept inside the viewport. */
  function place() {
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const left = Math.max(EDGE, Math.min(a.right - w, innerWidth - w - EDGE));
    panel.style.left = `${left}px`;
    panel.style.top = `${a.bottom + GAP}px`;
  }

  function onToggle(e: ToggleEvent) {
    if (e.newState === "open") place();
  }

  function planTimeLab() {
    panel?.hidePopover();
    uiState.openTimeLabPlanner();
  }

  function solveAll() {
    panel?.hidePopover();
    void uiState.solveAllIslands();
  }

  function importCode() {
    panel?.hidePopover();
    uiState.openImport();
  }
</script>

<!-- The game's energy bolt, beside every power figure as the board shows it. -->
{#snippet energy()}
  <img src={asset("icons/icon_energy.webp")} alt="" width="14" height="14" />
{/snippet}

{#snippet chronon()}
  <img src={asset("icons/icon_chronon.webp")} alt="" width="14" height="14" />
{/snippet}

{#if visible}
  <button
    bind:this={anchor}
    type="button"
    class="pill"
    class:compact
    popovertarget={id}
    aria-label={projection
      ? `Timeline: ${count(projection.award)} Chronons on a jump, ${formatNumber(power)} power`
      : `All islands: ${formatNumber(power)} power`}
  >
    {#if !compact || !projection}
      <span class="figure">
        <img
          src={asset("icons/icon_energy.webp")}
          alt=""
          width="16"
          height="16"
        />
        {formatNumber(power)}
      </span>
    {/if}
    {#if projection}
      <span class="figure">
        <img
          src={asset("icons/icon_chronon.webp")}
          alt=""
          width="16"
          height="16"
        />
        {count(projection.award)}
      </span>
    {/if}
  </button>

  <div bind:this={panel} {id} class="panel" popover="auto" ontoggle={onToggle}>
    {#if projection && record?.timeline}
      <!--
        What a jump would pay now, first and largest, and how far the next
        Chronon is along — the game's own bar. "Jump reward" is the game's
        word for it, and a noun: "Jump now" read as an order.
      -->
      <section class="hero">
        <span class="label">Jump reward</span>
        <span class="award">
          <img
            src={asset("icons/icon_chronon.webp")}
            alt=""
            width="22"
            height="22"
          />
          {count(projection.award)}
        </span>
        {#if bonusNames}
          <span class="aside">+88 if you enter {bonusNames}</span>
        {/if}
        {#if projection.secondsToNext !== null}
          <div
            class="bar"
            role="progressbar"
            aria-label="Toward the next Chronon"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(projection.towardNext * 100)}
          >
            <span style:width="{projection.towardNext * 100}%"></span>
          </div>
          <span class="aside">
            Next in {formatSpan(
              projection.secondsToNext,
            )}{projection.chrononSeconds !== null
              ? ` of ${formatSpan(projection.chrononSeconds)}`
              : ""}
          </span>
        {/if}
        {#if pace}
          <span class="aside">
            Earning {rate(pace.nowPerHour)}/h now · {rate(
              pace.averagePerHour,
            )}/h on average
          </span>
          <span class="verdict">
            {pace.nowPerHour < pace.averagePerHour
              ? "Past the best point: a fresh timeline would earn faster"
              : "Waiting still pays: you're above your average"}
          </span>
        {/if}
        {#if !projection.canJump}
          <span class="limit">
            Jumping unlocks at {count(projection.threshold)}
          </span>
        {/if}
      </section>

      <dl>
        <dt>Power</dt>
        <dd>
          {#if diverged && gamePower !== null}
            <span class="aside">game {formatNumber(gamePower)}</span>
          {/if}
          {@render energy()}
          {formatNumber(power)}
        </dd>
        {#if solvesGain !== null && withSolves !== null}
          <dt>With solves</dt>
          <dd>
            <span class="aside">+{solvesGain}%</span>
            {@render energy()}
            {formatNumber(withSolves)}
          </dd>
        {/if}
        <!--
          How many islands the solve figures cover, and the way to cover the
          rest. The button hides whenever "Solve all" cannot start, and a batch
          in flight says where it is instead.
        -->
        <dt>Solves</dt>
        <dd>
          {#if uiState.solveAll}
            <span class="aside">
              solving {uiState.solveAll.done + 1} of {uiState.solveAll.total}
            </span>
          {:else}
            <span class="aside">
              {timelineState.solvedIslands} of {uiState.solveAllTargets.length}
              islands
            </span>
            {#if uiState.canSolveAll}
              <button type="button" class="mini" onclick={solveAll}>
                Solve all
              </button>
            {/if}
          {/if}
        </dd>
        <!-- What the jump leaves to spend, and the way to plan spending it. -->
        {#if timelineState.planBudget !== null}
          <dt>Time Lab</dt>
          <dd>
            <span class="aside">{count(timelineState.planBudget)} to spend</span
            >
            <button type="button" class="mini" onclick={planTimeLab}>
              Plan
            </button>
          </dd>
        {/if}
        <dt>Held</dt>
        <dd>{@render chronon()}{count(record.timeline.chronons)}</dd>
        <dt>Timeline</dt>
        <dd>{formatSpan(projection.elapsedSeconds)}</dd>
      </dl>

      {#if eta}
        <section class="goal">
          <label class="target">
            <span class="label">Reach</span>
            <input
              type="text"
              inputmode="numeric"
              autocomplete="off"
              aria-label="Target jump award, in Chronons"
              value={fieldValue}
              placeholder={count(timelineState.defaultTarget)}
              onfocus={startEditing}
              oninput={editTarget}
              onblur={() => (editing = false)}
              onkeydown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
          <div class="chips" role="group" aria-label="Quick targets">
            {#each quickTargets as value (value)}
              <button
                type="button"
                class="chip"
                class:active={eta.target === value}
                aria-pressed={eta.target === value}
                onclick={() => timelineState.setChrononTarget(value)}
              >
                {short(value)}
              </button>
            {/each}
          </div>
          <!--
            A target already met says nothing here: the hold line below is the
            answer, and an empty field — today's award — is exactly that case.
          -->
          {#if eta.seconds === null || eta.at === null}
            <p class="when">Never — nothing is producing</p>
          {:else if eta.seconds > OUT_OF_REACH_S}
            <p class="when">More than a year away at this power</p>
          {:else if eta.seconds > 0}
            <p class="when">
              In <strong>{formatSpan(eta.seconds)}</strong>
              · {formatClockTime(eta.at, timelineState.now)}
            </p>
            {#if eta.secondsWithSolves !== null}
              <p class="aside">
                {formatSpan(eta.secondsWithSolves)} if the game ran your solves
              </p>
            {/if}
          {/if}
          <p class="aside">
            You'd hold {count(eta.held)}{bonusNames
              ? `, or ${count(eta.held + 88)} with the +88`
              : ""}
          </p>
        </section>
      {/if}

      <footer>
        <span class:limit={record.timeline.stampSource === "device"}>
          Exported {formatTimeAgo(
            record.timeline.exportedAt * 1000,
            timelineState.now,
          )}{record.timeline.stampSource === "device"
            ? ", game clock not synced"
            : ""}
        </span>
        <button type="button" class="link" onclick={importCode}>
          Re-import
        </button>
      </footer>
    {:else}
      <dl class="plain">
        <dt>Power, all islands</dt>
        <dd>{@render energy()}{formatNumber(power)}</dd>
      </dl>
      <p class="aside">
        {record
          ? "Your last import is from before game 1.1.11, which has no timeline."
          : "Import your game's code to count your Chronons here."}
      </p>
      <button type="button" class="link start" onclick={importCode}>
        Import game code
      </button>
    {/if}
  </div>
{/if}

<style>
  /*
   * Neutral, like every header action: a readout earns no hue under the
   * colour law, and the icons already carry the game's own.
   */
  .pill {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    height: var(--ctl);
    padding: 0 0.7rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: var(--fs-base);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
    transition: all var(--dur-fast);
  }

  .pill:hover {
    background: var(--surface-raised);
    border-color: var(--accent-dim);
  }

  .pill.compact {
    height: var(--tap);
    padding: 0 0.55rem;
  }

  @media (pointer: coarse) {
    .pill {
      min-height: var(--tap);
    }
  }

  .figure {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  img {
    flex-shrink: 0;
  }

  /* Reset the UA's centred-dialog placement; `place()` sets top and left. */
  .panel {
    position: fixed;
    inset: auto;
    margin: 0;
    display: none;
    flex-direction: column;
    gap: 0.7rem;
    width: min(18rem, calc(100vw - 16px));
    padding: 0.8rem 0.85rem;
    background: var(--surface-panel-solid);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius);
    color: var(--text);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  }

  .panel:popover-open {
    display: flex;
  }

  .label {
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .aside {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  /* A jump the game will not allow yet, or an unsynced clock: limits, `--warn`'s. */
  .limit {
    font-size: var(--fs-xs);
    color: var(--warn);
  }

  /* Advice, not a limit and not a selection: plain text, a step up from aside. */
  .verdict {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }

  .hero {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .award {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--fs-xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  /*
   * Neutral on purpose: the colour law keeps `--accent` for "selected" and the
   * board's colours for buildings, and a progress bar is neither.
   */
  .bar {
    height: 4px;
    margin-top: 0.35rem;
    border-radius: var(--radius-pill);
    background: var(--border);
    overflow: hidden;
  }

  .bar > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--text-muted);
  }

  /* Each block after the headline is set off by a rule, not a heading. */
  dl,
  .goal,
  footer {
    padding-top: 0.65rem;
    border-top: 1px solid var(--border);
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.75rem;
    margin: 0;
    font-size: var(--fs-sm);
  }

  dl.plain {
    padding-top: 0;
    border-top: 0;
  }

  dt {
    color: var(--text-muted);
  }

  dd {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.4rem;
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .goal {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .target {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  /*
   * 16px, off the type ladder on purpose and for the same reason as the Import
   * textarea: iOS Safari zooms the page in on a focused field smaller than
   * that, and on a phone this field is the one being typed in.
   */
  .target input {
    flex: 1;
    min-width: 0;
    height: var(--ctl-sm);
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    color: var(--text);
    font: inherit;
    font-size: 16px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .target input:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }

  .chips {
    display: flex;
    gap: 0.35rem;
  }

  .chip {
    flex: 1;
    height: var(--ctl-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: all var(--dur-fast);
  }

  .chip:hover {
    background: var(--surface-raised);
    color: var(--text);
  }

  /* The target in force: a selection, which is what `--accent` means. */
  .chip.active {
    border-color: var(--accent);
    background: var(--accent-bg);
    color: var(--accent);
  }

  .when {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }

  .when strong {
    font-size: var(--fs-md);
    color: var(--text);
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .link {
    flex-shrink: 0;
    padding: 0.3rem 0.65rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .link:hover {
    background: var(--surface-raised);
    border-color: var(--accent-dim);
  }

  .mini {
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: var(--fs-xs);
    font-weight: 600;
    cursor: pointer;
  }

  .mini:hover {
    background: var(--surface-raised);
    border-color: var(--accent-dim);
  }

  .link.start {
    align-self: flex-start;
  }

  @media (pointer: coarse) {
    .chip,
    .mini,
    .link {
      min-height: var(--tap);
    }
  }
</style>
