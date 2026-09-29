# CLAUDE.md — the HUD

Loaded when working under `src/lib/components/hud/`.

## One CSS caveat in `hud/`

**One CSS caveat in `hud/`.** The `.tool-btn` / `.toolbar-divider` /
`.mode-icon` / `.tool-label` base rules live in `HudToolbar.svelte` as
`:global(...)`, because `TerrainPalette` renders buttons into the same row and
Svelte's scoped CSS does not cross a component boundary. They are deliberately
left at single-class specificity so per-tool modifiers (`.grass-btn.active`, …)
still outrank them. Raise that specificity and active states silently lose the
cascade.

## The HUD and the panels

### Run lives in the HUD, not in the config panel

`hud/BoardActions.svelte` carries Undo, Redo and Run/Stop, and it is the only Run
button in the app. It cannot live in the config panel, because a `pointerdown`
anywhere in the HUD **dismisses that panel** — which would make the loop the app
exists for, paint then run, cost two extra taps every time round, and on a phone
would put Run behind a closed sheet.

What stays in the panel is `SolveModeSelector`: how long a run may take is a
setting chosen rarely and belongs beside the roster; starting the run is not a
setting.

**`BoardActions` stops `pointerdown` from bubbling**, so pressing Run does not
dismiss the panel. Not a matter of taste: at the sheet's `peek` detent the HUD is
lifted above the sheet, so dismissing it drops the row by 176px between
`pointerdown` and `pointerup` — the button slides out from under the finger and
the click never lands.

### The HUD dismisses the config panel

A `pointerdown` anywhere in the HUD stack closes the mobile sheet and folds the
docked sidebar (`uiState.collapseSidebar()`, idempotent so repeated calls do not
churn storage). Reaching for a tool means the user is done with the panel. Both
presentations need it for the same reason — the panel is sitting on top of the
thing being used. On a phone the sheet at `peek` holds the bottom
`sheetPeekHeight`; on a wide screen the sidebar is 380px pinned left while the HUD
centres across the full width, so below roughly 1200px they overlap and
`--z-sheet` outranks `--z-hud`.

**The sheet starts `closed`.** With Run in the HUD, peek would buy a strip of
_setup_ — none of which is the first move, and all of which costs the map about
150px.

**And the HUD stands down for as long as the sheet is open** — `App.svelte`
unmounts the whole stack while `sheetDetent !== "closed"` on a compact viewport.
They are both bottom-anchored, so otherwise both sit on screen at once: two
stacked bands of chrome over the board at the one moment neither is in use.

Three things follow: `sheetLift` is gone (`.hud` is simply `bottom: 0`);
`hudHeight` is **cleared when the stack unmounts** (the `$effect` returns a
teardown), since a stale inset reserves room for a bar that is not there; and
Escape and the scrim close outright rather than back to `peek`, which would leave
a sliver of Setup with every tool gone — dismissed, but not back to the board.

### The HUD's category buttons are toggles

Pressing the open one closes its ribbon (`activeBuildingCategory` is nullable),
which is what every other mode button in the stack already does
(`editorState.selectTool`, `selectBuilding`).
The ribbon is ~62px of chrome over a board the player is trying to see, and Back
is not an answer because it leaves buildings mode altogether. Closing **puts the
brush down too**: a building selected from a palette that is not on screen is a
hand nothing shows you are holding, and a tap would still place it.

### The solver's board is a result, not a canvas

`uiState.showingSolver` makes the board read-only, and the difference is not
cosmetic — a tap must never place a building and silently switch you to your own
board to do it, so `PixiCanvas` drops to pan-and-inspect there.

Everything that edits goes with it: `HudToolbar` renders no palettes and no tool
row, which takes the HUD from 180px to 118px. An `$effect` there also calls
`editorState.clearHand()`, because a brush held from a moment earlier would be
invisible _and_ still selected, with `PixiCanvas` refusing its taps for reasons
nothing on screen explains. **Undo and Redo are absent** too — they act on the
board the _user_ builds, so on the solver's an undo would land silently on the
other board while the press read as broken. Gone rather than greyed, because this
is a mode rather than a momentarily empty history.

**The way off that board is `uiState.copySolveToBoard()`**, offered as a Copy
button in the readout's head. A solve is as often a starting point as an answer —
a player wants what the search found, with one cooler moved, without rebuilding
forty buildings by hand. Three things about it: it
copies the layout **on screen**, not the applied one (`visiblePlacements` follows
the previewed variant); it is **one undo entry** (`adoptPlacements` records before
writing), which is what lets it overwrite an existing board without being a
one-way door, and it deep-copies so the two boards go on existing side by side;
and it **only asks twice when there is something to lose** — making the common
first use a two-press ceremony teaches people to double-tap without reading, the
habit that makes a confirmation useless on the day it matters.

**The toggle's left half says `Edit`, not `Yours`.** Ownership is the wrong axis
when the other half is read-only: both layouts are the player's, and the
difference that matters is that only one can be built on. It is **right-aligned,
not centred**, sharing an edge with the action pill so the two read as one stack
of board controls rather than three pills in a triangle.

**The way back into Setup is a sibling of Run, not a pill above it** — two
bottom-right pills on two lines read as one control that has grown a second head.
It is a button inside the action row, with `margin-right: auto` pushing Run to
the far end — Run takes the right, being the primary action and the easier
thumb reach. The view toggle cannot join them: Setup + toggle + actions is 425px
of pills in 374px of phone, so on a compact viewport it takes its own centred line
above (the paired `{#if viewportState.isCompact}` blocks).

**On a wide screen the collapse handle names itself.** Collapsed, it is a 28px
chevron against the left edge with nothing to say what is behind it, so it carries
a vertical `SETUP`; expanded, it drops back to a plain chevron. The collapsed
transform is `translateX(calc(-100% - var(--safe-left) - 0.75rem))`, matching the
panel's own `left` exactly so its right edge lands on 0.

One more thing about that row on a phone: it is full-bleed and centres its tools
with `justify-content: safe center` rather than packing them left, because on a
shipped island the terrain brushes are not rendered and the row can be as few as
three buttons. The `safe` keyword is what makes centring usable instead of a trap
— when the row _does_ overflow, plain `center` spills it equally off both ends and
the first tool becomes unreachable, since a scroll container cannot scroll back
past its start edge. `safe center` falls back to `flex-start` in exactly that
case, and a browser too old to parse it drops the declaration and gets the old
left-packed behaviour.

One listener on the container covers every control inside it, because events from
descendants still bubble through an element with `pointer-events: none` — that
property only stops the element being a hit target itself, which is what keeps
canvas drags working through the HUD's empty margins.
