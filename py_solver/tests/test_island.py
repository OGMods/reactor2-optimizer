"""
Tests for island decomposition and the theoretical max-power bound.

Islands are the solver's parallelism and correctness boundary: if two tiles
that CAN interact end up in different islands, the solver silently loses
layouts. The coordinate remapping is equally load-bearing -- get it wrong and
buildings render (and verify) on the wrong tiles.
"""

import random

from solver.types import IslandSubGrid
from grid import count_grass_tiles
from solver.island import (
    can_cool_direct_producer,
    estimate_island_max_power,
    estimate_total_max_power,
    split_grid_into_islands,
)
from solver.constants import EPS
from solver.simulate import simulate_island
from tests.helpers import (
    SimulationTestCase,
    basic_roster,
    cooler,
    direct_producer,
    generator,
    make_grid,
    reactor,
)


class SplitGridTests(SimulationTestCase):
    def setUp(self):
        self.roster = basic_roster()

    def test_single_connected_block_is_one_island(self):
        grid = make_grid([
            "GGG",
            "GGG",
        ])

        islands = split_grid_into_islands(grid, self.roster)

        self.assertEqual(len(islands), 1)
        self.assertEqual((islands[0].width, islands[0].height), (3, 2))
        self.assertEqual(count_grass_tiles(islands[0].grid), 6)

    def test_water_separates_islands(self):
        grid = make_grid([
            "GGG..GGG",
            "GGG..GGG",
        ])

        islands = split_grid_into_islands(grid, self.roster)

        self.assertEqual(len(islands), 2)
        for island in islands:
            self.assertEqual(count_grass_tiles(island.grid), 6)

    def test_diagonal_contact_keeps_tiles_in_one_island(self):
        """
        Interaction is 8-neighbor, so two blocks touching only at a corner CAN
        interact and must stay in the same island.
        """
        grid = make_grid([
            "GGG...",
            "GGG...",
            "...GGG",
            "...GGG",
        ])

        islands = split_grid_into_islands(grid, self.roster)

        self.assertEqual(len(islands), 1, "corner-touching blocks are one island")
        self.assertEqual(count_grass_tiles(islands[0].grid), 12)

    def test_scenery_tiles_are_treated_as_impassable(self):
        """Rocks, trees, ponds and transformers all block exactly like water."""
        grid = make_grid([
            "GGGRTUOXGGG",
        ])

        islands = split_grid_into_islands(grid, self.roster)

        self.assertEqual(len(islands), 2)
        for island in islands:
            self.assertEqual(count_grass_tiles(island.grid), 3)

    def test_islands_smaller_than_three_tiles_are_dropped(self):
        """
        Without a direct producer, the smallest working chain is
        reactor + generator + cooler, so 1- and 2-tile components are dead.
        """
        grid = make_grid([
            "G.GG.GGG",
        ])
        roster = basic_roster()  # no direct producer
        self.assertFalse(can_cool_direct_producer(roster))

        islands = split_grid_into_islands(grid, roster)

        self.assertEqual(len(islands), 1)
        self.assertEqual(count_grass_tiles(islands[0].grid), 3)

    def test_two_tile_islands_survive_when_a_cooler_can_cover_a_direct_producer(self):
        grid = make_grid([
            "G.GG.GGG",
        ])
        roster = basic_roster(dp_value=100.0, dp_waste_ratio=0.2)  # waste 20 <= cooler 100
        self.assertTrue(can_cool_direct_producer(roster))

        islands = split_grid_into_islands(grid, roster)

        self.assertEqual(
            sorted(count_grass_tiles(i.grid) for i in islands), [2, 3],
            "the 2-tile component is now viable, the 1-tile one is still not",
        )

    def test_empty_and_waterlogged_grids(self):
        self.assertEqual(split_grid_into_islands([], self.roster), [])
        self.assertEqual(split_grid_into_islands(make_grid(["...."]), self.roster), [])

    def test_sub_grid_masks_out_tiles_from_other_islands(self):
        """
        An island's bounding box can overlap another island. Those foreign tiles
        must appear as water in the sub-grid, or the solver would build on them.
        """
        grid = make_grid([
            "GGG.G",
            "GGG.G",
            "GGG.G",
        ])

        islands = split_grid_into_islands(grid, self.roster)

        self.assertEqual(len(islands), 2)
        for island in islands:
            width = island.width
            self.assertEqual(
                count_grass_tiles(island.grid),
                sum(1 for row in island.grid for t in row if t.type == "grass"),
            )
            # No island should claim more tiles than its own bounding box holds.
            self.assertLessEqual(count_grass_tiles(island.grid), width * island.height)
        self.assertEqual(sorted(count_grass_tiles(i.grid) for i in islands), [3, 9])


class CoordinateRemappingTests(SimulationTestCase):
    def test_original_tile_indices_point_back_at_the_source_tiles(self):
        grid = make_grid([
            "......",
            "..GGG.",
            "..GGG.",
        ])
        original_width = len(grid[0])

        islands = split_grid_into_islands(grid, basic_roster())
        island = islands[0]

        self.assertEqual(len(islands), 1)
        for local_y in range(island.height):
            for local_x in range(island.width):
                flat = island.original_tile_indices[local_y * island.width + local_x]
                orig_y, orig_x = divmod(flat, original_width)
                self.assertEqual(
                    grid[orig_y][orig_x].type,
                    island.grid[local_y][local_x].type,
                    f"local ({local_x},{local_y}) should map to original ({orig_x},{orig_y})",
                )

    def test_local_tile_coordinates_are_island_relative(self):
        grid = make_grid([
            ".....",
            ".GGG.",
            ".GGG.",
        ])

        island = split_grid_into_islands(grid, basic_roster())[0]

        self.assertEqual(island.grid[0][0].x, 0)
        self.assertEqual(island.grid[0][0].y, 0)
        self.assertEqual((island.width, island.height), (3, 2))


class CanCoolDirectProducerTests(SimulationTestCase):
    def test_false_without_coolers(self):
        self.assertFalse(can_cool_direct_producer([direct_producer(10, 0.2)]))

    def test_false_without_direct_producers(self):
        self.assertFalse(can_cool_direct_producer([cooler(100), reactor(100)]))

    def test_true_when_one_cooler_covers_the_whole_waste(self):
        self.assertTrue(can_cool_direct_producer([cooler(20), direct_producer(100, 0.2)]))

    def test_boundary_is_inclusive(self):
        """Waste exactly equal to cooling is enough (the rule is <=)."""
        self.assertTrue(can_cool_direct_producer([cooler(20.0), direct_producer(100, 0.2)]))
        self.assertFalse(can_cool_direct_producer([cooler(19.9), direct_producer(100, 0.2)]))


class MaxPowerBoundTests(SimulationTestCase):
    """
    The bound feeds the "layout efficiency" figure, and it must be a TRUE
    upper bound: no layout on the island may ever beat it, or the efficiency
    figure reads above 100% and stops meaning anything. (An earlier per-hub
    density estimate ignored cross-hub sharing and was routinely exceeded.)
    Most tests here check the shape of the estimate; the random-layout test
    checks the bound property itself.
    """

    def _island(self, rows):
        grid = make_grid(rows)
        islands = split_grid_into_islands(grid, basic_roster())
        return islands[0] if islands else None

    def test_zero_for_an_island_with_no_buildable_tiles(self):
        empty = IslandSubGrid(width=0, height=0, grid=[], original_tile_indices=[])
        self.assertClose(estimate_island_max_power(empty, basic_roster()), 0.0)

    def test_zero_without_coolers(self):
        island = self._island(["GGGG"])
        roster = [reactor(100), generator(100)]
        self.assertClose(estimate_island_max_power(island, roster), 0.0)

    def test_bound_grows_with_island_size(self):
        small = self._island(["GGG"])
        large = self._island(["GGGGGG", "GGGGGG"])
        roster = basic_roster()

        self.assertLess(
            estimate_island_max_power(small, roster),
            estimate_island_max_power(large, roster),
        )

    def test_a_three_tile_hub_bound_matches_the_hand_calculation(self):
        """1 reactor (100) + 1 generator (100) + 1 cooler (25) = 75 power."""
        island = self._island(["GGG"])
        roster = [reactor(100), generator(100), cooler(25)]

        self.assertClose(estimate_island_max_power(island, roster), 75.0)

    def test_no_random_layout_ever_beats_the_bound(self):
        """
        The bound property itself, exercised the only way that generalizes:
        throw hundreds of arbitrary layouts (including mixed generator + direct
        producer ones sharing coolers) at a fixed island and check every
        simulated power lands at or under the estimate.
        """
        island = self._island(["GGG", "GGG", "GGG"])
        roster = basic_roster(dp_value=120.0, dp_waste_ratio=0.2)
        bound = estimate_island_max_power(island, roster)
        tiles = [
            (t.x, t.y) for row in island.grid for t in row if t.type == "grass"
        ]

        rng = random.Random(20260818)
        options = roster + [None]
        for _ in range(300):
            placement = {}
            for pos in tiles:
                building = rng.choice(options)
                if building is not None:
                    placement[pos] = building
            power, _ = simulate_island(placement)
            self.assertLessEqual(
                power, bound + EPS,
                f"layout {sorted(placement.items())} beat the 'upper' bound",
            )

    def test_total_is_the_sum_over_islands(self):
        grid = make_grid(["GGG..GGG"])
        roster = basic_roster()
        islands = split_grid_into_islands(grid, roster)

        total = estimate_total_max_power(islands, roster)

        self.assertClose(
            total, sum(estimate_island_max_power(i, roster) for i in islands)
        )
        self.assertEqual(estimate_total_max_power([], roster), 0)
