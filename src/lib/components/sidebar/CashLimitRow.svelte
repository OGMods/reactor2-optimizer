<script lang="ts">
  import { formatNumber, parseHugeNumber } from "@reactor2/solver";
  import { X } from "lucide-svelte";
  import { configState } from "../../state";
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
   */
  let editing = $state(false);
  let draft = $state("");
  let invalid = $state(false);

  let limit = $derived(configState.cashLimit);
  let fieldValue = $derived(
    editing ? draft : limit === null ? "" : formatNumber(limit),
  );

  function startEditing() {
    draft = limit === null ? "" : formatNumber(limit);
    invalid = false;
    editing = true;
  }

  function commit() {
    if (!editing) return;
    editing = false;
    const text = draft.trim();
    if (text === "") {
      configState.setCashLimit(null);
      return;
    }
    const cash = parseHugeNumber(text);
    // A figure that does not read is dropped and the field falls back to the
    // limit it had — marked, so the typing does not just vanish unexplained.
    invalid = !Number.isFinite(cash) || cash < 0;
    if (!invalid) configState.setCashLimit(cash);
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
    <span class="sub" class:invalid>
      {#if invalid}
        Not a cash figure — try 15AC or 1.5e24
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
    inputmode="decimal"
    autocomplete="off"
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
        invalid = false;
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
