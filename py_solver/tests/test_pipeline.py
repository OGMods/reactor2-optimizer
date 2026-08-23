"""
Tests for solve(): the whole-grid pipeline.

The pipeline's own job is small -- split, budget, delegate, remap -- but the
remapping step is the one that turns island-local coordinates back into grid
coordinates, and a mistake there produces a plausible-looking result that
renders and scores against the wrong tiles.
"""

import json
import os
import subprocess
import sys
import unittest

from data.effective_buildings import get_effective_buildings
from blueprint import decode_blueprint
from grid import count_grass_tiles
from data.maps import MAPS_BY_NUM
from solver import solve
from solver.island import split_grid_into_islands
from solver.simulate import simulate_island
from tests.helpers import SimulationTestCase, basic_roster, cooler, make_grid, reactor

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class SolveContractTests(SimulationTestCase):
    def test_empty_grid(self):
        result = solve([], basic_roster(), 0.1)

        self.assertClose(result.total_power, 0.0)
        self.assertEqual(result.placements, [])
        self.assertEqual(result.active_tiles_count, 0)

    def test_grid_with_no_buildable_tiles(self):
        grid = make_grid(["....", ".RR."])

        result = solve(grid, basic_roster(), 0.1)

        self.assertClose(result.total_power, 0.0)
        self.assertEqual(result.placements, [])
        self.assertEqual(result.unused_tiles_count, 0)

    def test_roster_that_cannot_build_anything(self):
        grid = make_grid(["GGGG"])

        result = solve(grid, [cooler(100), reactor(100)], 0.2)

        self.assertClose(result.total_power, 0.0)
        self.assertEqual(result.placements, [])
        self.assertEqual(
            result.unused_tiles_count, 4, "all four grass tiles are still counted"
        )

    def test_tile_accounting_adds_up(self):
        grid = make_grid(["GGGG", "GG.G", "GGGG"])

        result = solve(grid, basic_roster(), 0.5, parallel=False)

        self.assertEqual(
            result.active_tiles_count + result.unused_tiles_count,
            count_grass_tiles(grid),
        )
        self.assertEqual(result.active_tiles_count, len(result.placements))

    def test_placements_land_on_grass_at_original_grid_coordinates(self):
        """Guards the island-local -> grid coordinate remapping."""
        grid = make_grid([
            "........",
            "..GGGG..",
            "..GGGG..",
            "........",
        ])

        result = solve(grid, basic_roster(), 0.5, parallel=False)

        self.assertGreater(len(result.placements), 0)
        for p in result.placements:
            self.assertEqual(
                grid[p.y][p.x].type, "grass",
                f"placement at ({p.x},{p.y}) is not on grass",
            )

    def test_no_tile_is_used_twice(self):
        grid = make_grid(["GGGG..GGGG", "GGGG..GGGG"])

        result = solve(grid, basic_roster(), 0.5, parallel=False)

        positions = [(p.x, p.y) for p in result.placements]
        self.assertEqual(len(positions), len(set(positions)))

    def test_total_power_matches_a_fresh_simulation_of_the_whole_grid(self):
        """
        Islands are 8-connected components, so no two islands can interact and
        simulating every placement together must reproduce the summed total.
        """
        grid = make_grid(["GGGG..GGGG", "GGGG..GGGG"])
        roster = basic_roster()
        by_id = {b.id: b for b in roster}

        result = solve(grid, roster, 0.6, parallel=False)

        layout = {(p.x, p.y): by_id[p.building_id] for p in result.placements}
        actual_power, _ = simulate_island(layout)

        self.assertClose(actual_power, result.total_power, rel=1e-9)

    def test_every_island_gets_worked_on(self):
        grid = make_grid(["GGGG..GGGG..GGGG"])
        roster = basic_roster()
        self.assertEqual(len(split_grid_into_islands(grid, roster)), 3)

        result = solve(grid, roster, 1.2, parallel=False)

        used_columns = {p.x for p in result.placements}
        self.assertTrue(any(x < 4 for x in used_columns), "first island unused")
        self.assertTrue(any(6 <= x < 10 for x in used_columns), "second island unused")
        self.assertTrue(any(x >= 12 for x in used_columns), "third island unused")

    def test_never_places_a_producer_that_generates_no_power(self):
        """
        Grid-level version of the stability requirement: no overheating or idle
        generator/direct producer may survive into the final result.
        """
        game_map = MAPS_BY_NUM[1]
        roster = get_effective_buildings()
        by_id = {b.id: b for b in roster}
        grid = decode_blueprint(game_map.code).grid

        result = solve(grid, roster, 1.5, parallel=False)

        self.assertGreater(len(result.placements), 0)
        for p in result.placements:
            building = by_id[p.building_id]
            if building.type in ("generator", "direct_producer"):
                self.assertGreater(
                    p.power_generated, 0.0,
                    f"{p.building_id} at ({p.x},{p.y}) is placed but generates nothing",
                )

    def test_summary_totals_match_the_placements(self):
        grid = make_grid(["GGGG", "GGGG"])

        result = solve(grid, basic_roster(), 0.5, parallel=False)
        summary = result.summary

        self.assertClose(
            summary.total_heat_produced,
            sum(p.heat_produced for p in result.placements), rel=1e-9,
        )
        self.assertClose(
            summary.total_cooling_capacity,
            sum(p.cooling_provided for p in result.placements), rel=1e-9,
        )
        self.assertClose(
            summary.total_waste_generated,
            sum(p.waste_heat_generated for p in result.placements), rel=1e-9,
        )

    def test_theoretical_max_power_is_reported(self):
        grid = make_grid(["GGGG", "GGGG"])

        result = solve(grid, basic_roster(), 0.3, parallel=False)

        self.assertGreater(
            result.theoretical_max_power, 0.0,
            "the efficiency figure in the summary depends on this",
        )


class SolveQualityTests(SimulationTestCase):
    """A floor on real-map results, so a broken heuristic can't pass silently."""

    def test_reaches_a_reasonable_fraction_of_the_bound_on_a_real_map(self):
        game_map = MAPS_BY_NUM[1]
        roster = get_effective_buildings()
        grid = decode_blueprint(game_map.code).grid

        result = solve(grid, roster, 2.0, parallel=False)

        self.assertGreater(
            result.total_power, 0.75 * result.theoretical_max_power,
            f"solve produced {result.total_power:.3e} against a "
            f"{result.theoretical_max_power:.3e} bound",
        )

    def test_more_time_never_produces_a_worse_expected_result(self):
        """
        Not a strict guarantee (the search is stochastic), but a long budget
        falling below a very short one repeatedly would mean annealing is
        actively destroying the seed.
        """
        game_map = MAPS_BY_NUM[0]
        roster = get_effective_buildings()
        grid = decode_blueprint(game_map.code).grid

        quick = solve(grid, roster, 0.2, parallel=False).total_power
        longer = solve(grid, roster, 1.5, parallel=False).total_power

        self.assertGreaterEqual(
            longer, quick * 0.9,
            "a longer search came back materially worse than a short one",
        )


class ParallelSolveTests(unittest.TestCase):
    """
    Runs in a subprocess: ProcessPoolExecutor spawns workers that re-import
    __main__, which is fine for a script but not for the unittest runner.
    """

    def test_parallel_and_sequential_solves_are_both_valid(self):
        script = os.path.join(PROJECT_ROOT, "tests", "_parallel_check.py")

        completed = subprocess.run(
            [sys.executable, script, "6", "1.0"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=180,
        )

        self.assertEqual(
            completed.returncode, 0,
            f"parallel solve failed:\n{completed.stderr}",
        )
        data = json.loads(completed.stdout)

        self.assertGreater(data["island_count"], 1, "map 6 should have several islands")
        for mode in ("parallel", "sequential"):
            with self.subTest(mode=mode):
                run = data[mode]
                self.assertTrue(run["all_on_grass"], "placement landed off grass")
                self.assertGreater(run["total_power"], 0.0)
                self.assertEqual(
                    len(run["positions"]), len({tuple(p) for p in run["positions"]}),
                    "a tile was used twice",
                )
                self.assertEqual(
                    run["active_tiles"] + run["unused_tiles"], data["grass_tiles"]
                )

    def test_parallel_result_is_comparable_to_sequential(self):
        script = os.path.join(PROJECT_ROOT, "tests", "_parallel_check.py")

        completed = subprocess.run(
            [sys.executable, script, "6", "1.5"],
            cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        data = json.loads(completed.stdout)

        parallel_power = data["parallel"]["total_power"]
        sequential_power = data["sequential"]["total_power"]

        self.assertEqual(
            data["parallel"]["max_power"], data["sequential"]["max_power"],
            "the theoretical bound must not depend on how islands were scheduled",
        )
        self.assertGreater(
            parallel_power, 0.5 * sequential_power,
            "parallel solving lost a large amount of power -- are islands being "
            "dropped or budgeted wrongly?",
        )
