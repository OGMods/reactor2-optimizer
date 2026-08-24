<script lang="ts">
  import {
    editorState,
    layoutState,
    configState,
    solverState,
    uiState,
    viewportState,
  } from "../../state";
  import { createPlacement } from "../../data/placements";
  import { onMount, onDestroy, untrack } from "svelte";
  import { Application, Container, Rectangle } from "pixi.js";
  import { loadAtlas } from "../../pixi/atlas";
  import { GridRenderer } from "../../pixi/gridPainter";
  import { ViewportControls } from "../../pixi/viewportControls";
  import { hapticTap } from "../../utils/haptics";
  import { dismissBootLoader } from "../../utils/bootLoader";
  import { trackEvent } from "../../utils/analytics";
  import type { ImageScale } from "../../types/ui";
  import {
    EXPORT_MAX_SIDE_PX,
    EXPORT_PADDING_PX,
  } from "../../pixi/boardExport";

  /*
   * The green the board sits on, as Pixi's numeric literal.
   *
   * `--canvas-clear` in `src/app.css` is the same colour, and `.canvas-wrapper`
   * below paints itself with it. Both are needed: the wrapper is on screen for
   * the frames before Pixi has initialised, so a wrapper in a different green
   * shows as a flash of the wrong colour on load. Pixi cannot read a custom
   * property, which is why this number exists twice at all — keep them equal.
   */
  const CANVAS_CLEAR = 0x46b696;

  let canvasWrapper: HTMLDivElement;
  let app: Application;
  let gridContainer: Container;
  let gridRenderer: GridRenderer | null = null;
  let viewportControls: ViewportControls | null = null;
  let isAtlasLoaded = $state(false);

  /**
   * A write, as a function of the tile it lands on. `true` if it wrote.
   *
   * Everything a press can do to the board is one of these, which is what lets
   * a press capture *its* action once and repeat it over every tile the drag
   * passes through — rather than the hover handler re-deciding, where a
   * right-button erase-drag would come back as whatever the left button paints.
   */
  type TileAction = (x: number, y: number) => boolean;

  /**
   * The action the press in flight repeats as it moves, or `null` when nothing
   * is being dragged.
   *
   * One field rather than a flag per tool, because the set of tools does not
   * close: a held building is placed exactly once by a drag, which no
   * paint/erase pair can express. Holding the action itself also keeps the
   * choice with the press that made it, rather than in the hover handler a
   * long way from anything that knows which button went down.
   */
  let dragAction: TileAction | null = null;
  let activeHoverKey: string | null = null;

  /*
   * Tap-to-inspect, coarse pointers only.
   *
   * `onPointerOver` does not meaningfully exist on touch — a tap fires
   * over/out around the press, so a card driven by it flickers away instantly
   * and the tile stats are unreachable on a phone. A tap that does not turn
   * into a drag pins them instead.
   *
   * The pin is committed on pointer *up* rather than down so that dragging to
   * pan does not leave a card behind.
   */
  const TAP_SLOP_PX = 10;
  let pendingPin: { x: number; y: number; type: string } | null = null;
  let pinDownPos = { x: 0, y: 0 };

  /*
   * And the way back out: a tap on the green *beside* the board dismisses it.
   *
   * A pinned card outlives the tap that made it, so without this the only ways
   * to be rid of one are to tap the same tile a second time — which means
   * finding a tile the board has probably since been panned away from — or to
   * open the sheet. Tapping off the thing you were reading is the gesture
   * every list, sheet and popover on the platform already answers to.
   *
   * Held as the press position rather than a boolean, because the same slop
   * rule the pin itself follows has to apply here: the empty green is most of
   * the screen and it is *the* place to grab the board and pan it, so a drag
   * that starts there must leave the card alone. Committed on pointer up, once
   * it is known not to have been a drag.
   */
  let pendingDismiss: { x: number; y: number } | null = null;

  /**
   * Whether the press currently landing hit a tile.
   *
   * Written by the tile handler below, which Pixi dispatches from its listener
   * on the canvas — a *child* of the wrapper — so it has always run by the time
   * the wrapper's own `pointerdown` reads it. That ordering is bubbling rather
   * than registration order, which is what makes it safe to depend on;
   * `ViewportControls` keeps its own `handledByTile` for the same question
   * because it is answering it from its own wrapper listener, where the order
   * against this component's would be a coin toss.
   */
  let pressHitTile = false;

  /**
   * How soon after a press writes something a second finger still reads as
   * "these two touches were one pinch".
   *
   * The canvas cannot know at `pointerdown` whether a press is a tap or the
   * first finger of a pinch, and waiting to find out would put a delay on
   * every placement. So it writes at once and takes it back if the second
   * finger arrives while the first is still, in effect, landing.
   *
   * Past the window the write stands: a press that has been down half a
   * second was aimed, and a drag-paint that a pinch interrupts is not an
   * accident to be undone.
   */
  const PINCH_GRACE_MS = 250;
  let lastWriteAt = 0;

  /**
   * A write a touch press has *earned* but not yet been given.
   *
   * On a touch screen one finger is the only way to move the board, so a press
   * that writes on contact takes panning away for as long as a tool is held —
   * which on a phone is most of the time, and is why dragging with a building
   * selected placed a row of buildings instead of moving the map. Writing on
   * contact and taking it back (see `PINCH_GRACE_MS` above) cannot fix that:
   * it can tell a pinch from a tap after the fact, but there is nothing to
   * tell a drag-to-pan from a drag-to-paint once the first tile is written.
   *
   * So a touch press writes on **lift** instead. The press arms the edit and
   * starts a pan; the edit lands if the finger comes up within `TAP_SLOP_PX`
   * of where it went down, and is dropped the moment the gesture turns out to
   * be something else — a drag, a second finger, a cancel. Committing on the
   * up is what the pinned tile card and the double-tap zoom already do, and
   * what every button on the platform does.
   *
   * A mouse or a pen still writes on contact, which is what keeps drag-paint
   * over a run of tiles working: those pointers have a middle-button drag and
   * a wheel to navigate with, and they cannot pinch.
   */
  let pendingEdit: {
    run: TileAction;
    tileX: number;
    tileY: number;
    downX: number;
    downY: number;
  } | null = null;

  /**
   * How long a finger must stay put before the press stops being a pan and
   * becomes a brush.
   *
   * Deferring to the lift gives a touch screen back its pan, but on its own it
   * costs the drag: painting a run of tiles or clearing a line of rocks became
   * a tap each. A hold is the way out of that trade — it is the gesture the
   * platform already uses for "no, I meant this one" — and it costs the pan
   * nothing, because a pan starts by *moving*.
   *
   * 350ms is above the length of the pause at the start of an ordinary drag
   * and below the ~500ms a long-press menu takes, which is not a menu the
   * board has.
   */
  const HOLD_TO_EDIT_MS = 350;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHold() {
    if (holdTimer === null) return;
    clearTimeout(holdTimer);
    holdTimer = null;
  }

  /** Whether a press writes on lift rather than on contact. */
  function writesOnLift(e: PointerEvent): boolean {
    return e.pointerType === "touch";
  }

  /**
   * Performs one tile's write and, when asked, confirms it by touch.
   *
   * `confirm` is the caller's call rather than the action's because the haptic
   * marks a *decision*, not a tile: it fires on the tap that placed something,
   * and once at the moment a hold turns the finger into a brush. A drag then
   * writes in silence — a buzz per tile across a painted row is a rattle, and
   * it would say nothing the first one has not.
   */
  function commitAction(
    action: TileAction,
    x: number,
    y: number,
    confirm: boolean,
  ) {
    if (!action(x, y)) return;
    lastWriteAt = performance.now();
    if (confirm && uiState.haptics) hapticTap();
  }

  /**
   * How much room a full-bleed readout is allowed to claim before the framing
   * gives up on it, as a share of the viewport height.
   *
   * `recenter` already refuses an inset that leaves less than 40% of an axis,
   * but that guard is against the total. This one is against the readout
   * alone: on a short landscape phone an unfolded card carrying a solve, two
   * failure counts and an inspected building can be most of the screen, and
   * framing the board into the strip under it would be worse than letting the
   * card overlap it.
   */
  const MAX_READOUT_INSET = 0.4;

  /** The gap the readout is set below the header, `0.5rem` in `App.svelte`. */
  const READOUT_GAP_PX = 8;

  /**
   * Where the free band starts: under the readout when the readout is a band
   * across the top, and under the header when it is not.
   *
   * On a phone the readout goes full-bleed directly beneath the header, so it
   * *is* chrome over the board and the board was being framed behind it —
   * centred in a band whose top third the card was sitting on, with the slack
   * left over at the bottom. On a wide screen the same card is 250px in the
   * top-right corner, where the board may quite happily run underneath it, and
   * treating it as an inset would push the board down for no reason.
   *
   * Which of the two it is, is decided by **measuring** rather than by
   * repeating the `640px` breakpoint that decides it in `App.svelte`'s CSS: a
   * readout that spans the viewport is a band, and one that does not is a
   * corner card. A second copy of that number in a second language is a thing
   * to get wrong later.
   *
   * Read from the DOM here, at the moment of framing, rather than from a
   * published measurement — see `uiState.statsRef`.
   */
  function readoutInset(): number {
    const el = uiState.statsRef;
    if (!el) return uiState.headerBottom;

    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return uiState.headerBottom;

    const spansViewport =
      rect.width >= document.documentElement.clientWidth * 0.9;
    if (!spansViewport) return uiState.headerBottom;

    const bottom = rect.bottom + READOUT_GAP_PX;
    return bottom > window.innerHeight * MAX_READOUT_INSET
      ? uiState.headerBottom
      : bottom;
  }

  /**
   * Frames the board in the space the chrome leaves free.
   *
   * Every inset is live, because every one of them changes size at runtime:
   * the header sheds controls on a phone, the HUD grows a row when a palette
   * ribbon opens, the sidebar folds away, and the readout grows a line when
   * something on the board stops working. The first three are measured and
   * published by the components that own them — `Header`, `HudToolbar`,
   * `ConfigSidebar`; the fourth is measured here, for the reason on
   * `readoutInset`.
   *
   * Read **untracked**, which is what keeps a live measurement from becoming a
   * live re-framing. The effects that call this declare the dependencies they
   * actually want — the initial framing waits on the header and HUD, the
   * re-frame watches the sidebar — and none of them wants to fire because the
   * readout grew a row, which would yank the board out from under a player
   * mid-tap.
   */
  export function recenterGrid() {
    const inset = untrack(() =>
      /*
       * With the interface hidden there is no chrome to frame the board
       * inside, so the free band is the whole window.
       *
       * Read rather than inferred from the published measurements, because
       * those do not all reset when their component unmounts — `hudHeight`
       * clears itself on teardown, but `headerBottom` and `sidebarWidth` keep
       * whatever they last measured. Without this a resize while the interface
       * was away (rotating a phone, most likely) would frame the board into a
       * band reserved for bars that are not on screen.
       */
      uiState.uiHidden
        ? { top: 0, bottom: 0, left: 0 }
        : {
            top: readoutInset(),
            bottom: uiState.hudHeight,
            left: uiState.sidebarWidth,
          },
    );
    viewportControls?.recenter(layoutState.width, layoutState.height, inset);
  }

  /**
   * The board on screen, as a PNG.
   *
   * It captures the *grid container*, not the visible canvas, and the
   * difference is the whole point: `getLocalBounds` ignores the container's
   * own transform, so the picture is the entire board at its authored sprite
   * scale — not the part of it the window happens to be showing, and not
   * whatever zoom the user last pinched to. Panning away from the map, or
   * halfway through a pinch, still exports the same picture.
   *
   * Which layout that is needs no decision here. The canvas already draws
   * `uiState.visiblePlacements`, so the export is the board the user is
   * looking at, solver's or their own, for the same reason Share is.
   *
   * The scale is passed in rather than read here: it is a preference, and the
   * renderer is told what to do with it — the same split `setAnimated` makes.
   *
   * `null` when there is nothing to capture — before the atlas has loaded, or
   * when the browser refuses the blob.
   */
  export async function exportBoardImage(
    scale: ImageScale,
  ): Promise<Blob | null> {
    if (!app || !gridContainer || !isAtlasLoaded) return null;

    const bounds = gridContainer.getLocalBounds();
    if (!(bounds.width > 0) || !(bounds.height > 0)) return null;

    const frame = new Rectangle(
      bounds.x - EXPORT_PADDING_PX,
      bounds.y - EXPORT_PADDING_PX,
      bounds.width + EXPORT_PADDING_PX * 2,
      bounds.height + EXPORT_PADDING_PX * 2,
    );

    // The cap wins outright over the chosen scale, and is not floored at 1x:
    // an oversized render texture comes back blank, and a board no shipped
    // island reaches is still not a reason to hand back an empty picture.
    const longest = Math.max(frame.width, frame.height);
    const resolution = Math.min(scale, EXPORT_MAX_SIDE_PX / longest);

    const canvas = app.renderer.extract.canvas({
      target: gridContainer,
      frame,
      resolution,
      antialias: true,
      // The same green the board sits on, so the margin above is board rather
      // than a transparent halo that turns black in most image viewers.
      clearColor: CANVAS_CLEAR,
    });

    // `ICanvas` is Pixi's abstraction over an HTMLCanvasElement and an
    // OffscreenCanvas, which spell "give me a blob" differently.
    if (typeof canvas.toBlob === "function") {
      return await new Promise<Blob | null>((resolve) =>
        canvas.toBlob!((blob) => resolve(blob), "image/png"),
      );
    }
    if (typeof canvas.convertToBlob === "function") {
      return await canvas.convertToBlob({ type: "image/png" });
    }
    return null;
  }

  /**
   * What a press does when it is not going to write anything: start a pan, and
   * on a coarse pointer arm the tile to be pinned if the press turns out not
   * to be a drag.
   *
   * The two callers are the last branch of an editable board — no tool in
   * hand, no building selected — and the whole of a read-only one (a shared
   * link, or the solver's own layout). They are the same gesture reached two
   * ways, so it is written once here rather than as the same eight lines twice.
   */
  function beginPanOrPin(x: number, y: number, native: PointerEvent) {
    if (viewportState.isCoarse) {
      const tile = layoutState.grid[y]?.[x];
      pendingPin = tile ? { x, y, type: tile.type } : null;
      pinDownPos = { x: native.clientX, y: native.clientY };
    }
    viewportControls?.startPan(native);
  }

  /**
   * The write a press with this button performs, as a function of the tile —
   * or `null` when the press writes nothing and is therefore a pan.
   *
   * Returned as a closure rather than performed, because *when* and *how often*
   * it runs is the gesture's business: a mouse runs it on contact and again on
   * every tile it drags over, a finger runs it on the lift or, after a hold, on
   * every tile too. Every branch that can change the board is in here, which is
   * what keeps the enclosing `beginStroke` a guarantee by construction rather
   * than a list to keep up to date.
   */
  function plannedAction(button: number): TileAction | null {
    // The right button erases whatever the left button would have done.
    if (button === 2) return eraseAt;
    // The middle button is `ViewportControls`' own pan, and no other writes.
    if (button !== 0) return null;

    if (editorState.restoreMode) {
      // Puts a cleared obstacle back; refuses any other tile, so a tap on bare
      // ground in restore mode simply does nothing.
      return (x, y) => layoutState.restoreObstacle(x, y);
    }

    // Same action the right button performs, reachable by tap.
    if (editorState.eraseMode) return eraseAt;

    if (editorState.activeTool !== null) {
      return (x, y) => editorState.paintTile(x, y);
    }

    if (editorState.selectedBuildingId !== null) return placeAt;

    return null;
  }

  /** Puts the held building on a tile, if the tile is island land. */
  function placeAt(x: number, y: number): boolean {
    const tile = layoutState.grid[y]?.[x];
    if (!tile || tile.type === "water") return false;

    const bldId = editorState.selectedBuildingId;
    if (bldId === null) return false;

    // Building by hand means the user's board is the one being worked on, so
    // the canvas switches to it. The solve is *kept* — it took minutes to
    // produce, and the toggle switches back.
    uiState.setPlacementView("user");

    layoutState.removePlacement(x, y);
    layoutState.addPlacement(
      createPlacement(bldId, x, y, configState.buildingUpgrades),
    );
    return true;
  }

  /**
   * The hold has elapsed with the finger still on the tile it landed on: the
   * press is an edit, not a pan.
   *
   * This is the one moment worth confirming by touch. It is the only thing
   * that tells the user which of the two the gesture became, and unlike a tap
   * it happens with the finger still down, where a buzz reads as the board
   * taking hold rather than as an after-the-fact report.
   */
  function lockEdit() {
    holdTimer = null;
    const edit = pendingEdit;
    pendingEdit = null;
    if (!edit) return;

    dragAction = edit.run;
    // The finger is a brush now, so the drag it started is given up — and its
    // velocity with it, or the release would fling the board being painted on.
    viewportControls?.cancelPan();
    // Once, at the lock: whether *this* tile happens to write is beside the
    // point, since the answer being confirmed is "you are editing now".
    if (uiState.haptics) hapticTap();
    commitAction(edit.run, edit.tileX, edit.tileY, false);
  }

  /**
   * Gives a touch press the write it armed, if the finger came up where it
   * went down and before the hold locked it into a drag. A drag was a pan, and
   * a pan is not an edit.
   *
   * The stroke this lands in was opened by the `pointerdown` that armed it and
   * is closed by the caller, so a deferred edit is one undo entry like any
   * other.
   */
  function runPendingEdit(e: PointerEvent) {
    const edit = pendingEdit;
    pendingEdit = null;
    if (!edit) return;
    if (
      Math.hypot(e.clientX - edit.downX, e.clientY - edit.downY) > TAP_SLOP_PX
    ) {
      return;
    }
    commitAction(edit.run, edit.tileX, edit.tileY, true);
  }

  function buildGridDisplay() {
    if (!gridContainer || !isAtlasLoaded || !gridRenderer) return;

    gridRenderer.buildGrid(
      layoutState.grid,
      layoutState.width,
      layoutState.height,
      {
        onPointerDown: (x, y, e) => {
          viewportControls?.notifyTileClick();
          // Read and cleared by the wrapper's `pointerdown`, which runs next.
          pressHitTile = true;

          const native = e.nativeEvent as PointerEvent;

          /*
           * Another pointer is already down, so this press is part of a pinch
           * rather than an edit — asked by id rather than as a count, because
           * this handler runs before the press it is handling is registered.
           * See `ViewportControls.hasOtherPointer`.
           */
          if (viewportControls?.hasOtherPointer(native.pointerId)) return;

          /*
           * Two boards are read-only, and the canvas drops to pan-and-inspect on
           * both: a drag still moves the view and a tap still pins the tile
           * card, but nothing can be placed, erased or restored.
           *
           * One is a board arriving from someone else's link. The other is **the
           * solver's own layout**. A tap that placed a building there would have
           * to switch you to your own board to do it — a press aimed at one
           * layout landing on a different one, with the board under your finger
           * replaced in the same frame. The solve is a result, not a canvas;
           * `copySolveToBoard` is how you get an editable version of it.
           *
           * The HUD's tools are not rendered in either case, so no mode should
           * be live here — this is the backstop for one held over from before.
           */
          const readOnly = layoutState.isPreview || uiState.showingSolver;

          /*
           * One gesture is one undo. Opened here rather than at each writing
           * branch so that every way a press can change the board is covered by
           * construction — a drag that paints twelve tiles, a tap that replaces
           * a building (a remove *and* an add), a right-click erase. A stroke
           * that writes nothing records nothing, so opening it on a pan is free,
           * and it is still open when a deferred edit runs on the lift.
           */
          if (!readOnly) layoutState.beginStroke();

          const action = readOnly ? null : plannedAction(e.button);

          if (!action) {
            // A press that writes nothing is a pan, and on a coarse pointer
            // the tile it landed on is what a tap will pin.
            if (e.button === 0) beginPanOrPin(x, y, native);
            return;
          }

          if (writesOnLift(native)) {
            pendingEdit = {
              run: action,
              tileX: x,
              tileY: y,
              downX: native.clientX,
              downY: native.clientY,
            };
            // The press pans until it is known to be an edit — `false` because
            // a press that may write must not also arm the double-tap zoom.
            viewportControls?.startPan(native, false);
            holdTimer = setTimeout(lockEdit, HOLD_TO_EDIT_MS);
            return;
          }

          dragAction = action;
          commitAction(action, x, y, true);
        },
        onPointerOver: (x, y) => {
          activeHoverKey = `${x},${y}`;
          gridRenderer?.setHover(x, y);

          const tile = layoutState.grid[y]?.[x];
          // Only meaningful with a real hover; touch uses `pinnedTile` instead.
          if (!viewportState.isCoarse) {
            uiState.hoveredTile = tile ? { x, y, type: tile.type } : null;
          }

          if (!dragAction) return;
          // A pinch is not a drag-paint.
          if ((viewportControls?.getActivePointerCount() ?? 1) > 1) return;

          commitAction(dragAction, x, y, false);

          // The hover card follows what actually landed rather than what was
          // asked for — the two differ on a tile the action refused.
          const after = layoutState.grid[y]?.[x];
          if (uiState.hoveredTile && after) {
            uiState.hoveredTile.type = after.type;
          }
        },
        onPointerOut: (x, y) => {
          if (activeHoverKey === `${x},${y}`) {
            activeHoverKey = null;
            gridRenderer?.setHover(null, null);
            uiState.hoveredTile = null;
          }
        },
      },
    );
  }

  /**
   * Removes whatever is on a tile: a hand-placed building first, otherwise the
   * obstacle underneath. Shared by right-click and the HUD's erase mode.
   */
  function eraseAt(x: number, y: number): boolean {
    const existingPlacement = layoutState.placements.find(
      (p) => p.x === x && p.y === y,
    );
    if (existingPlacement) {
      layoutState.removePlacement(x, y);
      return true;
    }
    return editorState.eraseTile(x, y);
  }

  function handlePointerUp(e: PointerEvent) {
    // First: the stroke it writes into is the one `endStroke` closes below.
    runPendingEdit(e);

    clearHold();
    dragAction = null;
    layoutState.endStroke();

    if (pendingDismiss) {
      const moved = Math.hypot(
        e.clientX - pendingDismiss.x,
        e.clientY - pendingDismiss.y,
      );
      // Same rule the pin follows, for the same reason: a drag was a pan.
      if (moved <= TAP_SLOP_PX) uiState.closeInspector();
      pendingDismiss = null;
    }

    if (pendingPin || viewportState.isCoarse) {
      const moved = Math.hypot(
        e.clientX - pinDownPos.x,
        e.clientY - pinDownPos.y,
      );
      // A drag was a pan, not an inspect.
      if (pendingPin && moved <= TAP_SLOP_PX) uiState.pinTile(pendingPin);
      pendingPin = null;
    }
  }

  onMount(() => {
    let atlasFailed = false;
    (async () => {
      /*
       * Started before the renderer rather than after it, so the atlas fetch
       * and WebGL context creation overlap. `main.ts` has normally started this
       * already and this is then a free await on the same memoised load — but
       * this component must not depend on that, or mounting it on its own puts
       * the largest download back at the end of the chain.
       */
      const atlasReady = loadAtlas();

      app = new Application();
      await app.init({
        resizeTo: canvasWrapper,
        backgroundColor: CANVAS_CLEAR,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });

      canvasWrapper.appendChild(app.canvas);

      gridContainer = new Container();
      app.stage.addChild(gridContainer);

      gridRenderer = new GridRenderer(gridContainer);
      viewportControls = new ViewportControls({
        canvasWrapper,
        gridContainer,
        getAppWidth: () => app.screen.width,
        getAppHeight: () => app.screen.height,
      });
      viewportControls.attach();

      try {
        await atlasReady;
      } catch (err) {
        atlasFailed = true;
        throw err;
      }
      isAtlasLoaded = true;

      buildGridDisplay();
      recenterGrid();

      /*
       * The board is up, so the splash that has been standing in for it since
       * the first frame comes down. `index.html` explains why it is markup in
       * the document rather than a component.
       */
      dismissBootLoader();

      /*
       * Drives the pulse on buildings that are idle or overheating. The
       * renderer owns *what* breathes and how; the app owns the clock, so the
       * animation runs on the same ticker Pixi is already drawing with rather
       * than a second `requestAnimationFrame` loop of its own.
       *
       * `lastTime` is the ticker's own elapsed ms, which is what keeps every
       * failing building on the board dipping in step.
       */
      app.ticker.add(() => {
        gridRenderer?.tick(app.ticker.lastTime);
        /*
         * And the board's own motion — the glide after a flick, the return
         * from an overscroll, the double-tap zoom. Same argument as above: one
         * clock, the one Pixi is already running.
         *
         * `deltaMS` rather than `lastTime` because these integrate a velocity
         * and a decay, so what they need is the length of the frame rather
         * than the time on it.
         */
        viewportControls?.tick(app.ticker.deltaMS);
      });

      window.addEventListener("resize", recenterGrid);
    })().catch((err) => {
      /*
       * An atlas that never arrives leaves the board empty, which is bad — but
       * leaving the splash up over it is worse: it is opaque and covers the
       * whole window, so the app would look hung rather than broken. The
       * dismissal is unconditional for that reason.
       */
      console.error("Canvas failed to start", err);
      // The symptom is the same either way — an empty board — so one event
      // covers both, with `stage` saying which half gave out.
      trackEvent("board_failed", {
        stage: atlasFailed ? "atlas" : "canvas",
        reason: String(err?.message ?? err).slice(0, 100),
      });
      dismissBootLoader();
    });
  });

  onDestroy(() => {
    clearHold();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", recenterGrid);
    }
    viewportControls?.detach();
    gridRenderer?.destroy();
    if (app) {
      app.destroy(true, { children: true });
    }
  });

  /*
   * Last drawn dimensions, so the render effect can tell a resize (rebuild the
   * whole display) from a repaint (update in place).
   *
   * Plain `let`, like `wasOptimizing` and `framed` below, and for the same
   * reason: the effect both reads and writes these, so as `$state` each resize
   * invalidated the effect that had just written them and cost a second pass
   * that could only conclude nothing had changed.
   */
  let prevWidth = layoutState.width;
  let prevHeight = layoutState.height;

  /*
   * Starting a solve is a request to look at what the solver comes up with, so
   * the canvas switches to its board for the duration and stays there when it
   * lands. Placing a building by hand switches back (see `onPointerDown`).
   *
   * Tracked as a plain edge rather than a `$state`, so the effect reacts to the
   * run starting and never to its own write.
   */
  let wasOptimizing = false;

  $effect(() => {
    const running = solverState.isOptimizing;
    if (running && !wasOptimizing) uiState.setPlacementView("solver");
    wasOptimizing = running;
  });

  /*
   * Pushes the animation preference into the renderer, which does not read it
   * itself: the effective answer is the user's Settings choice *or* the
   * system's reduced-motion query when they have made none, and choosing
   * between those is `uiState`'s job.
   *
   * An effect rather than a one-time call because both halves are live — the
   * toggle in Settings and the OS setting behind it — so a board already on
   * screen has to settle or start breathing without being rebuilt.
   */
  $effect(() => {
    // Read first, so this stays a dependency on the path that returns early.
    const on = uiState.animations;
    // `gridRenderer` is a plain `let`, so assigning it does not re-run this.
    // `isAtlasLoaded` is the `$state` that flips right after it is built —
    // the same handle the render effect below uses to wait for it.
    if (!isAtlasLoaded) return;
    gridRenderer?.setAnimated(on);
    // The same answer governs the board's own motion. With it off the glide,
    // the bounce and the double-tap zoom all still land where they were going,
    // they just do not travel there.
    viewportControls?.setAnimated(on);
  });

  /*
   * One re-frame once the chrome has measured itself.
   *
   * The insets `recenterGrid` reads are published by effects in `Header`,
   * `HudToolbar` and `ConfigSidebar`, which need not have run by the time the
   * atlas finishes loading and the board is first drawn — so without this the
   * opening frame is fitted to insets of zero.
   *
   * Once, and no more. Re-framing whenever the HUD grows a palette row would
   * yank the board out from under a player mid-tap; after this, changing the
   * framing is Center View's job and nobody else's.
   */
  let framed = false;

  $effect(() => {
    const ready = uiState.headerBottom > 0 && uiState.hudHeight > 0;
    if (framed || !ready || !isAtlasLoaded) return;
    framed = true;
    recenterGrid();
  });

  /*
   * Folding the docked panel hands 380px back to the board, so the board takes
   * it — and the HUD row already tracks the same edge, so without this the two
   * would disagree by that much the moment the panel moved.
   *
   * Only while the framing is still the app's, though: `isUserAdjusted` goes
   * true the first time anyone pans or zooms, and after that nothing but
   * Center View is allowed to move the view. Re-framing someone's chosen view
   * because a side panel folded is the app overruling a deliberate act.
   */
  $effect(() => {
    const sidebar = uiState.sidebarWidth;
    // Hiding the interface hands back the whole window, which is the same
    // event as folding the panel and answered the same way — and coming back
    // gives the chrome its room again, so both edges re-frame.
    const hidden = uiState.uiHidden;
    if (!framed || !isAtlasLoaded) return;
    if (viewportControls?.isUserAdjusted) return;
    void sidebar;
    void hidden;
    recenterGrid();
  });

  $effect(() => {
    const curW = layoutState.width;
    const curH = layoutState.height;
    const currentGrid = layoutState.grid;

    // Which of the two boards is on screen is `uiState`'s call, and the
    // inspector reads the same getter — so the card can never describe a
    // building that is not the one being drawn.
    const activePlacements = uiState.visiblePlacements;

    // Ghosts only while restore mode is on — see `editorState.restoreMode`.
    const ghosts = editorState.restoreMode
      ? layoutState.restorableObstacles
      : [];

    if (app && isAtlasLoaded && gridRenderer) {
      // A change of dimensions needs the whole display rebuilt; anything else
      // is a repaint of the nodes already there.
      if (curW !== prevWidth || curH !== prevHeight) {
        prevWidth = curW;
        prevHeight = curH;
        buildGridDisplay();
        recenterGrid();
      }
      /*
       * Unconditionally, and that matters: `buildGrid` only lays out empty
       * per-tile nodes and clears the state cache — `updateState` is the thing
       * that actually draws terrain, buildings and status pads into them.
       *
       * Inside an `else` a rebuilt board would be painted only if
       * `prevWidth`/`prevHeight` were `$state`: writing them above invalidates
       * the very effect doing the writing, which re-enters and falls down the
       * other branch, leaving the board blank for one pass and making
       * correctness depend on an accidental re-run. Both edges are plain
       * variables and the paint is spelled out.
       */
      gridRenderer.updateState(currentGrid, curW, curH, activePlacements);
      gridRenderer.setGhosts(ghosts);
    }
  });
</script>

<div
  class="canvas-wrapper"
  bind:this={canvasWrapper}
  onpointerdown={(e) => {
    const hitTile = pressHitTile;
    pressHitTile = false;

    if (e.isPrimary) {
      /*
       * A press that hit no tile is a candidate to dismiss the pinned card —
       * but only when there is one, so on a board with nothing pinned this
       * arms nothing and the double-tap zoom on the empty green is untouched.
       */
      pendingDismiss =
        !hitTile && uiState.pinnedTile ? { x: e.clientX, y: e.clientY } : null;
      return;
    }

    /*
     * A second finger means the gesture was a pinch, so whatever the first one
     * just wrote was never an edit. `isPrimary` is what identifies it — false
     * only while another pointer of the same type is already down — which
     * keeps this independent of the order the listeners on this element
     * happen to have been registered in.
     *
     * A pinch is not a tap either, so it disarms the dismissal above: two
     * fingers that land on the green and pinch the board by a hair would
     * otherwise come up inside the slop and take the card with them.
     *
     * `cancelStroke` leaves no undo entry: the write is erased rather than
     * reversed, because the user never asked for it in the first place.
     */
    pendingDismiss = null;

    /*
     * A touch press has written nothing yet, so a pinch simply drops what it
     * had armed — no board change, no haptic, nothing to take back. That is
     * the whole of what keeps a pinch from buzzing, placing a building and
     * *then* zooming.
     */
    pendingEdit = null;
    pendingPin = null;
    clearHold();
    // A hold that had already locked stops painting here; the tiles it wrote
    // stand, being older than the grace window below by construction.
    dragAction = null;

    /*
     * The grace window below still covers the one press this cannot: a pen or
     * a mouse writes on contact, and on a hybrid machine a touch can arrive
     * beside it.
     */
    if (performance.now() - lastWriteAt > PINCH_GRACE_MS) return;
    layoutState.cancelStroke();
  }}
  onpointermove={(e) => {
    /*
     * The finger has travelled before the hold could claim it, so the gesture
     * is a pan and the write it armed is dropped — along with the hold, which
     * would otherwise fire mid-drag and start painting a board in motion.
     *
     * Dropped here rather than on the lift: checking only at lift time would
     * let a drag that wandered off and came back land an edit on a tile the
     * board has since moved out from under.
     */
    if (!pendingEdit) return;
    const moved = Math.hypot(
      e.clientX - pendingEdit.downX,
      e.clientY - pendingEdit.downY,
    );
    if (moved > TAP_SLOP_PX) {
      pendingEdit = null;
      clearHold();
    }
  }}
  onpointerup={handlePointerUp}
  onpointercancel={() => {
    clearHold();
    dragAction = null;
    layoutState.endStroke();
    pendingEdit = null;
    pendingPin = null;
    pendingDismiss = null;
    pressHitTile = false;
  }}
  oncontextmenu={(e) => e.preventDefault()}
  role="region"
  aria-label="2.5D Isometric Grid View"
></div>

<style>
  .canvas-wrapper {
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
    background: var(--canvas-clear);
    touch-action: none;
    overflow: hidden;
  }
</style>
