<script lang="ts">
  import { layoutState, uiState } from "../../state";
  import { MAX_CUSTOM_ISLANDS } from "../../data/maps";
  import { AlertCircle, Download, Loader2 } from "lucide-svelte";
  import ModalShell from "./ModalShell.svelte";

  /**
   * Loads a pasted share code (`lib/encoding/blueprint.ts`) as a new custom
   * island.
   *
   * It always lands in a new slot rather than over the current board. A
   * shipped island's terrain is fixed so it could not go there anyway, and
   * writing over a custom island the user had built would be a destructive
   * act with no undo behind a button labelled "Import".
   */
  let atCapacity = $derived(!layoutState.canAddCustomIsland);
  let canSubmit = $derived(
    uiState.importCode.trim().length > 0 && !uiState.isImporting && !atCapacity,
  );

  function onKeyDown(e: KeyboardEvent) {
    // Enter submits; Shift+Enter and plain newlines stay available since a
    // pasted code can wrap.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
      e.preventDefault();
      uiState.importLayout();
    }
  }
</script>

{#if uiState.activeModal === "import"}
  <ModalShell title="Import Layout" onClose={() => uiState.closeModal()}>
    <p class="hint">
      Paste a share code. It is added as a new custom island, so nothing you
      have built is overwritten.
    </p>

    <textarea
      class="code-input thin-scroll"
      bind:value={uiState.importCode}
      onkeydown={onKeyDown}
      placeholder="eJx…"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      {...{ autocorrect: "off" }}
      aria-label="Share code"
      disabled={atCapacity}></textarea>

    {#if atCapacity}
      <div class="notice" role="status">
        <AlertCircle size={16} />
        <span>
          You already have {MAX_CUSTOM_ISLANDS} custom islands. Delete one in Setup
          to import another.
        </span>
      </div>
    {:else if uiState.importError}
      <div class="notice error" role="alert">
        <AlertCircle size={16} />
        <span>{uiState.importError}</span>
      </div>
    {/if}

    <button
      class="import-btn"
      onclick={() => uiState.importLayout()}
      disabled={!canSubmit}
    >
      {#if uiState.isImporting}
        <Loader2 size={16} class="spin" />
        <span>Importing…</span>
      {:else}
        <Download size={16} />
        <span>Import as new island</span>
      {/if}
    </button>
  </ModalShell>
{/if}

<style>
  .hint {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--text-muted);
  }

  .code-input {
    width: 100%;
    min-height: 7rem;
    max-height: 32dvh;
    resize: vertical;
    font-family: var(--mono);
    /*
     * 16px minimum. iOS Safari zooms the whole page in when a focused field
     * is under 16px, and the user lands back on a canvas they now have to
     * pan back into place.
     */
    font-size: 16px;
    line-height: 1.5;
    color: var(--text);
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-sm);
    padding: 0.7rem;
    word-break: break-all;
    overscroll-behavior: contain;
    user-select: text;
    -webkit-user-select: text;
  }

  .code-input:focus {
    outline: none;
    border-color: var(--neon-dim);
  }

  .code-input:disabled {
    opacity: 0.5;
  }

  .notice {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.65rem;
  }

  .notice.error {
    color: var(--danger-soft);
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }

  .notice :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
  }

  .import-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    min-height: var(--tap);
    width: 100%;
    background: var(--neon-bg);
    border: 1px solid var(--neon-dim);
    border-radius: var(--radius-sm);
    color: var(--neon);
    font-size: var(--fs-md);
    font-weight: 600;
    cursor: pointer;
    transition:
      background var(--dur-fast),
      border-color var(--dur-fast);
  }

  .import-btn:hover:not(:disabled) {
    background: rgba(0, 243, 255, 0.24);
  }

  .import-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .import-btn :global(.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
