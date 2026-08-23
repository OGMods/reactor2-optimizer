# py_solver

The reference implementation of the reactor layout optimizer: given an island
and a roster of reactors, generators and coolers, decide which building goes on
which tile so the board produces the most power.

It is a standalone Python program — pure stdlib for the solver and its tests,
with Pillow used only to draw the result. It is also the **upstream** of the
TypeScript solver that ships in the web app: algorithm changes are prototyped
here first and then ported, and when the two disagree, this tree is right. See
[`docs/PARITY.md`](../docs/PARITY.md) for the file-by-file mapping and every
intentional divergence between them.

## Requirements

- Python 3.10 or newer (CI runs the suite on 3.10 and 3.12)
- Pillow, for the PNG renderer only

```bash
pip install -r requirements.txt
```

## Running it

All commands are run from this directory.

```bash
python3 main.py                      # one 30s run on the default map (island 1)
python3 main.py --map 3 --time 60    # one 60s run on island 3
python3 main.py --map 2 --map 5      # solve two islands
python3 main.py --all --runs 3       # 3 runs on every map, best-of comparison
python3 main.py --map 1 --seed 7     # fix the search's random stream
```

Each run prints a summary — total power, the theoretical upper bound, layout
efficiency and the tile count — and writes an isometric PNG of the layout to
`solves/`.

| Flag        | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `--map NUM` | Map to solve; repeatable. Available: `0`–`8`                  |
| `--all`     | Solve every map                                               |
| `--runs N`  | Runs per map; more than one prints a best-of comparison table |
| `--time S`  | Time budget per run, in seconds (default: 30)                 |
| `--seed N`  | Base seed for the search's random stream                      |

The maps are blueprint codes in [`data/maps.py`](data/maps.py). Map 0 is a small
9×10 custom board useful for quick iteration; 1–8 are the shipped game islands,
from 67 up to 251 buildable tiles.

**A run is bounded by wall-clock time, not by convergence.** The search improves
a layout until its budget runs out, so a longer `--time` is a better answer and
there is no point at which it declares itself finished.

**The search is stochastic**, so two runs of the same map at the same budget
will differ. `--seed` fixes the move sequence but _not_ the result: stage
deadlines are wall-clock, so seeding narrows run-to-run variance rather than
eliminating it. Use `--runs` to see the spread.

## Choosing which buildings the solver may use

The solver only ever places buildings you have unlocked, at the tier you have
bought. That roster is `UNLOCKED_UPGRADES` in
[`data/buildings.py`](data/buildings.py) — a plain `building_id -> level index`
map, and the one thing in this tree you are expected to edit.

It ships unlocking everything at its top tier, which answers "what is the best
this board could ever do?". To answer "what is the best _I_ can build right
now?", replace it with a hand-listed progression — just the buildings you own,
each at the tier you own:

```python
UNLOCKED_UPGRADES: Dict[str, int] = {
    "coal_plant": 5,
    "nuclear_reactor": 3,
    "generator2": 4,
    "generator3": 0,
    "cooler1": 5,
    "cooler2": 2,
    "wind_turbine": 1,
}
```

Three rules govern that map:

- **The value is a 0-based index into that building's `levels` list, not the
  tier number the game shows you.** A building at tier 1 in-game is `0` here.
  Out-of-range values are clamped rather than rejected, so `99` is a safe way
  to say "max, whatever that is".
- **Omission means locked.** A building with no key is filtered out of the
  roster entirely and will never be placed. That is how you exclude something
  you own but do not want built — delete its line rather than setting it to `0`,
  which means "owned, at tier 1".
- **Buildings differ in how many tiers they have** (5 to 11 — `cooler6` has 11,
  `generator7` has 5), so there is no single "max" number to write.

A narrower roster changes the answer, not just the score: with only small
coolers available the search packs tiles differently, so a layout solved at full
unlocks is not the layout you should build at half of them.

`BUILDINGS` above it is **generated** — an external extraction script reads the
game's own data and splices that table in wholesale, so don't hand-edit it.
`UNLOCKED_UPGRADES` sits below it, is hand-owned and survives regeneration,
which is exactly why it is the safe thing to change.

Re-run `python3 main.py` afterwards, and `python3 -m parity.export_fixtures` if
you maintain the fixtures — each one records the roster it was made with. The
`full_upgrades_seed1` fixture asks for max level regardless, so it stays a
wide-search-space case whatever you set here.

## Tests

```bash
python3 -m unittest discover                      # the whole suite (~35s)
python3 -m unittest tests.test_distribution -v    # one module, verbose
```

Stdlib `unittest` — nothing to install. The suite also runs under pytest
unchanged (`pip install pytest && pytest`) if you prefer.

The layers worth knowing: `test_distribution.py` and `test_simulate.py` are
derived from the rules in [`docs/game-logic.md`](../docs/game-logic.md),
so a failure there means the change contradicts the spec rather than the test.
`test_golden_layouts.py` pins brute-force-verified optima for small islands —
those figures are proven and must never go down. `test_search.py` and
`test_pipeline.py` carry quality floors on real maps, which a deliberate
behaviour change is expected to move. [`CLAUDE.md`](CLAUDE.md) has the full
breakdown.

## How it works

The rules being implemented — adjacency, the heat and cooling flow model, the
all-or-nothing cooling threshold — are specified in
[`docs/game-logic.md`](../docs/game-logic.md). Read it before changing anything
under `solver/`.

The pipeline, in brief:

1. **Island decomposition** (`solver/island.py`) splits the grid into 8-neighbor
   connected components of buildable tiles. Placement in one island cannot
   affect another, so each is solved independently and the time budget is split
   between them by tile count.
2. **Placement search** (`solver/placement_search.py`) runs per island: seed
   construction, repair, composition retargeting, simulated annealing, pruning,
   and a final right-sizing pass that swaps oversized coolers down to the tier
   the tile actually needs.
3. **Simulation** (`solver/simulate.py`) scores one fixed layout — the hot path,
   called millions of times per solve. Heat and cooling are each routed by
   `solver/distribution.py`, a port of the game's own flow solver
   ("FairShare + Augmenting Repair").

A returned layout is always **stable**: every generator it places actually runs.
A layout can score higher by parking reactor heat in a generator that is never
cooled, and that is still the wrong answer.

```
py_solver/
  main.py            CLI: decode a map, solve it, render it, report on it
  blueprint.py       the layout codec (deflate + base64url), shared with the web app
  grid.py            tile predicates and the ASCII tile alphabet
  formatters.py      the game's compact suffix notation (K, M, B, T, AA...ZZ)
  solver/            the optimizer
  data/              the building roster and the island maps
  render/            Pillow isometric renderer
  parity/            golden-fixture export for the TypeScript port
  tests/             stdlib unittest suite
```

## Notes

- `render/` reads the web app's sprite atlas from `public/data/` at the repo
  root rather than keeping a second copy, so this directory is **not** portable
  out of the repo as-is. Everything except the renderer is.
- To regenerate the parity fixtures the TypeScript suite replays:

  ```bash
  python3 -m parity.export_fixtures
  ```

  They are written straight to `parity/fixtures/` at the repo root, which is the
  only copy — the TypeScript suite reads that directory and this tree keeps
  none of its own.
