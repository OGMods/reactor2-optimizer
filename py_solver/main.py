"""
Pipeline entry point: decode a map, solve it, render the layout to a PNG and
report on the result.

    python3 main.py                     # one 30s run on the default map
    python3 main.py --map 3 --time 60   # one 60s run on map 3
    python3 main.py --all --runs 3      # 3 runs on every map, best-of report
"""

import argparse
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

from data.effective_buildings import get_effective_buildings
from solver.types import EffectiveBuilding, OptimizationResult
from formatters import format_for_filename, format_number
from blueprint import decode_blueprint
from data.maps import DEFAULT_MAP_NUM, MAPS, MAPS_BY_NUM, GameMap
from render import IsometricRenderer, TextureAtlas
from solver import print_summary, solve, verify

SOLVES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "solves")
DEFAULT_TIME_LIMIT_S = 30.0

TEST_FILENAME_RE = re.compile(r"^test_(\d+)\.png$")
ISLAND_FILENAME_RE = re.compile(r"^(\d+)_island_\d+_\d+.*\.png$")


@dataclass
class SolveRun:
    run_num: int
    result: OptimizationResult
    elapsed_s: float
    output_png: Optional[str] = None


# --- Terminal progress ---------------------------------------------------

def update_progress(message: str):
    """Overwrites the current terminal line with progress text."""
    sys.stdout.write(f"\r{message:<80}")
    sys.stdout.flush()


def clear_progress():
    """Clears the progress status line in terminal."""
    sys.stdout.write(f"\r{' ' * 80}\r")
    sys.stdout.flush()


# --- Output files --------------------------------------------------------

def next_output_id(pattern: re.Pattern, solves_dir: str = SOLVES_DIR) -> int:
    """Next free leading id among files in `solves_dir` matching `pattern`."""
    if not os.path.exists(solves_dir):
        return 1
    ids = [
        int(match.group(1))
        for match in (pattern.match(name) for name in os.listdir(solves_dir))
        if match
    ]
    return max(ids) + 1 if ids else 1


# --- Solving -------------------------------------------------------------

def solve_map(
    game_map: GameMap,
    roster: List[EffectiveBuilding],
    renderer: IsometricRenderer,
    runs: int,
    time_limit_s: float,
    label: str,
    filename_for: Callable[[SolveRun, float], str],
    seed: Optional[int] = None,
) -> List[SolveRun]:
    """Solves one map `runs` times, rendering each run via `filename_for(run)`."""
    grid = decode_blueprint(game_map.code).grid
    results: List[SolveRun] = []

    for run_num in range(1, runs + 1):
        update_progress(f"{label} | Run {run_num}/{runs}...")
        # Offset the seed per run: with --seed, runs stay individually
        # reproducible without being copies of each other. The stride keeps
        # run streams clear of the per-island +i offsets applied in solve().
        run_seed = None if seed is None else (seed + (run_num - 1) * 100003) & 0xFFFFFFFF
        started = time.time()
        result = solve(grid, roster, time_limit_s, seed=run_seed)
        results.append(SolveRun(run_num, result, time.time() - started))

    best_power = max(r.result.total_power for r in results)

    for run in results:
        update_progress(f"{label} | Rendering run {run.run_num}/{runs}...")
        output_png = os.path.join(SOLVES_DIR, filename_for(run, best_power))
        renderer.render(grid, run.result.placements, output_png)
        run.output_png = output_png

    clear_progress()

    best = max(results, key=lambda r: r.result.total_power)
    verify(grid, roster, best.result)
    return results


def print_run_comparison(session_id: int, map_num: int, runs: List[SolveRun]) -> None:
    best_power = max(r.result.total_power for r in runs)
    worst_power = min(r.result.total_power for r in runs)
    spread = best_power - worst_power

    print("=" * 70)
    print(f"RUN COMPARISON REPORT (ID: {session_id}, Map: {map_num})")
    print("=" * 70)
    print(f"{'Run #':<6} | {'Total Power':<16} | {'Active Tiles':<12} | {'Time (s)':<10} | {'Status'}")
    print("-" * 70)

    for run in runs:
        result = run.result
        status = (
            "[BEST]"
            if result.total_power >= best_power
            else f"-{format_number(best_power - result.total_power)}"
        )
        print(
            f"Run {run.run_num:<2} | {format_number(result.total_power):<16} | "
            f"{result.active_tiles_count:<12} | {run.elapsed_s:<10.2f} | {status}"
        )

    print("-" * 70)
    print(f"Best Power Output : {format_number(best_power)}")
    pct = (spread / worst_power * 100) if worst_power else 0.0
    print(f"Max Power Delta   : {format_number(spread)} ({pct:.2f}% diff)")
    print("=" * 70 + "\n")


def run_single(
    game_map: GameMap, roster, renderer, time_limit_s: float, seed: Optional[int] = None
) -> None:
    """One run on one map, saved as test_{id}.png."""
    test_id = next_output_id(TEST_FILENAME_RE)

    runs = solve_map(
        game_map,
        roster,
        renderer,
        runs=1,
        time_limit_s=time_limit_s,
        label=f"Solving map {game_map.num} (test ID: {test_id})",
        filename_for=lambda run, best: f"test_{test_id}.png",
        seed=seed,
    )

    run = runs[0]
    print_summary(run.result, run.elapsed_s)
    print(f"Test output written to: {run.output_png}\n")


def run_comparison(
    game_maps: List[GameMap], roster, renderer, runs: int, time_limit_s: float,
    seed: Optional[int] = None,
) -> None:
    """Several runs per map, saved as {session}_island_{num}_{run}_{power}.png."""
    session_id = next_output_id(ISLAND_FILENAME_RE)

    for idx, game_map in enumerate(game_maps, start=1):
        def filename_for(run: SolveRun, best_power: float, num=game_map.num) -> str:
            if run.result.total_power >= best_power:
                return f"{session_id}_island_{num}_{run.run_num}_{format_for_filename(best_power)}.png"
            diff = format_for_filename(best_power - run.result.total_power)
            return f"{session_id}_island_{num}_{run.run_num}_minus_{diff}.png"

        map_runs = solve_map(
            game_map,
            roster,
            renderer,
            runs=runs,
            time_limit_s=time_limit_s,
            label=f"Map {game_map.num} [{idx}/{len(game_maps)}]",
            filename_for=filename_for,
            seed=seed,
        )

        print_run_comparison(session_id, game_map.num, map_runs)
        best = max(map_runs, key=lambda r: r.result.total_power)
        print_summary(best.result, best.elapsed_s)


# --- CLI -----------------------------------------------------------------

def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--map", type=int, action="append", dest="maps", metavar="NUM",
        help=f"map number to solve (repeatable). Available: {sorted(MAPS_BY_NUM)}",
    )
    parser.add_argument("--all", action="store_true", help="solve every map")
    parser.add_argument(
        "--runs", type=int, default=1,
        help="runs per map; more than one prints a best-of comparison (default: 1)",
    )
    parser.add_argument(
        "--time", type=float, default=DEFAULT_TIME_LIMIT_S, dest="time_limit_s",
        help=f"time budget per run in seconds (default: {DEFAULT_TIME_LIMIT_S:g})",
    )
    parser.add_argument(
        "--seed", type=int, default=None,
        help="base seed for the search's random stream; narrows run-to-run "
        "variance for debugging (stage deadlines remain wall-clock, so runs "
        "are not bit-identical)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if args.all:
        selected = list(MAPS)
    elif args.maps:
        unknown = [n for n in args.maps if n not in MAPS_BY_NUM]
        if unknown:
            print(f"Unknown map(s): {unknown}. Available: {sorted(MAPS_BY_NUM)}", file=sys.stderr)
            return 1
        selected = [MAPS_BY_NUM[n] for n in args.maps]
    else:
        selected = [MAPS_BY_NUM[DEFAULT_MAP_NUM]]

    os.makedirs(SOLVES_DIR, exist_ok=True)
    roster = get_effective_buildings()
    renderer = IsometricRenderer(TextureAtlas())

    if args.runs > 1 or len(selected) > 1:
        run_comparison(selected, roster, renderer, args.runs, args.time_limit_s, args.seed)
    else:
        run_single(selected[0], roster, renderer, args.time_limit_s, args.seed)

    return 0


if __name__ == "__main__":
    sys.exit(main())
