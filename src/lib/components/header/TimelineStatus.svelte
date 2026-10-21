<script lang="ts">
  import { formatNumber } from "@reactor2/solver";
  import { timelineState, uiState, viewportState } from "../../state";
  import { asset, formatSpan, formatTimeAgo } from "../../utils";

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
   * The two figures come from different places, and the panel says so: power
   * is the boards *here*, live, while the Chronons are the game's, run forward
   * from the last import at the power the game's own boards made. Editing a
   * board here does not change the game, so it does not move the count.
   */
  const id = "timeline-status";
  let anchor = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();

  let power = $derived(timelineState.totalPower);
  let record = $derived(timelineState.record);
  let projection = $derived(timelineState.projection);
  let visible = $derived(power > 0 || record !== null);
  let compact = $derived(viewportState.isPhone);

  // Re-score the islands whenever a saved board or the rules change; the call
  // reads its inputs before its first await, so this tracks exactly those.
  $effect(() => {
    void timelineState.refreshIslands();
  });

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

  const count = (n: number) => n.toLocaleString("en-US");

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

  function importCode() {
    panel?.hidePopover();
    uiState.openImport();
  }
</script>

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
    <section>
      <h2>All islands</h2>
      <dl>
        <dt>Power</dt>
        <dd>{formatNumber(power)}</dd>
        {#if diverged && gamePower !== null}
          <dt>In the game at export</dt>
          <dd>{formatNumber(gamePower)}</dd>
        {/if}
      </dl>
    </section>

    {#if projection && record?.timeline}
      <section>
        <h2>Timeline</h2>
        <dl>
          <dt>Jump now</dt>
          <dd class="strong">
            <img
              src={asset("icons/icon_chronon.webp")}
              alt=""
              width="14"
              height="14"
            />
            {count(projection.award)}
          </dd>
          {#if bonusNames}
            <dt>First entry</dt>
            <dd>+88 for {bonusNames}</dd>
          {/if}
          <dt>Next Chronon</dt>
          <dd>
            {projection.secondsToNext === null
              ? "—"
              : `in ${formatSpan(projection.secondsToNext)}`}
          </dd>
          <dt>Jump needs</dt>
          <dd class:short={!projection.canJump}>
            {count(projection.threshold)} · {projection.canJump
              ? "ready"
              : "not yet"}
          </dd>
          <dt>Chronons held</dt>
          <dd>{count(record.timeline.chronons)}</dd>
          <dt>Timeline</dt>
          <dd>{formatSpan(projection.elapsedSeconds)}</dd>
        </dl>
      </section>
      <p class="note">
        From your game export {formatTimeAgo(
          record.timeline.exportedAt * 1000,
          timelineState.now,
        )}, game {record.gameVersion}. Counted forward at the power your game's
        boards made then; re-import after changing them in the game.
      </p>
      {#if record.timeline.stampSource === "device"}
        <!--
          The game had not synced its clock, so the stamp is the phone's own:
          every figure above is counted from a moment that may be off by as
          far as the phone's clock is. A limit on what the panel knows, which
          is `--warn`'s.
        -->
        <p class="note warn">
          The game hadn't synced its clock when it exported, so the countdown
          may be off by as much as your phone's clock is.
        </p>
      {/if}
    {:else}
      <p class="note">
        {record
          ? "Your last import is from before game 1.1.11, which has no timeline."
          : "Import your game's code to count your Chronons here."}
      </p>
      <button type="button" class="link" onclick={importCode}>
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
    gap: 0.6rem;
    width: min(18rem, calc(100vw - 16px));
    padding: 0.7rem 0.8rem;
    background: var(--surface-panel-solid);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius);
    color: var(--text);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  }

  .panel:popover-open {
    display: flex;
  }

  h2 {
    margin: 0 0 0.3rem;
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
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
    text-align: right;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  dd.strong {
    font-size: var(--fs-md);
  }

  /* A jump the game will not allow yet is a limit, which is `--warn`'s. */
  dd.short {
    color: var(--warn);
  }

  .note {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    line-height: 1.4;
  }

  .note.warn {
    color: var(--warn);
  }

  .link {
    align-self: flex-start;
    padding: 0.35rem 0.6rem;
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
</style>
