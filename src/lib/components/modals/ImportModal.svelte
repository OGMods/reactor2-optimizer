<script lang="ts">
  import { layoutState, uiState } from "../../state";
  import {
    MAX_CUSTOM_ISLANDS,
    PRESTIGE_UPGRADES,
    findBuilding,
    getAnomaly,
    isGameExportCode,
    plannableProgress,
    type InProgressMode,
  } from "@reactor2/solver";
  import { AlertCircle, Download, Gamepad2, Loader2 } from "lucide-svelte";
  import { onDestroy } from "svelte";
  import { createConfirmArm } from "../confirmArm.svelte";
  import ModalShell from "./ModalShell.svelte";

  /**
   * Loads a pasted code. Two kinds arrive here:
   *
   * - A **share code** (`encoding/blueprint.ts`) lands as a new custom island.
   *   It always lands in a new slot rather than over the current board: a
   *   shipped island's terrain is fixed so it could not go there anyway, and
   *   writing over a custom island the user had built would be a destructive
   *   act with no undo behind a button labelled "Import".
   * - A **game code** — the game's Export to Optimizer button — is the
   *   opposite on purpose: it is the player's own save, so it *replaces* the
   *   roster, Time Lab, anomaly and the boards of every unlocked island. It is
   *   read and summarised as soon as it is pasted, and applying it takes two
   *   presses, the app's rule for anything that destroys work.
   */
  let game = $derived(uiState.gameImport);
  // A game code never takes a custom slot, so the cap only stands in the way
  // of a share code — and must not lock the box a game code is pasted into.
  let isGame = $derived(isGameExportCode(uiState.importCode));
  let atCapacity = $derived(!layoutState.canAddCustomIsland && !isGame);
  let canSubmit = $derived(
    uiState.importCode.trim().length > 0 &&
      !uiState.isImporting &&
      !atCapacity &&
      (!isGame || game !== null),
  );

  $effect(() => {
    void uiState.readImportCode(uiState.importCode);
  });

  const confirm = createConfirmArm<"replace">();
  onDestroy(() => confirm.disarm());

  function submit() {
    if (!canSubmit) return;
    if (game) {
      if (confirm.press("replace")) void uiState.applyGameImport();
    } else if (!isGame) {
      void uiState.importLayout();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // Enter submits; Shift+Enter and plain newlines stay available since a
    // pasted code can wrap.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
      e.preventDefault();
      submit();
    }
  }

  const MODES: { id: InProgressMode; label: string }[] = [
    { id: "plan", label: "Upgrade plan" },
    { id: "finished", label: "Count as done" },
    { id: "ignore", label: "Ignore" },
  ];

  function progressName(kind: "building" | "research", id: string): string {
    if (kind === "building") return findBuilding(id)?.name ?? id;
    return PRESTIGE_UPGRADES.find((u) => u.id === id)?.name ?? id;
  }

  /** Coarse on purpose — the game's own timer is the precise one. */
  function timeLeft(seconds: number): string {
    if (seconds <= 0) return "done";
    if (seconds < 60) return `${seconds}s`;
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  let unlockedCount = $derived(
    game ? Object.keys(game.buildingUpgrades).length : 0,
  );
  let researchNames = $derived.by(() => {
    const g = game;
    if (!g) return [];
    return PRESTIGE_UPGRADES.filter((u) => u.id in g.prestigeLevels).map(
      (u) => `${u.name} ${g.prestigeLevels[u.id] + 1}`,
    );
  });
  let dropped = $derived(
    game
      ? game.islands.reduce(
          (n, i) => n + i.blockedBuildings + i.unknownBuildings,
          0,
        )
      : 0,
  );
  let unplannable = $derived(
    game ? game.inProgress.length - plannableProgress(game).length : 0,
  );
</script>

{#if uiState.activeModal === "import"}
  <ModalShell title="Import Code" onClose={() => uiState.closeModal()}>
    <p class="hint">
      Paste a share code to add it as a new custom island, or a code from the
      game's <strong>Export to Optimizer</strong> button to load your whole save.
    </p>

    <textarea
      class="code-input thin-scroll"
      bind:value={uiState.importCode}
      onkeydown={onKeyDown}
      placeholder="eJx… or R2X1.…"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      {...{ autocorrect: "off" }}
      aria-label="Share code or game code"
      data-autofocus></textarea>

    {#if game}
      <section class="game" aria-label="Game save">
        <header class="game-head">
          <Gamepad2 size={16} />
          <span>Game save · {game.gameVersion}</span>
        </header>
        <dl class="facts">
          <dt>Islands</dt>
          <dd>
            {game.islands.map((i) => i.name).join(", ") || "none"}
            {#if game.lockedTemplateIds.length > 0}
              <span class="muted">
                · {game.lockedTemplateIds.length} locked, cleared
              </span>
            {/if}
          </dd>
          <dt>Buildings</dt>
          <dd>{unlockedCount} unlocked</dd>
          <dt>Time Lab</dt>
          <dd>{researchNames.join(", ") || "none"}</dd>
          <dt>Anomaly</dt>
          <dd>{getAnomaly(game.anomalyId).name}</dd>
        </dl>

        {#if game.inProgress.length > 0}
          <div class="progress">
            <span class="label">Research in progress</span>
            <ul>
              {#each game.inProgress as p (p.kind + p.id)}
                <li>
                  {progressName(p.kind, p.id)} → Lv.{p.level + 1}
                  <span class="muted">· {timeLeft(p.secondsLeft)}</span>
                </li>
              {/each}
            </ul>
            <div class="modes" role="group" aria-label="Research in progress">
              {#each MODES as mode (mode.id)}
                <button
                  class="mode"
                  class:active={uiState.gameImportMode === mode.id}
                  aria-pressed={uiState.gameImportMode === mode.id}
                  onclick={() => (uiState.gameImportMode = mode.id)}
                >
                  {mode.label}
                </button>
              {/each}
            </div>
            {#if uiState.gameImportMode === "plan" && unplannable > 0}
              <p class="muted small">
                A plan only holds upgrades of buildings already unlocked, so {unplannable}
                of these {unplannable === 1 ? "is" : "are"} left out. Choose "Count
                as done" to include {unplannable === 1 ? "it" : "them"}.
              </p>
            {/if}
          </div>
        {/if}
      </section>

      {#if game.unknownAnomaly}
        <div class="notice" role="status">
          <AlertCircle size={16} />
          <span>
            This version does not know the anomaly "{game.unknownAnomaly}", so
            none is set. Reload the page to update.
          </span>
        </div>
      {/if}
      {#if dropped > 0}
        <div class="notice" role="status">
          <AlertCircle size={16} />
          <span>
            {dropped} building{dropped === 1 ? "" : "s"} could not be placed: the
            optimizer does not have {dropped === 1 ? "it" : "them"} yet, or its map
            differs from the game's there.
          </span>
        </div>
      {/if}
      <div class="notice" role="status">
        <AlertCircle size={16} />
        <span>
          Replaces your buildings, Time Lab, anomaly and the boards of all
          {game.islands.length + game.lockedTemplateIds.length} islands; locked ones
          are cleared. Custom islands are not touched.
        </span>
      </div>
    {:else if atCapacity}
      <div class="notice" role="status">
        <AlertCircle size={16} />
        <span>
          You already have {MAX_CUSTOM_ISLANDS} custom islands. Delete one in Setup
          to import another.
        </span>
      </div>
    {/if}

    {#if uiState.importError}
      <div class="notice error" role="alert">
        <AlertCircle size={16} />
        <span>{uiState.importError}</span>
      </div>
    {/if}

    <button
      class="import-btn"
      class:armed={game !== null && confirm.armed === "replace"}
      onclick={submit}
      disabled={!canSubmit}
    >
      {#if uiState.isImporting}
        <Loader2 size={16} class="spin" />
        <span>Importing…</span>
      {:else if game && confirm.armed === "replace"}
        <Download size={16} />
        <span>Press again to replace</span>
      {:else if game}
        <Download size={16} />
        <span>Load my game</span>
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
    border-color: var(--accent-dim);
  }

  .game {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    font-size: var(--fs-sm);
    line-height: 1.45;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.65rem 0.75rem;
  }

  .game-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-weight: 600;
    color: var(--accent);
  }

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }

  .facts dt {
    color: var(--text-muted);
  }

  .facts dd {
    margin: 0;
    min-width: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .muted {
    color: var(--text-muted);
  }

  .small {
    margin: 0;
    font-size: var(--fs-sm);
  }

  .progress {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .progress .label {
    color: var(--text-muted);
  }

  .progress ul {
    margin: 0;
    padding-left: 1.1rem;
  }

  .modes {
    display: flex;
    gap: 0.35rem;
  }

  .mode {
    flex: 1;
    min-width: 0;
    min-height: var(--tap);
    padding: 0 0.4rem;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--fs-sm);
    cursor: pointer;
  }

  .mode.active {
    background: var(--accent-bg);
    border-color: var(--accent-dim);
    color: var(--accent);
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
    background: var(--accent-bg);
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius-sm);
    color: var(--accent);
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

  .import-btn.armed {
    background: var(--danger-bg);
    border-color: var(--danger-line);
    color: var(--danger-soft);
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
