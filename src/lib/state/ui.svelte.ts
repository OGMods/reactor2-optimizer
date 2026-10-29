import type { PixiCanvas } from "../components";
import type {
  ImageScale,
  OptimizationResult,
  PlacedBuilding,
  PlacementView,
  Tile,
} from "../types";
import { isObstacleType } from "../types/grid";
import type { BuildingCategory } from "@reactor2/solver";
import { buildShareUrl, clearSharedCode } from "../encoding/shareLink";
import {
  buildTransferUrl,
  clearTransferLink,
  decodeTransfer,
  encodeTransfer,
  readTransferLink,
  type TransferBundle,
  type TransferSolve,
} from "../encoding/transfer";
import { downloadBlob, toFileSlug } from "../utils/downloadFile";
import {
  applyInProgress,
  blueprintRules,
  BUILDINGS,
  buildPrice,
  decodeBlueprint,
  encodeBlueprint,
  findBuilding,
  getAnomaly,
  priceRules,
  sellRefund,
  decodeGameExport,
  formatNumberForFilename,
  ISLAND_TEMPLATES,
  isGameExportCode,
  resolveGameExport,
  type GameExport,
  type IslandTemplate,
  type InProgressMode,
  type ResolvedGameImport,
} from "@reactor2/solver";
import {
  analyticsOptedOut,
  doNotTrackRequested,
  setAnalyticsEnabled,
  trackEvent,
} from "../utils/analytics";
import {
  solverStorage,
  uiStorage,
  type StoredPlacement,
} from "../storage/storage";
import { evaluatePlan, type PlanReport } from "../simulation/upgradePlan";
import {
  createBoardScorer,
  simulatePlacedBuildings,
} from "../simulation/simulator";
import {
  planMoveSteps,
  PlanCancelled,
  stepCount,
  priceSteps,
  type BoardBuilding,
  type MovePlan,
  type StepPrice,
} from "../simulation/moveSteps";
import { createPlacement } from "../data/placements";
import { configState } from "./config.svelte";
import { layoutState } from "./layout.svelte";
import { solverState } from "./solver.svelte";
import { timelineState } from "./timeline.svelte";
import { viewportState } from "./viewport.svelte";

/** A tile the inspector can point at. Internal — nothing outside builds one. */
interface TileRef {
  x: number;
  y: number;
  type: string;
}

/** The dialogs the app can have open. Only ever one at a time. */
type ActiveModal =
  | "share"
  | "import"
  | "solve"
  | "solveModes"
  | "settings"
  | "upgradePlan"
  | "timeLab"
  | "transfer"
  | "transferIn"
  | null;

/**
 * The two forms a layout can be handed to someone else in.
 *
 * `code` is the portable one — it pastes into the Import dialog and survives
 * any channel that mangles URLs. `link` opens the board directly, in preview.
 * Both carry the identical payload, and each gets its own copy button because
 * which one is wanted depends entirely on where it is going.
 */
export type ShareForm = "code" | "link";

/** What a toast is saying: a thing that happened, or a thing that did not. */
type ToastTone = "ok" | "warn";

/**
 * What a saved board is called: `reactor2-island-3-12AF_345AE.png`.
 *
 * **The power is in the name** because a picture is the one form of a layout
 * that carries no figures of its own — and it is the figure the whole exercise
 * is about, so a folder of these sorts and compares without opening any of
 * them. `formatNumberForFilename` comes from `@reactor2/solver`, which is what
 * the CLI names its own output with, so a board saved from the app and one
 * solved from the terminal sort beside each other.
 *
 * The board is named by its **id** rather than its title: ids are `island3`
 * and `custom2`, which is already the "which island" a name would have to
 * carry, and unlike the title they do not change when a custom island is
 * renamed. The trailing digits are split off so the id reads as words.
 *
 * Exported because it is the whole of what the user sees of this feature
 * afterwards, and it is worth pinning without a browser to save a file with.
 */
export function layoutImageFilename(templateId: string, power: number): string {
  const board = toFileSlug(templateId.replace(/(\d+)$/, "-$1"), "island");
  return `reactor2-${board}-${formatNumberForFilename(power)}.png`;
}

/** How far the mobile config sheet is pulled up. */
export type SheetDetent = "closed" | "peek" | "half" | "full";

/**
 * Which half of Setup is on screen.
 *
 * The panel holds two unrelated tasks — *which island* and *which buildings* —
 * and stacking them in one scroller with the islands on top puts the roster
 * about 450px down a window ~257px tall on a phone. "Available Buildings" is
 * then never on screen when Setup opens: a section you have to already know is
 * there to go looking for it.
 *
 * Defaults to the islands, because that is the recurring task. The roster is
 * set once and then the same roster is tried against one island after another.
 */
type SetupTab = "islands" | "buildings" | "timelab";

/**
 * Visible height of the sheet's `peek` detent, in px.
 *
 * Lives here rather than in `ConfigSidebar` because the HUD also needs it:
 * at `peek` the sheet occupies the bottom of the screen, and the HUD lifts by
 * exactly this much so the two never overlap.
 *
 * **Only the starting value.** `ConfigSidebar` measures its own top region —
 * grabber, header, run slot — and publishes the real number as
 * `sheetPeekHeight`; this is what the layout uses for the one frame before
 * that lands.
 *
 * A hard-coded height cannot work here: the sheet's top region changes with
 * its contents, so any guess describes a sheet that does not exist. The app
 * refuses to guess `hudHeight` for exactly the same reason.
 */
const SHEET_PEEK_FALLBACK_PX = 148;

/**
 * Interface state: what is open, what is being inspected, and the view-model
 * the inspector card reads.
 *
 * The optimizer lives in `solver.svelte.ts` and the active template id in
 * `layout.svelte.ts`; what is here is genuinely about the interface.
 *
 * The `inspected*` getters read across `layout` and `solver` on purpose: the
 * one question they answer for `BoardStatsCard` — what is under the pointer —
 * depends on which of the two boards is currently drawn.
 */
class UIState {
  /** Desktop sidebar. Persisted; the mobile sheet deliberately is not. */
  sidebarCollapsed = $state(uiStorage.loadPrefs().sidebarCollapsed);

  /**
   * Which board the canvas draws once there is something to choose between:
   * the buildings the user placed, or the ones the last solve produced.
   *
   * It is a preference rather than a derivation because both boards are real
   * and the user decides which one they are working with. It only *means*
   * anything while a solve result exists — see `showingSolver`, which falls
   * back to the user's board rather than drawing an empty one.
   *
   * Persisted, so a reload lands on the same board as the restored solve.
   */
  placementView = $state<PlacementView>(uiStorage.loadPrefs().placementView);

  /**
   * Compact viewports only: folds `BoardStatsCard` down to one line.
   *
   * On a phone the readout spans the top of the map it is describing, and a
   * player lining up a placement wants the board, not the figures. Desktop
   * ignores it — there is a corner to sit in there.
   */
  statsCardCollapsed = $state(uiStorage.loadPrefs().statsCardCollapsed);

  /**
   * Mobile config sheet position. Unused on desktop, where the sidebar
   * renders instead.
   *
   * **Starts closed.** Run lives in the HUD (`hud/BoardActions.svelte`), so
   * opening at `peek` would buy a strip of *setup* — which island, which
   * buildings, how long a run may take — none of which is the first move, and
   * all of which costs the map 148px on the device this app is mostly used on.
   *
   * Closed does not hide the panel behind an unlabelled tab: the tab carries
   * the word "Setup".
   */
  sheetDetent = $state<SheetDetent>("closed");

  /**
   * The mobile sheet's real `peek` height, published by `ConfigSidebar` once
   * it has measured its own top region. Read by the sheet's own detent maths
   * and by `HudToolbar`, which rides above the sheet at that detent.
   */
  sheetPeekHeight = $state(SHEET_PEEK_FALLBACK_PX);

  /**
   * Where the header bar ends, in CSS pixels — published by `Header`, read by
   * everything anchored under it. See the note there.
   */
  headerBottom = $state(0);

  /**
   * How much width the docked sidebar takes out of the canvas, or 0 when it is
   * collapsed or presented as a sheet. Read by `PixiCanvas` so Center View
   * frames the board in the space actually left over rather than half of it
   * behind the panel.
   */
  sidebarWidth = $state(0);

  /** Header overflow menu (phone only). */
  overflowOpen = $state(false);

  /**
   * Everything but the canvas is off screen.
   *
   * The board is the thing this app is about, and every other pixel is chrome
   * standing on it — a header, a readout, a tool stack and a panel. There are
   * moments when none of it is wanted: reading a finished layout, showing
   * someone the board, taking a picture of it that is not the PNG export.
   *
   * **Not persisted**, unlike every other preference here. A reload that came
   * back with the entire interface gone would read as the app being broken,
   * and the one control that undoes it is a single unlabelled button — too
   * thin a thread to hang a returning session on. It is a thing you do to the
   * screen for a minute, not a way you have decided to use the app.
   */
  uiHidden = $state(false);

  /**
   * Hides the chrome, and tidies up on the way.
   *
   * The menu that this was chosen from, the sheet, and any open dialog all
   * live in the layer being hidden, so leaving them open would either hide
   * them mid-task or leave a dialog floating over a bare board with nothing
   * around it. Showing again restores none of them: coming back is a return to
   * the board, not a resumption of whatever was open a minute ago.
   */
  setUiHidden(hidden: boolean) {
    this.uiHidden = hidden;
    if (!hidden) return;
    this.overflowOpen = false;
    this.activeModal = null;
    this.setSheetDetent("closed");
  }

  /** Which category the sidebar's unlock list is showing. */
  catalogTab = $state<BuildingCategory>("generator");

  /**
   * Which half of Setup is showing — see `SetupTab`.
   *
   * View state, and deliberately not persisted, the same call `catalogTab`
   * already makes: opening Setup is the start of a task, and the task it
   * starts is nearly always the island.
   */
  setupTab = $state<SetupTab>("islands");

  /**
   * Whether the board animates, or `null` for "follow the system".
   *
   * The only thing this drives today is the pulse on buildings that are idle
   * or overheating (`pixi/statusPulse.ts`), which is also the only motion on
   * the canvas — everything else there moves because the user is dragging it.
   *
   * Three states rather than two, and the third is the point: until someone
   * opens Settings and decides, `prefers-reduced-motion` answers for them, and
   * it keeps answering if they change it at the OS level. An explicit choice
   * then overrides it for good, which is the standard reading of a system
   * preference — a default, not a veto.
   */
  #animations = $state<boolean | null>(
    uiStorage.loadPrefs().animations ?? null,
  );

  /** The effective answer: the user's choice, or the system's if they have none. */
  get animations(): boolean {
    return this.#animations ?? !viewportState.prefersReducedMotion;
  }

  /** True while nobody has chosen and the system is deciding. */
  get animationsFollowSystem(): boolean {
    return this.#animations === null;
  }

  setAnimations(on: boolean) {
    if (this.#animations === on) return;
    this.#animations = on;
    uiStorage.savePrefs({ animations: on });
  }

  /**
   * Whether an edit that lands buzzes the device.
   *
   * A plain boolean rather than `animations`' three states: touch has no
   * system preference to fall back on, so there is nothing for a third state
   * to mean. Devices that cannot vibrate ignore it — see `utils/haptics`.
   */
  #haptics = $state<boolean>(uiStorage.loadPrefs().haptics);

  get haptics(): boolean {
    return this.#haptics;
  }

  setHaptics(on: boolean) {
    if (this.#haptics === on) return;
    this.#haptics = on;
    uiStorage.savePrefs({ haptics: on });
  }

  /**
   * Whether each building wears the game's fill gauge ("70%") on the board.
   *
   * A switch because it is the one overlay that can crowd a large island at
   * the fitted zoom; the state and anomaly icons stay regardless, since they
   * are the board's only mark of *why* a building is in the state it is.
   */
  #fillBadges = $state<boolean>(uiStorage.loadPrefs().fillBadges);

  get fillBadges(): boolean {
    return this.#fillBadges;
  }

  setFillBadges(on: boolean) {
    if (this.#fillBadges === on) return;
    this.#fillBadges = on;
    uiStorage.savePrefs({ fillBadges: on });
  }

  /**
   * Whether the inspected building's lines carry on outward — through the
   * buildings it is linked to, and theirs, until the network it belongs to is
   * drawn whole. Off, only its own partners are linked.
   */
  #chainLinks = $state<boolean>(uiStorage.loadPrefs().chainLinks);

  get chainLinks(): boolean {
    return this.#chainLinks;
  }

  setChainLinks(on: boolean) {
    if (this.#chainLinks === on) return;
    this.#chainLinks = on;
    uiStorage.savePrefs({ chainLinks: on });
  }

  /**
   * Whether usage collection is off, or `null` for "follow the browser".
   *
   * The negative, matching gtag's `ga-disable-<id>`: the default is to
   * collect, so the state worth storing is the refusal. Three states for the
   * reason `animations` has them — do-not-track answers until someone chooses,
   * and an explicit choice then wins in both directions.
   *
   * Settings inverts it for display: every switch in that column means "this
   * is happening", and one inverted row would give `--accent` two readings.
   */
  #analyticsDisabled = $state<boolean | null>(
    uiStorage.loadPrefs().analyticsDisabled ?? null,
  );

  /** The effective answer: the user's choice, or the browser's if they have none. */
  get analyticsDisabled(): boolean {
    return analyticsOptedOut(this.#analyticsDisabled);
  }

  /**
   * Nobody has chosen *and* the browser is asking not to be tracked — the one
   * case worth saying out loud, since the switch is off and they did not do it.
   */
  get analyticsFollowsDoNotTrack(): boolean {
    return this.#analyticsDisabled === null && doNotTrackRequested();
  }

  /**
   * Writes the preference and acts on it at once — the tag is already in the
   * page, and a switch that only stopped collecting on the next load is not
   * an opt-out.
   *
   * The guard is on the *stored* choice, so the first press always lands:
   * `null` equals neither boolean, which is what pins the browser's answer
   * into an explicit one.
   */
  setAnalyticsDisabled(off: boolean) {
    if (this.#analyticsDisabled === off) return;
    this.#analyticsDisabled = off;
    uiStorage.savePrefs({ analyticsDisabled: off });
    setAnalyticsEnabled(!off);
  }

  /**
   * How far `saveLayoutImage` scales the exported PNG above the board's
   * authored sprite size.
   *
   * 1x by default, where the export used to be fixed at 2x: that put a large
   * board past 5MB, which is a lot of picture for something meant to be
   * pasted into a forum post. 2x is still there for anyone who wants it.
   */
  #imageScale = $state<ImageScale>(
    // Normalised, so a value stored before the ceiling came down cannot leave
    // the control with nothing lit.
    uiStorage.loadPrefs().imageScale === 2 ? 2 : 1,
  );

  get imageScale(): ImageScale {
    return this.#imageScale;
  }

  setImageScale(scale: ImageScale) {
    if (this.#imageScale === scale) return;
    this.#imageScale = scale;
    uiStorage.savePrefs({ imageScale: scale });
  }

  /**
   * Tile under a *fine* pointer. Transient — cleared the moment the cursor
   * leaves, so it is useless on touch, where there is no hover.
   */
  hoveredTile = $state<TileRef | null>(null);

  /**
   * Tile pinned by tapping, on a coarse pointer. Persists until dismissed:
   * tapping elsewhere, tapping it again, or the card's close control.
   */
  pinnedTile = $state<TileRef | null>(null);

  /**
   * Which dialog is open. One field rather than a boolean per dialog, so
   * "only one modal at a time" is a property of the type instead of an
   * invariant every call site has to remember to maintain.
   */
  activeModal = $state<ActiveModal>(null);

  /**
   * Share dialog: the board encoded, in both forms it can be sent in.
   *
   * Opening the dialog does not write the clipboard on the user's behalf.
   * There are two things it could copy and no way to guess which, and a silent
   * copy of the wrong one is worse than no copy — it overwrites whatever the
   * user had on their clipboard to give them something they did not ask for.
   * Both are on screen with a button each instead.
   */
  shareCode = $state("");
  shareUrl = $state("");

  /** Which of the two was copied last, for the two-second confirmation. */
  copiedForm = $state<ShareForm | null>(null);

  /**
   * The one-line message across the bottom of the screen, or `null`.
   *
   * It was hard-wired to `copiedForm`, which made "Copied" the only thing the
   * app could ever say this way. A second caller would have meant a second
   * block in `App.svelte` with its own timer and its own colours — the copy
   * that drifts.
   *
   * `tone` is not decoration: `ok` is the confirmation of something that
   * happened, `warn` is something that did *not* happen and why. The colour
   * law's `--warn` covers the second ("a limit is reached"), and `--danger`
   * would be wrong — a refused Run destroys nothing.
   */
  toast = $state<{ message: string; tone: ToastTone } | null>(null);
  #toastTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Says one thing, briefly. A second call replaces the first rather than
   * queueing: this is the bottom line of a phone screen, and a backlog of
   * messages there is a backlog nobody reads.
   */
  showToast(message: string, tone: ToastTone = "ok", ms = 2600) {
    if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);
    this.toast = { message, tone };
    this.#toastTimer = setTimeout(() => {
      this.toast = null;
      this.#toastTimer = null;
    }, ms);
  }

  /**
   * Why importing the previewed board was refused — at the island cap, or a
   * code the editor could never have produced. Shown on the preview banner,
   * which is the only place the visitor can act on it.
   */
  previewError = $state<string | null>(null);

  /** Import dialog: what the user pasted, and why it was rejected. */
  importCode = $state("");
  importError = $state<string | null>(null);
  isImporting = $state(false);

  /**
   * A pasted code from the game's Export to Optimizer button, read and
   * resolved but not yet applied — what the import dialog summarises before
   * asking to replace anything. Null for anything else in the box.
   */
  gameImport = $state<ResolvedGameImport | null>(null);
  /**
   * The same code as the game wrote it. The resolver translates what a board
   * needs and drops the rest — the economy research, the timeline — which
   * `timelineState.recordImport` keeps.
   */
  #gameExport: GameExport | null = null;
  /** What the import does with research still running in the game. */
  gameImportMode = $state<InProgressMode>("plan");

  /**
   * "Solve all islands" in progress: how many are done, how many in all, and
   * the one running now. Null with no batch running.
   */
  solveAll = $state<{ done: number; total: number; current: string } | null>(
    null,
  );
  /** Set by Stop: the island running finishes, and no further one starts. */
  #solveAllCancelled = false;
  /** Orders reads of the box, so a slow decode cannot land over a newer paste. */
  #gameReadSeq = 0;

  /** Binding reference for the PixiCanvas instance. */
  canvasRef = $state<PixiCanvas | null>(null);

  /**
   * Measured height of the bottom HUD stack, written by `HudToolbar`.
   *
   * The HUD is one or two rows depending on whether a palette is open, so its
   * height is not a constant the inspector can hard-code. The touch inspector
   * anchors itself directly above the HUD and needs the real number — the
   * alternative was a magic offset that drifts every time a row is added.
   */
  hudHeight = $state(0);

  /**
   * The element holding the readout, so `PixiCanvas` can measure it when it
   * frames the board.
   *
   * An element rather than a published number, unlike every other inset here,
   * and that is the whole reason this works. The readout changes height as the
   * board does — a solve lands, a row appears saying something is
   * overheating, the user folds it — and a *measurement* of it would be a
   * `$state` that every framing effect started depending on, so the board
   * would jump every time the card grew a line. Read from the DOM at the
   * moment of framing instead, it is always current and never a trigger.
   */
  statsRef = $state<HTMLElement | null>(null);

  /**
   * Measured height of the preview banner, or 0 when there is none.
   *
   * Same reason `hudHeight` is measured: the banner is one line normally and
   * two when it is carrying a refused import, so the readout that has to clear
   * it cannot hard-code an offset. It only matters on a phone, where the
   * readout goes full-bleed and lands directly underneath.
   */
  previewHeight = $state(0);

  /**
   * The one tile the inspector shows. Touch pins, mouse hovers — never both,
   * so there is only ever one inspector on screen.
   */
  get inspectedTile(): TileRef | null {
    return viewportState.isCoarse ? this.pinnedTile : this.hoveredTile;
  }

  /**
   * Whether there is a second board to switch to at all — with no solve there
   * is nothing to compare. This is what puts the toggle in the layout;
   * `canSwitchBoards` is what makes it visible and usable.
   */
  get hasSolverPlacements(): boolean {
    return (solverState.optimizationResult?.placements.length ?? 0) > 0;
  }

  /**
   * Whether the Edit/Solver switch has anything to offer, which is what both
   * it and the row it sits in render on.
   *
   * Not while a run is in flight, and for three reasons that all point the
   * same way. The readout is pinned to the run for the duration
   * (`statsPanel`), so switching to Edit leaves the card reporting the search
   * while the canvas draws the user's board — the one disagreement
   * `visiblePlacements` exists to make impossible. The switch back is an edge
   * on the run *starting* (`PixiCanvas`), so a layout finishing while the
   * user is on their own board lands on a board nobody is looking at. And the
   * pill would appear in the middle of a first-ever run anyway, the moment
   * the first progress report gives it placements to switch to — on a phone,
   * a whole line arriving in the HUD unasked.
   *
   * The run's board is the one on screen throughout, which is what starting a
   * run asks for; the way onto the other one is to let it finish or press
   * STOP.
   *
   * False does not always mean gone. The compact line the toggle sits on is
   * not rendered at all, but on a wide screen it shares a centred row with
   * the action pill and merely goes invisible, holding its box so RUN/STOP
   * does not re-centre under the cursor that just pressed it.
   */
  get canSwitchBoards(): boolean {
    return this.hasSolverPlacements && !solverState.isOptimizing;
  }

  /**
   * Takes the solved layout that is currently on screen into the editable
   * board, and switches to it.
   *
   * This is the way out of the solver board being read-only. A solve is worth
   * a starting point as often as it is worth an answer — a player wants to
   * take what the search found and move one cooler — and the only other route
   * is to rebuild forty buildings by hand.
   *
   * **The layout on screen, not the applied one.** `visiblePlacements` follows
   * the variant being previewed, so thumbing to the third of ten tied layouts
   * and copying gives you that one. Copying the applied variant instead would
   * hand back a board the user was not looking at.
   */
  copySolveToBoard(): boolean {
    if (this.isPreview) return false;
    if (!this.showingSolver) return false;
    const placements = this.visiblePlacements;
    if (placements.length === 0) return false;

    layoutState.adoptPlacements(placements);
    this.setPlacementView("user");
    return true;
  }

  /** True when the canvas is drawing the solver's layout rather than the user's. */
  get showingSolver(): boolean {
    return this.placementView === "solver" && this.hasSolverPlacements;
  }

  /**
   * The buildings currently on screen. The canvas renders these and the
   * inspector reads them, so the panel can never describe a building the
   * board is not showing.
   */
  get visiblePlacements(): PlacedBuilding[] {
    if (this.stepsActive) return this.#stepBoard;
    if (this.showingSolver) {
      return solverState.optimizationResult?.placements ?? [];
    }
    return layoutState.placements;
  }

  /**
   * What the board `visiblePlacements` returns puts out.
   *
   * The solve reports its own total rather than having it re-summed, which is
   * the same call `BoardStatsCard` makes and for the same reason: that is the
   * figure the search actually optimised. The user's board has no such figure,
   * so its rows — already scored by `simulation/simulator.ts` — are added up.
   */
  get visiblePower(): number {
    if (this.stepsActive)
      return this.moveSteps!.plan.powers[this.moveSteps!.index];
    if (this.showingSolver)
      return solverState.optimizationResult?.totalPower ?? 0;
    return layoutState.placements.reduce((sum, p) => sum + p.powerGenerated, 0);
  }

  /**
   * How the board on screen fares through the upgrade plan — power once every
   * step is bought, and the first step that shuts a building down — or null
   * when there is no plan or nothing to judge.
   *
   * It follows `visiblePlacements` rather than the solve, so it says the same
   * thing about any layout: a solve searched under the plan (which never
   * fails a step), one searched without it, and the player's own board. That
   * is also the warning the plan buys for free — a layout found before the
   * plan existed is told the upgrade will overheat it, before the purchase
   * rather than after.
   *
   * `$derived` because it is a simulation per step and the readout reads it on
   * every render. Absent while a run is in flight, whose streamed layouts are
   * not answers yet, and on a preview, which is someone else's board at their
   * own tiers — the reader's plan does not speak for it.
   */
  planReport: PlanReport | null = $derived.by(() => {
    if (!configState.hasPlan || this.isPreview) return null;
    if (solverState.isOptimizing) return null;
    const placements = this.visiblePlacements;
    if (placements.length === 0) return null;
    return evaluatePlan(
      layoutState.grid,
      placements,
      configState.resolvedPlan,
      configState.prestige,
      configState.activeAnomaly,
    );
  });

  /**
   * Which stats panel `BoardStatsCard` shows, if any.
   *
   * The card describes **the board on screen**, so it follows the toggle: the
   * solve's figures while the solver's layout is up, the live simulation of
   * the player's own buildings while theirs is. With neither — their board,
   * nothing built on it — there is nothing to describe and the card is absent
   * rather than sitting there full of zeroes.
   *
   * A run in flight outranks both: it has to stay visible and stoppable even
   * before it has produced a first result.
   */
  get statsPanel(): "solver" | "layout" | null {
    if (solverState.isOptimizing || solverState.optimizationError) {
      return "solver";
    }
    if (this.showingSolver) return "solver";
    return layoutState.placements.length > 0 ? "layout" : null;
  }

  /**
   * Switches the canvas between the two boards and remembers the choice.
   * A no-op write still costs a storage round-trip, so it is skipped.
   */
  setPlacementView(view: PlacementView) {
    // The steps lead to the solve; leaving the solve leaves them too.
    if (view === "user") this.closeMoveSteps();
    if (this.placementView === view) return;
    this.placementView = view;
    uiStorage.savePrefs({ placementView: view });
  }

  /**
   * The Run button's whole behaviour, in one place.
   *
   * Stops a run in flight; starts one outright when there is nothing to lose;
   * and otherwise asks first, because a re-run can come back *worse* — the
   * search is stochastic and the budget is short — and silently replacing a
   * good layout with a worse one is not something the user can undo.
   *
   * It lives here rather than on `solverState` because asking is a UI act and
   * the solver may not reach back into the interface: `ui -> solver` is the
   * only direction the state DAG allows.
   */
  requestSolve() {
    // A previewed board is read-only, and the Run button is not rendered over
    // one. This is the backstop for the keyboard and for anything that reaches
    // the verb another way.
    if (this.isPreview) return;
    if (this.running) {
      // Stop ends a "Solve all" too, not just the island it is on — and
      // between two of its islands there is no search to stop, only the batch.
      if (this.solveAll) this.#solveAllCancelled = true;
      if (solverState.isOptimizing) solverState.stopOptimizer();
      return;
    }
    /*
     * A roster that cannot produce power is refused, and the test is the real
     * one rather than "is anything unlocked": a roster of coolers, or of
     * reactors with no generator to convert their heat, is not empty and still
     * cannot come back with a number. Either way the run would spend its whole
     * budget and hand back a blank board with nothing on screen saying why.
     *
     * Two messages, because the two failures need different things done about
     * them — one is "you have not set the roster up", the other is "you have,
     * and it is missing a part". The wording names Setup because on a phone
     * that is behind a button and a closed sheet.
     *
     * After the stop branch above: pressing STOP must work whatever the roster
     * says.
     */
    if (!configState.canProducePower) {
      this.showToast(
        configState.hasUnlockedBuildings
          ? "This roster can't make power — it needs a reactor, a generator and a cooler"
          : "Unlock buildings in Setup before running",
        "warn",
        3800,
      );
      return;
    }
    /*
     * Nothing to ask about across an anomaly change: the layout on screen was
     * searched under other rules, so its power is not a bar a fresh run has
     * to clear — defending it would compare two numbers that do not mean the
     * same thing. Run outright, as if there were no result at all.
     *
     * Compared against `activeAnomaly.id` rather than the raw `anomalyId`,
     * which is whatever `localStorage` held: `resultAnomalyId` is always a
     * resolved id, so an unknown string would otherwise never match one and
     * the dialog would be skipped for good.
     *
     * The upgrade plan is the same question asked of a different input. A
     * layout searched for another plan was maximising another figure, and
     * under a plan the comparison is made on the power *after* it — so the
     * held layout is only a fair bar when both runs aim at the same plan.
     */
    if (
      solverState.optimizationResult &&
      solverState.resultAnomalyId === configState.activeAnomaly.id &&
      solverState.resultPlanKey === configState.planKey
    ) {
      this.activeModal = "solve";
      return;
    }
    this.#beginSolve();
  }

  /**
   * Answers the dialog: `keepBest` defends the layout already on screen.
   *
   * Discarding deletes it here, from the screen and from storage, before the
   * run starts rather than when its result lands. A layout the player chose
   * to throw away should not stay on the board through a 20s run, and a run
   * stopped before it reports anything would otherwise hand it back as if
   * nothing had been chosen.
   */
  startSolve(keepBest: boolean) {
    this.activeModal = null;
    if (!keepBest) solverState.clearResult();
    this.#beginSolve({ keepBest });
  }

  /**
   * The one way a run is started, and the tidying that goes with it.
   *
   * Setup is unmounted for the duration (`setupHidden`), so the sheet is shut
   * on the way in for the same reason `setUiHidden` shuts it: a detent left
   * open describes a panel that is no longer rendered, and on a compact
   * viewport it takes the whole HUD down with it — which is where STOP is.
   *
   * In practice it is already closed, because the HUD unmounts while the
   * sheet is open and Run is in the HUD. The case it covers is a sheet opened
   * on a phone and then run from a window that has since been widened, where
   * the detent survives unread until the viewport narrows again.
   */
  #beginSolve(options: { keepBest?: boolean } = {}) {
    this.setSheetDetent("closed");
    void solverState.runOptimizer(options);
  }

  /**
   * The islands "Solve all" works through: every shipped island that exists in
   * the game, less those the last import says are still locked there — the
   * player has nothing on those, and a solve for them answers no question yet.
   */
  get solveAllTargets(): IslandTemplate[] {
    const locked = timelineState.record?.lockedTemplateIds ?? [];
    return ISLAND_TEMPLATES.filter((t) => t.game && !locked.includes(t.id));
  }

  /**
   * Each Solve all island's terrain, decoded in the background for the
   * estimate: one entry per island, with the code it was decoded from — the
   * player's saved board where there is one, the shipped map otherwise. An
   * edit changes the code, and the entry is replaced rather than added to, so
   * this never holds more than one board per island. Raw: whole boards are
   * not worth proxying.
   */
  #estimateGrids = $state.raw<Record<string, { code: string; grid: Tile[][] }>>(
    {},
  );
  /**
   * The code each island's decode was started for, while it runs — and after
   * it fails, so a code that cannot be read is not decoded again on every
   * recompute. The next edit changes the code and tries once more.
   */
  #estimateDecoding = new Map<string, string>();

  /** `#estimateGrids` for one island, starting its decode if it has none yet. */
  #estimateGrid(template: IslandTemplate): Tile[][] | undefined {
    const id = template.id;
    const code = layoutState.savedGrids[id]?.code ?? template.code;
    const held = this.#estimateGrids[id];
    if (held?.code === code) return held.grid;
    if (this.#estimateDecoding.get(id) === code) return undefined;
    this.#estimateDecoding.set(id, code);
    void decodeBlueprint(code)
      .then((decoded) => {
        // Edited again while this decoded: a newer decode owns the entry.
        if (this.#estimateDecoding.get(id) !== code) return;
        this.#estimateDecoding.delete(id);
        this.#estimateGrids = {
          ...this.#estimateGrids,
          [id]: { code, grid: decoded.grid },
        };
      })
      .catch(() => {
        // Left out: the island borrows the on-screen estimate, as below.
      });
    return undefined;
  }

  /**
   * About how long Solve all takes in the current mode: each island's own
   * run, summed. Islands differ several times over in size, so the island on
   * screen times the island count — what this was — moved with whichever
   * island happened to be open. The one on screen is read live, edits and
   * all; one still decoding borrows its figure for the moment.
   */
  get solveAllEstimateMs(): number {
    const mode = solverState.solveMode;
    const onScreen = solverState.estimateRunMs(mode);
    let total = 0;
    for (const template of this.solveAllTargets) {
      if (template.id === layoutState.activeTemplateId) {
        total += onScreen;
        continue;
      }
      const grid = this.#estimateGrid(template);
      total += grid ? solverState.estimateRunMs(mode, grid) : onScreen;
    }
    return total;
  }

  /** Whether "Solve all" can start now — the controls are hidden otherwise. */
  get canSolveAll(): boolean {
    return (
      !this.isPreview &&
      !solverState.isOptimizing &&
      this.solveAll === null &&
      configState.canProducePower &&
      this.solveAllTargets.length > 0
    );
  }

  /**
   * Solves every unlocked island in turn, keeping each one's best layout, then
   * goes back to the island the player started on.
   *
   * It does this by opening each island exactly as the island list does and
   * running the same solve the Run button runs. That is deliberate: a run is
   * built around the board on screen — the layout it defends, the per-island
   * merge, the streamed progress — and solving an island off screen would mean
   * a second path through the most carefully pinned code in the app. Setup is
   * hidden while any run is in flight anyway, so there is little else to look
   * at, and watching each island solved is the progress bar.
   *
   * Each island's stored solve is defended the way the Run dialog's "keep the
   * better one" defends it, whenever it was searched under the same anomaly
   * and plan; across a change of either the two figures do not compare, and
   * the fresh run stands, as it would from the Run button.
   *
   * Stop ends the batch after the island running. A hidden tab holds the next
   * island back until it is visible again: a background tab is where a batch
   * the player has forgotten about would otherwise run their battery down.
   */
  // ── Move steps: from the game's board to the solve ─────────────────────

  /**
   * The steps from the player's board in Edit to the solve on screen, and the
   * one being looked at — see `simulation/moveSteps.ts`. Null outside step
   * mode.
   */
  moveSteps = $state<{
    templateId: string;
    result: OptimizationResult;
    plan: MovePlan;
    index: number;
    /** Each step's cash, in order — see `priceSteps`. */
    prices: StepPrice[];
  } | null>(null);

  /** Planning in progress: steps decided of steps in all. */
  moveStepsPlanning = $state<{ done: number; total: number } | null>(null);
  #moveStepsSeq = 0;

  /**
   * Whether step mode is what the board shows: the steps were planned for this
   * island and this very solve, and the solve is on screen. A switch of island,
   * a new run or the Edit view each make it false without anyone closing it,
   * so a plan can never be drawn over a board it does not describe.
   */
  get stepsActive(): boolean {
    const m = this.moveSteps;
    return (
      m !== null &&
      this.showingSolver &&
      m.templateId === layoutState.activeTemplateId &&
      m.result === solverState.optimizationResult
    );
  }

  /** Whether "Steps" can be offered for the board on screen now. */
  get canPlanMoveSteps(): boolean {
    return (
      this.showingSolver &&
      !this.isPreview &&
      !solverState.isOptimizing &&
      this.moveStepsPlanning === null &&
      (solverState.optimizationResult?.placements.length ?? 0) > 0
    );
  }

  /** The board after the step being looked at, scored. */
  #stepBoard: PlacedBuilding[] = $derived.by(() => {
    const m = this.moveSteps;
    if (!m) return [];
    const upgrades = configState.buildingUpgrades;
    return simulatePlacedBuildings(
      layoutState.grid,
      BUILDINGS,
      m.plan.boards[m.index].map((b) =>
        createPlacement(b.buildingId, b.x, b.y, upgrades),
      ),
      configState.prestige,
      configState.activeAnomaly,
    );
  });

  /**
   * Plans the steps for the island on screen and enters step mode at the
   * start. The starting board is the game's, as last imported, so the steps
   * are ones the player can take in the game; an island the import does not
   * cover starts from their board here instead. Superseded by a later call,
   * and abandoned if the solve or the island changes while it plans.
   */
  async planMoveSteps() {
    if (!this.canPlanMoveSteps) return;
    const seq = ++this.#moveStepsSeq;
    const templateId = layoutState.activeTemplateId;
    const grid = $state.snapshot(layoutState.grid);
    const upgrades = $state.snapshot(configState.buildingUpgrades);

    /*
     * The steps start from the board in Edit: straight after an import that is
     * the game's island, and once the player has rearranged it, it is where
     * they say they are. The obstacles come from the game's board as imported,
     * when there is one — a tile cleared here may still stand in the game, and
     * building on it there needs a clear first.
     */
    const start: BoardBuilding[] = layoutState.placements.map(
      ({ buildingId, x, y }) => ({ buildingId, x, y }),
    );
    let obstacles: { x: number; y: number; type: Tile["type"] }[] = [];
    const code = timelineState.record?.islands[templateId];
    if (code) {
      try {
        obstacles = (await decodeBlueprint(code)).grid
          .flat()
          .filter((t) => isObstacleType(t.type))
          .map((t) => ({ x: t.x, y: t.y, type: t.type }));
      } catch {
        // An unreadable import leaves the clears out rather than the plan.
      }
    }
    // Of the solve's layouts — every one at the same power — aim at the one
    // nearest the island: the same answer in the fewest steps. It is put on
    // screen, since the steps lead to the board being looked at.
    const shapeOf = (r: OptimizationResult): BoardBuilding[] =>
      r.placements.map(({ buildingId, x, y }) => ({ buildingId, x, y }));
    const variants = solverState.variants;
    if (variants.length > 1) {
      let nearest = solverState.variantIndex;
      let fewest = Infinity;
      variants.forEach((v, i) => {
        const n = stepCount(start, shapeOf(v));
        if (n < fewest) [fewest, nearest] = [n, i];
      });
      if (nearest !== solverState.variantIndex)
        solverState.showVariant(nearest);
    }
    const result = solverState.optimizationResult!;
    const target = shapeOf(result);
    const free = grid
      .flat()
      .filter((t) => t.type === "grass")
      .map(({ x, y }) => ({ x, y }));
    const score = createBoardScorer(
      grid,
      BUILDINGS,
      upgrades,
      configState.prestige,
      configState.activeAnomaly,
    );

    const stale = () =>
      seq !== this.#moveStepsSeq ||
      layoutState.activeTemplateId !== templateId ||
      solverState.optimizationResult !== result;

    this.moveStepsPlanning = { done: 0, total: 0 };
    try {
      const plan = await planMoveSteps(start, target, obstacles, free, score, {
        onProgress: (done, total) => {
          if (!stale()) this.moveStepsPlanning = { done, total };
        },
        cancelled: stale,
        // Scored by the planner's own scorer, so the goal and the steps are
        // measured alike: once the island makes this, the rest only shuffles.
        stopAtPower: score(
          new Map(target.map((b) => [`${b.x},${b.y}`, b.buildingId])),
        ),
      });
      if (stale()) return;
      if (plan.steps.every((step) => step.kind === "clear")) {
        this.showToast("Your island already makes as much as this layout");
        return;
      }
      const rules = priceRules(timelineState.record?.research ?? {});
      const baseOf = (id: string) => findBuilding(id)?.price ?? 0;
      const prices = priceSteps(
        plan,
        await this.#copiesAcrossIslands(),
        (id, n) => buildPrice(baseOf(id), n, rules),
        (id, n) => sellRefund(baseOf(id), n, rules),
      );
      if (stale()) return;
      this.moveSteps = {
        templateId,
        result,
        plan,
        index: 0,
        prices,
      };
      this.closeInspector();
    } catch (err) {
      if (!(err instanceof PlanCancelled)) throw err;
    } finally {
      if (seq === this.#moveStepsSeq) this.moveStepsPlanning = null;
    }
  }

  /**
   * Each building's count across every island — what a price climbs with —
   * on the boards here, as the steps start from them: the island on screen
   * from its board in Edit, every other from its saved layout.
   */
  async #copiesAcrossIslands(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const active = layoutState.activeTemplateId;
    for (const p of layoutState.placements)
      counts.set(p.buildingId, (counts.get(p.buildingId) ?? 0) + 1);
    const codes = ISLAND_TEMPLATES.filter((t) => t.game && t.id !== active).map(
      (t) => layoutState.savedGrids[t.id]?.code ?? t.code,
    );
    for (const code of codes) {
      try {
        for (const p of (await decodeBlueprint(code)).placements)
          counts.set(p.buildingId, (counts.get(p.buildingId) ?? 0) + 1);
      } catch {
        // An unreadable board counts for nothing rather than failing the plan.
      }
    }
    return counts;
  }

  /** Shows the board after step `index` (0 is the start, before any step). */
  showMoveStep(index: number) {
    const m = this.moveSteps;
    if (!m) return;
    m.index = Math.max(0, Math.min(index, m.plan.steps.length));
  }

  closeMoveSteps() {
    this.#moveStepsSeq++;
    this.moveSteps = null;
    this.moveStepsPlanning = null;
  }

  async solveAllIslands() {
    if (!this.canSolveAll) return;
    const islands = this.solveAllTargets;
    const home = layoutState.findTemplate(layoutState.activeTemplateId);
    this.#solveAllCancelled = false;
    this.setSheetDetent("closed");
    this.closeInspector();

    let done = 0;
    try {
      for (const island of islands) {
        await whenVisible();
        if (this.#solveAllCancelled) break;
        this.solveAll = {
          done,
          total: islands.length,
          current: island.name,
        };
        if (island.id !== layoutState.activeTemplateId) {
          await layoutState.loadTemplate(island, configState.buildingUpgrades);
          solverState.restore();
          this.recenterCanvas();
        }
        const keepBest =
          solverState.optimizationResult !== null &&
          solverState.resultAnomalyId === configState.activeAnomaly.id &&
          solverState.resultPlanKey === configState.planKey;
        await solverState.runOptimizer({ keepBest });
        if (this.#solveAllCancelled) break;
        done++;
      }
    } finally {
      this.solveAll = null;
      if (home && home.id !== layoutState.activeTemplateId) {
        await layoutState.loadTemplate(home, configState.buildingUpgrades);
        solverState.restore();
        this.recenterCanvas();
      }
      this.showToast(
        done === islands.length
          ? `Solved all ${done} islands`
          : `Stopped after ${done} of ${islands.length} islands`,
        done === islands.length ? "ok" : "warn",
      );
    }
  }

  /** Folds the corner readout on a small screen, and remembers it. */
  toggleStatsCard() {
    this.statsCardCollapsed = !this.statsCardCollapsed;
    uiStorage.savePrefs({ statsCardCollapsed: this.statsCardCollapsed });
  }

  /** True when the sheet covers enough of the canvas to warrant a scrim. */
  get sheetCoversCanvas(): boolean {
    return this.sheetDetent === "half" || this.sheetDetent === "full";
  }

  /**
   * Whether Setup is off screen, and with it both ways back in — the HUD's
   * Setup button and the docked panel's own handle.
   *
   * It goes away for as long as a run is in flight. Everything on its three
   * tabs is an input to *that* run — the island it is solving, the roster it
   * was planned with, the timeline it is rating against — and a run reads
   * every one of them once, at launch. So a press there either cannot reach
   * the search at all, or, on the island list, stops it outright; neither is
   * what a live panel appears to be offering.
   *
   * Hidden rather than disabled, this app's usual call, and it replaces a
   * half-measure: the run-length row and the anomaly list already greyed
   * themselves out while the island list and the roster beside them stayed
   * live, so what was on screen was a panel part working and part dead with
   * nothing saying which was which. It also hands the screen to the readout,
   * which is the one thing a player is actually watching at that moment.
   *
   * Stop is untouched — it lives in the HUD, which stays.
   */
  get setupHidden(): boolean {
    return this.running;
  }

  /**
   * Whether a run is under way, counting a whole "Solve all" as one: between
   * two of its islands the solver is idle for a moment while the next board
   * loads, and anything keyed on `isOptimizing` alone flickered there —
   * Setup flashed back in, and Run showed for a beat, where a press would
   * have started a second solve beside the batch.
   */
  get running(): boolean {
    return solverState.isOptimizing || this.solveAll !== null;
  }

  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    uiStorage.savePrefs({ sidebarCollapsed: this.sidebarCollapsed });
  }

  /**
   * Folds the docked sidebar away. Idempotent, so the HUD can call it on every
   * interaction without churning storage.
   *
   * It persists, like an explicit collapse does: the alternative leaves the
   * panel visibly shut while `localStorage` still claims it is open, so the
   * next reload springs it back for no reason the user can see.
   */
  collapseSidebar() {
    if (this.sidebarCollapsed) return;
    this.sidebarCollapsed = true;
    uiStorage.savePrefs({ sidebarCollapsed: true });
  }

  /**
   * Opening the sheet past `peek` dismisses a pinned inspector — one
   * inspector at a time, and the sheet would cover it anyway.
   */
  setSheetDetent(detent: SheetDetent) {
    this.sheetDetent = detent;
    if (detent === "half" || detent === "full") this.pinnedTile = null;
  }

  /** Tapping the pinned tile again clears it; tapping a new one moves it. */
  pinTile(tile: TileRef | null) {
    const current = this.pinnedTile;
    if (tile && current && current.x === tile.x && current.y === tile.y) {
      this.pinnedTile = null;
      return;
    }
    this.pinnedTile = tile;
  }

  closeInspector() {
    this.pinnedTile = null;
    this.hoveredTile = null;
  }

  get inspectedBuilding(): PlacedBuilding | null {
    const tile = this.inspectedTile;
    if (!tile) return null;
    const { x, y } = tile;

    // Whichever board is on screen — the inspector must describe what the user
    // can actually see, not the other layout hiding behind it.
    return this.visiblePlacements.find((p) => p.x === x && p.y === y) ?? null;
  }

  recenterCanvas() {
    this.canvasRef?.recenterGrid();
  }

  /**
   * Opens the share dialog on **the board that is on screen** — the solve when
   * the solver's layout is up, the user's own when theirs is.
   *
   * A share code limited to the hand-placed board would leave the layout a
   * five-minute run produced as the one thing in the app that cannot be sent to
   * anyone. `visiblePlacements` is already the single answer to "which board is
   * this", and the canvas and the inspector both read it, so sharing it means
   * the code describes exactly what the user was looking at when they pressed
   * the button.
   *
   * The code carries terrain, buildings and the tier each building is standing
   * at; see `encoding/blueprint.ts`.
   */
  async shareLayout() {
    this.overflowOpen = false;
    this.activeModal = "share";
    this.shareCode = "";
    this.shareUrl = "";
    this.copiedForm = null;
    try {
      // The rules the board on screen was built under travel with it — this
      // is the one place that can see both the board and `configState`. A
      // previewed board was built under its author's, so re-sharing it passes
      // those on (or their absence) rather than restating it under the reader's.
      const code = await layoutState.exportBlueprint(
        layoutState.isPreview
          ? layoutState.previewRules
          : blueprintRules(configState.anomalyId, configState.prestigeLevels),
        this.visiblePlacements,
      );
      this.shareCode = code;
      this.shareUrl = buildShareUrl(code);
    } catch (err) {
      console.error("[UI] Failed to encode layout:", err);
      this.shareCode = "";
      this.shareUrl = "";
    }
  }

  /**
   * Saves the board on screen as a PNG.
   *
   * The third way a layout leaves the app, and the only one that is not a
   * code: a share code needs this app to read it, so it is no use for a forum
   * post, a Discord message or a note to yourself. A picture is.
   *
   * It follows the same board Share does — `PixiCanvas` draws
   * `visiblePlacements`, so what is captured is what the user is looking at —
   * and it is allowed in preview, because it writes nothing the visitor owns.
   *
   * The flag is for the button: extracting a large board takes long enough to
   * look like a press that did nothing, and long enough to be pressed twice.
   */
  isSavingImage = $state(false);

  async saveLayoutImage() {
    if (this.isSavingImage) return;
    this.overflowOpen = false;
    this.isSavingImage = true;
    try {
      // The filename is taken before the extract, not after: it names the
      // board being captured, and a run finishing mid-capture must not move
      // the figure out from under it.
      const filename = layoutImageFilename(
        layoutState.activeTemplateId,
        this.visiblePower,
      );
      const blob = await this.canvasRef?.exportBoardImage(this.imageScale);
      if (!blob) return;

      downloadBlob(blob, filename);
    } catch (err) {
      // Nothing to say to the user that the absent download does not already
      // say, and nothing they can do about a renderer that refused to read
      // itself back.
      console.error("[UI] Failed to export the board as an image:", err);
    } finally {
      this.isSavingImage = false;
    }
  }

  /**
   * Copies one of the two forms. The dialog's only write to the clipboard, and
   * it is always a direct response to a press — which is also what makes it
   * work: a clipboard write not tied to a user gesture is refused outright by
   * some mobile browsers.
   */
  async copyShare(form: ShareForm) {
    const text = form === "code" ? this.shareCode : this.shareUrl;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      trackEvent("share_copy", { form });
      this.copiedForm = form;
      // The dialog can be taller than a phone, so the button that was pressed
      // — and its own "Copied!" label — may have scrolled out of sight.
      this.showToast("Copied", "ok", 2000);
      setTimeout(() => {
        // Only if it is still this one: copying the other form in the meantime
        // has already moved the confirmation, and this would clear it early.
        if (this.copiedForm === form) this.copiedForm = null;
      }, 2000);
    } catch {
      // Clipboard unavailable (non-secure origin, or denied) — both strings
      // are on screen and selectable, so this is not worth an error state.
    }
  }

  // ── Preview: a board opened from a shared link ───────────────────────────

  /** True while the canvas is showing someone else's board, from a link. */
  get isPreview(): boolean {
    return layoutState.isPreview;
  }

  /**
   * Whether the board on screen runs under an anomaly — the author's on a
   * previewed board, the player's otherwise. It is what the theme keys on:
   * the theme says "this timeline is not the ordinary rules", and on a shared
   * link the timeline being read is the author's, which is also the one the
   * board's figures are rated under (`layoutState.placementAnomaly`).
   */
  get boardHasAnomaly(): boolean {
    return this.isPreview
      ? layoutState.placementAnomaly.rule !== "baseline"
      : configState.hasAnomaly;
  }

  /**
   * Leaves the shared board and puts the visitor back on their own.
   *
   * The link's parameter goes with it, so a reload does not drop them straight
   * back into the preview they just left, and the solve for the island they
   * return to is re-hung — it was never discarded, only never restored while
   * the preview was up.
   */
  async exitPreview() {
    this.previewError = null;
    this.closeInspector();
    await layoutState.exitPreview(configState.buildingUpgrades);
    clearSharedCode();
    solverState.restore();
    this.recenterCanvas();
  }

  /**
   * Takes the shared board as one of the visitor's own islands, and leaves
   * preview by doing so.
   *
   * It lands in a new custom slot — the same destination a pasted code gets,
   * for the same reason: it is the only one that overwrites nothing. If it is
   * refused, the visitor stays in preview with the reason on the banner rather
   * than being dropped somewhere they did not ask to be.
   */
  async importPreview() {
    this.previewError = null;
    try {
      await layoutState.adoptPreview(configState.buildingUpgrades);
    } catch (err) {
      this.previewError =
        err instanceof Error
          ? err.message
          : "That layout could not be imported.";
      return;
    }
    clearSharedCode();
    solverState.restore();
    this.closeInspector();
    this.recenterCanvas();
  }

  /** Opens Settings. Reachable from the overflow menu at every width. */
  openSettings() {
    this.overflowOpen = false;
    this.activeModal = "settings";
  }

  /** Opens the import dialog on a clean slate — a stale error is confusing. */
  openImport() {
    this.overflowOpen = false;
    this.importCode = "";
    this.importError = null;
    this.isImporting = false;
    this.gameImport = null;
    this.#gameExport = null;
    this.activeModal = "import";
  }

  /**
   * Reads the import box when it holds a game code, so the dialog can say what
   * the code contains before anything is replaced. Anything else in the box
   * clears the summary and is left for `importLayout`.
   */
  async readImportCode(code: string) {
    const seq = ++this.#gameReadSeq;
    if (!isGameExportCode(code)) {
      this.gameImport = null;
      this.#gameExport = null;
      return;
    }
    try {
      const exp = await decodeGameExport(code);
      // Clears that finished between the export and now come in as cleared.
      const resolved = await resolveGameExport(exp, { now: Date.now() / 1000 });
      if (seq !== this.#gameReadSeq) return;
      this.#gameExport = exp;
      this.gameImport = resolved;
      this.importError = null;
    } catch (err) {
      if (seq !== this.#gameReadSeq) return;
      this.gameImport = null;
      this.#gameExport = null;
      this.importError =
        err instanceof Error ? err.message : "That code could not be read.";
    }
  }

  /**
   * Applies a read game code: the roster, Time Lab, anomaly and — depending on
   * `gameImportMode` — the upgrade plan, then each unlocked island's board.
   *
   * Unlike a share code this replaces what the player had, which is the point
   * of it: the game is the record of what they own. The dialog asks twice
   * before calling this. Configuration goes first so the islands are loaded
   * at the imported roster.
   */
  async applyGameImport() {
    const resolved = this.gameImport;
    const exp = this.#gameExport;
    if (!resolved || !exp || this.isImporting) return;
    this.isImporting = true;
    this.importError = null;
    try {
      // The run belongs to a board and a roster this is about to replace, so
      // it has to have landed before either changes — see `settleOptimizer`.
      await solverState.settleOptimizer();
      configState.applyGameImport(
        applyInProgress(resolved, this.gameImportMode),
        resolved.anomalyId,
      );
      await layoutState.importGameIslands(
        resolved.islands,
        configState.buildingUpgrades,
        resolved.lockedTemplateIds,
      );
      // Every stored solve was found under the old roster: keep each one the
      // import left buildable, re-scored, before restore() reads the store.
      await solverState.carryOverSolves(resolved.lockedTemplateIds);
      await timelineState.recordImport(exp, resolved);
      this.activeModal = null;
      this.importCode = "";
      this.gameImport = null;
      this.#gameExport = null;
      solverState.restore();
      this.closeInspector();
      this.recenterCanvas();
      const n = resolved.islands.length;
      this.showToast(`Imported your game: ${n} island${n === 1 ? "" : "s"}`);
    } catch (err) {
      this.importError =
        err instanceof Error ? err.message : "That code could not be imported.";
    } finally {
      this.isImporting = false;
    }
  }

  /**
   * Loads the pasted code as a new custom island and closes on success.
   *
   * The board it produces is the user's to edit, which is the point: a shipped
   * island's terrain is fixed, so an import has nowhere else it could land.
   */
  async importLayout() {
    if (this.isImporting) return;
    this.isImporting = true;
    this.importError = null;
    try {
      await layoutState.importBlueprint(
        this.importCode,
        configState.buildingUpgrades,
        // A run belongs to the board it was launched from, which an import
        // takes off the screen — the reason a template switch stops one first.
        // Stopped only once the code is accepted, so a bad paste mid-run costs
        // nothing.
        () => solverState.stopOptimizer(),
      );
      this.activeModal = null;
      this.importCode = "";
      // An import is a template switch, and every switch has to swap the
      // solve panel to the new island's (it has none yet, so this clears it).
      // Without it the previous island's solve stayed up — over the solver
      // view that is the old board's buildings on the new board's terrain —
      // until a switch away and back ran the restore this one skipped.
      solverState.restore();
      this.closeInspector();
      // The imported board is a different shape; frame it.
      this.recenterCanvas();
    } catch (err) {
      this.importError =
        err instanceof Error ? err.message : "That import could not be read.";
    } finally {
      this.isImporting = false;
    }
  }

  /**
   * Opens the run-length explainer.
   *
   * It is a modal rather than a tooltip because the answer is a paragraph, not
   * a phrase — why more searches beat a longer one, and what they cost on this
   * machine — and because on a phone the control lives in a bottom sheet with
   * no room beside it for anything at all.
   */
  openSolveModeInfo() {
    this.activeModal = "solveModes";
  }

  /**
   * Opens the upgrade plan editor. A dialog rather than a section of Setup:
   * each step wants an icon, a tier row and reordering, which would push the
   * roster down the Buildings tab on every visit for a thing set once.
   */
  openUpgradePlan() {
    this.activeModal = "upgradePlan";
  }

  /** The Time Lab planner: what to buy with the Chronons a jump would leave. */
  openTimeLabPlanner() {
    this.overflowOpen = false;
    this.activeModal = "timeLab";
  }

  closeModal() {
    if (this.activeModal === "transferIn") clearTransferLink();
    this.activeModal = null;
  }

  // ── Transfer: everything, to another browser ─────────────────────────────

  /** The code and link "Transfer" offers; empty while they are built. */
  transferCode = $state("");
  transferUrl = $state("");
  /** A transfer code read from a link or the import box, waiting for a yes. */
  transferIn = $state<TransferBundle | null>(null);
  transferError = $state<string | null>(null);
  isTransferring = $state(false);
  /** Bumped by each `openTransfer`, so only the newest build lands. */
  #transferSeq = 0;

  /**
   * Opens the transfer dialog and builds the code: the roster, Time Lab,
   * anomaly and plan, every board as it stands, each island's picked solve,
   * the last game import and the Chronon target.
   */
  async openTransfer() {
    const seq = ++this.#transferSeq;
    this.overflowOpen = false;
    this.transferCode = "";
    this.transferUrl = "";
    this.activeModal = "transfer";
    const solves: Record<string, TransferSolve> = {};
    for (const id of solverStorage.solveIds()) {
      const saved = solverStorage.loadSolve(id);
      const grid = saved && (await layoutState.boardOf(id));
      if (!saved || !grid) continue;
      const picked =
        saved.variants?.[saved.selectedVariant ?? 0]?.map(
          ([buildingId, x, y]) => ({ buildingId, x, y }),
        ) ?? saved.result.placements;
      solves[id] = {
        code: await encodeBlueprint(grid, picked),
        anomalyId: saved.anomalyId ?? configState.activeAnomaly.id,
        planKey: saved.planKey ?? "",
        durationMs: saved.durationMs,
        finishedAt: saved.finishedAt,
      };
    }
    const boards = await layoutState.boardsSnapshot();
    const code = await encodeTransfer({
      buildingUpgrades: $state.snapshot(configState.buildingUpgrades),
      prestigeLevels: $state.snapshot(configState.prestigeLevels),
      anomalyId: configState.activeAnomaly.id,
      upgradePlan: $state.snapshot(configState.upgradePlan),
      activeTemplateId: boards.activeTemplateId,
      customIslands: boards.customIslands ?? [],
      boards: Object.fromEntries(
        Object.entries(boards.savedGrids).map(([id, g]) => [id, g.code]),
      ),
      solves,
      gameImport: timelineState.record
        ? $state.snapshot(timelineState.record)
        : null,
      chrononTarget: timelineState.chrononTarget,
    });
    if (seq !== this.#transferSeq || this.activeModal !== "transfer") return;
    this.transferCode = code;
    this.transferUrl = buildTransferUrl(code);
  }

  /**
   * Reads a transfer code — from a link the page opened with, or pasted into
   * Import — and asks before loading it.
   */
  async receiveTransfer(code: string) {
    try {
      this.transferIn = await decodeTransfer(code);
      this.transferError = null;
    } catch (err) {
      this.transferIn = null;
      this.transferError =
        err instanceof Error ? err.message : "That code could not be read.";
    }
    this.overflowOpen = false;
    this.activeModal = "transferIn";
  }

  /** At startup: offers the transfer a link carried, if it carried one. */
  async receiveTransferLink() {
    const code = readTransferLink();
    if (code && !this.isPreview) await this.receiveTransfer(code);
    else clearTransferLink();
  }

  /**
   * Replaces everything here with the transfer read by `receiveTransfer`.
   * The dialog asks twice first: it overwrites boards, solves and the game
   * import this browser may hold and nowhere else.
   */
  async applyTransfer() {
    const t = this.transferIn;
    if (!t || this.isTransferring) return;
    this.isTransferring = true;
    this.transferError = null;
    try {
      await solverState.settleOptimizer();
      this.closeMoveSteps();
      configState.applyGameImport(
        {
          buildingUpgrades: t.buildingUpgrades,
          prestigeLevels: t.prestigeLevels,
          upgradePlan: t.upgradePlan,
        },
        t.anomalyId,
      );
      layoutState.setPrestige(configState.prestige);
      layoutState.setAnomaly(configState.activeAnomaly);

      // Solves first, unscored: re-filing them below scores each one on its
      // board at this browser's roster, as after any roster change.
      for (const id of solverStorage.solveIds()) solverStorage.clearSolve(id);
      for (const [id, s] of Object.entries(t.solves)) {
        const { placements } = await decodeBlueprint(s.code);
        solverStorage.saveSolve({
          templateId: id,
          signature: "",
          result: {
            totalPower: 0,
            placements: [],
            activeTilesCount: 0,
            unusedTilesCount: 0,
            summary: {
              totalHeatProduced: 0,
              totalHeatConsumed: 0,
              totalWasteGenerated: 0,
              totalCoolingCapacity: 0,
            },
            theoreticalMaxPower: 0,
          },
          variants: [
            placements.map((p): StoredPlacement => [p.buildingId, p.x, p.y, 0]),
          ],
          selectedVariant: 0,
          anomalyId: getAnomaly(s.anomalyId).id,
          planKey: s.planKey,
          durationMs: s.durationMs,
          finishedAt: s.finishedAt,
        });
      }

      await layoutState.adoptBoards(
        {
          activeTemplateId: t.activeTemplateId,
          savedGrids: Object.fromEntries(
            Object.entries(t.boards).map(([id, code]) => [id, { code }]),
          ),
          customIslands: t.customIslands,
        },
        configState.buildingUpgrades,
      );
      await solverState.carryOverSolves([]);
      if (t.gameImport)
        timelineState.adoptRecord(t.gameImport, t.chrononTarget);
      void timelineState.refreshIslands();

      clearTransferLink();
      this.transferIn = null;
      this.activeModal = null;
      solverState.restore();
      this.closeInspector();
      this.recenterCanvas();
      this.showToast("Loaded everything from your other device");
    } catch (err) {
      this.transferError =
        err instanceof Error
          ? err.message
          : "That transfer could not be loaded.";
    } finally {
      this.isTransferring = false;
    }
  }

  /** Copies the transfer link or code. */
  async copyTransfer(form: "link" | "code") {
    const text = form === "link" ? this.transferUrl : this.transferCode;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.showToast("Copied", "ok", 2000);
    } catch {
      // Unavailable or denied: the link is on screen and selectable.
    }
  }

  /** Hands the link to the system share sheet, where there is one. */
  get canShareTransfer(): boolean {
    return typeof navigator !== "undefined" && "share" in navigator;
  }

  async shareTransfer() {
    if (!this.transferUrl) return;
    try {
      await navigator.share({
        title: "Reactor 2 Optimizer",
        text: "Open to load my islands and solves",
        url: this.transferUrl,
      });
    } catch {
      // Dismissed, or refused — nothing to report.
    }
  }
}

/** Resolves at once on a visible page, else when it next becomes visible. */
function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden")
    return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

export const uiState = new UIState();
