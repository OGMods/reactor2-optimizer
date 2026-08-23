"""
Resolves building definitions against the player's unlocked upgrade levels.

Peer: `lib/data/effectiveBuildings.ts`.
"""

from typing import Dict, List, Optional

from data.buildings import BUILDINGS, UNLOCKED_UPGRADES
from solver.physics import snap_to_authored_precision
from solver.types import (
    BuildingDefinition,
    DirectProducerDefinition,
    EffectiveBuilding,
    GeneratorDefinition,
)


def get_effective_buildings(
    buildings: Optional[List[BuildingDefinition]] = None,
    unlocked_upgrades: Optional[Dict[str, int]] = None,
) -> List[EffectiveBuilding]:
    """
    Resolves building definitions against unlocked upgrade levels.

    Buildings omitted from `unlocked_upgrades`, or with no upgrade tiers defined,
    are treated as locked and filtered out.

    Coolers and reactors neither produce power nor need cooling, so both of
    their figures are zero. Generators and direct producers carry the game's
    authored `EnergyPerTick` / `WasteHeatPerTick` for the resolved tier, and
    only fall back to `heat - energy` for a source that authors no waste at all.
    """
    if buildings is None:
        buildings = BUILDINGS
    if unlocked_upgrades is None:
        unlocked_upgrades = UNLOCKED_UPGRADES

    roster: List[EffectiveBuilding] = []

    for building in buildings:
        if building.id not in unlocked_upgrades or not building.levels:
            continue

        level_index = unlocked_upgrades[building.id]
        clamped_index = max(0, min(level_index, len(building.levels) - 1))
        level = building.levels[clamped_index]

        if isinstance(building, (GeneratorDefinition, DirectProducerDefinition)):
            value, energy = level.heat, level.energy
            waste = (
                level.waste
                if level.waste is not None
                else snap_to_authored_precision(level.heat - level.energy)
            )
        elif building.type == "reactor":
            value, energy, waste = level.heat, 0.0, 0.0
        else:
            value, energy, waste = level.cooling, 0.0, 0.0

        roster.append(
            EffectiveBuilding(
                id=building.id,
                type=building.type,
                effective_value=value,
                energy=energy,
                waste=waste,
            )
        )

    return roster
