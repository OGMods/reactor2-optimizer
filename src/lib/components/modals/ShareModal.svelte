<script lang="ts">
  import { uiState } from "../../state";
  import type { ShareForm } from "../../state/ui.svelte";
  import { Check, Copy } from "lucide-svelte";
  import ModalShell from "./ModalShell.svelte";

  /*
   * Share dialog for the board on screen — the solve when the solver's layout
   * is up, the user's own when theirs is. Both rows carry the same blueprint
   * (`lib/encoding/blueprint.ts`): terrain, buildings, and the tier each
   * building is standing at. The trigger lives in `header/Header.svelte` on a
   * wide screen and in `header/OverflowMenu.svelte` on a phone.
   *
   * Two forms, two buttons, and **no copy on open**. There is no way to guess
   * which of the two a user wants, and helping yourself to their clipboard to
   * hand them the wrong one is worse than not helping at all — it destroys
   * whatever they had on it. The explicit press is also what makes the write
   * land: some mobile browsers refuse a clipboard write that is not tied
   * directly to a user gesture.
   */

  interface Row {
    form: ShareForm;
    title: string;
    hint: string;
    value: string;
  }

  let rows = $derived<Row[]>([
    {
      form: "code",
      title: "Share code",
      hint: "Paste into Import. Survives any channel that mangles links.",
      value: uiState.shareCode,
    },
    {
      form: "link",
      title: "Link",
      hint: "Opens the layout directly, read-only, without touching their islands.",
      value: uiState.shareUrl,
    },
  ]);
</script>

{#if uiState.activeModal === "share"}
  <ModalShell
    title="Share Layout"
    accent="var(--accent)"
    onClose={() => uiState.closeModal()}
  >
    {#each rows as row (row.form)}
      <section class="form">
        <div class="form-head">
          <span class="form-title">{row.title}</span>
          <span class="form-hint">{row.hint}</span>
        </div>

        <pre class="code thin-scroll">{row.value || "Encoding…"}</pre>

        <button
          class="copy-btn"
          class:copied={uiState.copiedForm === row.form}
          onclick={() => uiState.copyShare(row.form)}
          disabled={!row.value}
        >
          {#if uiState.copiedForm === row.form}
            <Check size={16} />
            <span>Copied</span>
          {:else}
            <Copy size={16} />
            <span>Copy {row.title.toLowerCase()}</span>
          {/if}
        </button>
      </section>
    {/each}
  </ModalShell>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    /*
     * Both sections shrink together when the panel runs out of room, which is
     * what keeps the second form's copy button on screen in landscape on a
     * phone. `min-height: 0` is the part that actually allows it: a flex item
     * defaults to `auto`, which refuses to shrink below its content.
     */
    flex: 1 1 auto;
    min-height: 0;
  }

  .form-head {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .form-title {
    font-size: var(--fs-sm);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--accent);
  }

  .form-hint {
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-dim);
  }

  .code {
    margin: 0;
    font-family: var(--mono);
    font-size: var(--fs-base);
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    white-space: pre-wrap;
    word-break: break-all;
    flex: 1 1 auto;
    /* Two lines of code, below which scrolling it is no longer useful. */
    min-height: 3.2rem;
    /*
     * Two of these share the dialog, so each is capped at half the height one
     * alone would take. A long code scrolls inside its own box rather than
     * pushing the other form's copy button off a phone screen.
     */
    max-height: 20dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    line-height: 1.6;
    /* The code is the one thing here worth selecting by hand. */
    user-select: text;
    -webkit-user-select: text;
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-height: var(--tap);
    width: 100%;
    background: var(--accent-bg);
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: var(--fs-md);
    font-weight: 600;
    cursor: pointer;
    transition:
      background var(--dur-fast),
      color var(--dur-fast),
      border-color var(--dur-fast);
  }

  .copy-btn:hover:not(:disabled) {
    background: rgba(0, 243, 255, 0.24);
  }

  .copy-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .copy-btn.copied {
    background: var(--status-ok-bg);
    border-color: rgba(74, 222, 128, 0.45);
    color: var(--success);
  }
</style>
