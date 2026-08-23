"""
Tests for the blueprint codec, and for its agreement with the TypeScript peer.

The interesting failure mode here is not "the codec is broken" -- a round-trip
test catches that. It is "the two trees drifted": a building renumbered on one
side decodes as a *different building* on the other rather than raising. So the
byte tables are pinned against `lib/encoding/blueprint.ts` itself.
"""

import pathlib
import re
import unittest
import zlib

from blueprint import (
    BlueprintPlacement,
    blueprint_key,
    decode_blueprint,
    encode_blueprint,
    _base64url_encode,
    _build_payload,
    _BUILDING_BYTE_MAP,
    _TILE_BYTE_MAP,
)
from data.buildings import BUILDINGS
from tests.helpers import SimulationTestCase, make_grid

TS_BLUEPRINT = (
    pathlib.Path(__file__).resolve().parents[2] / "src" / "lib" / "encoding" / "blueprint.ts"
)


def _ts_byte_map(source: str, declaration: str) -> dict:
    """Pulls one `name: number` table out of the TypeScript module."""
    body = source.split(declaration, 1)[1].split("};", 1)[0]
    return {
        name: int(value)
        for name, value in re.findall(r'["\']?([A-Za-z_][A-Za-z0-9_]*)["\']?\s*:\s*(\d+)', body)
    }


class RoundTripTests(SimulationTestCase):
    def test_terrain_round_trips(self):
        grid = make_grid(["G.RT", "UOXG", "GGGG"])

        decoded = decode_blueprint(encode_blueprint(grid))

        self.assertEqual((decoded.width, decoded.height), (4, 3))
        self.assertEqual(
            [[t.type for t in row] for row in decoded.grid],
            [[t.type for t in row] for row in grid],
        )

    def test_tile_coordinates_are_rebuilt(self):
        decoded = decode_blueprint(encode_blueprint(make_grid(["GG", "GG"])))

        for y, row in enumerate(decoded.grid):
            for x, tile in enumerate(row):
                self.assertEqual((tile.x, tile.y), (x, y))

    def test_placements_round_trip(self):
        grid = make_grid(["GGG", "GGG"])
        placements = [
            BlueprintPlacement(x=0, y=0, building_id="cooler1"),
            BlueprintPlacement(x=2, y=1, building_id="doomStar_reactor"),
        ]

        decoded = decode_blueprint(encode_blueprint(grid, placements))

        self.assertEqual(decoded.placements, placements)

    def test_a_building_implies_grass_underneath(self):
        grid = make_grid(["."])
        placements = [BlueprintPlacement(x=0, y=0, building_id="generator")]

        decoded = decode_blueprint(encode_blueprint(grid, placements))

        self.assertEqual(decoded.grid[0][0].type, "grass")

    def test_empty_grid_encodes_to_empty_string(self):
        self.assertEqual(encode_blueprint([]), "")
        decoded = decode_blueprint("")
        self.assertEqual((decoded.width, decoded.height, decoded.grid), (0, 0, []))

    def test_unknown_building_id_falls_back_to_terrain(self):
        grid = make_grid(["R"])
        placements = [BlueprintPlacement(x=0, y=0, building_id="not_a_building")]

        decoded = decode_blueprint(encode_blueprint(grid, placements))

        self.assertEqual(decoded.placements, [])
        self.assertEqual(decoded.grid[0][0].type, "rock")

    def test_every_shipped_building_survives_a_round_trip(self):
        grid = make_grid(["G"])
        for building in BUILDINGS:
            with self.subTest(building=building.id):
                decoded = decode_blueprint(
                    encode_blueprint(
                        grid, [BlueprintPlacement(x=0, y=0, building_id=building.id)]
                    )
                )
                self.assertEqual(
                    [p.building_id for p in decoded.placements], [building.id]
                )


class TierTableTests(SimulationTestCase):
    """
    The optional section after the tiles: what each building is rated for.

    Its whole design goal is that adding it did not change any code already in
    the wild, so most of these are about what stays the same rather than what
    is new.
    """

    def test_tiers_round_trip(self):
        grid = make_grid(["GGG", "GGG"])
        placements = [
            BlueprintPlacement(x=0, y=0, building_id="cooler2"),
            BlueprintPlacement(x=2, y=1, building_id="generator3"),
        ]
        tiers = {"cooler2": 4, "generator3": 7}

        decoded = decode_blueprint(encode_blueprint(grid, placements, tiers))

        self.assertEqual(decoded.tiers, tiers)
        self.assertEqual(decoded.placements, placements)

    def test_a_code_without_tiers_decodes_to_an_empty_table(self):
        """
        Not "everything is at tier 0" -- every code written before the table
        existed is one of these, and reading it that way would silently
        downgrade every layout ever shared.
        """
        grid = make_grid(["GG"])
        placements = [BlueprintPlacement(x=0, y=0, building_id="cooler1")]

        decoded = decode_blueprint(encode_blueprint(grid, placements))

        self.assertEqual(decoded.tiers, {})

    def test_omitting_tiers_reproduces_the_old_payload_exactly(self):
        """
        The reason `blueprint_key` could keep its meaning: with no tiers, the
        payload is byte for byte what it was before the table existed.
        """
        grid = make_grid(["GGR", "G.G"])
        placements = [BlueprintPlacement(x=1, y=0, building_id="cooler1")]

        self.assertEqual(
            _build_payload(grid, placements),
            bytes([3, 2]) + bytes([1, 10, 2, 1, 0, 1]),
        )

    def test_the_table_is_appended_after_the_tiles(self):
        """
        Pins the byte layout itself, not just the round trip. The TypeScript
        peer builds the same bytes for this board -- see the note at the top of
        this file about why a table that drifts fails silently.
        """
        grid = make_grid(["GG"])
        placements = [BlueprintPlacement(x=0, y=0, building_id="cooler1")]

        payload = _build_payload(grid, placements, {"cooler1": 3})

        #        w  h  tiles     n  [byte, level]
        self.assertEqual(payload, bytes([2, 1, 10, 1, 1, 10, 3]))

    def test_only_buildings_on_the_board_get_an_entry(self):
        """A tier for a building nobody placed describes nothing."""
        grid = make_grid(["GG"])
        placements = [BlueprintPlacement(x=0, y=0, building_id="cooler1")]

        decoded = decode_blueprint(
            encode_blueprint(grid, placements, {"cooler1": 1, "generator5": 6})
        )

        self.assertEqual(decoded.tiers, {"cooler1": 1})

    def test_an_unplaceable_building_id_gets_no_entry(self):
        """
        Its id never reached a tile byte either, so a tier for it would point
        at a building the board does not have.
        """
        grid = make_grid(["G"])
        placements = [BlueprintPlacement(x=0, y=0, building_id="not_a_building")]

        decoded = decode_blueprint(
            encode_blueprint(grid, placements, {"not_a_building": 2})
        )

        self.assertEqual(decoded.tiers, {})

    def test_tiers_are_not_part_of_the_key(self):
        """
        `blueprint_key` answers "is this the same layout?", and buying an
        upgrade does not repaint a board. So the key takes no tiers, and cannot
        be made to -- it is the untiered payload whatever the roster says.
        """
        grid = make_grid(["GG"])
        placements = [BlueprintPlacement(x=0, y=0, building_id="cooler1")]

        self.assertEqual(
            blueprint_key(grid, placements), _build_payload(grid, placements)
        )
        self.assertNotEqual(
            blueprint_key(grid, placements),
            _build_payload(grid, placements, {"cooler1": 5}),
        )

    def test_a_truncated_table_costs_the_table_not_the_layout(self):
        """
        The tiles cannot be reconstructed and the tiers can -- so a payload
        that stops mid-table gives up the tiers and keeps the board.
        """
        grid = make_grid(["GG"])
        placements = [BlueprintPlacement(x=0, y=0, building_id="cooler1")]
        payload = _build_payload(grid, placements, {"cooler1": 3})

        # Claims one entry, carries only the building byte of it.
        code = _base64url_encode(zlib.compress(payload[:-1]))
        decoded = decode_blueprint(code)

        self.assertEqual(decoded.tiers, {})
        self.assertEqual(decoded.placements, placements)


class MalformedInputTests(SimulationTestCase):
    def test_garbage_raises_valueerror(self):
        for bad in ("!!!!", "not-base64!", "eJzz"):
            with self.subTest(code=bad):
                with self.assertRaises(ValueError):
                    decode_blueprint(bad)

    def test_truncated_payload_raises_valueerror(self):
        import base64

        # Claims 10x10 but carries no tile bytes.
        raw = zlib.compress(bytes([10, 10]))
        code = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

        with self.assertRaises(ValueError):
            decode_blueprint(code)


class BlueprintKeyTests(SimulationTestCase):
    def test_identical_layouts_share_a_key(self):
        a = make_grid(["GG.", "G.G"])
        b = make_grid(["GG.", "G.G"])

        self.assertEqual(blueprint_key(a), blueprint_key(b))

    def test_differing_layouts_have_different_keys(self):
        self.assertNotEqual(
            blueprint_key(make_grid(["GG"])), blueprint_key(make_grid(["G."]))
        )

    def test_placements_are_part_of_the_key(self):
        grid = make_grid(["GG"])

        self.assertNotEqual(
            blueprint_key(grid),
            blueprint_key(grid, [BlueprintPlacement(x=0, y=0, building_id="cooler1")]),
        )

    def test_key_is_the_uncompressed_payload(self):
        """
        The reason a key exists at all: it must not depend on the compressor.
        Re-compressing at a different level changes the code but must not change
        the key.
        """
        grid = make_grid(["GGGG", "GGGG"])
        payload = blueprint_key(grid)

        self.assertEqual(zlib.decompress(zlib.compress(payload, 1)), payload)
        self.assertEqual(zlib.decompress(zlib.compress(payload, 9)), payload)
        self.assertNotEqual(zlib.compress(payload, 1), zlib.compress(payload, 9))


@unittest.skipUnless(TS_BLUEPRINT.is_file(), "TypeScript tree not present")
class TypeScriptAgreementTests(SimulationTestCase):
    """
    Pins the wire format against `lib/encoding/blueprint.ts`.

    A code written by one tree is read by the other, so a table that drifts does
    not fail loudly -- it silently decodes one building as another.
    """

    def setUp(self):
        self.source = TS_BLUEPRINT.read_text(encoding="utf-8")

    def test_tile_byte_map_matches(self):
        ts = _ts_byte_map(self.source, "TILE_BYTE_MAP: Record<TileType, number> = {")

        self.assertEqual(ts, _TILE_BYTE_MAP)

    def test_building_byte_map_matches(self):
        ts = _ts_byte_map(
            self.source, "BUILDING_BYTE_MAP: Record<BuildingId, number> = {"
        )

        self.assertEqual(ts, _BUILDING_BYTE_MAP)

    def test_building_byte_map_covers_the_whole_roster(self):
        self.assertEqual(
            sorted(_BUILDING_BYTE_MAP), sorted(b.id for b in BUILDINGS)
        )

    def test_terrain_and_building_byte_ranges_do_not_overlap(self):
        self.assertLess(max(_TILE_BYTE_MAP.values()), min(_BUILDING_BYTE_MAP.values()))
        self.assertEqual(
            len(set(_BUILDING_BYTE_MAP.values())), len(_BUILDING_BYTE_MAP)
        )


if __name__ == "__main__":
    unittest.main()
