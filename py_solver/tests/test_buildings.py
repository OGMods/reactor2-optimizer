"""Tests for resolving the building catalogue against unlocked upgrade levels."""

from data.buildings import BUILDINGS, UNLOCKED_UPGRADES
from data.effective_buildings import get_effective_buildings
from solver.physics import snap_to_authored_precision
from solver.types import (
    CoolerDefinition,
    CoolerLevel,
    DirectProducerDefinition,
    DirectProducerLevel,
    GeneratorDefinition,
    GeneratorLevel,
    ReactorDefinition,
    ReactorLevel,
)
from tests.helpers import SimulationTestCase


def definition(id="thing", values=(1.0, 2.0, 3.0)):
    """A cooler, for the tests that only care about level selection."""
    return CoolerDefinition(
        id=id,
        name=id,
        price=1,
        display_index=0,
        levels=[CoolerLevel(v) for v in values],
    )


def _one_level(cls, level, id):
    return cls(id=id, name=id, price=1, display_index=0, levels=[level])


class GetEffectiveBuildingsTests(SimulationTestCase):
    def test_picks_the_value_at_the_unlocked_level(self):
        roster = get_effective_buildings([definition(values=[10, 20, 30])], {"thing": 1})

        self.assertEqual(len(roster), 1)
        self.assertClose(roster[0].effective_value, 20.0)

    def test_buildings_absent_from_the_unlock_map_are_locked_out(self):
        roster = get_effective_buildings(
            [definition(id="a"), definition(id="b")], {"a": 0}
        )

        self.assertEqual([b.id for b in roster], ["a"])

    def test_level_is_clamped_into_range(self):
        defs = [definition(id="high", values=[10, 20]), definition(id="low", values=[10, 20])]

        roster = get_effective_buildings(defs, {"high": 99, "low": -5})
        by_id = {b.id: b for b in roster}

        self.assertClose(by_id["high"].effective_value, 20.0, "clamped to the last tier")
        self.assertClose(by_id["low"].effective_value, 10.0, "clamped to the first tier")

    def test_buildings_with_no_upgrade_tiers_are_skipped(self):
        roster = get_effective_buildings([definition(values=[])], {"thing": 0})

        self.assertEqual(roster, [])

    def test_energy_and_waste_are_resolved_per_role(self):
        defs = [
            _one_level(GeneratorDefinition, GeneratorLevel(100.0, 75.0), "gen"),
            _one_level(DirectProducerDefinition, DirectProducerLevel(10.0, 8.0), "dp"),
            _one_level(ReactorDefinition, ReactorLevel(50.0), "reactor"),
            _one_level(CoolerDefinition, CoolerLevel(30.0), "cooler"),
        ]

        by_id = {
            b.id: b
            for b in get_effective_buildings(defs, {k: 0 for k in ("gen", "dp", "reactor", "cooler")})
        }

        self.assertClose(by_id["gen"].energy, 75.0)
        self.assertClose(by_id["gen"].waste, 25.0, "a generator wastes the heat it does not convert")
        self.assertClose(by_id["dp"].energy, 8.0)
        self.assertClose(by_id["dp"].waste, 2.0)
        for support in ("reactor", "cooler"):
            with self.subTest(building=support):
                self.assertClose(by_id[support].energy, 0.0, "makes no power of its own")
                self.assertClose(by_id[support].waste, 0.0, "has nothing to cool")

    def test_authored_waste_wins_over_the_subtraction(self):
        """
        The game authors WasteHeatPerTick; it is not `heat - energy` evaluated
        in floating point. At generator 7's tiers the two differ in the last
        few digits, and the authored figure is the one the game uses.
        """
        defs = [
            _one_level(
                GeneratorDefinition, GeneratorLevel(8.85e21, 6.64e21, 2.21e21), "gen7"
            )
        ]

        gen = get_effective_buildings(defs, {"gen7": 0})[0]

        self.assertEqual(gen.waste, 2.21e21)
        self.assertNotEqual(8.85e21 - 6.64e21, 2.21e21, "the subtraction does not land there")

    def test_waste_falls_back_to_the_games_own_derivation(self):
        """A source that authors no waste gets snap(heat - energy), not the raw
        subtraction -- which is how the game computes the authored value."""
        defs = [_one_level(GeneratorDefinition, GeneratorLevel(8.85e21, 6.64e21), "gen7")]

        gen = get_effective_buildings(defs, {"gen7": 0})[0]

        self.assertEqual(gen.waste, 2.21e21)

    def test_defaults_to_the_shipped_catalogue_and_unlocks(self):
        self.assertEqual(get_effective_buildings(), get_effective_buildings(BUILDINGS, UNLOCKED_UPGRADES))


class CatalogueIntegrityTests(SimulationTestCase):
    """Guards against typos in the hand-maintained roster data."""

    def test_building_ids_are_unique(self):
        ids = [b.id for b in BUILDINGS]

        self.assertEqual(len(ids), len(set(ids)))

    def test_every_unlock_entry_refers_to_a_real_building(self):
        known = {b.id for b in BUILDINGS}

        unknown = sorted(set(UNLOCKED_UPGRADES) - known)

        self.assertEqual(unknown, [], "UNLOCKED_UPGRADES references missing buildings")

    def test_every_building_has_a_known_type_and_positive_tiers(self):
        for building in BUILDINGS:
            with self.subTest(building=building.id):
                self.assertIn(
                    building.type, ("cooler", "reactor", "generator", "direct_producer")
                )
                self.assertGreater(len(building.levels), 0)
                for level in building.levels:
                    self.assertGreater(level.value, 0)

    def test_upgrade_tiers_increase_monotonically(self):
        for building in BUILDINGS:
            with self.subTest(building=building.id):
                values = [level.value for level in building.levels]
                self.assertEqual(
                    values, sorted(values),
                    "a later upgrade tier should never be worth less",
                )

    def test_only_producers_convert_heat_into_power(self):
        for building in BUILDINGS:
            with self.subTest(building=building.id):
                if building.type not in ("generator", "direct_producer"):
                    self.assertFalse(
                        any(hasattr(level, "energy") for level in building.levels),
                        "coolers and reactors have no energy figure at all",
                    )
                    continue

                for index, level in enumerate(building.levels):
                    with self.subTest(level=index):
                        self.assertGreater(level.energy, 0)
                        self.assertLess(
                            level.energy, level.heat,
                            "some of the heat always has to be wasted",
                        )

    def test_authored_waste_is_the_games_own_derivation(self):
        for building in BUILDINGS:
            if building.type not in ("generator", "direct_producer"):
                continue
            for index, level in enumerate(building.levels):
                with self.subTest(building=building.id, level=index):
                    self.assertIsNotNone(level.waste, "the catalogue authors every waste figure")
                    self.assertEqual(
                        level.waste, snap_to_authored_precision(level.heat - level.energy)
                    )

    def test_cooler2_matches_authored_game_values(self):
        cooler2 = next(b for b in BUILDINGS if b.id == "cooler2")

        self.assertEqual(
            [level.cooling for level in cooler2.levels],
            [3200, 5760, 10368, 18662, 33592, 60466],
            "the authored values, not the 3-significant-figure ones the UI shows",
        )

    def test_generator1_has_seven_heat_tiers_ending_in_5120(self):
        generator = next(b for b in BUILDINGS if b.id == "generator")

        self.assertEqual([level.heat for level in generator.levels],
                         [80, 160, 320, 640, 1280, 2560, 5120])
        self.assertEqual(UNLOCKED_UPGRADES["generator"], 6)

    def test_the_catalogue_carries_the_games_authored_conversion(self):
        roster = {b.id: b for b in get_effective_buildings()}

        self.assertEqual(roster["generator"].energy, 3840)
        self.assertEqual(roster["generator"].waste, 1280)
        self.assertEqual(roster["wind_turbine"].energy, 7)
        self.assertEqual(roster["wind_turbine"].waste, 1.75)

    def test_the_shipped_roster_can_actually_build_something(self):
        roster = get_effective_buildings()
        types = {b.type for b in roster}

        self.assertIn("cooler", types)
        self.assertIn("generator", types)
        self.assertIn("reactor", types)
