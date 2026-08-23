"""
Generator conversion and the cooling threshold, matching Unity's authored stats.

Peer: `lib/solver/physics.ts`.

The game does not convert heat at a fixed ratio. Each generator tier authors
its own `HeatPerTick` / `EnergyPerTick` / `WasteHeatPerTick` in
`PowerSourceResearchLevelSO`, and late-game `Energy / Heat` is not exactly 0.75
because the three fields are authored to 3 significant figures independently.
`EffectiveBuilding` carries the resolved pair, so the functions here are thin --
what they buy is that the conversion and the online test are written once, in
the game's terms, instead of being spelled out at each of the nine call sites
that would otherwise multiply by a constant.
"""

from typing import Tuple

from solver.constants import EPS
from solver.types import EffectiveBuilding


def snap_to_authored_precision(value: float) -> float:
    """
    Match `NumbersTools.SnapToAuthoredPrecision`: double -> 15 s.f. -> double.

    The game's own `WasteHeatPerTick` is `SnapToAuthoredPrecision(Heat - Energy)`,
    which is why the catalogue's waste figures are round numbers (4.3e18) rather
    than what the subtraction actually lands on (4.2999999999999996e18).
    """
    if value != value:  # NaN
        return value
    abs_value = abs(value)
    if abs_value == float("inf") or abs_value > 7.9e28:
        return value
    if abs_value < 1e-28:
        return 0.0
    return float(format(value, ".15g"))


def waste_is_covered(waste: float, cooling: float) -> bool:
    """
    True when the cooling reaching a producer keeps it online.

    The game treats net waste <= max(HeatFlowTolerance.Floor, magnitude * 1e-9)
    as balanced. A fixed absolute epsilon decides nothing at late-game
    magnitudes -- one ULP at 1e18 is already ~1e2 -- so the relative term is
    what actually settles stability up there, and the floor is what settles it
    down at single digits.
    """
    magnitude = abs(waste) if abs(waste) >= abs(cooling) else abs(cooling)
    relative = magnitude * 1e-9
    tolerance = EPS if EPS >= relative else relative
    return waste - cooling <= tolerance


def generator_power_and_waste(
    building: EffectiveBuilding, h_in: float
) -> Tuple[float, float]:
    """
    Power and waste from a generator given its settled heat input.

    Mirrors `GeneratorBuilding.TickGeneratingEnergy`: the generator scales both
    of its authored figures by how full it is, rather than applying a ratio to
    the heat it received.
    """
    cap = building.effective_value
    if cap <= 0.0 or h_in <= 0.0:
        return 0.0, 0.0
    h_in = h_in if h_in < cap else cap
    scale = h_in / cap
    return scale * building.energy, scale * building.waste


def generator_energy_ratio(building: EffectiveBuilding) -> float:
    """Power per unit of heat this generator absorbs."""
    cap = building.effective_value
    if cap <= 0.0:
        return 0.0
    return building.energy / cap


def generator_waste_ratio(building: EffectiveBuilding) -> float:
    """Waste heat per unit of heat this generator absorbs."""
    cap = building.effective_value
    if cap <= 0.0:
        return 0.0
    return building.waste / cap
