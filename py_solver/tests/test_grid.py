"""Tests for the tile predicates and the shipped map codes."""

from blueprint import decode_blueprint
from grid import count_grass_tiles, is_island_tile
from data.maps import MAPS, MAPS_BY_NUM
from tests.helpers import SimulationTestCase, make_grid


class TilePredicateTests(SimulationTestCase):
    def test_is_island_tile_is_true_for_everything_but_water(self):
        grid = make_grid(["G.RTUOX"])
        types = [is_island_tile(t) for t in grid[0]]

        self.assertEqual(types, [True, False, True, True, True, True, True])

    def test_is_island_tile_handles_none(self):
        self.assertFalse(is_island_tile(None))

    def test_count_grass_tiles(self):
        self.assertEqual(count_grass_tiles(make_grid(["G.G", "GRG"])), 4)
        self.assertEqual(count_grass_tiles([]), 0)


class MapDataTests(SimulationTestCase):
    """The shipped maps must stay decodable -- a typo in a code is silent."""

    def test_every_map_decodes_to_a_rectangular_grid_with_buildable_tiles(self):
        for game_map in MAPS:
            with self.subTest(map=game_map.num):
                decoded = decode_blueprint(game_map.code)

                self.assertGreater(len(decoded.grid), 0, "map decoded to an empty grid")
                self.assertEqual(len(decoded.grid[0]), decoded.width)
                self.assertEqual(len(decoded.grid), decoded.height)
                for row in decoded.grid:
                    self.assertEqual(len(row), decoded.width, "grid is ragged")
                self.assertGreater(
                    count_grass_tiles(decoded.grid), 0, "map has no buildable tiles"
                )

    def test_maps_ship_terrain_only(self):
        """A map is a board, not a solved layout: no buildings baked in."""
        for game_map in MAPS:
            with self.subTest(map=game_map.num):
                self.assertEqual(decode_blueprint(game_map.code).placements, [])

    def test_map_numbers_are_unique(self):
        numbers = [m.num for m in MAPS]

        self.assertEqual(len(numbers), len(set(numbers)))
        self.assertEqual(len(MAPS_BY_NUM), len(MAPS))
