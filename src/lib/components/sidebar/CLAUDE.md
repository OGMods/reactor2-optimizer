# CLAUDE.md — Setup (the config panel)

Loaded when working under `src/lib/components/sidebar/`. The HUD side of these
rules is in `src/lib/components/hud/CLAUDE.md`.

### Setup is gone while a run is in flight

`uiState.setupHidden` takes the panel off screen for the length of a run, and
both ways back into it with it — the HUD's Setup button and the docked panel's
own handle. Everything on its three tabs is an input to *that* run (the island
it is solving, the roster it was planned with, the timeline it is rating
against) and a run reads every one of them once, at launch, so a press there
either cannot reach the search at all or, on the island list, stops it outright.
Hidden rather than disabled, which also replaces a half-measure:
`SolveModeSelector` and `AnomalySelector` already greyed themselves out while
the island list and the roster beside them stayed live, so the panel was part
working and part dead with nothing saying which was which. Both keep their
`disabled` as a backstop for the frame between the run starting and the panel
unmounting. Stop is untouched, because it is in the HUD.

Three things follow, and each is something that would otherwise be left behind:

- **`ConfigSidebar` holds `uiState.sidebarWidth` for the run, and clears it
  otherwise.** Its teardown is the same call `HudToolbar` makes for
  `hudHeight` — a width left behind reserves canvas, and the HUD's own
  `padding-left` tracks the same edge — and that is right for a preview or a
  hidden interface, which are states the user is *in*. A run is not: Setup is
  away for seconds and comes back on its own, so handing the space over means
  taking it again a moment later, with the action pill gliding 190px out from
  under the cursor that pressed RUN and back when it lands. Held, the whole
  scene stays still and all the run changes is that the panel is not drawn
  over it. The effect also skips the `0` that `bind:clientWidth` reports
  before it has measured, which would otherwise drop the inset for one paint
  every time Setup came back — and `padding-left` transitions, so one paint is
  a visible glide out and straight back.
- **The sheet is shut on the way in**, in `#beginSolve`, the one route both Run
  and the re-run dialog take to `runOptimizer`. Same reason `setUiHidden` shuts
  it: a detent left open describes a panel that is no longer rendered, and on a
  compact viewport it takes the whole HUD down with it — which is where STOP is.
  In practice it is already closed, since the HUD unmounts while the sheet is
  open and Run is in the HUD; the case it covers is a sheet opened on a phone
  and then run from a window that has since been widened.
- **`dismissConfigPanel` sits the run out.** `collapseSidebar` persists, so a
  press on the view toggle mid-run would otherwise hand the user back a panel
  that had shut itself.

**The Edit/Solver switch goes with it**, on `uiState.canSwitchBoards` — which
is `hasSolverPlacements` and no run in flight, and is what both the toggle and
the compact line it sits on render against. `showingSolver` keeps reading
`hasSolverPlacements` alone, since which board is drawn is a different question
from whether the switch is offered. Three reasons, all pointing the same way:
the readout is pinned to the run for the duration (`statsPanel`), so switching
to Edit leaves the card reporting the search while the canvas draws the user's
board — the one disagreement `visiblePlacements` exists to make impossible; the
switch to the solver's board is an edge on the run *starting* (`PixiCanvas`), so
a layout finishing while the user is on their own board lands where nobody is
looking; and on a first-ever run the pill would appear partway through anyway,
the moment the first progress report gives it something to switch to, which on
a phone is a line arriving in the HUD unasked. So mid-run on a compact viewport
the whole stack is the action pill alone.

**Hidden there does not mean unmounted, and the difference is the wide-screen
row.** On a phone the toggle has a line of its own and the pill below is pinned
to the band's right edge, so the line is simply not rendered. On a wide screen
the toggle shares one centred row with the action pill, and dropping out of the
flow re-centres RUN/STOP under the cursor that just pressed it — so it renders
on `hasSolverPlacements`, keeps its box, and takes `visibility: hidden`, which
is the one declaration that gives up paint, hit testing and the accessibility
tree at once while leaving the layout alone. That is why the `.view-row` gate
and the toggle's own are deliberately not the same condition.

On a compact viewport `.hud-top` is `justify-content: flex-end`, which is what
keeps the run pill still as Setup leaves. Setup's `margin-right: auto` takes the
free space first while it is there, so the property does nothing; with Setup
gone it is the whole of the rule, and STOP stays where the finger that pressed
RUN put it instead of centring itself across the row.

### Setup is three tasks, and it shows one at a time

The panel holds three unrelated jobs — **which island**, **which buildings** and
**the Time Lab** (research, then anomaly). Stacked in one scroller with the islands on top, the roster is
never on screen when Setup opens on a 390x844 phone, and the Reactors tab behind
it is 24 cards.

The Time Lab is a tab rather than a row somewhere because it is a third input of
the same kind, not a qualifier on either of the other two: it changes what a run
comes back with, it is set once and then tried against island after island, and
it needs room — four cards, each with the game's own icon and wording. Three
labels do fit a 374px phone, but only because each may ellipsize (`min-width: 0`
on the buttons).

`uiState.setupTab` picks between them and `ConfigSidebar` renders the switch and
the body as **snippets**, used by both shells: a sheet and a docked column differ
in their chrome and their gesture, never in this. Four things about it:

- **It defaults to `islands`, and is not persisted.** The roster and the Time Lab
  are set once; both are then tried against one island after another, so the
  island list is the recurring task. This is view state, not a preference.
- **The switch sits between the fixed top region and the scroller.** Inside
  `.sheet-top` it would inflate the measured `peekHeight`; inside `.scroll-body`
  it would scroll away, and the one control that says where you are is the last
  thing that should leave the screen.
- **The inactive half is unmounted, not hidden.** They share one scroller, so a
  hidden section shares its scroll offset — landing the roster halfway down
  because the island list is scrolled there.
- **It is an underline, where the category tabs inside the roster are filled
  pills.** Two rows of identical tabs stacked on each other read as one confusing
  row of five. Both take `--accent` for the active one, because the colour law has a
  single meaning for "this is selected"; the hierarchy is carried by shape.

Two things follow. The roster's category tab bar is **sticky** at the top of the
scroller, since it otherwise scrolls off after the third card and changing
category means scrolling back the length of the list. It is the only thing pinned: Unlock/Lock All sit just below it and
scroll away with the cards, because pinning is for the control you reach for
_while_ reading a list and those two are a bulk edit made once. Its background must
be **opaque** (`--surface-panel-solid`): the sheet is 97% and the panel 88%, so
either would leave cards faintly legible through the bar.

**That bar's `z-index: 1` only holds because `.building-card` isolates.** The card
stacks three things internally, and `position: relative` with `z-index: auto`
creates no stacking context, so those 1/2/3 were never local: they competed in the
same context as the sticky bar and every card scrolled straight over it.
`isolation: isolate` on the card is the fix, because the ordering it wants is the
default one and only the containment was missing. Raising the bar instead would
have papered over it until the next card gained a layer.

Both controls also drop a rung off the `--tap` floor — `--ctl` for the category
tabs, `--ctl-sm` for Unlock/Lock. A row you scroll past once is charged to the
list once; pinned, it is charged against every screen, and 44 + 44 of permanent
chrome was most of what pinning was meant to hand back. That puts both under the
44px touch guideline, and **"Lock All" is armed** to pay for it: it empties the
whole roster and `configState` keeps no history, so it is the one control in the
panel that destroys work with nothing behind it. "Unlock All" is not armed — it
only ever adds, and the way back is the button beside it.

**The HUD's Setup button opens the sheet at `full`, not `half`.** Half kept the
top of the board visible at a cost of 340px of list — but the HUD and every tool
unmount for as long as the sheet is open at _any_ detent, so what that bought was
a view of a board nothing could touch. Setup is a task you finish and leave; the
grabber still drags it back down.

**The upgrade plan is a row at the top of the Buildings tab that opens a
dialog** (`UpgradePlanSummary` → `modals/UpgradePlanModal`). On that tab because a
plan is a statement about buildings — the tiers the roster below will hold next —
which is where a player looks for it; behind a dialog because each step wants a
sprite, a tier row and reordering, and inline that would push the roster down on
every visit for a thing set once. The row scrolls away with the cards, like
Unlock/Lock, and lists the steps so the plan is legible without opening it.

Four things about the dialog:

- **The picker offers only buildings with a tier left to buy** once the steps
  already in the plan are counted (`configState.canPlan`), strongest-first like
  the HUD palette, since the building a player upgrades next is almost always
  their best. A step is born one tier up and its tier row raises it; its
  building is fixed, and changing it is remove-and-add.
- **Order is editable** (up/down), because it is the buying order and it
  decides what the layout has to survive.
- **It says up front that only the last step is optimal.** Today's power under
  a plan measured 57-98% of a plain solve's, and a player who did not expect
  that reads the lower figure as the solver getting worse. A neutral note, not
  `--warn`: nothing is wrong, it is what the plan buys.
- **The roster's cards mark the planned tier** with a dashed `--accent` border
  (`plannedUpgrade`, from `configState.plannedLevel`), so the plan is visible
  where tiers are chosen without making the cards a second place to edit it.
