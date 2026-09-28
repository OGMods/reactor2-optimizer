<script lang="ts">
  import { MIN_GRID_DIM } from "@reactor2/solver";
  import { layoutState } from "../../state";
  import { Minus, Plus } from "lucide-svelte";

  interface Props {
    /**
     * `inline` is the desktop header row; `stacked` is the phone overflow
     * menu, where the labels get their own line and the controls go
     * full-width so they are comfortable to hit with a thumb.
     */
    variant?: "inline" | "stacked";
  }

  let { variant = "inline" }: Props = $props();

  /*
   * The floor is the codec's, not this component's. A blueprint written before
   * the format carried a version byte is recognised by its first byte being a
   * width rather than a version, and that test is "at least `MIN_GRID_DIM`" —
   * so a smaller board here would have made some old codes unreadable.
   */
  const MIN = MIN_GRID_DIM;
  const MAX = 30;

  /*
   * This component assumes the map is resizable. A shipped island's
   * dimensions are part of the map, so its callers do not render it at all
   * there — see `Header` and `OverflowMenu`. `layoutState.resize` refuses
   * regardless, as the backstop.
   */

  const clamp = (n: number) => Math.max(MIN, Math.min(MAX, n));

  function setWidth(value: number) {
    layoutState.resize(clamp(value), layoutState.height);
  }

  function setHeight(value: number) {
    layoutState.resize(layoutState.width, clamp(value));
  }
</script>

<!--
  One stepper, rendered twice.

  The two dimensions are the same control — they differ only in their label,
  the number they read and the setter they call — so they share one snippet
  rather than thirty lines of markup per axis, which is where a fix applied to
  Width but not to Height comes from.

  Steppers rather than a bare `<input type="number">`: such a field sits around
  45px wide with 2px of padding, under the 44px minimum in both axes, and on
  iOS it also summons the keyboard and zooms the page in. Buttons avoid all
  three, and the value stays keyboard-editable via the field between them on
  desktop.
-->
{#snippet stepper(label: string, value: number, set: (n: number) => void)}
  <div class="dim">
    <span class="dim-label">{label}</span>
    <div class="stepper">
      <button
        class="step-btn"
        onclick={() => set(value - 1)}
        disabled={value <= MIN}
        aria-label="Decrease grid {label.toLowerCase()}"
      >
        <Minus size={14} />
      </button>
      <input
        class="dim-value"
        type="number"
        inputmode="numeric"
        min={MIN}
        max={MAX}
        {value}
        oninput={(e) => set(Number(e.currentTarget.value))}
        aria-label="Grid {label.toLowerCase()}"
      />
      <button
        class="step-btn"
        onclick={() => set(value + 1)}
        disabled={value >= MAX}
        aria-label="Increase grid {label.toLowerCase()}"
      >
        <Plus size={14} />
      </button>
    </div>
  </div>
{/snippet}

<div
  class="grid-controls"
  class:stacked={variant === "stacked"}
>
  {@render stepper("Width", layoutState.width, setWidth)}
  {@render stepper("Height", layoutState.height, setHeight)}
</div>

<style>
  /*
   * Zoom has no control here on purpose: it is driven by wheel/pinch in
   * `lib/pixi/viewportControls.ts`, and there is no zoom button to move.
   */
  .grid-controls {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .dim {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .dim-label {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
  }

  .stepper {
    display: flex;
    align-items: center;
    background: rgba(20, 28, 46, 0.8);
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .step-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    /* The compact step; the stacked variant lifts it to the tap floor. */
    width: var(--ctl-sm);
    height: var(--ctl-sm);
    background: transparent;
    border: none;
    color: var(--accent);
    cursor: pointer;
    transition: background var(--dur-fast);
  }

  .step-btn:hover:not(:disabled) {
    background: var(--accent-bg);
  }

  .step-btn:disabled {
    color: var(--text-dim);
    cursor: default;
  }

  .dim-value {
    width: 34px;
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
    color: var(--accent);
    font-family: var(--mono);
    font-size: var(--fs-md);
    font-weight: 600;
    text-align: center;
    padding: 0;
    height: var(--ctl-sm);
    /* Chrome/Safari spinners would blow the width budget. */
    appearance: textfield;
    -moz-appearance: textfield;
  }

  .dim-value::-webkit-outer-spin-button,
  .dim-value::-webkit-inner-spin-button {
    appearance: none;
    margin: 0;
  }

  /* ── Stacked (phone overflow menu) ───────────────────────────────── */
  .grid-controls.stacked {
    flex-direction: column;
    align-items: stretch;
    gap: 0.75rem;
    width: 100%;
  }

  .grid-controls.stacked .dim {
    justify-content: space-between;
  }

  .grid-controls.stacked .dim-label {
    font-size: var(--fs-base);
    color: var(--text-muted);
  }

  .grid-controls.stacked .step-btn {
    width: var(--tap);
    height: var(--tap);
  }

  .grid-controls.stacked .dim-value {
    width: 48px;
    height: var(--tap);
    font-size: var(--fs-lg);
  }
</style>
