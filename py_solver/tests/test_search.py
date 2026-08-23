"""
Tests for the per-island placement search.

The search is stochastic, so these tests assert invariants and quality FLOORS
rather than exact layouts. The one deterministic stage -- multi-start seed
construction -- is pinned down separately, because it is what every annealing
run starts from and a regression there quietly costs power on every solve.
"""

import time
from collections import Counter

from data.effective_buildings import get_effective_buildings
from blueprint import decode_blueprint
from data.maps import MAPS_BY_NUM
from solver.island import estimate_island_max_power, split_grid_into_islands
from solver.constants import GENERATOR_ENERGY_RATIO, GENERATOR_WASTE_RATIO
from solver.rules import build_neighbor_map
from solver.rng import Rng
from solver.placement_search import (
    _DOWNGRADE_ROLES,
    _buildable_tiles,
    _construct_multi_start_seed,
    _downgrade_oversized,
    _downgrade_tiers,
    _hill_climb,
    _offline_producers,
    _prune_dead_weight,
    _target_compositions,
    _tile_load,
    solve_island,
)
from solver.simulate import simulate_island
from solver.types import EffectiveBuilding
from tests.helpers import (
    SimulationTestCase,
    basic_roster,
    cooler,
    direct_producer,
    generator,
    make_grid,
    place,
    placements_by_pos,
    reactor,
)


def island_from(rows, roster=None):
    grid = make_grid(rows)
    islands = split_grid_into_islands(grid, roster or basic_roster())
    assert islands, "test grid produced no islands"
    return islands[0]


def sorted_pools(roster):
    """The four building pools in the order solve_island builds them."""
    reactors = sorted(
        (b for b in roster if b.type == "reactor"),
        key=lambda b: -b.effective_value,
    )
    generators = sorted(
        (b for b in roster if b.type == "generator"), key=lambda b: -b.effective_value
    )
    coolers = sorted(
        (b for b in roster if b.type == "cooler"), key=lambda b: -b.effective_value
    )
    direct_producers = sorted(
        (b for b in roster if b.type == "direct_producer"),
        key=lambda b: -b.energy,
    )
    return reactors, generators, coolers, direct_producers


class SolveIslandContractTests(SimulationTestCase):
    """Whatever the search decides, the result must be structurally valid."""

    def test_returns_nothing_for_an_island_with_no_buildable_tiles(self):
        island = island_from(["GGG"])
        for row in island.grid:
            for tile in row:
                tile.type = "water"

        placements, power = solve_island(island, basic_roster(), 0.1)

        self.assertEqual(placements, [])
        self.assertClose(power, 0.0)

    def test_returns_nothing_without_coolers(self):
        island = island_from(["GGGG"])

        placements, power = solve_island(island, [reactor(100), generator(100)], 0.2)

        self.assertEqual(placements, [])
        self.assertClose(power, 0.0)

    def test_returns_nothing_without_any_producer(self):
        island = island_from(["GGGG"])

        placements, power = solve_island(island, [cooler(100), reactor(100)], 0.2)

        self.assertEqual(placements, [])
        self.assertClose(power, 0.0)

    def test_places_at_most_one_building_per_tile_inside_the_island(self):
        island = island_from(["GGGG", "GGGG"])

        placements, _ = solve_island(island, basic_roster(), 0.5)

        positions = [(p.x, p.y) for p in placements]
        self.assertEqual(len(positions), len(set(positions)), "duplicate tile used")
        buildable = set(_buildable_tiles(island.grid))
        for pos in positions:
            self.assertIn(pos, buildable, "building placed off the island's grass")

    def test_only_uses_buildings_from_the_roster(self):
        island = island_from(["GGGG", "GGGG"])
        roster = basic_roster(dp_value=10, dp_waste_ratio=0.2)

        placements, _ = solve_island(island, roster, 0.5)

        available = {b.id for b in roster}
        for p in placements:
            self.assertIn(p.building_id, available)

    def test_never_places_a_producer_that_generates_no_power(self):
        """
        The core stability requirement: the answer is a grid where everything
        placed actually runs. A generator or direct producer that overheats --
        or that never receives heat -- must not appear in the result at all.
        """
        island = island_from(["GGGGG", "GGGGG", "GGGGG"])
        roster = basic_roster(dp_value=100.0, dp_waste_ratio=0.2)
        by_id = {b.id: b for b in roster}

        for attempt in range(5):
            placements, _ = solve_island(island, roster, 0.3)
            with self.subTest(attempt=attempt):
                for p in placements:
                    building = by_id[p.building_id]
                    is_producer = (
                        building.type in ("generator", "direct_producer")
                    )
                    if is_producer:
                        self.assertGreater(
                            p.power_generated, 0.0,
                            f"{p.building_id} at ({p.x},{p.y}) is placed but generates nothing",
                        )

    def test_reported_power_matches_a_fresh_simulation_of_the_layout(self):
        """
        The search caches simulation results as it goes; this checks the number
        it finally reports still matches what the layout actually scores.
        """
        island = island_from(["GGGGG", "GGGGG", "GGGGG"])
        roster = basic_roster()
        by_id = {b.id: b for b in roster}

        placements, reported_power = solve_island(island, roster, 1.0)

        layout = {(p.x, p.y): by_id[p.building_id] for p in placements}
        actual_power, _ = simulate_island(layout)

        self.assertClose(actual_power, reported_power, rel=1e-9)

    def test_finds_the_obvious_three_tile_solution(self):
        island = island_from(["GGG"])
        roster = [reactor(100), generator(100), cooler(25)]

        placements, power = solve_island(island, roster, 0.5)

        self.assertClose(power, 75.0, "one reactor + generator + cooler = 75 power")
        self.assertEqual(len(placements), 3)

    def test_uses_a_direct_producer_when_only_two_tiles_are_available(self):
        roster = basic_roster(dp_value=100.0, dp_waste_ratio=0.2)
        island = island_from(["GG"], roster)

        placements, power = solve_island(island, roster, 0.5)

        self.assertClose(power, 80.0, "direct producer + cooler is the only viable pair")
        self.assertEqual({p.building_id for p in placements}, {"dp", "cooler"})

    def test_respects_its_time_budget(self):
        island = island_from(["GGGGGG"] * 6)

        started = time.time()
        solve_island(island, basic_roster(), 0.5)
        elapsed = time.time() - started

        self.assertLess(elapsed, 3.0, "solve_island overran its 0.5s budget badly")

    def test_a_zero_time_budget_still_returns_a_valid_result(self):
        island = island_from(["GGGG", "GGGG"])

        placements, power = solve_island(island, basic_roster(), 0.0)

        self.assertGreaterEqual(power, 0.0)
        positions = [(p.x, p.y) for p in placements]
        self.assertEqual(len(positions), len(set(positions)))


class SeedConstructionTests(SimulationTestCase):
    """Multi-start seed construction is deterministic and must stay that way."""

    def _seed(self, island, roster, budget_s=30.0):
        buildable = _buildable_tiles(island.grid)
        neighbor_map = build_neighbor_map(buildable)
        reactors, generators, coolers, dps = sorted_pools(roster)
        seed = _construct_multi_start_seed(
            buildable, reactors, generators, coolers, dps,
            time.time() + budget_s, neighbor_map,
        )
        power, _ = simulate_island(seed, neighbor_map)
        return seed, power

    def test_seed_construction_is_deterministic(self):
        island = island_from(["GGGGG", "GGGGG", "GGGGG"])
        roster = basic_roster()

        first, first_power = self._seed(island, roster)
        second, second_power = self._seed(island, roster)

        self.assertEqual(
            {pos: b.id for pos, b in first.items()},
            {pos: b.id for pos, b in second.items()},
            "the same island and roster must always seed identically",
        )
        self.assertClose(first_power, second_power)

    def test_buildable_tiles_are_returned_in_the_games_spatial_order(self):
        island = island_from(["GGG", "GGG"])

        tiles = _buildable_tiles(island.grid)

        self.assertEqual(tiles, sorted(tiles, key=lambda p: (p[0], -p[1])))

    def test_seed_reaches_a_high_fraction_of_the_theoretical_bound(self):
        """
        A quality floor on the real game roster and a real map. The seed
        normally lands within a few percent of the (loose) upper bound; this
        fails loudly if a change to the construction heuristic guts it.
        """
        game_map = MAPS_BY_NUM[1]
        roster = get_effective_buildings()
        grid = decode_blueprint(game_map.code).grid
        island = split_grid_into_islands(grid, roster)[0]

        _, power = self._seed(island, roster)
        bound = estimate_island_max_power(island, roster)

        self.assertGreater(
            power, 0.75 * bound,
            f"seed power {power:.3e} is far below the {bound:.3e} bound",
        )


class PruneDeadWeightTests(SimulationTestCase):
    def test_pruning_a_stable_layout_never_reduces_power(self):
        """
        Pruning may only lose power by removing an overheating building. Once
        a layout is already stable, the remaining sweep over support buildings
        is strictly guarded and can never cost anything.
        """
        layout = place(
            ["RGC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25)},
        )
        before, placements = simulate_island(layout)
        self.assertEqual(
            _offline_producers(layout, placements), [],
            "precondition: this layout is already stable",
        )

        _, after = _prune_dead_weight(layout)

        self.assertGreaterEqual(after, before - 1e-9)

    def test_removes_a_generator_that_produces_nothing(self):
        """A generator with no reactor and no cooling is pure dead weight."""
        layout = place(
            ["RGC.G"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25)},
        )

        placements, power = _prune_dead_weight(layout)

        self.assertClose(power, 75.0)
        self.assertNotIn(
            (4, 0), {(p.x, p.y) for p in placements}, "offline generator was kept"
        )

    def test_removes_redundant_support_buildings(self):
        """Two coolers where one suffices: the spare should be pruned away."""
        layout = place(
            ["RGCC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25)},
        )

        placements, power = _prune_dead_weight(layout)

        self.assertClose(power, 75.0)
        self.assertEqual(
            len(placements), 3, "the second cooler contributes nothing and should go"
        )

    def test_removes_an_offline_producer_even_when_it_costs_power(self):
        """
        The goal is a fully stable layout: every placed producer must run. An
        overheating building is never acceptable, even when keeping it would
        score higher.

        Here the reactor (200) splits 100/100 between two generators, and only
        the big one has cooling. Keeping the offline generator scores 75,
        because it parks half the reactor's heat where nothing has to cool it.
        Dropping it hands all 200 heat to the big generator, whose waste (50)
        then exceeds its cooler (25) -- so it goes offline too and gets removed
        in turn. The stable answer for this layout is nothing at all.
        """
        layout = place(
            ["ARB", "C.."],
            {
                "A": generator(200, id="gen_big"),
                "R": reactor(200),
                "B": generator(100, id="gen_small"),
                "C": cooler(25),
            },
        )
        self.assertClose(
            simulate_island(layout)[0], 75.0,
            "precondition: the unstable layout scores 75 before pruning",
        )

        placements, power = _prune_dead_weight(layout)

        self.assertNotIn(
            (2, 0), {(p.x, p.y) for p in placements},
            "the overheating generator must not survive pruning",
        )
        self.assertClose(power, 0.0, "removal cascades: the big generator then overheats too")
        # The cascade is the point: removing one offline producer can push
        # another one offline, so a single unchecked pass is not enough.
        self.assertEqual(
            [p.building_id for p in placements if p.building_id.startswith("gen")], [],
            "the big generator overheats once the small one goes and must go too",
        )

    def test_result_never_contains_a_producer_generating_no_power(self):
        """The invariant every pruned layout must satisfy."""
        layout = place(
            ["RGCR", "GCRG", "CGRC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25)},
        )

        placements, _ = _prune_dead_weight(layout)

        for p in placements:
            if p.building_id in ("generator", "dp"):
                self.assertGreater(
                    p.power_generated, 0.0, f"idle producer left at ({p.x},{p.y})"
                )

    def test_keeps_a_cooler_that_is_actually_needed(self):
        layout = place(
            ["RGC"],
            {"R": reactor(100), "G": generator(100), "C": cooler(25)},
        )

        placements, power = _prune_dead_weight(layout)

        self.assertClose(power, 75.0)
        self.assertEqual(len(placements), 3)

    def test_empty_layout(self):
        placements, power = _prune_dead_weight({})

        self.assertEqual(placements, [])
        self.assertClose(power, 0.0)


class DowngradeOversizedTests(SimulationTestCase):
    """
    Right-sizing runs on the finished layout, so what it may change is narrow:
    the tier on a tile, never which tiles are occupied, and never the power.
    """

    def rebuild(self, placements, roster):
        """The placement dict behind a returned layout, for stability checks."""
        by_id = {b.id: b for b in roster}
        return {(p.x, p.y): by_id[p.building_id] for p in placements}

    def test_swaps_an_oversized_cooler_for_the_smallest_tier_that_covers_it(self):
        """The scenario the pass exists for: a cooler running at 2.5%."""
        roster = [
            reactor(100),
            generator(100),
            cooler(10, id="cooler_s"),
            cooler(25, id="cooler_m"),
            cooler(1000, id="cooler_l"),
        ]
        layout = place(["RGC"], {"R": roster[0], "G": roster[1], "C": roster[4]})
        power, placements = simulate_island(layout)

        placements, after = _downgrade_oversized(placements, power, roster)

        self.assertClose(after, power, "right-sizing must not cost power")
        self.assertEqual(
            placements_by_pos(placements)[(2, 0)].building_id, "cooler_m",
            "the generator wastes 25, so the 25 tier is the smallest that covers it",
        )

    def test_downgrades_a_reactor_to_the_heat_it_actually_sends(self):
        """
        The generator caps at 100, so 900 of the reactor's 1000 heat is never
        absorbed and the tier producing it is paid for and idle.
        """
        roster = [
            reactor(50, id="reactor_s"),
            reactor(100, id="reactor_m"),
            reactor(1000, id="reactor_l"),
            generator(100),
            cooler(25),
        ]
        layout = place(["RGC"], {"R": roster[2], "G": roster[3], "C": roster[4]})
        power, placements = simulate_island(layout)

        placements, after = _downgrade_oversized(placements, power, roster)

        self.assertClose(after, power)
        self.assertEqual(
            placements_by_pos(placements)[(0, 0)].building_id, "reactor_m",
            "the 50 tier would starve the generator, so 100 is the floor here",
        )

    def test_downgrades_a_generator_to_its_settled_intake(self):
        """A generator filled to 10% makes the same power on a tier ten times smaller."""
        roster = [
            reactor(100),
            generator(100, id="generator_s"),
            generator(1000, id="generator_l"),
            cooler(25),
        ]
        layout = place(["RGC"], {"R": roster[0], "G": roster[2], "C": roster[3]})
        power, placements = simulate_island(layout)

        placements, after = _downgrade_oversized(placements, power, roster)

        self.assertClose(after, power)
        self.assertEqual(
            placements_by_pos(placements)[(1, 0)].building_id, "generator_s"
        )

    def test_leaves_a_direct_producer_alone(self):
        """
        A direct producer runs flat out by definition, so it has no slack to
        give back -- a smaller tier is simply less power.
        """
        roster = [
            direct_producer(100, 0.2, id="dp_s"),
            direct_producer(1000, 0.2, id="dp_l"),
            cooler(200),
        ]
        layout = place(["DC"], {"D": roster[1], "C": roster[2]})
        power, placements = simulate_island(layout)

        placements, after = _downgrade_oversized(placements, power, roster)

        self.assertClose(after, power)
        self.assertEqual(placements_by_pos(placements)[(0, 0)].building_id, "dp_l")

    def test_keeps_a_tier_that_is_exactly_used(self):
        roster = [reactor(100), generator(100), cooler(10, id="cooler_s"), cooler(25)]
        layout = place(["RGC"], {"R": roster[0], "G": roster[1], "C": roster[3]})
        power, placements = simulate_island(layout)

        placements, after = _downgrade_oversized(placements, power, roster)

        self.assertClose(after, power)
        self.assertEqual(placements_by_pos(placements)[(2, 0)].building_id, "cooler")

    def test_sweeps_again_after_a_downgrade_frees_another_one(self):
        """
        One sweep is not enough. Shrinking the generator cuts the waste its
        cooler has to absorb, which frees a cooler tier the sweep has already
        walked past -- the cooler sits at (0,0) and is visited first.

        The two generator tiers deliberately do NOT share a waste ratio, which
        is what makes the second sweep observable: the big one wastes 40 at the
        fill this layout gives it, the small one 25 at the same intake.
        """
        gen_l = EffectiveBuilding(
            id="generator_l", type="generator", effective_value=1000,
            energy=750, waste=400,
        )
        gen_s = EffectiveBuilding(
            id="generator_s", type="generator", effective_value=100,
            energy=75, waste=25,
        )
        roster = [
            reactor(100),
            gen_s,
            gen_l,
            cooler(25, id="cooler_s"),
            cooler(40, id="cooler_m"),
            cooler(1000, id="cooler_l"),
        ]
        layout = place(["CGR"], {"C": roster[5], "G": gen_l, "R": roster[0]})
        power, placements = simulate_island(layout)
        self.assertClose(power, 75.0, "precondition: 10% fill of a 750-energy tier")

        placements, after = _downgrade_oversized(placements, power, roster)

        by_pos = placements_by_pos(placements)
        self.assertClose(after, power)
        self.assertEqual(by_pos[(1, 0)].building_id, "generator_s")
        self.assertEqual(
            by_pos[(0, 0)].building_id, "cooler_s",
            "the first sweep can only reach cooler_m (40); cooler_s needs a second",
        )

    def test_never_returns_an_offline_producer(self):
        """
        Covering a tile's current load is what makes a candidate plausible, not
        what makes it safe: a smaller supplier splits its output differently.
        Every swap is re-simulated, so the stability rule survives the pass.
        """
        roster = [
            reactor(100),
            reactor(400, id="reactor_l"),
            generator(100),
            generator(400, id="generator_l"),
            cooler(25),
            cooler(100, id="cooler_l"),
            cooler(4000, id="cooler_xl"),
        ]
        layout = place(
            ["RGCR", "GCRG", "CGRC"],
            {"R": roster[1], "G": roster[3], "C": roster[6]},
        )
        power, placements = simulate_island(layout)

        placements, after = _downgrade_oversized(placements, power, roster)

        self.assertGreaterEqual(after, power - abs(power) * 1e-9)
        self.assertEqual(
            _offline_producers(self.rebuild(placements, roster), placements), []
        )

    def test_every_returned_tier_still_covers_its_own_load(self):
        """The property the pass is selling: no tier is left doing more than it can."""
        roster = [
            reactor(100),
            reactor(400, id="reactor_l"),
            generator(100),
            generator(400, id="generator_l"),
            cooler(25),
            cooler(4000, id="cooler_xl"),
        ]
        layout = place(
            ["RGCR", "GCRG", "CGRC"],
            {"R": roster[1], "G": roster[3], "C": roster[5]},
        )
        power, placements = simulate_island(layout)

        placements, _ = _downgrade_oversized(placements, power, roster)

        rebuilt = self.rebuild(placements, roster)
        for p in placements:
            building = rebuilt[(p.x, p.y)]
            if building.type not in _DOWNGRADE_ROLES:
                continue
            self.assertGreaterEqual(
                building.effective_value,
                _tile_load(building, p) - 1e-9,
                f"{building.id} at ({p.x},{p.y}) cannot carry its own load",
            )

    def test_occupies_exactly_the_same_tiles(self):
        """Right-sizing re-tiers; removing dead weight is `_prune_dead_weight`'s job."""
        roster = [reactor(100), generator(100), cooler(25), cooler(1000, id="cooler_l")]
        layout = place(["RGC"], {"R": roster[0], "G": roster[1], "C": roster[3]})
        power, placements = simulate_island(layout)

        after_placements, _ = _downgrade_oversized(placements, power, roster)

        self.assertEqual(
            sorted((p.x, p.y) for p in after_placements),
            sorted((p.x, p.y) for p in placements),
        )

    def test_empty_layout(self):
        placements, power = _downgrade_oversized([], 0.0, basic_roster())

        self.assertEqual(placements, [])
        self.assertClose(power, 0.0)

    def test_tier_ladders_are_ascending_and_exclude_direct_producers(self):
        tiers = _downgrade_tiers(
            [
                cooler(1000, id="cooler_l"),
                cooler(25),
                reactor(100),
                generator(100),
                direct_producer(100, 0.2),
            ]
        )

        self.assertEqual([b.id for b in tiers["cooler"]], ["cooler", "cooler_l"])
        self.assertNotIn("direct_producer", tiers)

    def test_solve_island_right_sizes_the_layout_it_returns(self):
        """End to end: the biggest cooler in the roster is not the one that lands."""
        roster = [
            direct_producer(100, 0.2, id="dp"),
            cooler(20, id="cooler_s"),
            cooler(10000, id="cooler_l"),
        ]
        island = island_from(["GG"], roster)

        placements, power = solve_island(island, roster, 0.2)

        self.assertClose(power, 80.0)
        self.assertEqual(
            sorted(p.building_id for p in placements), ["cooler_s", "dp"],
            "a 10000 cooler for 20 of waste is capacity the player never uses",
        )


class TargetCompositionTests(SimulationTestCase):
    """
    `_target_compositions` answers "what should be built" exactly, by counting
    rather than searching. It ignores placement, so it is an upper bound on any
    arrangement -- but a tight and very cheap one.
    """

    def test_derives_the_hand_calculable_three_tile_answer(self):
        roster = [reactor(100), generator(100), cooler(25)]
        reactors, generators, coolers, _ = sorted_pools(roster)

        targets = _target_compositions(3, reactors, generators, coolers)

        self.assertTrue(targets)
        ceiling, composition = targets[0]
        self.assertEqual(
            dict(Counter(b.id for b in composition)),
            {"reactor": 1, "generator": 1, "cooler": 1},
        )
        self.assertClose(ceiling, 75.0, "100 heat converted at 0.75")

    def test_spends_extra_tiles_on_whichever_resource_is_binding(self):
        """
        With cooling scarce relative to reactor output, tiles have to go to
        coolers -- extra reactors beyond what the coolers can carry add nothing.
        """
        roster = [reactor(100), generator(100), cooler(5)]
        reactors, generators, coolers, _ = sorted_pools(roster)

        ceiling, composition = _target_compositions(10, reactors, generators, coolers)[0]
        counts = Counter(b.id for b in composition)

        self.assertEqual(sum(counts.values()), 10, "every tile is allocated")
        self.assertGreater(counts["cooler"], counts["reactor"], "cooling is the scarce resource")
        # Power is bounded by what the coolers can carry, whatever the reactors make.
        self.assertLessEqual(
            ceiling,
            (counts["cooler"] * 5 / GENERATOR_WASTE_RATIO) * GENERATOR_ENERGY_RATIO + 1e-9,
        )

    def test_surplus_reactor_heat_is_allowed_when_capacity_is_the_limit(self):
        """
        Regression: overshooting the heat budget is free, because the surplus is
        simply never absorbed and power stays capped.

        These are the real values from map 0's 7-tile island. Stepping down
        tiers to stay under the budget gives 4 doomStar + 1 flux = 7.92e21 of
        heat and 5.94e21 of power; packing all five tiles with doomStar makes
        9.20e21, of which only the generator's 8.85e21 is absorbed -- for
        6.64e21 of power. The ceiling has to cover the layout the solver can
        actually build, or it is not a ceiling.
        """
        roster = [
            reactor(1.84e21, id="doomStar_reactor"),
            reactor(5.63e20, id="flux_reactor"),
            generator(8.85e21, id="generator7"),
            cooler(2.35e21, id="cooler7"),
        ]
        reactors, generators, coolers, _ = sorted_pools(roster)

        ceiling, _ = _target_compositions(7, reactors, generators, coolers)[0]

        self.assertGreaterEqual(
            ceiling, 6.637e21 - 1e15,
            "ceiling must not fall below an achievable 5-reactor layout",
        )

    def test_every_returned_composition_can_cool_itself(self):
        roster = [reactor(100), reactor(12, id="small_reactor"), generator(100), cooler(25)]
        reactors, generators, coolers, _ = sorted_pools(roster)

        for tile_count in (3, 5, 8, 13, 21):
            for ceiling, composition in _target_compositions(
                tile_count, reactors, generators, coolers
            ):
                with self.subTest(tiles=tile_count):
                    counts = Counter(b.id for b in composition)
                    self.assertEqual(len(composition), tile_count)
                    heat = sum(b.effective_value for b in composition if b.type == "reactor")
                    gen_cap = sum(b.effective_value for b in composition if b.type == "generator")
                    cooling = sum(b.effective_value for b in composition if b.type == "cooler")
                    # Surplus reactor heat is allowed: it is simply never
                    # absorbed. What must hold is that the cooling covers the
                    # waste of the heat that IS absorbed.
                    absorbed = min(heat, gen_cap, cooling / GENERATOR_WASTE_RATIO)
                    self.assertGreaterEqual(
                        cooling, absorbed * GENERATOR_WASTE_RATIO - 1e-9,
                        f"{dict(counts)} cannot cool the heat it absorbs",
                    )
                    self.assertClose(ceiling, absorbed * GENERATOR_ENERGY_RATIO, rel=1e-9)

    def test_results_are_ordered_best_first(self):
        roster = [reactor(100), generator(100), cooler(25)]
        reactors, generators, coolers, _ = sorted_pools(roster)

        ceilings = [c for c, _ in _target_compositions(12, reactors, generators, coolers)]

        self.assertEqual(ceilings, sorted(ceilings, reverse=True))

    def test_no_composition_for_an_island_too_small_to_work(self):
        roster = [reactor(100), generator(100), cooler(25)]
        reactors, generators, coolers, _ = sorted_pools(roster)

        self.assertEqual(_target_compositions(2, reactors, generators, coolers), [])
        self.assertEqual(_target_compositions(3, [], generators, coolers), [])

    def test_the_ceiling_is_never_beaten_by_a_real_layout(self):
        """
        The composition ceiling ignores adjacency, so a real solve must always
        land at or below it. If this ever fails, the bound is wrong.
        """
        island = island_from(["GGGGG", "GGGGG", "GGGGG"])
        roster = basic_roster()
        reactors, generators, coolers, _ = sorted_pools(roster)
        tiles = _buildable_tiles(island.grid)

        ceiling = _target_compositions(len(tiles), reactors, generators, coolers)[0][0]
        _, power = solve_island(island, roster, 0.5)

        self.assertLessEqual(
            power, ceiling * (1 + 1e-9),
            f"solve returned {power:.4e}, above the {ceiling:.4e} composition ceiling",
        )


class HillClimbReplayTests(SimulationTestCase):
    """
    With a fixed rng and a step budget, the annealing walk must be fully
    deterministic. This is the property that lets a seeded Python run be
    replayed against the JS port and diffed bit for bit; wall-clock budgets
    cannot give it, because the deadline cuts each run at a different step.
    """

    def test_same_seed_and_step_budget_replays_identically(self):
        island = island_from(["GGGG", "GGGG", "GGGG"])
        roster = basic_roster()
        reactors, generators, coolers, direct_producers = sorted_pools(roster)
        buildable = _buildable_tiles(island.grid)
        neighbor_map = build_neighbor_map(buildable)
        seed_layout = _construct_multi_start_seed(
            buildable, reactors, generators, coolers, direct_producers,
            time.time() + 5.0, neighbor_map,
        )

        def run():
            # The 30s budget exists only so the deadline can never fire before
            # the step budget does; the walk stops at 20k steps regardless.
            return _hill_climb(
                seed_layout, buildable, reactors, generators, coolers,
                direct_producers, 30.0, neighbor_map, Rng(1234), max_steps=20_000,
            )

        first, second = run(), run()

        self.assertEqual(
            sorted((pos, b.id) for pos, b in first.items()),
            sorted((pos, b.id) for pos, b in second.items()),
            "two walks with the same seed and step budget diverged",
        )

    def test_different_seeds_are_allowed_to_diverge(self):
        """
        Not a strict requirement -- two seeds MAY collide on the same layout --
        but on a barely-constrained island the walk should visit seed-dependent
        states, so identical results for many distinct seeds would mean the
        rng is being ignored.
        """
        island = island_from(["GGGG", "GGGG", "GGGG"])
        roster = basic_roster()
        reactors, generators, coolers, direct_producers = sorted_pools(roster)
        buildable = _buildable_tiles(island.grid)
        neighbor_map = build_neighbor_map(buildable)

        results = set()
        for seed in range(6):
            result = _hill_climb(
                {}, buildable, reactors, generators, coolers,
                direct_producers, 30.0, neighbor_map, Rng(seed), max_steps=300,
            )
            results.add(tuple(sorted((pos, b.id) for pos, b in result.items())))

        self.assertGreater(
            len(results), 1,
            "six different seeds all produced the same layout; the walk "
            "does not appear to consume the rng it was given",
        )
