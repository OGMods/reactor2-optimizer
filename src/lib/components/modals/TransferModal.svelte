<script lang="ts">
  import { layoutState, uiState } from "../../state";
  import { getAnomaly, ISLAND_TEMPLATES } from "@reactor2/solver";
  import {
    AlertCircle,
    Check,
    Copy,
    Download,
    Loader2,
    Share2,
  } from "lucide-svelte";
  import qrcode from "qrcode-generator";
  import { onDestroy } from "svelte";
  import { transferUrlPrefix } from "../../encoding/transfer";
  import { formatTimeAgo } from "../../utils";
  import { createConfirmArm } from "../confirmArm.svelte";
  import ModalShell from "./ModalShell.svelte";

  /*
   * Moves everything between two browsers — a PC that solves and the phone
   * the game runs on, either way round. `transfer` is the sending side: one
   * link, offered as a QR code for a phone's camera, a copy button, and the
   * system share sheet (send it to yourself in a chat). `transferIn` is the
   * receiving side, opened by that link or by the code pasted into Import:
   * what it holds, and a two-press replace. See `encoding/transfer.ts`.
   */

  /*
   * The QR code, as one SVG path of its dark modules. Two segments: the
   * address in byte mode, the code in alphanumeric mode, which the code's
   * alphabet is chosen to fit and which packs it a third tighter. Low error
   * correction, since it is read off a screen, not a crumpled print, and
   * every bit of capacity goes to the link. A save too big for the largest QR
   * code throws in `make()`; then there is no code, and the link's other
   * routes remain.
   */
  let qr = $derived.by(() => {
    const url = uiState.transferUrl;
    if (!url) return null;
    const prefix = transferUrlPrefix();
    if (!url.startsWith(prefix)) return null;
    try {
      const code = qrcode(0, "L");
      code.addData(prefix, "Byte");
      code.addData(url.slice(prefix.length), "Alphanumeric");
      code.make();
      const n = code.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++)
          if (code.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { n, d };
    } catch {
      return null;
    }
  });

  let incoming = $derived(uiState.transferIn);
  let islandNames = $derived.by(() => {
    const t = incoming;
    if (!t) return "";
    const names = Object.keys(t.boards).map(
      (id) =>
        ISLAND_TEMPLATES.find((tt) => tt.id === id)?.name ??
        t.customIslands.find((c) => c.id === id)?.name ??
        id,
    );
    return names.join(", ") || "none changed";
  });

  const confirm = createConfirmArm<"replace">();
  onDestroy(() => confirm.disarm());

  function apply() {
    if (confirm.press("replace")) void uiState.applyTransfer();
  }
</script>

{#if uiState.activeModal === "transfer"}
  <ModalShell title="Transfer" onClose={() => uiState.closeModal()}>
    <p class="hint">
      Moves everything here — islands, solves, buildings, Time Lab and your game
      import — to another browser. Open the link there; it asks before replacing
      anything.
    </p>

    {#if !uiState.transferUrl}
      <div class="building"><Loader2 size={16} class="spin" /> Packing…</div>
    {:else}
      {#if qr}
        <!--
          White behind the modules and a four-module quiet zone, as scanners
          expect, whatever the theme.
        -->
        <svg
          class="qr"
          viewBox="-4 -4 {qr.n + 8} {qr.n + 8}"
          role="img"
          aria-label="QR code for the transfer link"
          shape-rendering="crispEdges"
        >
          <rect x="-4" y="-4" width={qr.n + 8} height={qr.n + 8} fill="#fff" />
          <path d={qr.d} fill="#000" />
        </svg>
        <p class="hint center">Scan with your phone's camera.</p>
      {:else}
        <div class="notice">
          <AlertCircle size={16} />
          <span>
            Too much for a QR code. Send the link to yourself instead — share
            it, or copy it into a chat or email you can open on the other
            device.
          </span>
        </div>
      {/if}

      <div class="actions">
        {#if uiState.canShareTransfer}
          <button class="btn primary" onclick={() => uiState.shareTransfer()}>
            <Share2 size={16} />
            <span>Share link</span>
          </button>
        {/if}
        <button class="btn" onclick={() => uiState.copyTransfer("link")}>
          <Copy size={16} />
          <span>Copy link</span>
        </button>
        <button class="btn" onclick={() => uiState.copyTransfer("code")}>
          <Copy size={16} />
          <span>Copy code</span>
        </button>
      </div>
      <p class="hint small">
        The code pastes into Import on the other device, for when a link will
        not open there.
      </p>
    {/if}
  </ModalShell>
{:else if uiState.activeModal === "transferIn"}
  <ModalShell title="Load Transfer" onClose={() => uiState.closeModal()}>
    {#if incoming}
      <p class="hint">Everything from your other device:</p>
      <dl class="facts">
        <dt>Islands</dt>
        <dd>{islandNames}</dd>
        <dt>Solves</dt>
        <dd>{Object.keys(incoming.solves).length}</dd>
        <dt>Buildings</dt>
        <dd>{Object.keys(incoming.buildingUpgrades).length} unlocked</dd>
        <dt>Anomaly</dt>
        <dd>{getAnomaly(incoming.anomalyId).name}</dd>
        <dt>Game import</dt>
        <dd>
          {incoming.gameImport
            ? `${incoming.gameImport.gameVersion} · ${formatTimeAgo(incoming.gameImport.importedAt)}`
            : "none — yours is kept"}
        </dd>
      </dl>
      <div class="notice">
        <AlertCircle size={16} />
        <span>
          Replaces your buildings, Time Lab, anomaly, the boards and solves of
          every island{layoutState.customIslands.length > 0
            ? ", and your custom islands"
            : ""}.
        </span>
      </div>
    {/if}
    {#if uiState.transferError}
      <div class="notice error" role="alert">
        <AlertCircle size={16} />
        <span>{uiState.transferError}</span>
      </div>
    {/if}
    {#if incoming}
      <button
        class="btn primary wide"
        class:armed={confirm.armed === "replace"}
        disabled={uiState.isTransferring}
        onclick={apply}
      >
        {#if uiState.isTransferring}
          <Loader2 size={16} class="spin" />
          <span>Loading…</span>
        {:else if confirm.armed === "replace"}
          <Check size={16} />
          <span>Press again to replace</span>
        {:else}
          <Download size={16} />
          <span>Load everything</span>
        {/if}
      </button>
    {/if}
  </ModalShell>
{/if}

<style>
  .hint {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--text-muted);
  }

  .hint.center {
    text-align: center;
  }

  .hint.small {
    color: var(--text-dim);
  }

  .building {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 0;
    color: var(--text-muted);
  }

  /*
   * As large as the dialog allows: a dense code needs every pixel per module
   * a camera can get, and a phone held to a monitor is not close.
   */
  .qr {
    display: block;
    width: min(100%, 22rem, 52dvh);
    aspect-ratio: 1;
    margin: 0 auto;
    border-radius: var(--radius-sm);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    flex: 1 1 8rem;
    min-height: var(--tap);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--fs-md);
    font-weight: 600;
    cursor: pointer;
    transition:
      background var(--dur-fast),
      border-color var(--dur-fast),
      color var(--dur-fast);
  }

  .btn:hover:not(:disabled) {
    background: var(--surface-raised);
    color: var(--text);
  }

  .btn.primary {
    background: var(--accent-bg);
    border-color: var(--accent-dim);
    color: var(--accent);
  }

  .btn.primary:hover:not(:disabled) {
    background: rgba(0, 243, 255, 0.24);
  }

  .btn.wide {
    width: 100%;
    flex: none;
  }

  .btn.armed {
    background: var(--danger-bg);
    border-color: var(--danger-line);
    color: var(--danger-soft);
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.75rem;
    margin: 0;
    font-size: var(--fs-sm);
  }

  .facts dt {
    color: var(--text-dim);
  }

  .facts dd {
    margin: 0;
    color: var(--text);
    min-width: 0;
    overflow-wrap: anywhere;
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

  .btn :global(.spin),
  .building :global(.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
