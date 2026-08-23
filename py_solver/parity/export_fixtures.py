"""
Exports golden fixtures for the TypeScript parity test suite.

    python3 -m parity.export_fixtures

Each case is written to `<repo root>/parity/fixtures/<name>.json`. Re-running with an
unchanged solver reproduces every file byte for byte; that property is what
makes a diff in `parity/fixtures/` a trustworthy signal that solver behaviour
moved.

Terrain is carried as a blueprint code (`blueprint.py`), the same format the
maps and the app's share codes use. Note the fixture is only reproducible
because CPython's zlib is deterministic *for a given interpreter*: the TS suite
decodes the code, it never re-encodes and compares strings. See the "codes are
not comparable, payloads are" note in `blueprint.py`.

WHY THIS DOES NOT CALL solve()
------------------------------
`solve()` is wall-clock budgeted at every stage, so a fixed seed narrows
run-to-run variance without eliminating it: the same seed and grid produce a
different layout depending on how many steps fit in the budget on the day. That
is correct for production and useless for a golden fixture.

So the fixtures replay the deterministic core instead, which is the path
`CLAUDE.md` designates as the cross-language oracle: seed construction (already
deterministic), then `_hill_climb` driven by `max_steps` rather than a deadline,
with a fixed `Rng`, then the standard prune. Every wall-clock deadline handed to
that path is far enough out that it can never fire, so step count -- not elapsed
time -- decides where the walk stops.

`_stage_island_solve` below mirrors `solve_island`'s stage order for the stages
it can replay. It deliberately omits the composition-retarget and greedy-polish
stages: those are `while time.time() < deadline` loops with no step cap, so
there is no way to replay them deterministically without changing the solver.
The TS side must replay this same reduced pipeline, not `solver.ts`'s full one.

TWO EXPECTATION LAYERS, AND WHY
-------------------------------
`expected` is exported with the annealing walk DISABLED (`max_steps=0`), and is
asserted exactly by the TS suite. `annealed` runs the walk and is asserted only
within a relative tolerance.

The split is forced by floating point, not by caution. The annealing walk is the
only part of the solver that calls transcendental functions: `(t_min/t_start) **
progress` for the temperature and `math.exp(exponent)` in the Metropolis test.
IEEE-754 does not require `pow`/`exp` to be correctly rounded, and CPython's
libm and V8 measurably disagree by 1 ULP on values this solver actually hits.
One ULP of temperature is enough to flip a single acceptance, after which the
two walks diverge permanently -- observed at step 1280 on a 3x3 island.

Everything else in the solver -- seed construction, `simulate_island`,
`run_distribution`, `_stabilize`, `_prune_dead_weight`, island splitting and
placement remapping -- is pure +-*/ and comparison on doubles, which IS
bit-identical across the two languages. That is exactly the set `max_steps=0`
exercises, which is why `expected` can be pinned exactly.
"""

import json
import pathlib
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from data.buildings import BUILDINGS, UNLOCKED_UPGRADES
from data.effective_buildings import get_effective_buildings
from blueprint import decode_blueprint, encode_blueprint
from grid import TILE_CHAR_MAP, count_grass_tiles
from solver.island import split_grid_into_islands
from solver.placement_search import (
    _buildable_tiles,
    _construct_multi_start_seed,
    _hill_climb,
    _prune_dead_weight,
)
from solver.rng import Rng
from solver.rules import build_neighbor_map
from solver.solver import _remap_placements
from solver.types import EffectiveBuilding, IslandSubGrid, PlacedBuilding, Tile

# One canonical location, at the repo root: the TypeScript suite reads these
# and a second copy under py_solver/ would be free to drift from it. Writing
# them out rather than up keeps the direction of the dependency right -- the
# web app never reaches into the Python tree to run its own tests.
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "parity" / "fixtures"

# Every deadline in the replayed path is set this far out, so none can fire and
# step count alone decides where the walk stops.
UNREACHABLE_DEADLINE_S = 1e6

# Floats are rounded to this many decimals before serialization so the JSON is
# stable across Python versions and platforms.
FLOAT_PRECISION = 9

CHAR_BY_TILE_TYPE = {tile_type: char for char, tile_type in TILE_CHAR_MAP.items()}


def _grid_from_rows(rows: Tuple[str, ...]) -> List[Tile]:
    """Builds a tile grid from the case's ASCII picture."""
    return [
        [Tile(x=x, y=y, type=TILE_CHAR_MAP[char]) for x, char in enumerate(row)]
        for y, row in enumerate(rows)
    ]


@dataclass(frozen=True)
class FixtureCase:
    name: str
    why: str
    rows: Tuple[str, ...]
    seed: int
    max_steps: int
    unlocked_upgrades: Optional[Dict[str, int]] = None


def _max_level_upgrades() -> Dict[str, int]:
    """Every building in the roster, unlocked at its highest tier."""
    return {b.id: len(b.levels) - 1 for b in BUILDINGS if b.levels}


CASES: Tuple[FixtureCase, ...] = (
    FixtureCase(
        name="single_tile",
        why="Degenerate island; catches empty-result and off-by-one handling",
        rows=("G",),
        seed=42,
        max_steps=200,
    ),
    FixtureCase(
        name="small_grid_seed42",
        why="Baseline; one island, small enough to diff by hand",
        rows=("GGG", "GGG", "GGG"),
        seed=42,
        max_steps=2000,
    ),
    FixtureCase(
        name="two_island_seed7",
        why="Exercises _remap_placements -- the highest-risk port surface",
        rows=("GGG.GGG", "GGG.GGG", "GGG.GGG"),
        seed=7,
        max_steps=2000,
    ),
    FixtureCase(
        name="three_island_uneven",
        why="Islands of very different sizes; catches per-island seed derivation",
        rows=(
            "GG.GGGG.GGGGG",
            "GG.GGGG.GGGGG",
            "...GGGG.GGGGG",
            "....GG..GGGGG",
        ),
        seed=13,
        max_steps=2000,
    ),
    FixtureCase(
        name="no_buildable_tiles",
        why="All-water grid; must produce the empty result, not an error",
        rows=("....", "....", "...."),
        seed=1,
        max_steps=200,
    ),
    FixtureCase(
        name="full_upgrades_seed1",
        why="Largest single island and longest walk; pins max level explicitly",
        rows=("GGGG", "GGGG", "GGGG", "GGGG"),
        seed=1,
        max_steps=3000,
        # Replaced with _max_level_upgrades() at export. That currently matches
        # UNLOCKED_UPGRADES, which unlocks everything -- but this case is the
        # one that must stay at max level whatever the checkout's progression
        # later becomes, so the guarantee is spelled out rather than inherited.
        unlocked_upgrades=None,
    ),
)

FULL_UPGRADE_CASES = {"full_upgrades_seed1"}


def _stage_island_solve(
    island: IslandSubGrid,
    roster: List[EffectiveBuilding],
    island_seed: int,
    max_steps: int,
) -> Tuple[List[PlacedBuilding], float]:
    """
    Deterministic replay of `solve_island`'s reproducible stages.

    Mirrors its roster partitioning and early-outs exactly; see the module
    docstring for which stages are skipped and why.
    """
    buildable = _buildable_tiles(island.grid)
    if not buildable:
        return [], 0.0

    neighbor_map = build_neighbor_map(buildable)

    reactors = sorted(
        (b for b in roster if b.type == "reactor"),
        key=lambda b: -b.effective_value,
    )
    generators = sorted(
        (b for b in roster if b.type == "generator"),
        key=lambda b: -b.effective_value,
    )
    coolers = sorted(
        (b for b in roster if b.type == "cooler"),
        key=lambda b: -b.effective_value,
    )
    direct_producers = sorted(
        (b for b in roster if b.type == "direct_producer"),
        key=lambda b: -b.energy,
    )

    can_hub = bool(reactors and generators)
    can_dp = bool(direct_producers)
    if not coolers or not (can_hub or can_dp):
        return [], 0.0

    deadline = time.time() + UNREACHABLE_DEADLINE_S
    placement = _construct_multi_start_seed(
        buildable, reactors, generators, coolers, direct_producers, deadline, neighbor_map
    )
    placement = _hill_climb(
        placement,
        buildable,
        reactors,
        generators,
        coolers,
        direct_producers,
        UNREACHABLE_DEADLINE_S,
        neighbor_map,
        rng=Rng(island_seed),
        max_steps=max_steps,
    )
    return _prune_dead_weight(placement, neighbor_map)


def deterministic_solve(
    grid: List[List[Tile]],
    roster: List[EffectiveBuilding],
    seed: int,
    max_steps: int,
) -> Tuple[List[PlacedBuilding], float, int]:
    """
    Deterministic replay of `solve()`: split, solve each island, remap to grid
    coordinates. Per-island seeds are derived exactly as `_solve_islands` does
    -- `(seed + i) & 0xFFFFFFFF` -- since that derivation is one of the things
    the TS coordinator has to reproduce.
    """
    if not grid or not grid[0]:
        return [], 0.0, 0

    original_width = len(grid[0])
    sub_grids = split_grid_into_islands(grid, roster)
    if not sub_grids:
        return [], 0.0, 0

    placements: List[PlacedBuilding] = []
    total_power = 0.0

    for index, sub_grid in enumerate(sub_grids):
        island_seed = (seed + index) & 0xFFFFFFFF
        local, power = _stage_island_solve(sub_grid, roster, island_seed, max_steps)
        total_power += power
        placements.extend(_remap_placements(sub_grid, local, original_width))

    return placements, total_power, len(sub_grids)


def build_fixture(case: FixtureCase) -> Dict:
    unlocked = (
        _max_level_upgrades() if case.name in FULL_UPGRADE_CASES
        else dict(case.unlocked_upgrades or UNLOCKED_UPGRADES)
    )
    roster = get_effective_buildings(BUILDINGS, unlocked)

    width = len(case.rows[0])
    grid = _grid_from_rows(case.rows)
    code = encode_blueprint(grid)

    # The code is the fixture's source of truth for terrain; make sure it decodes
    # back to the rows the case was authored with before anything depends on it.
    decoded = tuple(
        "".join(CHAR_BY_TILE_TYPE[t.type] for t in row)
        for row in decode_blueprint(code).grid
    )
    assert decoded == case.rows, f"{case.name}: blueprint round-trip failed: {decoded}"

    # Canonical order: flat tile index (y * width + x). Whatever order the
    # search produced is not reproducible and must never reach the file.
    def layer(max_steps: int) -> Dict:
        placements, power, island_count = deterministic_solve(
            grid, roster, case.seed, max_steps
        )
        ordered = sorted(placements, key=lambda p: (p.y * width + p.x))
        return {
            "placements": [
                {"x": p.x, "y": p.y, "building_id": p.building_id} for p in ordered
            ],
            "power_output": round(power, FLOAT_PRECISION),
            "island_count": island_count,
        }

    return {
        "name": case.name,
        "why": case.why,
        "seed": case.seed,
        "max_steps": case.max_steps,
        "grid": {"width": width, "height": len(case.rows), "code": code},
        "unlocked_upgrades": dict(sorted(unlocked.items())),
        "buildable_tiles": count_grass_tiles(grid),
        # Annealing disabled: pure arithmetic, asserted exactly by the TS suite.
        "expected": layer(0),
        # Annealing enabled: transcendental-dependent, tolerance-checked only.
        "annealed": layer(case.max_steps),
    }


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    for case in CASES:
        fixture = build_fixture(case)
        path = FIXTURES_DIR / f"{case.name}.json"
        # sort_keys is off on purpose: the key order above is the documented
        # schema order, and it is already deterministic.
        path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
        exact, annealed = fixture["expected"], fixture["annealed"]
        print(
            f"{case.name:22} islands={exact['island_count']} "
            f"exact={len(exact['placements'])}/{fixture['buildable_tiles']} "
            f"power={exact['power_output']:.6g}  "
            f"annealed={annealed['power_output']:.6g}"
        )


if __name__ == "__main__":
    main()
