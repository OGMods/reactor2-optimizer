<script lang="ts">
  import {
    formatNumber,
    parseHugeNumber,
    TICK_SECONDS,
  } from "@reactor2/solver";
  import { X } from "lucide-svelte";
  import { configState, timelineState } from "../../state";
  import { asset } from "../../utils/assetUrl";

  /*
   * The cash limit: solve for the most power a sum of cash buys, rather than
   * the most power at any price.
   *
   * On the Buildings tab beside the upgrade plan, because both are about what
   * the player is about to buy. Inline rather than behind a dialog like the
   * plan: it is one figure, and a player tries a few of them in a row.
   *
   * The figure is what changing the board into the layout may cost, net of
   * what selling pays back — the board in Edit is what stands, and keeping or
   * moving a building is free. Typed in the game's own notation ("15AC") or as
   * a plain number, read by `parseHugeNumber`, and committed on Enter or blur
   * so a half-typed figure never reaches the store.
   *
   * A figure under `MIN_LIMIT_SECONDS` of income is refused: the islands
   * earn it back in minutes, so a run held to it answers a question nobody is
   * asking and only hides what the next few seconds of play would buy. Income
   * is the power every island makes per tick, which is what selling it pays —
   * before a Rush Hour, which only makes the floor looser.
   */
  const MIN_LIMIT_SECONDS = 30 * 60;
  let editing = $state(false);
  let draft = $state("");
  // What the field showed on focus. The display rounds to 3 significant
  // figures, so re-parsing an untouched field would silently rewrite the
  // stored limit to the rounded figure; a draft still equal to this is left
  // alone.
  let seeded = "";
  /** Why the last figure typed was refused, or null. */
  let refusal = $state<string | null>(null);
  let invalid = $derived(refusal !== null);
  let floor = $derived(
    (timelineState.totalPower * MIN_LIMIT_SECONDS) / TICK_SECONDS,
  );

  let limit = $derived(configState.cashLimit);
  let fieldValue = $derived(
    editing ? draft : limit === null ? "" : formatNumber(limit),
  );

  function startEditing() {
    draft = seeded = limit === null ? "" : formatNumber(limit);
    refusal = null;
    editing = true;
  }

  function commit() {
    if (!editing) return;
    editing = false;
    const text = draft.trim();
    if (text === seeded.trim()) return;
    if (text === "") {
      configState.setCashLimit(null);
      return;
    }
    const cash = parseHugeNumber(text);
    // A figure that does not read, or one too tight to be worth a run, is
    // dropped and the field falls back to the limit it had — marked, so the
    // typing does not just vanish unexplained.
    if (!Number.isFinite(cash) || cash < 0)
      refusal = "Not a cash figure — try 15AC or 1.5e24";
    else if (cash < floor)
      refusal = `Too tight — at least ${formatNumber(floor)}`;
    else configState.setCashLimit(cash);
  }
</script>

<div class="cash-limit" class:active={limit !== null}>
  <img
    class="icon"
    src={asset("icons/icon_cash.webp")}
    alt=""
    width="15"
    height="15"
  />
  <label class="text" for="cash-limit-field">
    <span class="title">Cash limit</span>
    <!-- One line that clips on a narrow sheet, so a refusal reads in full on
         hover too. -->
    <span class="sub" class:invalid title={refusal ?? undefined}>
      {#if refusal !== null}
        {refusal}
      {:else if limit === null}
        Solve for the most power a sum buys
      {:else}
        Kept buildings cost nothing
      {/if}
    </span>
  </label>
  <input
    id="cash-limit-field"
    type="text"
    inputmode="text"
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    placeholder="Any"
    value={fieldValue}
    onfocus={startEditing}
    oninput={(e) => (draft = e.currentTarget.value)}
    onblur={commit}
    onkeydown={(e) => {
      if (e.key === "Enter") e.currentTarget.blur();
    }}
  />
  {#if limit !== null}
    <button
      type="button"
      class="clear"
      aria-label="Remove the cash limit"
      title="Remove the cash limit"
      onclick={() => {
        refusal = null;
        configState.setCashLimit(null);
      }}
    >
      <X size={14} />
    </button>
  {/if}
</div>

<style>
  .cash-limit {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    margin-bottom: 0.6rem;
    padding: 0.4rem 0.5rem 0.4rem 0.6rem;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
  }

  /* A limit in force changes what every run does, so it is marked the way the
     plan row beside it is. */
  .cash-limit.active {
    border-color: var(--accent-dim);
  }

  .icon {
    flex: 0 0 auto;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
    min-width: 0;
  }

  .title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
  }

  .sub {
    font-size: var(--fs-2xs);
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub.invalid {
    color: var(--warn);
  }

  /*
   * 16px, off the type ladder on purpose: iOS Safari zooms the page in on a
   * focused field smaller than that, as the timeline's target field notes.
   */
  input {
    flex: 0 1 6.5rem;
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

  input:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }

  .clear {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: var(--ctl-sm);
    height: var(--ctl-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }

  .clear:hover {
    border-color: var(--accent-dim);
    color: var(--text);
  }

  @media (pointer: coarse) {
    .cash-limit {
      min-height: var(--tap);
    }

    .clear {
      width: var(--tap);
      height: var(--tap);
    }
  }
</style>
