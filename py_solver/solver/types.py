"""
Dataclasses shared by the grid decoder, the solver and the renderer.

Every module imports these types from here, so there is exactly one import path
per class and the dependency direction between packages stays unambiguous:
`solver.types` depends on nothing, and everything else depends on it.

Peer: `lib/solver/types.ts`.

## The building model

`BuildingDefinition` is a tagged union with one variant per role, because the
four roles genuinely carry different numbers and a single flat record could
only express that with nullable fields. It had them: `waste_ratio` was `None`
for every building except the wind turbine, and telling a reactor from a direct
producer meant writing `type == "heat_producer" and waste_ratio is None` at a
dozen call sites. `type` now names the role directly, so that test is
`type == "reactor"`.

Note this splits the game's own category `heat_producer` into `reactor` and
`direct_producer`. The game's own data still uses the
three-way category; the split happens where `data/buildings.py` is authored,
keyed on whether the building has an energy output of its own.

Per-level numbers live in one record per level rather than in parallel lists.
The game ships 5-11 levels depending on the building, and a level is the unit
everything actually indexes by, so making it the unit of storage means a level
either has all of its numbers or does not exist.

All values are **per second**. The game's own tables mix `HeatPerSec` and
`HeatPerTick` field names, but a tick is a second, so no conversion applies.
"""

from dataclasses import dataclass, field
from typing import List, Literal, Optional, Union

BuildingType = Literal["cooler", "reactor", "generator", "direct_producer"]


@dataclass
class Tile:
    x: int
    y: int
    type: str


# ---------------------------------------------------------------------------
# Upgrade levels
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoolerLevel:
    """Cooling a cooler can absorb from its neighbours, per second."""

    cooling: float

    @property
    def value(self) -> float:
        """The number this level is sized by -- see `UpgradeLevel.value`."""
        return self.cooling


@dataclass(frozen=True)
class ReactorLevel:
    """Heat a reactor pushes out to adjacent generators, per second."""

    heat: float

    @property
    def value(self) -> float:
        """The number this level is sized by -- see `UpgradeLevel.value`."""
        return self.heat


@dataclass(frozen=True)
class GeneratorLevel:
    """
    A generator converts the heat it receives into power.

    The game authors all three figures per tier (`HeatPerTick`,
    `EnergyPerTick`, `WasteHeatPerTick`) rather than deriving them from a
    ratio, which is why `energy / heat` is only *near* 0.75 up the tiers: the
    fields are rounded to 3 significant figures independently of each other.

    `waste` is `None` only for a source that does not author one -- the
    extractor's rounded JSON does not -- in which case it resolves to
    `snap_to_authored_precision(heat - energy)`, which is how the game computes
    it in the first place.
    """

    heat: float
    energy: float
    waste: Optional[float] = None

    @property
    def value(self) -> float:
        """The number this level is sized by -- see `UpgradeLevel.value`."""
        return self.heat


@dataclass(frozen=True)
class DirectProducerLevel:
    """
    A direct producer runs flat out on its own: no reactor, no heat intake.

    `heat` is the heat it makes per second doing so, `energy` the power, and
    `waste` what has to be cooled -- the same three authored figures a
    generator carries, and resolved the same way when `waste` is absent.
    """

    heat: float
    energy: float
    waste: Optional[float] = None

    @property
    def value(self) -> float:
        """The number this level is sized by -- see `UpgradeLevel.value`."""
        return self.heat


UpgradeLevel = Union[CoolerLevel, ReactorLevel, GeneratorLevel, DirectProducerLevel]
"""
One upgrade tier's numbers. Every variant exposes `.value` -- the number the
tier is sized by, and the only one a caller that does not know the role can
ask for: cooling for a cooler, heat for everything else. Code that does know
the role should use the specific name, which says what the number means.
"""


# ---------------------------------------------------------------------------
# Building definitions
# ---------------------------------------------------------------------------


@dataclass
class BuildingBase:
    """Identity and shop data, shared by every role."""

    id: str
    name: str
    price: float
    display_index: int


@dataclass
class CoolerDefinition(BuildingBase):
    levels: List[CoolerLevel]
    type: BuildingType = field(init=False, default="cooler")


@dataclass
class ReactorDefinition(BuildingBase):
    levels: List[ReactorLevel]
    type: BuildingType = field(init=False, default="reactor")


@dataclass
class GeneratorDefinition(BuildingBase):
    levels: List[GeneratorLevel]
    type: BuildingType = field(init=False, default="generator")


@dataclass
class DirectProducerDefinition(BuildingBase):
    levels: List[DirectProducerLevel]
    type: BuildingType = field(init=False, default="direct_producer")


BuildingDefinition = Union[
    CoolerDefinition, ReactorDefinition, GeneratorDefinition, DirectProducerDefinition
]


@dataclass
class EffectiveBuilding:
    """
    A building collapsed to the single upgrade tier the player has unlocked.

    The level is already chosen here, so the role-specific waste rule has
    already been applied and what is left is three plain numbers the solver can
    use without branching on anything but `type`:

    - `effective_value` -- cooling for a cooler, heat out for a reactor, heat
      intake capacity for a generator, heat produced for a direct producer.
    - `energy` -- power at that full value; 0 for coolers and reactors.
    - `waste` -- waste heat at that full value; 0 for coolers and reactors.

    A generator that only fills part way scales both by the same fraction; a
    direct producer always runs at full.
    """

    id: str
    type: BuildingType
    effective_value: float
    energy: float = 0.0
    waste: float = 0.0


@dataclass
class IslandSubGrid:
    """One 8-connected component of buildable tiles, solvable in isolation."""

    width: int
    height: int
    grid: List[List[Tile]]
    original_tile_indices: List[int]  # Flat indices mapping back to the full grid


@dataclass
class PlacedBuilding:
    x: int
    y: int
    building_id: str
    base_value: float = 0.0
    power_generated: float = 0.0
    heat_produced: float = 0.0
    heat_consumed: float = 0.0
    waste_heat_generated: float = 0.0
    cooling_provided: float = 0.0
    cooling_received: float = 0.0


@dataclass
class OptimizationSummary:
    total_heat_produced: float = 0.0
    total_heat_consumed: float = 0.0
    total_waste_generated: float = 0.0
    total_cooling_capacity: float = 0.0


@dataclass
class OptimizationResult:
    total_power: float
    placements: List[PlacedBuilding]
    active_tiles_count: int
    unused_tiles_count: int
    summary: OptimizationSummary
    # Upper bound for the same grid + roster, used to report layout efficiency.
    theoretical_max_power: float = 0.0
