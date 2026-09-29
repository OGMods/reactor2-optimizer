# CLAUDE.md — rendering, gestures and framing

Loaded when working under `src/lib/pixi/`. Also read this before editing
`components/canvas/PixiCanvas.svelte`.

## Rendering (`components/canvas/PixiCanvas.svelte`, `pixi/gridPainter.ts`)

Grid rendering uses PixiJS (not DOM/CSS) via `GridRenderer`, built once an atlas
is loaded (`pixi/atlas.ts` loads `public/data/web_atlas.json`/`.webp`, packed by
an external script not in this repo; the atlas itself is committed). Isometric
projection math is in `utils/isoMath.ts`; pan/zoom/multi-touch is isolated in
`pixi/viewportControls.ts`.

**Every raster on the path to the first frame is lossless WebP** — the sheet, the
building icons, `hex.webp` and `logo.webp`. The sheet is the single largest
download, so its size is most of the cold start (1540KB as PNG against 1017KB
here; icons 382KB → 296KB). Lossless rather than lossy, which would have been far
smaller (471KB), because this is a sprite sheet packed with **2px of padding**:
lossy WebP smears colour across an alpha edge and at that padding the smear from
one frame lands inside the next, compositing as a halo on an unrelated sprite.
Lossless is pixel-exact on every visible pixel.

`meta.image` in the atlas JSON names the sheet, so `atlas.ts` follows it rather
than knowing the extension; the hard-coded name beside it is only a fallback.
**Icon URLs are the other half, and no data file carries them**: they are built as
`icons/<building id>.webp` at four call sites, so a roster re-exported in another
format means editing those four by hand.

**Three rasters stay PNG**, each because something refused the format ahead of it:
the favicon fallback and the apple-touch icon (Safari has never taken a WebP
favicon; iOS takes only PNG for Add to Home Screen), and the board's image export
(PNG is what every viewer and chat client takes without question). None is on the
path to the first frame.

**The status pads come from the atlas, all four of them.** `FRAME_KEYS` in
`atlas.ts` names `indicator_grid` / `indicator_normal` / `indicator_overheat` /
`indicator_idle`, and `STATUS_FRAME` in `gridPainter.ts` maps a
`PlacementStatus` onto the last three.

**A building that is not working breathes.** The pad says _what_ is wrong in
colour; the pulse says _that_ something is, and motion is what the eye finds
without being told where to look. `STATUS_PULSE` and the raised-cosine
`pulseAlpha` live in `pixi/statusPulse.ts`, split out so `statusPulse.test.ts` can
pin them without dragging PixiJS into a test. Four things are load-bearing:

- **`active` is absent from the table, not mapped to a no-op.** A board where
  everything works is _completely_ still, which is what makes movement mean
  something — and it keeps the ticker free, since the registry is empty.
- **Overheating pulses faster and deeper than idle** (900ms to 0.35 alpha, against
  2200ms to 0.55) — the same ranking the colours carry.
- **The curve starts at 1 and falls**, so a building that has just appeared fades
  in from full opacity rather than blinking on at its dimmest, which reads as a
  glitch. Every sprite is given the _same_ elapsed time rather than its own phase,
  so the board dips in step; staggered phases read as decoration.
- **The registry is keyed by tile and cleared in `renderTileVisuals`.** That
  method destroys and rebuilds a tile's sprites, so an entry left behind is a
  `tick` writing alpha into a destroyed sprite.

The clock is the app's own Pixi ticker, wired in `PixiCanvas` — Pixi is already
drawing every frame, so a second `requestAnimationFrame` loop would buy nothing.

**The renderer does not decide whether to animate; it is told.** `GridRenderer`
has `setAnimated(on)` and no media query of its own, because the effective answer
is the user's Settings choice _or_ `prefers-reduced-motion` when they have made
none, and picking between those is the state layer's job. An `$effect` in
`PixiCanvas` pushes it — an effect rather than a one-time call, because both
halves are live and a board already on screen has to settle or start breathing
without being rebuilt. That effect gates on `isAtlasLoaded` rather than on
`gridRenderer`: the renderer is a plain `let`, so assigning it re-runs nothing.

Two details of "off" are load-bearing: failing sprites **stay in the registry**
and are held at the floor of the breath they would otherwise take (no movement,
but the state is still visible, and they can start again without rebuilding the
board), and `setAnimated(false)` **settles them explicitly** rather than freezing
them wherever the last frame left them — mid-breath is an arbitrary opacity that
says nothing, the floor is the animation's resting point.

## Canvas gestures (`pixi/viewportControls.ts`)

`ViewportControls` owns pan, pinch, wheel, the glide after a flick, the bounce at
the edges and the double-tap zoom. It imports **only** the `Container` type from
PixiJS, which is what lets `viewportControls.test.ts` drive it through hand-rolled
stand-ins, firing at the listeners `attach()` registered exactly as a browser
does. Keep it that way.

**Two clocks feed it, and neither is its own.** `PixiCanvas` drives `tick()` from
the app's Pixi ticker in the same callback as the status pulse, and pushes
`uiState.animations` in through `setAnimated`. With animation off the glide, the
bounce and the double-tap all still reach the same place; they just do not travel
there.

**A board at rest costs the ticker nothing.** `tick()` returns immediately unless
something is in flight, and whether the board owes a bounce is a tracked flag
(`outOfBounds`) rather than a test — the test would mean reading
`getLocalBounds()` sixty times a second, which is cached in Pixi v8 but still
walks every tile node to find out whether the cache holds. Only a resisted gesture
and a glide can put the board out of range, and both set the flag.

Eight rules are invisible until they are wrong. Each is pinned by a test in
`viewportControls.test.ts` — read the test before changing the behaviour:

- **A pinch that ends with one finger down re-anchors on it** (`syncPinchAnchors`
  does the same when a third finger lands or leaves), or the next move resolves
  against a stale origin and the board snaps back by everything the pinch did.
- **A pinch anchors on the world point under the _previous_ midpoint.** The
  current one cancels algebraically, so the board zooms without panning.
- **`pointerdown` takes `setPointerCapture` on the wrapper**, or a drag onto the
  floating chrome leaks a pointer into `activePointers` forever and the next
  touch reads as half a pinch. It is also what makes `endStroke()` land on a
  gesture that finishes off-canvas.
- **Both zoom limits are relative to the fit, not flat** — `MIN_ZOOM_FACTOR` of
  the framed scale as the floor, `Math.max` against the fit as the ceiling, so a
  three-tile island can still reach its own framing.
- **Overscroll resists rather than stopping dead** (`setPositionResisted`,
  `settle`), applied to an absolute position rather than an increment so the
  damping is re-derived each frame rather than compounded.
- **The double-tap is armed in `startPan`, not `pointerdown`** (`armDoubleTap:
false` on a writing press), and commits on the second tap's _up_.
- **`hasOtherPointer(id)` must be asked by id.** Pixi's handler runs a bubble
  earlier, so a count reads the state before this finger landed, and the second
  finger of a pinch places a building.
- **A vertical-only wheel still zooms**, this board's existing convention; a
  `ctrlKey` or a `deltaX` pans instead, and `deltaMode` is normalised through
  `WHEEL_LINE_PX` (Firefox reports lines, ~3 against Chrome's ~100).

### A finger writes on lift, or after a hold; a mouse writes on contact

**On a touch screen one finger is the only way to move the board**, so a press
that writes on contact takes panning away for as long as a tool is held — which on
a phone is most of the time. Dragging with a building selected laid a row of
buildings instead of moving the map, and a pinch buzzed, placed something and
_then_ zoomed.

`plannedAction(button)` is the shape of the fix: it returns the write a press
performs as **a function of the tile** (`TileAction`, `true` if it wrote), or
`null` when the press writes nothing and is therefore a pan. _When_ and _how
often_ that runs is the gesture's business, and there are three answers:

- **A tap writes on the lift.** A touch press arms the action (`pendingEdit`) and
  starts a pan; the write lands if the finger comes up within `TAP_SLOP_PX` of
  where it went down, and is dropped the moment the gesture turns out to be
  something else — past the slop, a second finger, a `pointercancel`.
- **A hold turns the finger into a brush.** `HOLD_TO_EDIT_MS` (350ms) of stillness
  calls `lockEdit`, which takes the pan back (`cancelPan`) and hangs the action on
  `dragAction`, so every tile the drag crosses is written. Deferring to the lift
  alone would have cost the drag — a painted row became a tap each — and a hold is
  the standard way to say "no, I meant this one". It costs the pan nothing,
  because a pan begins by _moving_.
- **A mouse or a pen runs it on contact**, and drags from there. Those pointers
  have a middle-button drag and a wheel to navigate with, and cannot pinch.

**The haptic marks the decision, not the tile.** It fires on the tap that placed
something, and once at the lock — the moment the press stops being a pan is the
only thing that tells the user which of the two it became, and with the finger
still down a buzz reads as the board taking hold rather than as an after-the-fact
report. The drag that follows writes in silence: a buzz per tile across a painted
row is a rattle, and says nothing the first has not.

Two consequences. `TileAction` is what lets a press capture _its own_ action
rather than the hover handler re-deciding — a right-button erase-drag would
otherwise come back as whatever the left button paints. And because a touch press
has written nothing when a second finger lands, the pinch case needs no undo at
all: dropping `pendingEdit` is the whole of it.

**The grace window survives for the press this cannot cover.** A pen or a mouse
writes on contact, and on a hybrid machine a touch can arrive beside one — so
`PixiCanvas`'s wrapper-level `pointerdown` still calls `layoutState.cancelStroke()`
if a second finger lands within `PINCH_GRACE_MS`. `cancelStroke` restores the
board as it stood when the stroke opened and leaves **no entry in either stack**,
which is the whole difference from `undo()`: undo is a move the user made and Redo
can reach back through it, this is the removal of a write they never asked for. It
restores the Redo branch `#record` cleared, too. The second finger is identified
by `isPrimary`, so the rule does not depend on listener registration order.

**The stroke is still opened at `pointerdown`**, on every non-read-only press, and
both a deferred edit and a held drag write into the one their own press opened —
so one gesture is one undo entry whichever pointer made it and however many tiles
it crossed. That is also why `plannedAction` holds _every_ branch that can change
the board: it keeps the enclosing `beginStroke` a guarantee by construction rather
than a list to keep up to date.

**A tap on the green beside the board dismisses the pinned card.** A pin outlives
the tap that made it, so without this the only ways to be rid of one are to tap the
same tile again — on a board that has probably since been panned away — or to open
the sheet. Three rules keep it from firing on gestures that are not that tap, and
all three live on `pendingDismiss` being a _position_ rather than a boolean: it is
committed on the lift within `TAP_SLOP_PX` (the empty green is _the_ place to grab
the board and pan it); a second finger disarms it; and it arms only when there is a
card, so on a board with nothing pinned this is inert and the double-tap zoom on
the empty green is untouched.

Whether the press hit a tile is `pressHitTile`, written by the tile handler and
read by the wrapper's own `pointerdown`. Pixi dispatches from a listener on the
canvas — a _child_ of the wrapper — so the tile handler has always run by then.
That ordering is bubbling rather than registration order, which is what makes it
safe to depend on; `ViewportControls` keeps its own `handledByTile` for the same
question because it asks from a wrapper listener, where the order against this
component's would be a coin toss.

## The board is framed in what the chrome leaves free

`ViewportControls.recenter()` takes an `inset` — the header along the top, the HUD
along the bottom, the docked sidebar down the left — and both fits _and_ centres
the board inside the band those leave. The canvas is full-bleed and everything
else floats over it, so without the inset the board was sized against, and centred
in, the whole window.

The margin is `0.92` of the **band**, not of the window. It can be that tight
because the room it leaves is real room, rather than room the HUD was already
standing in.

Four things about this are easy to get wrong:

- **All three insets are measured** by the components that own them (see project
  conventions). The header's edge is `uiState.headerBottom`; before it was
  measured, everything under it used a hard-coded `4.5rem`, which overlapped the
  bar on desktop — and `--z-sheet` outranks `--z-header`, so the sidebar drew
  over it.
- **`PixiCanvas` re-frames once at startup**, when those measurements first land,
  because the effects publishing them need not have run before the atlas finishes
  loading. It does _not_ re-frame when the HUD grows a palette row — that would
  yank the board out from under a player mid-tap.
- **It does re-frame when the docked panel folds**, because folding hands 380px
  back and the HUD row tracks the same edge. But only while the framing is still
  the app's: `isUserAdjusted` goes true the first time anyone pans or zooms, and
  after that nothing but Center View may move the view. Re-framing someone's
  chosen view because a side panel folded is the app overruling a deliberate act.
  `recenter()` clears the flag, which is what hands control back.
- **`recenter` ignores an inset that would leave less than 40% of the axis.** A
  board framed inside a sliver is worse than one framed in the whole window, and a
  phone in landscape with a ribbon open can leave very little.

**The readout is an inset only when it is a band.** On a phone it goes full-bleed
under the header, so it is chrome over the board: excluded from the inset,
Center View frames the board _behind_ it. On a wide screen the same card is 250px
in the top-right corner, where the board may happily run underneath it.

Three things about how it is read:

- **Which of the two it is, is measured, not looked up.** `PixiCanvas.readoutInset`
  compares its rect to the document width rather than repeating the `640px`
  breakpoint that decides it in `App.svelte`'s CSS. A second copy of that number in
  a second language is a thing to get wrong later.
- **It is read from the DOM at the moment of framing**, not published as a
  measurement — hence `uiState.statsRef` being an element and not a number. The
  card changes height as the board does (a solve lands, a row appears, the user
  folds it), so as `$state` every framing effect would depend on it and the board
  would jump each time the card grew a line. `recenterGrid` reads all four insets
  inside `untrack` for the same reason.
- **A readout past `MAX_READOUT_INSET` of the viewport is ignored.** `recenter`'s
  own `MIN_BAND` guard is against the total; this one is against the readout alone,
  because on a short landscape phone an unfolded card can be most of the screen.
