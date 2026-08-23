"""
Known-best-layout regression tests.

Unlike the rest of the suite, these pin the solver to a specific, verified
OPTIMAL answer on small islands, so that any change in solver behaviour shows
up as a failure here rather than as a quietly worse number on a big map.

A ladder of island sizes, each with its verified optimum:

    tiles  shape       layout                                       power
    -----  ----------  -------------------------------------------  --------
      3    row         eye + gen6 + cooler6                         6.60e18
      4    2x2         2 eye + gen6 + cooler6                       1.32e19
      5    3x3 - 4     neuro + gen6 + 3 cooler6                     5.19e19
      6    2x3         neuro + 2 gen6 + 3 cooler6                   5.28e19
      7    3x3 - 2     neuro + psionic + 2 gen6 + 3 cooler6         5.36e19
      8    3x3 - 1     neuro + eye + 2 gen6 + 4 cooler6             5.94e19
      9    3x3         neuro + 2 eye + 2 gen6 + 4 cooler6           6.60e19

Every one was confirmed by exhaustive brute force, not by running the solver and
writing down what it said. The candidate set is deliberately lean -- the top
generator, the top cooler, the top three reactors, and "leave empty" -- because
generators and coolers jump 400x-4100x per tier, so no lower tier of either can
ever appear in an optimal layout (see docs/game-logic.md, "Building Tiers
Matter A Lot"). Reactors are kept three tiers deep
because their 8x steps ARE small enough to matter: the 7-tile optimum spends its
last tile on a psionic_tower purely to soak up leftover cooling capacity. The
3- and 4-tile boards were small enough to brute force against the entire
34-building roster, and agree.

A layout only counts as a valid answer if it is STABLE: every generator and
direct producer placed must actually run. Layouts that score higher by parking
heat in a permanently overheating building are rejected -- see
ThreeByThreeIslandTests.

Each size is checked twice: once against the SIMULATOR, pinning the exact layout
and score deterministically, and once against the SEARCH, which must reproduce
that answer. The one exception is the full 3x3, where the search reliably finds
the right composition but only lands the best arrangement of it about half the
time, so power there is asserted as a floor. Tightening that into an equality is
a fair goal for a future search improvement.

If one of these fails, behaviour changed. Whether that's a regression or an
improvement is for you to decide -- but the power values must never go DOWN,
because they are proven optima.
"""

from collections import Counter
from typing import Dict, List

from data.buildings import BUILDINGS, UNLOCKED_UPGRADES
from data.effective_buildings import get_effective_buildings
from solver.types import EffectiveBuilding
from solver.island import split_grid_into_islands
from solver.constants import GENERATOR_ENERGY_RATIO, GENERATOR_WASTE_RATIO
from solver.rules import build_neighbor_map
from solver.placement_search import (
    _buildable_tiles,
    _hill_climb,
    _offline_producers,
    _prune_dead_weight,
    solve_island,
)
from solver.simulate import simulate_island
from tests.helpers import SimulationTestCase, make_grid, placements_by_pos

# The scenario: everything unlocked EXCEPT these four.
EXCLUDED_BUILDINGS = frozenset({
    "generator7", "cooler7", "flux_reactor", "doomStar_reactor",
})

# Number of attempts allowed before a golden test is called a failure. The
# search is stochastic; a single unlucky anneal should not fail the build, but
# a solver that has genuinely regressed will miss on every attempt. In practice
# the first attempt succeeds (measured: 12/12 at less than half this budget),
# so the extra attempts only cost time when something is actually wrong.
ATTEMPTS = 3
TIME_BUDGET_S = 0.4

# ASCII shorthand used by every pinned layout below.
LEGEND = {
    "C": "cooler6",
    "G": "generator6",
    "N": "neuro_grid_reactor",
    "E": "sauron_eye",
    "P": "psionic_tower",
}


def _sorted_pools(roster: List[EffectiveBuilding]):
    """The four building pools, ordered exactly as solve_island orders them."""
    return (
        sorted(
            (b for b in roster if b.type == "reactor"),
            key=lambda b: -b.effective_value,
        ),
        sorted((b for b in roster if b.type == "generator"), key=lambda b: -b.effective_value),
        sorted((b for b in roster if b.type == "cooler"), key=lambda b: -b.effective_value),
        sorted(
            (b for b in roster if b.type == "direct_producer"),
            key=lambda b: -b.energy,
        ),
    )


def restricted_roster() -> List[EffectiveBuilding]:
    unlocks = {
        building_id: level
        for building_id, level in UNLOCKED_UPGRADES.items()
        if building_id not in EXCLUDED_BUILDINGS
    }
    return get_effective_buildings(BUILDINGS, unlocks)


class GoldenLayoutTestCase(SimulationTestCase):
    def setUp(self):
        self.roster = restricted_roster()
        self.by_id = {b.id: b for b in self.roster}

    def solve_to_optimum(self, island, optimum: float):
        """
        Runs the search until it reaches the known optimum, up to ATTEMPTS
        times, so an unlucky anneal doesn't fail the build. Returns the best
        result seen; a genuinely regressed solver misses on every attempt.
        """
        best_placements, best_power = [], -1.0
        for _ in range(ATTEMPTS):
            placements, power = solve_island(island, self.roster, TIME_BUDGET_S)
            if power > best_power:
                best_placements, best_power = placements, power
            if best_power >= optimum - abs(optimum) * 1e-9:
                break
        return best_placements, best_power

    def assertComposition(self, placements, expected: Dict[str, int]):
        actual = dict(Counter(p.building_id for p in placements))
        self.assertEqual(
            actual, expected,
            f"\n  expected layout: {expected}\n  solver produced: {actual}",
        )

    def island_from(self, rows):
        islands = split_grid_into_islands(make_grid(rows), self.roster)
        self.assertEqual(len(islands), 1, "test grid should be a single island")
        return islands[0]

    def layout_from(self, rows: List[str], legend: Dict[str, str] = None):
        """Builds a placement dict from an ASCII picture and a char -> id legend."""
        legend = LEGEND if legend is None else legend
        return {
            (x, y): self.by_id[legend[char]]
            for y, row in enumerate(rows)
            for x, char in enumerate(row)
            if char != "."
        }

    def converted_reactor_output(self, *reactor_ids: str) -> float:
        """
        Power for a layout whose generators absorb their reactors' full output.

        Every known-best layout in this file has that shape: the generators
        between them can accept everything the reactors make, so the score is
        simply the reactors' combined output times the 0.75 conversion.
        """
        total = sum(self.by_id[r].effective_value for r in reactor_ids)
        return total * GENERATOR_ENERGY_RATIO

    def assert_layout_scores(self, rows, composition: Dict[str, int], expected_power: float):
        """
        Deterministic half of a golden check: the named layout has the expected
        composition, scores the expected power, and is stable.
        """
        layout = self.layout_from(rows)
        power, placements = simulate_island(layout)

        self.assertEqual(
            dict(Counter(b.id for b in layout.values())), composition,
            "the pinned layout does not have the expected composition",
        )
        self.assertClose(power, expected_power)
        self.assertEqual(
            _offline_producers(layout, placements), [],
            "the known-best layout must not contain an overheating building",
        )
        return layout

    def assert_solver_finds(self, island_rows, composition: Dict[str, int], expected_power: float):
        """Search half of a golden check: the solver reproduces that answer."""
        island = self.island_from(island_rows)

        placements, power = self.solve_to_optimum(island, expected_power)

        self.assertComposition(placements, composition)
        self.assertClose(power, expected_power)
        return placements


class RosterPreconditionTests(GoldenLayoutTestCase):
    """
    Guards the assumptions the golden layouts rest on. If one of THESE fails,
    the building catalogue changed -- the solver is not at fault, and the
    expected layouts below need recomputing.
    """

    def test_the_four_excluded_buildings_are_absent(self):
        """
        Written so it holds whether or not UNLOCKED_UPGRADES currently unlocks
        these four -- the scenario is "everything the player has, minus these",
        not "the default roster is exactly four bigger".
        """
        available = {b.id for b in self.roster}
        default = {b.id for b in get_effective_buildings()}

        self.assertEqual(available & EXCLUDED_BUILDINGS, set())
        self.assertEqual(available, default - EXCLUDED_BUILDINGS)

    def test_the_top_tier_of_each_type_is_what_the_layouts_assume(self):
        best = {}
        for kind, predicate in (
            ("generator", lambda b: b.type == "generator"),
            ("cooler", lambda b: b.type == "cooler"),
            ("reactor", lambda b: b.type == "reactor"),
        ):
            best[kind] = max(filter(predicate, self.roster), key=lambda b: b.effective_value)

        self.assertEqual(best["generator"].id, "generator6")
        self.assertEqual(best["cooler"].id, "cooler6")
        self.assertEqual(best["reactor"].id, "neuro_grid_reactor")

    def test_the_arithmetic_that_makes_these_layouts_optimal(self):
        reactor = self.by_id["neuro_grid_reactor"].effective_value   # 7.04e19
        gen = self.by_id["generator6"].effective_value               # 6.92e19
        cool = self.by_id["cooler6"].effective_value                 # 6.03e18

        # One generator cannot absorb the whole reactor -- hence two generators
        # beat one as soon as a sixth tile is available.
        self.assertGreater(reactor, gen, "a single generator would cap the reactor")
        self.assertGreater(2 * gen, reactor, "two generators can take all of it")

        # Three coolers cover the waste in both layouts; two never do.
        self.assertGreaterEqual(3 * cool, reactor * GENERATOR_WASTE_RATIO)
        self.assertLess(2 * cool, gen * GENERATOR_WASTE_RATIO)


class SixTileIslandTests(GoldenLayoutTestCase):
    """
    A full 2x3 block:

        G G G
        G G G

    Known best: 2x generator6 + 1x neuro_grid_reactor + 3x cooler6.

    The reactor produces 7.04e19, more than one generator6 can accept
    (6.92e19), so two generators split it and NOTHING is wasted:
    power = 7.04e19 * 0.75 = 5.28e19. The resulting 1.76e19 of waste is just
    under the three coolers' 1.809e19.

    Note this layout is NOT found by greedy seed construction, which builds a
    single-generator hub worth 5.19e19 and leaves a tile idle -- reaching
    5.28e19 depends on the annealing stage. That makes this the most sensitive
    test in the suite to search-quality changes.
    """

    ROWS = ["GGG", "GGG"]
    EXPECTED = {"generator6": 2, "neuro_grid_reactor": 1, "cooler6": 3}

    def optimum(self) -> float:
        # Both generators together absorb the reactor's full output.
        return self.by_id["neuro_grid_reactor"].effective_value * GENERATOR_ENERGY_RATIO

    def test_finds_the_known_best_layout(self):
        island = self.island_from(self.ROWS)
        optimum = self.optimum()

        placements, power = self.solve_to_optimum(island, optimum)

        self.assertComposition(placements, self.EXPECTED)
        self.assertEqual(len(placements), 6, "every tile should be used")
        self.assertGreaterEqual(
            power, optimum - abs(optimum) * 1e-9,
            "brute force proves 5.28e19 is achievable on this island",
        )
        self.assertClose(power, optimum, "the whole reactor output should be converted")


class FiveTileIslandTests(GoldenLayoutTestCase):
    """
    The same block with one corner removed:

        G G G
        G G .

    Known best: 1x generator6 + 1x neuro_grid_reactor + 3x cooler6.

    With only five tiles there is no room for a second generator alongside the
    three coolers the waste requires, so the single generator caps the reactor
    at its own 6.92e19 capacity: power = 6.92e19 * 0.75 = 5.19e19. The 1.73e19
    of waste again needs all three coolers.
    """

    ROWS = ["GGG", "GG."]
    EXPECTED = {"generator6": 1, "neuro_grid_reactor": 1, "cooler6": 3}

    def optimum(self) -> float:
        # The lone generator's capacity is the binding constraint.
        return self.by_id["generator6"].effective_value * GENERATOR_ENERGY_RATIO

    def test_finds_the_known_best_layout(self):
        island = self.island_from(self.ROWS)
        optimum = self.optimum()

        placements, power = self.solve_to_optimum(island, optimum)

        self.assertComposition(placements, self.EXPECTED)
        self.assertEqual(len(placements), 5, "every tile should be used")
        self.assertGreaterEqual(
            power, optimum - abs(optimum) * 1e-9,
            "brute force proves 5.19e19 is achievable on this island",
        )
        self.assertClose(power, optimum, "the generator caps the reactor here")

    def test_sixth_tile_buys_the_second_generator(self):
        """
        Ties the two golden cases together: the 6-tile island must beat the
        5-tile one, and by exactly the reactor output that the lone generator
        was forced to waste.
        """
        five_optimum = self.optimum()
        six_optimum = SixTileIslandTests.optimum(self)

        _, five_power = self.solve_to_optimum(self.island_from(self.ROWS), five_optimum)
        _, six_power = self.solve_to_optimum(
            self.island_from(SixTileIslandTests.ROWS), six_optimum
        )

        self.assertGreater(six_power, five_power)
        self.assertClose(
            six_power - five_power,
            (
                self.by_id["neuro_grid_reactor"].effective_value
                - self.by_id["generator6"].effective_value
            ) * GENERATOR_ENERGY_RATIO,
            "the gain is exactly the reactor output the single generator wasted",
        )


class ThreeByThreeIslandTests(GoldenLayoutTestCase):
    """
    A compact 3x3 block (9 tiles).

        G G G
        G G G
        G G G

    Known best STABLE layout: 2x sauron_eye + 1x neuro_grid_reactor +
    2x generator6 + 4x cooler6 = 6.60e19, e.g.

        C N E
        G G E
        C C C

    The three reactors supply 7.04e19 + 2 x 8.8e18 = 8.80e19, which two
    generator6 (capacity 1.384e20 between them) absorb in full:
    8.80e19 * 0.75 = 6.60e19. The 2.20e19 of waste fits inside the four
    coolers' 2.41e19.

    A higher-scoring arrangement exists -- 2 reactors + 3 generators + 4
    coolers scores 7.04e19 -- but it is NOT a valid answer: it only works by
    parking heat in a third generator that never comes online, i.e. a
    permanently overheating building. See
    test_the_higher_scoring_layout_is_rejected_for_overheating.

    Both figures come from exhaustive search over
    {empty, generator6, cooler6, neuro_grid_reactor, sauron_eye}^9
    (1,953,125 layouts), with the stable optimum additionally checked against
    every 1- and 2-tile substitution from the full 34-building roster.
    """

    ROWS = ["GGG", "GGG", "GGG"]

    STABLE_ROWS = ["CNE", "GGE", "CCC"]
    STABLE_POWER = 6.60e19
    STABLE_COMPOSITION = {
        "sauron_eye": 2, "neuro_grid_reactor": 1, "generator6": 2, "cooler6": 4,
    }

    # Scores higher but leaves a generator permanently overheating.
    UNSTABLE_ROWS = ["CCC", "GNG", "GNC"]
    UNSTABLE_POWER = 7.04e19

    def test_the_known_best_stable_layout_scores_6_6e19(self):
        """Deterministic: pins the layout and its score, independent of search."""
        layout = self.layout_from(self.STABLE_ROWS)

        power, placements = simulate_island(layout)

        self.assertEqual(
            dict(Counter(b.id for b in layout.values())), self.STABLE_COMPOSITION
        )
        self.assertClose(power, self.STABLE_POWER)
        self.assertEqual(len(layout), 9, "every tile is used")
        self.assertEqual(
            _offline_producers(layout, placements), [],
            "every generator in the known-best layout must run",
        )

    def test_both_generators_run_on_the_reactors_full_output(self):
        """The whole point of the layout: nothing overheats and nothing is wasted."""
        layout = self.layout_from(self.STABLE_ROWS)
        reactor_output = (
            self.by_id["neuro_grid_reactor"].effective_value
            + 2 * self.by_id["sauron_eye"].effective_value
        )

        power, placements = simulate_island(layout)
        generators = [p for p in placements if p.building_id == "generator6"]

        self.assertEqual(len(generators), 2)
        self.assertClose(
            sum(g.heat_consumed for g in generators), reactor_output,
            "the two generators should absorb every bit of reactor output",
        )
        self.assertClose(power, reactor_output * GENERATOR_ENERGY_RATIO)
        for gen in generators:
            self.assertGreaterEqual(
                gen.cooling_received, gen.waste_heat_generated - 1e3,
                "each generator must be fully cooled",
            )

    def test_the_higher_scoring_layout_is_rejected_for_overheating(self):
        """
        The 2-reactor / 3-generator layout scores 7.04e19, beating the stable
        optimum by 6.7%, but only because a third generator absorbs heat it can
        never cool. Pruning must dismantle it even though that costs power --
        an overheating building is not an acceptable answer.
        """
        layout = self.layout_from(self.UNSTABLE_ROWS)
        neighbor_map = build_neighbor_map(list(layout))

        raw_power, placements = simulate_island(layout, neighbor_map)
        offline = _offline_producers(layout, placements)

        self.assertClose(raw_power, self.UNSTABLE_POWER)
        self.assertGreater(raw_power, self.STABLE_POWER, "precondition: it scores higher")
        self.assertEqual(len(offline), 1, "exactly one generator is permanently offline")

        pruned, pruned_power = _prune_dead_weight(dict(layout), neighbor_map)

        self.assertLess(
            pruned_power, self.STABLE_POWER,
            "stabilizing this layout collapses it, which is why the search must "
            "not settle for it in the first place",
        )
        for p in pruned:
            self.assertNotEqual(
                (p.x, p.y), offline[0], "the overheating generator survived pruning"
            )

    def test_the_search_never_settles_on_an_overheating_layout(self):
        """
        Handed the unstable 7.04e19 layout as its starting point, the search
        must not simply keep it: 7.04e19 is the highest score anything on this
        island can reach, so a search that ranks candidates on raw power alone
        can never improve on it and will return an overheating grid.

        Starting from that layout makes the failure deterministic, which a
        normal solve does not -- the search only stumbles onto this peak
        occasionally.
        """
        island = self.island_from(self.ROWS)
        buildable = _buildable_tiles(island.grid)
        neighbor_map = build_neighbor_map(buildable)
        unstable_seed = self.layout_from(self.UNSTABLE_ROWS)

        reactors, generators, coolers, direct_producers = _sorted_pools(self.roster)
        result = _hill_climb(
            unstable_seed, buildable, reactors, generators, coolers,
            direct_producers, 0.3, neighbor_map,
        )

        _, placements = simulate_island(result, neighbor_map)
        self.assertEqual(
            _offline_producers(result, placements), [],
            "the search returned a layout containing an overheating building",
        )

    def test_asymmetric_eye_sharing_overheats_a_generator(self):
        """
        Why eye placement matters so much. Here one eye feeds both generators
        and the other feeds only one, so the heat lands unevenly: the
        generator that gets 6.92e19 needs 1.73e19 of cooling but can only
        reach 1.51e19, and the all-or-nothing rule takes it offline. The other
        generator, starved to 1.76e19 of heat, cannot reach its cooling either.
        Both shut down and the island produces nothing.
        """
        lopsided = self.layout_from(["CEG", "NEC", "CGC"])

        power, placements = simulate_island(lopsided)
        by_pos = placements_by_pos(placements)

        starved, flooded = by_pos[(2, 0)], by_pos[(1, 2)]
        self.assertGreater(
            flooded.heat_consumed, starved.heat_consumed * 3,
            "precondition: this arrangement should distribute heat unevenly",
        )
        self.assertLess(
            flooded.cooling_received, flooded.waste_heat_generated,
            "the flooded generator cannot reach enough cooling",
        )
        self.assertClose(power, 0.0, "all-or-nothing means both generators shut down")

    def test_the_solver_builds_the_known_best_composition(self):
        """
        The composition is the reliable signal here: every run returns
        2 eyes + 1 neuro + 2 generators + 4 coolers. The exact arrangement
        varies -- roughly half the runs find the 6.60e19 optimum and the rest
        land on a 6.51e19 variant -- so power is asserted as a floor.
        Tightening this to equality is a fair goal for a search improvement.
        """
        island = self.island_from(self.ROWS)
        floor = 6.5e19

        placements, power = self.solve_to_optimum(island, self.STABLE_POWER)

        self.assertComposition(placements, self.STABLE_COMPOSITION)
        self.assertEqual(len(placements), 9, "every tile should be used")
        self.assertGreater(power, floor, f"solver returned only {power:.4e}")
        self.assertLessEqual(
            power, self.STABLE_POWER * (1 + 1e-9),
            "solver beat the stable optimum -- it may be leaving something overheating",
        )


class ThreeTileRowTests(GoldenLayoutTestCase):
    """
    Three tiles in a row -- the smallest island that can produce anything.

        G G G      ->    C G E

    Known best: sauron_eye + generator6 + cooler6 = 6.60e18.

    Only one cooler fits, and that is what picks the reactor. The best reactor,
    neuro_grid_reactor, would push 6.92e19 into the generator and make 1.73e19
    of waste -- nearly three coolers' worth -- so it can never run here. The
    8x-weaker sauron_eye makes only 2.20e18 of waste, which one cooler6
    (6.03e18) covers easily. A weaker reactor wins outright because cooling,
    not heat, is the binding constraint.
    """

    ROWS = ["GGG"]
    LAYOUT = ["CGE"]
    COMPOSITION = {"sauron_eye": 1, "generator6": 1, "cooler6": 1}

    def optimum(self) -> float:
        return self.converted_reactor_output("sauron_eye")

    def test_the_known_best_layout(self):
        self.assert_layout_scores(self.LAYOUT, self.COMPOSITION, self.optimum())

    def test_the_solver_finds_it(self):
        self.assert_solver_finds(self.ROWS, self.COMPOSITION, self.optimum())

    def test_the_top_reactor_cannot_be_cooled_here(self):
        """The reason a weaker reactor wins: one cooler cannot cover the big one."""
        cooler = self.by_id["cooler6"].effective_value
        neuro_waste = self.by_id["neuro_grid_reactor"].effective_value * GENERATOR_WASTE_RATIO
        eye_waste = self.by_id["sauron_eye"].effective_value * GENERATOR_WASTE_RATIO

        self.assertGreater(neuro_waste, cooler, "the top reactor needs more than one cooler")
        self.assertLessEqual(eye_waste, cooler, "the weaker reactor fits in one")

        power, placements = simulate_island(self.layout_from(["CGN"]))
        self.assertClose(power, 0.0, "swapping in the top reactor kills the layout")
        self.assertEqual(len(_offline_producers(self.layout_from(["CGN"]), placements)), 1)


class FourTileSquareTests(GoldenLayoutTestCase):
    """
    A 2x2 block, where every tile touches every other.

        G G      ->    C E
        G G            G E

    Known best: 2x sauron_eye + generator6 + cooler6 = 1.32e19.

    The fourth tile goes to a second eye rather than a second cooler: two eyes
    make 1.76e19 of heat and only 4.40e18 of waste, still inside one cooler6's
    6.03e18. The generator has capacity to spare (6.92e19), so the extra
    reactor is pure profit -- it exactly doubles the three-tile answer.
    """

    ROWS = ["GG", "GG"]
    LAYOUT = ["CE", "GE"]
    COMPOSITION = {"sauron_eye": 2, "generator6": 1, "cooler6": 1}

    def optimum(self) -> float:
        return self.converted_reactor_output("sauron_eye", "sauron_eye")

    def test_the_known_best_layout(self):
        self.assert_layout_scores(self.LAYOUT, self.COMPOSITION, self.optimum())

    def test_the_solver_finds_it(self):
        self.assert_solver_finds(self.ROWS, self.COMPOSITION, self.optimum())

    def test_a_second_reactor_beats_a_second_cooler(self):
        """One cooler still covers the waste, so the spare tile should make heat."""
        two_eyes = simulate_island(self.layout_from(self.LAYOUT))[0]
        eye_and_cooler = simulate_island(self.layout_from(["CE", "GC"]))[0]

        self.assertGreater(two_eyes, eye_and_cooler)
        self.assertClose(
            two_eyes, 2 * eye_and_cooler,
            "the second eye should exactly double the single-eye output",
        )


class SevenTileIslandTests(GoldenLayoutTestCase):
    """
    A 3x3 block with two tiles missing.

        G G G      ->    C N P
        G G G            G G C
        G . .            C . .

    Known best: psionic_tower + neuro_grid_reactor + 2x generator6 +
    3x cooler6 = 5.3625e19.

    This is the spec's "topping up a Generator's spare heat-input capacity"
    case, and the only golden layout that uses a third-tier reactor. The two
    generators can accept 1.384e20 between them but neuro only supplies
    7.04e19, so heat -- not generator capacity -- is the limit. Three coolers
    absorb 1.809e19 of waste, and neuro alone only makes 1.76e19, leaving
    5.0e17 of cooling headroom. psionic_tower (1.10e18, another 8x step down)
    fits into that gap almost exactly: total heat 7.15e19, total waste
    1.7875e19, just inside the coolers' 1.809e19.
    """

    ROWS = ["GGG", "GGG", "G.."]
    LAYOUT = ["CNP", "GGC", "C.."]
    COMPOSITION = {
        "neuro_grid_reactor": 1, "psionic_tower": 1, "generator6": 2, "cooler6": 3,
    }

    def optimum(self) -> float:
        return self.converted_reactor_output("neuro_grid_reactor", "psionic_tower")

    def test_the_known_best_layout(self):
        self.assert_layout_scores(self.LAYOUT, self.COMPOSITION, self.optimum())

    def test_the_solver_finds_it(self):
        self.assert_solver_finds(self.ROWS, self.COMPOSITION, self.optimum())

    def test_the_small_reactor_uses_up_the_spare_cooling(self):
        """
        Without the top-up the coolers sit partly idle; with it they are almost
        exactly saturated. Adding it must not tip the layout into overheating.
        """
        cooling = 3 * self.by_id["cooler6"].effective_value
        neuro_waste = self.by_id["neuro_grid_reactor"].effective_value * GENERATOR_WASTE_RATIO
        topped_up_waste = (
            self.by_id["neuro_grid_reactor"].effective_value
            + self.by_id["psionic_tower"].effective_value
        ) * GENERATOR_WASTE_RATIO

        self.assertLess(neuro_waste, cooling, "the big reactor alone leaves headroom")
        self.assertLessEqual(topped_up_waste, cooling, "the top-up must still fit")

        without_top_up = simulate_island(self.layout_from(["CNC", "GGC", "C.."]))[0]
        self.assertGreater(
            simulate_island(self.layout_from(self.LAYOUT))[0], without_top_up,
            "spending the spare tile on a small reactor should beat a fourth cooler",
        )


class EightTileIslandTests(GoldenLayoutTestCase):
    """
    A 3x3 block with one corner missing.

        G G G      ->    C G E
        G G G            C N C
        G G .            G C .

    Known best: sauron_eye + neuro_grid_reactor + 2x generator6 +
    4x cooler6 = 5.94e19.

    The eighth tile buys a fourth cooler, which lifts the cooling ceiling from
    1.809e19 to 2.412e19. That is enough headroom for a full sauron_eye
    (8.80e18) rather than the psionic top-up the 7-tile island could afford:
    total heat 7.92e19, waste 1.98e19, comfortably inside 2.412e19.

    A third reactor would fit the cooling budget too (waste 2.0075e19) but not
    the island -- 3 reactors + 2 generators + 4 coolers needs nine tiles, which
    is the full 3x3 case.
    """

    ROWS = ["GGG", "GGG", "GG."]
    LAYOUT = ["CGE", "CNC", "GC."]
    COMPOSITION = {
        "neuro_grid_reactor": 1, "sauron_eye": 1, "generator6": 2, "cooler6": 4,
    }

    def optimum(self) -> float:
        return self.converted_reactor_output("neuro_grid_reactor", "sauron_eye")

    def test_the_known_best_layout(self):
        self.assert_layout_scores(self.LAYOUT, self.COMPOSITION, self.optimum())

    def test_the_solver_finds_it(self):
        self.assert_solver_finds(self.ROWS, self.COMPOSITION, self.optimum())

    def test_the_fourth_cooler_is_what_pays_for_the_bigger_reactor(self):
        """
        Against the 7-tile island: one more cooler upgrades the top-up reactor
        from psionic_tower to the 8x larger sauron_eye.
        """
        seven_tile_cooling = 3 * self.by_id["cooler6"].effective_value
        eight_tile_cooling = 4 * self.by_id["cooler6"].effective_value
        waste = (
            self.by_id["neuro_grid_reactor"].effective_value
            + self.by_id["sauron_eye"].effective_value
        ) * GENERATOR_WASTE_RATIO

        self.assertGreater(waste, seven_tile_cooling, "three coolers could not carry this")
        self.assertLessEqual(waste, eight_tile_cooling, "four coolers can")
        self.assertGreater(self.optimum(), SevenTileIslandTests.optimum(self))
