# CLAUDE.md — the readout

Loaded when working under `src/lib/components/inspector/`.

## The readout (`inspector/BoardStatsCard`)

The app's only readout, and one component with two panels (`uiState.statsPanel`
picks between them): the solve's figures
while the solver's board is up, the live simulation of the player's own buildings
while theirs is, and nothing at all on an empty board of their own rather than a
card full of zeroes. A run in flight outranks both, because it must show its mode and
countdown before it has a first result. Stopping it is the HUD's job — Run turns
into Stop there — so the card carries no Stop of its own.

It carries three figures — power, the bound it is measured against, and how long
the solve took — and the inspected tile at its foot: bare ground is one line, name
left and position right, while a building adds its sprite, a `Lv. n` chip and its
figures as labelled rows in `BuildingUnlockCard`'s idiom, so a building reads the
same wherever it appears.

**The level chip is 1-based**, matching the sidebar's tier buttons, which number
themselves `idx + 1` — the two must agree or the same building reads as two
different tiers in two places. It resolves through `levelIndexForValue` (the
inverse of `placementBaseValue`) from the placement's own `baseValue` rather than
from the roster, the same rule the figures beneath it follow: it names the tier
the building was _placed_ at and the scorer ran it at. Reading the roster instead
would print a level the ceilings under it contradict. It sits under the name
rather than beside it because on one line the two competed for a phone's width
and the name had to ellipsize; stacked as a column (`.tile-id`), neither yields —
and that column is what pays for the sprite beside it being 40px rather than 30px.

Each figure row is **used / total** — `10.1AC / 13.3AC` — because the live figure
alone cannot distinguish a building doing nothing from one with little to do. The
ceiling is the tier the building was placed at, **rated for the tile it stands
on**, and it comes from the scorer rather than from the roster:
`simulation/simulator.ts` exports `ratedPlacementAt`, which lays the whole board
out through the same `layoutFor` that scored the rows and hands back what that
tile was rated for. Two things force that. A placement carries only its
_authored_ tier value — rightly, since the tier is resolved back out of it — so
`effectiveAtValue` on its own answers a question with no tile in it: against the
plain roster a shore cooler printed `8.35AC / 8AC`, a used figure past the total
it was measured against, and a Cryo cooler at full tilt could never reach one.
And a role isolation rates a building by _what its neighbours are_, so the whole
board has to go in, not the one building — which is why the answer comes back
through `simulateIsland` and `ctx.ratedLayout` rather than from a second
neighbour scan written in the component. A second reading of the rules in the
card is exactly what would drift from the rows above it. The board it lays out is
the one this panel describes, and the rules are `layoutState`'s, which on a
previewed board are the author's. A tile the scorer cannot place gets no ceiling
at all rather than an invented one: every figure beside it is zero anyway.

**Cooling is the one row not measured against a ceiling at all**: it is measured
against the waste the building is actually making, not the tier's full-tilt
waste, because what it needs falls with its fill — against the ceiling a half-fed generator would read as starved while
being perfectly covered. That row turns **red** when cooling does not cover waste,
and the test is `placementStatus` — the solver's own `wasteIsCovered` tolerance,
not a bare `<`, which would paint running buildings red.

**Failure counts.** What the card reports beyond power is the buildings that are
**not working**, split in two because the fixes differ: **Idle** (every figure
zero — a generator with no reactor beside it, a cooler nobody draws from; it needs
a neighbour) and **Overheating** (`placementStatus`'s `starved` — more waste than
the cooling routed to it covers, so the game shuts it down; it needs a cooler).
Both are numbers a player acts on, and neither has anywhere else to be said: on
the map a building doing nothing looks exactly like one that works. Each row
renders only when non-zero, so a board where everything runs says nothing at all.

They are counted for **both** panels: "a solved layout is stable by
construction" holds only for a layout the solver has _just_ returned, and
`rescoreResult` deliberately does not re-optimise, so a tier bought or locked
behind a standing solve can leave it unstable, and the card has to say so rather
than printing a power figure whose buildings have quietly shut down.

**Under an upgrade plan the card adds an "After upgrades" line**
(`uiState.planReport`): the power once the plan is bought, and — when a step
would overheat something — how many buildings and at which step, named by
building and level because the list it would index is behind a closed panel on
a phone. It is `--warn` rather than the board's red: it describes a board that
does not exist yet. It shows for any board on screen, so a solve found before
the plan existed is told the upgrade will shut part of it down.

The same report counts **`reserved`** — buildings idle today that work once the
plan is bought, mostly coolers held for heat still to come. They come out of the
amber Idle row (and the folded pill's count) and are listed uncoloured as "Kept
for upgrades", because printed as idle they are exactly what a tidy player would
remove. The pads on the board still say idle, which is true today.

**Amber is idle, red is overheating, and that is the whole app's language rather
than this card's.** The status pad under every building says the same in the same
colours (`STATUS_FRAME` in `pixi/gridPainter.ts`), the building above it breathes
at a rate ranking the two the same way (`STATUS_PULSE`), and so does the Cooling
chip. A player who learns one reading has learnt all four, and they cannot drift
because every one is `placementStatus` over an already-scored row. Red goes to the
more urgent: an idle building is wasted money, an overheating one is shut down and
taking its cluster's output with it.

**When the solve has ties, the card grows a Layout row** — arrows, `n / total`,
and Apply. It renders only above one variant and never while a run is in flight:
the shortlist that run will produce does not exist yet, and the layout streaming
into the panel is not one of its entries.

**Reset asks twice** and acts on whichever board is showing: the solve, or every
hand-placed building. Switching panels disarms it, otherwise a press aimed at one
board would land on the other.

**Layout rules.** Everything under the head is a single `.card-scroll` —
figures and inspected tile together — capped by `.corner-cards` at the viewport
less header and HUD, with `min-height: 0` so it can shrink into that cap.

_One_ scroller, not two. Splitting them was the first attempt, so that "what did I
just tap" would not scroll away — but flexbox takes the whole shortfall out of
whatever can shrink, so a fixed tile section (~120px) crushed the figures to a few
pixels, and a scrollbar a few pixels tall is unusable. The head stays out of the
scroller because it is one line naming the board, and a scrolled card that no
longer says which of the two layouts it describes is worse than one line shorter.

`flex: 1 1 auto` on that scroller, and the `auto` basis is load-bearing: `flex: 1`
means a basis of **0**, and since the card's height is content-driven the card
would collapse to its head. `.scroll-body` in the sidebar can take the `0` basis
because its parent has a definite height; this one does not.

On a compact viewport the card **folds to one line** (title, power, the two
controls), because there it lies across the map being played. The state is a
persisted preference (`statsCardCollapsed`), and folding never hides the inspected
tile — that section is outside the fold — nor the failure counts: the collapsed
header carries a pill with the combined count ahead of the power figure, red as
soon as anything is overheating and amber otherwise. Folding puts the _figures_
away, not the fact that the board has a problem. A pill rather than bare text
because two numbers side by side with nothing between them read as one.

**Inspecting a tile folds it too** on a compact viewport, whatever the preference
says: a tile brings a sprite, a name, a chip and up to three stat rows, and
unfolded under a solve's figures that is most of a phone spent covering the board
whose tile was just tapped. It is **derived, never written** — dismissing the tile
puts the card back exactly as the player left it, where folding _by_ setting
`statsCardCollapsed` would have rewritten their preference on the way past.

Player-facing coordinates are flipped: `formatTileCoords` prints
`[x, height - y]`, because the grid indexes rows downward and the game counts them
upward from the bottom. That flip lives in the formatter and nowhere else, so the
two conventions never mix inside the model.
