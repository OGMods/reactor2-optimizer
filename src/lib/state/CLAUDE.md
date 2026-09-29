# CLAUDE.md — state layer and board rules

Loaded when working under `src/lib/state/`. The six stores and the dependency
DAG between them are summarised in the root `CLAUDE.md`.

## The Time Lab and anomalies: the app side

The engine side is in `packages/solver/CLAUDE.md`.

`layoutState` cannot read `configState`, so it **holds** the scales
(`setPrestige`) rather than taking them per call — `recalculate()` runs from a
dozen internal places that cannot all grow an argument. `hydrateState` seeds it
before the board exists; `App.svelte`'s effect pushes changes. A previewed board
sits it out, the same as `rebasePlacements`: it is the author's board at the
author's research, and a blueprint does not record what that was.

- `configState.anomalyId` is the live choice, persisted under its own key rather
  than in `ui_prefs` because it is a **solve input** like the roster, not a
  preference about the app — which is also why `solveSignature()` counts it and
  a solve found under another anomaly restores as stale.
- **`sidebar/AnomalySelector` is the only place it is chosen**, under the
  research on Setup's Time Lab tab. It mirrors a choice already made in the game rather than making one, so
  it is built to be recognised rather than shopped: icon and name first, the
  game's benefit/drawback pair beside them, and the full rule only under the
  selected card — four rules at once is a wall of text on a phone describing
  three timelines nobody is in.
- **Changing it re-scores both boards** through the same `$effect` in
  `App.svelte` a roster change goes through, and for the same reason. It is
  tracked separately there because the two ask for different work: a bought tier
  changes which tier a *placement* resolves to (`rebasePlacements`), while an
  anomaly changes none of them — the same building at the same tier is simply
  rated differently — so it needs the re-score alone.
## The stores

**`layoutState` imports nothing from the rest of the state layer.** It is the
model, constructed first, and everything else reads from it. Three things used to
violate that: it wrote `activeTemplateId` onto `uiState`, it recentered the canvas
on template load, and `paintTile` read the brush off the editor. The first two
made the grid and UI singletons mutually dependent _during construction_, which
worked only because module import order happened to cooperate. Now the template
id lives in `layoutState`, recentering is the caller's job, and the editing verbs
live on `editorState`, which calls `layoutState.setTile()`. `layoutState` exposes
`setTile`/`tileAt` and applies no editing rules of its own.

### `editorState` (`editor.svelte.ts`)

The paintbrush: `activeTool`, `selectedBuildingId`, and the editing verbs
`paintTile` / `eraseTile`, which — like `placeAt` and `eraseAt` in the canvas —
**report whether they wrote** so a brush dragged
across a board it may not edit cannot buzz once per refused tile. Transient;
never persisted.

### `layoutState` (`layout.svelte.ts`)

The document: `grid`, `width`/`height`, `activeTemplateId`, per-template saved
edits, and hand `placements`. Saved to `localStorage` as a blueprint code, one
per template, and that same code is the share code.

Because both templates and saves are blueprints, **the constructor cannot build a
grid at all** — it only restores which template was selected. `hydrateState()`,
awaited in `main.ts` before mount, decodes the template and then the user's saved
layout over it, so the first paint is the real board. Writes go the other way:
`persist()` returns immediately and the encode lands in the background, with a
sequence number so a burst of paints cannot land out of order.

### `configState` (`config.svelte.ts`)

The roster: which buildings are unlocked and to what level. **Presence of a key
in `buildingUpgrades` is what "unlocked" means**; locking deletes the key rather
than storing a flag. The building _catalog_ is not here — it is static data, so
import `BUILDINGS` from `@reactor2/solver`.

### `solverState` (`solver.svelte.ts`)

The optimizer run: status, streaming `optimizationResult`, `estimatedMaxPower`,
the elapsed clock and the stop handle. The only place that drives
`SolverWorkerClient`.

**A run is bounded by a budget, and the budget is the whole shape of it.** The
search has no natural end, so the coordinator divides the budget across islands
and every stage's deadline is carved out of it. It is short on purpose, because
that is what makes "run it again" cheap rather than a five-minute commitment.
`#startWatchdog` is a backstop, not the mechanism — the workers honour the budget
themselves, and it only fires (with a grace period, via the graceful
`stopOptimizer`) if an island's pass overruns its slice. It is set against the
run's **serial** cost, not the parallel estimate: a machine that reports eight
cores and gives two must not have its run cut short.

**How the budget is spent is the player's choice** — `SOLVE_MODES` in
`worker/solveModes.ts`, persisted as `solveModeId` (README states what the three
modes buy). Ties from different attempts are pooled, which is where a deep run's
fuller shortlist comes from.

Attempts are ordinary pool tasks: `attempts × islands` go into the same queue
that runs one island per worker, so extra searches cost wall-clock only once the
pool is full. That is why `estimatedRunMs` exists and why the control prints it —
"10 × 10s" is not a duration until you know how many workers the browser gives
you. `estimateMakespanMs` replays the coordinator's own greedy dispatch over the
task durations rather than guessing.

Two properties of that queue are load-bearing. Tasks are ordered
**attempt-major**, so every island is solved once before any island is solved
twice — island-major would leave the last island of a large board empty if the
user pressed Stop early. And when Stop is signalled the still-queued tasks are
struck off the outstanding count on the spot: they will never run, so they will
never report, and a run that kept counting on them would wait forever.

**The best attempt is taken per island, not per board** (`IslandBest`). Islands
never interact, so the maximum over attempts for each island composes into a
board at least as good as the best whole-board attempt. Ties across attempts are
pooled rather than discarded. Finished attempts only: a progress report is a
snapshot of a search still moving, so the coordinator streams those to the screen
on a separate, monotonic track and never files them as answers.

**A re-run has to earn its place.** `runOptimizer({ keepBest })` captures the
shortlist on screen and puts the new result back only if it scores higher; a
defended layout keeps its _own_ run's duration and timestamp, because it is still
that solve and the card prints both. The search is stochastic and the budget
short, so a second run genuinely can come back worse — which is why the choice is
put to the user (`uiState.requestSolve`) rather than assumed.

Two things about "the layout on screen" are load-bearing:

- **The bar is the _best_ layout held, not the one being previewed.**
  `variantIndex` is wherever the user's eye happens to be, and a shortlist is not
  always level: `rescoreResult` re-rates fixed shapes at a new roster and can rank
  them apart. Measured against the previewed entry, a run that beats only _that_
  one replaces the whole shortlist, higher layouts included. The _selection_
  still stays where the user put it.
- **A run that comes back with nothing puts the held layout back.** What is on
  screen at that moment is the last thing the dead run _streamed_ — a search still
  moving, usually a fraction of the power it was drawn over. `runOptimizer`'s
  `finally` re-hangs `variants[variantIndex]` with the clock that came with it, or
  empties the panel if there was never one. `previousVariants` is likewise only
  taken when there _is_ a shortlist behind the result: a bare streamed snapshot is
  not something to defend, and defending it would hand the next run a bar of
  nearly zero.

**A solve is a shortlist, not a layout.** `variants` holds up to
`MAX_SOLVE_VARIANTS` (ten) boards at the _same_ power, and `variantIndex` is the
one the canvas draws. Cycling (`showVariant`, which wraps both ways) only
previews and writes nothing; `applyVariant` is the commitment and
`appliedVariant` is what a reload returns to. Thumbing through ten layouts must
not quietly overwrite the one already chosen.

The list is filled from two directions: one run usually fills it on the shipped
islands, and `chooseSolveVariants` pools further runs that **tie** into it (a
fresh layout joins only if it clears `MIN_ALTERNATE_DISTANCE`; held layouts go in
unfiltered and stay in front, so the user's pick keeps its index). A run that
beats it replaces the list; one that comes back lower is defended against. That
policy is exported and pinned by `state/solveVariants.test.ts` rather than buried
in `runOptimizer`, because it is the whole meaning of "ten layouts at the same
power".

Only the **applied** variant is stored scored; the rest are stored as bare shape
(`StoredPlacement` — building, tile, tier) and re-scored through
`simulatePlacedBuildings` on the way back in. Ten scored boards across eight
islands is megabytes of `localStorage` for figures that take a millisecond to
recompute. A record written before variants existed restores as a shortlist of
one, which is what it was.

**Completed solves are persisted per island** (`solverStorage`, key
`solver_result`: one record per template id, oldest evicted past
`MAX_STORED_SOLVES`) and re-hung by `restore()`, which `hydrateState()` awaits
_after_ `layoutState.hydrate()` — deciding whether a stored result is still valid
means reading the board it was solved against. Validity is a stored signature:
the terrain (`blueprintKey(grid)`, no placements) and the roster. Hand-placed
buildings are deliberately outside it because the solver ignores them, so
building by hand does not invalidate a solve; clearing an obstacle or changing an
unlock does.

A run can take five minutes, which is what makes losing one expensive.
**Switching islands is a change of view, not a deletion**: `TemplateSelector`
calls `restore()`, which is total — it hangs the new island's solve or empties the
panel. Only a real discard goes through `clearResult()`: the card's Reset, and
resetting a template. `forgetSolve(id)` drops the record for an island being
deleted.

**A tier bought after a building is down re-scores it.** The roster is an input to
both boards' figures, not just to the next solve, so an `$effect` in `App.svelte`
— the one always-mounted place allowed to see all three singletons, since
`configState` is the bottom of the DAG — calls `layoutState.rebasePlacements()`
and `solverState.rescoreResult()`. The first re-reads each placement's tier and
re-scores, applying live the rule `#applySaved` has always applied on load, so a
board on screen and the same board reloaded cannot disagree. The second re-runs
the scorer over the solve's fixed shape and writes the result back under the new
signature. It deliberately does **not** re-optimise: that layout was chosen for
the old roster and may no longer be the best shape, or a stable one, so what it
reports is the honest output of those buildings at their new tiers. Re-running is
the player's call.

A run also outlives the switch that interrupts it, so it is **bound to the island
it was started on**: `#runTemplateId` / `#runSignature` are captured before the
first await, progress reports are dropped once that island is off screen, and the
finished layout is filed under the captured id. Switching stops the run, because
the board it is solving is no longer the one being looked at.

`elapsedMs` ticks every 100ms while a run is in flight and holds the final
duration afterwards (`lastRunDurationMs`, `finishedAt`). The solve has a
five-minute ceiling, streams its result and shows no progress bar, so without a
clock nothing separates "four seconds in" from "about to time out".

### `viewportState` (`viewport.svelte.ts`)

The device, from `matchMedia`: `isCompact` (< 1024px — bottom sheet instead of
docked sidebar), `isPhone` (< 768px — the header sheds secondary controls into
`OverflowMenu`), `isCoarse` (`pointer: coarse` — tap to inspect instead of
hover), `prefersReducedMotion`, and the live viewport `height` the sheet's detent
maths reads.

**Width and pointer are independent axes and must stay that way**: a touchscreen
laptop at 1400px gets the docked sidebar _and_ tap-to-inspect, and deriving
either from the other hands it the wrong half of each. Motion is a third,
independent of both, and unlike the others it only ever sets a _default_ — see
`uiState.animations`.

### `uiState` (`ui.svelte.ts`)

The interface: sidebar/catalog tab, the inspected tile, the share dialog, canvas
ref, `sheetDetent`, the measured `hudHeight`, `activeModal`, `placementView`, and
the getters `BoardStatsCard` reads. `activeModal` is one field rather than a
boolean per dialog, so "only one modal at a time" is a property of the type.

Two fields cover the inspector because the two pointer types cannot share one:
`hoveredTile` is transient and fine-pointer only, `pinnedTile` survives until
dismissed and is what touch sets. `inspectedTile` picks between them, so there is
only ever one inspector on screen.

**`animations` is three states, not two, and the third is the point.**
`#animations` is `true | false | null`, and `null` — nobody has chosen — is what a
fresh install has. The getter resolves it against
`viewportState.prefersReducedMotion`, so until someone opens Settings the system
answers for them _and keeps answering_ if they change it at the OS level. An
explicit choice then wins for good, which is the standard reading of a system
preference: a default, not a veto. `UiPrefs.animations` is optional in storage for
the same reason — absent is not `false`.

**`haptics` is a plain boolean**, and the asymmetry is the point: there is no
`prefers-reduced-motion` for touch, so there is no system answer to defer to and
no third state to preserve. `UiPrefs.haptics` is required and defaults to `true`.
It is best-effort in a way the rest of the app is not — **iOS Safari implements
none of the Vibration API** — so nothing is ever confirmed by touch alone, and
`SettingsModal`'s hint says so on a device that cannot do it rather than leaving
the user to conclude the app is broken.

**`analyticsDisabled` is the third row, and the only one that is not about how
the app behaves for the user.** Google Analytics is opt-_out_: the stored field
is the refusal, matching gtag's own `ga-disable-<id>` switch, and the row is
presented as the affirmative — lit when collecting — because every switch in
that column means "this is happening".

**It is three states, like `animations`.** Absent means nobody has chosen, and
then the browser answers: `doNotTrackRequested()` reads Global Privacy Control
as well as `doNotTrack`, because DNT is gone from Safari and never had a UI in
Chrome. Both are compared to `"1"` rather than coerced — `"0"` means _yes, you
may_, and it is truthy. An explicit choice then wins in both directions.
`analyticsOptedOut(choice)` holds that rule for the two callers that resolve it,
`main.ts` at boot and `uiState` for the switch.

Three things in `utils/analytics.ts` are what make the opt-out real: the tag is
**not in `index.html`** (a `<head>` script sends its `page_view` before any
preference has been read), it is fetched **on idle** after mount so it never
competes with the atlas, and switching off sets the disable flag on a tag
**already in the page**. `setAnalyticsEnabled` is idempotent and fetches at most
once, which is what lets one function serve both the boot path and the switch.
The measurement id is a constant, since it ships in the bundle anyway.
`utils/analytics.test.ts` pins every branch — each fails either open (a page
view for someone who said no) or closed (the tag off for everyone), and neither
is visible in the app.

**Six events beyond `page_view`**, each fired from the one place that knows
the answer: `solve_run` and `solve_done` in `runOptimizer` (paired, so a status
other than `ok` is countable rather than inferred from a run that never
reported), `share_copy` in `copyShare`, `board_failed` in `PixiCanvas`'s
init catch — one event for both halves, since an atlas that never arrives and a
WebGL context that never starts are the same empty board — and the Time Lab's
two, `anomaly_select` in `configState.setAnomaly` and `research_set` in
`toggleResearch` / `setResearchLevel`. Both solve events also carry the rules
the run was launched under (`configState.rulesParams()`: `anomaly`, and
`research` as `id:level` pairs numbered from 1), captured at launch, so power
and bound can be split by timeline. `trackEvent` buffers
until the tag lands, because it is fetched on idle and the app is usable well
before that; nothing buffered before an opt-out is ever sent. A param is not
reportable until it is registered as a custom dimension or metric in GA.

Those three are the **only** preferences in a Settings dialog, deliberately:
every other setting — run length, which board is drawn, whether the readout is
folded — sits beside the thing it changes, because choosing it is part of doing
the task. These are about the app rather than the board.

**Settings and Setup are two things.** The panel is named **SETUP**, never
_Configuration_ — a synonym for _Settings_ offers two differently-named doors and
no way to guess which holds what. The split is real: the panel holds the **solve's inputs** (which island, which buildings, how
long a run may take), all of which change what comes back from a run, while
Settings holds preferences about **the app** that no solve can see.

**Sharing follows the board on screen.** `shareLayout()` encodes
`visiblePlacements`, so the solve is shareable. `copyShare(form)` is the only
write to the clipboard and is always a direct response to a press, which is also
what makes it land: some mobile browsers refuse a clipboard write not tied to a
user gesture.

**The bottom line of the screen is `uiState.showToast`, and it is general** —
not hard-wired to any one caller. `tone` is not decoration: `ok` confirms something that
happened, `warn` says something did _not_ and why. A second call replaces the
first rather than queueing — this is the bottom line of a phone, and a backlog
there is a backlog nobody reads.

Its first `warn` caller is **`requestSolve` refusing a roster that cannot produce
power.** The test is `configState.canProducePower`, not "is anything unlocked": a
roster of coolers, or of reactors with no generator, is not empty and still
cannot come back with a number — the run would spend its whole budget and hand
back a blank board with nothing on screen saying why. `rosterCanProducePower` in
`data/effectiveBuildings.ts` restates `docs/game-logic.md` over the resolved
roster: a direct producer is self-contained and needs only cooling; a generator
needs a reactor, because heat comes from nowhere else; and either counts only if
its waste has a cooler to go to. It tests `waste <= 0` rather than
`wasteIsCovered`, because the question is whether cooling _exists_, not whether a
given layout covers a given building — that needs a board and is
`simulateIsland`'s job. `data/rosterPower.test.ts` pins every branch, since each
is a way the guard fails open (a wasted five-minute run) or closed (a refusal on
a roster that would have worked).

There are two messages, because the two failures want different things done about
them: nothing unlocked at all, versus a roster with a part missing. Both name
Setup, because on a phone that is behind a button and a closed sheet. The guard
sits _after_ the stop branch — pressing STOP must work whatever the roster says —
and Run stays live rather than going disabled, since a dead primary action
explains nothing.

**A layout leaves the app a third way: as a picture.** `saveLayoutImage()` (the
overflow menu's _Save as image_) downloads the board as a PNG. A share code and a
link both need this app to read them, which is no use for a forum post; a picture
travels anywhere. It follows the same board Share does, and it is allowed in
preview because it writes nothing the visitor owns.

**The power is in the filename** — `reactor2-island-3-12AA-345T.png`, from
`layoutImageFilename`. A picture is the one form of a layout that carries no
figures inside it, so a folder of these sorts and compares without opening any.
`formatNumberForFilename` comes from `@reactor2/solver`, which is what the CLI
names its own output with, so a board saved from the app and one solved from the
terminal spell the same figure the same way — dots turned into a second whole
tier after a hyphen, because a dot in a filename reads as an extension. The board is named by its **id** (`island3`, `custom2`)
rather than its title: the id is already the "which island", and unlike the title
it survives a rename.

The capture is `PixiCanvas.exportBoardImage()`, and it takes the **grid
container**, not the visible canvas. `getLocalBounds()` ignores the container's
own transform, so what comes out is the whole board at its authored sprite scale
— not the part the window happens to be showing, and not whatever zoom was last
pinched to. `clearColor` is the board's own green, so the margin is board rather
than a transparent halo that most viewers render black.

**The scale is a Settings preference** (`uiState.imageScale`) and is **passed
in** rather than read by the renderer — the same split `setAnimated` makes. 2x
is where the export used to be fixed, and it is now the _ceiling_: it puts a
large board past 5MB, so 1x is the default and the reason the setting exists. `EXPORT_MAX_SIDE_PX` in `pixi/boardExport.ts` still
wins outright over it, and is not floored at 1x: a render texture past the GPU's
cap comes back blank rather than large, so the scale is backed off rather than
the picture cropped. Settings names that cap in its hint, which is why the two
constants live in a module of their own instead of inside `PixiCanvas`.

**Two boards can exist at once** — the user's hand-placed buildings and the last
solve's — and `visiblePlacements` is the single answer to which is on screen.
`PixiCanvas` renders it and `inspectedBuilding` reads it, so the card cannot
describe a building the board is not drawing. `placementView` (`"user"` |
`"solver"`) is the user's choice, persisted in `ui_prefs` so a reload lands on the
same board as the restored solve; `showingSolver` falls back to the user's board
when there is no solve.

Placing a building by hand switches the view and **keeps** the solve — it must
never delete a five-minute run to show a one-building board; starting a solve switches it back (an `$effect` in
`PixiCanvas`, on the edge of `isOptimizing` — `solverState` cannot reach `uiState`
without breaking the DAG).

## Board and terrain rules

### Shipped islands are fixed maps

`layoutState.canEditTerrain` is true **only for the user's own custom islands**.
On a shipped template the terrain is read-only and the controls for it are not
rendered. `editorState.paintTile` and `layoutState.resize` both refuse anyway, as
the backstop for a tool that survives a template switch
(`editorState.clearHand()` is what normally prevents that).

Two things stay open, because they are the player's actual moves rather than
terrain authoring: **placing and removing buildings**, and **erasing an
obstacle** — `eraseTile` only ever writes grass over a rock/tree/pond, so it
cannot reshape a map.

The reason to keep this rule is that a shipped island _is_ the puzzle. If it can
be repainted, "solve island 3" becomes "draw an easier island 3", and a share code
for `island3` can describe a board no other player can reach.

**Clearing an obstacle is reversible.** `layoutState` keeps the loaded template's
pristine tile types (`#pristineTypes`) alongside `#pristineKey` — the key is a
one-way hash that can say _that_ the board changed but not _what_ used to be on a
tile, and restoring needs the original type. `restorableObstacles` is every tile
whose pristine type was an obstacle and which is now bare grass;
`restoreObstacle()` puts one back and refuses anything else, so a stale click
cannot invent terrain. The HUD's Restore toggle appears only when that list is
non-empty, and while it is on the renderer ghosts those tiles
(`GridRenderer.setGhosts`). Without this, clearing was a one-way trap on a fixed
map whose only undo was Reset — which also discards every building placed.
`state/terrainRules.test.ts` pins the round-trip and both refusals.

Ghosts live in their own Pixi container rather than in the per-tile prop nodes,
because `renderTileVisuals` clears those whenever a tile's state changes.

**Importing therefore always creates a new custom island**
(`layoutState.importBlueprint`). It cannot land on a shipped template, and
deliberately does not overwrite the current custom island, since that would be a
destructive act with no undo behind a button marked "Import". At
`MAX_CUSTOM_ISLANDS` it refuses and says so.

### The transformer is special

Two rules the other tile types do not have, both enforced in `editorState`:

- **It cannot be erased.** `eraseTile` refuses it — it is the board's power
  hookup, not scenery. A consequence: it can never become a cleared obstacle, so
  it never appears in `restorableObstacles`.
- **A board carries at most one.** Painting one when the board already has a
  transformer **moves** it rather than adding a second.

Moving, rather than refusing the second placement, is the only reading of the two
rules that works together: it cannot be erased, so a refusal would make a
misplaced transformer permanent on a custom island, with no way back short of
deleting the island.

`layoutState.findTransformer()` is the query the rules read; the rules live in
`editorState`, because `layoutState` applies no editing rules of its own.
`importBlueprint` also rejects a code carrying more than one — the editor cannot
produce such a board, so one that exists was hand-edited, and accepting it would
hand the user a layout they can neither reproduce nor repair.

All eight shipped maps carry exactly one transformer despite having 4–12 separate
landmasses, which settles "one per **map**" rather than one per connected
component. `state/terrainRules.test.ts` pins that against the shipped codes.

### The board has an undo

`layoutState` keeps a bounded stack of whole-board snapshots (`BoardSnapshot`,
`MAX_HISTORY` of 30) and every verb that writes the board — `setTile`,
`addPlacement`, `removePlacement`, `clearPlacements`, `resize` — records the board
as it stood _before_ the change. The only other way back from a mis-tapped
building is the readout's Reset, which throws away every other building with it:
a larger mistake offered as the cure for a small one. It earns
its keep on a phone, where the board is isometric, the tiles are small and a thumb
covers several at once.

Four rules, each pinned by `state/boardHistory.test.ts`:

- **Snapshots, not deltas.** A board is a few hundred tile types and a handful of
  placements. Thirty cost little, and the whole class of bug where an inverse
  operation turns out not to be the inverse cannot arise, because nothing is
  inverted.
- **A gesture is one undo.** `beginStroke()` / `endStroke()` open a coalescing
  window that `PixiCanvas` wraps around every press, so a drag across twelve tiles
  is one entry, and a tap that replaces a building (a remove _and_ an add) is also
  one. Opened for every press rather than at each writing branch, so each way a
  press can change the board is covered by construction; a stroke that writes
  nothing records nothing.
- **History never crosses a board.** `#clearHistory()` runs in
  `#applyBaseTemplate` and `loadPreview` — the two places a board arrives from. An
  undo that survived a template switch would paint one island's terrain onto
  another.
- **A restored board is re-scored, not un-scored.** `#restore` calls
  `recalculate()` rather than trusting the figures in the snapshot.

Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y are wired in `App.svelte` and deliberately sit out
three cases: a modal being open, focus in a text field (the browser's own undo is
the right one there, and Import is a textarea), and a previewed board.

### A shared link is a preview, not a board you own

Arriving with `?bp=<code>` puts the app in **preview**: someone else's layout on
screen, `layoutState.isPreview` true, and nothing the visitor owns disturbed.
`hydrateState()` still hydrates their own board first — so `exitPreview()` is a
plain re-hydrate with somewhere to return to — and then overlays the shared one;
an unreadable code just leaves them where they were.

It is **fully read-only**, and that is one rule with a lot of surfaces:

- `canEditTerrain` is false, `editorState.eraseTile` refuses (`paintTile` already
  reads `canEditTerrain`), and `PixiCanvas` drops to pan-and-inspect.
- `persist()` and `#saveState()` return early, so no island, no saved grid and no
  preference moves. `importBlueprint` throws outright — it claims an island slot
  that `#saveState` would then refuse to write.
- `rebasePlacements` sits it out. A previewed board is rated at **the author's**
  tiers, read from the code's tier table, and at the author's rules where the
  code names them — it is the one board the reader's roster and the reader's
  timeline do not speak for. This is the reason the tier and rules tables exist.
- The HUD and the config panel are not rendered at all, so there is no Run button
  and no roster.

Two ways out, both of which clear the parameter so a reload does not drop the
visitor back in: `adoptPreview()` takes the board as a new custom island — and
re-bases it to the visitor's own unlocks on the way in, because once the board is
theirs it is their roster that rates it — or `exitPreview()` simply leaves. An
adoption that is refused (island cap, two transformers) puts the flag back and
leaves them reading. `state/previewMode.test.ts` pins every refusal.

**The author's rules are dropped with the code, on both ways out, and restored
with it when an adoption is refused.** Exiting re-hydrates a board that was never
built under them, and an adopted board is re-based to the visitor's own unlocks,
so keeping the author's research would rate the visitor's own buildings under a
timeline they were never in. Every accessor that reads the rules branches on
`isPreview` first, so nothing would print a wrong figure today — but that makes
the guard the only thing standing between a re-scored board and someone else's
timeline, and there being nothing to guard is the stronger guarantee. On the
refused path the rules go back with the code, because the visitor is still
reading the author's board.

The state lives on `layoutState` rather than `uiState` because it is a property of
the _document_: this board is not saved, not editable, and not the player's.

### Grid data model

Tiles are typed `water | grass | rock | tree1 | tree2 | pond | transformer` — only
`grass` is buildable; all others are obstacles.

### The interface can be put away

`uiState.uiHidden` takes every pixel that is not the board off the screen —
header, banner, readout, HUD, panel and scrim — and leaves one small button in the
corner. The board is what this app is about and everything else is chrome standing
on it; there are moments when none of it is wanted, reading a finished layout most
of all.

Five things about it, each a way it would otherwise leave the app with no way out:

- **`App.svelte` gates the chrome as one block**, not per component, so a layer
  added later is hidden by default rather than being the one thing left floating
  over a bare board.
- **Not persisted**, unlike every other preference on `uiState`. A reload that came
  back with the whole interface gone would read as the app being broken, and one
  unlabelled button is too thin a thread to hang a returning session on.
- **`setUiHidden` closes the menu, the sheet and any dialog** on the way in — all
  three live in the layer being hidden. Coming back restores none of them: it is a
  return to the board, not a resumption of what was open.
- **Escape brings it back**, wired in the shell. The button is the only other
  route, and a player who misses it is looking at an app that appears to have lost
  its controls.
- **It puts the brush down** (`editorState.clearHand`). The palette that shows
  what is in hand goes with the chrome, and so does undo.

`recenterGrid` reads `uiHidden` and frames the board against the whole window when
it is set, rather than against the published insets — those do not all reset on
unmount (`hudHeight` clears itself, `headerBottom` and `sidebarWidth` keep their
last measurement), so a rotate with the interface away would otherwise frame the
board into a band reserved for bars that are not there. Toggling it also re-frames,
on the same terms as folding the docked panel: only while `isUserAdjusted` is
false.
