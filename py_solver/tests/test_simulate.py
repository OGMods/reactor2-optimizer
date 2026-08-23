"""
Tests for simulate_island: the placement evaluator.

This is the function the search calls millions of times per solve, so it is
also the one most likely to be "optimized" into subtly wrong behaviour. The
rules encoded here come from docs/game-logic.md, chiefly the authored
per-tier conversion, the all-or-nothing cooling rule, and the guarantee that
cooling never feeds back into heat.
"""

from solver.constants import GENERATOR_ENERGY_RATIO, GENERATOR_WASTE_RATIO
from solver.physics import snap_to_authored_precision, waste_is_covered
from solver.simulate import simulate_island
from solver.types import EffectiveBuilding
from tests.helpers import (
    SimulationTestCase,
    cooler,
    direct_producer,
    generator,
    place,
    placements_by_pos,
    reactor,
)


class GeneratorPhysicsTests(SimulationTestCase):
    def test_generator_converts_75_percent_of_heat_to_power(self):
        layout = place(
            ["RGC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25)},
        )

        power, placements = simulate_island(layout)
        by_pos = placements_by_pos(placements)

        self.assertClose(power, 75.0, "100 heat in -> 75 power")
        self.assertClose(by_pos[(1, 0)].heat_consumed, 100.0)
        self.assertClose(by_pos[(1, 0)].waste_heat_generated, 25.0)
        self.assertClose(by_pos[(1, 0)].power_generated, 75.0)

    def test_conversion_ratios_are_the_documented_constants(self):
        self.assertEqual(GENERATOR_ENERGY_RATIO, 0.75)
        self.assertEqual(GENERATOR_WASTE_RATIO, 0.25)
        self.assertEqual(GENERATOR_ENERGY_RATIO + GENERATOR_WASTE_RATIO, 1.0)

    def test_generator_input_is_capped_by_its_own_capacity(self):
        """A reactor's surplus heat is lost, not stored or rerouted."""
        layout = place(
            ["RGC"],
            {"R": reactor(500), "G": generator(100), "C": cooler(25)},
        )

        power, placements = simulate_island(layout)
        by_pos = placements_by_pos(placements)

        self.assertClose(power, 75.0)
        self.assertClose(by_pos[(1, 0)].heat_consumed, 100.0, "H_in cannot exceed H_max")
        self.assertClose(by_pos[(0, 0)].heat_produced, 100.0, "reactor only reports what it sent")

    def test_generator_with_no_adjacent_reactor_produces_nothing(self):
        layout = place(
            ["R.GC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25)},
        )

        power, _ = simulate_island(layout)

        self.assertClose(power, 0.0)

    def test_two_reactors_can_feed_one_generator(self):
        layout = place(
            ["RGR", ".C."],
            {"R": reactor(40), "G": generator(100), "C": cooler(25)},
        )

        power, placements = simulate_island(layout)

        self.assertClose(placements_by_pos(placements)[(1, 0)].heat_consumed, 80.0)
        self.assertClose(power, 60.0)

    def test_a_generator_converts_at_its_own_authored_rate(self):
        """
        Generator 7 tier 4: heat 8.85e21, energy 6.64e21, waste 2.21e21 -- a
        conversion of 0.7503, not 0.75. Every generator authors its own pair,
        so a fixed ratio would quietly overstate this one.
        """
        gen = EffectiveBuilding(
            id="generator7",
            type="generator",
            effective_value=8.85e21,
            energy=6.64e21,
            waste=snap_to_authored_precision(8.85e21 - 6.64e21),
        )
        layout = place(
            ["RGC"],
            {"R": reactor(8.85e21), "G": gen, "C": cooler(gen.waste)},
        )

        power, placements = simulate_island(layout)

        self.assertClose(power, 6.64e21)
        self.assertClose(placements_by_pos(placements)[(1, 0)].waste_heat_generated, 2.21e21)
        self.assertNotEqual(power, 8.85e21 * GENERATOR_ENERGY_RATIO, "not the 0.75 fallback")

    def test_a_generator_scales_both_figures_by_how_full_it_is(self):
        """Half the heat in, half the power and half the waste out."""
        gen = EffectiveBuilding(
            id="odd", type="generator", effective_value=100.0, energy=70.0, waste=30.0
        )
        layout = place(
            ["RGC"],
            {"R": reactor(50), "G": gen, "C": cooler(15.0)},
        )

        power, placements = simulate_island(layout)

        self.assertClose(power, 35.0)
        self.assertClose(placements_by_pos(placements)[(1, 0)].waste_heat_generated, 15.0)


class CoolingToleranceTests(SimulationTestCase):
    """`waste_is_covered` is relative, not a fixed epsilon."""

    def test_a_late_game_ulp_shortfall_still_counts_as_covered(self):
        """
        One ULP at 1e21 is ~1e5, so an absolute epsilon decides nothing up
        here: it would shut down a generator that the game keeps running.
        """
        waste = 1e21
        cooling = waste - waste * 1e-12

        self.assertTrue(waste_is_covered(waste, cooling))

    def test_a_real_shortfall_is_still_a_shortfall_at_any_scale(self):
        self.assertFalse(waste_is_covered(1e21, 1e21 * 0.999))
        self.assertFalse(waste_is_covered(10.0, 9.0))


class CoolingRuleTests(SimulationTestCase):
    """The all-or-nothing rule: online iff waste <= cooling routed."""

    def test_exactly_enough_cooling_keeps_the_building_online(self):
        """The comparison is <=, so cooling equal to waste is valid."""
        layout = place(
            ["RGC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25.0)},
        )

        power, placements = simulate_island(layout)

        self.assertClose(power, 75.0, "cooling exactly equal to waste must stay online")
        self.assertClose(placements_by_pos(placements)[(1, 0)].cooling_received, 25.0)

    def test_slightly_insufficient_cooling_shuts_the_building_down_completely(self):
        layout = place(
            ["RGC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(24.9)},
        )

        power, placements = simulate_island(layout)
        gen = placements_by_pos(placements)[(1, 0)]

        self.assertClose(power, 0.0, "partial cooling means zero power, not reduced power")
        self.assertClose(gen.power_generated, 0.0)
        self.assertClose(
            gen.heat_consumed, 100.0,
            "heat stays allocated even though the generator is offline",
        )
        self.assertClose(gen.waste_heat_generated, 25.0)

    def test_offline_building_does_not_return_its_heat(self):
        """
        Two generators fed by one reactor; only the first has cooling. The
        offline generator must NOT hand its heat back for the online one to
        use -- if it did, generator A (capacity 200) would end up at 200 heat
        and 150 power instead of 100 heat and 75 power.
        """
        layout = place(
            ["ARB", "C.."],
            {
                "A": generator(200, id="gen_big"),
                "R": reactor(200),
                "B": generator(100, id="gen_small"),
                "C": cooler(50),
            },
        )

        power, placements = simulate_island(layout)
        by_pos = placements_by_pos(placements)

        # FairShare splits the reactor 100/100 before cooling is considered.
        self.assertClose(by_pos[(0, 0)].heat_consumed, 100.0, "heat is not reassigned")
        self.assertClose(by_pos[(2, 0)].heat_consumed, 100.0)
        self.assertClose(by_pos[(2, 0)].power_generated, 0.0, "uncooled generator is offline")
        self.assertClose(power, 75.0)

    def test_one_cooler_split_between_two_producers_can_starve_both(self):
        """
        A trap worth pinning down: cooling FairShares evenly, and the online
        check is all-or-nothing, so a single cooler adjacent to two generators
        gives each half of what it needs and BOTH shut down. Total power is 0
        even though the cooler has exactly enough capacity for one of them.
        """
        layout = place(
            ["GRG", ".C."],
            {"R": reactor(200), "G": generator(100), "C": cooler(25)},
        )

        power, placements = simulate_island(layout)
        by_pos = placements_by_pos(placements)

        self.assertClose(by_pos[(0, 0)].cooling_received, 12.5)
        self.assertClose(by_pos[(2, 0)].cooling_received, 12.5)
        self.assertClose(power, 0.0, "half the required cooling powers nothing")

    def test_no_coolers_means_no_power(self):
        layout = place(
            ["RG"],
            {"R": reactor(100), "G": generator(100)},
        )

        power, placements = simulate_island(layout)

        self.assertClose(power, 0.0)
        self.assertEqual(len(placements), 2, "every occupied tile is still reported")

    def test_cooler_reports_only_the_cooling_it_actually_routed(self):
        layout = place(
            ["RGC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(1000)},
        )

        _, placements = simulate_island(layout)

        self.assertClose(
            placements_by_pos(placements)[(2, 0)].cooling_provided, 25.0,
            "spare cooling capacity sits idle",
        )


class DirectProducerTests(SimulationTestCase):
    def test_direct_producer_commits_full_load(self):
        layout = place(
            ["DC"],
            {"D": direct_producer(100, 0.2), "C": cooler(20)},
        )

        power, placements = simulate_island(layout)
        dp = placements_by_pos(placements)[(0, 0)]

        self.assertClose(power, 80.0, "power = the level's energy figure")
        self.assertClose(dp.waste_heat_generated, 20.0, "waste = what it makes minus what it converts")

    def test_direct_producer_obeys_the_all_or_nothing_cooling_rule(self):
        layout = place(
            ["DC"],
            {"D": direct_producer(100, 0.2), "C": cooler(19.9)},
        )

        power, _ = simulate_island(layout)

        self.assertClose(power, 0.0)

    def test_direct_producer_never_participates_in_heat_distribution(self):
        """A reactor next to a direct producer must not be able to feed it."""
        layout = place(
            ["RDC"],
            {"R": reactor(100), "D": direct_producer(100, 0.2), "C": cooler(20)},
        )

        power, placements = simulate_island(layout)
        by_pos = placements_by_pos(placements)

        self.assertClose(by_pos[(0, 0)].heat_produced, 0.0, "reactor has no valid consumer")
        self.assertClose(power, 80.0, "the direct producer's own output is unaffected")

    def test_direct_producer_and_generator_share_cooling(self):
        layout = place(
            ["RGCD"],
            {
                "R": reactor(100),
                "G": generator(100),
                "C": cooler(45),
                "D": direct_producer(100, 0.2),
            },
        )

        power, _ = simulate_island(layout)

        # 45 cooling covers the generator's 25 waste and the producer's 20.
        self.assertClose(power, 75.0 + 80.0)


class CrossInstanceIsolationTests(SimulationTestCase):
    """Spec: heat distribution never considers cooling, and vice versa."""

    def test_generator_heat_input_is_identical_regardless_of_cooling(self):
        """Spec: "generator.H_in cannot change because of cooling"."""
        fully_cooled = place(
            ["RGC"], {"R": reactor(100), "G": generator(100), "C": cooler(25)}
        )
        barely_cooled = place(
            ["RGC"], {"R": reactor(100), "G": generator(100), "C": cooler(1)}
        )

        cooled_power, cooled_placements = simulate_island(fully_cooled)
        starved_power, starved_placements = simulate_island(barely_cooled)

        self.assertClose(
            placements_by_pos(starved_placements)[(1, 0)].heat_consumed, 100.0,
            "H_in is fixed by heat distribution before cooling is evaluated",
        )
        self.assertClose(
            placements_by_pos(cooled_placements)[(1, 0)].heat_consumed, 100.0,
        )
        self.assertClose(cooled_power, 75.0)
        self.assertClose(starved_power, 0.0, "only the ONLINE decision changes")

    def test_adding_cooling_never_reduces_power(self):
        legend = {"R": reactor(100), "G": generator(100), "C": cooler(25)}

        without, _ = simulate_island(place(["RG."], legend))
        with_cooler, _ = simulate_island(place(["RGC"], legend))

        self.assertGreaterEqual(with_cooler, without)


class FastPathTests(SimulationTestCase):
    """The early-exit branches must agree with the full path."""

    def test_zero_cooler_shortcut_reports_no_diagnostics(self):
        """
        Documents a deliberate shortcut: with no cooler placed, nothing can be
        online, so simulate_island returns 0 immediately WITHOUT running heat
        distribution. Per-building diagnostics (heat_consumed, waste, ...) are
        therefore all zero in this state -- only the total power is meaningful.
        The search relies on this being fast, so if you ever make the fast path
        populate real values, keep an eye on solve throughput.
        """
        layout = place(["RG"], {"R": reactor(100), "G": generator(100)})

        power, placements = simulate_island(layout)
        gen = placements_by_pos(placements)[(1, 0)]

        self.assertClose(power, 0.0)
        self.assertClose(gen.heat_consumed, 0.0)
        self.assertClose(gen.base_value, 100.0, "base_value is still reported")

    def test_layout_with_no_power_producers_scores_zero(self):
        layout = place(["RC"], {"R": reactor(100), "C": cooler(100)})

        power, placements = simulate_island(layout)

        self.assertClose(power, 0.0)
        self.assertEqual(len(placements), 2)

    def test_empty_layout(self):
        power, placements = simulate_island({})

        self.assertClose(power, 0.0)
        self.assertEqual(placements, [])

    def test_every_occupied_tile_is_reported_exactly_once(self):
        layout = place(
            ["RGC", "DR.", "CGR"],
            {
                "R": reactor(100),
                "G": generator(100),
                "C": cooler(50),
                "D": direct_producer(10, 0.2),
            },
        )

        _, placements = simulate_island(layout)

        self.assertEqual(len(placements), len(layout))
        self.assertEqual({(p.x, p.y) for p in placements}, set(layout))
        for pos, building in layout.items():
            self.assertEqual(placements_by_pos(placements)[pos].building_id, building.id)

    def test_base_value_is_recorded_for_every_building(self):
        layout = place(["RGC"], {"R": reactor(100), "G": generator(80), "C": cooler(25)})

        _, placements = simulate_island(layout)
        by_pos = placements_by_pos(placements)

        self.assertClose(by_pos[(0, 0)].base_value, 100.0)
        self.assertClose(by_pos[(1, 0)].base_value, 80.0)
        self.assertClose(by_pos[(2, 0)].base_value, 25.0)


class NeighborMapConsistencyTests(SimulationTestCase):
    def test_precomputed_neighbor_map_matches_derived_adjacency(self):
        from solver.rules import build_neighbor_map

        layout = place(
            ["RGC", "GRG", "CGR"],
            {"R": reactor(100), "G": generator(60), "C": cooler(40)},
        )
        neighbor_map = build_neighbor_map(list(layout))

        slow_power, slow_placements = simulate_island(layout, None)
        fast_power, fast_placements = simulate_island(layout, neighbor_map)

        self.assertClose(fast_power, slow_power)
        slow_by_pos = placements_by_pos(slow_placements)
        for pos, fast in placements_by_pos(fast_placements).items():
            self.assertClose(fast.power_generated, slow_by_pos[pos].power_generated, f"at {pos}")
            self.assertClose(fast.heat_consumed, slow_by_pos[pos].heat_consumed, f"at {pos}")
            self.assertClose(fast.cooling_received, slow_by_pos[pos].cooling_received, f"at {pos}")
