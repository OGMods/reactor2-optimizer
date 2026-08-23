"""
Full placement evaluator with fast-path short-circuiting: given a fixed set of
buildings, runs the simulation described in docs/game-logic.md and
returns total online power plus one PlacedBuilding per occupied tile.
"""

from typing import Dict, List, Optional, Tuple

from solver.types import EffectiveBuilding, PlacedBuilding
from solver.distribution import Node, run_distribution
from solver.constants import EPS
from solver.physics import generator_power_and_waste, waste_is_covered
from solver.rules import TileId

def simulate_island(
    placement: Dict[TileId, EffectiveBuilding],
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Tuple[float, List[PlacedBuilding]]:
    reactors = {pos: b for pos, b in placement.items() if b.type == "reactor"}
    generators = {pos: b for pos, b in placement.items() if b.type == "generator"}
    direct_producers = {
        pos: b for pos, b in placement.items() if b.type == "direct_producer"
    }
    coolers = {pos: b for pos, b in placement.items() if b.type == "cooler"}

    # Fast-Path 1: No power-producing buildings placed
    if not generators and not direct_producers:
        placements = [
            PlacedBuilding(x=pos[0], y=pos[1], building_id=b.id, base_value=b.effective_value)
            for pos, b in placement.items()
        ]
        return 0.0, placements

    # Fast-Path 2: Zero coolers placed
    # Since all generators/DPs generate waste heat and require 100% cooling to stay online,
    # 0 coolers = 0 online power.
    if not coolers:
        placements = [
            PlacedBuilding(x=pos[0], y=pos[1], building_id=b.id, base_value=b.effective_value)
            for pos, b in placement.items()
        ]
        return 0.0, placements

    # 1-3. Heat distribution: Reactor -> Generator
    if reactors and generators:
        reactor_nodes = [Node(id=pos, capacity=b.effective_value) for pos, b in reactors.items()]
        generator_nodes = [Node(id=pos, capacity=b.effective_value) for pos, b in generators.items()]
        reactor_sent, generator_h_in = run_distribution(reactor_nodes, generator_nodes, neighbor_map)
    else:
        reactor_sent = {}
        generator_h_in = {}

    generator_power: Dict[TileId, float] = {}
    generator_waste: Dict[TileId, float] = {}
    for pos, b in generators.items():
        h_in = generator_h_in.get(pos, 0.0)
        generator_power[pos], generator_waste[pos] = generator_power_and_waste(b, h_in)

    # 4. Direct Producers
    dp_power: Dict[TileId, float] = {}
    dp_waste: Dict[TileId, float] = {}
    for pos, b in direct_producers.items():
        dp_power[pos] = b.energy
        dp_waste[pos] = b.waste

    # 5. Cooling distribution: Cooler -> Generator/DirectProducer
    waste_by_pos: Dict[TileId, float] = {**generator_waste, **dp_waste}
    waste_consumer_nodes = [Node(id=pos, capacity=w) for pos, w in waste_by_pos.items() if w > EPS]

    if waste_consumer_nodes and coolers:
        cooler_nodes = [Node(id=pos, capacity=b.effective_value) for pos, b in coolers.items()]
        cooler_sent, cooling_received = run_distribution(cooler_nodes, waste_consumer_nodes, neighbor_map)
    else:
        cooler_sent = {}
        cooling_received = {}

    total_power = 0.0
    placements: List[PlacedBuilding] = []

    for pos, b in reactors.items():
        x, y = pos
        placements.append(PlacedBuilding(
            x=x, y=y, building_id=b.id, base_value=b.effective_value,
            heat_produced=reactor_sent.get(pos, 0.0),
        ))

    for pos, b in generators.items():
        x, y = pos
        waste = generator_waste[pos]
        cooling = cooling_received.get(pos, 0.0)
        online = waste_is_covered(waste, cooling)
        power = generator_power[pos] if online else 0.0
        total_power += power
        placements.append(PlacedBuilding(
            x=x, y=y, building_id=b.id, base_value=b.effective_value,
            power_generated=power,
            heat_consumed=generator_h_in.get(pos, 0.0),
            waste_heat_generated=waste,
            cooling_received=cooling,
        ))

    for pos, b in direct_producers.items():
        x, y = pos
        waste = dp_waste[pos]
        cooling = cooling_received.get(pos, 0.0)
        online = waste_is_covered(waste, cooling)
        power = dp_power[pos] if online else 0.0
        total_power += power
        placements.append(PlacedBuilding(
            x=x, y=y, building_id=b.id, base_value=b.effective_value,
            power_generated=power,
            waste_heat_generated=waste,
            cooling_received=cooling,
        ))

    for pos, b in coolers.items():
        x, y = pos
        placements.append(PlacedBuilding(
            x=x, y=y, building_id=b.id, base_value=b.effective_value,
            cooling_provided=cooler_sent.get(pos, 0.0),
        ))

    return total_power, placements
