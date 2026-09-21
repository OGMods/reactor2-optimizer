# Grid Power & Heat — How It Works

## The Big Picture

You place buildings on a grid to generate electricity. Making power creates heat as
a side effect, and any heat that isn't cooled shuts a building down. The whole game
is about arranging reactors, generators, direct producers, and coolers close enough
to each other that heat can get where it needs to go, and cooling can get to the
buildings that are overheating — all while everything fits together on the grid.

Heat gets handled first, completely, before cooling is even considered. Once a
generator has been given its heat, that amount is locked in — cooling can never add
to it, take away from it, or fix a bad heat delivery. Cooling's only job is to decide,
afterward, which already-heated buildings get to actually turn on.

---

## The Grid and Islands

The grid is made of tiles. Grass tiles are buildable — you can put anything on
them. Everything else (water, rock, trees, ponds, transformers) is just scenery:
you can't build there, and it has no effect on anything.

Only one building fits per tile.

Buildings only affect buildings that are close to them (see Adjacency, below).
Because of this, a grid naturally breaks apart into separate clusters of connected
grass tiles — call them islands. Nothing that happens on one island can ever affect
another island, so each patch of buildable land is really its own self-contained
puzzle.

A cluster needs a minimum amount of room to ever produce any power at all:

- Normally it needs at least **3 buildable tiles** — a reactor, a generator, and a
  cooler, one on each tile, is the smallest working setup.
- It can get away with just **2 tiles** if a direct producer's waste can be fully
  handled by a single cooler on its own, since a direct producer doesn't need a
  reactor.

Anything smaller than that is a dead zone — it will never generate power, no matter
what you put there.

---

## Adjacency

Two buildings can interact — sending heat, sending cooling — only if they are
within one tile of each other in any direction, including diagonally. Think of it
as the eight tiles surrounding a building, plus the building's own tile as the
reference point. If a building isn't in that ring, it might as well not exist as
far as the other building is concerned, no matter how much capacity either one has.

---

## The Order Things Happen In

Whenever the game has to decide who gets heat or who gets cooling, it always
works through the buildings in the exact same sequence: it sweeps across the
grid column by column, left to right, and within each column it goes from the
bottom row up to the top.

This isn't just bookkeeping — it genuinely changes the outcome. Whoever gets
processed first in a shared situation effectively gets first pick, and that can
mean the difference between a building running at full power and one shutting
down entirely. This same left-to-right, bottom-to-top order governs every stage
of both heat delivery and cooling delivery.

---

## Building Tiers Matter A Lot

Every building type comes in tiers, and the jump between tiers is huge, not
gradual:

- Coolers and generators get roughly **400 to over 4,000 times** more powerful
  from one tier to the next.
- Reactors and direct producers grow more modestly, roughly **8 times** per tier,
  but that jump is very consistent all the way up the chain.

The practical upshot: once you've unlocked a better tier of something, the old
tier is basically obsolete for that role. Swapping a top-tier building out for a
weaker one on the same spot is almost always a big loss.

There are exactly two situations where an old, weaker building still earns its
keep:

1. **Filling a generator's leftover appetite.** If a generator isn't receiving
   quite as much heat as it could handle, a small extra reactor tucked in next to
   it can push a bit more power out of that same generator — free capacity is
   free capacity. This only helps if you also have enough spare cooling on hand;
   otherwise the extra heat just risks tipping the generator into an overheat
   shutdown instead of adding power.
2. **Matching what your coolers can actually handle.** If your best generator or
   direct producer makes more waste heat than your best coolers can ever absorb —
   even completely surrounded by coolers — then a weaker generator or direct
   producer whose waste your coolers _can_ fully cover may end up producing more
   real power, simply because a building that can't get fully cooled produces
   nothing at all.

Outside of those two cases, treat a lower-tier building as basically worthless
once you have a better one.

---

## The Buildings

### Reactor

A reactor makes heat and nothing else. It has no power output and no waste heat
of its own — it just generates heat and pushes it out to any generators standing
next to it.

A reactor doesn't care whether the generators receiving its heat have any cooling
lined up; that's not its problem. And if a reactor has more heat available than
its neighboring generators can absorb, the extra is simply wasted — it's not
saved for later and it's never redirected into cooling.

### Generator

A generator takes in heat from nearby reactors and turns it into electricity.
Roughly three quarters of what it receives becomes usable power and the rest
becomes waste heat that needs cooling — but "roughly" is the operative word:
every tier of every generator has its own conversion figures, and they differ
from three quarters by a fraction of a percent in both directions. A generator
running at half its heat capacity makes half its rated power and half its rated
waste.

A generator has no dial to turn down — however much heat it ends up receiving
once all the heat has been sorted out, that's exactly what it converts. And once
that amount is settled, it's final: nothing that happens later with cooling can
change how much heat a generator actually got.

### Direct Producer

A direct producer is its own self-contained power source. It skips reactors and
generators entirely — it doesn't send or receive heat from anyone. It simply runs
at its full rated capacity all the time, no partial operation, converting most of
that into power and the rest into waste heat, at a fixed ratio built into the
building itself.

The only thing a direct producer needs from the outside world is cooling for its
waste heat — it never takes part in the heat side of things at all, only cooling.

Right now, the only direct producer in the game is the wind turbine, and it's
very weak — any normal reactor-and-generator setup heavily outperforms it. In
practice, a wind turbine isn't a real competitor for tile space against a
reactor chain; it only makes sense in the very specific spots described under
[Building Tiers Matter A Lot](#building-tiers-matter-a-lot), where nothing else
would fit or pay off better.

### Cooler

A cooler soaks up waste heat from anything generating it nearby — generators and
direct producers alike. A single cooler's capacity can be spread across several
overheating neighbors at once, and a single overheating building can draw cooling
from several different coolers around it at the same time.

Cooling has no downside and no cost. If a cooler has spare capacity nobody needs,
it simply sits there unused — there's no penalty for that.

---

## How Heat and Cooling Actually Get Shared Out

Heat delivery and cooling delivery both work the exact same way — heat runs
first from start to finish, and only once every generator's heat is locked in
does cooling begin, working the same process over again for coolers and their
neighbors.

The process has two stages: an initial fair split, and then a cleanup pass that
fixes obviously bad splits.

### Stage One: The Fair Split

Each supplier (a reactor for heat, a cooler for cooling) is handled one at a
time, in the standard left-to-right, bottom-to-top order. When it's a supplier's
turn, it looks at all its eligible neighbors — the ones that still have room
left to receive more — and offers them an equal share each.

If a neighbor's equal share is more than that neighbor can actually use, the
neighbor just takes what it needs, and the leftover doesn't get evenly
re-divided among everyone else. Instead, the whole leftover amount is offered,
in full, to the next eligible neighbor in that same standard order. If that one
can't use all of it either, the remainder keeps moving down the line the same
way, until it's all been placed or there's nobody left who can take any more.

For example: a single supplier with 100 units, next to three neighbors that can
hold 100, 100, and 10. Everyone gets offered 33.33 first. The small neighbor can
only use 10 of that, so 23.33 stays with the supplier. On the next pass that
23.33 is offered again, split evenly between the two neighbors that still have
room — leftovers get re-divided, never dumped whole on one neighbor.

The catch is that a supplier only gets as many passes as there are suppliers it
is actually connected to — counting only the ones that share a neighbor with it,
directly or through a chain. Suppliers elsewhere on the island, or on another
island entirely, do not count. With a single supplier there is only one pass, so its 23.33 never
gets re-divided at all — the cleanup pass below picks it up instead, and the
cleanup pass _does_ hand things over one neighbor at a time. That's why this
particular example ends up 10 / 57 / 33 even though the fair split itself would
have divided it evenly. Two or more suppliers competing for the same neighbors
is where the difference actually shows.

If a supplier still has leftover amount after all its passes and nobody can take
any more, that leftover is simply lost. It's not an error, and it's not held onto
for later — the supplier just ran at less than full effect for this round.

### Stage Two: Fixing the Splits

The fair split only looks at one supplier at a time, so it can leave things
lopsided when multiple suppliers are involved. The cleanup pass looks across
all of them together and looks for cases where reshuffling would let more total
heat, or more total cooling, actually get delivered and used.

Concretely: if a neighbor is currently getting some of its supply from a
supplier that could have reached other neighbors too, but a different, more
limited supplier — one that can _only_ reach that same neighbor — turns out to
be able to satisfy it directly, the more flexible supplier's allocation to that
neighbor gets pulled back. That freed-up amount then gets handed out again,
following the exact same "whole amount to the next eligible neighbor in
standard order" rule the fair split used.

This reshuffling only happens when it would genuinely deliver more total heat
or cooling than before — it never happens just to make things look more even.
And if freeing something up only partially helps (say, it takes a neighbor from
half-supplied to mostly-supplied but not all the way), that's still worth doing,
but it won't cause anything else, unrelated, to get rebalanced along with it. The
cleanup pass can also happen more than once in a row, since fixing one situation
can sometimes open the door to fixing a second one elsewhere.

One consequence of all this: because suppliers are handled one after another
rather than all at once, which supplier happens to go first can change the final
result. The exact same layout of buildings can end up delivering heat or cooling
differently depending on the order things are processed in — and that order is a
fixed, meaningful rule of the game, not just an implementation quirk.

---

## Cooling Is All-Or-Nothing

Once heat has been settled and every generator's power is locked in, cooling
gets distributed the same way. Then comes the real test: a generator or direct
producer only actually runs — and only actually produces its power — if the
cooling it received covers _all_ of its waste heat. Getting cooled exactly as
much as its waste amount is fine; that still counts as fully covered.

If it falls even slightly short, the building shuts down completely and
produces zero power. There's no partial credit, and nothing gets undone or
sent back — the heat it already received during heat delivery is not returned
to any reactor, and it can't be reassigned to a different generator just
because this building couldn't stay cooled. A building with no cooling routed
to it at all can never run, no matter how much heat it received.

---

## A Worked Example

Say a generator can hold up to 50 heat, and it sits next to two reactors: a
small one that can put out 30, and a large one that can put out 100. A second
generator, also able to hold 50, sits next to only the large reactor.

If the large reactor happens to be processed first, it splits its heat evenly
between both generators it can reach — 50 to each, which happens to exactly
fill both of them. When the small reactor is processed after that, it finds
its one neighboring generator already completely full, so its entire output
goes unused. There's nothing for the cleanup pass to fix here, because the
first generator isn't partially filled — it's already maxed out, so there's
no leftover to reclaim.

If the order were reversed instead, the small reactor would fill part of the
first generator first, and the large reactor — going second — would top off
the rest of that generator and then give the second generator its full share,
with a bit of its own output left over unused once the second generator
reaches its cap. Either way, the same total amount of power ends up getting
delivered — it's just a different reactor's output that goes to waste. The
cleanup pass only actually reclaims and reroutes something when a generator is
left partially filled by one reactor while another reactor could have topped
it off directly — not in a case like this one, where a single reactor already
saturates a generator on its own.

Only once every generator's final heat amount is locked in does cooling
begin — any coolers nearby then go through the exact same fair-split-then-
cleanup process to decide how much cooling actually reaches each generator,
and from that, which ones stay online.

### A Variant Where the Cleanup Pass Actually Does Something

Change the second generator's cap from 50 to 100, so now the setup is: a
50-capacity generator that can reach both reactors, and a 100-capacity
generator that can reach only the large one.

If the large reactor still goes first, it fair-shares its 100 evenly again —
50 to each generator. The 50-cap generator is now completely full, but the
100-cap generator still has 50 of room left, since it only received half of
what it could hold. The small reactor then runs, finds its only neighbor (the
50-cap generator) already full, and its 30 initially has nowhere to go.

This is where the cleanup pass has real work to do. The 50-cap generator's
current supply — 50 from the large reactor — could just as easily come from
the small reactor instead, since the small reactor can reach it directly. So
the cleanup pass reclaims that allocation: the small reactor now feeds the
50-cap generator (30, with the generator needing 20 more, still supplied by
the large reactor), and the 30 units of large-reactor output that this frees
up get handed to the 100-cap generator, which still has room to use them.

The end result is the small reactor's output no longer goes to waste, and the
100-cap generator ends up with 80 instead of 50 — 130 total power delivered
instead of 100. This is the situation the cleanup pass exists for: a generator
with only one possible supplier gets to "claim priority" on that supplier,
freeing up a more flexible supplier to help elsewhere.

---

## What You're Actually Optimizing For

Given a grid of tiles — some blocked, some open — and whichever building tiers
you've unlocked so far, the goal is to decide what to place on every buildable
tile, including deciding to leave some tiles empty, so that the total
electricity produced by everything that stays running is as high as possible.

A few things always hold true no matter how you arrange things:

- Only one building per tile, and only on buildable ground.
- Nothing can interact with anything outside its immediate neighborhood.
- A reactor can never send out more heat than its own maximum.
- A generator can never take in more heat than its own maximum.
- Heat is always settled completely before cooling is even looked at.
- A generator or direct producer only contributes power if it's fully cooled.

And ultimately, what matters isn't how many buildings you've placed, or how much
heat or cooling moved around the grid — it's the total amount of power actually
being produced by whatever's still online at the end.

---

## Anomalies

Prestiging ("Time Jump") ends a timeline and starts a new one, and on the way
out the player picks an **anomaly**: a rule change that applies for the whole of
the next timeline. Exactly one is active at a time, and "no anomaly" is a real
option rather than a missing value — it means the rules exactly as described
above.

An anomaly never adds a building, removes one, or changes the grid. It changes
either **what a placed building's figures are** or **how a supply gets shared
out**, and the three that exist so far divide cleanly along that line.

### The figures an anomaly scales

Every stat anomaly so far scales a building **uniformly**: the same multiplier
lands on all of its authored figures at once. The game's wording lists them
separately — "Energy, Heat, Cooling, and overheat capacity" — but those four
names are one field each across the four roles:

| the game says      | the figure                                          |
| ------------------ | --------------------------------------------------- |
| Heat               | a reactor's output, a generator's intake capacity, a direct producer's own heat |
| Energy             | what a generator or direct producer puts out at full |
| Cooling            | what a cooler absorbs                                |
| overheat capacity  | the waste heat a generator or direct producer makes at full, and therefore what must be cooled for it to stay online |

So a building with a ×1.67 bonus is simply a building whose whole tier is worth
1.67× as much: it absorbs more, produces more, and needs proportionally more
cooling. A bonus is **not** free power on its own — it moves the whole balance
of a layout, and a scaled producer that outruns its coolers goes offline like
any other.

The multiplier is applied to the authored figure at solve time and is not
snapped back to the game's authored precision, because it is a runtime
multiply rather than a table entry.

### Cryo Nexus — one shared cooling pool

> All Heat Sinks on an island add their Cooling to one shared pool. It can cool
> every Power Source on that island, no matter how far away it is. If there is
> not enough Cooling, every Power Source receives the same percentage of what it
> needs. Each Heat Sink contributes ×0.88 of its normal Cooling. Cooling does
> not carry over to other islands.

This replaces the cooling half of the distribution wholesale. Adjacency stops
mattering for cooling, and so do the fair split and the cleanup pass — there is
one number for the island and one rule for handing it out. Heat delivery is
untouched: reactors still only reach adjacent generators, and heat is still
settled first.

Two consequences fall straight out of it, and both matter more than the rule
itself:

- **Coolers stop competing for tile space near producers.** A cooler anywhere on
  the island is worth exactly as much as one wedged between two generators, so
  the layout problem collapses to "how much total cooling do I buy, and where do
  I spend the tiles I have left".
- **Cooling becomes all-or-nothing for the whole island at once.** Every power
  source gets the same percentage of what it needs, and a building only runs if
  it is covered in full — so either the pool covers the island's entire waste
  and everything runs, or it falls short and *every* power source on that island
  shuts down. There is no partial board.

The ×0.88 is a straight tax on each cooler's contribution, applied before
anything is shared.

**"An island" here means the whole map.** Gale Hills is an island; so is Ash
Bay. The rule is board-wide: every cooler anywhere on the map pays into one
pool, and every power source anywhere on the map draws from it. "Cooling does
not carry over to other islands" means it does not carry to a *different map* —
there is nothing finer than the board for this pool to respect.

This is the one rule in the game that reaches across the whole board, and every
other rule in this document is the opposite: adjacency-bound, which is why a
board splits into independent patches of connected grass and each can be solved
on its own. Under this anomaly they are not independent.

They are still *nearly* independent, and the shape of what survives is worth
being precise about, because it is the whole basis of solving this efficiently:

- **Heat is untouched.** Reactors still only reach adjacent generators, so which
  buildings a patch can bring online, and how much power it makes, is still a
  question about that patch alone.
- **The patches are coupled by exactly two numbers.** A layout on a patch makes
  some power, generates some waste, and contributes some cooling; the board runs
  on whether the cooling *summed over every patch* covers the waste summed over
  every patch. Nothing else crosses.

So a patch is no longer described by "the most power it can make" but by a
trade-off: how much power it makes for a given amount of cooling it puts into
the pool over what it takes out. It can run a producer it cannot cool and let
the rest of the board pay for it, or pave itself in coolers and produce nothing
but surplus.

And because cooling is all-or-nothing, and every power source gets the same
percentage, **the whole board is all-or-nothing together**: either the pool
covers the board's entire waste and everything runs, or it falls short and every
power source on the map produces nothing. There is no partial board and no
partially-lit patch.

One smaller consequence: a patch too small to work normally becomes usable, since
it no longer needs a cooler of its own. A lone grass tile with a direct producer
on it runs off the pool. That is worth having but it is not much — the shipped
maps lose between 0 and 6 tiles to patches below the minimum size, out of boards
of 49 to 184 grass tiles.

### Tidal Ascendancy — a bonus for building on the shore

> Production buildings next to water get a ×1.67 multiplier. Corners count too.
> The bonus affects Energy, Heat, Cooling, and overheat capacity. Buildings away
> from water work normally and get no bonus.

A per-tile uniform scale, decided by terrain alone: a building is scaled if any
of the eight tiles around it is water. Nothing about the layout can change which
tiles qualify, so this is a fixed per-tile multiplier the solver can compute once
per island and then treat as part of the board.

It is the first rule in the game where a non-buildable tile does anything at all.

**A pond is not water.** It is an obstacle — scenery you cannot build on, like a
rock or a tree — and it grants no shore bonus. Only the water tile proper does.

The bonus is not a rare one: between 36% and 44% of the grass on every shipped
map is water-adjacent, so on any of them something close to half the buildable
board is worth ×1.67. That makes the shoreline the most valuable ground on the
map and this anomaly a genuine change of shape rather than a modifier, since the
best layout under it wants its producers on a coastline whose length is fixed by
the terrain.

### Singularity Isolation — generators want elbow room

> A Generator with no other Generator next to it gets ×2.5 Energy output, Heat
> output, and overheat capacity. If another Generator touches it, including at a
> corner, those values drop to ×0.8. More neighbours do not make the penalty
> worse.

Unlike the other two, this one depends on **the layout itself**: a generator's
figures are a function of what its neighbours are, so they change as the search
moves buildings around. It cannot be folded into the board or into the roster,
and it is the reason a placed building's resolved figures have to be computed
per layout rather than once per tile.

The threshold is binary — one adjacent generator costs the same as five — so the
rule is a two-way test, not a count.
