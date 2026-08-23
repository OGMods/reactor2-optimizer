<script lang="ts">
  import type { Snippet } from "svelte";
  import { X } from "lucide-svelte";

  /**
   * The chrome every dialog needs: a backdrop that closes on click, Escape to
   * dismiss, and a Tab loop trapped inside the panel.
   *
   * It exists so the focus trap has exactly one implementation. A modal a
   * keyboard user can tab out of but not close is worse than no modal, and
   * that is precisely the detail that rots when it is copied per dialog.
   */
  interface Props {
    title: string;
    /** Tints the header and border — amber for share, cyan for import. */
    accent?: string;
    onClose: () => void;
    children: Snippet;
  }

  let { title, accent = "var(--neon)", onClose, children }: Props = $props();

  let panelEl = $state<HTMLDivElement | null>(null);
  let closeEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    // Focus lands on Close, the one control that is always safe to activate.
    closeEl?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelEl) return;

      const focusable = [
        ...panelEl.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute("disabled"));
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose}></div>
<div
  class="panel"
  bind:this={panelEl}
  style:--accent={accent}
  role="dialog"
  aria-modal="true"
  aria-label={title}
>
  <div class="panel-header">
    <span>{title}</span>
    <button
      class="close-btn"
      bind:this={closeEl}
      onclick={onClose}
      aria-label="Close"
    >
      <X size={18} />
    </button>
  </div>

  <!--
    Everything below the header scrolls. The panel is capped at the viewport,
    so without this a dialog taller than the screen simply spilled out of its
    own border with the overflow unreachable — which is what the Run again?
    dialog does in landscape, where its two option cards are twice the height
    available.
  -->
  <div class="panel-body thin-scroll">
    {@render children()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }

  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: calc(var(--z-modal) + 1);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    /*
     * The header stays put and `.panel-body` takes the overflow; this only
     * keeps the rounded corners honest. `clip` rather than `hidden` for the
     * reason `.app-shell` uses it — `hidden` leaves the box a scroll
     * container the browser may scroll itself to reveal a focused control,
     * and the one thing that must scroll here is the body.
     */
    overflow: clip;
    background: var(--surface-panel-solid);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    /* Fits a 320px screen with room to spare, and never taller than the
       visible viewport once a mobile keyboard is up. */
    width: min(
      440px,
      calc(100vw - var(--safe-left) - var(--safe-right) - 1.5rem)
    );
    /*
     * The panel is centred, so it clears a notch only if it leaves room for
     * the *larger* inset on both sides — a portrait iPhone reserves 47px at
     * the top, against the 24px a bare `100dvh - 3rem` left it.
     */
    max-height: calc(
      100dvh - 2 * max(var(--safe-top), var(--safe-bottom)) - 3rem
    );
    box-shadow:
      0 0 40px color-mix(in srgb, var(--accent) 15%, transparent),
      0 8px 32px rgba(0, 0, 0, 0.6);
  }

  /*
   * `min-height: 0` is the load-bearing half: a flex item's automatic minimum
   * size is its content size, so `overflow-y` alone cannot shrink this below
   * the height of everything inside it. Same rule `.scroll-body` needs in the
   * sidebar, and the same way it fails without it — no scrollbar, and the
   * content overflowing the panel instead.
   *
   * The padding/margin pair is net zero: it moves nothing, and buys 4px
   * inside the scroll box for the focus ring (`outline` 2px at 2px offset)
   * that a scroll container would otherwise clip off a full-width button.
   */
  .panel-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    overflow-y: auto;
    /* The board behind must not scroll when this hits its end under a thumb. */
    overscroll-behavior: contain;
    padding: 0.25rem;
    margin: -0.25rem;
  }

  .panel-header {
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--accent);
    font-size: var(--fs-md);
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tap);
    height: var(--tap);
    /* Pulled into the header's padding so the row stays compact while the
       target itself stays a full 44px. */
    margin: -0.5rem -0.65rem -0.5rem 0;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    cursor: pointer;
    transition: color var(--dur-fast);
  }

  .close-btn:hover {
    color: #e2e8f0;
    background: var(--surface-raised);
  }
</style>
