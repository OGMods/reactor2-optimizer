"""
Implements the game's Distribution System (see docs/game-logic.md):
FairShare followed by Augmenting Repair, run identically for the heat
instance (Reactor -> Generator) and the cooling instance
(Cooler -> Generator/DirectProducer).

The per-supplier / per-consumer *split* is ported from Unity
`FlowNetwork.cs` (FairShare + Edmonds-Karp repair). Total max-flow is
unchanged; the split is what decides which generators clear cooling.

FairShare is simulated literally, in the documented spatial order
(ascending X, then descending Y), including its bounded round loop and the
even re-split of each supplier's leftover. Rounds are budgeted per connected
component of the supplier<->consumer graph -- Unity already solves each
FlowNetwork island separately, so `maxRounds = s` on an island is the same
budget.

Augmenting Repair is Unity's BFS: source enqueues every supplier with
remaining supply; suppliers enqueue every unvisited adjacent consumer
(forward residual unbounded, no jump-to-sink); a consumer with leftover
demand connects to the sink and ends that search, otherwise it walks
back-edges. Node space matches FlowNetwork: suppliers, then consumers,
then source, then sink.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from solver.constants import EPS, spatial_key
from solver.rules import TileId, is_adjacent


@dataclass
class Node:
    """One endpoint of a distribution graph: a tile with a capacity to give or absorb."""

    id: TileId
    capacity: float


def run_distribution(
    suppliers: List[Node],
    consumers: List[Node],
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Tuple[Dict[TileId, float], Dict[TileId, float]]:
    """Returns (supplier_id -> total sent, consumer_id -> total received)."""
    if not suppliers or not consumers:
        return {s.id: 0.0 for s in suppliers}, {c.id: 0.0 for c in consumers}

    sorted_suppliers = sorted(suppliers, key=lambda s: spatial_key(*s.id))
    sorted_consumers = sorted(consumers, key=lambda c: spatial_key(*c.id))

    num_suppliers = len(sorted_suppliers)
    num_consumers = len(sorted_consumers)

    consumer_id_to_idx = {c.id: j for j, c in enumerate(sorted_consumers)}

    # Flattened bipartite edges, matching FlowNetwork.BuildIsland:
    # suppliers in spatial order, each supplier's consumer neighbours in
    # ascending local consumer index.
    edge_supplier: List[int] = []
    edge_consumer: List[int] = []
    supplier_edges: List[List[int]] = [[] for _ in range(num_suppliers)]
    consumer_edges: List[List[int]] = [[] for _ in range(num_consumers)]

    for si, s in enumerate(sorted_suppliers):
        if neighbor_map is not None:
            locals_ci = [
                consumer_id_to_idx[n]
                for n in neighbor_map.get(s.id, ())
                if n in consumer_id_to_idx
            ]
            locals_ci.sort()
        else:
            locals_ci = [
                ci
                for ci, c in enumerate(sorted_consumers)
                if is_adjacent(s.id, c.id)
            ]
        for ci in locals_ci:
            edge = len(edge_supplier)
            edge_supplier.append(si)
            edge_consumer.append(ci)
            supplier_edges[si].append(edge)
            consumer_edges[ci].append(edge)

    cap = [s.capacity for s in sorted_suppliers]
    demand = [c.capacity for c in sorted_consumers]
    sup_remaining = list(cap)
    dem_remaining = list(demand)
    edge_flow = [0.0] * len(edge_supplier)

    # --- Phase 1: FairShare (FlowNetwork.FairShare inner loop) ---
    # Each round walks every supplier in spatial order and splits whatever that
    # supplier still holds EVENLY across its adjacent consumers that still have
    # demand. A leftover (created when an even share overshoots a consumer's
    # remaining capacity) is re-split evenly on the NEXT round -- never handed
    # whole to one neighbour. The round loop sits OUTSIDE the supplier loop, so
    # a supplier's round-N split sees what the others did in round N-1.
    #
    # A supplier gets as many rounds as there are suppliers in **its own
    # connected component** of the supplier<->consumer graph -- not on the
    # island, and not on the board. Buildings that cannot exchange anything do
    # not lengthen each other's redistribution. Measured in-game: an isolated
    # reactor keeps its single round even with other reactors elsewhere on the
    # same island, and the same layout on an island of its own behaves
    # identically. See docs/game-logic.md.
    components: Optional[List[List[int]]] = None

    def get_components() -> List[List[int]]:
        nonlocal components
        if components is None:
            components = _supplier_components(
                num_suppliers, supplier_edges, edge_consumer, consumer_edges, edge_supplier
            )
        return components

    def fairshare_round(bound: Optional[List[int]], round_idx: int) -> float:
        moved = 0.0
        for si in range(num_suppliers):
            if bound is not None and round_idx >= bound[si]:
                continue
            if sup_remaining[si] <= EPS:
                continue

            edges = supplier_edges[si]
            needy = 0
            for edge in edges:
                if dem_remaining[edge_consumer[edge]] > EPS:
                    needy += 1
            if needy == 0:
                continue

            share = sup_remaining[si] / needy
            for edge in edges:
                if sup_remaining[si] <= EPS:
                    break
                ci = edge_consumer[edge]
                if dem_remaining[ci] <= EPS:
                    continue
                give = share
                if dem_remaining[ci] < give:
                    give = dem_remaining[ci]
                if sup_remaining[si] < give:
                    give = sup_remaining[si]
                if give <= EPS:
                    continue
                edge_flow[edge] += give
                sup_remaining[si] -= give
                dem_remaining[ci] -= give
                moved += give
        return moved

    # Round 1 needs no component map: every supplier's component contains at
    # least itself, so every supplier is entitled to one round.
    fairshare_round(None, 0)

    # Later rounds need the per-supplier bound, which costs a graph walk. Skip
    # it unless some supplier could actually still move something -- the common
    # case settles in one round and never pays for the decomposition.
    if any(
        sup_remaining[si] > EPS
        and any(dem_remaining[edge_consumer[e]] > EPS for e in supplier_edges[si])
        for si in range(num_suppliers)
    ):
        supplier_round_budget = [0] * num_suppliers
        for members in get_components():
            n = len(members)
            for si in members:
                supplier_round_budget[si] = n
        for round_idx in range(1, max(supplier_round_budget, default=1)):
            if fairshare_round(supplier_round_budget, round_idx) <= EPS:
                # A round that moves nothing leaves the state untouched, so no
                # later round can move anything either.
                break

    # --- Phase 2: Augmenting Repair (FlowNetwork.Augment) ---
    # Node space matches Unity:
    #   [0 .. S-1]       suppliers
    #   [S .. S+C-1]     consumers
    #   S+C              source
    #   S+C+1            sink
    # Augmenting Repair can only raise total delivery, so it needs BOTH a
    # supplier with something left to give and a consumer with room to take it.
    # Whenever either side is exhausted -- which is common, since layouts tend
    # to be tight on one of the two -- the whole phase is a guaranteed no-op and
    # its BFS machinery can be skipped entirely.
    if not any(r > EPS for r in sup_remaining) or not any(r > EPS for r in dem_remaining):
        return (
            {s.id: cap[i] - sup_remaining[i] for i, s in enumerate(sorted_suppliers)},
            {c.id: demand[j] - dem_remaining[j] for j, c in enumerate(sorted_consumers)},
        )

    source = num_suppliers + num_consumers
    sink = source + 1
    total_nodes = sink + 1

    visited_token = [0] * total_nodes
    parent_node = [0] * total_nodes
    via_edge = [0] * total_nodes
    queue = [0] * total_nodes
    token = 0

    # Suppliers grouped into connected components of the supplier<->consumer
    # graph. An augmenting path can never leave its component, and augmenting
    # inside one component cannot change any other's residual state, so each
    # can be repaired independently -- identical result, but every BFS scans
    # one component instead of the whole island. On a solved map-1 layout the
    # heat graph splits in two and the cooling graph into five.
    #
    # Each component's members MUST stay in ascending index order. The BFS
    # expands suppliers in that order, and when several augmenting paths are
    # equally short the first one reached wins -- so discovery order here would
    # silently pick a different (equally maximal, but differently split) flow,
    # and the split is what decides which buildings clear their cooling.
    for source_suppliers in get_components():
        while True:
            if not any(sup_remaining[si] > EPS for si in source_suppliers):
                break

            token += 1
            visited_token[source] = token
            parent_node[source] = -1
            queue[0] = source
            q_head = 0
            q_tail = 1
            reached_sink = False

            while q_head < q_tail and not reached_sink:
                node = queue[q_head]
                q_head += 1

                if node == source:
                    for si in source_suppliers:
                        if visited_token[si] == token:
                            continue
                        if sup_remaining[si] > EPS:
                            visited_token[si] = token
                            parent_node[si] = source
                            via_edge[si] = -1
                            queue[q_tail] = si
                            q_tail += 1

                elif node < num_suppliers:
                    # Supplier -> every unvisited adjacent consumer. Forward
                    # residual is unbounded. Do not jump to the sink here:
                    # FlowNetwork enqueues the consumer and lets the consumer
                    # node connect to the sink, so later same-layer suppliers
                    # still expand. Jumping from the supplier marks later
                    # consumers unvisited and can pick a different equal-length
                    # path.
                    for edge in supplier_edges[node]:
                        con_node = num_suppliers + edge_consumer[edge]
                        if visited_token[con_node] == token:
                            continue
                        visited_token[con_node] = token
                        parent_node[con_node] = node
                        via_edge[con_node] = edge
                        queue[q_tail] = con_node
                        q_tail += 1

                elif node < source:
                    ci = node - num_suppliers
                    if visited_token[sink] != token and dem_remaining[ci] > EPS:
                        visited_token[sink] = token
                        parent_node[sink] = node
                        via_edge[sink] = -1
                        reached_sink = True
                        break

                    for edge in consumer_edges[ci]:
                        if edge_flow[edge] <= EPS:
                            continue
                        sup_node = edge_supplier[edge]
                        if visited_token[sup_node] == token:
                            continue
                        visited_token[sup_node] = token
                        parent_node[sup_node] = node
                        via_edge[sup_node] = edge
                        queue[q_tail] = sup_node
                        q_tail += 1

            if not reached_sink:
                break

            bottleneck = float("inf")
            node = sink
            while node != source:
                prev = parent_node[node]
                if node == sink:
                    residual = dem_remaining[prev - num_suppliers]
                elif prev == source:
                    residual = sup_remaining[node]
                elif node < num_suppliers:
                    residual = edge_flow[via_edge[node]]
                else:
                    residual = float("inf")
                if residual < bottleneck:
                    bottleneck = residual
                node = prev

            if bottleneck == float("inf") or bottleneck <= EPS:
                break

            node = sink
            while node != source:
                prev = parent_node[node]
                if node == sink:
                    dem_remaining[prev - num_suppliers] -= bottleneck
                elif prev == source:
                    sup_remaining[node] -= bottleneck
                elif node < num_suppliers:
                    edge_flow[via_edge[node]] -= bottleneck
                else:
                    edge_flow[via_edge[node]] += bottleneck
                node = prev

    return (
        {s.id: cap[i] - sup_remaining[i] for i, s in enumerate(sorted_suppliers)},
        {c.id: demand[j] - dem_remaining[j] for j, c in enumerate(sorted_consumers)},
    )


def _supplier_components(
    num_suppliers: int,
    supplier_edges: List[List[int]],
    edge_consumer: List[int],
    consumer_edges: List[List[int]],
    edge_supplier: List[int],
) -> List[List[int]]:
    """
    Connected components of the supplier<->consumer graph, each as a list of
    supplier indices in ascending order.

    That count is the supplier's FairShare round budget: two clusters that
    share no consumer cannot affect each other, so neither may lengthen the
    other's redistribution. Repair walks the same components, and must keep
    this ascending-index order -- discovery order silently picks a different
    equally-short augmenting path.
    """
    component_of = [-1] * num_suppliers
    components: List[List[int]] = []
    for start in range(num_suppliers):
        if component_of[start] != -1:
            continue
        members = [start]
        component_of[start] = len(components)
        seen_consumers = set()
        stack = [start]
        while stack:
            si = stack.pop()
            for edge in supplier_edges[si]:
                ci = edge_consumer[edge]
                if ci in seen_consumers:
                    continue
                seen_consumers.add(ci)
                for other_edge in consumer_edges[ci]:
                    other = edge_supplier[other_edge]
                    if component_of[other] == -1:
                        component_of[other] = len(components)
                        members.append(other)
                        stack.append(other)
        members.sort()
        components.append(members)
    return components
