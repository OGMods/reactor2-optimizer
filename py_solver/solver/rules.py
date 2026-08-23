"""
The grid adjacency primitives every solver stage shares.

The rule *values* these build on live in `constants.py`; this module is the
geometry derived from them.

See `docs/game-logic.md` for the authoritative rules.

No file-level TS peer: the adjacency construction lives inside
`buildIslandContext()` in `lib/solver/context.ts`. See docs/PARITY.md.
"""

from typing import Dict, List, Tuple

from solver.constants import CHEBYSHEV_DIRECTIONS, spatial_key

TileId = Tuple[int, int]


def is_adjacent(a: TileId, b: TileId) -> bool:
    """8-neighbor (Chebyshev) adjacency between two (x, y) tile positions."""
    return max(abs(a[0] - b[0]), abs(a[1] - b[1])) <= 1


def build_neighbor_map(tiles: List[TileId]) -> Dict[TileId, List[TileId]]:
    """
    Precomputes, once per island, every buildable tile's Chebyshev-adjacent
    buildable neighbors -- pure grid geometry, independent of which building
    (if any) ends up on each tile. Each tile's neighbor list is pre-sorted by
    spatial_key, matching the game's fixed processing order, so downstream
    callers (run_distribution, seed construction) can filter this list by
    "is this neighbor currently a supplier/consumer of the right type" via
    an O(1) dict/set lookup instead of re-deriving adjacency with is_adjacent
    (an O(S*C) pairwise scan) plus a fresh sort on every call. Geometry never
    changes across a solve, so this is computed exactly once and reused.
    """
    tile_set = set(tiles)
    neighbor_map: Dict[TileId, List[TileId]] = {}
    for x, y in tiles:
        candidates = [(x + dx, y + dy) for dx, dy in CHEBYSHEV_DIRECTIONS]
        neighbors = [n for n in candidates if n in tile_set]
        neighbors.sort(key=lambda p: spatial_key(*p))
        neighbor_map[(x, y)] = neighbors
    return neighbor_map
