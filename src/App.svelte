<script lang="ts">
  import {
    configState,
    editorState,
    layoutState,
    solverState,
    uiState,
    viewportState,
  } from "./lib/state";
  import {
    ConfigSidebar,
    Header,
    ImportModal,
    HudToolbar,
    PixiCanvas,
    PreviewBanner,
    SettingsModal,
    BoardStatsCard,
    ShareModal,
    SolveModal,
    SolveModeInfoModal,
  } from "./lib/components";
  import { Eye } from "lucide-svelte";

  /*
   * On a compact viewport the config panel is a bottom sheet, and once it is
   * pulled past `peek` it earns a scrim: the canvas behind it is no longer the
   * thing being interacted with. At `peek` there is no scrim, because the
   * whole point of that detent is that the canvas stays live underneath.
   */
  let showScrim = $derived(
    viewportState.isCompact && uiState.sheetCoversCanvas,
  );

  /*
   * A board opened from a shared link is read-only, so the two regions that
   * exist to change things are not rendered at all: the HUD (terrain brushes,
   * building palette, erase and restore) and the config panel (the roster, the
   * island list, and Run). Hidden rather than disabled, the same call the app
   * already makes for a shipped island's grid steppers — a row of inert
   * controls is not a smaller interface, it is a broken-looking one.
   *
   * What stays is everything that reads: the canvas, the header, the board
   * readout with its tile inspector, and Share, which re-emits the same code
   * the visitor arrived with.
   */
  let readOnly = $derived(uiState.isPreview);

  /*
   * The HUD stands down while the setup sheet is open.
   *
   * They are both bottom-anchored on a phone, so at the `peek` detent both
   * would be on screen — the sheet holding the bottom strip and the HUD riding
   * above it, two stacked bands of chrome over the board at the one moment
   * neither is being used. Opening Setup is a task you finish and
   * leave; while you are in it, the tools and Run have nothing to say.
   *
   * Compact only. On a wide screen the panel is a column down the side and the
   * HUD is a bar along the bottom, so they never contend for the same space.
   */
  let hudHidden = $derived(
    viewportState.isCompact && uiState.sheetDetent !== "closed",
  );

  /*
   * Undo and redo from the keyboard.
   *
   * The buttons in the HUD are the primary route — this app is used mostly on
   * a phone, where there is no Ctrl to hold — but a desktop user who has just
   * mis-clicked reaches for Ctrl+Z before looking for anything, and finding
   * nothing there reads as the app not having undo at all.
   *
   * It lives in the shell for the same reason the roster effect further down
   * does: this is the one component that is always mounted. Three things are
   * deliberately not intercepted — a modal being open (Escape and Enter belong
   * to it while it is up), focus sitting in a text field (the browser's own
   * undo is the right one there, and the Import dialog is a textarea), and a
   * previewed board, which is not the visitor's to edit.
   */
  function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  /*
   * Hiding the interface puts the brush down.
   *
   * The palette that would show what is in hand goes with it, and so does the
   * undo that would take a mis-tap back — so a held building becomes a hand
   * nothing on screen says you are holding, placed by the first tap on a board
   * you hid the interface to *look* at. Same call `HudToolbar` makes when the
   * solver's board comes up, for the same reason.
   *
   * In the shell because this is the always-mounted component and the one
   * allowed to reach across singletons; the HUD's own effect cannot do it,
   * since the HUD is part of what is being unmounted.
   */
  $effect(() => {
    if (uiState.uiHidden) editorState.clearHand();
  });

  /*
   * Escape brings the interface back.
   *
   * With everything away, the only route is one small unlabelled button, and a
   * player who misses it is looking at an app that appears to have lost its
   * controls. Escape is what every other full-screen state on the platform
   * answers to, and it collides with nothing here: the dialogs and the sheet
   * that own it are all closed by `setUiHidden` on the way in.
   */
  $effect(() => {
    if (!uiState.uiHidden) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") uiState.setUiHidden(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  $effect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (uiState.activeModal !== null) return;
      if (layoutState.isPreview) return;
      if (isTyping(e.target)) return;

      const key = e.key.toLowerCase();
      // Ctrl+Y is the Windows spelling of redo, and this ships to Windows.
      const redo = key === "y" || (key === "z" && e.shiftKey);
      if (!redo && key !== "z") return;

      e.preventDefault();
      if (redo) layoutState.redo();
      else layoutState.undo();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /*
   * The roster is an input to both boards' figures, not just to the next
   * solve: a building's tier decides what it produces, so buying an upgrade
   * changes what everything already placed is doing. Both boards are re-scored
   * here — the hand-placed one by re-basing its placements, the solve by
   * re-running the same scorer over its fixed shape.
   *
   * It lives in the shell because nothing else can hold it. `configState` is
   * the bottom of the state DAG and reaches nothing, and neither board may
   * import it back without making the graph cyclic; this component is the one
   * place that is always mounted and allowed to see all three.
   *
   * The signature is built by *reading* every entry, which is what subscribes
   * this effect to a single tier changing rather than only to the map being
   * replaced. `previousRoster` is a plain variable, so writing it never
   * re-triggers.
   */
  function rosterSignature(): string {
    return Object.entries(configState.buildingUpgrades)
      .map(([id, level]) => `${id}:${level}`)
      .sort()
      .join(",");
  }

  // Seeded before the first run, so mounting does not re-score a board that
  // nothing has changed.
  let previousRoster = rosterSignature();
  let previousAnomaly = configState.anomalyId;
  let previousPrestige = configState.prestige;

  /*
   * The anomaly and the Time Lab research are the second and third inputs of
   * this kind and are handled in the same effect, because it is the same
   * argument: each changes what the buildings already on both boards are worth,
   * not just what the next run may build.
   *
   * It is tracked separately from the roster rather than folded into one
   * signature because the two ask for different work. A tier bought behind a
   * standing building changes which tier that *placement* resolves to, which
   * is what `rebasePlacements` re-reads; an anomaly changes none of them — the
   * same building at the same tier is simply rated differently — so it needs
   * the re-score and nothing else.
   *
   * Like a roster change, this deliberately does not re-optimise. That layout
   * was chosen under the old rules and may no longer be the best shape or a
   * stable one; what it reports is the honest output of those buildings under
   * the new ones, and re-running is the player's call.
   */
  $effect(() => {
    const signature = rosterSignature();
    const anomaly = configState.anomalyId;
    const prestige = configState.prestige;
    if (
      signature === previousRoster &&
      anomaly === previousAnomaly &&
      prestige === previousPrestige
    )
      return;

    const rosterChanged = signature !== previousRoster;
    const prestigeChanged = prestige !== previousPrestige;
    previousRoster = signature;
    previousAnomaly = anomaly;
    previousPrestige = prestige;

    if (rosterChanged)
      layoutState.rebasePlacements(configState.buildingUpgrades);
    // Research does not change which *tier* a placement is, only what that
    // tier is worth — so the board is re-rated rather than re-based, and
    // `setPrestige` re-scores on its own.
    if (prestigeChanged) layoutState.setPrestige(prestige);
    solverState.rescoreResult();
  });
</script>

<!--
  Three measured edges, re-exported as custom properties for whatever has to
  clear them. `--header-clearance` is where the top bar ends, which differs by
  5px between a phone and a desktop, so a guessed `4.5rem` is close enough to
  leave a gap in one case and a 2px overlap in the other.
  `--hud-clearance` is the bottom HUD stack, which grows a row whenever a
  palette ribbon opens. `--preview-clearance` is the shared-link banner, which
  grows a line whenever an import is refused and is 0px on every board but a
  shared one. All three are published rather than assumed.
-->
<main
  class="app-shell"
  style:--header-clearance="{uiState.headerBottom}px"
  style:--sidebar-clearance="{uiState.sidebarWidth}px"
  style:--hud-clearance="{uiState.hudHeight}px"
  style:--preview-clearance="{uiState.previewHeight}px"
>
  <PixiCanvas bind:this={uiState.canvasRef} />

  <!--
    ── The chrome ───────────────────────────────────────────────────
    Everything from here to the dialogs is what `uiState.uiHidden` puts away,
    which is every pixel of the app that is not the board. Gated as one block
    rather than per component, so a layer added later is hidden by default
    instead of being the one thing left floating over a bare board.
  -->
  {#if !uiState.uiHidden}
    <Header />
    <PreviewBanner />

    <!--
      Top-right readout. One card, not two: it carries the layout's figures and
      the inspected tile on a single line at its foot, so a phone is never asked
      to show two stacked panels over the map they describe.
    -->
    <div class="corner-cards" bind:this={uiState.statsRef}>
      <BoardStatsCard />
    </div>

    {#if !readOnly && !hudHidden}
      <HudToolbar />
    {/if}
  {/if}

  {#if showScrim && !uiState.uiHidden}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- Straight to closed, for the same reason Escape is — see ConfigSidebar. -->
    <div
      class="scrim"
      onclick={() => uiState.setSheetDetent("closed")}
      aria-hidden="true"
    ></div>
  {/if}

  {#if !readOnly && !uiState.uiHidden}
    <ConfigSidebar />
  {/if}

  <!--
    The way back, and the only thing on screen while the interface is away.
    Small, unlabelled and in the corner the header's menu was in, so it reads
    as what is left of that bar rather than as a new control — and it takes
    `--z-toast` because it must sit over anything the canvas draws.
  -->
  {#if uiState.uiHidden}
    <button
      class="show-ui"
      onclick={() => uiState.setUiHidden(false)}
      aria-label="Show the interface"
      title="Show the interface (Esc)"
    >
      <Eye size={18} />
    </button>
  {/if}

  <ShareModal />
  <ImportModal />
  <SettingsModal />
  <SolveModal />
  <SolveModeInfoModal />

  <!--
    The app's one-line message, wherever it comes from — see
    `uiState.showToast`. It is the last thing in the shell so it paints over
    everything, which is also what `--z-toast` says.
  -->
  {#if uiState.toast}
    <div
      class="toast"
      class:warn={uiState.toast.tone === "warn"}
      role={uiState.toast.tone === "warn" ? "alert" : "status"}
      aria-live="polite"
    >
      {uiState.toast.message}
    </div>
  {/if}
</main>

<style>
  .app-shell {
    position: relative;
    width: 100%;
    /*
     * `dvh` tracks the viewport as mobile browsers collapse their URL bar;
     * `vh` freezes at the *largest* size, which pushed the HUD under the
     * bottom chrome on iOS Safari. The `vh` line is the fallback for
     * anything without `dvh`.
     */
    height: 100vh;
    height: 100dvh;
    /*
     * `clip`, not `hidden`, and the difference is not cosmetic.
     *
     * The mobile sheet is hidden by translating it a full sheet-height down,
     * and a transformed element still contributes **scrollable overflow** — so
     * this box had a 1604px scroll area inside an 844px window. `hidden` makes
     * a box unscrollable by the user but leaves it a scroll *container*, which
     * the browser will happily scroll itself to bring a focused element into
     * view. Tabbing to, or tapping, a control inside the tall roster list did
     * exactly that: the entire app — header, HUD, board and all — slid up by
     * ~340px, and with no scrollbar there was no way to put it back.
     *
     * `clip` creates no scroll container at all, so there is nothing to
     * scroll. The `hidden` line above it is the fallback for anything too old
     * to know the keyword.
     */
    overflow: hidden;
    overflow: clip;
  }

  .corner-cards {
    position: absolute;
    top: calc(var(--header-clearance, 4.5rem) + 0.5rem);
    right: calc(var(--safe-right) + 0.75rem);
    z-index: var(--z-inspector);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.6rem;
    /* Leaves room for the HUD, so a long card never runs under it. */
    max-height: calc(
      100dvh - var(--header-clearance, 4.5rem) - var(--hud-clearance, 0px) -
        2rem
    );
    /* The strip itself must not intercept drags meant for the canvas. */
    pointer-events: none;
  }

  .corner-cards > :global(*) {
    pointer-events: auto;
  }

  /* Full-bleed under the header on a phone, where a 260px corner card
     leaves the numbers cramped against the edge. */
  @media (max-width: 640px) {
    .corner-cards {
      left: calc(var(--safe-left) + 0.75rem);
      align-items: stretch;
      /*
       * Full-bleed puts this directly under the preview banner rather than
       * beside it, so it drops by the banner's measured height. Zero when
       * there is no banner, which is every board but a shared one.
       */
      top: calc(
        var(--header-clearance, 4.5rem) + 0.5rem + var(--preview-clearance, 0px)
      );
      max-height: calc(
        100dvh - var(--header-clearance, 4.5rem) -
          var(--preview-clearance, 0px) - var(--hud-clearance, 0px) - 2rem
      );
    }
  }

  .scrim {
    position: absolute;
    inset: 0;
    z-index: calc(var(--z-sheet) - 1);
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
    animation: fade-in var(--dur) var(--ease);
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .toast {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    /*
     * Above the HUD's *measured* height rather than a hard-coded 9rem, which
     * was a guess against a stack that is one row or two depending on whether
     * a palette ribbon is open — the same argument `--hud-clearance` already
     * won for the corner readout. It matters more here than it looks: the
     * message this most often carries points the user at Setup, and Setup is
     * a button in that stack.
     */
    bottom: calc(var(--safe-bottom) + var(--hud-clearance, 9rem) + 1rem);
    /* One line on a desktop, wrapping rather than clipping on a phone. */
    max-width: calc(100vw - var(--safe-left) - var(--safe-right) - 2rem);
    text-align: center;
    z-index: var(--z-toast);
    background: var(--surface-panel-solid);
    border: 1px solid var(--success);
    color: var(--success);
    font-size: var(--fs-base);
    font-weight: 700;
    letter-spacing: 0.5px;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-pill);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    pointer-events: none;
    animation: fade-in var(--dur-fast) var(--ease);
  }

  /*
   * The one control left while the interface is hidden.
   *
   * Anchored to the corner the header's overflow button sits in, at the same
   * safe-area offsets, so it lands exactly where that button does. Neutral
   * rather than accented: it is not a selection and it destroys nothing, which
   * is the colour law's answer for most of the header too.
   */
  .show-ui {
    position: absolute;
    top: calc(var(--safe-top) + 0.75rem);
    right: calc(var(--safe-right) + 0.75rem);
    z-index: var(--z-toast);
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tap);
    height: var(--tap);
    background: var(--surface-panel);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border-neon);
    border-radius: var(--radius-pill);
    color: var(--text-muted);
    cursor: pointer;
    /* Understated until reached for: the point of hiding the interface is to
       see the board, and a bright pill in the corner is interface. */
    opacity: 0.55;
    transition:
      opacity var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }

  .show-ui:hover,
  .show-ui:focus-visible {
    opacity: 1;
    color: var(--text);
  }

  /*
   * `--warn`, not `--danger`: the colour law gives danger to things that
   * destroy, and a refused Run destroys nothing — it is a precondition that is
   * not met, which is exactly what warn is for.
   */
  .toast.warn {
    border-color: var(--warn);
    color: var(--warn);
  }
</style>
