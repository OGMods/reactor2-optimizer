import type { PixiCanvas } from "../components";
import type { ImageScale, PlacedBuilding, PlacementView } from "../types";
import type { BuildingCategory } from "@reactor2/solver";
import { buildShareUrl, clearSharedCode } from "../encoding/shareLink";
import { downloadBlob, toFileSlug } from "../utils/downloadFile";
import { formatNumberForFilename } from "@reactor2/solver";
import {
  analyticsOptedOut,
  doNotTrackRequested,
  setAnalyticsEnabled,
  trackEvent,
} from "../utils/analytics";
import { uiStorage } from "../storage/storage";
import { configState } from "./config.svelte";
import { layoutState } from "./layout.svelte";
import { solverState } from "./solver.svelte";
import { viewportState } from "./viewport.svelte";

/** A tile the inspector can point at. Internal — nothing outside builds one. */
interface TileRef {
  x: number;
  y: number;
  type: string;
}

/** The dialogs the app can have open. Only ever one at a time. */
type ActiveModal =
  "share" | "import" | "solve" | "solveModes" | "settings" | null;

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
type SetupTab = "islands" | "buildings";

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
   * Whether usage collection is off, or `null` for "follow the browser".
   *
   * The negative, matching gtag's `ga-disable-<id>`: the default is to
   * collect, so the state worth storing is the refusal. Three states for the
   * reason `animations` has them — do-not-track answers until someone chooses,
   * and an explicit choice then wins in both directions.
   *
   * Settings inverts it for display: every switch in that column means "this
   * is happening", and one inverted row would give `--neon` two readings.
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
   * Whether there is a second board to switch to at all. The toggle renders
   * only when this is true — with no solve there is nothing to compare.
   */
  get hasSolverPlacements(): boolean {
    return (solverState.optimizationResult?.placements.length ?? 0) > 0;
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
    if (this.showingSolver)
      return solverState.optimizationResult?.totalPower ?? 0;
    return layoutState.placements.reduce((sum, p) => sum + p.powerGenerated, 0);
  }

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
    if (solverState.isOptimizing) {
      solverState.stopOptimizer();
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
    if (solverState.optimizationResult) {
      this.activeModal = "solve";
      return;
    }
    void solverState.runOptimizer();
  }

  /** Answers the dialog: `keepBest` defends the layout already on screen. */
  startSolve(keepBest: boolean) {
    this.activeModal = null;
    void solverState.runOptimizer({ keepBest });
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
      const code = await layoutState.exportBlueprint(this.visiblePlacements);
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
    this.activeModal = "import";
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
      );
      this.activeModal = null;
      this.importCode = "";
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

  closeModal() {
    this.activeModal = null;
  }
}

export const uiState = new UIState();
