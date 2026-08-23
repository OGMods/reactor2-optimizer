"""Tests for the post-solve checks and the console summary."""

import io
import unittest.mock

from solver.types import OptimizationResult, OptimizationSummary, PlacedBuilding
from solver.report import print_summary, verify
from tests.helpers import SimulationTestCase, basic_roster, make_grid


def result_with(placements, total_power=100.0, max_power=200.0):
    return OptimizationResult(
        total_power=total_power,
        placements=placements,
        active_tiles_count=len(placements),
        unused_tiles_count=0,
        summary=OptimizationSummary(),
        theoretical_max_power=max_power,
    )


def placed(x, y, building_id="reactor"):
    return PlacedBuilding(x=x, y=y, building_id=building_id)


class VerifyTests(SimulationTestCase):
    def setUp(self):
        self.grid = make_grid([
            "GGG",
            "G.R",
        ])
        self.roster = basic_roster()

    def test_accepts_a_valid_layout(self):
        result = result_with([placed(0, 0), placed(1, 0, "generator"), placed(2, 0, "cooler")])

        verify(self.grid, self.roster, result)  # must not raise

    def test_rejects_two_buildings_on_the_same_tile(self):
        result = result_with([placed(0, 0), placed(0, 0, "cooler")])

        with self.assertRaises(ValueError) as caught:
            verify(self.grid, self.roster, result)

        self.assertIn("Duplicate tile", str(caught.exception))

    def test_rejects_building_on_water(self):
        result = result_with([placed(1, 1)])

        with self.assertRaises(ValueError) as caught:
            verify(self.grid, self.roster, result)

        self.assertIn("non-grass", str(caught.exception))

    def test_rejects_building_on_scenery(self):
        result = result_with([placed(2, 1)])

        with self.assertRaises(ValueError):
            verify(self.grid, self.roster, result)

    def test_rejects_a_building_that_is_not_in_the_roster(self):
        result = result_with([placed(0, 0, "not_unlocked")])

        with self.assertRaises(ValueError) as caught:
            verify(self.grid, self.roster, result)

        self.assertIn("Unavailable/locked", str(caught.exception))

    def test_allows_the_same_building_id_on_many_tiles(self):
        """There is no per-id quantity limit -- only tile availability."""
        result = result_with([placed(0, 0), placed(1, 0), placed(2, 0)])

        verify(self.grid, self.roster, result)

    def test_accepts_an_empty_layout(self):
        verify(self.grid, self.roster, result_with([]))


class PrintSummaryTests(SimulationTestCase):
    def _summary_output(self, result, solve_time_s=None):
        buffer = io.StringIO()
        with unittest.mock.patch("sys.stdout", buffer):
            print_summary(result, solve_time_s)
        return buffer.getvalue()

    def test_reports_power_efficiency_and_tiles(self):
        result = OptimizationResult(
            total_power=150.0,
            placements=[placed(0, 0)],
            active_tiles_count=3,
            unused_tiles_count=7,
            summary=OptimizationSummary(),
            theoretical_max_power=300.0,
        )

        output = self._summary_output(result, solve_time_s=1.5)

        self.assertIn("150", output)
        self.assertIn("50.0%", output, "efficiency is total / theoretical max")
        self.assertIn("3/10", output, "active out of total tiles")
        self.assertIn("1.50s", output)

    def test_omits_the_timing_line_when_no_time_is_given(self):
        output = self._summary_output(result_with([]))

        self.assertNotIn("Solve time", output)

    def test_handles_a_zero_theoretical_maximum_without_dividing_by_zero(self):
        result = result_with([], total_power=0.0, max_power=0.0)

        output = self._summary_output(result)

        self.assertIn("0.0%", output)
