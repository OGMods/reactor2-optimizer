<script lang="ts">
  import { uiState, viewportState } from "../../state";
  import { AlertCircle, Download, Eye, LogOut } from "lucide-svelte";

  /**
   * The bar that says "this board is not yours".
   *
   * A shared link opens someone else's layout read-only: the terrain brushes,
   * the building palette, the config panel and the Run button are all absent
   * while it is up, so without this the app would simply look broken. It is a
   * banner rather than a modal because the whole point of the link is to *look*
   * at the board — a dialog over it would have to be dismissed before the
   * visitor could see the thing they followed the link for.
   *
   * Two ways out, and they are the only two: take the board as your own island,
   * or leave it and go back to yours. Both clear the link's parameter, so a
   * reload does not drop the visitor back into the preview they just left.
   */
  let busy = $state(false);
  let compact = $derived(viewportState.isPhone);

  /*
   * On a phone the board readout goes full-bleed directly below the header,
   * which is where this bar now is. It publishes its real height so the
   * readout can drop by exactly that much — the same measured-not-guessed rule
   * `HudToolbar` follows, and for the same reason: this bar grows a second
   * line whenever an import is refused.
   */
  let measured = $state(0);

  $effect(() => {
    uiState.previewHeight = uiState.isPreview ? measured : 0;
  });

  async function adopt() {
    if (busy) return;
    busy = true;
    try {
      await uiState.importPreview();
    } finally {
      busy = false;
    }
  }

  async function leave() {
    if (busy) return;
    busy = true;
    try {
      await uiState.exitPreview();
    } finally {
      busy = false;
    }
  }
</script>

{#if uiState.isPreview}
  <div
    class="preview-bar"
    class:compact
    bind:clientHeight={measured}
    role="status"
  >
    <span class="label">
      <Eye size={15} />
      <span class="text">
        <strong>Shared layout</strong>
        {#if !compact}<span class="sub">— view only</span>{/if}
      </span>
    </span>

    <span class="actions">
      <button class="pv-btn adopt" onclick={adopt} disabled={busy}>
        <Download size={15} />
        <span>{compact ? "Import" : "Import as my island"}</span>
      </button>
      <button class="pv-btn leave" onclick={leave} disabled={busy}>
        <LogOut size={15} />
        <span>{compact ? "Exit" : "Exit preview"}</span>
      </button>
    </span>

    {#if uiState.previewError}
      <span class="error" role="alert">
        <AlertCircle size={14} />
        <span>{uiState.previewError}</span>
      </span>
    {/if}
  </div>
{/if}

<style>
  .preview-bar {
    position: absolute;
    /*
     * Directly under the header, which is `--safe-top + 0.75rem` down and
     * about 3rem tall. Anchored to the same safe-area insets so it clears a
     * notch in landscape exactly as the bar above it does.
     */
    top: calc(var(--header-clearance, 4rem) + 0.35rem);
    left: calc(var(--safe-left) + 0.75rem);
    /*
     * A step *below* the header rather than level with it. Both are header
     * chrome, so they share the token — but this bar is mounted after the
     * header, and at an equal z-index DOM order decides, which put it over
     * everything the header opens. The overflow menu is a plain absolute child
     * of a bar that has a z-index of its own, so it is sealed inside that
     * stacking context and cannot climb out to reach a sibling; the bar
     * underneath has to yield instead. Yielding is also the honest reading:
     * this is a status line, and the header's controls come over it.
     */
    z-index: calc(var(--z-header) - 1);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.85rem;
    max-width: calc(100vw - var(--safe-left) - var(--safe-right) - 1.5rem);
    background: var(--surface-panel);
    backdrop-filter: blur(12px);
    border: 1px solid var(--warn-dim);
    border-radius: var(--radius);
    padding: 0.45rem 0.75rem;
  }

  .label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--warn);
    font-size: var(--fs-base);
    min-width: 0;
  }

  .label :global(svg) {
    flex-shrink: 0;
  }

  .text strong {
    font-weight: 700;
    letter-spacing: 0.3px;
  }

  .sub {
    color: var(--text-dim);
    font-weight: 500;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .pv-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    height: var(--ctl);
    padding: 0 0.7rem;
    border-radius: var(--radius-sm);
    font-size: var(--fs-base);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition: all var(--dur-fast);
  }

  .pv-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .adopt {
    background: var(--neon-bg);
    border: 1px solid var(--neon-dim);
    color: var(--neon);
  }

  .adopt:hover:not(:disabled) {
    background: rgba(0, 243, 255, 0.24);
  }

  .leave {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
  }

  .leave:hover:not(:disabled) {
    border-color: var(--text-dim);
    color: var(--text);
  }

  .error {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    /* Its own line: the reason an import was refused is a sentence, not a
       chip, and squeezing it beside the buttons would truncate it. */
    flex-basis: 100%;
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--danger-soft);
  }

  .error :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* Phone: the bar sits under a shorter header and holds shorter labels. */
  .preview-bar.compact {
    top: calc(var(--header-clearance, 3.9rem) + 0.35rem);
    right: calc(var(--safe-right) + 0.75rem);
    padding: 0.4rem 0.5rem;
    gap: 0.4rem 0.5rem;
  }

  .preview-bar.compact .pv-btn {
    /* Coarse pointers get the full target; see `app.css`. */
    min-height: var(--tap);
  }
</style>
