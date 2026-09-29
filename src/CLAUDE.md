# CLAUDE.md — styling and the mobile shell

Loaded when working under `src/`.

## Styling and the mobile shell

`src/app.css` is the token layer: the z-index scale, the colour law below, four
ladders (radius, type and control heights, the last including the `--tap`
floor), the
`env(safe-area-inset-*)` aliases, and the `.ribbon` / `.thin-scroll` / `.sr-only`
helpers.

**Never hard-code a z-index** — every layer has a token, and before they existed
the header, HUD, palettes and inspector all sat at `10` and stacked by whatever
order `App.svelte` happened to mount them in. Two layers sit at a token minus one,
and both are the same lesson. `PreviewBanner` is `calc(var(--z-header) - 1)`: it is
header chrome and shares the token, but it mounts _after_ the header, and at an
equal z-index DOM order decides — which put a status line over everything the
header opens. The overflow menu is a plain absolutely-positioned child of a bar
with a z-index of its own, so it is sealed inside that stacking context and cannot
climb out to reach a sibling; the bar underneath has to yield instead — which is
also the honest reading, since the header's controls belong over a status line.

Note `--z-sheet` deliberately outranks `--z-header`: the mobile sheet is 90dvh at
its `full` detent, so it has to cover a top-anchored header.

**A floating menu needs a bound.** `OverflowMenu` caps itself at
`100dvh - var(--header-clearance) - var(--safe-bottom) - 1.5rem` and scrolls
inside it. That list only grows, and unbounded it simply ran off the bottom of the
screen — and since the page cannot scroll (`html, body { overflow: hidden }`) and
the menu is absolutely positioned, rows past the fold were not awkward to reach but
_unreachable_.

### The ladders

Three scales in `app.css`, because the same kind of thing was otherwise sized a
different way by each author: **radius** (`xs` chips, `sm` buttons/rows,
`--radius` panels, `md` ribbon items, `lg` the sheet, `pill` for anything whose
radius is half its height), **type** (seven steps), and **control heights**
(`--ctl-sm` 32px inline steppers, `--ctl` 36px secondary, `--tap` 44px for
anything a thumb must hit). The audit is
`grep -rn "font-size: [0-9]" src/lib/components`, which should stay empty of
`rem`.

Two values are deliberately **off** the ladders, and both say so in place: the
Import textarea is pinned at `16px` because iOS Safari zooms the page in on a
focused field under that, and `BuildingUnlockCard`'s stat rows are a px-based
sub-layout of their own.

`--text-dim` is `#7d8da4` rather than the `#64748b` it looks like it wants to be:
it is the colour of nineteen small labels, and the darker value is 3.4:1 against a
panel — under WCAG AA. Measure against the _lightest_ backdrop a panel makes
(roughly `#112226`), not `--surface-void`, because light text loses contrast on
the lighter one.

### Tokens are named for the role, never the colour

`--accent` was called `--neon` until a theme made it purple, at which point the
name was simply wrong in half the app — and a wrong name is worse than a vague
one, because it reads as true. The same trap is waiting for anything spelled
`--purple`, `--amber` or `--cyan`: a themed token names **what the colour is
for**, and a theme decides what it holds.

Two corollaries. `--action` is a separate token from `--accent` even though the
base theme answers both with the same cyan — they are different roles (a fill
carrying ink, against a stroke on a dark ground) and a theme separates them, so
collapsing the two would only have to be undone. And `ACCENT` in
`pixi/gridPainter.ts` keeps the value as a numeric literal because Pixi cannot
read a custom property: it is pinned to the **base** theme and says so, since a
name promising it follows the shell would be the same lie again.

### The colour law

The law lives at the top of `app.css`, one line each. Without it the palette
drifts to twelve-odd hues — a Share button wearing the colour the board uses for
"idle", grass painted the green that means "working":

|                 | means                                                       |
| --------------- | ----------------------------------------------------------- |
| `--accent`      | this control is selected / active. Nothing else.            |
| `--action`      | the one *filled* primary control. RUN, and nothing else.    |
| `--status-ok`   | the board only: this building is working.                   |
| `--status-idle` | the board only: this building is doing nothing.             |
| `--danger`      | the board: overheating. In the UI: this destroys something. |
| `--warn`        | a limit is reached, or this board is not yours to edit.     |
| `--anomaly-*`   | `AnomalySelector`'s cards only, and nowhere else.           |

The first two are themed, the four below them never are — see the theme block
in `app.css`. `--anomaly-*` is neither: it is the game's own chooser palette,
not a theme, which is why it kept its name while the purple that used to share
that prefix became the anomaly theme's binding of `--accent`, `--text` and the
rest.

**The two board readings are reserved, and that is the whole point.** The pad under
every building, the pulse that breathes it and the readout in the corner all speak
them, so a player who has learnt that language must not meet it again on a button
that has nothing to do with it. `--status-idle` is `#facc15`, matched to the
`indicator_idle` pad so the tile and the card describing it are one yellow rather
than two. A control earns colour by being selected, or
destructive, or neither — and _neither_ is most of the header.

Two things follow in the CSS. `:global(.tool-btn.active)` in `HudToolbar` is the
single active rule for every tool button — `.erase-btn.active` is the one
override, two classes so it outranks, and red because it is the one tool that
destroys. And a control earns colour by being selected or destructive; _neither_
is most of the header.

One hue sits outside the law and says so in the file: `--heart`, for the donate
button, because a donate heart is pink everywhere on the web and `--danger` would
tell the user the button breaks something.

**The anomaly cards' green/red pair is the second exception, and it is a
narrower one.** `--benefit-*` and `--drawback-*` are sampled from the game's own
"Choose an anomaly" screen — both stripe fills and the text on each — because
that is the one screen in the app mirroring a screen in the game: the player has
just chosen there and is confirming here, so the pairing they read a moment ago
is worth more than a palette of our own. They are **not** `--status-ok` and
`--danger`, which stay reserved to the board, and reusing those would not even
have looked right: the board speaks as a saturated accent on a dark ground, these
are muted fills carrying near-white text. A player meets them as panels, not as
status lights, which is what keeps the reservation honest.

**`--anomaly-selected` is the sharper half of that exception**, because `--accent`
means selected everywhere else and on this list it does not: the chosen card is
ringed in the game's own green. Two selection colours is a real cost, and it is
taken for the same reason and stretches no further — showing a player their own
choice in a colour they will not recognise from the screen they made it on is the
larger one. Nothing outside `AnomalySelector` may take it.

**An anomaly is a theme, not a hundred conditionals.** `App.svelte` — the one
place allowed to see `configState` beside everything else — puts
`data-theme="anomaly"` on `.app-shell` while one is selected, and a single
block in `app.css` rebinds the tokens under it. Every surface inside the shell
follows: the header, the HUD's pills and ribbons, the readout, Setup, the
overflow menu, the dialogs, the toast. No component reads `hasAnomaly` and none
of them carries a rule about anomalies at all.

It replaced eleven copies of the signal — ten components each with
`class:anomalous={configState.hasAnomaly}` and a `.anomalous` rule re-pointing
*a different subset* of the same tokens, which is exactly how the HUD's ground
went purple while the selected tool on it stayed cyan, and how
`BuildingPalette` came to remember `--text-dim` where `ObstaclePalette` beside
it did not. Every new panel was another place to remember, and forgetting was
silent.

Keyed on the selection and not on Setup's Time Lab tab, because that is what it
says: this timeline is not running the ordinary rules, and the island list, the
roster and the board's figures are all read under them. Nothing selected leaves
the attribute off and every token falls back to the navy in `:root`, which is
the common case.

Four things about what a theme may and may not move:

- **Alpha is the component's, hue is the theme's.** Each surface picks its own
  strength over the board — the sheet 0.97, the readout 0.94, the HUD's pills
  0.92, the docked panel 0.88 — by composing `rgba(var(--surface-panel-rgb),
  …)`. That is why the ground is a bare triplet rather than a colour: one
  decision, not one token per surface. Selecting an anomaly changes the hue and
  nothing about how much board shows through.
- **The whole `--accent` family goes**, so every mark meaning "selected" follows
  the ground under it: Setup's heading, its active tab, the chosen island's
  row, the roster's category pills, the HUD's active tool, the selected
  building in the palette, the readout's accents. The purple is **lighter**
  than the game's badge purple, and that is forced — cyan earns its prominence
  by contrast, and the badge purple reads 3.3:1 on this panel, unreadable as a
  heading. `#c9a5f0` puts back the 6.5:1 the cyan had.
- **`--action` is a separate role from `--accent`, and this is what it is for.**
  RUN is the one *filled* control in the app: a fill carrying ink, where
  brighter is *less* legible, against `--accent`'s stroke-on-dark, where brighter
  is more. The base theme answers both with the same cyan, which is why they
  looked like one token until a theme needed them apart — the selection
  lavender carries neither ink at AA, so `--action` is the badge purple pulled
  two steps down its own ramp (5.4:1 resting, 4.8:1 hover; RUN is 12.8px bold,
  so 4.5 is the bar). Stop is untouched either way: a stop is destructive of
  the run in progress whatever rules it began under.
- **The board's own language is never rebound.** `--status-ok`,
  `--status-idle`, `--danger` and `--warn` stay out of every theme. The pad
  under a building, the pulse that breathes it and the readout's red Cooling
  row mean the same thing under every timeline, and an anomaly is precisely
  when a player most needs them to.

**The game's chooser palette is not a theme either**, and that is the other
half of the split: `--anomaly-card`, `--anomaly-selected` and the
benefit/drawback pair are `AnomalySelector`'s own colours, sampled from a
screen in the game, and they do not move with the ground. They stay in `:root`
for that reason — only the ground under them is themed. Two of the three text
values are **lifted** off what the game uses, since its secondary lavender
measures 3.8:1 on this panel, under AA — the same trap `--text-dim` was lifted
out of once already.

That leaves two purples meaning "selected" inside Setup, which is deliberate:
the lavender is the **app** saying which tab or row you are on, while the green
ring on an anomaly card is the **game's**, and the card is a second view of the
game's own chooser.

That list also **stays compact until a card is chosen** — the unselected size is
the default and `.active` is what loosens it (a larger icon, roomier panels, and
the full rule). Three of the four describe a timeline nobody is in, and sizing it
this way makes the selected card obvious by shape as well as by colour, which is
the reading that survives a colourblind viewer.

### Overflow and viewport rules

Two overflow rules look like formatting and are not. Both were found by driving the
built app in a real browser, and neither shows up until a player unlocks a full
roster — which is to say, in normal play but never in a quick smoke test:

- **`.scroll-body` needs `min-height: 0`.** A flex item's automatic minimum size is
  its _content_ size, so `flex: 1` alone cannot shrink a list below the height of
  every card in it. Without it a full 38-building roster refuses to shrink and
  overflows the sheet. `.sidebar-panel` clips its own overflow, which is why only
  the phone ever showed it.
- **`.app-shell` uses `overflow: clip`, not `overflow: hidden`.** The mobile sheet
  is hidden by translating it a full sheet-height down, and a transformed element
  still contributes **scrollable overflow**. `hidden` makes a box unscrollable _by
  the user_ but leaves it a scroll container, and the browser will scroll one itself
  to bring a focused element into view — so tapping a control in the roster slid
  the whole app up with no scrollbar to put it back. `clip` creates no scroll
  container at all. The `hidden` declaration stays above it as the
  fallback.

Two more the layout depends on:

- **`100dvh`, not `100vh`.** `vh` freezes at the viewport's _largest_ size, so on
  iOS Safari the HUD sat under the collapsed URL bar.
- **`index.html` asks for `viewport-fit=cover`.** Without it every
  `env(safe-area-inset-*)` resolves to `0px` and the safe-area padding silently does
  nothing.

Touch-target bumps are keyed on `@media (pointer: coarse)`, not a width breakpoint,
for the same reason `viewportState` splits the two axes.
