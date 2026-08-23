"""
Game-rule constants and the grid's fixed processing order.

These are the values the rules themselves fix -- not tuning knobs. Search
tuning lives next to the stage it tunes, in `placement_search.py`.

See `docs/game-logic.md` for the authoritative rules.
Peer: `lib/solver/constants.ts`.
"""

from typing import Tuple

# The conversion every generator in the game has used so far. It is NOT a rule
# of the game: each generator tier authors its own EnergyPerTick and
# WasteHeatPerTick, and `solver/physics.py` reads those. These two are the
# fallback for synthetic buildings that author neither -- test fixtures, mostly.
GENERATOR_ENERGY_RATIO = 0.75
GENERATOR_WASTE_RATIO = 0.25

# 8-directional Chebyshev neighbor relative offsets [dx, dy]
CHEBYSHEV_DIRECTIONS = [
    (-1, -1), (0, -1), (1, -1),
    (-1,  0),          (1,  0),
    (-1,  1), (0,  1), (1,  1),
]

# Matches HeatFlowTolerance.Floor in the Unity flow solver.
EPS = 1e-6


def spatial_key(x: int, y: int) -> Tuple[int, int]:
    """Sort key for the game's explicit processing order: ascending X, then descending Y."""
    return (x, -y)
