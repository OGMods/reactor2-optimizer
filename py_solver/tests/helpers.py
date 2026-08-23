"""Shared fixtures: building factories, grid builders and float assertions."""

import unittest
from typing import Dict, List, Optional, Tuple

from solver.constants import GENERATOR_ENERGY_RATIO, GENERATOR_WASTE_RATIO
from solver.types import EffectiveBuilding, PlacedBuilding, Tile
from grid import TILE_CHAR_MAP

TileId = Tuple[int, int]


# --- Building factories --------------------------------------------------
# Ids default to something descriptive so failures name the building.

def reactor(value: float, id: str = "reactor") -> EffectiveBuilding:
    """A pure heat source: heat out, no power and nothing to cool."""
    return EffectiveBuilding(id=id, type="reactor", effective_value=value)


def generator(value: float, id: str = "generator") -> EffectiveBuilding:
    """Converts reactor heat to power; `value` is its max heat input H_max."""
    return EffectiveBuilding(
        id=id,
        type="generator",
        effective_value=value,
        energy=value * GENERATOR_ENERGY_RATIO,
        waste=value * GENERATOR_WASTE_RATIO,
    )


def cooler(value: float, id: str = "cooler") -> EffectiveBuilding:
    return EffectiveBuilding(id=id, type="cooler", effective_value=value)


def direct_producer(value: float, waste_ratio: float, id: str = "dp") -> EffectiveBuilding:
    """
    A self-contained producer: runs flat out, needs only cooling.

    Takes a ratio rather than the two numbers because that is how these
    fixtures read -- "a producer that wastes a fifth of what it makes".
    """
    return EffectiveBuilding(
        id=id,
        type="direct_producer",
        effective_value=value,
        energy=value * (1 - waste_ratio),
        waste=value * waste_ratio,
    )


def basic_roster(
    reactor_value: float = 100.0,
    generator_value: float = 100.0,
    cooler_value: float = 100.0,
    dp_value: Optional[float] = None,
    dp_waste_ratio: float = 0.2,
) -> List[EffectiveBuilding]:
    roster = [
        reactor(reactor_value),
        generator(generator_value),
        cooler(cooler_value),
    ]
    if dp_value is not None:
        roster.append(direct_producer(dp_value, dp_waste_ratio))
    return roster


# --- Grid builders -------------------------------------------------------

def make_grid(rows: List[str]) -> List[List[Tile]]:
    """
    Builds a tile grid from an ASCII picture, one string per row (y), using
    `grid.TILE_CHAR_MAP`: 'G' grass, '.' water, 'R' rock, 'T'/'U' trees,
    'O' pond, 'X' transformer.

        make_grid([
            "GGG",
            "G.G",
        ])
    """
    width = len(rows[0]) if rows else 0
    assert all(len(r) == width for r in rows), "make_grid rows must be equal length"
    return [
        [Tile(x=x, y=y, type=TILE_CHAR_MAP[char]) for x, char in enumerate(row)]
        for y, row in enumerate(rows)
    ]


def place(rows: List[str], legend: Dict[str, EffectiveBuilding]) -> Dict[TileId, EffectiveBuilding]:
    """
    Builds a placement dict from an ASCII picture, one string per row (y), with
    '.' or ' ' meaning "empty tile".

        place(["RGC"], {"R": reactor(100), "G": generator(100), "C": cooler(25)})

    puts a reactor at (0,0), a generator at (1,0) and a cooler at (2,0).
    """
    placement: Dict[TileId, EffectiveBuilding] = {}
    for y, row in enumerate(rows):
        for x, char in enumerate(row):
            if char in (".", " "):
                continue
            assert char in legend, f"{char!r} is missing from the legend"
            placement[(x, y)] = legend[char]
    return placement


def placements_by_pos(placements: List[PlacedBuilding]) -> Dict[TileId, PlacedBuilding]:
    return {(p.x, p.y): p for p in placements}


class SimulationTestCase(unittest.TestCase):
    """Adds float comparison helpers tuned to the solver's magnitudes."""

    def assertClose(self, actual: float, expected: float, msg: str = "", rel: float = 1e-9):
        """Relative-tolerance comparison; exact for zero."""
        if expected == 0:
            self.assertAlmostEqual(actual, 0.0, places=9, msg=msg)
            return
        tolerance = abs(expected) * rel
        self.assertLessEqual(
            abs(actual - expected),
            tolerance,
            msg=f"{msg} expected {expected!r}, got {actual!r} (tolerance {tolerance!r})",
        )

    def assertAllocation(
        self,
        actual: Dict[TileId, float],
        expected: Dict[TileId, float],
        rel: float = 1e-9,
    ):
        """Compares a distribution result tile-by-tile with a useful failure message."""
        self.assertEqual(
            sorted(actual), sorted(expected), "allocation covers different tiles"
        )
        for pos, want in expected.items():
            self.assertClose(actual[pos], want, msg=f"at tile {pos}:", rel=rel)
