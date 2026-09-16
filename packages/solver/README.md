# @reactor2/solver

The layout engine behind [reactor2-optimizer](https://ogmods.github.io/reactor2-optimizer/):
the rules of _Reactor 2: Nuclear Tycoon_, its building roster, the blueprint
wire format, and a near-optimal placement search over them.

**No runtime dependencies.** Everything under `src/` is importable into a Web
Worker — that is what the app does with it — so it reaches for no npm package
and no DOM library. Platform globals it does use (`CompressionStream`,
`MessageChannel`, `performance`) are ones Node and the browser both have.

## Using it

```ts
import {
  BUILDINGS,
  allUpgradesUnlocked,
  decodeBlueprint,
  solve,
} from "@reactor2/solver";

const { grid } = await decodeBlueprint(shareCode);
const result = await solve(grid, [...BUILDINGS], allUpgradesUnlocked(), 30);

console.log(result.totalPower, "of", result.theoreticalMaxPower);
```

`solve()` is budgeted in seconds, not iterations: the search has no natural end,
so you tell it how long it may take. `theoreticalMaxPower` is a true upper bound
for that grid and roster — no layout can beat it — which is what makes
"efficiency" mean something.

Other things worth knowing about:

- `simulateIsland(placement, ctx)` scores a fixed layout, which is what you want
  for a board someone placed by hand.
- `encodeBlueprint` / `decodeBlueprint` / `blueprintKey` are the wire format.
  **Never compare encoded codes** to test whether two layouts match — DEFLATE is
  only required to round-trip. `blueprintKey` compares the uncompressed payload.
- `ISLAND_TEMPLATES` is the shipped island set, as blueprint codes.
- `formatNumber` spells a figure the way the game does (`71.7AB`).

## The CLI

```bash
npx reactor2-solve                          # one 30s run on island 1
npx reactor2-solve --map 3 --time 60
npx reactor2-solve --all --runs 3
npx reactor2-solve --map 7 --attempts 100 --time 20
npx reactor2-solve --help
```

`--attempts` runs a batch session: N whole solves through a worker pool, with a
leaderboard of distinct layouts at the end. Ctrl-C stops it and still prints the
report.

Each run writes its blueprint code to `solves/`, named after the power it found
(`3_island_7_2_91AC-296AB.txt`). Paste one into the app's Import dialog to see
the board.

## Working on it

From the repository root:

```bash
npm test                # this package's suite runs with the app's
npm run check           # typecheck
npm run solve -- --help # the CLI, from source
npm run fixtures        # regenerate the golden fixtures
npm run build:solver    # build the publishable dist/
```

The app imports this package's TypeScript source through the workspace link, so
there is no build step between an edit and a reload.

Before changing the search, read [`docs/SOLVER.md`](../../docs/SOLVER.md) and
[`docs/game-logic.md`](../../docs/game-logic.md). Two things in particular are
easy to break without noticing: the RNG's pinned golden streams, and the proven
optima in `tests/goldenLayouts.test.ts`, **which must never go down**.

## License

GPL-3.0-or-later. Copyright (C) 2026 OGMods.
