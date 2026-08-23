"""
Tests for the Distribution System (FairShare + Augmenting Repair).

The worked examples below are taken straight from docs/game-logic.md
and are the highest-value tests in the suite: distribution is the one place
where a plausible-looking "simplification" (handing leftovers on sequentially
instead of re-splitting them, or skipping the repair loop) silently changes
every solve.

Positions matter. The spec's processing order is ascending X, then descending Y,
so the coordinates in each test are chosen to pin down that order.
"""

import itertools
import random
from typing import Dict, Tuple

from solver.distribution import Node, run_distribution
from solver.rules import build_neighbor_map, is_adjacent
from tests.helpers import SimulationTestCase

THIRD_OF_100 = 100.0 / 3.0


def reference_max_flow(
    supplier_caps: Dict[Tuple[int, int], float],
    consumer_caps: Dict[Tuple[int, int], float],
) -> float:
    """
    Independent maximum-flow oracle: a textbook Edmonds-Karp over an explicit
    capacity matrix, deliberately sharing no structure with the implementation
    under test. Used to check that Augmenting Repair really does run to
    completion rather than stopping at the first improvement.

    Node layout: 0 = source, 1..S = suppliers, S+1..S+C = consumers, last = sink.
    """
    suppliers = list(supplier_caps)
    consumers = list(consumer_caps)
    n_sup, n_con = len(suppliers), len(consumers)
    sink = n_sup + n_con + 1
    size = sink + 1
    infinity = float("inf")

    residual = [[0.0] * size for _ in range(size)]
    for i, s in enumerate(suppliers):
        residual[0][1 + i] = supplier_caps[s]
        for j, c in enumerate(consumers):
            if is_adjacent(s, c):
                residual[1 + i][1 + n_sup + j] = infinity
    for j, c in enumerate(consumers):
        residual[1 + n_sup + j][sink] = consumer_caps[c]

    total = 0.0
    while True:
        # BFS for a shortest augmenting path in the residual graph.
        parent = [-1] * size
        parent[0] = 0
        queue = [0]
        while queue and parent[sink] == -1:
            node = queue.pop(0)
            for nxt in range(size):
                if parent[nxt] == -1 and residual[node][nxt] > 1e-9:
                    parent[nxt] = node
                    queue.append(nxt)

        if parent[sink] == -1:
            return total

        bottleneck = infinity
        node = sink
        while node != 0:
            bottleneck = min(bottleneck, residual[parent[node]][node])
            node = parent[node]

        node = sink
        while node != 0:
            residual[parent[node]][node] -= bottleneck
            residual[node][parent[node]] += bottleneck
            node = parent[node]

        total += bottleneck


class FairShareTests(SimulationTestCase):
    """Phase 1: equal split, with leftovers re-split evenly on later rounds."""

    def test_equal_split_among_eligible_consumers(self):
        suppliers = [Node(id=(1, 0), capacity=100.0)]
        consumers = [Node(id=(0, 0), capacity=100.0), Node(id=(2, 0), capacity=100.0)]

        sent, received = run_distribution(suppliers, consumers)

        self.assertAllocation(received, {(0, 0): 50.0, (2, 0): 50.0})
        self.assertAllocation(sent, {(1, 0): 100.0})

    def test_single_supplier_leftover_lands_via_augmenting_repair(self):
        """
        One reactor (100 heat) adjacent to three generators of capacity 10, 100
        and 100 produces 10 / 57 / 33.

        Read the reason carefully. With a SINGLE supplier, FairShare gets only
        one round, so its 23.33 leftover is never re-split -- Augmenting Repair
        places it, and Augmenting Repair *is* sequential. The same 10 / 57 / 33
        therefore comes out whether FairShare re-splits evenly or hands leftovers
        on one at a time, so this case says nothing about which rule FairShare
        uses. It once carried a name and a comment claiming it proved the
        sequential reading; it does not, and the wrong rule shipped for a long
        time behind exactly that false confidence.

        See InGameMeasurementTests for the multi-supplier layouts that actually
        discriminate.
        """
        supplier = Node(id=(1, 1), capacity=100.0)
        # Spatial order (ascending X, then descending Y): (0,1) -> (0,0) -> (1,0)
        small = Node(id=(0, 1), capacity=10.0)
        first_large = Node(id=(0, 0), capacity=100.0)
        second_large = Node(id=(1, 0), capacity=100.0)

        sent, received = run_distribution([supplier], [small, first_large, second_large])

        self.assertAllocation(
            received,
            {
                (0, 1): 10.0,                       # capped at its capacity
                (0, 0): THIRD_OF_100 + 70.0 / 3.0,  # 33.33 share + 23.33 from repair
                (1, 0): THIRD_OF_100,
            },
        )
        self.assertClose(sent[(1, 1)], 100.0)

    def test_supplier_surplus_with_no_eligible_consumer_goes_unused(self):
        """Spec: "Unreclaimed Surplus Stays Unused" -- not forced onto a full consumer."""
        suppliers = [Node(id=(1, 0), capacity=100.0)]
        consumers = [Node(id=(0, 0), capacity=10.0)]

        sent, received = run_distribution(suppliers, consumers)

        self.assertClose(received[(0, 0)], 10.0)
        self.assertClose(sent[(1, 0)], 10.0, "supplier must not report sending more than was absorbed")

    def test_non_adjacent_pairs_never_interact(self):
        suppliers = [Node(id=(0, 0), capacity=100.0)]
        consumers = [Node(id=(5, 5), capacity=100.0)]

        sent, received = run_distribution(suppliers, consumers)

        self.assertClose(sent[(0, 0)], 0.0)
        self.assertClose(received[(5, 5)], 0.0)

    def test_diagonal_neighbours_interact(self):
        suppliers = [Node(id=(0, 0), capacity=40.0)]
        consumers = [Node(id=(1, 1), capacity=100.0)]

        _, received = run_distribution(suppliers, consumers)

        self.assertClose(received[(1, 1)], 40.0)

    def test_earlier_supplier_consumes_capacity_before_later_ones(self):
        """Suppliers are sequential: the first one to run sees full capacity."""
        early = Node(id=(0, 0), capacity=60.0)
        late = Node(id=(2, 0), capacity=60.0)
        shared = Node(id=(1, 0), capacity=100.0)

        sent, received = run_distribution([late, early], [shared])

        self.assertClose(received[(1, 0)], 100.0)
        self.assertClose(sent[(0, 0)], 60.0, "supplier at x=0 is processed first and fills 60")
        self.assertClose(sent[(2, 0)], 40.0, "later supplier only gets the remaining 40")


class AugmentingRepairTests(SimulationTestCase):
    """Phase 2: reclaim allocations ACROSS suppliers to raise total delivery."""

    def test_example_1_constrained_supplier_takes_priority(self):
        """
        Spec Example 1. Supplier A reaches both consumers, supplier B only
        reaches consumer B. FairShare splits A 50/50; repair must then move A's
        allocation off consumer B (which B can fill on its own) onto consumer A,
        ending at 100%/100%.
        """
        consumer_a = Node(id=(0, 0), capacity=100.0)
        supplier_a = Node(id=(1, 0), capacity=100.0)
        consumer_b = Node(id=(2, 0), capacity=100.0)
        supplier_b = Node(id=(3, 0), capacity=100.0)

        sent, received = run_distribution(
            [supplier_a, supplier_b], [consumer_a, consumer_b]
        )

        self.assertAllocation(received, {(0, 0): 100.0, (2, 0): 100.0})
        self.assertClose(sent[(1, 0)], 100.0)
        self.assertClose(sent[(3, 0)], 100.0)

    def test_example_1_partial_repair_does_not_force_a_rebalance(self):
        """
        Spec Example 1, second half: if supplier B can only raise consumer B
        from 50% to 80%, the result stays 50/80 -- the 20% gap does not justify
        pulling resource away from consumer A.
        """
        consumer_a = Node(id=(0, 0), capacity=100.0)
        supplier_a = Node(id=(1, 0), capacity=100.0)
        consumer_b = Node(id=(2, 0), capacity=100.0)
        supplier_b = Node(id=(3, 0), capacity=30.0)

        _, received = run_distribution([supplier_a, supplier_b], [consumer_a, consumer_b])

        self.assertAllocation(received, {(0, 0): 50.0, (2, 0): 80.0})

    def test_example_2_returned_resource_follows_grid_order(self):
        """
        Spec Example 2. A shared supplier FairShares 33/33/33; an independent
        supplier then fills consumer 1, and the reclaimed 33.33 goes WHOLE to
        the next consumer in spatial order -- 100 / 66 / 33, not 100 / 50 / 50.
        """
        shared = Node(id=(1, 1), capacity=100.0)
        independent = Node(id=(3, 1), capacity=100.0)
        consumer_1 = Node(id=(2, 1), capacity=100.0)  # the only one `independent` reaches
        consumer_2 = Node(id=(0, 1), capacity=100.0)  # first in spatial order
        consumer_3 = Node(id=(0, 0), capacity=100.0)

        sent, received = run_distribution(
            [shared, independent], [consumer_1, consumer_2, consumer_3]
        )

        self.assertAllocation(
            received,
            {
                (2, 1): 100.0,               # consumer 1: filled outright
                (0, 1): 2 * THIRD_OF_100,    # consumer 2: 33.33 + the whole 33.33 returned
                (0, 0): THIRD_OF_100,        # consumer 3: untouched
            },
        )
        self.assertClose(sent[(1, 1)], 100.0)

        # An even re-split of the returned resource would give 50/50 here.
        self.assertNotAlmostEqual(received[(0, 1)], 50.0, places=6)

    def test_processing_order_changes_the_result(self):
        """
        Spec: "Processing order changes the final result". Same capacities and
        the same adjacency shape as the test above, but with the independent
        supplier earlier in spatial order, giving 100 / 50 / 50 instead.
        """
        independent = Node(id=(0, 1), capacity=100.0)
        consumer_1 = Node(id=(1, 1), capacity=100.0)
        shared = Node(id=(2, 1), capacity=100.0)
        consumer_2 = Node(id=(3, 1), capacity=100.0)
        consumer_3 = Node(id=(3, 0), capacity=100.0)

        _, received = run_distribution(
            [independent, shared], [consumer_1, consumer_2, consumer_3]
        )

        self.assertAllocation(
            received, {(1, 1): 100.0, (3, 1): 50.0, (3, 0): 50.0}
        )

    def test_repair_repeats_until_no_further_gain(self):
        """
        A chain where one reclaim frees capacity that enables a second, distinct
        reclaim. A single repair pass would stop short of full delivery.
        """
        # Consumers at even x, suppliers at odd x, each supplier adjacent to the
        # consumers on either side of it; the last supplier is a dead end.
        consumers = [Node(id=(2 * i, 0), capacity=100.0) for i in range(4)]
        suppliers = [Node(id=(2 * i + 1, 0), capacity=100.0) for i in range(4)]

        sent, received = run_distribution(suppliers, consumers)

        total_delivered = sum(received.values())
        self.assertClose(total_delivered, 400.0, "every consumer should end up full")
        for consumer in consumers:
            self.assertClose(received[consumer.id], 100.0, msg=f"consumer {consumer.id}")


class DistributionInvariantTests(SimulationTestCase):
    """Properties that must hold for every input, per the spec's invariants."""

    def _random_case(self, rng: random.Random):
        positions = [(x, y) for x in range(4) for y in range(3)]
        rng.shuffle(positions)
        n_sup = rng.randint(1, 5)
        n_con = rng.randint(1, 5)
        suppliers = [
            Node(id=pos, capacity=float(rng.randint(1, 100)))
            for pos in positions[:n_sup]
        ]
        consumers = [
            Node(id=pos, capacity=float(rng.randint(1, 100)))
            for pos in positions[n_sup:n_sup + n_con]
        ]
        return suppliers, consumers

    def test_invariants_hold_over_many_random_layouts(self):
        rng = random.Random(20240817)
        for case in range(300):
            suppliers, consumers = self._random_case(rng)
            sent, received = run_distribution(suppliers, consumers)

            with self.subTest(case=case):
                for s in suppliers:
                    self.assertGreaterEqual(sent[s.id], -1e-9)
                    self.assertLessEqual(
                        sent[s.id], s.capacity + 1e-9,
                        f"supplier {s.id} sent more than its capacity",
                    )
                for c in consumers:
                    self.assertGreaterEqual(received[c.id], -1e-9)
                    self.assertLessEqual(
                        received[c.id], c.capacity + 1e-9,
                        f"consumer {c.id} received more than its capacity",
                    )
                self.assertClose(
                    sum(sent.values()), sum(received.values()),
                    "conservation: everything sent must be received", rel=1e-6,
                )

    def test_reaches_maximum_possible_delivery(self):
        """
        Augmenting Repair claims to repeat "until no further reclaim would
        increase total valid delivery" -- i.e. the result is a maximum flow.
        Checked against an independent Ford-Fulkerson implementation.
        """
        rng = random.Random(11235)
        for case in range(120):
            suppliers, consumers = self._random_case(rng)
            _, received = run_distribution(suppliers, consumers)

            expected = reference_max_flow(
                {s.id: s.capacity for s in suppliers},
                {c.id: c.capacity for c in consumers},
            )
            with self.subTest(case=case):
                self.assertClose(
                    sum(received.values()), expected,
                    "total delivery should equal the max flow", rel=1e-6,
                )

    def test_neighbor_map_fast_path_matches_the_slow_path(self):
        """
        build_neighbor_map is a pure optimization: precomputing adjacency must
        never change the outcome versus deriving it with is_adjacent.
        """
        rng = random.Random(777)
        for case in range(200):
            suppliers, consumers = self._random_case(rng)
            all_tiles = [n.id for n in itertools.chain(suppliers, consumers)]
            neighbor_map = build_neighbor_map(all_tiles)

            slow = run_distribution(suppliers, consumers, None)
            fast = run_distribution(suppliers, consumers, neighbor_map)

            with self.subTest(case=case):
                self.assertAllocation(fast[0], slow[0], rel=1e-9)
                self.assertAllocation(fast[1], slow[1], rel=1e-9)

    def test_empty_inputs(self):
        sent, received = run_distribution([], [Node(id=(0, 0), capacity=5.0)])
        self.assertEqual(sent, {})
        self.assertAllocation(received, {(0, 0): 0.0})

        sent, received = run_distribution([Node(id=(0, 0), capacity=5.0)], [])
        self.assertAllocation(sent, {(0, 0): 0.0})
        self.assertEqual(received, {})


class ComponentDecompositionTests(SimulationTestCase):
    """
    Augmenting Repair runs per connected component of the supplier<->consumer
    graph. That is a pure speed optimization -- suppliers in different
    components cannot reach each other's consumers -- but it is only safe if
    each component's suppliers keep their original ascending order.

    The BFS expands suppliers in that order, and when several augmenting paths
    are equally short the first one reached wins. Grouping into components in
    discovery order instead silently produced a DIFFERENT maximal flow: same
    total delivered, but split across suppliers differently. The split is what
    decides which buildings clear their cooling threshold, so it matters.
    """

    def test_disconnected_groups_do_not_influence_each_other(self):
        """Two islands of supply, far apart, must each resolve on their own."""
        near = run_distribution(
            [Node(id=(1, 0), capacity=100.0)], [Node(id=(0, 0), capacity=60.0)]
        )
        together = run_distribution(
            [Node(id=(1, 0), capacity=100.0), Node(id=(9, 9), capacity=50.0)],
            [Node(id=(0, 0), capacity=60.0), Node(id=(8, 9), capacity=40.0)],
        )

        self.assertClose(together[0][(1, 0)], near[0][(1, 0)])
        self.assertClose(together[1][(0, 0)], near[1][(0, 0)])
        self.assertClose(together[0][(9, 9)], 40.0)
        self.assertClose(together[1][(8, 9)], 40.0)

    def test_many_components_still_reach_maximum_delivery(self):
        suppliers, consumers = [], []
        for group in range(6):
            x = group * 4  # far enough apart to never be adjacent
            suppliers.append(Node(id=(x + 1, 0), capacity=100.0))
            consumers.append(Node(id=(x, 0), capacity=70.0))

        sent, received = run_distribution(suppliers, consumers)

        self.assertClose(sum(received.values()), 6 * 70.0)
        for consumer in consumers:
            self.assertClose(received[consumer.id], 70.0)

    def test_component_order_decides_the_split_not_just_the_total(self):
        """
        A case that actually distinguishes the two orderings.

        Both give the same total delivery (362), because both are maximum
        flows. They differ in WHICH suppliers provide it: grouping components
        in discovery order (DFS append, no sort) enqueues (4,1) before (3,0)
        and the BFS then meets a different equally-short augmenting path first,
        sending ~19.67 from (4,1) and ~65.33 from (3,0). Sorted-by-index --
        which is FlowNetwork.Augment's local supplier order -- sends 85 from
        (3,0) and 0 from (4,1). The per-supplier split is what decides which
        buildings clear their cooling threshold, so the values below are the
        ones that must hold.
        """
        suppliers = [
            Node(id=(3, 3), capacity=185.0),
            Node(id=(2, 2), capacity=92.0),
            Node(id=(3, 0), capacity=123.0),
            Node(id=(4, 1), capacity=96.0),
        ]
        consumers = [
            Node(id=(0, 0), capacity=104.0),
            Node(id=(0, 2), capacity=56.0),
            Node(id=(2, 3), capacity=200.0),
            Node(id=(1, 0), capacity=166.0),
            Node(id=(3, 2), capacity=66.0),
            Node(id=(3, 1), capacity=96.0),
        ]

        sent, received = run_distribution(suppliers, consumers)

        self.assertAllocation(
            sent,
            {(3, 3): 185.0, (2, 2): 92.0, (3, 0): 85.0, (4, 1): 0.0},
            rel=1e-6,
        )
        self.assertAllocation(
            received,
            {
                (0, 0): 0.0, (0, 2): 0.0, (1, 0): 0.0,
                (2, 3): 200.0, (3, 2): 66.0, (3, 1): 96.0,
            },
            rel=1e-6,
        )

    def test_split_matches_an_undecomposed_reference_on_random_layouts(self):
        """
        The property the ordering bug broke: not just the total, but the exact
        per-supplier and per-consumer split, must be independent of how the
        components happen to be discovered.
        """
        rng = random.Random(31337)
        for case in range(400):
            positions = [(x, y) for x in range(5) for y in range(4)]
            rng.shuffle(positions)
            n_sup = rng.randint(1, 8)
            suppliers = [
                Node(id=p, capacity=float(rng.randint(1, 200)))
                for p in positions[:n_sup]
            ]
            consumers = [
                Node(id=p, capacity=float(rng.randint(1, 200)))
                for p in positions[n_sup:n_sup + rng.randint(1, 8)]
            ]
            neighbor_map = build_neighbor_map([n.id for n in suppliers + consumers])

            sent, received = run_distribution(suppliers, consumers, neighbor_map)
            expected = reference_max_flow(
                {s.id: s.capacity for s in suppliers},
                {c.id: c.capacity for c in consumers},
            )

            with self.subTest(case=case):
                # Reversing the input order must not change the outcome: the
                # implementation sorts spatially, and components must preserve
                # that order rather than substituting discovery order.
                reversed_sent, reversed_received = run_distribution(
                    list(reversed(suppliers)), list(reversed(consumers)), neighbor_map
                )
                self.assertAllocation(reversed_sent, sent)
                self.assertAllocation(reversed_received, received)
                self.assertClose(sum(received.values()), expected, rel=1e-6)


class InGameMeasurementTests(SimulationTestCase):
    """
    Layouts built in the live game, with per-building power read off the screen.

    These are observations, not derivations from the spec -- the spec was wrong
    about leftover handling until these runs corrected it. Each layout was
    designed so that two candidate rules predict visibly different numbers, and
    the totals act as a control (they match under both, so a mismatched total
    means the board was built wrong rather than the rule being wrong).
    """

    G2, G1, HELIO = 1.31e6, 2560.0, 250000.0

    def test_two_contested_suppliers_re_split_the_leftover_evenly(self):
        """
        Two Heliothermal Plants, both adjacent to two Generator 2s and one
        Generator 1. Measured: both Generator 2s ran at 186k power.

        A sequential handoff predicts 217k / 156k. The even re-split predicts
        186,540 for both, which is what the game shows.
        """
        suppliers = [Node(id=(0, 1), capacity=self.HELIO), Node(id=(2, 1), capacity=self.HELIO)]
        consumers = [
            Node(id=(1, 2), capacity=self.G2),
            Node(id=(1, 1), capacity=self.G2),
            Node(id=(1, 0), capacity=self.G1),
        ]

        _, received = run_distribution(suppliers, consumers)

        self.assertClose(received[(1, 2)] * 0.75, 186540.0, rel=1e-9)
        self.assertClose(received[(1, 1)] * 0.75, 186540.0, rel=1e-9)
        self.assertClose(received[(1, 0)] * 0.75, 1920.0, rel=1e-9)

    def test_round_loop_sits_outside_the_supplier_loop(self):
        """
        Two Divine Reactors: the first adjacent to only two of the four
        generators, the second to all four. Measured: no two Generator 5s ran at
        the same power.

        Running each supplier to exhaustion before starting the next ("rounds
        inside") predicts 6.45e15 for two of them. Running every supplier once
        per round ("rounds outside") predicts 8.6e15 and 4.3e15. The game shows
        them unequal.
        """
        divine, g5 = 1.72e16, 1.69e16
        suppliers = [Node(id=(0, 0), capacity=divine), Node(id=(1, 1), capacity=divine)]
        consumers = [
            Node(id=(0, 1), capacity=g5),
            Node(id=(1, 2), capacity=g5),
            Node(id=(1, 0), capacity=self.G2),
            Node(id=(2, 1), capacity=g5),
        ]

        _, received = run_distribution(suppliers, consumers)

        self.assertClose(received[(0, 1)] * 0.75, 1.2675e16, rel=1e-9)
        self.assertClose(received[(1, 2)] * 0.75, 8.6e15, rel=1e-9)
        self.assertClose(received[(2, 1)] * 0.75, 4.3e15, rel=1e-9)
        self.assertNotAlmostEqual(received[(1, 2)], received[(2, 1)], places=6)

    def test_rounds_are_scoped_to_the_connected_component(self):
        """
        A reactor that shares no consumer with this cluster must not lengthen
        its redistribution.

        The round budget is per connected component, not per island and not per
        board. Measured in-game: the isolated cluster keeps its single round
        even with other reactors on the same island and elsewhere on the map.
        """
        cluster_suppliers = [Node(id=(0, 1), capacity=self.HELIO)]
        cluster_consumers = [
            Node(id=(1, 2), capacity=self.G2),
            Node(id=(1, 1), capacity=self.G2),
            Node(id=(1, 0), capacity=self.G1),
        ]

        _, alone = run_distribution(cluster_suppliers, cluster_consumers)

        # Same cluster, plus an unreachable reactor/generator pair.
        _, together = run_distribution(
            cluster_suppliers + [Node(id=(5, 1), capacity=self.HELIO)],
            cluster_consumers + [Node(id=(6, 1), capacity=self.G2)],
        )

        self.assertClose(together[(1, 2)] * 0.75, 123080.0, rel=1e-9)
        self.assertClose(together[(1, 1)] * 0.75, 62500.0, rel=1e-9)
        for pos in [(1, 2), (1, 1), (1, 0)]:
            self.assertClose(together[pos], alone[pos], rel=1e-12)
