<script lang="ts">
  import type { Snippet } from "svelte";
  import { formatNumberFull } from "@reactor2/solver";

  /*
   * A figure that will show every digit on request: hover it with a mouse, or
   * tap it on a phone, and the compact `611AC` opens into `611,210,546AA`.
   *
   * The popup is a native `popover`, for two reasons that are both about the
   * card it sits in. It renders in the top layer, so the card's scrolling body
   * and `backdrop-filter` (which makes `position: fixed` relative to the card)
   * cannot clip or displace it. And `popovertarget` gives the tap its whole
   * behaviour for free: the button toggles it, a tap anywhere else or Esc
   * dismisses it, and the button is exempt from that dismissal so a second tap
   * closes rather than closing-then-reopening.
   *
   * Hover is layered on top for a mouse only — on touch, `pointerenter` fires
   * on the same tap that toggles, and the two would fight. A popover opened by
   * a click stays open when the pointer leaves; one opened by hover does not.
   */
  let {
    value,
    label,
    align = "start",
    children,
  }: {
    value: number;
    /** Says what the figure is, for a screen reader and the popup's heading. */
    label: string;
    /** Which edge of the figure the popup lines up with. */
    align?: "start" | "end";
    children: Snippet;
  } = $props();

  const uid = $props.id();
  const id = `full-number-${uid}`;
  let anchor = $state<HTMLButtonElement>();
  let tip = $state<HTMLDivElement>();
  let pinned = false;

  const GAP = 6;
  const EDGE = 8;

  /** Below the figure, kept inside the viewport. */
  function place() {
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = align === "end" ? a.right - w : a.left;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE));
    let top = a.bottom + GAP;
    if (top + h > window.innerHeight - EDGE) top = a.top - GAP - h;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function onToggle(e: ToggleEvent) {
    if (e.newState === "open") place();
    else pinned = false;
  }

  function hoverOpen(e: PointerEvent) {
    if (e.pointerType !== "mouse" || !tip || tip.matches(":popover-open"))
      return;
    tip.showPopover();
  }

  function hoverClose(e: PointerEvent) {
    if (e.pointerType !== "mouse" || pinned || !tip) return;
    if (tip.matches(":popover-open")) tip.hidePopover();
  }

  /*
   * Runs before the native toggle. A mouse click on a figure hover already
   * opened would toggle it shut under the cursor, so it pins instead; any other
   * click — a tap, or a click on a closed figure — toggles as usual and pins
   * what it opens.
   */
  function onClick(e: MouseEvent) {
    if (!tip) return;
    const open = tip.matches(":popover-open");
    if (open && !pinned && (e as PointerEvent).pointerType === "mouse") {
      e.preventDefault();
      pinned = true;
      return;
    }
    pinned = !open;
  }
</script>

<button
  bind:this={anchor}
  type="button"
  class="figure"
  popovertarget={id}
  aria-label="{label}: {formatNumberFull(value)}"
  onpointerenter={hoverOpen}
  onpointerleave={hoverClose}
  onclick={onClick}
>
  {@render children()}
</button>

<div bind:this={tip} {id} class="tip" popover="auto" ontoggle={onToggle}>
  <span class="tip-label">{label}</span>
  <span class="tip-value">{formatNumberFull(value)}</span>
</div>

<style>
  /* The figure as it was, made pressable: no chrome of its own. */
  .figure {
    display: inline-flex;
    align-items: center;
    gap: inherit;
    margin: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    border-radius: var(--radius-xs);
    cursor: help;
  }

  .figure:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }

  /* Reset the UA's centred-dialog placement; `place()` sets top and left. */
  .tip {
    position: fixed;
    inset: auto;
    margin: 0;
    display: none;
    flex-direction: column;
    gap: 0.1rem;
    max-width: calc(100vw - 16px);
    padding: 0.35rem 0.55rem;
    background: var(--surface-panel-solid);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-sm);
    color: var(--text);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  }

  .tip:popover-open {
    display: flex;
  }

  .tip-label {
    font-size: var(--fs-2xs);
    color: var(--text-muted);
    text-transform: uppercase;
  }

  /* Long by design, so it wraps at a group rather than running off a phone. */
  .tip-value {
    font-size: var(--fs-sm);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
</style>
